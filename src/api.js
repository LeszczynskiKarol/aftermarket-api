// Cienka warstwa nad biblioteką aftermarketpl-api.
// Biblioteka ma hardcodowany timeout 1000ms i nie loguje błędów —
// owijamy ją własnym axios-em z normalną konfiguracją i logiem do SQLite.

import axios from "axios";
import { config } from "dotenv";
import { logOperation } from "./db.js";

config();

const API_URL = process.env.AM_API_URL || "https://json.aftermarket.pl";
const API_KEY = process.env.AM_API_KEY || "";
const API_SECRET = process.env.AM_API_SECRET || "";
const TIMEOUT = parseInt(process.env.AM_TIMEOUT_MS || "15000", 10);

if (!API_KEY || !API_SECRET) {
  console.warn(
    "[api] Brak AM_API_KEY / AM_API_SECRET w .env — wywołania API zwrócą błąd autoryzacji",
  );
}

const auth = "Basic " + Buffer.from(`${API_KEY}:${API_SECRET}`).toString("base64");

const http = axios.create({
  baseURL: API_URL,
  timeout: TIMEOUT,
  headers: { Authorization: auth },
  responseType: "json",
  validateStatus: () => true, // sami obsługujemy statusy
});

/**
 * Wywołuje endpoint API AfterMarket.
 * @param {string} command  np. "/domain/check"
 * @param {object} params   parametry payloadu
 * @param {object} [opts]
 * @param {boolean} [opts.silent]  jeśli true, nie loguje operacji do DB
 * @returns {Promise<any>} pole data z odpowiedzi (już rozpakowane)
 */
export async function callApi(command, params = {}, opts = {}) {
  const path = command.startsWith("/") ? command : "/" + command;
  const startedAt = Date.now();
  let status = "ok";
  let errorMsg = null;
  let result = null;

  try {
    const response = await http.post(path, params);
    const body = response.data;

    if (response.status >= 500) {
      status = "error";
      errorMsg = `HTTP ${response.status}`;
      throw withMeta(new Error(errorMsg), { status: response.status, body });
    }

    if (!body || typeof body !== "object") {
      status = "error";
      const preview = typeof body === "string" ? body.slice(0, 300) : String(body).slice(0, 300);
      errorMsg = `Niepoprawny format odpowiedzi (HTTP ${response.status}, nie-JSON): ${preview}`;
      throw withMeta(new Error(errorMsg), { status: response.status, body: preview });
    }

    if (!body.ok) {
      status = "api_error";
      errorMsg = body.error || "Nieznany błąd API";
      throw withMeta(new Error(errorMsg), {
        code: body.status,
        response: body,
      });
    }

    result = body.data;
    return result;
  } catch (err) {
    if (!errorMsg) errorMsg = err.message;
    if (status === "ok") status = "error";
    throw err;
  } finally {
    if (!opts.silent) {
      try {
        logOperation({
          endpoint: path,
          params,
          status,
          error: errorMsg,
          duration_ms: Date.now() - startedAt,
          result_summary: summarize(result),
        });
      } catch (e) {
        // log nie powinien wywrócić requestu
        console.error("[api] logOperation failed:", e.message);
      }
    }
  }
}

function withMeta(err, meta) {
  Object.assign(err, meta);
  return err;
}

function summarize(v) {
  if (v == null) return null;
  try {
    const s = JSON.stringify(v);
    return s.length > 500 ? s.slice(0, 500) + "…" : s;
  } catch {
    return null;
  }
}

// ===== Konwencjonalne wrappery na endpointy =====
// Niektóre ścieżki są pewne (jak /domain/check), inne to nasze najlepsze zgadnięcia
// na bazie konwencji AfterMarket. Każdy wrapper można w razie potrzeby naprawić
// jednym miejscu, bez ruszania MCP servera.

export const domain = {
  /** Sprawdza dostępność listy domen. */
  check: (names) => callApi("/domain/check", { names: arrify(names) }),

  /** Lista domen w portfolio użytkownika. */
  list: (params = {}) => callApi("/domain/list", params),

  /** Szczegóły jednej domeny z portfolio użytkownika. */
  info: (name) => callApi("/domain/get", { name }),

  /** Rejestracja nowej domeny (płatna od razu). */
  order: (params) => callApi("/domain/add", params),

  /** Rejestracja "suspended" — zlecenie wisi na /order/list, można aktywować przez /order/resume.
   *  Wg docs: jeśli koszt 0, wykona się od razu. Bezpieczniejszy dry-run niż /domain/add. */
  orderSuspended: (params) => callApi("/domain/add/suspended", params),

  /** Przedłużenie domeny (płatne). */
  renew: (params) => callApi("/domain/renew", params),

  /** Reaktywacja wygasającej domeny. */
  reactivate: (params) => callApi("/domain/reactivate", params),

  /** Notatki i tagi po stronie AM (osobne od naszej lokalnej bazy). */
  noteGet: (name) => callApi("/domain/note/get", { name }),
  noteSet: (name, note) => callApi("/domain/note/set", { name, note }),
  tagAssign: (name, tag) => callApi("/domain/tag/assign", { name, tag }),
  tagList: (name) => callApi("/domain/tag/list", { name }),
  tagRemove: (name, tag) => callApi("/domain/tag/remove", { name, tag }),
};

// AfterMarket nazywa to "buyer/catch", nie "dropcatch" — endpointy /buyer/catch/*.
export const dropcatch = {
  add: (params) => callApi("/buyer/catch/add", params),
  list: (params = {}) => callApi("/buyer/catch/list", params),
  remove: (params) => callApi("/buyer/catch/remove", params),
  /** Notatki na pozycji catch-listy. */
  noteGet: (name) => callApi("/buyer/catch/note/get", { name }),
  noteSet: (name, note) => callApi("/buyer/catch/note/set", { name, note }),
  /** Już złapane / nieziłapane domeny. */
  caughtList: (params = {}) => callApi("/buyer/caught/list", params),
  notcaughtList: (params = {}) => callApi("/buyer/notcaught/list", params),
  /** Lista WSZYSTKICH wygasających domen z giełdy AM — do szukania kandydatów. */
  expiringList: (params = {}) => callApi("/buyer/expiring/domain/list", params),
  expiringCategories: (params = {}) => callApi("/buyer/expiring/domain/category/list", params),
};

export const helper = {
  /** Konwersja IDN (np. ąść.pl -> xn--...). */
  idnEncode: (name) => callApi("/helper/idn/encode", { name }),
  idnDecode: (name) => callApi("/helper/idn/decode", { name }),
};

function arrify(v) {
  return Array.isArray(v) ? v : [v];
}

/**
 * Mapuje surowy rekord z /domain/list na kształt naszego portfolio w SQLite.
 * API zwraca: added/time (Unix ts), expires (Unix ts), autorenew (bool), note (string), tags (string).
 */
export function portfolioRowFromApi(r) {
  return {
    name: r.name || r.utfname || r.nameIDN,
    registered_at: tsToDate(r.added ?? r.time),
    expires_at: tsToDate(r.expires),
    auto_renew: !!r.autorenew,
    tags: r.tags || null,
    notes: r.note || null,
  };
}

function tsToDate(ts) {
  if (!ts || typeof ts !== "number") return null;
  return new Date(ts * 1000).toISOString().slice(0, 10);
}
