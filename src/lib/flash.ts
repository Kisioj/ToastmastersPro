import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

export interface Flash {
  type: 'ok' | 'err' | 'info';
  msg: string;
}

const NAME = 'tm_flash';

export function setFlash(c: Context, type: Flash['type'], msg: string): void {
  setCookie(c, NAME, encodeURIComponent(JSON.stringify({ type, msg })), { path: '/', httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 60 });
}

export function takeFlash(c: Context): Flash | null {
  const raw = getCookie(c, NAME);
  if (!raw) return null;
  deleteCookie(c, NAME, { path: '/', secure: true });
  try {
    const f = JSON.parse(decodeURIComponent(raw)) as Flash;
    return ['ok', 'err', 'info'].includes(f.type) && typeof f.msg === 'string' ? f : null;
  } catch {
    return null;
  }
}
