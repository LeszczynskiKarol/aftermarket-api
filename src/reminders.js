// Skanuje lokalne portfolio i wypisuje domeny do przedłużenia.
// Uruchamiaj ręcznie (`node src/reminders.js`) albo z Windows Task Scheduler raz dziennie.
//
// Wypisuje na stdout listę domen i exit code != 0 jeśli coś wymaga uwagi —
// ułatwia integrację z innymi narzędziami.

import { listPortfolio, wasReminderSent, markReminderSent } from "./db.js";

const WINDOWS = [30, 14, 7, 3, 1]; // dni do wygaśnięcia, dla których pokażemy alert

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const diff = d.getTime() - Date.now();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function pickWindow(days) {
  // największe okno które domena już osiągnęła (np. zostało 5 dni -> okno 7)
  for (const w of WINDOWS) {
    if (days != null && days <= w) return w;
  }
  return null;
}

const rows = listPortfolio({});
const alerts = [];

for (const r of rows) {
  const days = daysUntil(r.expires_at);
  if (days == null) continue;
  if (days < -1) continue; // wygasłe od dawna pomijamy
  const win = pickWindow(days);
  if (win == null) continue;
  if (wasReminderSent(r.name, win)) continue;
  alerts.push({ name: r.name, expires_at: r.expires_at, days_left: days, window: win, auto_renew: !!r.auto_renew });
  markReminderSent(r.name, win);
}

if (alerts.length === 0) {
  console.log("Brak domen wymagających uwagi.");
  process.exit(0);
}

console.log(`\nDomeny do przedłużenia (${alerts.length}):\n`);
for (const a of alerts) {
  const ar = a.auto_renew ? " [auto-renew]" : "";
  console.log(`  ${a.name.padEnd(40)} ${a.days_left}d  (wygasa ${a.expires_at})${ar}`);
}
console.log("");
process.exit(2); // != 0 żeby cron mógł odpalić powiadomienie
