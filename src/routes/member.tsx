import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv, Contest, EntryRow, User } from '../env';
import type { ReviewVerdict } from '../lib/contests';
import {
  canManage,
  canSeeResults,
  computeTallies,
  entryReviews,
  getContest,
  isReviewVerdict,
  isTestMode,
  leaderboard,
  listContests,
  listEntries,
  managedContestIds,
  REVIEW_VERDICTS,
  ROLLUP_DEFAULTS,
  userBallots,
  type EntryReview,
  type LeaderRow,
} from '../lib/contests';
import { refererPath, setPreview } from '../lib/auth';
import { reviewMail, sendMail } from '../lib/mail';
import { setFlash, takeFlash } from '../lib/flash';
import { hashPassword, MIN_PASSWORD, passwordProblem } from '../lib/password';
import { firstName, fmtDate, fmtDay, fmtSize, safeJson } from '../lib/util';
import { isMethod, METHODS, plural, type MethodId } from '../lib/voting';
import { aiProvider, type AiReview } from '../lib/ai';
import { getStore } from '../lib/storage';
import { JsonData, Layout, PageHead, PasswordInput, PhasePill } from '../views/layout';
import { AiReviewView, TechReportView, VERDICT_AI, VERDICT_TECH, type TechReport } from '../views/reports';

export const member = new Hono<AppEnv>();

const ctaFor = (c: Contest, voted: boolean) => {
  if (c.kind === 'leaderboard') return 'Zobacz ranking';
  if (c.phase === 'voting') return voted ? 'Zobacz / zmień głos' : 'Zagłosuj';
  if (c.phase === 'submissions') return c.kind === 'rollup' ? 'Wyślij projekt' : 'Zobacz propozycje';
  if (c.phase === 'closed') return 'Wyniki';
  return 'Podgląd';
};

member.get('/', async (c) => {
  const user = c.var.user!;
  const isAdmin = user.role === 'admin';
  const managed = isAdmin || user.preview ? new Set<number>() : await managedContestIds(c.env.DB, user.id);
  const contests = (await listContests(c.env.DB, true)).filter((ct) => ct.phase !== 'draft' || isAdmin || managed.has(ct.id));
  const { results: voted } = await c.env.DB.prepare('SELECT DISTINCT contest_id FROM ballots WHERE user_id = ?').bind(user.id).all<{ contest_id: number }>();
  const votedSet = new Set(voted.map((v) => v.contest_id));
  return c.html(
    <Layout title="Konkursy" user={user} flash={takeFlash(c)} nav="home">
      <PageHead eyebrow={`Cześć, ${firstName(user.name, user.email)}!`} title="Konkursy klubowe" lead="Tu głosujemy i zbieramy projekty. Każdy członek klubu ma jeden głos, który możesz zmieniać do końca głosowania." />
      <section class="section tight">
        <div class="wrap">
          {contests.length === 0 ? (
            <p class="empty-note">Na razie nie ma żadnych konkursów. Zajrzyj tu wkrótce!</p>
          ) : (
            <div class="grid">
              {contests.map((ct) => (
                <article class="card contest-card">
                  <p class="row" style="margin:0">
                    <PhasePill phase={ct.phase} kind={ct.kind} />
                    {votedSet.has(ct.id) && <span class="pill ok">✓ Oddano głos</span>}
                    {isTestMode(ct) && ct.phase === 'voting' && <span class="pill warn">Tryb testowy</span>}
                  </p>
                  <h3>{ct.title}</h3>
                  {ct.description && <p>{ct.description.length > 180 ? `${ct.description.slice(0, 180)}…` : ct.description}</p>}
                  <p class="row" style="margin:auto 0 0">
                    <a class="btn" href={`/konkursy/${ct.slug}`}>
                      {ctaFor(ct, votedSet.has(ct.id))}
                    </a>
                    {(isAdmin || managed.has(ct.id)) && (
                      <a class="btn ghost" href={`/admin/konkursy/${ct.id}`}>
                        Zarządzaj
                      </a>
                    )}
                  </p>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </Layout>,
  );
});

const previewUrl = (e: EntryRow) => (e.preview_key ? `/pliki/${e.id}/podglad` : null);

member.get('/konkursy/:slug', async (c) => {
  const user = c.var.user!;
  const db = c.env.DB;
  const contest = await getContest(db, c.req.param('slug'));
  if (!contest) return c.notFound();
  // admin systemu albo opiekun tego konkursu
  const manager = await canManage(db, user, contest.id);
  if (contest.phase === 'draft' && !manager) return c.notFound();

  const entries = await listEntries(db, contest.id);
  const ballots = await userBallots(db, contest.id, user.id);
  const visibleMethods = contest.methods.filter((m) => canSeeResults(contest, user, m in ballots, manager));
  const tallies = await computeTallies(db, contest, visibleMethods, entries);
  const feedback = await db
    .prepare('SELECT preferred, comment FROM method_feedback WHERE contest_id = ? AND user_id = ?')
    .bind(contest.id, user.id)
    .first<{ preferred: string; comment: string }>();
  const testMode = isTestMode(contest);
  // odpowiedzi na ankietę „który sposób najlepszy” widzi admin i opiekun konkursu
  const allFeedback =
    manager && testMode
      ? (
          await db
            .prepare(
              `SELECT f.preferred, f.comment, COALESCE(NULLIF(u.name, ''), u.email) AS who FROM method_feedback f JOIN users u ON u.id = f.user_id
               WHERE f.contest_id = ? ORDER BY f.updated_at DESC`,
            )
            .bind(contest.id)
            .all<{ preferred: string; comment: string; who: string }>()
        ).results
      : [];
  const isBoard = contest.kind === 'leaderboard';
  const showVoting = !isBoard && (contest.phase === 'voting' || (contest.phase === 'draft' && manager));
  const isRollup = contest.kind === 'rollup';

  const mySubs =
    isRollup
      ? (
          await db
            .prepare('SELECT * FROM entries WHERE contest_id = ? AND author_id = ? ORDER BY created_at DESC')
            .bind(contest.id, user.id)
            .all<EntryRow>()
        ).results
      : [];

  // admin widzi wszystkie zgłoszenia z autorami; członkowie tylko swoje (w głosowaniu — bez nazwisk)
  const allSubs =
    isRollup && manager
      ? (
          await db
            .prepare(
              `SELECT e.*, COALESCE(NULLIF(u.name, ''), u.email, '-') AS author FROM entries e LEFT JOIN users u ON u.id = e.author_id
               WHERE e.contest_id = ? AND e.upload_complete = 1 ORDER BY e.created_at DESC`,
            )
            .bind(contest.id)
            .all<EntryRow & { author: string }>()
        ).results
      : [];

  // uwagi opiekuna: opiekun widzi wszystkie, członek tylko do swoich projektów
  const reviews = isRollup && (mySubs.length || allSubs.length) ? await entryReviews(db, contest.id, manager ? null : user.id) : new Map<number, EntryReview[]>();

  const board = isBoard ? await leaderboard(db, contest.id) : [];
  const visits =
    isBoard && manager
      ? (
          await db
            .prepare(
              `SELECT v.id, v.guest_name, v.visit_date, COALESCE(NULLIF(u.name, ''), u.email) AS host
               FROM guest_visits v JOIN users u ON u.id = v.user_id WHERE v.contest_id = ? ORDER BY COALESCE(v.visit_date, '') DESC, v.id DESC`,
            )
            .bind(contest.id)
            .all<{ id: number; guest_name: string; visit_date: string | null; host: string }>()
        ).results
      : [];
  const hosts =
    isBoard && manager
      ? (await db.prepare("SELECT id, COALESCE(NULLIF(name, ''), email) AS name FROM users WHERE active = 1 ORDER BY name").all<{ id: number; name: string }>()).results
      : [];

  const scripts = ['/js/app.js'];
  if (!isBoard && (showVoting || contest.phase === 'closed')) scripts.push('/js/vote.js');
  if (isRollup && contest.phase === 'submissions') scripts.push('/js/rollup.js');

  return c.html(
    <Layout title={contest.title} user={user} flash={takeFlash(c)} scripts={scripts} nav="home">
      <PageHead eyebrow={isRollup ? 'Konkurs na projekt' : 'Konkurs'} title={contest.title} lead={contest.description}>
        <p class="row" style="margin:16px 0 0">
          <PhasePill phase={contest.phase} kind={contest.kind} />
          {testMode && showVoting && <span class="pill warn">Tryb testowy: kilka sposobów głosowania</span>}
          {manager && (
            <a class="btn ghost small" href={`/admin/konkursy/${contest.id}`}>
              Ustawienia konkursu
            </a>
          )}
        </p>
      </PageHead>

      {isBoard && <Leaderboard contest={contest} rows={board} me={user.id} manager={manager} visits={visits} hosts={hosts} />}

      {isRollup && contest.phase === 'submissions' && <RollupSubmit contest={contest} user={user} mySubs={mySubs} reviews={reviews} aiOn={aiProvider(c.env) !== null} storeOn={getStore(c.env) !== null} />}

      {manager && isRollup && (
        <section class="section tight">
          <div class="wrap mid">
            <h2>
              Wszystkie zgłoszenia ({allSubs.length}) <span class="pill">{user.role === 'admin' ? 'widok admina' : 'widok opiekuna'}</span>
            </h2>
            <p class="muted">Członkowie widzą tylko własne projekty, a w głosowaniu same projekty, bez nazwisk autorów. Uwagi, które dodasz do zgłoszenia, zobaczy jego autor.</p>
            {allSubs.length === 0 ? (
              <p class="empty-note">Nikt jeszcze nie wysłał projektu.</p>
            ) : (
              <div class="stack" style="--gap:16px">
                {allSubs.map((e) => (
                  <SubmissionCard
                    entry={e}
                    aiOn={aiProvider(c.env) !== null}
                    canDelete={true}
                    author={e.author_id === user.id ? `${e.author} (Ty)` : e.author}
                    idPrefix="all-entry"
                    reviews={reviews.get(e.id)}
                    reviewSlug={contest.slug}
                  />
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {contest.kind === 'text' && contest.phase === 'submissions' && (
        <section class="section tight">
          <div class="wrap mid">
            <h2>Propozycje</h2>
            <ol class="opts">
              {entries.map((e) => (
                <li class="opt">
                  <span class="txt">{e.title}</span>
                </li>
              ))}
            </ol>
            <p class="muted" style="margin-top:16px">
              Głosowanie jeszcze się nie zaczęło.
            </p>
          </div>
        </section>
      )}

      {showVoting && (
        <section class="section tight">
          <div class="wrap mid">
            {contest.phase === 'draft' && <p class="callout">Podgląd dla zarządzających: konkurs jest w szkicu, członkowie go nie widzą.</p>}
            {testMode && (
              <div class="callout" style="margin-bottom:20px">
                <p>
                  <strong>Tryb testowy.</strong> Nie zdecydowaliśmy jeszcze, jak głosować. Wypróbuj każdy sposób (zakładki poniżej). Głosy w każdej
                  zakładce liczą się osobno. Na dole strony powiedz nam, który sposób najbardziej Ci odpowiada.
                </p>
              </div>
            )}
            {entries.length < 2 ? (
              <p class="empty-note">Za mało propozycji, żeby głosować.</p>
            ) : (
              <div class="tabs" id="vote-app">
                {testMode && (
                  <div role="tablist" class="tablist" aria-label="Sposób głosowania">
                    {contest.methods.map((m, i) => (
                      <button type="button" role="tab" id={`tab-${m}`} aria-selected={i === 0 ? 'true' : 'false'} tabindex={i === 0 ? 0 : -1} data-method={m}>
                        {METHODS[m].short}
                        {m in ballots && (
                          <span class="done-mark" aria-label="oddano głos">
                            ✓
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
                {contest.methods.map((m, i) => (
                  <div
                    role={testMode ? 'tabpanel' : 'region'}
                    id={`panel-${m}`}
                    aria-labelledby={testMode ? `tab-${m}` : undefined}
                    aria-label={testMode ? undefined : 'Głosowanie'}
                    hidden={i > 0}
                    data-panel={m}
                  >
                    <div class="tabpanel-inner">
                      <div class="method-head">
                        <h2>{testMode ? METHODS[m].name : 'Twój głos'}</h2>
                        <p>{METHODS[m].tagline.replace('10 punktów', `${contest.settings.points_budget ?? 10} punktów`)}</p>
                        <p class="how">Jak liczymy: {METHODS[m].scoring}</p>
                      </div>
                      <div data-ballot={m}>
                        <noscript>
                          <p class="flash err">Do głosowania potrzebny jest włączony JavaScript.</p>
                        </noscript>
                      </div>
                      <div class="res-box" data-results={m} hidden={!tallies[m]}></div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {testMode && contest.phase === 'voting' && (
              <form class="form card" method="post" action={`/konkursy/${contest.slug}/opinia`} style="margin-top:36px">
                <h2 style="margin:0">Który sposób głosowania jest najlepszy?</h2>
                <fieldset>
                  <legend>Wybierz jeden</legend>
                  {contest.methods.map((m) => (
                    <label class="check">
                      <input type="radio" name="preferred" value={m} required checked={feedback?.preferred === m} />
                      <span>
                        <strong>{METHODS[m].name}</strong> <span class="hint">{METHODS[m].pros}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <label for="fb-comment">
                  Komentarz (opcjonalnie)
                  <textarea id="fb-comment" name="comment" maxlength={1000} placeholder="Co było wygodne, co męczyło?">
                    {feedback?.comment ?? ''}
                  </textarea>
                </label>
                {feedback && (
                  <p class="flash ok small" style="margin:0">
                    Twoja odpowiedź jest zapisana ({isMethod(feedback.preferred) ? METHODS[feedback.preferred].name : feedback.preferred}). Możesz ją zmienić do
                    końca głosowania.
                  </p>
                )}
                <button class="btn" type="submit" style="justify-self:start">
                  {feedback ? 'Zmień opinię' : 'Wyślij opinię'}
                </button>
              </form>
            )}

            {manager && testMode && (contest.phase === 'voting' || allFeedback.length > 0) && (
              <FeedbackSummary contest={contest} feedback={allFeedback} />
            )}
          </div>
        </section>
      )}

      {!isBoard && contest.phase === 'closed' && (
        <section class="section tight">
          <div class="wrap mid">
            <h2>Wyniki</h2>
            {visibleMethods.length === 0 ? (
              <p class="empty-note">Wyniki ogłosi zarząd klubu.</p>
            ) : (
              <div id="closed-results" class="stack" style="--gap:32px">
                {visibleMethods.map((m) => (
                  <div class="card" data-static-results={m}></div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {!isBoard && (showVoting || contest.phase === 'closed') && (
        <JsonData
          id="vote-data"
          data={{
            contestId: contest.id,
            phase: contest.phase,
            kind: contest.kind,
            testMode,
            budget: contest.settings.points_budget ?? 10,
            methods: contest.methods.map((m) => ({ id: m, name: METHODS[m].name })),
            entries: entries.map((e) => ({ id: e.id, title: e.title, preview: previewUrl(e) })),
            ballots,
            results: tallies,
          }}
        />
      )}

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

/** Podsumowanie ankiety o sposobach głosowania (tylko admin i opiekun konkursu) */
const FeedbackSummary = ({ contest, feedback }: { contest: Contest; feedback: { preferred: string; comment: string; who: string }[] }) => {
  const methods = [...new Set([...contest.methods, ...feedback.map((f) => f.preferred).filter(isMethod)])] as MethodId[];
  const counts = methods.map((m) => ({ m, n: feedback.filter((f) => f.preferred === m).length })).sort((a, b) => b.n - a.n);
  const max = Math.max(1, ...counts.map((c) => c.n));
  const comments = feedback.filter((f) => f.comment.trim());
  return (
    <section class="card stack" style="margin-top:20px;--gap:14px" aria-labelledby="fb-sum">
      <h2 id="fb-sum" style="margin:0">
        Odpowiedzi członków ({feedback.length}) <span class="pill">widzi tylko admin i opiekun</span>
      </h2>
      {feedback.length === 0 ? (
        <p class="empty-note">Nikt jeszcze nie odpowiedział.</p>
      ) : (
        <ol class="results">
          {counts.map(({ m, n }) => (
            <li>
              <span class="place" aria-hidden="true">
                {n}
              </span>
              <span class="name">
                <span>{METHODS[m].name}</span>
                <small>
                  {n} {plural(n, 'osoba woli', 'osoby wolą', 'osób woli')} ten sposób
                </small>
              </span>
              <span class="bar" aria-hidden="true">
                <i style={`width:${Math.round((n / max) * 100)}%`}></i>
              </span>
            </li>
          ))}
        </ol>
      )}
      {comments.length > 0 && (
        <div>
          <h3>Komentarze</h3>
          <ul class="stack" style="--gap:8px;padding-left:1.2em;margin:0">
            {comments.map((f) => (
              <li>
                <strong>{f.who}</strong> ({isMethod(f.preferred) ? METHODS[f.preferred].name : f.preferred}): „{f.comment}”
              </li>
            ))}
          </ul>
        </div>
      )}
      <p class="small" style="margin:0">
        <a href={`/admin/konkursy/${contest.id}`}>Porównanie z wynikami głosowania w panelu zarządzania</a>
      </p>
    </section>
  );
};

const RollupSubmit = ({
  contest,
  user,
  mySubs,
  reviews,
  aiOn,
  storeOn,
}: {
  contest: Contest;
  user: User;
  mySubs: EntryRow[];
  reviews: Map<number, EntryReview[]>;
  aiOn: boolean;
  storeOn: boolean;
}) => {
  const s = { ...ROLLUP_DEFAULTS, ...contest.settings };
  const done = mySubs.filter((e) => e.upload_complete);
  const limitReached = user.role !== 'admin' && done.length >= s.max_entries;
  return (
    <section class="section tight">
      <div class="wrap mid stack" style="--gap:28px">
        <div class="card">
          <h2>Wymagania techniczne</h2>
          <ul class="spec">
            <li>
              Wymiar rollupu: <strong>{s.width_mm / 10} × {s.height_mm / 10} cm</strong> (pion). Plik w skali 1:1 albo 1:10, sprawdzimy proporcje.
            </li>
            <li>
              Najlepiej <strong>PDF</strong> (wektorowy, z osadzonymi czcionkami lub tekstem zamienionym na krzywe). Przyjmujemy też SVG, JPG, PNG i
              WebP.
            </li>
            <li>
              Zdjęcia i grafiki rastrowe: min. <strong>100 DPI</strong> w skali 1:1 (zalecane 150 DPI), czyli np. JPG co najmniej{' '}
              {Math.round((s.width_mm / 25.4) * 100)} × {Math.round((s.height_mm / 25.4) * 100)} px.
            </li>
            <li>Dolne ~10 cm chowa się w kasecie stojaka, więc nie umieszczaj tam ważnych treści. Zostaw ~3 cm marginesu po bokach.</li>
            <li>
              Zgodność z <a href="https://content.toastmasters.org/image/upload/02330-001-0001-brand-manual.pdf">Brand Manualem Toastmasters</a>:
              oficjalne logo bez zmian, kolory Loyal Blue #004165 i True Maroon #772432 (akcenty: Cool Gray #A9B2B1, Happy Yellow #F2DF74), czcionki
              Montserrat/Gotham i Source Sans/Myriad.
            </li>
            <li>
              Maks. rozmiar pliku: {s.max_mb} MB. Maks. {s.max_entries} {s.max_entries === 1 ? 'projekt' : 'projekty'} na osobę.
            </li>
          </ul>
        </div>

        {!storeOn ? (
          <p class="flash err">Przechowywanie plików nie jest skonfigurowane. Daj znać adminowi.</p>
        ) : limitReached ? (
          <p class="callout">Wysłałeś(-aś) już maksymalną liczbę projektów ({s.max_entries}). Możesz usunąć któryś poniżej i wysłać nowy.</p>
        ) : (
          <div class="card raised" id="rollup-app">
            <h2>Wyślij projekt</h2>
            <p class="muted">Najpierw sprawdzimy plik w Twojej przeglądarce (rozmiar, proporcje, DPI, czcionki, kolory). Plik nie jest nigdzie wysyłany, dopóki nie klikniesz „Wyślij projekt”.</p>
            <label class="drop" id="drop">
              <input type="file" id="file" accept=".pdf,.svg,.jpg,.jpeg,.png,.webp,application/pdf,image/svg+xml,image/jpeg,image/png,image/webp" />
              <strong>Wybierz plik albo upuść go tutaj</strong>
              <span class="muted small">PDF, SVG, JPG, PNG, WebP · do {s.max_mb} MB</span>
            </label>
            <div id="analysis" hidden></div>
          </div>
        )}

        <div>
          <h2>Twoje zgłoszenia</h2>
          {mySubs.length === 0 ? (
            <p class="empty-note">Nie masz jeszcze zgłoszeń.</p>
          ) : (
            <div class="stack" style="--gap:16px">
              {mySubs.map((e) => (
                <SubmissionCard entry={e} aiOn={aiOn} canDelete={true} reviews={reviews.get(e.id)} />
              ))}
            </div>
          )}
        </div>
      </div>
      <JsonData id="rollup-data" data={{ contestId: contest.id, settings: s, aiOn }} />
    </section>
  );
};

/**
 * idPrefix: inny prefiks id, gdy karta jest drugi raz na stronie (widok opiekuna), żeby id się nie powtarzały.
 * reviews: uwagi opiekuna; reviewSlug: slug konkursu, gdy oglądający może dodawać i usuwać uwagi.
 */
export const SubmissionCard = ({
  entry: e,
  aiOn,
  canDelete,
  author,
  idPrefix = 'entry',
  reviews = [],
  reviewSlug,
}: {
  entry: EntryRow;
  aiOn: boolean;
  canDelete: boolean;
  author?: string;
  idPrefix?: string;
  reviews?: EntryReview[];
  reviewSlug?: string;
}) => {
  const report = safeJson<TechReport | null>(e.report, null);
  const aiRaw = safeJson<(AiReview & { error?: undefined }) | { error: string; created_at: number } | null>(e.ai_report, null);
  const ai = aiRaw && !aiRaw.error ? (aiRaw as AiReview) : null;
  const aiError = aiRaw?.error ?? null;
  const tech = VERDICT_TECH[report?.verdict ?? 'warn'] ?? VERDICT_TECH.warn;
  const lastVerdict = [...reviews].reverse().find((r) => r.verdict)?.verdict ?? null;
  const formId = `${idPrefix}-${e.id}-review`;
  return (
    <article class="card" id={`${idPrefix}-${e.id}`}>
      <div class="subm">
        {e.preview_key ? (
          <button type="button" class="thumb-btn" data-lightbox={`/pliki/${e.id}/podglad`} data-title={e.title} aria-label={`Powiększ podgląd: ${e.title}`}>
            <img class="thumb" src={`/pliki/${e.id}/podglad`} alt="" loading="lazy" />
          </button>
        ) : (
          <span class="thumb" aria-hidden="true"></span>
        )}
        <div class="stack" style="--gap:8px">
          <h3 style="margin:0">{e.title}</h3>
          <p class="row small" style="margin:0">
            {!e.upload_complete && <span class="pill err">Wysyłka nieukończona</span>}
            {e.hidden ? <span class="pill draft">Ukryty</span> : null}
            <span class={`pill ${tech.cls}`}>{tech.text}</span>
            {ai && <span class={`pill ${VERDICT_AI[ai.verdict]?.cls ?? 'warn'}`}>AI: {ai.score}/100</span>}
            {lastVerdict && <span class={`pill ${REVIEW_VERDICTS[lastVerdict].cls}`}>Opiekun: {REVIEW_VERDICTS[lastVerdict].text}</span>}
            <span class="muted">
              {e.file_name} · {fmtSize(e.file_size)} · {fmtDate(e.created_at)}
              {author ? ` · ${author}` : ''}
            </span>
          </p>
          <details class="more">
            <summary>Raport techniczny</summary>
            <div style="margin-top:10px">
              <TechReportView report={report} />
            </div>
          </details>
          <details class="more" open={Boolean(ai || aiError)}>
            <summary>Zgodność z brand manualem (AI)</summary>
            <div style="margin-top:10px" data-ai-box={e.id}>
              <AiReviewView review={ai} error={aiError} />
            </div>
          </details>
          {reviews.length > 0 && (
            <section class="reviews" aria-label="Uwagi opiekuna konkursu">
              <h4>Uwagi opiekuna konkursu</h4>
              <ul>
                {reviews.map((r) => (
                  <li>
                    <p class="row small" style="margin:0">
                      {r.verdict && <span class={`pill ${REVIEW_VERDICTS[r.verdict].cls}`}>{REVIEW_VERDICTS[r.verdict].text}</span>}
                      <span class="muted">
                        {r.reviewer} · {fmtDate(r.created_at)}
                        {r.mailed ? ' · autor dostał maila' : ''}
                      </span>
                      {reviewSlug && (
                        <form method="post" action={`/konkursy/${reviewSlug}/uwagi/${r.id}/usun`} class="inline-form" style="margin-left:auto" data-confirm="Usunąć te uwagi?">
                          <input type="hidden" name="back" value={idPrefix} />
                          <button type="submit" class="btn ghost small">
                            Usuń uwagi
                          </button>
                        </form>
                      )}
                    </p>
                    {r.comment && <p class="review-text">{r.comment}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {reviewSlug && (
            <details class="more">
              <summary>Dodaj uwagi dla autora</summary>
              <form
                class="form"
                method="post"
                action={`/konkursy/${reviewSlug}/zgloszenia/${e.id}/uwagi`}
                data-mail-preview={`/konkursy/${reviewSlug}/zgloszenia/${e.id}/uwagi/podglad`}
                data-mail-preview-if="notify"
                style="margin-top:12px"
              >
                <input type="hidden" name="back" value={idPrefix} />
                <fieldset>
                  <legend>Ocena</legend>
                  <label class="check">
                    <input type="radio" name="verdict" value="" checked />
                    <span>Bez oceny, tylko komentarz</span>
                  </label>
                  {Object.entries(REVIEW_VERDICTS).map(([k, v]) => (
                    <label class="check">
                      <input type="radio" name="verdict" value={k} />
                      <span>{v.text}</span>
                    </label>
                  ))}
                </fieldset>
                <label for={`${formId}-comment`}>
                  Uwagi <span class="hint">zobaczy je autor projektu</span>
                  <textarea id={`${formId}-comment`} name="comment" maxlength={3000} rows={4}></textarea>
                </label>
                <label class="check">
                  <input type="checkbox" name="notify" value="1" checked />
                  <span>Wyślij autorowi maila z uwagami</span>
                </label>
                <button class="btn small" type="submit" style="justify-self:start">
                  Zapisz uwagi
                </button>
              </form>
            </details>
          )}
          <div class="row">
            {e.upload_complete && e.file_key ? (
              <a class="btn ghost small" href={`/pliki/${e.id}/plik`}>
                Pobierz plik
              </a>
            ) : null}
            {aiOn && e.preview_key && (
              <button type="button" class="btn ghost small" data-ai-run={e.id}>
                {ai ? 'Oceń ponownie (AI)' : aiError ? 'Spróbuj ponownie (AI)' : 'Oceń zgodność (AI)'}
              </button>
            )}
            {canDelete && (
              <form method="post" action={`/zgloszenia/${e.id}/usun`} class="inline-form" data-confirm="Na pewno usunąć ten projekt?">
                <button type="submit" class="btn danger small">
                  Usuń
                </button>
              </form>
            )}
          </div>
          <p class="status-line small" role="status" data-ai-status={e.id}></p>
        </div>
      </div>
    </article>
  );
};

const Leaderboard = ({
  contest,
  rows,
  me,
  manager,
  visits,
  hosts,
}: {
  contest: Contest;
  rows: LeaderRow[];
  me: number;
  manager: boolean;
  visits: { id: number; guest_name: string; visit_date: string | null; host: string }[];
  hosts: { id: number; name: string }[];
}) => {
  const s = contest.settings;
  const max = Math.max(1, ...rows.map((r) => r.guests));
  return (
    <section class="section tight">
      <div class="wrap mid stack" style="--gap:28px">
        {(s.period_start || s.period_end) && (
          <p class="callout blue" style="margin:0">
            Okres konkursu: <strong>{s.period_start ? `od ${fmtDay(s.period_start)}` : ''}{s.period_end ? ` do ${fmtDay(s.period_end)}` : ''}</strong>
          </p>
        )}
        <div class="card">
          <h2>Ranking</h2>
          {rows.length === 0 ? (
            <p class="empty-note">Jeszcze nikt nie przyprowadził gościa. Może to będziesz Ty?</p>
          ) : (
            <ol class="results">
              {rows.map((r) => (
                <li class={r.user_id === me ? 'me' : undefined}>
                  <span class="place" aria-label={`Miejsce ${r.rank}`}>
                    {r.rank}
                  </span>
                  <span class="name">
                    <span>
                      {r.name}
                      {r.user_id === me ? ' (Ty)' : ''}
                    </span>
                    <small>
                      {r.guests} {plural(r.guests, 'gość', 'gości', 'gości')}
                    </small>
                  </span>
                  <span class="bar" aria-hidden="true">
                    <i style={`width:${Math.round((r.guests / max) * 100)}%`}></i>
                  </span>
                </li>
              ))}
            </ol>
          )}
          <p class="muted small" style="margin:14px 0 0">Ranking aktualizuje zarząd klubu na podstawie listy gości ze spotkań.</p>
        </div>

        {manager && (
          <div class="card stack" style="--gap:18px">
            <h2 style="margin:0">
              Dodaj gościa <span class="pill">dla zarządzających</span>
            </h2>
            <form class="form" method="post" action={`/konkursy/${contest.slug}/goscie`}>
              <label for="host">
                Kto przyprowadził
                <select id="host" name="user_id" required>
                  <option value="">Wybierz osobę</option>
                  {hosts.map((h) => (
                    <option value={String(h.id)}>{h.name}</option>
                  ))}
                </select>
              </label>
              <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;align-items:end">
                <label for="guest-name">
                  Imię gościa <span class="hint">opcjonalnie, widzą tylko zarządzający</span>
                  <input type="text" id="guest-name" name="guest_name" maxlength={80} autocomplete="off" />
                </label>
                <label for="visit-date">
                  Data spotkania <span class="hint">opcjonalnie</span>
                  <input type="date" id="visit-date" name="visit_date" min={s.period_start} max={s.period_end} />
                </label>
              </div>
              <label class="check">
                <input type="checkbox" name="confirm" value="1" required />
                <span>Gość jest u nas pierwszy raz od co najmniej pół roku i powiedział, od kogo przyszedł.</span>
              </label>
              <button class="btn" type="submit" style="justify-self:start">
                Dodaj gościa
              </button>
            </form>
            {visits.length > 0 && (
              <div class="table-wrapper" tabindex={0} role="region" aria-labelledby="visits-cap">
                <table class="data">
                  <caption id="visits-cap">Zapisani goście ({visits.length})</caption>
                  <thead>
                    <tr>
                      <th>Przyprowadził(a)</th>
                      <th>Gość</th>
                      <th>Data</th>
                      <th>Akcje</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visits.map((v) => (
                      <tr>
                        <th>{v.host}</th>
                        <td data-label="Gość">{v.guest_name || '-'}</td>
                        <td data-label="Data">{fmtDay(v.visit_date) || '-'}</td>
                        <td class="actions-cell">
                          <form method="post" action={`/konkursy/${contest.slug}/goscie/${v.id}/usun`} class="inline-form" data-confirm="Usunąć ten wpis?">
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
        )}
      </div>
    </section>
  );
};

member.post('/konkursy/:slug/goscie', async (c) => {
  const user = c.var.user!;
  const db = c.env.DB;
  const contest = await getContest(db, c.req.param('slug'));
  if (!contest || contest.kind !== 'leaderboard') return c.notFound();
  if (!(await canManage(db, user, contest.id))) return c.text('Brak dostępu.', 403);
  const f = await c.req.parseBody();
  const host = await db.prepare('SELECT id, name, email FROM users WHERE id = ? AND active = 1').bind(Number(f.user_id)).first<{ id: number; name: string; email: string }>();
  if (!host || !f.confirm) {
    setFlash(c, 'err', 'Wybierz osobę i potwierdź, że gość spełnia warunki konkursu.');
    return c.redirect(`/konkursy/${contest.slug}`);
  }
  const guest = String(f.guest_name ?? '').trim().slice(0, 80);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(f.visit_date ?? '')) ? String(f.visit_date) : null;
  await db
    .prepare('INSERT INTO guest_visits (contest_id, user_id, guest_name, visit_date, added_by, created_at) VALUES (?, ?, ?, ?, ?, unixepoch())')
    .bind(contest.id, host.id, guest, date, user.id)
    .run();
  setFlash(c, 'ok', `Dodano gościa dla: ${host.name || host.email}.`);
  return c.redirect(`/konkursy/${contest.slug}`);
});

member.post('/konkursy/:slug/goscie/:id/usun', async (c) => {
  const db = c.env.DB;
  const contest = await getContest(db, c.req.param('slug'));
  if (!contest || contest.kind !== 'leaderboard') return c.notFound();
  if (!(await canManage(db, c.var.user!, contest.id))) return c.text('Brak dostępu.', 403);
  await db.prepare('DELETE FROM guest_visits WHERE id = ? AND contest_id = ?').bind(Number(c.req.param('id')), contest.id).run();
  setFlash(c, 'ok', 'Usunięto wpis.');
  return c.redirect(`/konkursy/${contest.slug}`);
});

/** Dokąd wrócić po dodaniu/usunięciu uwag: do karty w widoku opiekuna albo we własnych zgłoszeniach */
const backTo = (slug: string, prefix: unknown, entryId: number) =>
  `/konkursy/${slug}#${prefix === 'entry' ? 'entry' : 'all-entry'}-${entryId}`;

type ReviewEntry = { id: number; title: string; author_id: number | null; email: string | null; name: string | null; active: number | null };

/** Konkurs i zgłoszenie dla uwag opiekuna (zapis i podgląd maila); null = nie ma, 'denied' = brak uprawnień */
async function reviewTarget(c: Context<AppEnv>): Promise<{ contest: Contest; entry: ReviewEntry } | null | 'denied'> {
  const db = c.env.DB;
  const contest = await getContest(db, c.req.param('slug') ?? '');
  if (!contest || contest.kind !== 'rollup') return null;
  if (!(await canManage(db, c.var.user!, contest.id))) return 'denied';
  const entry = await db
    .prepare(
      `SELECT e.id, e.title, e.author_id, u.email, u.name, u.active FROM entries e LEFT JOIN users u ON u.id = e.author_id
       WHERE e.id = ? AND e.contest_id = ?`,
    )
    .bind(Number(c.req.param('id')), contest.id)
    .first<ReviewEntry>();
  return entry ? { contest, entry } : null;
}

function reviewInput(f: Record<string, unknown>): { verdict: ReviewVerdict | null; comment: string; notify: boolean } {
  return {
    verdict: isReviewVerdict(f.verdict) ? f.verdict : null,
    comment: String(f.comment ?? '')
      .replace(/\r\n/g, '\n')
      .trim()
      .slice(0, 3000),
    notify: Boolean(f.notify),
  };
}

/** Mail z uwagami: ta sama funkcja dla wysyłki i podglądu. null = autor nie dostanie maila (brak konta, nieaktywny, sam sobie). */
function reviewMessage(c: Context<AppEnv>, contest: Contest, entry: ReviewEntry, verdict: ReviewVerdict | null, comment: string) {
  const user = c.var.user!;
  if (!entry.email || !entry.active || entry.author_id === user.id) return null;
  const link = `${new URL(c.req.url).origin}/konkursy/${contest.slug}#entry-${entry.id}`;
  return { to: entry.email, toName: entry.name ?? undefined, ...reviewMail(entry.title, verdict ? REVIEW_VERDICTS[verdict].text : null, comment, user.name || user.email, link) };
}

member.post('/konkursy/:slug/zgloszenia/:id/uwagi/podglad', async (c) => {
  const target = await reviewTarget(c);
  if (target === 'denied') return c.json({ ok: false, error: 'Brak dostępu.' }, 403);
  if (!target) return c.json({ ok: false, error: 'Nie ma takiego zgłoszenia.' }, 404);
  const { verdict, comment, notify } = reviewInput(await c.req.parseBody());
  const msg = notify && (comment || verdict) ? reviewMessage(c, target.contest, target.entry, verdict, comment) : null;
  // bez maila (albo z błędem w formularzu): zwykły zapis, komunikat pokaże strona
  if (!msg) return c.json({ ok: true, skip: true });
  return c.json({
    ok: true,
    to: msg.toName ? `${msg.toName} <${msg.to}>` : msg.to,
    subject: msg.subject,
    html: msg.html,
    note: 'Tak będzie wyglądał mail do autora. Uwagi zapiszą się też przy projekcie.',
    okLabel: 'Zapisz i wyślij maila',
  });
});

member.post('/konkursy/:slug/zgloszenia/:id/uwagi', async (c) => {
  const user = c.var.user!;
  const db = c.env.DB;
  const target = await reviewTarget(c);
  if (target === 'denied') return c.text('Brak dostępu.', 403);
  if (!target) return c.notFound();
  const { contest, entry } = target;
  const f = await c.req.parseBody();
  const back = backTo(contest.slug, f.back, entry.id);
  const { verdict, comment, notify } = reviewInput(f);
  if (!comment && !verdict) {
    setFlash(c, 'err', 'Wpisz uwagi albo wybierz ocenę.');
    return c.redirect(back);
  }
  const { meta } = await db
    .prepare('INSERT INTO entry_reviews (entry_id, author_id, verdict, comment, created_at) VALUES (?, ?, ?, ?, unixepoch())')
    .bind(entry.id, user.id, verdict, comment)
    .run();

  let note = '';
  let mailFailed = false;
  const msg = notify ? reviewMessage(c, contest, entry, verdict, comment) : null;
  if (msg) {
    const r = await sendMail(c.env, msg);
    if (r.sent) {
      await db.prepare('UPDATE entry_reviews SET mailed = 1 WHERE id = ?').bind(meta.last_row_id).run();
      note = ' Autor dostał maila.';
    } else if (r.mode === 'off') note = ' Wysyłka maili jest wyłączona, więc autor zobaczy uwagi tylko na stronie.';
    else {
      mailFailed = true;
      note = ` Mail do autora nie poszedł: ${r.error ?? 'nieznany błąd'}. Uwagi i tak widać przy projekcie.`;
    }
  }
  setFlash(c, mailFailed ? 'info' : 'ok', `Zapisano uwagi do „${entry.title}”.${note}`);
  return c.redirect(back);
});

member.post('/konkursy/:slug/uwagi/:id/usun', async (c) => {
  const db = c.env.DB;
  const contest = await getContest(db, c.req.param('slug'));
  if (!contest || contest.kind !== 'rollup') return c.notFound();
  if (!(await canManage(db, c.var.user!, contest.id))) return c.text('Brak dostępu.', 403);
  const row = await db
    .prepare('SELECT r.entry_id FROM entry_reviews r JOIN entries e ON e.id = r.entry_id WHERE r.id = ? AND e.contest_id = ?')
    .bind(Number(c.req.param('id')), contest.id)
    .first<{ entry_id: number }>();
  if (!row) return c.notFound();
  await db.prepare('DELETE FROM entry_reviews WHERE id = ?').bind(Number(c.req.param('id'))).run();
  const f = await c.req.parseBody();
  setFlash(c, 'ok', 'Usunięto uwagi.');
  return c.redirect(backTo(contest.slug, f.back, row.entry_id));
});

member.post('/konkursy/:slug/opinia', async (c) => {
  const user = c.var.user!;
  const contest = await getContest(c.env.DB, c.req.param('slug'));
  if (!contest || contest.phase !== 'voting') return c.notFound();
  const f = await c.req.parseBody();
  const preferred = String(f.preferred ?? '');
  if (!isMethod(preferred) || !contest.methods.includes(preferred as MethodId)) {
    setFlash(c, 'err', 'Wybierz jeden ze sposobów głosowania.');
    return c.redirect(`/konkursy/${contest.slug}`);
  }
  const comment = String(f.comment ?? '').slice(0, 1000);
  await c.env.DB.prepare(
    `INSERT INTO method_feedback (contest_id, user_id, preferred, comment, updated_at) VALUES (?, ?, ?, ?, unixepoch())
     ON CONFLICT(contest_id, user_id) DO UPDATE SET preferred = excluded.preferred, comment = excluded.comment, updated_at = excluded.updated_at`,
  )
    .bind(contest.id, user.id, preferred, comment)
    .run();
  setFlash(c, 'ok', 'Dzięki! Zapisaliśmy Twoją opinię.');
  return c.redirect(`/konkursy/${contest.slug}`);
});

/** Koniec podglądu jako członek: wracamy na tę samą stronę, już w widoku admina */
member.post('/podglad/koniec', (c) => {
  setPreview(c, false);
  return c.redirect(refererPath(c, '/admin'));
});

member.get('/konto', (c) => {
  const user = c.var.user!;
  return c.html(
    <Layout title="Moje konto" user={user} flash={takeFlash(c)} scripts={['/js/app.js']} nav="account">
      <PageHead title="Moje konto" lead={user.email} />
      <section class="section tight">
        <div class="wrap narrow stack" style="--gap:24px">
          <form class="form card" method="post" action="/konto">
            <h2 style="margin:0">Dane</h2>
            <label for="name">
              Imię i nazwisko
              <input type="text" id="name" name="name" value={user.name} autocomplete="name" maxlength={80} />
            </label>
            <button class="btn" type="submit" style="justify-self:start">
              Zapisz
            </button>
          </form>
          <form class="form card" method="post" action="/konto/haslo">
            <h2 style="margin:0">{user.password_hash ? 'Zmień hasło' : 'Ustaw hasło'}</h2>
            <p class="hint" style="margin:0">
              {user.password_hash
                ? 'Po zmianie hasła wylogujemy Cię na innych urządzeniach.'
                : 'Na razie logujesz się linkami z maila. Ustaw hasło, jeśli wolisz logować się hasłem.'}
            </p>
            <input type="email" name="email" value={user.email} autocomplete="username" hidden readonly />
            <label for="new-password">
              Nowe hasło <span class="hint">co najmniej {MIN_PASSWORD} znaków</span>
              <PasswordInput id="new-password" name="password" autocomplete="new-password" minlength={MIN_PASSWORD} />
            </label>
            <button class="btn" type="submit" style="justify-self:start">
              {user.password_hash ? 'Zmień hasło' : 'Ustaw hasło'}
            </button>
          </form>
          <form method="post" action="/wyloguj">
            <button class="btn ghost" type="submit">
              Wyloguj się
            </button>
          </form>
        </div>
      </section>
    </Layout>,
  );
});

member.post('/konto', async (c) => {
  const f = await c.req.parseBody();
  const name = String(f.name ?? '').trim().slice(0, 80);
  await c.env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(name, c.var.user!.id).run();
  setFlash(c, 'ok', 'Zapisano.');
  return c.redirect('/konto');
});

member.post('/konto/haslo', async (c) => {
  const user = c.var.user!;
  const f = await c.req.parseBody();
  const password = String(f.password ?? '');
  const problem = passwordProblem(password);
  if (problem) {
    setFlash(c, 'err', problem);
    return c.redirect('/konto');
  }
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(password), user.id),
    // wyloguj inne urządzenia, zostaw bieżącą sesję
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').bind(user.id, c.var.sessionHash ?? ''),
  ]);
  setFlash(c, 'ok', 'Hasło zapisane.');
  return c.redirect('/konto');
});
