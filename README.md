# aftermarket-local

Lokalny system do zarządzania portfolio domen w AfterMarket.pl —
wyszukiwanie, rejestracja, przedłużanie i przechwytywanie wygasających domen.

Działa w dwóch trybach jednocześnie:
- **CLI** (`node src/cli.js …`) — dla Ciebie z terminala
- **MCP server** (stdio) — dla Claude Code, który może wykonywać operacje za Ciebie

Stan trzymany lokalnie w SQLite (`data/aftermarket.db`): portfolio z notatkami i
tagami, watchlista interesujących domen, kolejka dropcatchu, log wszystkich
operacji API.

## Setup

```powershell
# 1. Zainstaluj zależności
npm install

# 2. Skopiuj .env.example i wpisz klucze
copy .env.example .env
# Następnie wyedytuj .env i wklej:
#   AM_API_KEY=...
#   AM_API_SECRET=...
# Klucze generujesz na https://www.aftermarket.pl/API/Create/

# 3. Smoke test — sprawdza dostępność jakiejś domeny
npm run am -- check przykladowa-testowa-domena-12345.pl
```

## CLI — najczęstsze operacje

```powershell
# Sprawdzanie dostępności
npm run am -- check foo.pl bar.com

# Rejestracja (kosztuje!)
npm run am -- register foo.pl --period 1

# Przedłużenie (kosztuje!)
npm run am -- renew foo.pl --period 2

# Synchronizacja portfolio z API do lokalnej bazy
npm run am -- portfolio sync

# Lista lokalna z filtrem wygasających w 30 dni
npm run am -- portfolio --expiring 30

# Dropcatch
npm run am -- dropcatch add foo.pl --max-price 100
npm run am -- dropcatch                 # lokalna kolejka
npm run am -- dropcatch remote          # co siedzi po stronie API

# Surowe wywołanie dowolnego endpointu (przydatne do eksploracji)
npm run am -- call /domain/check --json '{"names":["foo.pl"]}'

# Log ostatnich operacji
npm run am -- log --limit 20
```

## Claude Code (MCP)

Plik `.mcp.json` w katalogu projektu automatycznie rejestruje server
`aftermarket` dla Claude Code uruchomionego w tym folderze. Po `claude` w
`D:\aftermarket-api` Claude zobaczy tools:

- `domain_check`, `domain_info`, `domain_register`, `domain_renew`
- `portfolio_sync`, `portfolio_list`, `portfolio_get`, `portfolio_set`, `portfolio_remove`
- `watchlist_add`, `watchlist_list`, `watchlist_remove`
- `dropcatch_add`, `dropcatch_list_remote`, `dropcatch_list_local`, `dropcatch_remove`
- `idn_encode`, `op_log`
- `am_api_call` — escape hatch do dowolnego endpointu
- `moz_url_metrics` — DA/PA/spam dla nowych domen
- `gsc_sites_list`, `gsc_summary`, `gsc_top_queries`, `gsc_top_pages`, `gsc_query`

Operacje kosztowne (`register`, `renew`, `dropcatch_add`) powinny być
zatwierdzane ręcznie w prompcie Claude Code. Operacje read-only możesz
auto-approve w `~/.claude/settings.json`.

## Moz (DA/PA dla nowych domen)

```powershell
# Wklej MOZ_TOKEN do .env (z https://moz.com/products/api -> Manage Tokens)
npm run am -- moz example.com
npm run am -- moz foo.com bar.com baz.com    # batch
npm run am -- moz example.com --force        # pomiń cache (cache TTL 7 dni)
```

UWAGA: Plan Starter Medium ma 3000 req/miesiąc. Cache trzymamy 7 dni
w SQLite — to samo zapytanie nie liczy się do kwoty.

## GSC (Search Console dla Twoich domen)

Setup jednorazowy:
```powershell
# 1. https://console.cloud.google.com/apis/credentials
#    -> Create OAuth 2.0 Client ID -> Desktop application
#    Wklej client_id i client_secret do .env
# 2. Włącz Search Console API:
#    https://console.cloud.google.com/apis/library/searchconsole.googleapis.com
# 3. Jednorazowy flow OAuth:
npm run gsc:auth
#    Otworzy się przeglądarka, zalogujesz się, refresh_token sam się zapisze do .env
```

Użycie:
```powershell
npm run am -- gsc sites                              # zweryfikowane properties
npm run am -- gsc summary foo.pl                     # 28d + porównanie do 28d wstecz
npm run am -- gsc summary foo.pl --days 90
npm run am -- gsc top-queries foo.pl --days 28 --limit 50
npm run am -- gsc top-pages foo.pl --days 28
```

Auto-match: `foo.pl` automatycznie próbuje `sc-domain:foo.pl`, potem
`https://foo.pl/`, `http://foo.pl/`, warianty z `www`. Jeśli nie znajdzie —
wypisuje listę dostępnych properties.

## Reminders

`node src/reminders.js` skanuje portfolio i wypisuje domeny wygasające w
oknach 30/14/7/3/1 dni. Każde okno raportowane jest tylko raz na domenę
(tabela `reminders_sent`). Wpinasz w Windows Task Scheduler raz dziennie.

## Pliki

```
src/api.js          — warstwa nad aftermarketpl-api + log
src/db.js           — SQLite (portfolio, watchlist, dropcatch, op_log, reminders_sent, api_cache)
src/mcp-server.js   — MCP server stdio dla Claude Code
src/cli.js          — CLI
src/reminders.js    — skaner przypomnień
src/moz.js          — Moz Links API v2 (DA/PA/spam) z cache
src/gsc.js          — Google Search Console (sites + searchanalytics) z cache
src/gsc-auth.js     — jednorazowy OAuth flow (npm run gsc:auth)
.mcp.json           — rejestracja MCP w Claude Code (project scope)
.env                — klucze API (NIE commituj)
data/aftermarket.db — baza SQLite (NIE commituj)
```

## Endpointy do potwierdzenia

Biblioteka `aftermarketpl-api` to tylko generyczny `send(path, params)`.
Dokumentacja na https://json.aftermarket.pl/__docs/ używa zaciemnionych
hashy w nawigacji, więc nie udało się wyciągnąć wszystkich ścieżek
automatycznie. W `src/api.js` użyto następujących (część to nasze
najlepsze zgadnięcia — zweryfikuj pierwszym `am_api_call` jeśli zwróci 404):

- `/domain/check`     — potwierdzone w README biblioteki
- `/domain/list`      — do weryfikacji
- `/domain/info`      — do weryfikacji
- `/domain/order/add` — do weryfikacji
- `/domain/renew`     — do weryfikacji
- `/dropcatch/add`    — do weryfikacji
- `/dropcatch/list`   — do weryfikacji
- `/dropcatch/remove` — do weryfikacji

Jeśli któraś ścieżka jest błędna — popraw w `src/api.js` w jednym miejscu,
MCP/CLI same się dostosują.
# aftermarket-api
