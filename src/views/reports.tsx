import type { FC } from 'hono/jsx';
import type { AiReview } from '../lib/ai';
import { fmtDate } from '../lib/util';

/** Raport techniczny liczony w przeglądarce (dane od klienta — wyświetlamy tylko przez JSX, z limitami) */
export interface TechReport {
  verdict?: 'ok' | 'warn' | 'err';
  summary?: string;
  checks?: { level: 'ok' | 'warn' | 'err' | 'info'; title: string; detail?: string }[];
  colors?: { hex: string; share: number; brand?: string | null }[];
  brandShare?: number;
}

const ICON = { ok: '✓', warn: '!', err: '✕', info: 'i', uwaga: '!', blad: '✕' } as const;
const LEVEL_TEXT = { ok: 'OK', warn: 'Uwaga', err: 'Błąd', info: 'Info', uwaga: 'Uwaga', blad: 'Błąd' } as const;

export const VERDICT_TECH = {
  ok: { cls: 'ok', text: 'Technicznie OK' },
  warn: { cls: 'warn', text: 'Technicznie: są uwagi' },
  err: { cls: 'err', text: 'Technicznie: nie nadaje się do druku' },
} as const;

export const VERDICT_AI = {
  zgodny: { cls: 'ok', text: 'Zgodny z brand manualem' },
  drobne_poprawki: { cls: 'warn', text: 'Drobne poprawki' },
  wymaga_zmian: { cls: 'err', text: 'Wymaga zmian' },
} as const;

export const TechReportView: FC<{ report: TechReport | null }> = ({ report }) => {
  if (!report?.checks?.length) return <p class="muted">Brak raportu technicznego.</p>;
  const v = VERDICT_TECH[report.verdict ?? 'warn'] ?? VERDICT_TECH.warn;
  return (
    <div class="stack" style="--gap:10px">
      <p class="row" style="margin:0">
        <span class={`pill ${v.cls}`}>{v.text}</span>
        {report.summary && <span class="muted small">{String(report.summary).slice(0, 300)}</span>}
      </p>
      <ul class="checks">
        {report.checks.slice(0, 20).map((ch) => {
          const lvl = (['ok', 'warn', 'err', 'info'] as const).includes(ch.level) ? ch.level : 'info';
          return (
            <li class={lvl}>
              <span class="ico" aria-hidden="true">
                {ICON[lvl]}
              </span>
              <b>
                <span class="visually-hidden">{LEVEL_TEXT[lvl]}: </span>
                {String(ch.title).slice(0, 120)}
              </b>
              {ch.detail && <span>{String(ch.detail).slice(0, 400)}</span>}
            </li>
          );
        })}
      </ul>
      {report.colors && report.colors.length > 0 && (
        <div>
          <p class="small" style="margin:0">
            <b>Dominujące kolory</b>
            {typeof report.brandShare === 'number' && <span class="muted"> · w kolorach marki: {Math.round(report.brandShare * 100)}% powierzchni</span>}
          </p>
          <div class="swatches">
            {report.colors.slice(0, 8).map((col) =>
              /^#[0-9a-f]{6}$/i.test(col.hex) ? (
                <span class="swatch">
                  <i style={`background:${col.hex}`}></i>
                  {col.hex} · {Math.round(col.share * 100)}%{col.brand ? ` · ${String(col.brand).slice(0, 30)}` : ''}
                </span>
              ) : null,
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export const AiReviewView: FC<{ review: AiReview | null; error?: string | null }> = ({ review, error }) => {
  if (error) return <p class="flash err">{error}</p>;
  if (!review) return <p class="muted">Ocena AI jeszcze nie została wykonana.</p>;
  const v = VERDICT_AI[review.verdict] ?? VERDICT_AI.drobne_poprawki;
  return (
    <div class="stack" style="--gap:10px">
      <div class="verdict">
        <span class="score" aria-label={`Ocena ${review.score} na 100`}>
          {review.score}
        </span>
        <div>
          <span class={`pill ${v.cls}`}>{v.text}</span>
          <p class="muted small" style="margin:4px 0 0">
            {review.provider === 'claude' ? 'Claude' : 'Workers AI'} · {fmtDate(review.created_at)}
          </p>
        </div>
      </div>
      {review.summary && <p style="margin:0">{review.summary}</p>}
      <ul class="checks">
        {review.checks.map((ch) => (
          <li class={ch.status}>
            <span class="ico" aria-hidden="true">
              {ICON[ch.status] ?? 'i'}
            </span>
            <b>
              <span class="visually-hidden">{LEVEL_TEXT[ch.status] ?? ''}: </span>
              {ch.area}
            </b>
            <span>{ch.comment}</span>
          </li>
        ))}
      </ul>
      {review.suggestions.length > 0 && (
        <div>
          <p class="small" style="margin:0 0 4px">
            <b>Co poprawić</b>
          </p>
          <ol style="margin:0;padding-left:1.3em">
            {review.suggestions.map((s) => (
              <li>{s}</li>
            ))}
          </ol>
        </div>
      )}
      <p class="muted small" style="margin:0">
        Ocena AI jest pomocnicza — ostateczną decyzję podejmuje klub. Pełne zasady:{' '}
        <a href="https://content.toastmasters.org/image/upload/02330-001-0001-brand-manual.pdf">Brand Manual Toastmasters</a>.
      </p>
    </div>
  );
};
