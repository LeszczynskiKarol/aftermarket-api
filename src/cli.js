#!/usr/bin/env node
// CLI do tych samych operacji co MCP — żebyś mógł je wywołać ręcznie z terminala.
//
// Przykłady:
//   node src/cli.js check foo.pl bar.com
//   node src/cli.js portfolio
//   node src/cli.js portfolio --expiring 30
//   node src/cli.js renew foo.pl --period 2
//   node src/cli.js dropcatch add foo.pl --max-price 100
//   node src/cli.js log --limit 20

import { callApi, domain, dropcatch, helper, portfolioRowFromApi } from "./api.js";
import { urlMetrics as mozUrlMetrics } from "./moz.js";
import { listSites as gscListSites, topQueries as gscTopQueries, topPages as gscTopPages, summary as gscSummary } from "./gsc.js";
import {
  upsertPortfolioDomain,
  listPortfolio,
  addToWatchlist,
  listWatchlist,
  removeFromWatchlist,
  listDropcatch,
  upsertDropcatch,
  removeDropcatch,
  recentOperations,
} from "./db.js";

const args = process.argv.slice(2);
const cmd = args[0];

const flags = {};
const positional = [];
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) { flags[key] = next; i++; }
    else flags[key] = true;
  } else positional.push(a);
}

function out(v) {
  console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
}
function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

const commands = {
  async check() {
    if (!positional.length) die("Usage: check <domain> [domain...]");
    out(await domain.check(positional));
  },
  async info() {
    const name = positional[0];
    if (!name) die("Usage: info <domain>");
    out(await domain.info(name));
  },
  async register() {
    const name = positional[0];
    if (!name) die("Usage: register <domain> [--period N]");
    const period = parseInt(flags.period || "1", 10);
    out(await domain.order({ name, period }));
  },
  async renew() {
    const name = positional[0];
    if (!name) die("Usage: renew <domain> [--period N]");
    const period = parseInt(flags.period || "1", 10);
    out(await domain.renew({ name, period }));
  },
  async portfolio() {
    if (positional[0] === "sync") {
      const data = await domain.list({});
      const rows = Array.isArray(data) ? data : (data?.domains || data?.items || []);
      let saved = 0;
      for (const r of rows) {
        const mapped = portfolioRowFromApi(r);
        if (!mapped.name) continue;
        upsertPortfolioDomain(mapped);
        saved++;
      }
      out({ synced: saved });
      return;
    }
    const expiring = flags.expiring ? parseInt(flags.expiring, 10) : undefined;
    const tag = typeof flags.tag === "string" ? flags.tag : undefined;
    out(listPortfolio({ tag, expiringInDays: expiring }));
  },
  async watchlist() {
    const sub = positional[0];
    if (sub === "add") {
      const name = positional[1];
      if (!name) die("Usage: watchlist add <domain> [--priority N] [--max-price X] [--reason ...]");
      addToWatchlist({
        name,
        priority: flags.priority ? parseInt(flags.priority, 10) : 0,
        max_price: flags["max-price"] ? parseFloat(flags["max-price"]) : null,
        reason: typeof flags.reason === "string" ? flags.reason : null,
      });
      out({ added: name });
    } else if (sub === "remove") {
      const name = positional[1];
      if (!name) die("Usage: watchlist remove <domain>");
      out({ removed: removeFromWatchlist(name).changes });
    } else {
      out(listWatchlist());
    }
  },
  async dropcatch() {
    const sub = positional[0];
    if (sub === "add") {
      const name = positional[1];
      if (!name) die("Usage: dropcatch add <domain> [--max-price X]");
      const max_price = flags["max-price"] ? parseFloat(flags["max-price"]) : undefined;
      const data = await dropcatch.add({ name, ...(max_price != null ? { max_price } : {}) });
      upsertDropcatch({
        name,
        max_price: max_price ?? null,
        remote_id: data?.id || data?.dropcatch_id || null,
        remote_status: data?.status || "added",
      });
      out(data);
    } else if (sub === "remove") {
      const name = positional[1];
      if (!name) die("Usage: dropcatch remove <domain>");
      try { await dropcatch.remove({ name }); } catch (e) {
        console.error("[warn] API remove failed:", e.message);
      }
      removeDropcatch(name);
      out({ removed: name });
    } else if (sub === "remote") {
      out(await dropcatch.list({}));
    } else {
      out(listDropcatch());
    }
  },
  async call() {
    const path = positional[0];
    if (!path) die("Usage: call /endpoint/path [--json '{...}']");
    let params = {};
    if (typeof flags.json === "string") {
      try { params = JSON.parse(flags.json); }
      catch (e) { die("Niepoprawny JSON: " + e.message); }
    }
    out(await callApi(path, params));
  },
  async idn() {
    const sub = positional[0];
    const name = positional[1];
    if (!name) die("Usage: idn encode|decode <name>");
    if (sub === "decode") out(await helper.idnDecode(name));
    else out(await helper.idnEncode(name));
  },
  async log() {
    const limit = flags.limit ? parseInt(flags.limit, 10) : 50;
    out(recentOperations(limit));
  },
  async moz() {
    if (!positional.length) die("Usage: moz <domain> [domain...] [--force]");
    out(await mozUrlMetrics(positional, { force: !!flags.force }));
  },
  async gsc() {
    const sub = positional[0];
    if (sub === "sites") {
      out(await gscListSites({ force: !!flags.force }));
      return;
    }
    const target = positional[1];
    const days = flags.days ? parseInt(flags.days, 10) : 28;
    const limit = flags.limit ? parseInt(flags.limit, 10) : 50;
    if (sub === "top-queries") {
      if (!target) die("Usage: gsc top-queries <domain> [--days 28] [--limit 50]");
      out(await gscTopQueries(target, days, limit));
    } else if (sub === "top-pages") {
      if (!target) die("Usage: gsc top-pages <domain> [--days 28] [--limit 50]");
      out(await gscTopPages(target, days, limit));
    } else if (sub === "summary") {
      if (!target) die("Usage: gsc summary <domain> [--days 28]");
      out(await gscSummary(target, days));
    } else {
      die("Usage: gsc sites | top-queries <domain> | top-pages <domain> | summary <domain>");
    }
  },
  async help() { printHelp(); },
};

function printHelp() {
  out(`
am — CLI do AfterMarket + lokalnego portfolio

  check <domain> [domain...]              Sprawdza dostępność
  info <domain>                           Szczegóły domeny z API
  register <domain> [--period N]          Rejestruje domenę (kosztuje!)
  renew <domain> [--period N]             Przedłuża domenę (kosztuje!)

  portfolio                               Lista lokalnego portfolio
  portfolio --expiring 30 [--tag X]       Filtrowanie
  portfolio sync                          Pobiera z API i zapisuje do bazy

  watchlist                               Lista watchlisty
  watchlist add <domain> [--priority N] [--max-price X] [--reason ...]
  watchlist remove <domain>

  dropcatch                               Lokalna kolejka dropcatchu
  dropcatch remote                        Pobiera z API
  dropcatch add <domain> [--max-price X]
  dropcatch remove <domain>

  idn encode|decode <name>                Konwersja IDN (xn--...)
  call /endpoint/path [--json '{...}']    Surowe wywołanie endpointu
  log [--limit N]                         Ostatnie operacje API

  moz <domain> [domain...] [--force]      Moz DA/PA/spam (cache 7 dni)
  gsc sites                               Lista properties w Search Console
  gsc top-queries <domain> [--days 28] [--limit 50]
  gsc top-pages <domain> [--days 28] [--limit 50]
  gsc summary <domain> [--days 28]        Clicks/impr/CTR/poz + porównanie

  help                                    Ten ekran
`.trim());
}

(async () => {
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    process.exit(0);
  }
  const fn = commands[cmd];
  if (!fn) die(`Nieznana komenda: ${cmd}. Użyj 'help'.`);
  try {
    await fn();
  } catch (e) {
    console.error("Błąd:", e.message);
    if (e.response) console.error("Odpowiedź API:", JSON.stringify(e.response, null, 2));
    process.exit(1);
  }
})();
