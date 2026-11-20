import type { Contest, ContestRow, EntryRow, User } from '../env';
import { parseMethods, tally, type MethodId, type Tally } from './voting';
import { safeJson } from './util';

export const PHASES = {
  draft: 'Szkic (widzi tylko admin)',
  submissions: 'Zgłoszenia',
  voting: 'Głosowanie',
  closed: 'Zakończony',
} as const;

export const RESULTS_MODES = {
  admin: 'Tylko admin',
  after_vote: 'Członkowie widzą wyniki po oddaniu głosu',
  closed: 'Członkowie widzą wyniki po zakończeniu',
} as const;

export const ROLLUP_DEFAULTS = { width_mm: 850, height_mm: 2000, max_mb: 95, max_entries: 3 };

export function toContest(row: ContestRow): Contest {
  return { ...row, methods: parseMethods(row.methods), settings: safeJson(row.settings, {}) };
}

export async function getContest(db: D1Database, slugOrId: string | number): Promise<Contest | null> {
  const row =
    typeof slugOrId === 'number'
      ? await db.prepare('SELECT * FROM contests WHERE id = ?').bind(slugOrId).first<ContestRow>()
      : await db.prepare('SELECT * FROM contests WHERE slug = ?').bind(slugOrId).first<ContestRow>();
  return row ? toContest(row) : null;
}

export async function listContests(db: D1Database, includeDraft: boolean): Promise<Contest[]> {
  const { results } = await db
    .prepare(`SELECT * FROM contests ${includeDraft ? '' : "WHERE phase != 'draft'"} ORDER BY position, created_at DESC`)
    .all<ContestRow>();
  return results.map(toContest);
}

/** Widoczne propozycje (do głosowania) */
export async function listEntries(db: D1Database, contestId: number, withHidden = false): Promise<EntryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM entries WHERE contest_id = ? AND upload_complete = 1 ${withHidden ? '' : 'AND hidden = 0'}
       ORDER BY position, id`,
    )
    .bind(contestId)
    .all<EntryRow>();
  return results;
}

export async function userBallots(db: D1Database, contestId: number, userId: number): Promise<Record<string, unknown>> {
  const { results } = await db
    .prepare('SELECT method, data FROM ballots WHERE contest_id = ? AND user_id = ?')
    .bind(contestId, userId)
    .all<{ method: string; data: string }>();
  return Object.fromEntries(results.map((r) => [r.method, safeJson(r.data, {})]));
}

export async function computeTally(db: D1Database, contest: Contest, method: MethodId, entries?: EntryRow[]): Promise<Tally> {
  const es = entries ?? (await listEntries(db, contest.id));
  const { results } = await db
    .prepare('SELECT data FROM ballots WHERE contest_id = ? AND method = ?')
    .bind(contest.id, method)
    .all<{ data: string }>();
  return tally(
    method,
    results.map((r) => safeJson(r.data, {})),
    es.map((e) => ({ id: e.id, title: e.title })),
  );
}

/** Wyniki wielu metod jednym zapytaniem */
export async function computeTallies(db: D1Database, contest: Contest, methods: MethodId[], entries: EntryRow[]): Promise<Partial<Record<MethodId, Tally>>> {
  if (!methods.length) return {};
  const { results } = await db.prepare('SELECT method, data FROM ballots WHERE contest_id = ?').bind(contest.id).all<{ method: string; data: string }>();
  const lite = entries.map((e) => ({ id: e.id, title: e.title }));
  const out: Partial<Record<MethodId, Tally>> = {};
  for (const m of methods) {
    out[m] = tally(
      m,
      results.filter((r) => r.method === m).map((r) => safeJson(r.data, {})),
      lite,
    );
  }
  return out;
}

/** Admin systemu zarządza wszystkim; opiekun — tylko przypisanymi konkursami */
export async function canManage(db: D1Database, user: User, contestId: number): Promise<boolean> {
  if (user.preview) return false;
  if (user.role === 'admin') return true;
  const row = await db.prepare('SELECT 1 AS ok FROM contest_managers WHERE contest_id = ? AND user_id = ?').bind(contestId, user.id).first();
  return Boolean(row);
}

export async function managedContestIds(db: D1Database, userId: number): Promise<Set<number>> {
  const { results } = await db.prepare('SELECT contest_id FROM contest_managers WHERE user_id = ?').bind(userId).all<{ contest_id: number }>();
  return new Set(results.map((r) => r.contest_id));
}

/** Czy użytkownik może zobaczyć wyniki danej metody (admin i opiekun konkursu — zawsze) */
export function canSeeResults(contest: Contest, user: User, votedInMethod: boolean, manager = false): boolean {
  if (user.role === 'admin' || manager) return true;
  if (contest.results === 'after_vote') return votedInMethod || contest.phase === 'closed';
  if (contest.results === 'closed') return contest.phase === 'closed';
  return false;
}

export function isTestMode(contest: Contest): boolean {
  return contest.methods.length > 1;
}

export interface LeaderRow {
  user_id: number;
  name: string;
  guests: number;
  rank: number;
}

/** Ranking „kto przyprowadził najwięcej gości” — liczony z rejestru wizyt */
export async function leaderboard(db: D1Database, contestId: number): Promise<LeaderRow[]> {
  const { results } = await db
    .prepare(
      `SELECT v.user_id, COALESCE(NULLIF(u.name, ''), u.email) AS name, COUNT(*) AS guests
       FROM guest_visits v JOIN users u ON u.id = v.user_id
       WHERE v.contest_id = ? GROUP BY v.user_id ORDER BY guests DESC, name`,
    )
    .bind(contestId)
    .all<{ user_id: number; name: string; guests: number }>();
  let rank = 0;
  let prev = -1;
  return results.map((r, i) => {
    if (r.guests !== prev) rank = i + 1;
    prev = r.guests;
    return { ...r, rank };
  });
}

/** Ocena zgłoszenia przez opiekuna konkursu */
export const REVIEW_VERDICTS = {
  ok: { cls: 'ok', text: 'Spełnia wymagania' },
  fix: { cls: 'warn', text: 'Do poprawy' },
  reject: { cls: 'err', text: 'Nie spełnia wymagań' },
} as const;
export type ReviewVerdict = keyof typeof REVIEW_VERDICTS;
export const isReviewVerdict = (v: unknown): v is ReviewVerdict => typeof v === 'string' && v in REVIEW_VERDICTS;

export interface EntryReview {
  id: number;
  entry_id: number;
  verdict: ReviewVerdict | null;
  comment: string;
  reviewer: string;
  mailed: number | null;
  created_at: number;
}

/** Uwagi do zgłoszeń konkursu, pogrupowane po zgłoszeniu. onlyAuthor: tylko do projektów tej osoby. */
export async function entryReviews(db: D1Database, contestId: number, onlyAuthor: number | null): Promise<Map<number, EntryReview[]>> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.entry_id, r.verdict, r.comment, r.mailed, r.created_at, COALESCE(NULLIF(u.name, ''), u.email, '-') AS reviewer
       FROM entry_reviews r JOIN entries e ON e.id = r.entry_id LEFT JOIN users u ON u.id = r.author_id
       WHERE e.contest_id = ? ${onlyAuthor === null ? '' : 'AND e.author_id = ?'} ORDER BY r.created_at, r.id`,
    )
    .bind(...(onlyAuthor === null ? [contestId] : [contestId, onlyAuthor]))
    .all<EntryReview>();
  const map = new Map<number, EntryReview[]>();
  for (const r of results) {
    const list = map.get(r.entry_id) ?? [];
    list.push({ ...r, verdict: isReviewVerdict(r.verdict) ? r.verdict : null });
    map.set(r.entry_id, list);
  }
  return map;
}
