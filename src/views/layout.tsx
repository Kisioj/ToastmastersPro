import type { Child, FC } from 'hono/jsx';
import { raw } from 'hono/html';
import type { User } from '../env';
import type { Flash } from '../lib/flash';
import { jsonForScript } from '../lib/util';
import type { Tally } from '../lib/voting';
import { METHODS } from '../lib/voting';
import { PHASES } from '../lib/contests';

/** Zmień przy zmianach w /public, żeby przeglądarki pobrały nowe pliki */
export const ASSET_V = '7';

interface LayoutProps {
  title: string;
  user: User | null;
  flash?: Flash | null;
  scripts?: string[];
  nav?: 'home' | 'admin' | 'account';
  children?: Child;
}

export const Layout: FC<LayoutProps> = ({ title, user, flash, scripts = [], nav, children }) => (
  <html lang="pl">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex, nofollow" />
      <meta name="theme-color" content="#004165" />
      <title>{`${title} · Strefa członka · Toastmasters Częstochowa`}</title>
      <link rel="icon" href="/favicon.png" type="image/png" />
      <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      <link rel="stylesheet" href={`/css/app.css?v=${ASSET_V}`} />
    </head>
    <body>
      <a class="skip" href="#tresc">
        Przejdź do treści
      </a>
      <header class="top">
        <div class="wrap">
          <a class="brand" href="/" aria-label="Strefa członka, strona główna">
            <img src="/img/logo.webp" width="340" height="74" alt="Toastmasters Częstochowa" />
          </a>
          <span class="zone">Strefa członka</span>
          {user && (
            <nav class="nav" aria-label="Menu">
              <a href="/" aria-current={nav === 'home' ? 'page' : undefined}>
                Konkursy
              </a>
              {user.role === 'admin' && (
                <a href="/admin" aria-current={nav === 'admin' ? 'page' : undefined}>
                  Panel admina
                </a>
              )}
              <a href="/konto" aria-current={nav === 'account' ? 'page' : undefined}>
                Moje konto
              </a>
            </nav>
          )}
        </div>
      </header>
      <main id="tresc">
        {flash && (
          <div class="wrap">
            <p class={`flash ${flash.type}`} role={flash.type === 'err' ? 'alert' : 'status'}>
              {flash.msg}
            </p>
          </div>
        )}
        {children}
      </main>
      <footer class="foot">
        <div class="wrap">
          <p style="margin:0">
            <a href="https://toastmasters.czest.pl/">toastmasters.czest.pl</a> · Klub Toastmasters Częstochowa · kontakt:{' '}
            <a href="mailto:toastmastersczwa@gmail.com">toastmastersczwa@gmail.com</a>
          </p>
          <p class="disclaimer" lang="en">
            The information on this website is for the sole use of Toastmasters’ members, for Toastmasters business only. It is not to be used for
            solicitation and distribution of non-Toastmasters material or information.
          </p>
        </div>
      </footer>
      {scripts.map((s) => (
        <script type="module" src={`${s}?v=${ASSET_V}`}></script>
      ))}
    </body>
  </html>
);

export const PageHead: FC<{ eyebrow?: string; title: string; lead?: string; children?: Child }> = ({ eyebrow, title, lead, children }) => (
  <section class="page-head">
    <div class="wrap">
      {eyebrow && <p class="eyebrow">{eyebrow}</p>}
      <h1>{title}</h1>
      {lead && <p class="lead">{lead}</p>}
      {children}
    </div>
  </section>
);

/** Ranking (np. goście) nie ma zgłoszeń ani głosowania — po prostu „trwa” */
export const PhasePill: FC<{ phase: keyof typeof PHASES; kind?: string }> = ({ phase, kind }) => (
  <span class={`pill ${phase}`}>
    {phase === 'draft' ? 'Szkic' : kind === 'leaderboard' && phase !== 'closed' ? 'Trwa' : PHASES[phase]}
  </span>
);

/** Dane dla skryptów: <script type="application/json"> */
export const JsonData: FC<{ id: string; data: unknown }> = ({ id, data }) => (
  <script type="application/json" id={id}>
    {raw(jsonForScript(data))}
  </script>
);

export const ResultsList: FC<{ tally: Tally; showMethod?: boolean }> = ({ tally, showMethod }) => (
  <div>
    {showMethod && <h3>{METHODS[tally.method].name}</h3>}
    <p class="muted small">
      Głosujących: <strong>{tally.voters}</strong>
    </p>
    {tally.voters === 0 ? (
      <p class="empty-note">Nikt jeszcze nie zagłosował tym sposobem.</p>
    ) : (
      <ol class="results">
        {tally.rows.map((r) => (
          <li>
            <span class="place" aria-label={`Miejsce ${r.rank}`}>
              {r.rank}
            </span>
            <span class="name">
              <span>{r.title}</span>
              <small>{r.label}</small>
            </span>
            <span class="bar" aria-hidden="true">
              <i style={`width:${Math.round(r.bar * 100)}%`}></i>
            </span>
          </li>
        ))}
      </ol>
    )}
    {tally.notes.length > 0 && (
      <ul class="res-notes">
        {tally.notes.map((n) => (
          <li>{n}</li>
        ))}
      </ul>
    )}
  </div>
);

export const PasswordInput: FC<{ id: string; name: string; autocomplete: string; minlength?: number }> = ({ id, name, autocomplete, minlength }) => (
  <span class="pw-field">
    <input type="password" id={id} name={name} autocomplete={autocomplete} required minlength={minlength} enterkeyhint="done" />
    <button type="button" class="pw-toggle" data-pw-toggle={id} aria-pressed="false">
      Pokaż
    </button>
  </span>
);

/** Przycisk kopiowania z dymkiem, który jest jednocześnie regionem role=status */
export const CopyButton: FC<{ target: string; label: string }> = ({ target, label }) => (
  <span class="copy">
    <button type="button" class="btn ghost small" command="--copy" commandfor={target} aria-label={label}>
      Kopiuj
    </button>
    <span class="bubble" role="status"></span>
  </span>
);
