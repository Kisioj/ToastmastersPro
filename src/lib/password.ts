import { b64, fromB64 } from './util';

/**
 * PBKDF2-SHA256 z WebCrypto (natywne w Workers).
 * Darmowy plan Workers ma limit 10 ms CPU na żądanie — 100 000 iteracji zajmuje ~10 ms,
 * więc używamy 50 000 (~5 ms). Liczba iteracji jest zapisana w hashu, można ją później podnieść.
 */
const ITERATIONS = 50_000;
export const MIN_PASSWORD = 8;

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2-sha256$${ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [alg, iterStr, saltStr, hashStr] = stored.split('$');
  if (alg !== 'pbkdf2-sha256') return false;
  const iterations = Number(iterStr);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100_000) return false;
  const expected = fromB64(hashStr);
  const actual = await derive(password, fromB64(saltStr), iterations);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

/** Bez pola „powtórz hasło” — jest przycisk „Pokaż hasło” i menedżer haseł przeglądarki */
export function passwordProblem(pw: string): string | null {
  if (pw.length < MIN_PASSWORD) return `Hasło musi mieć co najmniej ${MIN_PASSWORD} znaków.`;
  if (pw.length > 200) return 'Hasło jest za długie.';
  return null;
}
