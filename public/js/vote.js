// Głosowanie: 7 sposobów (top3, ranking, approval, score, points, duel, single) + wyniki.
// app.js (ładowany wcześniej) udostępnia window.TM — bez importu, żeby moduł nie załadował się drugi raz pod innym URL
const openLightbox = (src, t) => window.TM?.openLightbox(src, t);

const dataEl = document.getElementById('vote-data');
const D = dataEl ? JSON.parse(dataEl.textContent) : null;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// — małe narzędzia DOM —
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
const byId = new Map((D?.entries ?? []).map((e) => [e.id, e]));
const title = (id) => byId.get(id)?.title ?? '?';
const plural = (n, one, few, many) => {
  if (n === 1) return one;
  const d = n % 10, t = n % 100;
  return d >= 2 && d <= 4 && (t < 12 || t > 14) ? few : many;
};

function thumb(e) {
  if (!e.preview) return null;
  return h(
    'button',
    { type: 'button', class: 'thumb-btn', 'aria-label': `Powiększ podgląd: ${e.title}`, onclick: (ev) => { ev.preventDefault(); openLightbox(e.preview, e.title); } },
    h('img', { class: 'thumb', src: e.preview, alt: '', loading: 'lazy' }),
  );
}

/** Zmienia kolejność istniejących węzłów (bez odtwarzania), z animacją view transition */
function reorder(container, nodes) {
  const move = Object.hasOwn(Element.prototype, 'moveBefore') ? (n) => container.moveBefore(n, null) : (n) => container.append(n);
  const update = () => nodes.forEach(move);
  if (reduceMotion) return update();
  if (container.startViewTransition) container.startViewTransition(update);
  else if (document.startViewTransition) document.startViewTransition(update);
  else update();
}

// — zapis głosu —
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('Błąd połączenia. Spróbuj ponownie.');
  }
  if (!data.ok) throw new Error(data.error || 'Nie udało się zapisać.');
  return data;
}

function statusLine() {
  return h('p', { class: 'status-line', role: 'status' });
}
function setStatus(el, ok, msg) {
  el.className = `status-line ${ok ? 'ok' : 'err'}`;
  el.textContent = '';
  requestAnimationFrame(() => (el.textContent = msg));
}

function markVoted(method) {
  const tab = document.getElementById(`tab-${method}`);
  if (tab && !tab.querySelector('.done-mark')) tab.append(h('span', { class: 'done-mark', 'aria-label': 'oddano głos', text: '✓' }));
}
function unmarkVoted(method) {
  document.getElementById(`tab-${method}`)?.querySelector('.done-mark')?.remove();
}
/** Po wycofaniu głosu: wyniki nadal widoczne (np. admin) albo chowamy je */
function updateResults(method, tally) {
  if (tally) return showResults(method, tally);
  delete D.results[method];
  const box = document.querySelector(`[data-results="${method}"]`);
  if (box) {
    box.hidden = true;
    box.replaceChildren();
  }
}

/** „Wycofaj głos” (zapisany głos: usuwa go z serwera) albo „Wyczyść wybór” (tylko zaznaczenia na ekranie) */
async function clearBallot(m, btn, status) {
  const root = document.querySelector(`[data-ballot="${m}"]`);
  let msg = 'Wyczyszczono wybór.';
  if (D.ballots[m]) {
    const name = D.methods.length > 1 ? D.methods.find((x) => x.id === m)?.name : null;
    if (!confirm(`Wycofać Twój głos${name ? ` w sposobie „${name}”` : ''}? Możesz potem zagłosować od nowa.`)) return;
    btn.setAttribute('aria-disabled', 'true');
    btn.classList.add('busy');
    try {
      const res = await post(`/api/konkursy/${D.contestId}/glos/usun`, { method: m });
      delete D.ballots[m];
      unmarkVoted(m);
      updateResults(m, res.results);
      msg = 'Głos wycofany. Możesz zagłosować od nowa.';
    } catch (err) {
      btn.removeAttribute('aria-disabled');
      btn.classList.remove('busy');
      return setStatus(status, false, err.message);
    }
  }
  RENDER[m](root, m);
  const fresh = root.querySelector('.status-line');
  if (fresh) setStatus(fresh, true, msg);
}

async function saveBallot(method, data, btn, status) {
  btn.setAttribute('aria-disabled', 'true');
  btn.classList.add('busy');
  try {
    const res = await post(`/api/konkursy/${D.contestId}/glos`, { method, data });
    D.ballots[method] = res.data;
    markVoted(method);
    setStatus(status, true, res.results ? 'Głos zapisany ✓ Wyniki poniżej.' : 'Głos zapisany ✓ Wyniki poznamy po zakończeniu głosowania.');
    if (res.results) showResults(method, res.results);
    btn.textContent = 'Zmień głos';
    const clear = btn.parentElement?.querySelector('[data-clear]');
    if (clear) clear.textContent = 'Wycofaj głos';
  } catch (err) {
    setStatus(status, false, err.message);
  } finally {
    btn.removeAttribute('aria-disabled');
    btn.classList.remove('busy');
  }
}

function saveButton(m, label, onSave) {
  const status = statusLine();
  const btn = h('button', { type: 'button', class: 'btn', text: label });
  btn.addEventListener('click', () => {
    if (btn.getAttribute('aria-disabled') === 'true') return;
    onSave(btn, status);
  });
  const clear = h('button', { type: 'button', class: 'btn ghost', 'data-clear': true, text: D.ballots[m] ? 'Wycofaj głos' : 'Wyczyść wybór' });
  clear.addEventListener('click', () => {
    if (clear.getAttribute('aria-disabled') === 'true') return;
    clearBallot(m, clear, status);
  });
  return { btn, status, row: h('div', { class: 'actions' }, btn, clear, status) };
}

// — 1. Jeden głos —
function renderSingle(root, m) {
  const name = `single-${D.contestId}`;
  let choice = D.ballots[m]?.choice ?? null;
  const list = h(
    'ul',
    { class: 'opts' },
    D.entries.map((e) =>
      h(
        'li',
        { class: 'opt' },
        thumb(e),
        h(
          'label',
          {},
          h('input', { type: 'radio', name, value: e.id, checked: choice === e.id, onchange: () => (choice = e.id) }),
          h('span', { class: 'txt', text: e.title }),
        ),
      ),
    ),
  );
  const fs = h('fieldset', { style: 'border:0;margin:0;padding:0' }, h('legend', { class: 'visually-hidden', text: 'Wybierz jedną propozycję' }), list);
  const { row, status } = saveButton(m, D.ballots[m] ? 'Zmień głos' : 'Zapisz głos', (btn) => {
    if (choice === null) return setStatus(status, false, 'Wybierz jedną propozycję.');
    saveBallot(m, { choice }, btn, status);
  });
  root.replaceChildren(fs, row);
}

// — 2. Podium (top 3) —
function renderTop3(root, m) {
  const need = Math.min(3, D.entries.length);
  const podium = [...(D.ballots[m]?.podium ?? [])];
  while (podium.length < need) podium.push(null);
  const slotsEl = h('div', { class: 'podium', 'aria-label': 'Twoje podium' });
  const announce = h('p', { class: 'visually-hidden', role: 'status' });
  const placeBtns = new Map();

  function paint() {
    slotsEl.replaceChildren(
      ...podium.slice(0, need).map((id, i) =>
        h(
          'div',
          { class: `slot${id ? ' filled' : ''}` },
          h('b', { text: `${i + 1}. miejsce · ${3 - i} pkt` }),
          h('span', { text: id ? title(id) : 'nie wybrano' }),
          id ? h('button', { type: 'button', class: 'linkbtn', text: 'Usuń', 'aria-label': `Usuń z ${i + 1}. miejsca: ${title(id)}`, onclick: () => set(id, i) }) : null,
        ),
      ),
    );
    for (const [id, btns] of placeBtns) btns.forEach((b, i) => b.setAttribute('aria-pressed', String(podium[i] === id)));
  }
  function set(id, place) {
    if (podium[place] === id) {
      podium[place] = null;
      announce.textContent = `Usunięto z ${place + 1}. miejsca: ${title(id)}`;
    } else {
      const prev = podium.indexOf(id);
      if (prev >= 0) podium[prev] = null;
      podium[place] = id;
      announce.textContent = `${place + 1}. miejsce: ${title(id)}`;
    }
    paint();
  }
  const list = h(
    'ul',
    { class: 'opts' },
    D.entries.map((e) => {
      const btns = Array.from({ length: need }, (_, i) =>
        h('button', { type: 'button', text: String(i + 1), 'aria-label': `${i + 1}. miejsce: ${e.title}`, 'aria-pressed': 'false', onclick: () => set(e.id, i) }),
      );
      placeBtns.set(e.id, btns);
      return h('li', { class: 'opt' }, thumb(e), h('span', { class: 'txt', text: e.title }), h('span', { class: 'place-btns' }, btns));
    }),
  );
  const { row, status } = saveButton(m, D.ballots[m] ? 'Zmień głos' : 'Zapisz głos', (btn) => {
    if (podium.slice(0, need).some((x) => x === null)) return setStatus(status, false, `Uzupełnij wszystkie ${need} miejsca na podium.`);
    saveBallot(m, { podium: podium.slice(0, need) }, btn, status);
  });
  paint();
  root.replaceChildren(h('p', { class: 'muted small', text: 'Kliknij 1, 2 lub 3 przy propozycji, żeby postawić ją na podium.' }), slotsEl, list, announce, row);
}

// — 3. Aprobata —
function renderApproval(root, m) {
  const chosen = new Set(D.ballots[m]?.approved ?? []);
  const counter = h('p', { class: 'muted small', 'aria-live': 'polite' });
  const paintCount = () => (counter.textContent = `Zaznaczono: ${chosen.size} z ${D.entries.length}`);
  const list = h(
    'ul',
    { class: 'opts' },
    D.entries.map((e) =>
      h(
        'li',
        { class: 'opt' },
        thumb(e),
        h(
          'label',
          {},
          h('input', {
            type: 'checkbox',
            value: e.id,
            checked: chosen.has(e.id),
            onchange: (ev) => {
              ev.target.checked ? chosen.add(e.id) : chosen.delete(e.id);
              paintCount();
            },
          }),
          h('span', { class: 'txt', text: e.title }),
        ),
      ),
    ),
  );
  const fs = h('fieldset', { style: 'border:0;margin:0;padding:0' }, h('legend', { class: 'visually-hidden', text: 'Zaznacz propozycje, które Ci odpowiadają' }), list);
  const { row, status } = saveButton(m, D.ballots[m] ? 'Zmień głos' : 'Zapisz głos', (btn) => {
    if (!chosen.size) return setStatus(status, false, 'Zaznacz przynajmniej jedną propozycję.');
    saveBallot(m, { approved: [...chosen] }, btn, status);
  });
  paintCount();
  root.replaceChildren(fs, counter, row);
}

// — 4. Pełny ranking —
function renderRanking(root, m) {
  const saved = (D.ballots[m]?.order ?? []).filter((id) => byId.has(id));
  const order = [...saved];
  const rankList = h('ol', { class: 'rank-list', 'aria-label': 'Twój ranking' });
  const pool = h('ul', { class: 'pool-list', 'aria-label': 'Propozycje do uszeregowania' });
  const poolEmpty = h('p', { class: 'empty-note', text: 'Wszystko uszeregowane 👍' });
  const rankEmpty = h('p', { class: 'empty-note', text: 'Kliknij propozycje po prawej (na telefonie: poniżej) w kolejności od najlepszej.' });
  const announce = h('p', { class: 'visually-hidden', role: 'status' });
  const rankNodes = new Map();
  const poolNodes = new Map();
  let announceTimer;
  const say = (msg) => {
    clearTimeout(announceTimer);
    announce.textContent = '';
    announceTimer = setTimeout(() => (announce.textContent = msg), Object.hasOwn(Element.prototype, 'moveBefore') ? 50 : 500);
  };

  function rankNode(id) {
    const up = h('button', { type: 'button', text: '↑', 'aria-label': `Przesuń wyżej: ${title(id)}`, onclick: () => move(id, -1, up) });
    const down = h('button', { type: 'button', text: '↓', 'aria-label': `Przesuń niżej: ${title(id)}`, onclick: () => move(id, 1, down) });
    const del = h('button', { type: 'button', text: '✕', 'aria-label': `Usuń z rankingu: ${title(id)}`, onclick: () => unrank(id) });
    const li = h('li', { 'data-id': id }, h('span', { class: 'txt', text: title(id) }), h('span', { class: 'move-btns' }, up, down, del));
    li._btns = { up, down };
    return li;
  }
  function poolNode(id) {
    const e = byId.get(id);
    return h(
      'li',
      { 'data-id': id },
      h('button', { type: 'button', class: 'pick', 'aria-label': `Dodaj na miejsce: ${e.title}`, onclick: () => rank(id) }, h('span', { class: 'plus', 'aria-hidden': 'true', text: '+' }), h('span', { text: e.title })),
    );
  }
  function syncButtons() {
    order.forEach((id, i) => {
      const { up, down } = rankNodes.get(id)._btns;
      up.disabled = i === 0;
      down.disabled = i === order.length - 1;
    });
    rankEmpty.hidden = order.length > 0;
    poolEmpty.hidden = order.length < D.entries.length;
  }
  function rank(id) {
    order.push(id);
    const li = rankNode(id);
    rankNodes.set(id, li);
    rankList.append(li);
    const pn = poolNodes.get(id);
    // fokus na następną propozycję z puli, żeby dało się szybko klikać dalej
    const nextPick = (pn.nextElementSibling || pn.previousElementSibling)?.querySelector('button');
    pn.remove();
    poolNodes.delete(id);
    syncButtons();
    (nextPick || rankList.lastElementChild.querySelector('button')).focus({ preventScroll: true });
    say(`${title(id)}: miejsce ${order.length}.`);
  }
  function unrank(id) {
    const i = order.indexOf(id);
    order.splice(i, 1);
    const li = rankNodes.get(id);
    const focusNext = (li.nextElementSibling || li.previousElementSibling)?.querySelector('button');
    li.remove();
    rankNodes.delete(id);
    const pn = poolNode(id);
    poolNodes.set(id, pn);
    // wracamy do puli w pierwotnej kolejności
    const ids = D.entries.map((e) => e.id).filter((x) => poolNodes.has(x));
    const after = ids.slice(ids.indexOf(id) + 1).find((x) => poolNodes.get(x).isConnected);
    after ? poolNodes.get(after).before(pn) : pool.append(pn);
    syncButtons();
    (focusNext || pn.querySelector('button')).focus({ preventScroll: true });
    say(`Usunięto z rankingu: ${title(id)}.`);
  }
  function move(id, dir, btn) {
    const i = order.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    reorder(rankList, order.map((x) => rankNodes.get(x)));
    syncButtons();
    const li = rankNodes.get(id);
    li.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const target = btn.disabled ? (dir < 0 ? li._btns.down : li._btns.up) : btn;
    target.focus({ preventScroll: true });
    say(`${title(id)}: teraz miejsce ${j + 1} z ${order.length}.`);
  }

  for (const id of order) {
    const li = rankNode(id);
    rankNodes.set(id, li);
    rankList.append(li);
  }
  for (const e of D.entries) {
    if (order.includes(e.id)) continue;
    const pn = poolNode(e.id);
    poolNodes.set(e.id, pn);
    pool.append(pn);
  }
  const addRest = h('button', {
    type: 'button',
    class: 'btn ghost small',
    text: 'Dodaj pozostałe na koniec',
    onclick: () => [...poolNodes.keys()].forEach((id) => rank(id)),
  });
  const { row, status } = saveButton(m, D.ballots[m] ? 'Zmień głos' : 'Zapisz ranking', (btn) => {
    if (order.length !== D.entries.length) return setStatus(status, false, `Uszereguj wszystkie propozycje (brakuje ${D.entries.length - order.length}).`);
    saveBallot(m, { order: [...order] }, btn, status);
  });
  syncButtons();
  root.replaceChildren(
    h(
      'div',
      { class: 'rank-cols' },
      h('div', {}, h('h3', { text: 'Twój ranking' }), rankEmpty, rankList),
      h('div', {}, h('h3', { text: 'Do uszeregowania' }), poolEmpty, pool, h('p', { style: 'margin-top:10px' }, addRest)),
    ),
    announce,
    row,
  );
}

// — 5. Gwiazdki —
function renderScore(root, m) {
  const scores = { ...(D.ballots[m]?.scores ?? {}) };
  const progress = h('p', { class: 'muted small', 'aria-live': 'polite' });
  const paint = () => {
    const n = D.entries.filter((e) => scores[e.id]).length;
    progress.textContent = `Oceniono: ${n} z ${D.entries.length}`;
  };
  const rows = D.entries.map((e) => {
    const name = `score-${e.id}`;
    const val = h('span', { class: 'stars-val', text: scores[e.id] ? `${scores[e.id]} / 5` : '' });
    const stars = h('span', { class: 'stars' });
    for (let v = 1; v <= 5; v++) {
      const id = `${name}-${v}`;
      stars.append(
        h('input', {
          type: 'radio',
          id,
          name,
          value: v,
          checked: scores[e.id] === v,
          onchange: () => {
            scores[e.id] = v;
            val.textContent = `${v} / 5`;
            paint();
          },
        }),
        h('label', { for: id, title: `${v} z 5` }, h('span', { 'aria-hidden': 'true', text: '★' }), h('span', { class: 'visually-hidden', text: `${v} z 5` })),
      );
    }
    return h('fieldset', { class: 'stars-row' }, h('legend', { text: e.title }), thumb(e), stars, val);
  });
  const { row, status } = saveButton(m, D.ballots[m] ? 'Zmień oceny' : 'Zapisz oceny', (btn) => {
    const missing = D.entries.filter((e) => !scores[e.id]).length;
    if (missing) return setStatus(status, false, `Oceń wszystkie propozycje (brakuje ${missing}).`);
    saveBallot(m, { scores }, btn, status);
  });
  paint();
  root.replaceChildren(h('div', { class: 'stack', style: '--gap:10px' }, rows), progress, row);
}

// — 6. Rozdaj punkty —
function renderPoints(root, m) {
  const budget = D.budget;
  const pts = Object.fromEntries(D.entries.map((e) => [e.id, D.ballots[m]?.points?.[e.id] ?? 0]));
  const left = () => budget - Object.values(pts).reduce((a, b) => a + b, 0);
  const prog = h('progress', { max: budget, value: 0, 'aria-label': 'Rozdane punkty' });
  const leftText = h('span', { 'aria-live': 'polite' });
  const bar = h('div', { class: 'budget' }, leftText, prog);
  const controls = [];
  function paint() {
    const l = left();
    prog.value = budget - l;
    leftText.textContent = l === 0 ? 'Rozdano wszystkie punkty ✓' : `Zostało ${l} ${plural(l, 'punkt', 'punkty', 'punktów')} z ${budget}`;
    for (const c of controls) {
      c.out.value = pts[c.id];
      c.minus.disabled = pts[c.id] === 0;
      c.plus.disabled = l === 0;
    }
  }
  const list = h(
    'ul',
    { class: 'opts' },
    D.entries.map((e) => {
      const out = h('output', { 'aria-label': `Punkty: ${e.title}` });
      const minus = h('button', { type: 'button', text: '−', 'aria-label': `Odejmij punkt: ${e.title}`, onclick: () => { pts[e.id]--; paint(); } });
      const plus = h('button', { type: 'button', text: '+', 'aria-label': `Dodaj punkt: ${e.title}`, onclick: () => { pts[e.id]++; paint(); } });
      controls.push({ id: e.id, out, minus, plus });
      return h('li', { class: 'opt' }, thumb(e), h('span', { class: 'txt', text: e.title }), h('span', { class: 'stepper' }, minus, out, plus));
    }),
  );
  const { row, status } = saveButton(m, D.ballots[m] ? 'Zmień głos' : 'Zapisz punkty', (btn) => {
    const l = left();
    if (l !== 0) return setStatus(status, false, `Rozdaj dokładnie ${budget} pkt (zostało ${l}).`);
    saveBallot(m, { points: Object.fromEntries(Object.entries(pts).filter(([, v]) => v > 0)) }, btn, status);
  });
  paint();
  root.replaceChildren(bar, list, row);
}

// — 7. Pojedynki —
function renderDuel(root, m) {
  const ids = D.entries.map((e) => e.id);
  const all = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) all.push([ids[i], ids[j]]);
  const key = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  let done = new Set((D.ballots[m]?.duels ?? []).map(([a, b]) => key(a, b)));
  const skipped = new Set();
  const arena = h('div', { class: 'duel' });
  const prog = h('progress', { max: all.length, value: 0, 'aria-label': 'Postęp pojedynków' });
  const info = h('span');
  const status = statusLine();
  const skipBtn = h('button', { type: 'button', class: 'btn ghost small', text: 'Pomiń tę parę', onclick: () => next(true) });
  const resetBtn = h('button', {
    type: 'button',
    class: 'btn ghost small',
    text: 'Zacznij od nowa',
    onclick: async () => {
      if (!confirm('Usunąć Twoje dotychczasowe pojedynki i zacząć od nowa?')) return;
      try {
        const res = await post(`/api/konkursy/${D.contestId}/glos/usun`, { method: m });
        done = new Set();
        skipped.clear();
        delete D.ballots[m];
        unmarkVoted(m);
        updateResults(m, res.results);
        next();
      } catch (err) {
        setStatus(status, false, err.message);
      }
    },
  });
  let current = null;

  function pick() {
    // najpierw pary nieporównane i niepominięte, preferując propozycje, które rzadziej się pojawiały
    let pool = all.filter(([a, b]) => !done.has(key(a, b)) && !skipped.has(key(a, b)));
    if (!pool.length) {
      skipped.clear();
      pool = all.filter(([a, b]) => !done.has(key(a, b)));
    }
    if (!pool.length) return null;
    const seen = new Map(ids.map((id) => [id, 0]));
    for (const k of done) for (const id of k.split('-').map(Number)) seen.set(id, (seen.get(id) ?? 0) + 1);
    pool.sort((p, q) => seen.get(p[0]) + seen.get(p[1]) - (seen.get(q[0]) + seen.get(q[1])));
    const top = pool.filter((p) => seen.get(p[0]) + seen.get(p[1]) === seen.get(pool[0][0]) + seen.get(pool[0][1]));
    const pair = top[Math.floor(Math.random() * top.length)];
    return Math.random() < 0.5 ? pair : [pair[1], pair[0]];
  }
  function side(id, other) {
    const e = byId.get(id);
    return h(
      'button',
      { type: 'button', class: 'side', 'aria-label': `Lepsze: ${e.title}`, onclick: () => choose(id, other) },
      e.preview ? h('img', { src: e.preview, alt: '' }) : null,
      h('span', { text: e.title }),
    );
  }
  function paintMeta() {
    prog.value = done.size;
    info.textContent = `Porównano ${done.size} z ${all.length} ${plural(all.length, 'pary', 'par', 'par')}`;
  }
  function next(skip = false) {
    if (skip && current) skipped.add(key(...current));
    current = pick();
    paintMeta();
    if (!current) {
      arena.replaceChildren(h('p', { class: 'empty-note', style: 'grid-column:1/-1', text: 'Porównano wszystkie pary, dziękujemy! 🎉 Wynik zapisuje się na bieżąco.' }));
      skipBtn.hidden = true;
      return;
    }
    skipBtn.hidden = false;
    const [a, b] = current;
    arena.replaceChildren(side(a, b), h('span', { class: 'vs', text: 'vs' }), side(b, a));
  }
  async function choose(winner, loser) {
    arena.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      const res = await post(`/api/konkursy/${D.contestId}/pojedynek`, { winner, loser });
      D.ballots[m] = res.data;
      done.add(key(winner, loser));
      markVoted(m);
      setStatus(status, true, `Zapisano: „${title(winner)}” lepsze od „${title(loser)}”.`);
      if (res.results) showResults(m, res.results);
      next();
      arena.querySelector('button')?.focus({ preventScroll: true });
    } catch (err) {
      setStatus(status, false, err.message);
      arena.querySelectorAll('button').forEach((b) => (b.disabled = false));
    }
  }
  next();
  root.replaceChildren(arena, h('div', { class: 'duel-meta' }, info, prog, skipBtn, resetBtn), status);
}

// — wyniki —
function resultsEl(tally, heading) {
  const wrap = h('div', {}, h('h3', { text: heading }), h('p', { class: 'muted small' }, 'Głosujących: ', h('strong', { text: String(tally.voters) })));
  if (!tally.voters) {
    wrap.append(h('p', { class: 'empty-note', text: 'Nikt jeszcze nie zagłosował tym sposobem.' }));
    return wrap;
  }
  wrap.append(
    h(
      'ol',
      { class: 'results' },
      tally.rows.map((r) =>
        h(
          'li',
          {},
          h('span', { class: 'place', 'aria-label': `Miejsce ${r.rank}`, text: String(r.rank) }),
          h('span', { class: 'name' }, h('span', { text: r.title }), h('small', { text: r.label })),
          h('span', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: `width:${Math.round(r.bar * 100)}%` })),
        ),
      ),
    ),
  );
  if (tally.notes?.length) wrap.append(h('ul', { class: 'res-notes' }, tally.notes.map((n) => h('li', { text: n }))));
  return wrap;
}
function showResults(method, tally) {
  D.results[method] = tally;
  const box = document.querySelector(`[data-results="${method}"]`);
  if (!box) return;
  box.hidden = false;
  box.replaceChildren(resultsEl(tally, 'Wyniki na żywo'));
}

// — zakładki (tryb testowy): ARIA tabs, wybór podąża za fokusem —
function initTabs() {
  const tablist = document.querySelector('#vote-app [role="tablist"]');
  if (!tablist) return;
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];
  const select = (tab, focus = true) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(`panel-${t.dataset.method}`).hidden = !on;
    }
    if (focus) tab.focus();
    tab.scrollIntoView({ block: 'nearest', inline: 'nearest', container: 'nearest' });
    try {
      history.replaceState(null, '', `#${tab.dataset.method}`);
    } catch {}
  };
  tablist.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) select(tab);
  });
  tablist.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    select(tabs[(to + tabs.length) % tabs.length]);
  });
  const fromHash = tabs.find((t) => `#${t.dataset.method}` === location.hash);
  if (fromHash) select(fromHash, false);
}

const RENDER = { single: renderSingle, top3: renderTop3, approval: renderApproval, ranking: renderRanking, score: renderScore, points: renderPoints, duel: renderDuel };

if (D) {
  if (D.phase === 'closed') {
    for (const el of document.querySelectorAll('[data-static-results]')) {
      const m = el.dataset.staticResults;
      if (D.results[m]) el.replaceChildren(resultsEl(D.results[m], D.methods.length > 1 ? D.methods.find((x) => x.id === m)?.name ?? m : 'Wyniki'));
    }
  } else {
    for (const el of document.querySelectorAll('[data-ballot]')) {
      const m = el.dataset.ballot;
      RENDER[m]?.(el, m);
      if (D.results[m]) showResults(m, D.results[m]);
    }
    initTabs();
  }
}
