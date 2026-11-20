import { EMAIL_RE, normEmail } from './util';

/**
 * Wyciąga osoby (e-mail + imię i nazwisko) z wklejonego tekstu:
 *  - „Anna Nowak <anna@example.com>”, „anna@example.com, Anna Nowak”, sam adres,
 *  - wiersze skopiowane z Excela / Arkuszy Google (kolumny rozdzielone tabulatorami),
 *  - pliki CSV (przecinek lub średnik), np. eksport listy członków.
 * Linie bez adresu (nagłówki, puste) są pomijane, duplikaty adresów scalane.
 */
const EMAIL_FIND = /[^\s<>(),;:"'[\]]+@[^\s<>(),;:"'[\]]+\.[a-z]{2,}/i;

// słowa z kolumn typu „Rola”, „Status”, daty — to nie są imiona
const STOP = new Set(
  (
    'member members officer officers club president vice secretary treasurer sergeant arms past immediate education membership ' +
    'public relations guest guests active inactive paid unpaid yes no none record email mail name first last full phone mobile ' +
    'home work status role date feb mar apr jun jul aug sep sept oct nov dec ' + // bez „jan” i „may” — to też imiona
    'imię imie nazwisko członek czlonek gość gosc telefon tak nie rola'
  ).split(' '),
);

function nameFrom(fragment: string): string {
  const cleaned = fragment.replace(/\[[^\]]*\]|<[^>]*>|\([^)]*\)/g, ' ');
  const words: string[] = [];
  for (const raw of cleaned.split(/\s+/)) {
    const w = raw.replace(/^[^\p{L}]+/u, '').replace(/[^\p{L}]+$/u, '');
    const isWord =
      w.length > 0 &&
      /^\p{L}[\p{L}'’.-]*$/u.test(w) &&
      !/\p{Ll}\p{Lu}/u.test(w) && // „AdrianK”, „KrzysztofJ” — to loginy, nie imiona
      !STOP.has(w.toLowerCase());
    if (!isWord) {
      if (words.length) break;
      continue;
    }
    words.push(w);
    if (words.length === 4) break;
  }
  return words.join(' ');
}

export interface ParsedMember {
  email: string;
  name: string;
}

export function parseMemberLines(text: string): ParsedMember[] {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(EMAIL_FIND);
    if (!m) continue;
    const email = normEmail(m[0]);
    if (!EMAIL_RE.test(email)) continue;
    const fields = line
      .split(/\t|;|,|\|/)
      .map((s) => s.trim())
      .filter(Boolean);
    let name: string;
    if (fields.length > 1) {
      const candidates = fields.map((f) => nameFrom(f.replace(m[0], ' '))).filter(Boolean);
      // pełne imię i nazwisko w jednej kolumnie albo osobne kolumny „Imię” i „Nazwisko”
      name = candidates.find((n) => n.includes(' ')) ?? candidates.slice(0, 2).join(' ');
    } else {
      name = nameFrom(line.replace(m[0], ' '));
    }
    name = name.slice(0, 80);
    if (!out.has(email) || (name && !out.get(email))) out.set(email, name);
  }
  return [...out].map(([email, name]) => ({ email, name }));
}
