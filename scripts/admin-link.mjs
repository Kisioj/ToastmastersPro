#!/usr/bin/env node
// Dodaje osobę (opcjonalnie jako admina) i wypisuje jej link do ustawienia hasła.
// Przydatne na start, zanim zadziała wysyłka maili.
//
//   node scripts/admin-link.mjs jan@example.com --name "Jan Kowalski" --admin            # lokalna baza
//   node scripts/admin-link.mjs jan@example.com --admin --remote --url https://twoja-domena
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const email = (args.find((a) => !a.startsWith('--') && a.includes('@')) || '').trim().toLowerCase();
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) {
  console.error('Użycie: node scripts/admin-link.mjs <email> [--name "Imię Nazwisko"] [--admin] [--remote] [--url https://adres]');
  process.exit(1);
}
const remote = args.includes('--remote');
const isAdmin = args.includes('--admin');
const name = opt('name') ?? '';
const url = (opt('url') ?? (remote ? '' : 'http://localhost:8787')).replace(/\/$/, '');
if (!url) {
  console.error('Podaj adres strony: --url https://...workers.dev');
  process.exit(1);
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const token = randomBytes(32).toString('base64url');
const hash = createHash('sha256').update(token).digest('hex');
const now = Math.floor(Date.now() / 1000);
const sql = `
INSERT INTO users (email, name, role, created_at) VALUES (${q(email)}, ${q(name)}, ${q(isAdmin ? 'admin' : 'member')}, ${now})
  ON CONFLICT(email) DO UPDATE SET active = 1,
    name = CASE WHEN excluded.name != '' THEN excluded.name ELSE users.name END,
    role = CASE WHEN ${isAdmin ? 1 : 0} THEN 'admin' ELSE users.role END;
DELETE FROM tokens WHERE purpose = 'set_password' AND used_at IS NULL AND user_id = (SELECT id FROM users WHERE email = ${q(email)});
INSERT INTO tokens (token_hash, user_id, purpose, expires_at, created_at)
  SELECT ${q(hash)}, id, 'set_password', ${now + 14 * 86400}, ${now} FROM users WHERE email = ${q(email)};
UPDATE users SET invited_at = ${now} WHERE email = ${q(email)};
`;
const wrangler = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.bin', 'wrangler');
execFileSync(wrangler, ['d1', 'execute', 'DB', remote ? '--remote' : '--local', '--command', sql], { stdio: ['ignore', 'ignore', 'inherit'] });
console.log(`\n${isAdmin ? 'Admin' : 'Osoba'} ${email} — link do ustawienia hasła (ważny 14 dni, jednorazowy):\n${url}/ustaw-haslo/${token}\n`);
