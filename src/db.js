// Lokalna baza SQLite — portfolio z notatkami/tagami, watchlista interesujących
// domen, kolejka dropcatchu i log każdej operacji API.
//
// AfterMarket trzyma stan po swojej stronie; ta baza dodaje tylko warstwę
// którą my kontrolujemy: prywatne notatki, priorytety, tagi, daty reminderów.

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { config } from "dotenv";

config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = path.resolve(__dirname, "..", "data", "aftermarket.db");
const DB_PATH = process.env.AM_DB_PATH || DEFAULT_DB;

let _db = null;

export function getDb() {
  if (_db) return _db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  migrate(_db);
  return _db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS portfolio (
      name             TEXT PRIMARY KEY,
      registered_at    TEXT,
      expires_at       TEXT,
      auto_renew       INTEGER DEFAULT 0,
      tags             TEXT,
      notes            TEXT,
      last_synced_at   TEXT,
      created_at       TEXT DEFAULT (datetime('now')),
      updated_at       TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_portfolio_expires ON portfolio(expires_at);

    CREATE TABLE IF NOT EXISTS watchlist (
      name        TEXT PRIMARY KEY,
      priority    INTEGER DEFAULT 0,
      max_price   REAL,
      reason      TEXT,
      added_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dropcatch_queue (
      name              TEXT PRIMARY KEY,
      priority          INTEGER DEFAULT 0,
      max_price         REAL,
      remote_id         TEXT,   -- id zwrócone przez AfterMarket po dodaniu
      remote_status     TEXT,   -- ostatni znany status z API
      notes             TEXT,
      added_at          TEXT DEFAULT (datetime('now')),
      last_synced_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS operations_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts            TEXT DEFAULT (datetime('now')),
      endpoint      TEXT NOT NULL,
      params        TEXT,        -- JSON
      status        TEXT,        -- ok | api_error | error
      error         TEXT,
      duration_ms   INTEGER,
      result_summary TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_oplog_ts ON operations_log(ts);
    CREATE INDEX IF NOT EXISTS idx_oplog_endpoint ON operations_log(endpoint);

    CREATE TABLE IF NOT EXISTS reminders_sent (
      domain      TEXT NOT NULL,
      days_left   INTEGER NOT NULL,
      sent_at     TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (domain, days_left)
    );

    CREATE TABLE IF NOT EXISTS api_cache (
      provider     TEXT NOT NULL,    -- 'moz' | 'gsc' | inne
      cache_key    TEXT NOT NULL,    -- np. 'moz:foo.com' albo 'gsc:sites' albo hash
      payload      TEXT NOT NULL,    -- JSON
      fetched_at   TEXT DEFAULT (datetime('now')),
      ttl_seconds  INTEGER NOT NULL DEFAULT 86400,
      PRIMARY KEY (provider, cache_key)
    );

    CREATE INDEX IF NOT EXISTS idx_cache_fetched ON api_cache(provider, fetched_at);
  `);
}

// ===== Generic cache (Moz, GSC) =====

export function cacheGet(provider, key) {
  const row = getDb().prepare(`
    SELECT payload, fetched_at, ttl_seconds,
           (strftime('%s','now') - strftime('%s', fetched_at)) AS age_seconds
    FROM api_cache
    WHERE provider = ? AND cache_key = ?
  `).get(provider, key);
  if (!row) return null;
  if (row.age_seconds > row.ttl_seconds) return null;
  try {
    return { data: JSON.parse(row.payload), age_seconds: row.age_seconds, fetched_at: row.fetched_at };
  } catch {
    return null;
  }
}

export function cacheSet(provider, key, data, ttl_seconds = 86400) {
  return getDb().prepare(`
    INSERT INTO api_cache (provider, cache_key, payload, fetched_at, ttl_seconds)
    VALUES (?, ?, ?, datetime('now'), ?)
    ON CONFLICT(provider, cache_key) DO UPDATE SET
      payload = excluded.payload,
      fetched_at = excluded.fetched_at,
      ttl_seconds = excluded.ttl_seconds
  `).run(provider, key, JSON.stringify(data), ttl_seconds);
}

export function cacheClear(provider, key = null) {
  if (key) return getDb().prepare("DELETE FROM api_cache WHERE provider = ? AND cache_key = ?").run(provider, key);
  return getDb().prepare("DELETE FROM api_cache WHERE provider = ?").run(provider);
}

// ===== Portfolio =====

export function upsertPortfolioDomain(d) {
  const db = getDb();
  db.prepare(`
    INSERT INTO portfolio (name, registered_at, expires_at, auto_renew, tags, notes, last_synced_at, updated_at)
    VALUES (@name, @registered_at, @expires_at, @auto_renew, @tags, @notes, datetime('now'), datetime('now'))
    ON CONFLICT(name) DO UPDATE SET
      registered_at = COALESCE(excluded.registered_at, portfolio.registered_at),
      expires_at    = COALESCE(excluded.expires_at,    portfolio.expires_at),
      auto_renew    = COALESCE(excluded.auto_renew,    portfolio.auto_renew),
      tags          = COALESCE(excluded.tags,          portfolio.tags),
      notes         = COALESCE(excluded.notes,         portfolio.notes),
      last_synced_at = datetime('now'),
      updated_at    = datetime('now')
  `).run({
    name: d.name,
    registered_at: d.registered_at ?? null,
    expires_at: d.expires_at ?? null,
    auto_renew: d.auto_renew == null ? null : (d.auto_renew ? 1 : 0),
    tags: d.tags ?? null,
    notes: d.notes ?? null,
  });
}

export function listPortfolio({ tag, expiringInDays } = {}) {
  const db = getDb();
  const where = [];
  const args = {};
  if (tag) {
    where.push("tags LIKE @tag");
    args.tag = `%${tag}%`;
  }
  if (expiringInDays != null) {
    where.push("expires_at IS NOT NULL AND date(expires_at) <= date('now', '+' || @days || ' days')");
    args.days = expiringInDays;
  }
  const sql = `SELECT * FROM portfolio ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY expires_at ASC NULLS LAST`;
  return db.prepare(sql).all(args);
}

export function getPortfolioDomain(name) {
  return getDb().prepare("SELECT * FROM portfolio WHERE name = ?").get(name);
}

export function removePortfolioDomain(name) {
  return getDb().prepare("DELETE FROM portfolio WHERE name = ?").run(name);
}

// ===== Watchlist =====

export function addToWatchlist({ name, priority = 0, max_price = null, reason = null }) {
  return getDb().prepare(`
    INSERT INTO watchlist (name, priority, max_price, reason)
    VALUES (@name, @priority, @max_price, @reason)
    ON CONFLICT(name) DO UPDATE SET
      priority = excluded.priority,
      max_price = excluded.max_price,
      reason = excluded.reason
  `).run({ name, priority, max_price, reason });
}

export function listWatchlist() {
  return getDb().prepare("SELECT * FROM watchlist ORDER BY priority DESC, name ASC").all();
}

export function removeFromWatchlist(name) {
  return getDb().prepare("DELETE FROM watchlist WHERE name = ?").run(name);
}

// ===== Dropcatch queue (lokalne odzwierciedlenie tego co siedzi w API) =====

export function upsertDropcatch(d) {
  return getDb().prepare(`
    INSERT INTO dropcatch_queue (name, priority, max_price, remote_id, remote_status, notes, last_synced_at)
    VALUES (@name, @priority, @max_price, @remote_id, @remote_status, @notes, datetime('now'))
    ON CONFLICT(name) DO UPDATE SET
      priority = COALESCE(excluded.priority, dropcatch_queue.priority),
      max_price = COALESCE(excluded.max_price, dropcatch_queue.max_price),
      remote_id = COALESCE(excluded.remote_id, dropcatch_queue.remote_id),
      remote_status = COALESCE(excluded.remote_status, dropcatch_queue.remote_status),
      notes = COALESCE(excluded.notes, dropcatch_queue.notes),
      last_synced_at = datetime('now')
  `).run({
    name: d.name,
    priority: d.priority ?? 0,
    max_price: d.max_price ?? null,
    remote_id: d.remote_id ?? null,
    remote_status: d.remote_status ?? null,
    notes: d.notes ?? null,
  });
}

export function listDropcatch() {
  return getDb().prepare("SELECT * FROM dropcatch_queue ORDER BY priority DESC, name ASC").all();
}

export function removeDropcatch(name) {
  return getDb().prepare("DELETE FROM dropcatch_queue WHERE name = ?").run(name);
}

// ===== Log operacji =====

export function logOperation({ endpoint, params, status, error, duration_ms, result_summary }) {
  return getDb().prepare(`
    INSERT INTO operations_log (endpoint, params, status, error, duration_ms, result_summary)
    VALUES (@endpoint, @params, @status, @error, @duration_ms, @result_summary)
  `).run({
    endpoint,
    params: params ? JSON.stringify(params) : null,
    status,
    error,
    duration_ms,
    result_summary,
  });
}

export function recentOperations(limit = 50) {
  return getDb().prepare(`
    SELECT id, ts, endpoint, status, error, duration_ms, result_summary
    FROM operations_log
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
}

// ===== Reminders =====

export function wasReminderSent(domain, days_left) {
  return !!getDb().prepare(
    "SELECT 1 FROM reminders_sent WHERE domain = ? AND days_left = ?"
  ).get(domain, days_left);
}

export function markReminderSent(domain, days_left) {
  return getDb().prepare(
    "INSERT OR IGNORE INTO reminders_sent (domain, days_left) VALUES (?, ?)"
  ).run(domain, days_left);
}
