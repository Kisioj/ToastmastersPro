import { fmtNum } from './util';

export interface MethodInfo {
  id: MethodId;
  name: string;
  /** krótka nazwa na zakładkę */
  short: string;
  /** krótka instrukcja dla głosującego */
  tagline: string;
  /** jak liczymy wynik */
  scoring: string;
  /** zalety / wady — pomaga wybrać metodę */
  pros: string;
}

export const METHOD_IDS = ['top3', 'ranking', 'approval', 'score', 'points', 'duel', 'single'] as const;
export type MethodId = (typeof METHOD_IDS)[number];

export const METHODS: Record<MethodId, MethodInfo> = {
  top3: {
    id: 'top3',
    short: 'Podium',
    name: 'Podium (top 3)',
    tagline: 'Wybierz swoje 1., 2. i 3. miejsce.',
    scoring: '1. miejsce = 3 pkt, 2. miejsce = 2 pkt, 3. miejsce = 1 pkt. Wygrywa najwięcej punktów.',
    pros: 'Szybkie i intuicyjne, a jednocześnie bierze pod uwagę więcej niż jeden faworyt.',
  },
  ranking: {
    id: 'ranking',
    short: 'Ranking',
    name: 'Pełny ranking',
    tagline: 'Ułóż wszystkie propozycje od najlepszej do najsłabszej.',
    scoring: 'Liczymy średnie miejsce każdej propozycji (metoda Bordy). Dodatkowo sprawdzamy zwycięzcę Condorceta — propozycję, która wygrywa z każdą inną w bezpośrednim porównaniu.',
    pros: 'Najwięcej informacji o preferencjach, ale wymaga przemyślenia wszystkich propozycji.',
  },
  approval: {
    id: 'approval',
    short: 'Aprobata',
    name: 'Aprobata',
    tagline: 'Zaznacz wszystkie propozycje, które byłyby dla Ciebie OK.',
    scoring: 'Wygrywa propozycja zaakceptowana przez najwięcej osób.',
    pros: 'Bardzo proste; dobrze wyłania kompromis akceptowalny dla większości.',
  },
  score: {
    id: 'score',
    short: 'Gwiazdki',
    name: 'Gwiazdki',
    tagline: 'Oceń każdą propozycję w skali od 1 do 5 gwiazdek.',
    scoring: 'Wygrywa najwyższa średnia ocen.',
    pros: 'Pokazuje nie tylko kolejność, ale też „jak bardzo” coś się podoba.',
  },
  points: {
    id: 'points',
    short: 'Punkty',
    name: 'Rozdaj punkty',
    tagline: 'Rozdziel 10 punktów — możesz dać wszystkie jednej propozycji albo podzielić.',
    scoring: 'Wygrywa największa suma punktów.',
    pros: 'Pozwala wyrazić siłę preferencji; mocni faworyci mogą dostać dużo punktów.',
  },
  duel: {
    id: 'duel',
    short: 'Pojedynki',
    name: 'Pojedynki',
    tagline: 'Dostajesz dwie propozycje naraz — wybierz lepszą. Możesz przerwać w dowolnym momencie.',
    scoring: 'Wygrywa propozycja z najwyższym odsetkiem wygranych pojedynków.',
    pros: 'Najłatwiejsza decyzja w każdym kroku; dobre przy wielu podobnych propozycjach.',
  },
  single: {
    id: 'single',
    short: 'Jeden głos',
    name: 'Jeden głos',
    tagline: 'Wybierz jedną, ulubioną propozycję.',
    scoring: 'Wygrywa najwięcej głosów.',
    pros: 'Najprostsze, ale przy wielu propozycjach głosy się rozpraszają.',
  },
};

export function isMethod(m: unknown): m is MethodId {
  return typeof m === 'string' && (METHOD_IDS as readonly string[]).includes(m);
}

export function parseMethods(json: string): MethodId[] {
  try {
    const arr = JSON.parse(json);
    const ok = Array.isArray(arr) ? arr.filter(isMethod) : [];
    return ok.length ? [...new Set(ok)] : ['top3'];
  } catch {
    return ['top3'];
  }
}

export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const d = n % 10;
  const t = n % 100;
  return d >= 2 && d <= 4 && (t < 12 || t > 14) ? few : many;
}

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Sprawdza głos i zwraca znormalizowane dane do zapisania */
export function validateBallot(method: MethodId, raw: unknown, ids: number[], budget = 10): Result<unknown> {
  const idSet = new Set(ids);
  const r = (raw ?? {}) as Record<string, unknown>;
  const distinctValid = (arr: unknown): arr is number[] =>
    Array.isArray(arr) && arr.every((x) => isInt(x) && idSet.has(x)) && new Set(arr).size === arr.length;

  switch (method) {
    case 'single': {
      if (!isInt(r.choice) || !idSet.has(r.choice)) return { ok: false, error: 'Wybierz jedną propozycję.' };
      return { ok: true, data: { choice: r.choice } };
    }
    case 'top3': {
      const need = Math.min(3, ids.length);
      if (!distinctValid(r.podium) || r.podium.length !== need)
        return { ok: false, error: `Wybierz ${need === 3 ? 'wszystkie trzy miejsca' : `${need} miejsca`} na podium.` };
      return { ok: true, data: { podium: r.podium } };
    }
    case 'approval': {
      if (!distinctValid(r.approved) || r.approved.length < 1) return { ok: false, error: 'Zaznacz przynajmniej jedną propozycję.' };
      return { ok: true, data: { approved: r.approved } };
    }
    case 'ranking': {
      if (!distinctValid(r.order) || r.order.length !== ids.length)
        return { ok: false, error: 'Uszereguj wszystkie propozycje (każda musi mieć swoje miejsce).' };
      return { ok: true, data: { order: r.order } };
    }
    case 'score': {
      const s = r.scores as Record<string, unknown> | undefined;
      if (!s || typeof s !== 'object') return { ok: false, error: 'Oceń propozycje.' };
      const out: Record<string, number> = {};
      for (const id of ids) {
        const v = s[String(id)];
        if (!isInt(v) || v < 1 || v > 5) return { ok: false, error: 'Oceń każdą propozycję (od 1 do 5 gwiazdek).' };
        out[id] = v;
      }
      return { ok: true, data: { scores: out } };
    }
    case 'points': {
      const p = r.points as Record<string, unknown> | undefined;
      if (!p || typeof p !== 'object') return { ok: false, error: 'Rozdaj punkty.' };
      const out: Record<string, number> = {};
      let sum = 0;
      for (const [k, v] of Object.entries(p)) {
        const id = Number(k);
        if (!idSet.has(id) || !isInt(v) || v < 0 || v > budget) return { ok: false, error: 'Nieprawidłowa liczba punktów.' };
        if (v > 0) out[id] = v;
        sum += v;
      }
      if (sum !== budget) return { ok: false, error: `Rozdaj dokładnie ${budget} pkt (teraz: ${sum}).` };
      return { ok: true, data: { points: out } };
    }
    case 'duel': {
      if (!Array.isArray(r.duels)) return { ok: false, error: 'Brak pojedynków.' };
      const duels = (r.duels as unknown[]).filter(
        (d): d is [number, number] => Array.isArray(d) && d.length === 2 && isInt(d[0]) && isInt(d[1]) && d[0] !== d[1] && idSet.has(d[0]) && idSet.has(d[1]),
      );
      return { ok: true, data: { duels: duels.slice(-2000) } };
    }
  }
}

/** Dopisuje jeden pojedynek, zastępując wcześniejszy wynik tej samej pary */
export function addDuel(existing: unknown, winner: number, loser: number): { duels: [number, number][] } {
  const prev = ((existing as { duels?: [number, number][] })?.duels ?? []).filter(
    ([a, b]) => !((a === winner && b === loser) || (a === loser && b === winner)),
  );
  prev.push([winner, loser]);
  return { duels: prev.slice(-2000) };
}

export interface TallyRow {
  id: number;
  title: string;
  score: number;
  label: string;
  /** 0..1 — długość paska na wykresie */
  bar: number;
  rank: number;
}

export interface Tally {
  method: MethodId;
  voters: number;
  rows: TallyRow[];
  notes: string[];
}

interface EntryLite {
  id: number;
  title: string;
}

function finish(method: MethodId, voters: number, rows: Omit<TallyRow, 'rank' | 'bar'>[], higherBetter: boolean, notes: string[], barOf?: (s: number) => number): Tally {
  rows.sort((a, b) => (higherBetter ? b.score - a.score : a.score - b.score));
  const max = Math.max(0, ...rows.map((r) => r.score));
  let rank = 0;
  let prev: number | null = null;
  const out = rows.map((r, i) => {
    if (prev === null || r.score !== prev) rank = i + 1;
    prev = r.score;
    return { ...r, rank, bar: barOf ? barOf(r.score) : max > 0 ? Math.max(0, r.score) / max : 0 };
  });
  return { method, voters, rows: out, notes };
}

export function tally(method: MethodId, ballots: unknown[], entries: EntryLite[]): Tally {
  const ids = entries.map((e) => e.id);
  const idSet = new Set(ids);
  const n = ids.length;
  const voters = ballots.length;
  const base = (id: number) => entries.find((e) => e.id === id)!.title;

  switch (method) {
    case 'single': {
      const c = new Map(ids.map((id) => [id, 0]));
      for (const b of ballots as { choice?: number }[]) if (b.choice !== undefined && idSet.has(b.choice)) c.set(b.choice, c.get(b.choice)! + 1);
      return finish(method, voters, ids.map((id) => ({ id, title: base(id), score: c.get(id)!, label: `${c.get(id)} ${plural(c.get(id)!, 'głos', 'głosy', 'głosów')}` })), true, []);
    }
    case 'top3': {
      const pts = new Map(ids.map((id) => [id, 0]));
      const firsts = new Map(ids.map((id) => [id, 0]));
      for (const b of ballots as { podium?: number[] }[]) {
        (b.podium ?? []).forEach((id, i) => {
          if (!idSet.has(id) || i > 2) return;
          pts.set(id, pts.get(id)! + (3 - i));
          if (i === 0) firsts.set(id, firsts.get(id)! + 1);
        });
      }
      // remisy rozstrzyga liczba pierwszych miejsc (ułamek nie zmienia kolejności przy różnych punktach)
      return finish(
        method,
        voters,
        ids.map((id) => ({ id, title: base(id), score: pts.get(id)! + firsts.get(id)! / 1000, label: `${pts.get(id)} pkt${firsts.get(id) ? ` · ${firsts.get(id)}× 1. miejsce` : ''}` })),
        true,
        [],
      );
    }
    case 'approval': {
      const c = new Map(ids.map((id) => [id, 0]));
      for (const b of ballots as { approved?: number[] }[]) for (const id of b.approved ?? []) if (idSet.has(id)) c.set(id, c.get(id)! + 1);
      return finish(
        method,
        voters,
        ids.map((id) => ({ id, title: base(id), score: c.get(id)!, label: `${c.get(id)} z ${voters}${voters ? ` (${Math.round((c.get(id)! / voters) * 100)}%)` : ''}` })),
        true,
        [],
        (s) => (voters ? s / voters : 0),
      );
    }
    case 'ranking': {
      const sumPos = new Map(ids.map((id) => [id, 0]));
      // pairwise[a][b] = ilu głosujących woli a od b
      const pair = new Map(ids.map((a) => [a, new Map(ids.map((b) => [b, 0]))]));
      for (const b of ballots as { order?: number[] }[]) {
        const order = (b.order ?? []).filter((id) => idSet.has(id));
        const pos = new Map<number, number>();
        order.forEach((id, i) => pos.set(id, i + 1));
        // propozycje dodane po oddaniu głosu: ex aequo na końcu
        const tail = (order.length + 1 + n) / 2;
        for (const id of ids) if (!pos.has(id)) pos.set(id, tail);
        for (const id of ids) sumPos.set(id, sumPos.get(id)! + pos.get(id)!);
        for (const a of ids) for (const c of ids) if (a !== c && pos.get(a)! < pos.get(c)!) pair.get(a)!.set(c, pair.get(a)!.get(c)! + 1);
      }
      const notes: string[] = [];
      if (voters > 0 && n > 1) {
        const winner = ids.find((a) => ids.every((c) => c === a || pair.get(a)!.get(c)! > pair.get(c)!.get(a)!));
        notes.push(
          winner !== undefined
            ? `Zwycięzca Condorceta (wygrywa w bezpośrednim porównaniu z każdą inną propozycją): „${base(winner)}”.`
            : 'Brak zwycięzcy Condorceta — żadna propozycja nie wygrywa z każdą inną w bezpośrednim porównaniu.',
        );
      }
      return finish(
        method,
        voters,
        ids.map((id) => {
          const avg = voters ? sumPos.get(id)! / voters : 0;
          return { id, title: base(id), score: voters ? avg : n, label: voters ? `średnie miejsce ${fmtNum(avg)}` : '—' };
        }),
        false,
        notes,
        (s) => (voters && n > 1 ? (n - s) / (n - 1) : 0),
      );
    }
    case 'score': {
      const sum = new Map(ids.map((id) => [id, 0]));
      const cnt = new Map(ids.map((id) => [id, 0]));
      for (const b of ballots as { scores?: Record<string, number> }[]) {
        for (const [k, v] of Object.entries(b.scores ?? {})) {
          const id = Number(k);
          if (!idSet.has(id)) continue;
          sum.set(id, sum.get(id)! + v);
          cnt.set(id, cnt.get(id)! + 1);
        }
      }
      return finish(
        method,
        voters,
        ids.map((id) => {
          const c = cnt.get(id)!;
          const avg = c ? sum.get(id)! / c : 0;
          return { id, title: base(id), score: avg + c / 1e6, label: c ? `${fmtNum(avg)} ★ (${c} ${plural(c, 'ocena', 'oceny', 'ocen')})` : 'brak ocen' };
        }),
        true,
        [],
        (s) => s / 5,
      );
    }
    case 'points': {
      const pts = new Map(ids.map((id) => [id, 0]));
      for (const b of ballots as { points?: Record<string, number> }[])
        for (const [k, v] of Object.entries(b.points ?? {})) if (idSet.has(Number(k))) pts.set(Number(k), pts.get(Number(k))! + v);
      return finish(method, voters, ids.map((id) => ({ id, title: base(id), score: pts.get(id)!, label: `${pts.get(id)} pkt` })), true, []);
    }
    case 'duel': {
      const w = new Map(ids.map((id) => [id, 0]));
      const l = new Map(ids.map((id) => [id, 0]));
      let total = 0;
      for (const b of ballots as { duels?: [number, number][] }[]) {
        for (const [a, c] of b.duels ?? []) {
          if (!idSet.has(a) || !idSet.has(c)) continue;
          w.set(a, w.get(a)! + 1);
          l.set(c, l.get(c)! + 1);
          total++;
        }
      }
      return finish(
        method,
        voters,
        ids.map((id) => {
          const games = w.get(id)! + l.get(id)!;
          const pct = games ? w.get(id)! / games : 0;
          return { id, title: base(id), score: games ? pct + w.get(id)! / 1e6 : -1, label: games ? `${Math.round(pct * 100)}% wygranych (${w.get(id)}/${games})` : 'jeszcze bez pojedynków' };
        }),
        true,
        [`Rozegrano ${total} ${plural(total, 'pojedynek', 'pojedynki', 'pojedynków')}.`],
        (s) => Math.max(0, Math.min(1, s)),
      );
    }
  }
}
