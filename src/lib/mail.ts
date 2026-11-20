import { WorkerMailer } from 'worker-mailer';
import type { Env } from '../env';
import { now } from './util';

export interface MailResult {
  sent: boolean;
  /** smtp = wysłano (lub błąd SMTP); off = brak konfiguracji SMTP; blocked = zablokowane przez limity */
  mode: 'smtp' | 'off' | 'blocked';
  error?: string;
  /** dla mode=blocked: za ile sekund można spróbować ponownie */
  retryIn?: number;
}

export function mailConfigured(env: Env): boolean {
  return Boolean(env.SMTP_USER && env.SMTP_PASS);
}

/**
 * Limity wysyłki (Gmail pozwala zwykłemu kontu na ok. 500 maili/dobę — po przekroczeniu blokuje całe konto
 * nawet na 24 h, także ręczną korespondencję klubu):
 *  - maile tylko do aktywnych osób z listy członków,
 *  - maks. 1 mail na MAIL_COOLDOWN sekund na adres,
 *  - maks. MAIL_DAILY_LIMIT maili na dobę z całej aplikacji (domyślnie 300 — zapas na ręczne maile klubu).
 */
export const MAIL_COOLDOWN = 5 * 60;

export function mailDailyLimit(env: Env): number {
  return Number(env.MAIL_DAILY_LIMIT || 300);
}

export async function mailsSentLast24h(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM mail_log WHERE status = 'sent' AND created_at > ?").bind(now() - 86400).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Jedno zapytanie zbiorcze (darmowy plan Workers: maks. 50 podżądań na żądanie, D1 też się wlicza) */
export async function mailAllowed(env: Env, to: string): Promise<{ ok: true } | { ok: false; reason: string; retryIn?: number }> {
  const email = to.trim().toLowerCase();
  const t = now();
  const [member, last, day] = await env.DB.batch<{ v: number | null }>([
    env.DB.prepare('SELECT 1 AS v FROM users WHERE email = ? AND active = 1').bind(email),
    env.DB.prepare("SELECT MAX(created_at) AS v FROM mail_log WHERE to_email = ? AND status = 'sent'").bind(email),
    env.DB.prepare("SELECT COUNT(*) AS v FROM mail_log WHERE status = 'sent' AND created_at > ?").bind(t - 86400),
  ]);
  if (!member.results.length) return { ok: false, reason: 'Ten adres nie jest na liście aktywnych członków.' };
  const lastAt = last.results[0]?.v ?? 0;
  if (lastAt && t - lastAt < MAIL_COOLDOWN) {
    const retryIn = MAIL_COOLDOWN - (t - lastAt);
    return { ok: false, reason: `Na ten adres wysłaliśmy maila przed chwilą. Kolejny możliwy za ${Math.ceil(retryIn / 60)} min.`, retryIn };
  }
  if ((day.results[0]?.v ?? 0) >= mailDailyLimit(env))
    return { ok: false, reason: `Osiągnięto dzienny limit ${mailDailyLimit(env)} maili. Spróbuj jutro.` };
  return { ok: true };
}

export async function sendMail(
  env: Env,
  msg: { to: string; toName?: string; subject: string; text: string; html: string },
  opts: { alreadyChecked?: boolean } = {},
): Promise<MailResult> {
  if (!opts.alreadyChecked) {
    const allowed = await mailAllowed(env, msg.to);
    if (!allowed.ok) return { sent: false, mode: 'blocked', error: allowed.reason, retryIn: allowed.retryIn };
  }
  let result: MailResult;
  if (!mailConfigured(env)) {
    console.log(`[MAIL wyłączony] Do: ${msg.to}\nTemat: ${msg.subject}\n\n${msg.text}`);
    result = { sent: false, mode: 'off' };
  } else {
    const port = Number(env.SMTP_PORT || 465);
    try {
      await WorkerMailer.send(
        {
          host: env.SMTP_HOST || 'smtp.gmail.com',
          port,
          secure: port === 465,
          startTls: port !== 465,
          credentials: { username: env.SMTP_USER!, password: env.SMTP_PASS!.replace(/\s+/g, '') },
          authType: ['plain', 'login'],
          socketTimeoutMs: 15000,
          responseTimeoutMs: 15000,
        },
        {
          from: { name: env.MAIL_FROM_NAME || 'Toastmasters Częstochowa', email: env.SMTP_USER! },
          to: msg.toName ? { name: msg.toName, email: msg.to } : msg.to,
          subject: msg.subject,
          text: msg.text,
          html: msg.html,
        },
      );
      result = { sent: true, mode: 'smtp' };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error('Błąd wysyłki maila', error);
      result = { sent: false, mode: 'smtp', error };
    }
  }
  await env.DB.prepare('INSERT INTO mail_log (to_email, subject, status, error, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(msg.to, msg.subject, result.sent ? 'sent' : result.mode === 'off' ? 'not_configured' : 'error', result.error ?? null, now())
    .run();
  return result;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

function wrapHtml(heading: string, paragraphs: string[], button: { label: string; url: string }, footnote: string): string {
  return `<!doctype html><html lang="pl"><body style="margin:0;background:#f3f6f8;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#16232c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f6f8;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden">
<tr><td style="background:#004165;padding:20px 28px;color:#fff;font-weight:800;font-size:18px">Toastmasters Częstochowa <span style="color:#f2df74;font-weight:600">· Strefa członka</span></td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 16px;font-size:22px;color:#00304b">${esc(heading)}</h1>
${paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.6">${p}</p>`).join('')}
<p style="margin:24px 0"><a href="${esc(button.url)}" style="display:inline-block;padding:14px 26px;border-radius:999px;background:#772432;color:#fff;font-weight:700;text-decoration:none">${esc(button.label)}</a></p>
<p style="margin:0 0 8px;font-size:13px;color:#4a5661">Jeśli przycisk nie działa, skopiuj ten adres do przeglądarki:<br><a href="${esc(button.url)}" style="color:#004165;word-break:break-all">${esc(button.url)}</a></p>
<p style="margin:16px 0 0;font-size:13px;color:#4a5661">${footnote}</p>
</td></tr></table></td></tr></table></body></html>`;
}

export function inviteMail(name: string, link: string) {
  const hi = name ? `Cześć ${esc(name)}!` : 'Cześć!';
  return {
    subject: 'Zaproszenie do strefy członka Toastmasters Częstochowa',
    text: `${hi.replace(/&[^;]+;/g, '')}\n\nTwój adres został dodany do strefy członka klubu Toastmasters Częstochowa. Znajdziesz tam m.in. konkursy klubowe i głosowania.\n\nUstaw swoje hasło (link jest ważny 14 dni):\n${link}\n\nPotem możesz logować się mailem i hasłem albo samym mailem (wtedy wyślemy Ci link do logowania).\n\nDo zobaczenia na spotkaniu!\nToastmasters Częstochowa`,
    html: wrapHtml(
      'Zaproszenie do strefy członka',
      [
        hi,
        'Twój adres został dodany do <strong>strefy członka klubu Toastmasters Częstochowa</strong>. Znajdziesz tam m.in. konkursy klubowe i głosowania.',
        'Kliknij poniżej, żeby ustawić swoje hasło. Potem możesz logować się mailem i hasłem albo samym mailem (wtedy wyślemy Ci link do logowania).',
      ],
      { label: 'Ustaw hasło', url: link },
      'Link jest ważny 14 dni i działa tylko raz. Jeśli nie spodziewałeś(-aś) się tej wiadomości, po prostu ją zignoruj.',
    ),
  };
}

export function loginMail(link: string) {
  return {
    subject: 'Toastmasters Częstochowa: link do logowania',
    text: `Ktoś (pewnie Ty) poprosił o link do logowania w strefie członka Toastmasters Częstochowa.\n\nZaloguj się (link ważny 20 minut, działa raz):\n${link}\n\nJeśli to nie Ty, zignoruj tę wiadomość.`,
    html: wrapHtml(
      'Twój link do logowania',
      ['Ktoś (pewnie Ty) poprosił o link do logowania w strefie członka Toastmasters Częstochowa.'],
      { label: 'Zaloguj się', url: link },
      'Link jest ważny 20 minut i działa tylko raz. Jeśli to nie Ty, zignoruj tę wiadomość.',
    ),
  };
}

/**
 * Powiadomienie do wielu członków naraz: jeden mail w ukrytej kopii (BCC), adresowany do skrzynki klubu.
 * Jedno połączenie SMTP na 90 odbiorców, więc mieści się w limicie podżądań darmowego planu.
 * Pomija osoby, które dostały maila w ostatnich 5 minutach, i pilnuje dziennego limitu.
 */
export async function sendAnnouncement(
  env: Env,
  emails: string[],
  msg: { subject: string; text: string; html: string },
): Promise<{ sent: number; skipped: number; error?: string }> {
  if (!mailConfigured(env)) return { sent: 0, skipped: emails.length, error: 'Wysyłka maili jest wyłączona.' };
  const t = now();
  const [recent, day] = await env.DB.batch<{ v: string | number }>([
    env.DB.prepare("SELECT DISTINCT to_email AS v FROM mail_log WHERE status = 'sent' AND created_at > ?").bind(t - MAIL_COOLDOWN),
    env.DB.prepare("SELECT COUNT(*) AS v FROM mail_log WHERE status = 'sent' AND created_at > ?").bind(t - 86400),
  ]);
  const recentSet = new Set(recent.results.map((r) => String(r.v)));
  const list = [...new Set(emails.map((e) => e.trim().toLowerCase()))].filter((e) => !recentSet.has(e));
  const skipped = emails.length - list.length;
  const room = mailDailyLimit(env) - Number(day.results[0]?.v ?? 0);
  if (list.length > room) return { sent: 0, skipped: emails.length, error: `Dzienny limit maili nie wystarczy (zostało ${Math.max(0, room)}). Spróbuj jutro.` };
  if (!list.length) return { sent: 0, skipped, error: 'Wszyscy dostali maila w ostatnich minutach. Spróbuj za 5 minut.' };

  const port = Number(env.SMTP_PORT || 465);
  const from = { name: env.MAIL_FROM_NAME || 'Toastmasters Częstochowa', email: env.SMTP_USER! };
  const logs: D1PreparedStatement[] = [];
  let sent = 0;
  let error: string | undefined;
  for (let i = 0; i < list.length; i += 90) {
    const chunk = list.slice(i, i + 90);
    try {
      await WorkerMailer.send(
        {
          host: env.SMTP_HOST || 'smtp.gmail.com',
          port,
          secure: port === 465,
          startTls: port !== 465,
          credentials: { username: env.SMTP_USER!, password: env.SMTP_PASS!.replace(/\s+/g, '') },
          authType: ['plain', 'login'],
          socketTimeoutMs: 20000,
          responseTimeoutMs: 20000,
        },
        { from, to: from, bcc: chunk, subject: msg.subject, text: msg.text, html: msg.html },
      );
      sent += chunk.length;
      for (const e of chunk) logs.push(env.DB.prepare("INSERT INTO mail_log (to_email, subject, status, created_at) VALUES (?, ?, 'sent', ?)").bind(e, msg.subject, t));
    } catch (e) {
      error = `Błąd wysyłki: ${e instanceof Error ? e.message : String(e)}`;
      for (const addr of chunk) logs.push(env.DB.prepare("INSERT INTO mail_log (to_email, subject, status, error, created_at) VALUES (?, ?, 'error', ?, ?)").bind(addr, msg.subject, error, t));
    }
  }
  if (logs.length) await env.DB.batch(logs);
  return { sent, skipped, error };
}

export function announcementMail(subject: string, message: string, link: string) {
  const paragraphs = message
    .split(/\n{2,}|\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const foot = 'Nie pamiętasz hasła albo jeszcze go nie ustawiłeś(-aś)? Na stronie logowania kliknij „Wyślij mi link do logowania”.';
  return {
    subject,
    text: `Cześć!\n\n${paragraphs.join('\n\n')}\n\nPrzejdź do konkursu: ${link}\n\n${foot}\n\nToastmasters Częstochowa`,
    html: wrapHtml(subject, ['Cześć!', ...paragraphs.map(esc)], { label: 'Przejdź do konkursu', url: link }, foot),
  };
}
