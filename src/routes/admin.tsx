import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv, Contest, ContestSettings, EntryRow, User } from '../env';
import { aiClubLimit, aiProvider, aiQuotaExhausted, aiUsageToday } from '../lib/ai';
import { createToken, linkFor, refererPath, setPreview } from '../lib/auth';
import { canManage, computeTallies, getContest, listContests, listEntries, PHASES, RESULTS_MODES, ROLLUP_DEFAULTS, entryReviews } from '../lib/contests';
import { setFlash, takeFlash } from '../lib/flash';
import { announcementMail, inviteMail, mailAllowed, mailConfigured, mailDailyLimit, mailsSentLast24h, sendAnnouncement, sendMail } from '../lib/mail';
import { parseMemberLines } from '../lib/members';
import { deleteParts, getStore } from '../lib/storage';
import { fmtDate, fmtDay, now, slugify } from '../lib/util';
import { isMethod, METHOD_IDS, METHODS, plural, type MethodId } from '../lib/voting';
import { Layout, PageHead, PhasePill, ResultsList } from '../views/layout';
import { SubmissionCard } from './member';

export const admin = new Hono<AppEnv>();

/** ok. 5 podżądań na zaproszenie (sprawdzenie limitów, token, SMTP, log, znacznik) — 8 × 5 + reszta < 50 */
const INVITE_BATCH = 8;

/** Tylko admin systemu: członkowie, maile, tworzenie i usuwanie konkursów, przydzielanie opiekunów */
const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.var.user?.preview) return previewDenied(c);
  if (c.var.user?.role !== 'admin') return c.text('Brak dostępu. To tylko dla admina systemu.', 403);
  await next();
};

/** Admin systemu albo opiekun tego konkursu */
async function guardContest(c: Context<AppEnv>, contestId: number): Promise<Response | null> {
  if (c.var.user?.preview) return previewDenied(c);
  if (!Number.isInteger(contestId) || !(await canManage(c.env.DB, c.var.user!, contestId))) return c.text('Brak dostępu do tego konkursu.', 403);
  return null;
}

/** W podglądzie członka strony admina są zamknięte jak dla członka, ale z paskiem „Wróć do widoku admina” */
function previewDenied(c: Context<AppEnv>) {
  if (c.req.method !== 'GET') return c.text('Jesteś w podglądzie jako członek. Wróć do widoku admina (przycisk na górze strony) i spróbuj ponownie.', 403);
  return c.html(
    <Layout title="Brak dostępu" user={c.var.user}>
      <section class="section">
        <div class="wrap narrow stack">
          <h1>To strona tylko dla admina</h1>
          <p>Zwykły członek klubu nie ma tu wstępu, więc w podglądzie też jej nie zobaczysz. Wróć do widoku admina przyciskiem na żółtym pasku u góry.</p>
        </div>
      </section>
    </Layout>,
    403,
  );
}

/** Podgląd jako członek: ta sama strona (poza panelem admina) bez uprawnień admina i opiekuna */
admin.post('/podglad', requireAdmin, (c) => {
  setPreview(c, true);
  const back = refererPath(c, '/');
  return c.redirect(back.startsWith('/admin') ? '/' : back);
});

/** Domyślna treść powiadomienia zależnie od rodzaju i etapu konkursu (bez długich myślników) */
function announcementTemplate(ct: Contest): { subject: string; message: string } | null {
  if (ct.phase === 'draft') return null;
  const until = ct.settings.period_end ? ` Zgłoszenia przyjmujemy do ${fmtDay(ct.settings.period_end)}.` : '';
  if (ct.kind === 'leaderboard')
    return { subject: `${ct.title}: sprawdź ranking`, message: `Trwa konkurs „${ct.title}”. Zasady i aktualny ranking znajdziesz w strefie członka.` };
  if (ct.phase === 'submissions')
    return ct.kind === 'rollup'
      ? {
          subject: `${ct.title}: można wysyłać zgłoszenia`,
          message: `Ruszyły zgłoszenia w konkursie „${ct.title}”. Zaloguj się do strefy członka i wyślij swój projekt. System od razu sprawdzi, czy plik nadaje się do druku i czy pasuje do zasad marki Toastmasters.${until}`,
        }
      : { subject: `${ct.title}: zbieramy propozycje`, message: `Zbieramy propozycje w konkursie „${ct.title}”. Szczegóły znajdziesz w strefie członka.` };
  if (ct.phase === 'voting')
    return {
      subject: `${ct.title}: ruszyło głosowanie`,
      message: `Możesz już głosować w konkursie „${ct.title}”. Głos możesz zmieniać do końca głosowania.${
        ct.methods.length > 1 ? '\n\nTym razem możesz wypróbować kilka sposobów głosowania i powiedzieć nam, który jest najlepszy.' : ''
      }`,
    };
  return { subject: `${ct.title}: wyniki`, message: `Konkurs „${ct.title}” jest zakończony. Wyniki znajdziesz w strefie członka.` };
}

function memberStatus(u: User): { cls: string; text: string } {
  if (!u.active) return { cls: 'closed', text: 'Nieaktywny' };
  if (u.password_hash) return { cls: 'ok', text: 'Ma hasło' };
  if (u.last_login_at) return { cls: 'ok', text: 'Loguje się linkiem' };
  if (u.invited_at) return { cls: 'warn', text: `Zaproszony ${fmtDate(u.invited_at)}` };
  return { cls: 'draft', text: 'Bez zaproszenia' };
}

async function sendInvite(c: Context<AppEnv>, u: User) {
  // limit sprawdzamy przed utworzeniem tokenu — nowy link unieważnia poprzedni, wysłany mailem
  const allowed = await mailAllowed(c.env, u.email);
  if (!allowed.ok) return { link: null, sent: false, mode: 'blocked' as const, error: allowed.reason };
  const token = await createToken(c.env.DB, u.id, 'set_password');
  const link = linkFor(c, 'set_password', token);
  const res = await sendMail(c.env, { to: u.email, toName: u.name, ...inviteMail(u.name.split(' ')[0] ?? '', link) }, { alreadyChecked: true });
  await c.env.DB.prepare('UPDATE users SET invited_at = ? WHERE id = ?').bind(now(), u.id).run();
  return { link, ...res };
}

/** Link z zaproszeniem bez maila: admin przesyła go sam (SMS, komunikator). Osoba liczy się jako zaproszona. */
async function inviteLink(c: Context<AppEnv>, u: User): Promise<string> {
  const token = await createToken(c.env.DB, u.id, 'set_password');
  await c.env.DB.prepare('UPDATE users SET invited_at = ? WHERE id = ?').bind(now(), u.id).run();
  return linkFor(c, 'set_password', token);
}

/** Teksty pytań przed utworzeniem linku: nowy link unieważnia poprzedni */
function inviteAsk(u: User, byMail: boolean, again: boolean): string {
  const who = u.name ? `${u.name} (${u.email})` : u.email;
  const old = ' Jeśli ta osoba dostała już wcześniej link, przestanie on działać.';
  if (byMail) return again ? `Wysłać mailem nowy link do ustawienia hasła dla: ${who}?${old}` : `Wysłać maila z zaproszeniem do: ${who}?`;
  return again ? `Utworzyć nowy link do ustawienia hasła dla: ${who}? Mail nie zostanie wysłany.${old}` : '';
}

admin.get('/', requireAdmin, async (c) => {
  const db = c.env.DB;
  const { results: users } = await db.prepare('SELECT * FROM users ORDER BY active DESC, role, name, email').all<User>();
  const contests = await listContests(db, true);
  const lastErr = await db
    .prepare("SELECT to_email, error, created_at FROM mail_log WHERE status = 'error' ORDER BY id DESC LIMIT 1")
    .first<{ to_email: string; error: string; created_at: number }>();
  const store = getStore(c.env);
  const ai = aiProvider(c.env);
  const quotaGone = ai === 'workers-ai' && (await aiQuotaExhausted(c.env));
  const aiToday = ai ? await aiUsageToday(c.env) : 0;
  const mailOn = mailConfigured(c.env);
  const sent24 = await mailsSentLast24h(c.env);
  const pending = users.filter((u) => u.active && !u.invited_at && !u.password_hash);
  const batch = pending.slice(0, INVITE_BATCH);
  const bulkAsk =
    `Wysłać teraz maile z zaproszeniem do ${batch.length} ${plural(batch.length, 'osoby', 'osób', 'osób')}?\n\n` +
    batch.map((u) => `• ${u.name || u.email}`).join('\n') +
    (pending.length > batch.length ? `\n\nPozostałe ${pending.length - batch.length} wyślesz kolejnym kliknięciem.` : '');

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
              <p class="muted small">
                Wysłane w ostatnich 24 h: <strong>{sent24}</strong> z limitu {mailDailyLimit(c.env)} (Gmail pozwala na ok. 500/dobę na całe konto). Maile idą
                tylko do aktywnych osób z listy, maks. 1 na 5 minut na adres.
              </p>
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
              {quotaGone && (
                <p class="flash err small">Dzisiejszy darmowy limit Workers AI jest wyczerpany. Oceny wrócą o 1:00 w nocy (latem o 2:00).</p>
              )}
              <p class="muted small">
                Dziś: {aiToday} z {aiClubLimit(c.env)} ocen (limit całego klubu). Pierwsze ok. 25 ocen dziennie mieści się w darmowej puli Cloudflare, każda kolejna kosztuje ok. 1,3 grosza. Na osobę: {c.env.AI_DAILY_LIMIT || 8} ocen dziennie i {c.env.AI_COOLDOWN_MINUTES || 5} min przerwy między ocenami (admin i opiekun konkursu bez limitu osoby).
              </p>
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
                          <PhasePill phase={ct.phase} kind={ct.kind} />
                        </td>
                        <td data-label="Głosowanie">{ct.kind === 'leaderboard' ? 'Ranking gości' : ct.methods.length > 1 ? `Tryb testowy: ${ct.methods.length} sposoby` : METHODS[ct.methods[0] as MethodId].name}</td>
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
            <div class="row" style="margin-bottom:12px">
              <h2 style="margin:0">Członkowie ({users.filter((u) => u.active).length})</h2>
              <span class="spacer"></span>
              {mailOn && pending.length > 0 && (
                <form method="post" action="/admin/czlonkowie/zaproszenia" data-confirm={bulkAsk}>
                  <input type="hidden" name="ids" value={batch.map((u) => u.id).join(',')} />
                  <button class="btn" type="submit">
                    Wyślij zaproszenia niezaproszonym ({pending.length})
                  </button>
                </form>
              )}
            </div>
            <form class="form card" method="post" action="/admin/czlonkowie/podglad" style="margin-bottom:20px">
              <label for="members">
                Dodaj osoby albo wklej całą listę członków
                <span class="hint">
                  Jedna osoba w linii: „Anna Nowak &lt;anna@example.com&gt;”, „anna@example.com, Anna Nowak” albo sam adres. Możesz też wkleić wiersze
                  skopiowane z Excela / Arkuszy Google lub wczytać plik CSV, a wyłapiemy adresy i imiona. Przed zapisem pokażemy podgląd.
                </span>
                <textarea id="members" name="members" rows={5} required spellcheck={false}></textarea>
              </label>
              <label for="members-file" class="hint" style="font-weight:600">
                albo wczytaj plik CSV / TXT
                <input type="file" id="members-file" accept=".csv,.tsv,.txt,text/csv,text/plain" data-fill="members" />
              </label>
              <button class="btn" type="submit" style="justify-self:start">
                Pokaż podgląd
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
                          {u.name || '-'} {u.role === 'admin' && <span class="pill">admin</span>}
                          <span class="sub">{u.email}</span>
                        </th>
                        <td data-label="Status">
                          <span class={`pill ${st.cls}`}>{st.text}</span>
                        </td>
                        <td data-label="Ostatnie logowanie">{fmtDate(u.last_login_at)}</td>
                        <td class="actions-cell">
                          <div class="row" style="gap:6px">
                            {u.active ? (
                              <>
                                <button
                                  type="button"
                                  class="btn ghost small"
                                  data-invite-link={u.id}
                                  data-email={u.email}
                                  data-ask={inviteAsk(u, false, Boolean(u.invited_at || u.password_hash))}
                                  data-ask-again={inviteAsk(u, false, true)}
                                  data-label-again="Nowy link do skopiowania"
                                >
                                  {u.invited_at || u.password_hash ? 'Nowy link do skopiowania' : 'Link do skopiowania'}
                                </button>
                                {mailOn && (
                                  <button
                                    type="button"
                                    class="btn small"
                                    data-invite={u.id}
                                    data-email={u.email}
                                    data-ask={inviteAsk(u, true, Boolean(u.invited_at || u.password_hash))}
                                    data-ask-again={inviteAsk(u, true, true)}
                                    data-label-again="Nowy link mailem"
                                  >
                                    {u.invited_at || u.password_hash ? 'Nowy link mailem' : 'Wyślij zaproszenie'}
                                  </button>
                                )}
                              </>
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

/** Podgląd importu: kto zostanie dodany, kto już jest, kogo nie ma na liście */
admin.post('/czlonkowie/podglad', requireAdmin, async (c) => {
  const f = await c.req.parseBody();
  const people = parseMemberLines(String(f.members ?? ''));
  if (!people.length) {
    setFlash(c, 'err', 'Nie znalazłem w tekście żadnego poprawnego adresu e-mail.');
    return c.redirect('/admin');
  }
  const { results: users } = await c.env.DB.prepare('SELECT * FROM users').all<User>();
  const byEmail = new Map(users.map((u) => [u.email, u]));
  const listed = new Set(people.map((p) => p.email));
  const rows = people.map((p) => {
    const u = byEmail.get(p.email);
    const status = !u ? 'Nowa osoba' : !u.active ? 'Zostanie aktywowana' : p.name && p.name !== u.name ? `Już jest (imię: ${u.name || '-'} → ${p.name})` : 'Już jest';
    return { ...p, status, cls: !u ? 'ok' : !u.active ? 'warn' : '' };
  });
  const missing = users.filter((u) => u.active && u.role !== 'admin' && !listed.has(u.email));
  const newCount = rows.filter((r) => r.cls === 'ok').length;
  const mailOn = mailConfigured(c.env);
  const normalized = people.map((p) => (p.name ? `${p.name} <${p.email}>` : p.email)).join('\n');

  return c.html(
    <Layout title="Podgląd importu" user={c.var.user} nav="admin" scripts={['/js/app.js']}>
      <PageHead eyebrow="Panel admina · członkowie" title="Podgląd importu" lead={`Znaleziono ${people.length} ${plural(people.length, 'adres', 'adresy', 'adresów')}, w tym ${newCount} ${plural(newCount, 'nową osobę', 'nowe osoby', 'nowych osób')}. Sprawdź imiona: popraw je później w tabeli albo wklej listę jeszcze raz.`} />
      <section class="section tight">
        <div class="wrap stack" style="--gap:24px">
          <div class="table-wrapper" tabindex={0} role="region" aria-labelledby="imp-cap">
            <table class="data">
              <caption id="imp-cap">Osoby z wklejonej listy</caption>
              <thead>
                <tr>
                  <th>Imię i nazwisko</th>
                  <th>E-mail</th>
                  <th>Co się stanie</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr>
                    <th>{r.name || <span class="muted">(brak imienia)</span>}</th>
                    <td data-label="E-mail">{r.email}</td>
                    <td data-label="Co się stanie">{r.cls ? <span class={`pill ${r.cls}`}>{r.status}</span> : <span class="muted">{r.status}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <form class="form card" method="post" action="/admin/czlonkowie">
            <textarea name="members" hidden readonly>
              {normalized}
            </textarea>
            <label class="check">
              <input type="checkbox" name="invite" value="1" checked={mailOn} disabled={!mailOn} />
              <span>
                Wyślij nowym osobom zaproszenie z linkiem do ustawienia hasła
                {mailOn ? ' (maks. 6 od razu, resztę wyślesz przyciskiem nad tabelą)' : ' (maile są wyłączone, linki skopiujesz z tabeli)'}
              </span>
            </label>
            {missing.length > 0 && (
              <label class="check">
                <input type="checkbox" name="sync" value="1" />
                <span>
                  <strong>Tylko te osoby mają mieć dostęp</strong>: dezaktywuj {missing.length} {plural(missing.length, 'osobę', 'osoby', 'osób')} spoza tej listy:{' '}
                  {missing.map((u) => u.name || u.email).join(', ')}. Admini nie są ruszani, a dezaktywowane konta można przywrócić.
                </span>
              </label>
            )}
            <div class="row">
              <button class="btn" type="submit">
                Zapisz {people.length} {plural(people.length, 'osobę', 'osoby', 'osób')}
              </button>
              <a class="btn ghost" href="/admin">
                Anuluj
              </a>
            </div>
          </form>
        </div>
      </section>
    </Layout>,
  );
});

admin.post('/czlonkowie', requireAdmin, async (c) => {
  const f = await c.req.parseBody();
  const people = parseMemberLines(String(f.members ?? ''));
  if (!people.length) {
    setFlash(c, 'err', 'Nie znalazłem żadnego poprawnego adresu e-mail.');
    return c.redirect('/admin');
  }
  const db = c.env.DB;
  // jeden batch = jedno podżądanie, niezależnie od długości listy
  const t = now();
  const upserted = await db.batch<User & { is_new: number }>(
    people.map((p) =>
      db
        .prepare(
          `INSERT INTO users (email, name, created_at) VALUES (?, ?, ?)
           ON CONFLICT(email) DO UPDATE SET name = CASE WHEN excluded.name != '' THEN excluded.name ELSE users.name END, active = 1
           RETURNING *, (created_at = ?) AS is_new`,
        )
        .bind(p.email, p.name, t, t),
    ),
  );
  const fresh = upserted.map((r) => r.results[0]).filter((u): u is User & { is_new: number } => Boolean(u?.is_new));
  const added = fresh.length;
  // „tylko te maile”: dezaktywuj osoby spoza listy (bez adminów)
  let deactivated = 0;
  if (f.sync) {
    const listed = new Set(people.map((p) => p.email));
    const { results: active } = await db.prepare("SELECT id, email FROM users WHERE active = 1 AND role != 'admin'").all<{ id: number; email: string }>();
    const gone = active.filter((u) => !listed.has(u.email));
    if (gone.length) {
      await db.batch(gone.flatMap((u) => [db.prepare('UPDATE users SET active = 0 WHERE id = ?').bind(u.id), db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id)]));
    }
    deactivated = gone.length;
  }
  let sent = 0;
  let failed = 0;
  let blocked = 0;
  if (f.invite && mailConfigured(c.env)) {
    // limit podżądań na darmowym planie — w imporcie max 6 zaproszeń, resztę wysyła przycisk „niezaproszonym”
    for (const u of fresh.slice(0, 6)) {
      const r = await sendInvite(c, u);
      if (r.sent) sent++;
      else if (r.mode === 'blocked') blocked++;
      else failed++;
    }
  }
  const parts = [`Dodano ${added} ${plural(added, 'osobę', 'osoby', 'osób')}`];
  if (people.length > added) parts.push(`${people.length - added} już było na liście`);
  if (deactivated) parts.push(`dezaktywowano ${deactivated} spoza listy`);
  if (sent) parts.push(`wysłano ${sent} ${plural(sent, 'zaproszenie', 'zaproszenia', 'zaproszeń')}`);
  if (blocked) parts.push(`${blocked} zaproszeń wstrzymał limit wysyłki`);
  if (failed) parts.push(`${failed} maili nie wyszło, sprawdź ustawienia SMTP`);
  if (fresh.length > 6 && f.invite) parts.push('resztę zaproszeń wyślij przyciskiem „Wyślij zaproszenia niezaproszonym”');
  setFlash(c, failed ? 'err' : 'ok', `${parts.join(', ')}.`);
  return c.redirect('/admin');
});

/**
 * Zaproszenia dla aktywnych osób bez zaproszenia i bez hasła — po 8 naraz (ok. 5 podżądań na zaproszenie, limit 50).
 * Formularz przysyła identyfikatory osób wymienionych w pytaniu, więc wychodzi dokładnie to, co admin zatwierdził.
 */
admin.post('/czlonkowie/zaproszenia', requireAdmin, async (c) => {
  if (!mailConfigured(c.env)) {
    setFlash(c, 'err', 'Wysyłka maili jest wyłączona.');
    return c.redirect('/admin');
  }
  const f = await c.req.parseBody();
  const ids = [...new Set(String(f.ids ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, INVITE_BATCH);
  if (!ids.length) {
    setFlash(c, 'err', 'Nie wybrano nikogo do zaproszenia. Odśwież stronę i spróbuj ponownie.');
    return c.redirect('/admin');
  }
  const { results: todo } = await c.env.DB.prepare(
    `SELECT * FROM users WHERE id IN (${ids.map(() => '?').join(',')}) AND active = 1 AND invited_at IS NULL AND password_hash IS NULL`,
  )
    .bind(...ids)
    .all<User>();
  let sent = 0;
  const problems: string[] = [];
  for (const u of todo) {
    const r = await sendInvite(c, u);
    if (r.sent) sent++;
    else problems.push(`${u.name || u.email}: ${r.error ?? 'nie wysłano'}`);
  }
  const rest = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1 AND invited_at IS NULL AND password_hash IS NULL').first<{ n: number }>();
  const left = rest?.n ?? 0;
  const msg = [`Wysłano ${sent} ${plural(sent, 'zaproszenie', 'zaproszenia', 'zaproszeń')}`];
  if (left > 0) msg.push(`zostało ${left}, kliknij przycisk jeszcze raz`);
  if (problems.length) msg.push(`problemy: ${problems.slice(0, 3).join('; ')}`);
  setFlash(c, problems.length ? 'err' : 'ok', `${msg.join(', ')}.`);
  return c.redirect('/admin');
});

admin.post('/czlonkowie/:id/link', requireAdmin, async (c) => {
  const u = await c.env.DB.prepare('SELECT * FROM users WHERE id = ? AND active = 1').bind(Number(c.req.param('id'))).first<User>();
  if (!u) return c.json({ ok: false, error: 'Nie ma takiej osoby.' }, 404);
  return c.json({ ok: true, link: await inviteLink(c, u) });
});

admin.post('/czlonkowie/:id/zaproszenie', requireAdmin, async (c) => {
  const u = await c.env.DB.prepare('SELECT * FROM users WHERE id = ? AND active = 1').bind(Number(c.req.param('id'))).first<User>();
  if (!u) return c.json({ ok: false, error: 'Nie ma takiej osoby.' }, 404);
  const r = await sendInvite(c, u);
  if (!r.link) return c.json({ ok: false, error: r.error }, 429);
  return c.json({ ok: true, link: r.link, sent: r.sent, mode: r.mode, error: r.error ?? null });
});

admin.post('/czlonkowie/:id', requireAdmin, async (c) => {
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

admin.post('/mail-test', requireAdmin, async (c) => {
  const u = c.var.user!;
  const r = await sendMail(c.env, {
    to: u.email,
    subject: 'Test wysyłki ze strefy członka',
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
        Adres <span class="hint">/konkursy/… (zostaw puste, utworzymy z tytułu)</span>
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
          <span>Teksty (np. hasła), propozycje dodaje admin</span>
        </label>
        <label class="check">
          <input type="radio" name="kind" value="rollup" checked={contest.kind === 'rollup'} />
          <span>Projekty graficzne (rollup): członkowie wysyłają pliki, system je sprawdza</span>
        </label>
        <label class="check">
          <input type="radio" name="kind" value="leaderboard" checked={contest.kind === 'leaderboard'} />
          <span>Ranking (np. kto przyprowadzi najwięcej gości): zasady i tabela, wpisy dodają zarządzający</span>
        </label>
      </fieldset>
      <label for="phase">
        Etap
        <select id="phase" name="phase">
          {Object.entries(PHASES)
            .filter(([k]) => !(contest.kind === 'leaderboard' && k === 'voting'))
            .map(([k, v]) => (
              <option value={k} selected={(contest.phase ?? 'draft') === k || (contest.kind === 'leaderboard' && k === 'submissions' && contest.phase === 'voting')}>
                {contest.kind === 'leaderboard' && k === 'submissions' ? 'Trwa' : v}
              </option>
            ))}
        </select>
      </label>
      <fieldset>
        <legend>Sposoby głosowania</legend>
        <p class="hint" style="margin:0">Zaznacz jeden: to oficjalne głosowanie. Zaznacz kilka: członkowie przetestują każdy i powiedzą, który wolą (tryb testowy).</p>
        {METHOD_IDS.map((m) => (
          <label class="check">
            <input type="checkbox" name="methods" value={m} checked={contest.methods.includes(m)} />
            <span>
              <strong>{METHODS[m].name}</strong> <span class="hint">{METHODS[m].tagline}</span>
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
        <label for="period_start">
          Okres od <span class="hint">opcjonalnie</span>
          <input type="date" id="period_start" name="period_start" value={s.period_start ?? ''} />
        </label>
        <label for="period_end">
          Okres do <span class="hint">opcjonalnie</span>
          <input type="date" id="period_end" name="period_end" value={s.period_end ?? ''} />
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
    kind: ['rollup', 'leaderboard'].includes(one('kind')) ? one('kind') : 'text',
    phase: (Object.keys(PHASES) as string[]).includes(one('phase')) ? one('phase') : 'draft',
    results: (Object.keys(RESULTS_MODES) as string[]).includes(one('results')) ? one('results') : 'after_vote',
    methods: JSON.stringify(methods.length ? methods : ['top3']),
    settings: JSON.stringify({
      points_budget: int('points_budget', 10, 3, 100),
      max_entries: int('max_entries', 3, 1, 20),
      max_mb: int('max_mb', 95, 1, 95),
      ...(/^\d{4}-\d{2}-\d{2}$/.test(one('period_start')) ? { period_start: one('period_start') } : {}),
      ...(/^\d{4}-\d{2}-\d{2}$/.test(one('period_end')) ? { period_end: one('period_end') } : {}),
    }),
    position: int('position', 0, -1000, 1000),
  };
}

admin.get('/konkursy/nowy', requireAdmin, (c) =>
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

admin.post('/konkursy', requireAdmin, async (c) => {
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
    setFlash(c, 'err', `Adres /konkursy/${v.slug} jest już zajęty, wpisz inny.`);
    return c.redirect('/admin/konkursy/nowy');
  }
});

admin.get('/konkursy/:id', async (c) => {
  const db = c.env.DB;
  const contest = await getContest(db, Number(c.req.param('id')));
  if (!contest) return c.notFound();
  const denied = await guardContest(c, contest.id);
  if (denied) return denied;
  const isAdmin = c.var.user!.role === 'admin';
  const tpl = announcementTemplate(contest);
  const mailOn = mailConfigured(c.env);
  const activeCount = (await db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').first<{ n: number }>())?.n ?? 0;
  const { results: announcements } = await db
    .prepare(
      `SELECT a.phase, a.subject, a.recipients, a.skipped, a.created_at, COALESCE(NULLIF(u.name, ''), u.email) AS by_name
       FROM contest_announcements a LEFT JOIN users u ON u.id = a.sent_by WHERE a.contest_id = ? ORDER BY a.created_at DESC LIMIT 5`,
    )
    .bind(contest.id)
    .all<{ phase: string; subject: string; recipients: number; skipped: number; created_at: number; by_name: string | null }>();
  const { results: managers } = await db
    .prepare('SELECT u.id, u.name, u.email FROM contest_managers m JOIN users u ON u.id = m.user_id WHERE m.contest_id = ? ORDER BY u.name, u.email')
    .bind(contest.id)
    .all<{ id: number; name: string; email: string }>();
  const { results: candidates } = isAdmin
    ? await db.prepare("SELECT id, name, email FROM users WHERE active = 1 AND role != 'admin' ORDER BY name, email").all<{ id: number; name: string; email: string }>()
    : { results: [] as { id: number; name: string; email: string }[] };
  const entries = await listEntries(db, contest.id, true);
  const visible = entries.filter((e) => !e.hidden);
  const reviews = contest.kind === 'rollup' ? await entryReviews(db, contest.id, null) : new Map();
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
    <Layout title={contest.title} user={c.var.user} flash={takeFlash(c)} scripts={['/js/app.js']} nav={isAdmin ? 'admin' : 'home'}>
      <PageHead eyebrow={isAdmin ? 'Panel admina · konkurs' : 'Zarządzanie konkursem'} title={contest.title}>
        <p class="row" style="margin:12px 0 0">
          <PhasePill phase={contest.phase} kind={contest.kind} />
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
          {contest.kind === 'leaderboard' ? (
            <p class="callout blue">
              Ranking i rejestr gości są na <a href={`/konkursy/${contest.slug}`}>stronie konkursu</a>: tam dodajesz gości i widzisz tabelę.
            </p>
          ) : (
            <>
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
                      const lead = t.voters ? t.rows.filter((r) => r.rank === 1).map((r) => r.title).join(' / ') : '-';
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
                      {f.comment && <span class="muted">: „{f.comment}”</span>}
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
                  Dodaj propozycje, jedna w linii
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
                    <SubmissionCard entry={e} aiOn={aiProvider(c.env) !== null} canDelete={true} author={e.author_id ? authors.get(e.author_id) : undefined} reviews={reviews.get(e.id)} />
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

            </>
          )}

          <div class="card">
            <h2>Powiadom klubowiczów</h2>
            {!mailOn ? (
              <p class="muted">Wysyłka maili jest wyłączona.</p>
            ) : !tpl ? (
              <p class="muted">Konkurs jest w szkicu. Członkowie go nie widzą, więc nie ma jeszcze o czym powiadamiać.</p>
            ) : (
              <form
                class="form"
                method="post"
                action={`/admin/konkursy/${contest.id}/powiadom`}
                data-confirm={`Wysłać maila do ${activeCount} ${plural(activeCount, 'osoby', 'osób', 'osób')}?${
                  announcements.some((a) => a.phase === contest.phase) ? ' Uwaga: na tym etapie powiadomienie już raz poszło.' : ''
                }`}
              >
                <p class="hint" style="margin:0">
                  Jeden mail do wszystkich aktywnych członków ({activeCount}) w ukrytej kopii, więc nikt nie widzi adresów innych osób. Link do konkursu i
                  podpowiedź, jak się zalogować, dodamy sami. Treść możesz poprawić przed wysłaniem.
                </p>
                <label for="ann-subject">
                  Temat
                  <input type="text" id="ann-subject" name="subject" value={tpl.subject} maxlength={150} required />
                </label>
                <label for="ann-message">
                  Treść
                  <textarea id="ann-message" name="message" rows={5} maxlength={2000} required>
                    {tpl.message}
                  </textarea>
                </label>
                <button class="btn" type="submit" style="justify-self:start">
                  Wyślij do {activeCount} {plural(activeCount, 'osoby', 'osób', 'osób')}
                </button>
              </form>
            )}
            {announcements.length > 0 && (
              <div style="margin-top:18px">
                <p class="small" style="margin:0 0 6px">
                  <b>Wysłane powiadomienia</b>
                </p>
                <ul class="small muted" style="margin:0;padding-left:1.2em">
                  {announcements.map((a) => (
                    <li>
                      {fmtDate(a.created_at)}: „{a.subject}”, {a.recipients} {plural(a.recipients, 'osoba', 'osoby', 'osób')}
                      {a.skipped ? `, pominięto ${a.skipped}` : ''}
                      {a.by_name ? `, wysłał(a): ${a.by_name}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div class="card">
            <h2>Opiekunowie konkursu</h2>
            <p class="muted">
              Opiekun zarządza tylko tym konkursem: ustawienia i etap, propozycje, zgłoszenia z autorami, wyniki i zerowanie głosów. Nie widzi listy
              członków ani innych konkursów.
            </p>
            {managers.length === 0 ? (
              <p class="empty-note">Brak opiekunów. Konkursem zarządza tylko admin systemu.</p>
            ) : (
              <ul class="stack" style="--gap:8px;padding:0;list-style:none;margin:0 0 12px">
                {managers.map((m) => (
                  <li class="row">
                    <span>
                      <strong>{m.name || m.email}</strong> <span class="muted small">{m.email}</span>
                    </span>
                    {isAdmin && (
                      <form method="post" action={`/admin/konkursy/${contest.id}/opiekunowie`} class="inline-form">
                        <input type="hidden" name="action" value="remove" />
                        <input type="hidden" name="user_id" value={String(m.id)} />
                        <button class="btn danger small" type="submit">
                          Odbierz
                        </button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {isAdmin && candidates.length > 0 && (
              <form method="post" action={`/admin/konkursy/${contest.id}/opiekunowie`} class="row" style="gap:8px">
                <input type="hidden" name="action" value="add" />
                <label class="visually-hidden" for="new-manager">
                  Osoba
                </label>
                <select id="new-manager" name="user_id" required style="min-block-size:40px;border-radius:8px;font:inherit;padding:4px 8px;max-width:100%">
                  <option value="">Wybierz osobę</option>
                  {candidates
                    .filter((u) => !managers.some((m) => m.id === u.id))
                    .map((u) => (
                      <option value={String(u.id)}>{u.name ? `${u.name} (${u.email})` : u.email}</option>
                    ))}
                </select>
                <button class="btn small" type="submit">
                  Dodaj opiekuna
                </button>
              </form>
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
              {isAdmin && (
                <form method="post" action={`/admin/konkursy/${contest.id}/usun`} data-confirm="Usunąć cały konkurs razem z propozycjami, plikami i głosami?">
                  <button class="btn danger small" type="submit">
                    Usuń konkurs
                  </button>
                </form>
              )}
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
  const denied = await guardContest(c, id);
  if (denied) return denied;
  const v = readContestForm(await c.req.parseBody({ all: true }));
  if (!v.title) {
    setFlash(c, 'err', 'Podaj tytuł.');
    return c.redirect(`/admin/konkursy/${id}`);
  }
  const before = await getContest(c.env.DB, id);
  try {
    await c.env.DB.prepare(
      'UPDATE contests SET slug = ?, title = ?, description = ?, kind = ?, phase = ?, methods = ?, results = ?, settings = ?, position = ? WHERE id = ?',
    )
      .bind(v.slug, v.title, v.description, v.kind, v.phase, v.methods, v.results, v.settings, v.position, id)
      .run();
    const phaseChanged = before && before.phase !== v.phase && v.phase !== 'draft';
    setFlash(c, 'ok', phaseChanged ? 'Zapisano. Etap się zmienił: możesz powiadomić klubowiczów mailem (sekcja „Powiadom klubowiczów” niżej).' : 'Zapisano ustawienia.');
  } catch {
    setFlash(c, 'err', `Adres /konkursy/${v.slug} jest już zajęty.`);
  }
  return c.redirect(`/admin/konkursy/${id}`);
});

admin.post('/konkursy/:id/powiadom', async (c) => {
  const id = Number(c.req.param('id'));
  const denied = await guardContest(c, id);
  if (denied) return denied;
  const db = c.env.DB;
  const contest = await getContest(db, id);
  if (!contest) return c.notFound();
  const back = `/admin/konkursy/${id}`;
  if (contest.phase === 'draft') {
    setFlash(c, 'err', 'Konkurs jest w szkicu, członkowie go nie widzą.');
    return c.redirect(back);
  }
  const f = await c.req.parseBody();
  const subject = String(f.subject ?? '').trim().replace(/\s*—\s*/g, ' - ').slice(0, 150);
  const message = String(f.message ?? '').trim().replace(/\s*—\s*/g, ' - ').slice(0, 2000);
  if (!subject || !message) {
    setFlash(c, 'err', 'Podaj temat i treść.');
    return c.redirect(back);
  }
  const { results } = await db.prepare('SELECT email FROM users WHERE active = 1').all<{ email: string }>();
  const link = `${new URL(c.req.url).origin}/konkursy/${contest.slug}`;
  const r = await sendAnnouncement(c.env, results.map((u) => u.email), announcementMail(subject, message, link));
  if (r.sent) {
    await db
      .prepare('INSERT INTO contest_announcements (contest_id, phase, subject, recipients, skipped, sent_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, contest.phase, subject, r.sent, r.skipped, c.var.user!.id, now())
      .run();
  }
  if (r.sent) {
    const extra = [r.skipped ? `pominięto ${r.skipped} (dostali maila przed chwilą, wyślij im później)` : '', r.error ? `część się nie udała: ${r.error}` : '']
      .filter(Boolean)
      .join(', ');
    setFlash(c, r.error ? 'err' : 'ok', `Wysłano powiadomienie do ${r.sent} ${plural(r.sent, 'osoby', 'osób', 'osób')}${extra ? `, ${extra}` : ''}.`);
  } else {
    setFlash(c, 'err', r.error ?? 'Nie udało się wysłać.');
  }
  return c.redirect(back);
});

admin.post('/konkursy/:id/propozycje', async (c) => {
  const id = Number(c.req.param('id'));
  const denied = await guardContest(c, id);
  if (denied) return denied;
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
  const denied = await guardContest(c, e.contest_id);
  if (denied) return denied;
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
  const denied = await guardContest(c, id);
  if (denied) return denied;
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

admin.post('/konkursy/:id/opiekunowie', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  const f = await c.req.parseBody();
  const userId = Number(f.user_id);
  const db = c.env.DB;
  const u = await db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').bind(userId).first<User>();
  if (!u || !(await getContest(db, id))) {
    setFlash(c, 'err', 'Nie ma takiej osoby albo konkursu.');
    return c.redirect(`/admin/konkursy/${id}`);
  }
  if (String(f.action) === 'remove') {
    await db.prepare('DELETE FROM contest_managers WHERE contest_id = ? AND user_id = ?').bind(id, userId).run();
    setFlash(c, 'ok', `${u.name || u.email} nie jest już opiekunem tego konkursu.`);
  } else {
    await db.prepare('INSERT OR IGNORE INTO contest_managers (contest_id, user_id, created_at) VALUES (?, ?, ?)').bind(id, userId, now()).run();
    setFlash(c, 'ok', `${u.name || u.email} jest teraz opiekunem tego konkursu.`);
  }
  return c.redirect(`/admin/konkursy/${id}`);
});

admin.post('/konkursy/:id/usun', requireAdmin, async (c) => {
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

