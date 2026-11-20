import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv, User } from '../env';
import { consumeToken, createSession, createToken, destroySession, linkFor, peekToken, safeNext } from '../lib/auth';
import { setFlash, takeFlash } from '../lib/flash';
import { loginMail, sendMail } from '../lib/mail';
import { hashPassword, MIN_PASSWORD, passwordProblem, verifyPassword } from '../lib/password';
import { EMAIL_RE, normEmail, now } from '../lib/util';
import { Layout, PageHead, PasswordInput } from '../views/layout';

export const auth = new Hono<AppEnv>();

const isLocal = (c: Context) => ['localhost', '127.0.0.1'].includes(new URL(c.req.url).hostname);
const MAX_FAILS = 10;
const FAIL_WINDOW = 15 * 60;

auth.get('/logowanie', (c) => {
  const next = safeNext(c.req.query('next'));
  if (c.var.user) return c.redirect(next);
  const email = c.req.query('email') ?? '';
  return c.html(
    <Layout title="Logowanie" user={null} flash={takeFlash(c)} scripts={['/js/app.js']}>
      <section class="section">
        <div class="wrap narrow">
          <h1>Zaloguj się</h1>
          <p class="muted">Strefa dla członków klubu Toastmasters Częstochowa.</p>
          <form class="form card raised" method="post" action="/logowanie">
            <input type="hidden" name="next" value={next} />
            <label for="email">
              E-mail
              <input type="email" id="email" name="email" value={email} autocomplete="username" spellcheck={false} required enterkeyhint="next" />
            </label>
            <label for="current-password">
              Hasło
              <PasswordInput id="current-password" name="password" autocomplete="current-password" />
            </label>
            <button class="btn" type="submit">
              Zaloguj się
            </button>
            <p class="or">albo bez hasła</p>
            <button class="btn ghost" type="submit" formaction="/logowanie/link" formnovalidate>
              Wyślij mi link do logowania
            </button>
            <p class="hint">Link przyjdzie na podany adres e-mail i będzie ważny 20 minut. Nie pamiętasz hasła? Zaloguj się linkiem, a potem ustaw nowe w „Moje konto”.</p>
          </form>
          <p class="muted small" style="margin-top:20px">
            Nie masz dostępu? Napisz do zarządu klubu: <a href="mailto:toastmastersczwa@gmail.com">toastmastersczwa@gmail.com</a>.
          </p>
        </div>
      </section>
    </Layout>,
  );
});

auth.post('/logowanie', async (c) => {
  const f = await c.req.parseBody();
  const email = normEmail(String(f.email ?? ''));
  const password = String(f.password ?? '');
  const next = safeNext(String(f.next ?? ''));
  const back = `/logowanie?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`;
  const db = c.env.DB;

  const fails = await db
    .prepare('SELECT COUNT(*) AS n FROM login_failures WHERE email = ? AND at > ?')
    .bind(email, now() - FAIL_WINDOW)
    .first<{ n: number }>();
  if ((fails?.n ?? 0) >= MAX_FAILS) {
    setFlash(c, 'err', 'Za dużo nieudanych prób. Odczekaj kwadrans albo zaloguj się linkiem z maila.');
    return c.redirect(back);
  }

  const user = await db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').bind(email).first<User>();
  if (user && !user.password_hash) {
    setFlash(c, 'info', 'To konto nie ma jeszcze hasła. Użyj linku z zaproszenia albo kliknij „Wyślij mi link do logowania”.');
    return c.redirect(back);
  }
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    await db.prepare('INSERT INTO login_failures (email, at) VALUES (?, ?)').bind(email, now()).run();
    setFlash(c, 'err', 'Nieprawidłowy e-mail lub hasło.');
    return c.redirect(back);
  }
  await db.prepare('DELETE FROM login_failures WHERE email = ? OR at < ?').bind(email, now() - FAIL_WINDOW).run();
  await createSession(c, user.id);
  return c.redirect(next);
});

auth.post('/logowanie/link', async (c) => {
  const f = await c.req.parseBody();
  const email = normEmail(String(f.email ?? ''));
  if (!EMAIL_RE.test(email)) {
    setFlash(c, 'err', 'Wpisz poprawny adres e-mail, na który mamy wysłać link.');
    return c.redirect(`/logowanie?email=${encodeURIComponent(email)}`);
  }
  const db = c.env.DB;
  const user = await db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').bind(email).first<User>();
  let devLink: string | null = null;
  let mailOff = false;
  if (user) {
    const recent = await db
      .prepare("SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND purpose = 'login' AND created_at > ?")
      .bind(user.id, now() - 10 * 60)
      .first<{ n: number }>();
    if ((recent?.n ?? 0) < 3) {
      const token = await createToken(db, user.id, 'login');
      const link = linkFor(c, 'login', token);
      const res = await sendMail(c.env, { to: user.email, toName: user.name, ...loginMail(link) });
      mailOff = res.mode === 'off';
      if (mailOff && isLocal(c)) devLink = link;
    }
  }
  return c.html(
    <Layout title="Sprawdź skrzynkę" user={null}>
      <section class="section">
        <div class="wrap narrow stack">
          <h1>Sprawdź skrzynkę</h1>
          <p>
            Jeśli <strong>{email}</strong> jest na liście członków, wysłaliśmy tam link do logowania. Link jest ważny 20 minut i działa jeden raz.
          </p>
          <p class="muted">Nie widzisz maila? Zajrzyj do folderu „Spam” lub „Oferty”.</p>
          {mailOff && !devLink && (
            <p class="callout">Wysyłka maili nie jest jeszcze skonfigurowana — poproś admina o link do logowania.</p>
          )}
          {devLink && (
            <p class="callout blue">
              Tryb lokalny (bez SMTP): <a href={devLink}>zaloguj się tym linkiem</a>
            </p>
          )}
          <p>
            <a href="/logowanie">← Wróć do logowania</a>
          </p>
        </div>
      </section>
    </Layout>,
  );
});

const invalidLink = (c: Context<AppEnv>, what: string) =>
  c.html(
    <Layout title="Link nieaktywny" user={c.var.user}>
      <section class="section">
        <div class="wrap narrow stack">
          <h1>Ten link już nie działa</h1>
          <p>
            {what} jest jednorazowy i ma ograniczoną ważność. Mógł wygasnąć albo został już użyty (czasem programy pocztowe „sprawdzają” linki
            za Ciebie).
          </p>
          <p>
            <a class="btn" href="/logowanie">
              Przejdź do logowania
            </a>
          </p>
          <p class="muted">Na stronie logowania możesz poprosić o nowy link na maila.</p>
        </div>
      </section>
    </Layout>,
    410,
  );

// GET tylko pokazuje przycisk — dzięki temu skanery linków w poczcie nie „zużyją” tokenu
auth.get('/zaloguj/:token', async (c) => {
  const user = await peekToken(c.env.DB, c.req.param('token'), 'login');
  if (!user) return invalidLink(c, 'Link do logowania');
  return c.html(
    <Layout title="Logowanie" user={null}>
      <section class="section">
        <div class="wrap narrow">
          <form class="form card raised" method="post">
            <h1 style="margin:0">Logowanie</h1>
            <p style="margin:0">
              Zalogujesz się jako <strong>{user.email}</strong>.
            </p>
            <button class="btn" type="submit">
              Zaloguj się
            </button>
          </form>
        </div>
      </section>
    </Layout>,
  );
});

auth.post('/zaloguj/:token', async (c) => {
  const user = await consumeToken(c.env.DB, c.req.param('token'), 'login');
  if (!user) return invalidLink(c, 'Link do logowania');
  await createSession(c, user.id);
  setFlash(c, 'ok', `Zalogowano jako ${user.email}.`);
  return c.redirect('/');
});

const setPasswordPage = (c: Context<AppEnv>, user: User, error?: string) =>
  c.html(
    <Layout title="Ustaw hasło" user={null} scripts={['/js/app.js']}>
      <section class="section">
        <div class="wrap narrow">
          <form class="form card raised" method="post">
            <h1 style="margin:0">{user.password_hash ? 'Ustaw nowe hasło' : 'Witaj w strefie członka!'}</h1>
            <p style="margin:0">Ustaw hasło do konta. Później możesz logować się hasłem albo samym mailem (link do logowania).</p>
            {error && (
              <p class="flash err" role="alert">
                {error}
              </p>
            )}
            <label for="email">
              E-mail
              <input type="email" id="email" name="email" value={user.email} autocomplete="username" readonly />
            </label>
            <label for="new-password">
              Nowe hasło <span class="hint">co najmniej {MIN_PASSWORD} znaków</span>
              <PasswordInput id="new-password" name="password" autocomplete="new-password" minlength={MIN_PASSWORD} />
            </label>
            <button class="btn" type="submit">
              Ustaw hasło i zaloguj się
            </button>
          </form>
        </div>
      </section>
    </Layout>,
    error ? 400 : 200,
  );

auth.get('/ustaw-haslo/:token', async (c) => {
  const user = await peekToken(c.env.DB, c.req.param('token'), 'set_password');
  if (!user) return invalidLink(c, 'Link do ustawienia hasła');
  return setPasswordPage(c, user);
});

auth.post('/ustaw-haslo/:token', async (c) => {
  const token = c.req.param('token');
  const user = await peekToken(c.env.DB, token, 'set_password');
  if (!user) return invalidLink(c, 'Link do ustawienia hasła');
  const f = await c.req.parseBody();
  const password = String(f.password ?? '');
  const problem = passwordProblem(password);
  if (problem) return setPasswordPage(c, user, problem);
  const consumed = await consumeToken(c.env.DB, token, 'set_password');
  if (!consumed) return invalidLink(c, 'Link do ustawienia hasła');
  await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(password), consumed.id).run();
  // zmiana hasła wylogowuje inne urządzenia
  await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(consumed.id).run();
  await createSession(c, consumed.id);
  setFlash(c, 'ok', 'Hasło ustawione. Witaj w strefie członka!');
  return c.redirect('/');
});

auth.post('/wyloguj', async (c) => {
  await destroySession(c);
  setFlash(c, 'ok', 'Wylogowano.');
  return c.redirect('/logowanie');
});
