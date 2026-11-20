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

/** Czy użytkownik może zobaczyć wyniki danej metody */
export function canSeeResults(contest: Contest, user: User, votedInMethod: boolean): boolean {
  if (user.role === 'admin') return true;
  if (contest.results === 'after_vote') return votedInMethod || contest.phase === 'closed';
  if (contest.results === 'closed') return contest.phase === 'closed';
  return false;
}

export function isTestMode(contest: Contest): boolean {
  return contest.methods.length > 1;
}
