// Moz Links API v2 — sprawdzanie DA/PA/spam/linków dla URL/domeny.
// Endpoint: https://lsapi.seomoz.com/v2/url_metrics
// Auth: Basic z tokenem z https://moz.com/products/api -> Manage Tokens
//
// UWAGA: Plan Starter Medium ma 3000 req/miesiąc — agresywnie cache'ujemy.

import axios from "axios";
import { config } from "dotenv";
import { cacheGet, cacheSet, logOperation } from "./db.js";

config();

const MOZ_TOKEN = process.env.MOZ_TOKEN || "";
const MOZ_URL = "https://lsapi.seomoz.com/v2";
const TIMEOUT = parseInt(process.env.AM_TIMEOUT_MS || "15000", 10);

// Cache TTL: 7 dni dla url_metrics (DA się zmienia rzadko)
const URL_METRICS_TTL = 7 * 24 * 3600;

const http = axios.create({
  baseURL: MOZ_URL,
  timeout: TIMEOUT,
  headers: { Authorization: "Basic " + MOZ_TOKEN },
  responseType: "json",
  validateStatus: () => true,
});

function normalize(target) {
  // Moz akceptuje target jako bare domain albo URL.
  // Normalizujemy do bare domain dla cache key consistency.
  return target.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/**
 * Pobiera metryki dla listy URL/domen.
 * @param {string|string[]} targets
 * @param {object} [opts]
 * @param {boolean} [opts.force] pomiń cache
 * @returns {Promise<Array>}  rezultaty + metadata z cache (cached: bool, age_seconds?: number)
 */
export async function urlMetrics(targets, opts = {}) {
  if (!MOZ_TOKEN) throw new Error("Brak MOZ_TOKEN w .env");
  const arr = (Array.isArray(targets) ? targets : [targets]).map(normalize);
  const results = [];
  const toFetch = [];

  if (!opts.force) {
    for (const t of arr) {
      const c = cacheGet("moz", `url_metrics:${t}`);
      if (c) results.push({ target: t, cached: true, age_seconds: c.age_seconds, ...c.data });
      else toFetch.push(t);
    }
  } else {
    toFetch.push(...arr);
  }

  if (toFetch.length === 0) return results;

  const started = Date.now();
  let status = "ok", errorMsg = null, data = null;
  try {
    const response = await http.post("/url_metrics", { targets: toFetch });
    if (response.status === 429) {
      status = "api_error";
      errorMsg = "Moz: quota wyczerpana (429). Reset za kilka dni — sprawdź dashboard.";
      throw new Error(errorMsg);
    }
    if (response.status >= 400) {
      status = "api_error";
      errorMsg = `Moz HTTP ${response.status}: ${JSON.stringify(response.data).slice(0, 200)}`;
      throw new Error(errorMsg);
    }
    data = response.data;
    // odpowiedź ma kształt { results: [...] } albo bezpośrednio tablicę — robimy oba
    const rows = data?.results || (Array.isArray(data) ? data : []);
    for (const row of rows) {
      const t = normalize(row.target || row.canonical_url || "");
      if (t) cacheSet("moz", `url_metrics:${t}`, row, URL_METRICS_TTL);
      results.push({ target: t, cached: false, ...row });
    }
    return results;
  } catch (e) {
    if (!errorMsg) errorMsg = e.message;
    if (status === "ok") status = "error";
    throw e;
  } finally {
    try {
      logOperation({
        endpoint: "moz:/v2/url_metrics",
        params: { targets: toFetch },
        status,
        error: errorMsg,
        duration_ms: Date.now() - started,
        result_summary: data ? JSON.stringify(data).slice(0, 500) : null,
      });
    } catch {}
  }
}
