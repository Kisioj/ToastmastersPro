import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv, Contest, EntryRow, User } from '../env';
import { aiLimitCheck, recordAiUse, reviewDesign } from '../lib/ai';
import { canManage, canSeeResults, computeTally, getContest, listEntries, ROLLUP_DEFAULTS } from '../lib/contests';
import { setFlash } from '../lib/flash';
import { CHUNK_SIZE, concatParts, deleteParts, getStore } from '../lib/storage';
import { b64, now, randomToken, safeJson } from '../lib/util';
import { addDuel, isMethod, validateBallot } from '../lib/voting';
import { AiReviewView } from '../views/reports';

export const api = new Hono<AppEnv>();

const ALLOWED_TYPES = ['application/pdf', 'image/svg+xml', 'image/jpeg', 'image/png', 'image/webp'];

const err = (c: Context, msg: string, status = 400) => c.json({ ok: false, error: msg }, status as 400);

async function readJson<T>(c: Context, maxBytes = 64 * 1024): Promise<T | null> {
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > maxBytes) return null;
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

type ManagedContest = Contest & { manager: boolean };

/** Szkic jest otwarty do głosowania (podglądu) tylko dla admina i opiekuna konkursu */
function votingOpen(contest: ManagedContest): boolean {
  return contest.phase === 'voting' || (contest.phase === 'draft' && contest.manager);
}

async function contestFor(c: Context<AppEnv>): Promise<ManagedContest | null> {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return null;
  const contest = await getContest(c.env.DB, id);
  if (!contest) return null;
  const manager = await canManage(c.env.DB, c.var.user!, contest.id);
  if (contest.phase === 'draft' && !manager) return null;
  return { ...contest, manager };
}

// ——— głosowanie ———

api.post('/api/konkursy/:id/glos', async (c) => {
  const user = c.var.user!;
  const contest = await contestFor(c);
  if (!contest) return err(c, 'Nie ma takiego konkursu.', 404);
  if (!votingOpen(contest)) return err(c, 'Głosowanie jest zamknięte.', 409);
  const body = await readJson<{ method?: string; data?: unknown }>(c);
  if (!body || !isMethod(body.method) || !contest.methods.includes(body.method) || body.method === 'duel')
    return err(c, 'Nieprawidłowy sposób głosowania.');
  const entries = await listEntries(c.env.DB, contest.id);
  const v = validateBallot(body.method, body.data, entries.map((e) => e.id), contest.settings.points_budget ?? 10);
  if (!v.ok) return err(c, v.error);
  await c.env.DB.prepare(
    `INSERT INTO ballots (contest_id, user_id, method, data, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(contest_id, user_id, method) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  )
    .bind(contest.id, user.id, body.method, JSON.stringify(v.data), now())
    .run();
  const results = canSeeResults(contest, user, true, contest.manager) ? await computeTally(c.env.DB, contest, body.method, entries) : null;
  return c.json({ ok: true, data: v.data, results });
});

api.post('/api/konkursy/:id/pojedynek', async (c) => {
  const user = c.var.user!;
  const contest = await contestFor(c);
  if (!contest) return err(c, 'Nie ma takiego konkursu.', 404);
  if (!votingOpen(contest) || !contest.methods.includes('duel')) return err(c, 'Pojedynki są wyłączone.', 409);
  const body = await readJson<{ winner?: number; loser?: number }>(c);
  const entries = await listEntries(c.env.DB, contest.id);
  const ids = new Set(entries.map((e) => e.id));
  if (!body || !ids.has(Number(body.winner)) || !ids.has(Number(body.loser)) || body.winner === body.loser) return err(c, 'Nieprawidłowy pojedynek.');
  const prev = await c.env.DB.prepare("SELECT data FROM ballots WHERE contest_id = ? AND user_id = ? AND method = 'duel'")
    .bind(contest.id, user.id)
    .first<{ data: string }>();
  const data = addDuel(safeJson(prev?.data, {}), Number(body.winner), Number(body.loser));
  await c.env.DB.prepare(
    `INSERT INTO ballots (contest_id, user_id, method, data, updated_at) VALUES (?, ?, 'duel', ?, ?)
     ON CONFLICT(contest_id, user_id, method) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  )
    .bind(contest.id, user.id, JSON.stringify(data), now())
    .run();
  const results = canSeeResults(contest, user, true, contest.manager) ? await computeTally(c.env.DB, contest, 'duel', entries) : null;
  return c.json({ ok: true, data, results });
});

api.post('/api/konkursy/:id/glos/usun', async (c) => {
  const user = c.var.user!;
  const contest = await contestFor(c);
  if (!contest) return err(c, 'Nie ma takiego konkursu.', 404);
  if (!votingOpen(contest)) return err(c, 'Głosowanie jest zamknięte.', 409);
  const body = await readJson<{ method?: string }>(c);
  if (!body || !isMethod(body.method)) return err(c, 'Nieprawidłowy sposób głosowania.');
  await c.env.DB.prepare('DELETE FROM ballots WHERE contest_id = ? AND user_id = ? AND method = ?').bind(contest.id, user.id, body.method).run();
  return c.json({ ok: true });
});

// ——— zgłoszenia rollupu ———

api.post('/api/konkursy/:id/zgloszenia', async (c) => {
  const user = c.var.user!;
  const store = getStore(c.env);
  if (!store) return err(c, 'Przechowywanie plików nie jest skonfigurowane.', 503);
  const contest = await contestFor(c);
  if (!contest || contest.kind !== 'rollup') return err(c, 'Nie ma takiego konkursu.', 404);
  if (contest.phase !== 'submissions' && !contest.manager) return err(c, 'Zgłoszenia są zamknięte.', 409);
  const s = { ...ROLLUP_DEFAULTS, ...contest.settings };
  const body = await readJson<{ title?: string; file_name?: string; file_type?: string; file_size?: number; report?: unknown }>(c, 64 * 1024);
  if (!body) return err(c, 'Nieprawidłowe dane.');
  const title = String(body.title ?? '').trim().slice(0, 120);
  const fileName = String(body.file_name ?? 'projekt').replace(/[\r\n"\\/]/g, '_').slice(0, 150);
  const fileType = String(body.file_type ?? '');
  const size = Number(body.file_size);
  if (!title) return err(c, 'Podaj tytuł projektu.');
  if (!ALLOWED_TYPES.includes(fileType)) return err(c, 'Nieobsługiwany format pliku. Wyślij PDF, SVG, JPG, PNG albo WebP.');
  if (!Number.isInteger(size) || size <= 0 || size > s.max_mb * 1024 * 1024) return err(c, `Plik może mieć maksymalnie ${s.max_mb} MB.`);
  const report = JSON.stringify(body.report ?? {});
  if (report.length > 30000) return err(c, 'Raport techniczny jest za duży.');

  const db = c.env.DB;
  // porzucone wysyłki tej osoby (starsze niż godzina) — sprzątamy
  const { results: stale } = await db
    .prepare('SELECT * FROM entries WHERE contest_id = ? AND author_id = ? AND upload_complete = 0 AND created_at < ?')
    .bind(contest.id, user.id, now() - 3600)
    .all<EntryRow>();
  for (const e of stale) {
    if (e.file_key) await deleteParts(store, e.file_key, e.file_parts ?? 0);
    await db.prepare('DELETE FROM entries WHERE id = ?').bind(e.id).run();
  }

  if (user.role !== 'admin') {
    const cnt = await db
      .prepare('SELECT COUNT(*) AS n FROM entries WHERE contest_id = ? AND author_id = ?')
      .bind(contest.id, user.id)
      .first<{ n: number }>();
    if ((cnt?.n ?? 0) >= s.max_entries) return err(c, `Możesz wysłać maksymalnie ${s.max_entries} projekty. Usuń któryś, żeby dodać nowy.`, 409);
  }

  const parts = Math.max(1, Math.ceil(size / CHUNK_SIZE));
  const key = `c${contest.id}/${randomToken(12)}`;
  const row = await db
    .prepare(
      `INSERT INTO entries (contest_id, title, author_id, file_key, file_name, file_type, file_size, file_parts, upload_complete, report, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?) RETURNING id`,
    )
    .bind(contest.id, title, user.id, key, fileName, fileType, size, parts, report, now())
    .first<{ id: number }>();
  return c.json({ ok: true, id: row!.id, parts, chunkSize: CHUNK_SIZE });
});

/** Zgłoszenie dostępne dla autora, admina systemu i opiekuna konkursu (manager = admin lub opiekun) */
async function ownEntry(c: Context<AppEnv>): Promise<(EntryRow & { manager: boolean }) | null> {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return null;
  const e = await c.env.DB.prepare('SELECT * FROM entries WHERE id = ?').bind(id).first<EntryRow>();
  if (!e) return null;
  const manager = await canManage(c.env.DB, c.var.user!, e.contest_id);
  return e.author_id === c.var.user!.id || manager ? { ...e, manager } : null;
}

api.put('/api/zgloszenia/:id/czesc/:n', async (c) => {
  const store = getStore(c.env);
  const e = await ownEntry(c);
  if (!store || !e || !e.file_key || e.upload_complete) return err(c, 'Nie można wysłać tej części.', 404);
  const n = Number(c.req.param('n'));
  const parts = e.file_parts ?? 1;
  if (!Number.isInteger(n) || n < 0 || n >= parts) return err(c, 'Zły numer części.');
  const expected = n < parts - 1 ? CHUNK_SIZE : (e.file_size ?? 0) - CHUNK_SIZE * (parts - 1);
  const len = Number(c.req.header('content-length') ?? -1);
  if (len !== expected || !c.req.raw.body) return err(c, `Zły rozmiar części (${len} zamiast ${expected}).`);
  // strumień prosto do magazynu — Worker nie kopiuje bajtów
  await store.put(`${e.file_key}/${n}`, c.req.raw.body, e.file_type ?? undefined);
  return c.json({ ok: true });
});

api.put('/api/zgloszenia/:id/podglad', async (c) => {
  const store = getStore(c.env);
  const e = await ownEntry(c);
  if (!store || !e || !e.file_key) return err(c, 'Nie można zapisać podglądu.', 404);
  const len = Number(c.req.header('content-length') ?? 0);
  if (len <= 0 || len > 3 * 1024 * 1024) return err(c, 'Podgląd jest za duży.');
  const buf = await c.req.arrayBuffer();
  const head = new Uint8Array(buf, 0, 3);
  if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) return err(c, 'Podgląd musi być plikiem JPEG.');
  await store.put(`${e.file_key}/preview`, buf, 'image/jpeg');
  await c.env.DB.prepare('UPDATE entries SET preview_key = ? WHERE id = ?').bind(`${e.file_key}/preview`, e.id).run();
  return c.json({ ok: true });
});

api.post('/api/zgloszenia/:id/zakoncz', async (c) => {
  const e = await ownEntry(c);
  if (!e) return err(c, 'Nie ma takiego zgłoszenia.', 404);
  await c.env.DB.prepare('UPDATE entries SET upload_complete = 1 WHERE id = ?').bind(e.id).run();
  return c.json({ ok: true });
});

async function runAi(c: Context<AppEnv>, imageB64: string, title: string, report: unknown, unlimited = false) {
  const user = c.var.user!;
  const limited = !unlimited && user.role !== 'admin';
  if (limited) {
    const blocked = await aiLimitCheck(c.env, user.id);
    if (blocked) return { error: blocked, status: 429 as const };
  }
  try {
    const review = await reviewDesign(c.env, { imageB64, title, report });
    // liczymy tylko udane oceny
    if (limited) await recordAiUse(c.env, user.id);
    return { review };
  } catch (e) {
    console.error('AI', e);
    return { error: e instanceof Error ? e.message : 'Ocena AI nie powiodła się.', status: 502 as const };
  }
}

api.post('/api/zgloszenia/:id/ocena-ai', async (c) => {
  const store = getStore(c.env);
  const e = await ownEntry(c);
  if (!store || !e || !e.preview_key) return err(c, 'Brak podglądu do oceny.', 404);
  const stream = await store.get(e.preview_key);
  if (!stream) return err(c, 'Nie znaleziono podglądu.', 404);
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const out = await runAi(c, b64(bytes), e.title, safeJson(e.report, {}), e.manager);
  if ('error' in out) {
    // zapamiętaj powód przy zgłoszeniu (bez błędów limitu osoby), chyba że jest już udana ocena
    const prev = safeJson<{ error?: string } | null>(e.ai_report, null);
    if (out.status !== 429 && (!prev || prev.error)) {
      await c.env.DB.prepare('UPDATE entries SET ai_report = ? WHERE id = ?').bind(JSON.stringify({ error: out.error, created_at: now() }), e.id).run();
    }
    return err(c, out.error!, out.status);
  }
  await c.env.DB.prepare('UPDATE entries SET ai_report = ? WHERE id = ?').bind(JSON.stringify(out.review), e.id).run();
  const html = await (<AiReviewView review={out.review!} />).toString();
  return c.json({ ok: true, review: out.review, html });
});

/** Ocena AI bez zapisywania zgłoszenia (przycisk „Sprawdź zgodność przed wysłaniem”) */
api.post('/api/ocena-ai', async (c) => {
  const body = await readJson<{ image?: string; title?: string; report?: unknown }>(c, 4 * 1024 * 1024);
  if (!body?.image || typeof body.image !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(body.image.slice(0, 200)))
    return err(c, 'Brak obrazu do oceny.');
  const out = await runAi(c, body.image, String(body.title ?? 'projekt').slice(0, 120), body.report ?? {});
  if ('error' in out) return err(c, out.error!, out.status);
  const html = await (<AiReviewView review={out.review!} />).toString();
  return c.json({ ok: true, review: out.review, html });
});

api.post('/zgloszenia/:id/usun', async (c) => {
  const user = c.var.user!;
  const e = await ownEntry(c);
  if (!e) return c.notFound();
  const contest = await getContest(c.env.DB, e.contest_id);
  if (!e.manager && contest?.phase !== 'submissions') {
    setFlash(c, 'err', 'Zgłoszenia można usuwać tylko w trakcie przyjmowania projektów.');
    return c.redirect(`/konkursy/${contest?.slug ?? ''}`);
  }
  const store = getStore(c.env);
  if (store && e.file_key) await deleteParts(store, e.file_key, e.file_parts ?? 0);
  await c.env.DB.prepare('DELETE FROM entries WHERE id = ?').bind(e.id).run();
  setFlash(c, 'ok', `Usunięto „${e.title}”.`);
  const back = c.req.header('referer');
  return c.redirect(back && new URL(back).host === new URL(c.req.url).host ? new URL(back).pathname : `/konkursy/${contest?.slug ?? ''}`);
});

// ——— pliki ———

api.get('/pliki/:id/:what{podglad|plik}', async (c) => {
  const user = c.var.user!;
  const store = getStore(c.env);
  const id = Number(c.req.param('id'));
  const e = await c.env.DB.prepare('SELECT * FROM entries WHERE id = ?').bind(id).first<EntryRow>();
  if (!store || !e || !e.file_key) return c.notFound();
  const contest = await getContest(c.env.DB, e.contest_id);
  const isOwner = e.author_id === user.id || (await canManage(c.env.DB, user, e.contest_id));
  const what = c.req.param('what');

  if (what === 'podglad') {
    const publicToMembers = !e.hidden && e.upload_complete && contest && (contest.phase === 'voting' || contest.phase === 'closed');
    if (!isOwner && !publicToMembers) return c.notFound();
    const s = e.preview_key ? await store.get(e.preview_key) : null;
    if (!s) return c.notFound();
    return new Response(s, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' } });
  }

  if (!isOwner || !e.upload_complete) return c.notFound();
  const name = e.file_name ?? 'projekt';
  return new Response(concatParts(store, e.file_key, e.file_parts ?? 1), {
    headers: {
      'content-type': e.file_type ?? 'application/octet-stream',
      'content-length': String(e.file_size ?? ''),
      'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'private, no-store',
    },
  });
});
