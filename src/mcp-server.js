// MCP server (stdio) dla Claude Code.
// Eksponuje tools owijające AfterMarket API + lokalną bazę.
//
// Rejestracja w Claude Code: zob. .mcp.json w katalogu projektu.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { callApi, domain, dropcatch, helper, portfolioRowFromApi } from "./api.js";
import { urlMetrics as mozUrlMetrics } from "./moz.js";
import { listSites as gscListSites, searchAnalyticsQuery as gscQuery, topQueries as gscTopQueries, topPages as gscTopPages, summary as gscSummary } from "./gsc.js";
import {
  upsertPortfolioDomain,
  listPortfolio,
  getPortfolioDomain,
  removePortfolioDomain,
  addToWatchlist,
  listWatchlist,
  removeFromWatchlist,
  upsertDropcatch,
  listDropcatch,
  removeDropcatch,
  recentOperations,
} from "./db.js";

const server = new McpServer({
  name: "aftermarket-local",
  version: "0.1.0",
});

// ===== Helpers =====
const ok = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});
const err = (e) => ({
  isError: true,
  content: [{ type: "text", text: `Błąd: ${e.message}${e.code ? ` (code ${e.code})` : ""}` }],
});

// ===== Generyczny escape-hatch =====
// Pozwala wywołać DOWOLNY endpoint API. Używamy go żeby weryfikować ścieżki
// których jeszcze nie owinęliśmy w typowane tools.
server.tool(
  "am_api_call",
  "Wywołuje dowolny endpoint AfterMarket API (np. '/domain/check'). Używaj gdy potrzebujesz endpointu nieobjętego dedykowanym tool.",
  {
    path: z.string().describe("Ścieżka endpointu, np. '/domain/check'"),
    params: z.record(z.any()).optional().describe("Parametry payloadu (JSON object)"),
  },
  async ({ path, params }) => {
    try {
      const data = await callApi(path, params || {});
      return ok(data);
    } catch (e) {
      return err(e);
    }
  },
);

// ===== Sprawdzanie dostępności / wyszukiwanie =====
server.tool(
  "domain_check",
  "Sprawdza dostępność jednej lub wielu domen. Zwraca status każdej (wolna/zajęta/inne).",
  {
    names: z.array(z.string()).min(1).describe("Lista nazw domen, np. ['foo.pl','bar.com']"),
  },
  async ({ names }) => {
    try {
      return ok(await domain.check(names));
    } catch (e) { return err(e); }
  },
);

// ===== Rejestracja domeny =====
server.tool(
  "domain_register",
  "Zamawia rejestrację nowej domeny. UWAGA: ta operacja kosztuje pieniądze.",
  {
    name: z.string().describe("Nazwa domeny do zarejestrowania"),
    period: z.number().int().min(1).max(10).default(1).describe("Okres rejestracji w latach"),
    contact_id: z.string().optional().describe("ID kontaktu (jeśli wymagane przez API)"),
    extra: z.record(z.any()).optional().describe("Dodatkowe parametry przekazywane do /domain/order/add"),
  },
  async ({ name, period, contact_id, extra }) => {
    try {
      const params = { name, period, ...(contact_id ? { contact_id } : {}), ...(extra || {}) };
      const data = await domain.order(params);
      // jeśli zwróci sukces — wpiszmy do portfolio na wszelki wypadek
      try { upsertPortfolioDomain({ name }); } catch {}
      return ok(data);
    } catch (e) { return err(e); }
  },
);

// ===== Przedłużenie =====
server.tool(
  "domain_renew",
  "Przedłuża domenę. UWAGA: kosztuje pieniądze.",
  {
    name: z.string(),
    period: z.number().int().min(1).max(10).default(1).describe("Okres przedłużenia w latach"),
    extra: z.record(z.any()).optional(),
  },
  async ({ name, period, extra }) => {
    try {
      const data = await domain.renew({ name, period, ...(extra || {}) });
      return ok(data);
    } catch (e) { return err(e); }
  },
);

// ===== Info / synchronizacja portfolio z API =====
server.tool(
  "domain_info",
  "Zwraca szczegóły jednej domeny z API.",
  { name: z.string() },
  async ({ name }) => {
    try { return ok(await domain.info(name)); }
    catch (e) { return err(e); }
  },
);

server.tool(
  "portfolio_sync",
  "Pobiera listę domen z AfterMarket i zapisuje do lokalnej bazy portfolio.",
  { params: z.record(z.any()).optional() },
  async ({ params }) => {
    try {
      const data = await domain.list(params || {});
      const rows = Array.isArray(data) ? data : (data?.domains || data?.items || []);
      let saved = 0;
      for (const r of rows) {
        const mapped = portfolioRowFromApi(r);
        if (!mapped.name) continue;
        upsertPortfolioDomain(mapped);
        saved++;
      }
      return ok({ synced: saved });
    } catch (e) { return err(e); }
  },
);

// ===== Lokalne portfolio =====
server.tool(
  "portfolio_list",
  "Lista domen w lokalnym portfolio (z bazy SQLite). Można filtrować po tagu albo wygasające w ciągu N dni.",
  {
    tag: z.string().optional(),
    expiring_in_days: z.number().int().positive().optional(),
  },
  async ({ tag, expiring_in_days }) => {
    return ok(listPortfolio({ tag, expiringInDays: expiring_in_days }));
  },
);

server.tool(
  "portfolio_get",
  "Pobiera lokalny rekord domeny z portfolio (notatki, tagi, daty).",
  { name: z.string() },
  async ({ name }) => {
    const r = getPortfolioDomain(name);
    return r ? ok(r) : err(new Error(`Brak ${name} w lokalnym portfolio`));
  },
);

server.tool(
  "portfolio_set",
  "Tworzy/aktualizuje lokalny rekord domeny w portfolio (notatki/tagi/daty). Nie wywołuje API.",
  {
    name: z.string(),
    registered_at: z.string().optional(),
    expires_at: z.string().optional(),
    auto_renew: z.boolean().optional(),
    tags: z.string().optional().describe("CSV tagów, np. 'projekty,parking'"),
    notes: z.string().optional(),
  },
  async (args) => {
    upsertPortfolioDomain(args);
    return ok(getPortfolioDomain(args.name));
  },
);

server.tool(
  "portfolio_remove",
  "Usuwa LOKALNY rekord z portfolio (nie usuwa domeny z AfterMarket).",
  { name: z.string() },
  async ({ name }) => {
    const r = removePortfolioDomain(name);
    return ok({ removed: r.changes });
  },
);

// ===== Watchlist =====
server.tool(
  "watchlist_add",
  "Dodaje domenę do lokalnej watchlisty (interesujące domeny do śledzenia).",
  {
    name: z.string(),
    priority: z.number().int().default(0),
    max_price: z.number().optional(),
    reason: z.string().optional(),
  },
  async (args) => {
    addToWatchlist(args);
    return ok({ added: args.name });
  },
);
server.tool("watchlist_list", "Lista watchlisty.", {}, async () => ok(listWatchlist()));
server.tool(
  "watchlist_remove",
  "Usuwa z watchlisty.",
  { name: z.string() },
  async ({ name }) => ok({ removed: removeFromWatchlist(name).changes }),
);

// ===== Dropcatch =====
server.tool(
  "dropcatch_add",
  "Dodaje domenę do kolejki dropcatchu (przechwytywanie wygasających domen). UWAGA: jeśli złapana - kosztuje.",
  {
    name: z.string(),
    max_price: z.number().optional(),
    priority: z.number().int().optional(),
    extra: z.record(z.any()).optional().describe("Dodatkowe parametry przekazywane do /dropcatch/add"),
  },
  async ({ name, max_price, priority, extra }) => {
    try {
      const params = { name, ...(max_price != null ? { max_price } : {}), ...(extra || {}) };
      const data = await dropcatch.add(params);
      upsertDropcatch({
        name,
        priority: priority ?? 0,
        max_price: max_price ?? null,
        remote_id: data?.id || data?.dropcatch_id || null,
        remote_status: data?.status || "added",
      });
      return ok(data);
    } catch (e) { return err(e); }
  },
);

server.tool(
  "dropcatch_list_remote",
  "Pobiera aktualną listę dropcatchu z API AfterMarket.",
  { params: z.record(z.any()).optional() },
  async ({ params }) => {
    try { return ok(await dropcatch.list(params || {})); }
    catch (e) { return err(e); }
  },
);

server.tool(
  "dropcatch_list_local",
  "Lista pozycji dropcatchu z lokalnej bazy (z priorytetami i notatkami).",
  {},
  async () => ok(listDropcatch()),
);

server.tool(
  "dropcatch_remove",
  "Usuwa pozycję z kolejki dropcatchu (próbuje również w API).",
  { name: z.string() },
  async ({ name }) => {
    let apiResult = null;
    try { apiResult = await dropcatch.remove({ name }); } catch (e) {
      apiResult = { error: e.message };
    }
    removeDropcatch(name);
    return ok({ local_removed: true, api: apiResult });
  },
);

// ===== Helpery =====
server.tool(
  "idn_encode",
  "Konwertuje nazwę z polskimi znakami na postać IDN (xn--...).",
  { name: z.string() },
  async ({ name }) => {
    try { return ok(await helper.idnEncode(name)); }
    catch (e) { return err(e); }
  },
);

server.tool(
  "op_log",
  "Ostatnie operacje API z lokalnego logu (debugowanie).",
  { limit: z.number().int().positive().max(500).default(50) },
  async ({ limit }) => ok(recentOperations(limit)),
);

// ===== Moz =====
server.tool(
  "moz_url_metrics",
  "Pobiera metryki Moz (DA, PA, spam score, linki) dla jednej lub wielu domen/URL. Cache 7 dni. UWAGA: plan ma 3000 req/miesiąc.",
  {
    targets: z.array(z.string()).min(1).describe("Lista domen lub URL, np. ['foo.com','https://bar.pl/x']"),
    force: z.boolean().optional().describe("Pomiń cache, wymuś świeże zapytanie"),
  },
  async ({ targets, force }) => {
    try { return ok(await mozUrlMetrics(targets, { force })); }
    catch (e) { return err(e); }
  },
);

// ===== GSC =====
server.tool(
  "gsc_sites_list",
  "Lista zweryfikowanych properties w Google Search Console. Cache 24h.",
  { force: z.boolean().optional() },
  async ({ force }) => {
    try { return ok(await gscListSites({ force })); }
    catch (e) { return err(e); }
  },
);

server.tool(
  "gsc_top_queries",
  "Top frazy z GSC dla danej domeny (auto-match property). Cache 6h.",
  {
    domain: z.string().describe("Domena, np. 'foo.pl'. Auto-match do sc-domain:/https://"),
    days: z.number().int().positive().default(28),
    limit: z.number().int().positive().max(5000).default(50),
  },
  async ({ domain, days, limit }) => {
    try { return ok(await gscTopQueries(domain, days, limit)); }
    catch (e) { return err(e); }
  },
);

server.tool(
  "gsc_top_pages",
  "Top strony z GSC dla danej domeny (clicks/impressions/CTR/position).",
  {
    domain: z.string(),
    days: z.number().int().positive().default(28),
    limit: z.number().int().positive().max(5000).default(50),
  },
  async ({ domain, days, limit }) => {
    try { return ok(await gscTopPages(domain, days, limit)); }
    catch (e) { return err(e); }
  },
);

server.tool(
  "gsc_summary",
  "Podsumowanie GSC dla domeny: clicks/impressions/CTR/position za N dni + porównanie do poprzedniego okresu.",
  {
    domain: z.string(),
    days: z.number().int().positive().default(28),
  },
  async ({ domain, days }) => {
    try { return ok(await gscSummary(domain, days)); }
    catch (e) { return err(e); }
  },
);

server.tool(
  "gsc_query",
  "Surowe Search Analytics query (pełna kontrola: dimensions, filters, date range).",
  {
    siteUrl: z.string().describe("np. 'sc-domain:foo.pl' albo 'https://foo.pl/'"),
    startDate: z.string().describe("YYYY-MM-DD"),
    endDate: z.string().describe("YYYY-MM-DD"),
    dimensions: z.array(z.enum(["query","page","country","device","date","searchAppearance"])).optional(),
    rowLimit: z.number().int().positive().max(25000).optional(),
    filters: z.array(z.object({
      dimension: z.string(),
      operator: z.string().optional(),
      expression: z.string(),
    })).optional(),
    type: z.enum(["web","image","video","news","discover","googleNews"]).optional(),
    dataState: z.enum(["all","final"]).optional(),
  },
  async (args) => {
    try { return ok(await gscQuery(args)); }
    catch (e) { return err(e); }
  },
);

// ===== Start =====
const transport = new StdioServerTransport();
await server.connect(transport);
// (żadnych printów do stdout — to popsułoby stdio MCP)
