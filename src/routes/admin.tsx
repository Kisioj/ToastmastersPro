import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv, Contest, ContestSettings, EntryRow, User } from '../env';
import { aiProvider } from '../lib/ai';
import { createToken, linkFor } from '../lib/auth';
import { computeTallies, getContest, listContests, listEntries, PHASES, RESULTS_MODES, ROLLUP_DEFAULTS } from '../lib/contests';
import { setFlash, takeFlash } from '../lib/flash';
import { inviteMail, mailConfigured, sendMail } from '../lib/mail';
import { deleteParts, getStore } from '../lib/storage';
import { EMAIL_RE, fmtDate, normEmail, now, slugify } from '../lib/util';
import { isMethod, METHOD_IDS, METHODS, plural, type MethodId } from '../lib/voting';
import { Layout, PageHead, PhasePill, ResultsList } from '../views/layout';
import { SubmissionCard } from './member';

export const admin = new Hono<AppEnv>();

admin.use('*', async (c, next) => {
  if (c.var.user?.role !== 'admin') return c.text('Brak dostępu', 403);
  await next();
});

function memberStatus(u: User): { cls: string; text: string } {
  if (!u.active) return { cls: 'closed', text: 'Nieaktywny' };
  if (u.password_hash) return { cls: 'ok', text: 'Ma hasło' };
  if (u.last_login_at) return { cls: 'ok', text: 'Loguje się linkiem' };
  if (u.invited_at) return { cls: 'warn', text: `Zaproszony ${fmtDate(u.invited_at)}` };
  return { cls: 'draft', text: 'Bez zaproszenia' };
}

/** "Jan Kowalski <jan@x.pl>", "jan@x.pl, Jan Kowalski", "jan@x.pl" */
export function parseMemberLines(text: string): { email: string; name: string }[] {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/[^\s<>(),;:"']+@[^\s<>(),;:"']+\.[a-z]{2,}/i);
    if (!m) continue;
    const email = normEmail(m[0]);
    if (!EMAIL_RE.test(email)) continue;
    const name = line
      .replace(m[0], '')
      .replace(/[<>(),;"\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    if (!out.has(email) || name) out.set(email, name);
  }
  return [...out].map(([email, name]) => ({ email, name }));
}

async function sendInvite(c: Context<AppEnv>, u: User) {
  const token = await createToken(c.env.DB, u.id, 'set_password');
  const link = linkFor(c, 'set_password', token);
  const res = await sendMail(c.env, { to: u.email, toName: u.name, ...inviteMail(u.name.split(' ')[0] ?? '', link) });
  await c.env.DB.prepare('UPDATE users SET invited_at = ? WHERE id = ?').bind(now(), u.id).run();
  return { link, ...res };
}

admin.get('/', async (c) => {
  const db = c.env.DB;
  const { results: users } = await db.prepare('SELECT * FROM users ORDER BY active DESC, role, name, email').all<User>();
  const contests = await listContests(db, true);
  const lastErr = await db
    .prepare("SELECT to_email, error, created_at FROM mail_log WHERE status = 'error' ORDER BY id DESC LIMIT 1")
    .first<{ to_email: string; error: string; created_at: number }>();
  const store = getStore(c.env);
  const ai = aiProvider(c.env);
  const mailOn = mailConfigured(c.env);

  return c.html(
    <Layout title="Panel admina" user={c.var.user} flash={takeFlash(c)} scripts={['/js/app.js', '/js/admin.js']} nav="admin">
      <PageHead eyebrow="Panel admina" title="Członkowie i konkursy" />
      <section class="section tight">
        <div class="wrap stack" style="--gap:36px">
          <div class="grid">
            <div class="card">
              <h3>E-maile</h3>
              {mailOn ? (
                <p>
                  <span class="pill ok">Włączone</span> wysyłka z <strong>{c.env.SMTP_USER}</strong>
                </p>
              ) : (
                <p>
                  <span class="pill warn">Wyłączone</span> Brak hasła aplikacji Gmail (sekret <code>SMTP_PASS</code>). Linki z zaproszeniami pokażą się tutaj
                  do skopiowania.
                </p>
              )}
              {lastErr && (
                <p class="flash err small">
                  Ostatni błąd ({fmtDate(lastErr.created_at)}, {lastErr.to_email}): {lastErr.error}
                </p>
              )}
              {mailOn && (
                <form method="post" action="/admin/mail-test">
                  <button class="btn ghost small" type="submit">
                    Wyślij testowego maila do mnie
                  </button>
                </form>
              )}
            </div>
            <div class="card">
              <h3>Ocena AI projektów</h3>
              <p>
                {ai === 'claude' ? (
                  <>
                    <span class="pill ok">Claude</span> model <code>{c.env.CLAUDE_MODEL || 'claude-opus-5-5'}</code>
                  </>
                ) : ai === 'workers-ai' ? (
                  <>
                    <span class="pill ok">Workers AI (darmowe)</span> <code>{c.env.WORKERS_AI_MODEL}</code>
                  </>
                ) : (
                  <span class="pill warn">Wyłączona</span>
                )}
              </p>
              <p class="muted small">Limit: {c.env.AI_DAILY_LIMIT || 15} ocen dziennie na osobę (admin bez limitu).</p>
            </div>
            <div class="card">
              <h3>Pliki</h3>
              <p>
                {store ? <span class="pill ok">{store.kind === 'r2' ? 'Cloudflare R2' : 'Workers KV'}</span> : <span class="pill err">Brak magazynu</span>}
              </p>
              {store?.kind === 'kv' && <p class="muted small">KV ma 1 GB za darmo. Przy wielu dużych plikach włącz R2 (10 GB za darmo).</p>}
            </div>
          </div>

          <div>
            <div class="row" style="margin-bottom:12px">
              <h2 style="margin:0">Konkursy</h2>
              <span class="spacer"></span>
              <a class="btn" href="/admin/konkursy/nowy">
                Nowy konkurs
              </a>
            </div>
            {contests.length === 0 ? (
              <p class="empty-note">Brak konkursów.</p>
            ) : (
              <div class="table-wrapper" tabindex={0} role="region" aria-labelledby="ct-cap">
                <table class="data">
                  <caption id="ct-cap" class="visually-hidden">
                    Konkursy
                  </caption>
                  <thead>
                    <tr>
                      <th>Konkurs</th>
                      <th>Etap</th>
                      <th>Głosowanie</th>
                      <th>Akcje</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contests.map((ct) => (
                      <tr>
                        <th>
                          {ct.title}
                          <span class="sub">/konkursy/{ct.slug}</span>
                        </th>
                        <td data-label="Etap">
                          <PhasePill phase={ct.phase} />
                        </td>
                        <td data-label="Głosowanie">{ct.methods.length > 1 ? `Tryb testowy: ${ct.methods.length} sposoby` : METHODS[ct.methods[0] as MethodId].name}</td>
                        <td class="actions-cell">
                          <a class="btn small" href={`/admin/konkursy/${ct.id}`}>
                            Zarządzaj
                          </a>{' '}
                          <a class="btn ghost small" href={`/konkursy/${ct.slug}`}>
                            Otwórz
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div>
            <h2>Członkowie ({users.filter((u) => u.active).length})</h2>
            <form class="form card" method="post" action="/admin/czlonkowie" style="margin-bottom:20px">
              <label for="members">
                Dodaj osoby — jedna w linii
                <span class="hint">Np. „Anna Nowak &lt;anna@example.com&gt;”, „anna@example.com, Anna Nowak” albo sam adres.</span>
                <textarea id="members" name="members" rows={4} required spellcheck={false}></textarea>
              </label>
              <label class="check">
                <input type="checkbox" name="invite" value="1" checked={mailOn} />
                <span>Od razu wyślij zaproszenia z linkiem do ustawienia hasła {mailOn ? '' : '(maile wyłączone — linki skopiujesz z tabeli)'}</span>
              </label>
              <button class="btn" type="submit" style="justify-self:start">
                Dodaj
              </button>
            </form>
            <div class="table-wrapper" tabindex={0} role="region" aria-labelledby="mem-cap">
              <table class="data">
                <caption id="mem-cap" class="visually-hidden">
                  Członkowie
                </caption>
                <thead>
                  <tr>
                    <th>Osoba</th>
                    <th>Status</th>
                    <th>Ostatnie logowanie</th>
                    <th>Akcje</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const st = memberStatus(u);
                    return (
                      <tr id={`u-${u.id}`}>
                        <th>
                          {u.name || '—'} {u.role === 'admin' && <span class="pill">admin</span>}
                          <span class="sub">{u.email}</span>
                        </th>
                        <td data-label="Status">
                          <span class={`pill ${st.cls}`}>{st.text}</span>
                        </td>
                        <td data-label="Ostatnie logowanie">{fmtDate(u.last_login_at)}</td>
                        <td class="actions-cell">
                          <div class="row" style="gap:6px">
                            {u.active ? (
                              <button type="button" class="btn small" data-invite={u.id} data-email={u.email}>
                                {u.invited_at || u.password_hash ? 'Nowy link do hasła' : 'Wyślij zaproszenie'}
                              </button>
                            ) : null}
                            <form method="post" action={`/admin/czlonkowie/${u.id}`} class="inline-form">
                              <input type="hidden" name="action" value={u.active ? 'deactivate' : 'activate'} />
                              <button class="btn ghost small" type="submit" disabled={u.id === c.var.user!.id}>
                                {u.active ? 'Dezaktywuj' : 'Aktywuj'}
                              </button>
                            </form>
                            <form method="post" action={`/admin/czlonkowie/${u.id}`} class="inline-form">
                              <input type="hidden" name="action" value={u.role === 'admin' ? 'member' : 'admin'} />
                              <button class="btn ghost small" type="submit" disabled={u.id === c.var.user!.id}>
                                {u.role === 'admin' ? 'Odbierz admina' : 'Nadaj admina'}
                              </button>
                            </form>
                            <form method="post" action={`/admin/czlonkowie/${u.id}`} class="inline-form" data-confirm={`Usunąć ${u.email}? Jej/jego głosy też zostaną usunięte.`}>
                              <input type="hidden" name="action" value="delete" />
                              <button class="btn danger small" type="submit" disabled={u.id === c.var.user!.id}>
                                Usuń
                              </button>
                            </form>
                          </div>
                          <div data-invite-out={u.id}></div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
    </Layout>,
  );
});

admin.post('/czlonkowie', async (c) => {
  const f = await c.req.parseBody();
  const people = parseMemberLines(String(f.members ?? ''));
  if (!people.length) {
    setFlash(c, 'err', 'Nie znalazłem żadnego poprawnego adresu e-mail.');
    return c.redirect('/admin');
  }
  const db = c.env.DB;
  let added = 0;
  const fresh: User[] = [];
  for (const p of people) {
    const row = await db
      .prepare(
        `INSERT INTO users (email, name, created_at) VALUES (?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET name = CASE WHEN excluded.name != '' THEN excluded.name ELSE users.name END, active = 1
         RETURNING *, (created_at = ?) AS is_new`,
      )
      .bind(p.email, p.name, now(), now())
      .first<User & { is_new: number }>();
    if (row?.is_new) {
      added++;
      fresh.push(row);
    }
  }
  let sent = 0;
  let failed = 0;
  if (f.invite && mailConfigured(c.env)) {
    // limit podżądań na darmowym planie — wysyłamy max 15 naraz
    for (const u of fresh.slice(0, 15)) {
      const r = await sendInvite(c, u);
      r.sent ? sent++ : failed++;
    }
  }
  const parts = [`Dodano ${added} ${plural(added, 'osobę', 'osoby', 'osób')}`];
  if (people.length > added) parts.push(`${people.length - added} już było na liście`);
  if (sent) parts.push(`wysłano ${sent} ${plural(sent, 'zaproszenie', 'zaproszenia', 'zaproszeń')}`);
  if (failed) parts.push(`${failed} maili nie wyszło — sprawdź ustawienia SMTP`);
  if (fresh.length > 15 && f.invite) parts.push('resztę zaproszeń wyślij przyciskami w tabeli');
  setFlash(c, failed ? 'err' : 'ok', `${parts.join(', ')}.`);
  return c.redirect('/admin');
});

admin.post('/czlonkowie/:id/zaproszenie', async (c) => {
  const u = await c.env.DB.prepare('SELECT * FROM users WHERE id = ? AND active = 1').bind(Number(c.req.param('id'))).first<User>();
  if (!u) return c.json({ ok: false, error: 'Nie ma takiej osoby.' }, 404);
  const r = await sendInvite(c, u);
  return c.json({ ok: true, link: r.link, sent: r.sent, mode: r.mode, error: r.error ?? null });
});

admin.post('/czlonkowie/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const f = await c.req.parseBody();
  const action = String(f.action ?? '');
  const db = c.env.DB;
  if (id === c.var.user!.id) {
    setFlash(c, 'err', 'Nie możesz zmienić własnego konta w ten sposób.');
    return c.redirect('/admin');
  }
  if (action === 'delete') await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  else if (action === 'deactivate') await db.batch([db.prepare('UPDATE users SET active = 0 WHERE id = ?').bind(id), db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id)]);
  else if (action === 'activate') await db.prepare('UPDATE users SET active = 1 WHERE id = ?').bind(id).run();
  else if (action === 'admin' || action === 'member') await db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(action, id).run();
  setFlash(c, 'ok', 'Zapisano.');
  return c.redirect('/admin');
});

admin.post('/mail-test', async (c) => {
  const u = c.var.user!;
  const r = await sendMail(c.env, {
    to: u.email,
    subject: 'Test wysyłki — strefa członka',
    text: 'Jeśli to czytasz, wysyłka maili działa.',
    html: '<p>Jeśli to czytasz, wysyłka maili działa. ✅</p>',
  });
  setFlash(c, r.sent ? 'ok' : 'err', r.sent ? `Wysłano test na ${u.email}.` : `Nie udało się: ${r.error ?? 'SMTP wyłączone'}`);
  return c.redirect('/admin');
});

// ——— konkursy ———

const ContestForm = ({ contest, action }: { contest: Partial<Contest> & { methods: string[]; settings: ContestSettings }; action: string }) => {
  const s = { ...ROLLUP_DEFAULTS, points_budget: 10, ...contest.settings };
  return (
    <form class="form card" method="post" action={action}>
      <label for="title">
        Tytuł
        <input type="text" id="title" name="title" value={contest.title ?? ''} required maxlength={120} />
      </label>
      <label for="slug">
        Adres <span class="hint">/konkursy/… — zostaw puste, utworzymy z tytułu</span>
        <input type="text" id="slug" name="slug" value={contest.slug ?? ''} pattern="[a-z0-9-]*" maxlength={60} spellcheck={false} />
      </label>
      <label for="description">
        Opis dla członków
        <textarea id="description" name="description" rows={4} maxlength={3000}>
          {contest.description ?? ''}
        </textarea>
      </label>
      <fieldset>
        <legend>Rodzaj</legend>
        <label class="check">
          <input type="radio" name="kind" value="text" checked={(contest.kind ?? 'text') === 'text'} />
          <span>Teksty (np. hasła) — propozycje dodaje admin</span>
        </label>
        <label class="check">
          <input type="radio" name="kind" value="rollup" checked={contest.kind === 'rollup'} />
          <span>Projekty graficzne (rollup) — członkowie wysyłają pliki, system je sprawdza</span>
        </label>
      </fieldset>
      <label for="phase">
        Etap
        <select id="phase" name="phase">
          {Object.entries(PHASES).map(([k, v]) => (
            <option value={k} selected={(contest.phase ?? 'draft') === k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>Sposoby głosowania</legend>
        <p class="hint" style="margin:0">Zaznacz jeden — to oficjalne głosowanie. Zaznacz kilka — członkowie przetestują każdy i powiedzą, który wolą (tryb testowy).</p>
        {METHOD_IDS.map((m) => (
          <label class="check">
            <input type="checkbox" name="methods" value={m} checked={contest.methods.includes(m)} />
            <span>
              <strong>{METHODS[m].name}</strong> <span class="hint">— {METHODS[m].tagline}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label for="results">
        Kto widzi wyniki
        <select id="results" name="results">
          {Object.entries(RESULTS_MODES).map(([k, v]) => (
            <option value={k} selected={(contest.results ?? 'after_vote') === k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px">
        <label for="points_budget">
          Punkty do rozdania
          <input type="number" id="points_budget" name="points_budget" min={3} max={100} value={s.points_budget} />
        </label>
        <label for="max_entries">
          Projektów na osobę
          <input type="number" id="max_entries" name="max_entries" min={1} max={20} value={s.max_entries} />
        </label>
        <label for="max_mb">
          Maks. MB na plik
          <input type="number" id="max_mb" name="max_mb" min={1} max={95} value={s.max_mb} />
        </label>
        <label for="position">
          Kolejność na liście
          <input type="number" id="position" name="position" value={contest.position ?? 0} />
        </label>
      </div>
      <button class="btn" type="submit" style="justify-self:start">
        Zapisz
      </button>
    </form>
  );
};

function readContestForm(f: Record<string, string | File | (string | File)[]>) {
  const all = (k: string) => {
    const v = f[k] ?? f[`${k}[]`];
    return (Array.isArray(v) ? v : v === undefined ? [] : [v]).map(String);
  };
  const one = (k: string) => String(all(k)[0] ?? '');
  const int = (k: string, d: number, min: number, max: number) => {
    const n = Math.round(Number(one(k)));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
  };
  const methods = all('methods').filter(isMethod);
  return {
    title: one('title').trim().slice(0, 120),
    slug: slugify(one('slug') || one('title')),
    description: one('description').trim().slice(0, 3000),
    kind: one('kind') === 'rollup' ? 'rollup' : 'text',
    phase: (Object.keys(PHASES) as string[]).includes(one('phase')) ? one('phase') : 'draft',
    results: (Object.keys(RESULTS_MODES) as string[]).includes(one('results')) ? one('results') : 'after_vote',
    methods: JSON.stringify(methods.length ? methods : ['top3']),
    settings: JSON.stringify({
      points_budget: int('points_budget', 10, 3, 100),
      max_entries: int('max_entries', 3, 1, 20),
      max_mb: int('max_mb', 95, 1, 95),
    }),
    position: int('position', 0, -1000, 1000),
  };
}

admin.get('/konkursy/nowy', (c) =>
  c.html(
    <Layout title="Nowy konkurs" user={c.var.user} flash={takeFlash(c)} nav="admin">
      <PageHead eyebrow="Panel admina" title="Nowy konkurs" />
      <section class="section tight">
        <div class="wrap mid">
          <ContestForm contest={{ methods: ['top3'], settings: {}, results: 'after_vote' }} action="/admin/konkursy" />
        </div>
      </section>
    </Layout>,
  ),
);

admin.post('/konkursy', async (c) => {
  const v = readContestForm(await c.req.parseBody({ all: true }));
  if (!v.title) {
    setFlash(c, 'err', 'Podaj tytuł.');
    return c.redirect('/admin/konkursy/nowy');
  }
  try {
    const row = await c.env.DB.prepare(
      `INSERT INTO contests (slug, title, description, kind, phase, methods, results, settings, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
      .bind(v.slug, v.title, v.description, v.kind, v.phase, v.methods, v.results, v.settings, v.position, now())
      .first<{ id: number }>();
    setFlash(c, 'ok', 'Konkurs utworzony. Dodaj propozycje poniżej.');
    return c.redirect(`/admin/konkursy/${row!.id}`);
  } catch {
    setFlash(c, 'err', `Adres /konkursy/${v.slug} jest już zajęty — wpisz inny.`);
    return c.redirect('/admin/konkursy/nowy');
  }
});

admin.get('/konkursy/:id', async (c) => {
  const db = c.env.DB;
  const contest = await getContest(db, Number(c.req.param('id')));
  if (!contest) return c.notFound();
  const entries = await listEntries(db, contest.id, true);
  const visible = entries.filter((e) => !e.hidden);
  const { results: methodsWithVotes } = await db
    .prepare('SELECT method, COUNT(*) AS n FROM ballots WHERE contest_id = ? GROUP BY method')
    .bind(contest.id)
    .all<{ method: string; n: number }>();
  const shownMethods = [...new Set([...contest.methods, ...methodsWithVotes.map((m) => m.method).filter(isMethod)])] as MethodId[];
  const tallies = await computeTallies(db, contest, shownMethods, visible);
  const { results: feedback } = await db
    .prepare(
      `SELECT f.preferred, f.comment, f.updated_at, u.name, u.email FROM method_feedback f JOIN users u ON u.id = f.user_id
       WHERE f.contest_id = ? ORDER BY f.updated_at DESC`,
    )
    .bind(contest.id)
    .all<{ preferred: string; comment: string; updated_at: number; name: string; email: string }>();
  const { results: voterCount } = await db
    .prepare('SELECT COUNT(DISTINCT user_id) AS n FROM ballots WHERE contest_id = ?')
    .bind(contest.id)
    .all<{ n: number }>();
  const authors = new Map<number, string>();
  if (contest.kind === 'rollup') {
    const { results } = await db.prepare('SELECT id, name, email FROM users').all<{ id: number; name: string; email: string }>();
    for (const u of results) authors.set(u.id, u.name || u.email);
  }
  const { results: pending } =
    contest.kind === 'rollup'
      ? await db.prepare('SELECT * FROM entries WHERE contest_id = ? AND upload_complete = 0').bind(contest.id).all<EntryRow>()
      : { results: [] as EntryRow[] };

  return c.html(
    <Layout title={contest.title} user={c.var.user} flash={takeFlash(c)} scripts={['/js/app.js']} nav="admin">
      <PageHead eyebrow="Panel admina · konkurs" title={contest.title}>
        <p class="row" style="margin:12px 0 0">
          <PhasePill phase={contest.phase} />
          <a class="btn ghost small" href={`/konkursy/${contest.slug}`}>
            Otwórz stronę konkursu
          </a>
          <span class="muted small">
            Głosowało: {voterCount[0]?.n ?? 0} {plural(voterCount[0]?.n ?? 0, 'osoba', 'osoby', 'osób')}
          </span>
        </p>
      </PageHead>
      <section class="section tight">
        <div class="wrap stack" style="--gap:40px">
          <div>
            <h2>Wyniki</h2>
            {shownMethods.length > 1 && (
              <div class="table-wrapper" tabindex={0} role="region" aria-labelledby="cmp-cap" style="margin-bottom:24px">
                <table class="data">
                  <caption id="cmp-cap">Porównanie sposobów głosowania</caption>
                  <thead>
                    <tr>
                      <th>Sposób</th>
                      <th>Głosujących</th>
                      <th>Prowadzi</th>
                      <th>Woli ten sposób</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownMethods.map((m) => {
                      const t = tallies[m]!;
                      const lead = t.voters ? t.rows.filter((r) => r.rank === 1).map((r) => r.title).join(' / ') : '—';
                      return (
                        <tr>
                          <th>
                            {METHODS[m].name}
                            {!contest.methods.includes(m) && <span class="sub">(wyłączony, są stare głosy)</span>}
                          </th>
                          <td data-label="Głosujących">{t.voters}</td>
                          <td data-label="Prowadzi">{lead}</td>
                          <td data-label="Woli ten sposób">{feedback.filter((f) => f.preferred === m).length}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div class="grid">
              {shownMethods.map((m) => (
                <div class="card">
                  <ResultsList tally={tallies[m]!} showMethod />
                </div>
              ))}
            </div>
            {feedback.length > 0 && (
              <div class="card" style="margin-top:20px">
                <h3>Opinie o sposobach głosowania ({feedback.length})</h3>
                <ul class="stack" style="--gap:10px;padding-left:1.2em;margin:0">
                  {feedback.map((f) => (
                    <li>
                      <strong>{f.name || f.email}</strong> woli: {isMethod(f.preferred) ? METHODS[f.preferred].name : f.preferred}
                      {f.comment && <span class="muted"> — „{f.comment}”</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div>
            <h2>{contest.kind === 'rollup' ? 'Zgłoszone projekty' : 'Propozycje'}</h2>
            {contest.kind === 'text' && (
              <form class="form card" method="post" action={`/admin/konkursy/${contest.id}/propozycje`} style="margin-bottom:16px">
                <label for="new-entries">
                  Dodaj propozycje — jedna w linii
                  <span class="hint">Numeracja na początku linii („1.”, „2)”) zostanie usunięta.</span>
                  <textarea id="new-entries" name="entries" rows={4} required></textarea>
                </label>
                <button class="btn" type="submit" style="justify-self:start">
                  Dodaj
                </button>
              </form>
            )}
            {contest.kind === 'rollup' ? (
              <div class="stack" style="--gap:16px">
                {entries.length === 0 && <p class="empty-note">Nikt jeszcze nie wysłał projektu.</p>}
                {entries.map((e) => (
                  <div>
                    <SubmissionCard entry={e} aiOn={aiProvider(c.env) !== null} canDelete={true} author={e.author_id ? authors.get(e.author_id) : undefined} />
                    <form method="post" action={`/admin/propozycje/${e.id}`} class="row" style="margin-top:8px">
                      <input type="hidden" name="action" value={e.hidden ? 'show' : 'hide'} />
                      <button class="btn ghost small" type="submit">
                        {e.hidden ? 'Pokaż w głosowaniu' : 'Ukryj w głosowaniu'}
                      </button>
                    </form>
                  </div>
                ))}
                {pending.length > 0 && <p class="muted small">Nieukończone wysyłki: {pending.length} (usuwane automatycznie po godzinie).</p>}
              </div>
            ) : (
              <div class="table-wrapper" tabindex={0} role="region" aria-labelledby="en-cap">
                <table class="data">
                  <caption id="en-cap" class="visually-hidden">
                    Propozycje
                  </caption>
                  <thead>
                    <tr>
                      <th>Nr</th>
                      <th>Treść</th>
                      <th>Akcje</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e, i) => (
                      <tr>
                        <td data-label="Nr">
                          {i + 1}
                          {e.hidden ? <span class="sub">ukryta</span> : null}
                        </td>
                        <td data-label="Treść">
                          <form method="post" action={`/admin/propozycje/${e.id}`} class="row" style="gap:6px">
                            <input type="hidden" name="action" value="rename" />
                            <label class="visually-hidden" for={`en-${e.id}`}>
                              Treść propozycji {i + 1}
                            </label>
                            <input
                              type="text"
                              id={`en-${e.id}`}
                              name="title"
                              value={e.title}
                              maxlength={200}
                              style="flex:1;min-width:12rem;min-block-size:40px;padding:6px 10px;border:1.5px solid #cbd6dd;border-radius:8px;font:inherit"
                            />
                            <button class="btn ghost small" type="submit">
                              Zapisz
                            </button>
                          </form>
                        </td>
                        <td class="actions-cell">
                          <form method="post" action={`/admin/propozycje/${e.id}`} class="inline-form">
                            <input type="hidden" name="action" value={e.hidden ? 'show' : 'hide'} />
                            <button class="btn ghost small" type="submit">
                              {e.hidden ? 'Pokaż' : 'Ukryj'}
                            </button>
                          </form>{' '}
                          <form method="post" action={`/admin/propozycje/${e.id}`} class="inline-form" data-confirm="Usunąć tę propozycję?">
                            <input type="hidden" name="action" value="delete" />
                            <button class="btn danger small" type="submit">
                              Usuń
                            </button>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div>
            <h2>Ustawienia</h2>
            <ContestForm contest={contest} action={`/admin/konkursy/${contest.id}`} />
          </div>

          <div class="card" style="border-color:#e6b7bd">
            <h2>Strefa niebezpieczna</h2>
            <div class="row">
              <form method="post" action={`/admin/konkursy/${contest.id}/reset`} class="row" data-confirm="Na pewno usunąć głosy? Tego nie da się cofnąć." style="gap:6px">
                <label class="visually-hidden" for="reset-method">
                  Które głosy usunąć
                </label>
                <select id="reset-method" name="method" style="min-block-size:40px;border-radius:8px;font:inherit;padding:4px 8px">
                  <option value="">wszystkie głosy</option>
                  {shownMethods.map((m) => (
                    <option value={m}>głosy: {METHODS[m].name}</option>
                  ))}
                </select>
                <button class="btn danger small" type="submit">
                  Wyzeruj
                </button>
              </form>
              <form method="post" action={`/admin/konkursy/${contest.id}/usun`} data-confirm="Usunąć cały konkurs razem z propozycjami, plikami i głosami?">
                <button class="btn danger small" type="submit">
                  Usuń konkurs
                </button>
              </form>
            </div>
          </div>
        </div>
      </section>
      <dialog class="lightbox" id="lightbox" closedby="any" aria-labelledby="lb-title">
        <div class="lb-head">
          <h2 id="lb-title">Podgląd</h2>
          <button type="button" class="btn ghost small" data-close-dialog>
            Zamknij
          </button>
        </div>
        <div class="lb-body">
          <img id="lb-img" alt="" />
        </div>
      </dialog>
    </Layout>,
  );
});

admin.post('/konkursy/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const v = readContestForm(await c.req.parseBody({ all: true }));
  if (!v.title) {
    setFlash(c, 'err', 'Podaj tytuł.');
    return c.redirect(`/admin/konkursy/${id}`);
  }
  try {
    await c.env.DB.prepare(
      'UPDATE contests SET slug = ?, title = ?, description = ?, kind = ?, phase = ?, methods = ?, results = ?, settings = ?, position = ? WHERE id = ?',
    )
      .bind(v.slug, v.title, v.description, v.kind, v.phase, v.methods, v.results, v.settings, v.position, id)
      .run();
    setFlash(c, 'ok', 'Zapisano ustawienia.');
  } catch {
    setFlash(c, 'err', `Adres /konkursy/${v.slug} jest już zajęty.`);
  }
  return c.redirect(`/admin/konkursy/${id}`);
});

admin.post('/konkursy/:id/propozycje', async (c) => {
  const id = Number(c.req.param('id'));
  const f = await c.req.parseBody();
  const lines = String(f.entries ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\d+\s*[.)]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 200);
  const db = c.env.DB;
  const max = await db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM entries WHERE contest_id = ?').bind(id).first<{ p: number }>();
  let pos = max?.p ?? 0;
  if (lines.length) {
    await db.batch(
      lines.map((t) => db.prepare('INSERT INTO entries (contest_id, title, position, created_at) VALUES (?, ?, ?, ?)').bind(id, t.slice(0, 200), ++pos, now())),
    );
  }
  setFlash(c, 'ok', `Dodano ${lines.length} ${plural(lines.length, 'propozycję', 'propozycje', 'propozycji')}.`);
  return c.redirect(`/admin/konkursy/${id}`);
});

admin.post('/propozycje/:id', async (c) => {
  const db = c.env.DB;
  const e = await db.prepare('SELECT * FROM entries WHERE id = ?').bind(Number(c.req.param('id'))).first<EntryRow>();
  if (!e) return c.notFound();
  const f = await c.req.parseBody();
  const action = String(f.action ?? '');
  if (action === 'rename') {
    const title = String(f.title ?? '').trim().slice(0, 200);
    if (title) await db.prepare('UPDATE entries SET title = ? WHERE id = ?').bind(title, e.id).run();
  } else if (action === 'hide' || action === 'show') {
    await db.prepare('UPDATE entries SET hidden = ? WHERE id = ?').bind(action === 'hide' ? 1 : 0, e.id).run();
  } else if (action === 'delete') {
    const store = getStore(c.env);
    if (store && e.file_key) await deleteParts(store, e.file_key, e.file_parts ?? 0);
    await db.prepare('DELETE FROM entries WHERE id = ?').bind(e.id).run();
  }
  setFlash(c, 'ok', 'Zapisano.');
  return c.redirect(`/admin/konkursy/${e.contest_id}`);
});

admin.post('/konkursy/:id/reset', async (c) => {
  const id = Number(c.req.param('id'));
  const f = await c.req.parseBody();
  const method = String(f.method ?? '');
  const db = c.env.DB;
  if (isMethod(method)) {
    await db.batch([
      db.prepare('DELETE FROM ballots WHERE contest_id = ? AND method = ?').bind(id, method),
    ]);
    setFlash(c, 'ok', `Usunięto głosy: ${METHODS[method].name}.`);
  } else {
    await db.batch([db.prepare('DELETE FROM ballots WHERE contest_id = ?').bind(id), db.prepare('DELETE FROM method_feedback WHERE contest_id = ?').bind(id)]);
    setFlash(c, 'ok', 'Usunięto wszystkie głosy i opinie.');
  }
  return c.redirect(`/admin/konkursy/${id}`);
});

admin.post('/konkursy/:id/usun', async (c) => {
  const id = Number(c.req.param('id'));
  const db = c.env.DB;
  const store = getStore(c.env);
  if (store) {
    const { results } = await db.prepare('SELECT file_key, file_parts FROM entries WHERE contest_id = ? AND file_key IS NOT NULL').bind(id).all<EntryRow>();
    for (const e of results) await deleteParts(store, e.file_key!, e.file_parts ?? 0);
  }
  await db.prepare('DELETE FROM contests WHERE id = ?').bind(id).run();
  setFlash(c, 'ok', 'Konkurs usunięty.');
  return c.redirect('/admin');
});

