import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv, User } from '../env';
import { now, randomToken, sha256hex } from './util';

const COOKIE = 'tm_session';
const SESSION_DAYS = 60;

export const TOKEN_TTL = {
  set_password: 14 * 24 * 3600, // link z zaproszeniem: 14 dni
  login: 20 * 60, // link do logowania: 20 minut
} as const;
export type TokenPurpose = keyof typeof TOKEN_TTL;

export async function createSession(c: Context<AppEnv>, userId: number): Promise<void> {
  const token = randomToken(32);
  const t = now();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').bind(
      await sha256hex(token),
      userId,
      t + SESSION_DAYS * 86400,
      t,
    ),
    c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(t, userId),
    // sprzątanie wygasłych sesji i tokenów przy okazji
    c.env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t),
    c.env.DB.prepare('DELETE FROM tokens WHERE expires_at < ?').bind(t - 86400),
  ]);
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  });
}

export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, COOKIE);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(await sha256hex(token)).run();
  deleteCookie(c, COOKIE, { path: '/', secure: true });
}

/** Ładuje zalogowanego użytkownika (lub null) do c.var.user */
export const loadUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, COOKIE);
  let user: User | null = null;
  let hash: string | null = null;
  if (token) {
    hash = await sha256hex(token);
    user = await c.env.DB.prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id_hash = ? AND s.expires_at > ? AND u.active = 1`,
    )
      .bind(hash, now())
      .first<User>();
  }
  c.set('user', user);
  c.set('sessionHash', user ? hash : null);
  await next();
};

/** Proste zabezpieczenie CSRF: żądania zmieniające dane muszą pochodzić z tej samej domeny */
export const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('origin');
    if (origin && new URL(origin).host !== new URL(c.req.url).host) {
      return c.text('Nieprawidłowe źródło żądania', 403);
    }
  }
  await next();
};

export async function createToken(db: D1Database, userId: number, purpose: TokenPurpose): Promise<string> {
  const token = randomToken(32);
  const t = now();
  const stmts = [];
  // jeden ważny link do ustawienia hasła na osobę — nowy unieważnia poprzednie
  if (purpose === 'set_password') {
    stmts.push(db.prepare("DELETE FROM tokens WHERE user_id = ? AND purpose = 'set_password' AND used_at IS NULL").bind(userId));
  }
  stmts.push(
    db
      .prepare('INSERT INTO tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(await sha256hex(token), userId, purpose, t + TOKEN_TTL[purpose], t),
  );
  await db.batch(stmts);
  return token;
}

/** Sprawdza token bez zużywania go (do wyświetlenia strony) */
export async function peekToken(db: D1Database, token: string, purpose: TokenPurpose): Promise<User | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  return db
    .prepare(
      `SELECT u.* FROM tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ? AND t.purpose = ? AND t.used_at IS NULL AND t.expires_at > ? AND u.active = 1`,
    )
    .bind(await sha256hex(token), purpose, now())
    .first<User>();
}

/** Zużywa token (atomowo) i zwraca użytkownika */
export async function consumeToken(db: D1Database, token: string, purpose: TokenPurpose): Promise<User | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const t = now();
  const row = await db
    .prepare(
      `UPDATE tokens SET used_at = ? WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
       RETURNING user_id`,
    )
    .bind(t, await sha256hex(token), purpose, t)
    .first<{ user_id: number }>();
  if (!row) return null;
  return db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').bind(row.user_id).first<User>();
}

export function linkFor(c: Context, purpose: TokenPurpose, token: string): string {
  const origin = new URL(c.req.url).origin;
  return purpose === 'set_password' ? `${origin}/ustaw-haslo/${token}` : `${origin}/zaloguj/${token}`;
}

/** Bezpieczny adres powrotu po logowaniu (tylko ścieżki w tej domenie) */
export function safeNext(next: string | undefined | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  return next;
}
