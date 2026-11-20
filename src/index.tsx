import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv } from './env';
import { loadUser, sameOrigin } from './lib/auth';
import { admin } from './routes/admin';
import { api } from './routes/api';
import { auth } from './routes/auth';
import { member } from './routes/member';
import { Layout } from './views/layout';

const app = new Hono<AppEnv>();

app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      // pdf.js używa WebAssembly do dekodowania niektórych obrazów w PDF
      scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      workerSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
    },
    referrerPolicy: 'same-origin',
  }),
);
// www.* i *.workers.dev → CANONICAL_HOST (jeden adres = jedna sesja i spójne linki w mailach).
// Tylko GET/HEAD — formularz wysłany z otwartej starej karty nadal zadziała.
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const canonical = c.env.CANONICAL_HOST;
  const offHost = url.hostname.startsWith('www.') || (canonical && url.hostname.endsWith('.workers.dev'));
  if (offHost && ['GET', 'HEAD'].includes(c.req.method)) {
    url.hostname = url.hostname.startsWith('www.') && !canonical ? url.hostname.slice(4) : canonical!;
    url.protocol = 'https:';
    url.port = '';
    return c.redirect(url.toString(), 301);
  }
  await next();
});
app.use('*', sameOrigin);
app.use('*', loadUser);

app.route('/', auth);

// wszystko poniżej wymaga zalogowania
app.use('*', async (c, next) => {
  if (!c.var.user) {
    if (c.req.path.startsWith('/api/')) return c.json({ ok: false, error: 'Sesja wygasła. Zaloguj się ponownie.' }, 401);
    const next_ = c.req.method === 'GET' ? `?next=${encodeURIComponent(c.req.path)}` : '';
    return c.redirect(`/logowanie${next_}`);
  }
  await next();
});

app.route('/', member);
app.route('/', api);
app.route('/admin', admin);

app.notFound((c) =>
  c.html(
    <Layout title="Nie znaleziono" user={c.var.user ?? null}>
      <section class="section">
        <div class="wrap narrow stack">
          <h1>Nie ma takiej strony</h1>
          <p>
            <a class="btn" href="/">
              Wróć do strony głównej
            </a>
          </p>
        </div>
      </section>
    </Layout>,
    404,
  ),
);

app.onError((err, c) => {
  console.error(err);
  if (c.req.path.startsWith('/api/')) return c.json({ ok: false, error: 'Błąd serwera. Spróbuj ponownie.' }, 500);
  return c.html(
    <Layout title="Błąd" user={c.var.user ?? null}>
      <section class="section">
        <div class="wrap narrow stack">
          <h1>Coś poszło nie tak</h1>
          <p>Spróbuj odświeżyć stronę. Jeśli błąd się powtarza, daj znać adminowi.</p>
        </div>
      </section>
    </Layout>,
    500,
  );
});

export default app;
