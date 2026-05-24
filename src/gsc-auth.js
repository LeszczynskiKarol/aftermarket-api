// Jednorazowy OAuth flow dla GSC.
// Uruchom: npm run gsc:auth
//
// Co robi:
// 1. Stawia lokalny serwer HTTP na 127.0.0.1:53682
// 2. Otwiera przeglądarkę z URL-em Google OAuth
// 3. Łapie callback z kodem
// 4. Wymienia kod na refresh_token
// 5. Dopisuje GOOGLE_REFRESH_TOKEN do .env

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";
import { config } from "dotenv";
import openModule from "open";

config();

const open = openModule.default || openModule;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(__dirname, "..", ".env");

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth2/callback`;
const SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "Brak GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET w .env\n" +
    "Wejdź na https://console.cloud.google.com/apis/credentials i stwórz OAuth 2.0 Client ID (typ: Desktop application).\n" +
    "Potem wklej do .env i uruchom ponownie."
  );
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent", // żeby zawsze dostać refresh_token
  scope: SCOPES,
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname !== "/oauth2/callback") {
      res.writeHead(404); res.end("not found"); return;
    }
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (error) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<h1>Błąd: ${error}</h1>`);
      console.error("OAuth error:", error);
      server.close();
      process.exit(1);
    }
    if (!code) {
      res.writeHead(400); res.end("no code"); return;
    }

    const { tokens } = await oauth2.getToken(code);
    if (!tokens.refresh_token) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>Brak refresh_token. Usuń aplikację z https://myaccount.google.com/permissions i spróbuj ponownie.</h1>");
      console.error("Google nie zwróciło refresh_token. Możliwe że już raz autoryzowałeś — wycofaj dostęp i spróbuj ponownie.");
      server.close();
      process.exit(1);
    }

    writeRefreshToken(tokens.refresh_token);

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<h1>OK</h1><p>refresh_token zapisany w .env. Możesz zamknąć tę zakładkę.</p>`);
    console.log("\n✓ refresh_token zapisany w", ENV_PATH);
    console.log("  Sprawdź: npm run am -- gsc sites");
    setTimeout(() => { server.close(); process.exit(0); }, 500);
  } catch (e) {
    console.error("Błąd:", e.message);
    try { res.writeHead(500); res.end(e.message); } catch {}
    server.close();
    process.exit(1);
  }
});

function writeRefreshToken(token) {
  let env = "";
  try { env = fs.readFileSync(ENV_PATH, "utf8"); } catch {}
  const line = `GOOGLE_REFRESH_TOKEN=${token}`;
  if (env.match(/^GOOGLE_REFRESH_TOKEN=.*/m)) {
    env = env.replace(/^GOOGLE_REFRESH_TOKEN=.*$/m, line);
  } else {
    if (env && !env.endsWith("\n")) env += "\n";
    env += line + "\n";
  }
  fs.writeFileSync(ENV_PATH, env);
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Słucham na ${REDIRECT_URI}`);
  console.log("Otwieram przeglądarkę...");
  open(authUrl).catch(() => {
    console.log("Nie udało się otworzyć przeglądarki. Otwórz ręcznie:");
    console.log(authUrl);
  });
});
