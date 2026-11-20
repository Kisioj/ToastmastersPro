import type { Env } from '../env';
import { now } from './util';

/**
 * Ocena projektu rollupu pod kątem Brand Manuala Toastmasters International (v2.0, rev. 08/2026).
 * Dwa silniki:
 *  - "workers-ai" — darmowe Workers AI (model wizyjny Mistral Small 3.1), bez dodatkowych kont,
 *  - "claude"     — Claude API (płatne za użycie, wyraźnie lepsza ocena; wymaga sekretu ANTHROPIC_API_KEY).
 * Twarde parametry techniczne (DPI, wymiary, czcionki) liczy przeglądarka — AI dostaje je jako raport.
 */

export interface AiCheck {
  area: string;
  status: 'ok' | 'uwaga' | 'blad';
  comment: string;
}

export interface AiReview {
  verdict: 'zgodny' | 'drobne_poprawki' | 'wymaga_zmian';
  score: number;
  summary: string;
  checks: AiCheck[];
  suggestions: string[];
  provider: string;
  model: string;
  created_at: number;
}

const SYSTEM = `You review roll-up banner designs (85 × 200 cm) submitted to a design contest of the Toastmasters Częstochowa club (Poland). Assess (1) compliance with the Toastmasters International Brand Manual (v2.0, rev. 08/2026) and (2) how well the design works as a roll-up seen from 1–3 m. Write ALL output text in Polish: concise, specific, constructive, addressed directly to the designer.

BRAND RULES
- Colors: primary Loyal Blue #004165 and True Maroon #772432 should dominate (backgrounds, large areas). Secondary accents: Cool Gray #A9B2B1, Happy Yellow #F2DF74 (highlights). The only allowed gradients: Loyal Blue #004165 ↔ Blissful Blue #006094; Deep Maroon #3B0104 ↔ Rich Maroon #781327; Cool Gray #A9B2B1 ↔ Fair Gray #F5F5F5. White overlays at ~70% opacity are fine. These colors are a RECOMMENDATION of the club: other dominant colors or gradients get status "uwaga", never "blad".
- Logo: the official Toastmasters International logo, unmodified: no perspective, stretching, disproportionate scaling, recoloring, changed element proportions, glow, busy or patterned background behind it, no text/images overlapping it. Clear space around it at least equal to the wordmark height (recommendation). Clubs must NOT create their own logo. The club name ("Toastmasters Częstochowa") may appear as text, e.g. below the logo.
- Typography: headlines in Gotham (free alternative: Montserrat), body copy in Myriad Pro (free alternative: Source Sans 3); Arial / Segoe UI acceptable for body. No word art, drop shadows, heavy outlines or distorted type.
- Tagline: "Where Leaders Are Made" in Title Case or ALL CAPS. Approved phrases (one per piece): Find Your Voice; Relax, present confidently.; Relax, speak confidently.; Communicate Confidently®; More than 100 Years of Confident Voices; Over a Century of Communication Excellence; Find your confidence; Become a better leader; Invest in a Brighter Future. The manual says clubs may not create their own taglines; if a Polish slogan or club motto is used, mark it "uwaga" (needs a club decision), not "blad".
- Photography: real people engaged in Toastmasters situations (speaking, meetings, contests, networking). Avoid landscapes, animals, children, food, medicine or architecture as the main subject. Cartoons, illustrations and clip art only as secondary elements. A logo placed on a photo needs good contrast, must not cover faces, ideally top-left or bottom-right.
- Contrast: text must contrast strongly with its background.

ROLL-UP PRACTICE
- Logo and the main message in the upper half (eye level). Nothing important within ~3 cm of the side edges or in the bottom ~10 cm (hidden by the stand base).
- Headline readable from 3 m (letters roughly 6–8 cm tall or more on the real banner). Little text, a roll-up is not a flyer.
- Contact info (website, socials, QR code at least 3 × 3 cm) is a plus.

You receive a downscaled preview (proportions preserved) and an automatic technical report (physical size, effective DPI, fonts, color shares). Trust the report for resolution and size; never judge DPI from the preview. Judge only what is visible; say when unsure.

SEVERITY POLICY (decided by the club, follow it strictly):
- "blad" is allowed ONLY in the "Logo" check, and only when the official Toastmasters logo is modified (stretched, squeezed, recolored, rotated or in perspective, elements changed, glow or shadow added) or a custom/unofficial logo is used instead of it.
- Everything else is a recommendation and gets at most "uwaga": colors and gradients, logo clear space, size, placement and background, a missing logo, typography, tagline, photos, layout, legibility and contrast.
- verdict: "zgodny" = no "uwaga" and no "blad"; "drobne_poprawki" = only recommendations ("uwaga"); "wymaga_zmian" = at least one "blad".

STYLE: plain Polish sentences. Never use the em dash character (—); use commas, colons or full stops instead.

Return JSON only with: verdict, score (integer 0–100), summary (2–3 sentences), checks (5–8 items covering: Kolory, Logo, Typografia, Hasło/tagline, Zdjęcia i grafika, Czytelność z daleka, Układ na rollupie, Kontrast; status "ok" | "uwaga" | "blad"), suggestions (up to 5 concrete fixes, most important first).`;

const SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['zgodny', 'drobne_poprawki', 'wymaga_zmian'] },
    score: { type: 'integer' },
    summary: { type: 'string' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          area: { type: 'string' },
          status: { type: 'string', enum: ['ok', 'uwaga', 'blad'] },
          comment: { type: 'string' },
        },
        required: ['area', 'status', 'comment'],
        additionalProperties: false,
      },
    },
    suggestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'score', 'summary', 'checks', 'suggestions'],
  additionalProperties: false,
} as const;

export function aiProvider(env: Env): 'claude' | 'workers-ai' | null {
  const wanted = (env.AI_PROVIDER || 'workers-ai').toLowerCase();
  if (wanted === 'claude' && env.ANTHROPIC_API_KEY) return 'claude';
  if (env.AI) return 'workers-ai';
  if (env.ANTHROPIC_API_KEY) return 'claude';
  return null;
}

function reportText(title: string, report: unknown): string {
  return `Contest entry title: ${JSON.stringify(title)}\nAutomatic technical report (JSON):\n${JSON.stringify(report ?? {}, null, 1).slice(0, 6000)}`;
}

function normalize(raw: unknown, provider: string, model: string): AiReview {
  const r = (raw ?? {}) as Record<string, unknown>;
  const verdicts = ['zgodny', 'drobne_poprawki', 'wymaga_zmian'] as const;
  const statuses = ['ok', 'uwaga', 'blad'] as const;
  const verdict = verdicts.includes(r.verdict as never) ? (r.verdict as AiReview['verdict']) : 'drobne_poprawki';
  const score = Math.max(0, Math.min(100, Math.round(Number(r.score) || 0)));
  const checks = (Array.isArray(r.checks) ? r.checks : [])
    .map((c) => c as Record<string, unknown>)
    .filter((c) => typeof c.area === 'string' && typeof c.comment === 'string')
    .slice(0, 12)
    .map((c) => ({
      area: String(c.area).slice(0, 80),
      status: (statuses.includes(c.status as never) ? c.status : 'uwaga') as AiCheck['status'],
      comment: String(c.comment).slice(0, 600),
    }));
  // tylko „Logo” może mieć błąd (zmodyfikowane / nieoficjalne logo); reszta to zalecenia
  for (const ch of checks) if (ch.status === 'blad' && !/logo/i.test(ch.area)) ch.status = 'uwaga';
  const suggestions = (Array.isArray(r.suggestions) ? r.suggestions : [])
    .filter((s): s is string => typeof s === 'string')
    .slice(0, 6)
    .map((s) => s.slice(0, 400));
  // werdykt wynika z punktów kontroli, a nie z deklaracji modelu
  const derived: AiReview['verdict'] = checks.some((ch) => ch.status === 'blad') ? 'wymaga_zmian' : checks.some((ch) => ch.status === 'uwaga') ? 'drobne_poprawki' : checks.length ? 'zgodny' : verdict;
  for (const ch of checks) ch.comment = noDash(ch.comment);
  return { verdict: derived, score, summary: noDash(String(r.summary ?? '').slice(0, 1200)), checks, suggestions: suggestions.map(noDash), provider, model, created_at: now() };
}

/** Bez długich myślników w tekstach na stronie */
const noDash = (t: string) => t.replace(/\s*—\s*/g, ' - ');

/** Wyciąga pierwszy obiekt JSON z odpowiedzi modelu (Workers AI nie zawsze trzyma się formatu) */
function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Model nie zwrócił oceny w formacie JSON.');
  return JSON.parse(text.slice(start, end + 1));
}

async function viaClaude(env: Env, imageB64: string, userText: string): Promise<AiReview> {
  // SDK ładowane dopiero tutaj: to ~3 MB kodu, a darmowy plan liczy CPU zimnego startu (limit 10 ms)
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.CLAUDE_MODEL || 'claude-opus-5-5';
  const params = {
    model,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: 'medium' as const, format: { type: 'json_schema' as const, schema: SCHEMA } },
    messages: [
      {
        role: 'user' as const,
        content: [
          { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: imageB64 } },
          { type: 'text' as const, text: userText },
        ],
      },
    ],
  };
  // Serwerowy fallback po odmowie (refusal) — wspierany przez Opus 5.5 / Sonnet 5.5 / Fable; Haiku go nie ma.
  const withFallback = /^claude-(opus-5|sonnet-5-5|fable-5)/.test(model);
  try {
    const msg = withFallback
      ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : await client.messages.create(params);
    if (msg.stop_reason === 'refusal') throw new Error('Model odmówił oceny tego projektu.');
    if (msg.stop_reason === 'max_tokens') throw new Error('Ocena została ucięta (limit tokenów).');
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return normalize(JSON.parse(text), 'claude', msg.model ?? model);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Nieprawidłowy klucz ANTHROPIC_API_KEY.');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Za dużo zapytań do Claude. Spróbuj za chwilę.');
    if (e instanceof Anthropic.BadRequestError) throw new Error(`Claude odrzucił zapytanie: ${e.message}`);
    if (e instanceof Anthropic.APIError) throw new Error(`Błąd Claude API (${e.status}): ${e.message}`);
    throw e;
  }
}

async function viaWorkersAi(env: Env, imageB64: string, userText: string): Promise<AiReview> {
  const model = env.WORKERS_AI_MODEL || '@cf/mistralai/mistral-small-3.1-24b-instruct';
  const shape =
    '\n\nRespond with ONE JSON object and nothing else, exactly in this shape: {"verdict":"zgodny|drobne_poprawki|wymaga_zmian","score":0-100,"summary":"...","checks":[{"area":"Kolory","status":"ok|uwaga|blad","comment":"..."}],"suggestions":["..."]}';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = (await (env.AI as any).run(model, {
    messages: [
      { role: 'system', content: SYSTEM + shape },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageB64}` } },
        ],
      },
    ],
    max_tokens: 2000,
    temperature: 0.2,
  })) as { response?: unknown };
  const resp = out?.response;
  const parsed = typeof resp === 'string' ? extractJson(resp) : resp;
  return normalize(parsed, 'workers-ai', model);
}

/** Komunikat, gdy skończy się darmowa dzienna pula Workers AI (10 000 „neuronów”, odnawia się o 00:00 UTC) */
export const AI_QUOTA_MSG =
  'Na dziś wyczerpał się darmowy limit oceny AI. Spróbuj jutro: limit odnawia się o 1:00 w nocy (latem o 2:00). Projekt możesz wysłać normalnie, a ocenę uruchomisz później przyciskiem przy zgłoszeniu.';
const QUOTA_KEY = 'workers_ai_quota_exhausted';
const utcDay = () => new Date().toISOString().slice(0, 10);

/** Czy dzisiaj (UTC) wyczerpano już darmowy limit Workers AI */
export async function aiQuotaExhausted(env: Env): Promise<boolean> {
  const row = await env.DB.prepare('SELECT value FROM app_state WHERE key = ?').bind(QUOTA_KEY).first<{ value: string }>();
  return row?.value === utcDay();
}

/** Błędy Workers AI po polsku (oryginał trafia do logów) */
function friendlyWorkersAiError(e: unknown): { message: string; quota: boolean } {
  const raw = e instanceof Error ? e.message : String(e);
  if (/3036|4006|daily free allocation|account limited|neurons/i.test(raw)) return { message: AI_QUOTA_MSG, quota: true };
  if (/capacity|rate limit|too many requests|3040|429/i.test(raw)) return { message: 'Usługa AI jest chwilowo przeciążona. Spróbuj za kilka minut.', quota: false };
  if (/timeout|timed out|3007/i.test(raw)) return { message: 'Ocena AI trwała za długo. Spróbuj ponownie.', quota: false };
  return { message: 'Ocena AI nie powiodła się. Spróbuj ponownie za chwilę.', quota: false };
}

export async function reviewDesign(env: Env, input: { imageB64: string; title: string; report: unknown }): Promise<AiReview> {
  const provider = aiProvider(env);
  if (!provider) throw new Error('Ocena AI nie jest skonfigurowana.');
  const text = reportText(input.title, input.report);
  if (provider === 'claude') return viaClaude(env, input.imageB64, text);
  // limit już wyczerpany dzisiaj: nie czekamy na wolną odpowiedź z błędem
  if (await aiQuotaExhausted(env)) throw new Error(AI_QUOTA_MSG);
  try {
    return await viaWorkersAi(env, input.imageB64, text);
  } catch (e) {
    console.error('Workers AI', e);
    const f = friendlyWorkersAiError(e);
    if (f.quota) {
      await env.DB.prepare(
        'INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
        .bind(QUOTA_KEY, utcDay())
        .run();
    }
    throw new Error(f.message);
  }
}

/**
 * Limity ocen AI:
 *  - AI_CLUB_DAILY_LIMIT ocen dziennie dla całego klubu, wszyscy razem, także admin (domyślnie 100).
 *    Twardy bezpiecznik kosztów: limit wydatków Cloudflare nie obejmuje Workers AI.
 *  - na osobę (admin i opiekun konkursu bez tych limitów):
 *    AI_DAILY_LIMIT ocen dziennie (domyślnie 8) i AI_COOLDOWN_MINUTES przerwy między ocenami (domyślnie 5).
 * Liczone są tylko udane oceny: błąd albo wyczerpana pula nie zużywa limitu.
 */
export function aiClubLimit(env: Env): number {
  return Number(env.AI_CLUB_DAILY_LIMIT || 100);
}

export async function aiUsageToday(env: Env): Promise<number> {
  const row = await env.DB.prepare('SELECT COALESCE(SUM(count), 0) AS total FROM ai_usage WHERE day = ?').bind(utcDay()).first<{ total: number }>();
  return row?.total ?? 0;
}

export async function aiLimitCheck(env: Env, userId: number, perUser = true): Promise<string | null> {
  const day = utcDay();
  const [mineRes, allRes] = await env.DB.batch([
    env.DB.prepare('SELECT count, last_at FROM ai_usage WHERE user_id = ? AND day = ?').bind(userId, day),
    env.DB.prepare('SELECT COALESCE(SUM(count), 0) AS total FROM ai_usage WHERE day = ?').bind(day),
  ]);
  const club = aiClubLimit(env);
  const total = (allRes.results[0] as { total: number } | undefined)?.total ?? 0;
  if (total >= club) return `Klub wykorzystał dzisiejszy limit ocen AI (${club}). Ocena będzie znowu dostępna jutro.`;
  if (!perUser) return null;
  const row = mineRes.results[0] as { count: number; last_at: number | null } | undefined;
  const limit = Number(env.AI_DAILY_LIMIT || 8);
  const cooldown = Number(env.AI_COOLDOWN_MINUTES || 5) * 60;
  if ((row?.count ?? 0) >= limit) return `Wykorzystano dzienny limit ocen AI (${limit}). Spróbuj jutro.`;
  const since = row?.last_at ? now() - row.last_at : Infinity;
  if (since < cooldown) {
    const min = Math.ceil((cooldown - since) / 60);
    return `Kolejną ocenę AI możesz uruchomić za ${min} min. Przerwa chroni wspólny dzienny limit ocen.`;
  }
  return null;
}

export async function recordAiUse(env: Env, userId: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ai_usage (user_id, day, count, last_at) VALUES (?, ?, 1, unixepoch())
     ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1, last_at = unixepoch()`,
  )
    .bind(userId, utcDay())
    .run();
}
