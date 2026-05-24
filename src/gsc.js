// Google Search Console — sites.list + searchanalytics.query.
// Auto-match: jeśli podasz "foo.pl", szuka w properties najpierw
// "sc-domain:foo.pl", potem "https://foo.pl/", potem "http://foo.pl/", potem warianty www.

import { google } from "googleapis";
import { config } from "dotenv";
import { cacheGet, cacheSet, logOperation } from "./db.js";

config();

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

const SITES_TTL = 24 * 3600;            // lista properties - 1 dzień
const SUMMARY_TTL = 6 * 3600;           // summary - 6h
const ANALYTICS_TTL = 6 * 3600;         // raw query - 6h

let _client = null;

function getClient() {
  if (_client) return _client;
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Brak GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET w .env");
  if (!REFRESH_TOKEN) throw new Error("Brak GOOGLE_REFRESH_TOKEN — uruchom: npm run gsc:auth");
  const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: REFRESH_TOKEN });
  _client = google.searchconsole({ version: "v1", auth: oauth2 });
  return _client;
}

async function withLog(endpoint, params, fn) {
  const started = Date.now();
  let status = "ok", errorMsg = null, summary = null;
  try {
    const result = await fn();
    summary = JSON.stringify(result).slice(0, 500);
    return result;
  } catch (e) {
    status = "api_error";
    errorMsg = e.message;
    throw e;
  } finally {
    try {
      logOperation({
        endpoint: "gsc:" + endpoint,
        params,
        status,
        error: errorMsg,
        duration_ms: Date.now() - started,
        result_summary: summary,
      });
    } catch {}
  }
}

export async function listSites({ force = false } = {}) {
  if (!force) {
    const c = cacheGet("gsc", "sites");
    if (c) return { cached: true, age_seconds: c.age_seconds, sites: c.data };
  }
  const sites = await withLog("/sites/list", {}, async () => {
    const sc = getClient();
    const res = await sc.sites.list();
    return res.data.siteEntry || [];
  });
  cacheSet("gsc", "sites", sites, SITES_TTL);
  return { cached: false, sites };
}

/**
 * Próbuje znaleźć właściwy siteUrl dla podanej domeny.
 * Zwraca string siteUrl albo rzuca z listą dostępnych properties.
 */
export async function resolveSite(domain) {
  if (domain.startsWith("sc-domain:") || domain.startsWith("http")) return domain;
  const { sites } = await listSites();
  const verified = sites.filter(s => s.permissionLevel && s.permissionLevel !== "siteUnverifiedUser");
  const candidates = [
    `sc-domain:${domain}`,
    `https://${domain}/`,
    `http://${domain}/`,
    `https://www.${domain}/`,
    `http://www.${domain}/`,
  ];
  for (const c of candidates) {
    if (verified.some(s => s.siteUrl === c)) return c;
  }
  const list = verified.map(s => s.siteUrl).join(", ") || "(brak zweryfikowanych)";
  throw new Error(`Nie znalazłem property GSC dla "${domain}". Dostępne: ${list}`);
}

/**
 * Surowy Search Analytics query.
 * @param {object} opts
 *   siteUrl, startDate, endDate, dimensions, rowLimit, filters, type, dataState
 */
export async function searchAnalyticsQuery(opts) {
  const { siteUrl, startDate, endDate, dimensions = [], rowLimit = 1000, filters, type, dataState } = opts;
  if (!siteUrl) throw new Error("siteUrl wymagany");
  if (!startDate || !endDate) throw new Error("startDate i endDate wymagane (YYYY-MM-DD)");

  const cacheKey = `sa:${siteUrl}:${startDate}:${endDate}:${dimensions.join(",")}:${rowLimit}:${JSON.stringify(filters||{})}:${type||""}:${dataState||""}`;
  const c = cacheGet("gsc", cacheKey);
  if (c) return { cached: true, age_seconds: c.age_seconds, rows: c.data };

  const rows = await withLog("/searchanalytics/query", { siteUrl, startDate, endDate, dimensions }, async () => {
    const sc = getClient();
    const requestBody = { startDate, endDate, dimensions, rowLimit };
    if (filters) requestBody.dimensionFilterGroups = [{ filters }];
    if (type) requestBody.type = type;
    if (dataState) requestBody.dataState = dataState;
    const res = await sc.searchanalytics.query({ siteUrl, requestBody });
    return res.data.rows || [];
  });
  cacheSet("gsc", cacheKey, rows, ANALYTICS_TTL);
  return { cached: false, rows };
}

function dateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function topQueries(domain, days = 28, limit = 50) {
  const siteUrl = await resolveSite(domain);
  const r = await searchAnalyticsQuery({
    siteUrl,
    startDate: dateNDaysAgo(days + 2), // GSC ma ~2 dni opóźnienia
    endDate: dateNDaysAgo(2),
    dimensions: ["query"],
    rowLimit: limit,
  });
  return { siteUrl, days, ...r };
}

export async function topPages(domain, days = 28, limit = 50) {
  const siteUrl = await resolveSite(domain);
  const r = await searchAnalyticsQuery({
    siteUrl,
    startDate: dateNDaysAgo(days + 2),
    endDate: dateNDaysAgo(2),
    dimensions: ["page"],
    rowLimit: limit,
  });
  return { siteUrl, days, ...r };
}

/**
 * Podsumowanie: clicks/impressions/CTR/position za ostatnie N dni
 * + porównanie do poprzedniego okresu tej samej długości.
 */
export async function summary(domain, days = 28) {
  const siteUrl = await resolveSite(domain);
  const cacheKey = `summary:${siteUrl}:${days}`;
  const c = cacheGet("gsc", cacheKey);
  if (c) return { cached: true, age_seconds: c.age_seconds, ...c.data };

  const endCurr = dateNDaysAgo(2);
  const startCurr = dateNDaysAgo(2 + days);
  const endPrev = dateNDaysAgo(2 + days + 1);
  const startPrev = dateNDaysAgo(2 + days + days);

  async function totals(startDate, endDate) {
    const sc = getClient();
    const res = await sc.searchanalytics.query({
      siteUrl,
      requestBody: { startDate, endDate, dimensions: [], rowLimit: 1 },
    });
    const row = (res.data.rows || [])[0] || {};
    return {
      clicks: row.clicks || 0,
      impressions: row.impressions || 0,
      ctr: row.ctr || 0,
      position: row.position || 0,
    };
  }

  const [current, previous] = await Promise.all([
    withLog("/searchanalytics/totals(curr)", { siteUrl, startCurr, endCurr }, () => totals(startCurr, endCurr)),
    withLog("/searchanalytics/totals(prev)", { siteUrl, startPrev, endPrev }, () => totals(startPrev, endPrev)),
  ]);

  const result = {
    siteUrl,
    days,
    period: { current: { startDate: startCurr, endDate: endCurr }, previous: { startDate: startPrev, endDate: endPrev } },
    current,
    previous,
    delta: {
      clicks: current.clicks - previous.clicks,
      impressions: current.impressions - previous.impressions,
      ctr: round4(current.ctr - previous.ctr),
      position: round4(current.position - previous.position),
    },
  };
  cacheSet("gsc", cacheKey, result, SUMMARY_TTL);
  return { cached: false, ...result };
}

function round4(n) { return Math.round(n * 10000) / 10000; }
