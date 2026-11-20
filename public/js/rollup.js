// Analiza projektu rollupu w przeglądarce (PDF / SVG / JPG / PNG / WebP) + wysyłka w kawałkach + ocena AI.
// Analiza działa lokalnie — darmowy plan Workers ma tylko 10 ms CPU na żądanie, więc serwer tylko przechowuje pliki.

const cfgEl = document.getElementById('rollup-data');
const CFG = cfgEl ? JSON.parse(cfgEl.textContent) : null;
const app = document.getElementById('rollup-app');
const VENDOR = '/vendor/pdfjs/';

const BRAND = [
  { name: 'Loyal Blue', hex: '#004165', kind: 'brand' },
  { name: 'Blissful Blue', hex: '#006094', kind: 'brand' },
  { name: 'True Maroon', hex: '#772432', kind: 'brand' },
  { name: 'Rich Maroon', hex: '#781327', kind: 'brand' },
  { name: 'Deep Maroon', hex: '#3B0104', kind: 'brand' },
  { name: 'Cool Gray', hex: '#A9B2B1', kind: 'brand' },
  { name: 'Fair Gray', hex: '#F5F5F5', kind: 'brand' },
  { name: 'Happy Yellow', hex: '#F2DF74', kind: 'brand' },
  { name: 'biel', hex: '#FFFFFF', kind: 'neutral' },
  { name: 'czerń', hex: '#000000', kind: 'neutral' },
];

const fmt = (n, d = 0) => n.toFixed(d).replace('.', ',');
const fmtMB = (b) => `${fmt(b / 1024 / 1024, 1)} MB`;

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

// ——— kolory ———
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToLab([r, g, b]) {
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = f(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const BRAND_LAB = BRAND.map((b) => ({ ...b, lab: rgbToLab(hexToRgb(b.hex)) }));
function nearestBrand(rgb) {
  const lab = rgbToLab(rgb);
  let best = null;
  let bestD = Infinity;
  for (const b of BRAND_LAB) {
    const d = Math.hypot(lab[0] - b.lab[0], lab[1] - b.lab[1], lab[2] - b.lab[2]);
    if (d < bestD) [best, bestD] = [b, d];
  }
  // neutralne szarości (niskie nasycenie) też traktujemy jako neutralne
  const isGray = Math.hypot(lab[1], lab[2]) < 6;
  return { brand: best, dist: bestD, isGray };
}
function colorStats(canvas) {
  const W = 120;
  const H = Math.max(1, Math.round((canvas.height / canvas.width) * W));
  const small = new OffscreenCanvas(W, H);
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, W, H);
  const px = ctx.getImageData(0, 0, W, H).data;
  const bins = new Map();
  let total = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 128) continue;
    const key = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
    bins.set(key, (bins.get(key) ?? 0) + 1);
    total++;
  }
  let brand = 0;
  let neutral = 0;
  const groups = new Map();
  for (const [key, count] of bins) {
    const rgb = [((key >> 8) & 15) * 17, ((key >> 4) & 15) * 17, (key & 15) * 17];
    const nb = nearestBrand(rgb);
    let label;
    if (nb.dist < 14) {
      if (nb.brand.kind === 'brand') brand += count;
      else neutral += count;
      label = nb.brand.hex;
    } else if (nb.isGray) {
      neutral += count;
      label = `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
    } else {
      label = `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
    }
    groups.set(label, (groups.get(label) ?? 0) + count);
  }
  const top = [...groups]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([hex, n]) => {
      const nb = nearestBrand(hexToRgb(hex));
      return { hex: hex.toUpperCase(), share: n / total, brand: nb.dist < 14 ? nb.brand.name : null };
    });
  return { brandShare: brand / total, neutralShare: neutral / total, otherShare: 1 - (brand + neutral) / total, top };
}

// ——— podgląd ———
async function canvasToJpeg(canvas, quality = 0.85) {
  const c = canvas instanceof OffscreenCanvas ? canvas : canvas;
  if (c.convertToBlob) return c.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
}
function whiteCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}
const PREVIEW_H = 1600;

// ——— wspólna ocena wymiarów i DPI ———
function sizeChecks(wMM, hMM, checks, { knownPhysical = true } = {}) {
  const W = CFG.settings.width_mm;
  const H = CFG.settings.height_mm;
  const out = { w_mm: wMM, h_mm: hMM, scale: 1 };
  if (wMM > hMM) {
    checks.push({ level: 'err', title: 'Projekt jest poziomy', detail: `Rollup jest pionowy (${W / 10} × ${H / 10} cm). Obróć projekt.` });
    return out;
  }
  // skala: 1:1, 1:2, 1:5 albo 1:10 — dobieramy po szerokości
  let scale = W / wMM;
  const std = [1, 2, 5, 10].find((k) => Math.abs((wMM * k) / W - 1) < 0.04);
  if (std) scale = std;
  out.scale = scale;
  const realW = wMM * scale;
  const realH = hMM * scale;
  const ratio = hMM / wMM;
  const expected = H / W;
  if (knownPhysical) {
    const label = std ? (std === 1 ? 'skala 1:1' : `skala 1:${std}`) : `niestandardowa skala (×${fmt(scale, 2)})`;
    checks.push({
      level: std ? 'ok' : 'warn',
      title: `Wymiar w pliku: ${fmt(wMM / 10, 1)} × ${fmt(hMM / 10, 1)} cm (${label})`,
      detail: std
        ? `Po przeskalowaniu: ${fmt(realW / 10, 1)} × ${fmt(realH / 10, 1)} cm.`
        : `Szerokość nie pasuje do ${W / 10} cm ani do skali 1:10. Drukarnia przeskaluje plik, upewnij się, że to zamierzone.`,
    });
  }
  if (ratio < expected * 0.985) {
    checks.push({
      level: 'err',
      title: 'Złe proporcje: projekt jest za niski',
      detail: `Proporcje ${fmt(1, 0)} : ${fmt(ratio, 2)}, a rollup ${W / 10} × ${H / 10} cm to 1 : ${fmt(expected, 2)}. Po rozciągnięciu na szerokość ${W / 10} cm wysokość wyniosłaby ${fmt((ratio * W) / 10, 1)} cm.`,
    });
  } else if (ratio > ((H + 150) / W) * 1.01) {
    checks.push({
      level: 'err',
      title: 'Złe proporcje: projekt jest za wysoki',
      detail: `Po dopasowaniu do szerokości ${W / 10} cm wysokość wyniosłaby ${fmt((ratio * W) / 10, 1)} cm zamiast ${H / 10} cm.`,
    });
  } else if (ratio > expected * 1.015) {
    checks.push({
      level: 'info',
      title: `Projekt jest wyższy niż ${H / 10} cm (${fmt((ratio * W) / 10, 1)} cm)`,
      detail: 'To w porządku, jeśli to zapas na kasetę stojaka albo spady, ale sprawdź wymagania drukarni.',
    });
  } else {
    checks.push({ level: 'ok', title: 'Proporcje pasują do rollupu', detail: `1 : ${fmt(ratio, 3)} (rollup: 1 : ${fmt(expected, 3)}).` });
  }
  return out;
}

function dpiLevel(dpi) {
  if (dpi >= 150) return 'ok';
  if (dpi >= 100) return 'ok';
  if (dpi >= 72) return 'warn';
  return 'err';
}
function dpiText(dpi) {
  if (dpi >= 150) return 'świetna jakość';
  if (dpi >= 100) return 'wystarczy na rollup oglądany z 1-3 m';
  if (dpi >= 72) return 'słabo, z bliska widać piksele';
  return 'za mała rozdzielczość, wydruk będzie rozmazany';
}

// ——— PDF ———
let pdfjsPromise = null;
function loadPdfjs() {
  pdfjsPromise ??= import(`${VENDOR}pdf.min.mjs`).then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = `${VENDOR}pdf.worker.min.mjs`;
    return lib;
  });
  return pdfjsPromise;
}

function mul(m, n) {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}

async function analyzePdf(file, checks) {
  const lib = await loadPdfjs();
  const task = lib.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    isEvalSupported: false,
    fontExtraProperties: true,
    wasmUrl: `${VENDOR}wasm/`,
    cMapUrl: `${VENDOR}cmaps/`,
    standardFontDataUrl: `${VENDOR}standard_fonts/`,
    iccUrl: `${VENDOR}iccs/`,
  });
  const doc = await task.promise;
  try {
    if (doc.numPages > 1) checks.push({ level: 'warn', title: `Plik ma ${doc.numPages} strony`, detail: 'Rollup to jedna strona, sprawdzamy tylko pierwszą.' });
    const page = await doc.getPage(1);
    const [x0, y0, x1, y1] = page.view;
    const uu = page.userUnit || 1;
    let wPt = (x1 - x0) * uu;
    let hPt = (y1 - y0) * uu;
    if (page.rotate % 180 !== 0) [wPt, hPt] = [hPt, wPt];
    const ptToMm = 25.4 / 72;
    const size = sizeChecks(wPt * ptToMm, hPt * ptToMm, checks);

    // obrazy rastrowe i czcionki z listy operatorów
    const ops = await page.getOperatorList();
    const { OPS } = lib;
    let ctm = [uu, 0, 0, uu, 0, 0];
    const stack = [];
    const images = [];
    const fontRefs = new Set();
    const pageArea = wPt * hPt;
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.transform) ctm = mul(ctm, args);
      else if (fn === OPS.paintFormXObjectBegin) {
        stack.push(ctm);
        if (args?.[0]) ctm = mul(ctm, args[0]);
      } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.setFont) fontRefs.add(args[0]);
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
        const pxW = fn === OPS.paintImageXObject ? args[1] : args[0]?.width;
        const pxH = fn === OPS.paintImageXObject ? args[2] : args[0]?.height;
        if (!pxW || !pxH) continue;
        const dispW = Math.hypot(ctm[0], ctm[1]);
        const dispH = Math.hypot(ctm[2], ctm[3]);
        if (dispW < 1 || dispH < 1) continue;
        const realInW = (dispW / 72) * size.scale;
        const realInH = (dispH / 72) * size.scale;
        const dpi = Math.min(pxW / realInW, pxH / realInH);
        images.push({ pxW, pxH, dpi, area: Math.min(1, (dispW * dispH) / pageArea) });
      }
    }
    const relevant = images.filter((im) => im.area >= 0.005);
    if (!relevant.length) {
      checks.push({ level: 'ok', title: 'Brak zdjęć/grafik rastrowych', detail: 'Projekt jest wektorowy, wydrukuje się ostro w każdym rozmiarze.' });
    } else {
      relevant.sort((a, b) => a.dpi - b.dpi);
      const big = relevant.filter((im) => im.area >= 0.15);
      const worstBig = big[0];
      const worst = relevant[0];
      const lvl = worstBig ? dpiLevel(worstBig.dpi) : worst.dpi < 100 ? 'warn' : 'ok';
      checks.push({
        level: lvl,
        title: `Grafiki rastrowe: ${relevant.length}, najniższa rozdzielczość ${Math.round(worst.dpi)} DPI`,
        detail:
          `W skali 1:1 (${CFG.settings.width_mm / 10} × ${CFG.settings.height_mm / 10} cm): ${dpiText(worst.dpi)}. ` +
          relevant
            .slice(0, 3)
            .map((im) => `${im.pxW}×${im.pxH} px na ${Math.round(im.area * 100)}% powierzchni → ${Math.round(im.dpi)} DPI`)
            .join('; ') +
          (lvl !== 'ok' ? '. Użyj zdjęć w wyższej rozdzielczości albo grafik wektorowych (logo najlepiej jako wektor).' : '.'),
      });
    }

    const text = await page.getTextContent();
    const fonts = [];
    for (const ref of fontRefs) {
      try {
        if (!page.commonObjs.has(ref)) continue;
        const f = page.commonObjs.get(ref);
        fonts.push({ name: String(f.name || f.loadedName || ref).replace(/^[A-Z]{6}\+/, ''), missing: Boolean(f.missingFile), type3: Boolean(f.isType3Font) });
      } catch {}
    }
    const missing = fonts.filter((f) => f.missing);
    if (missing.length) {
      checks.push({
        level: 'err',
        title: `Nieosadzone czcionki: ${missing.map((f) => f.name).join(', ')}`,
        detail: 'Drukarnia może ich nie mieć i podstawi inne. Przy eksporcie PDF osadź czcionki albo zamień tekst na krzywe.',
      });
    } else if (fonts.length) {
      checks.push({ level: 'ok', title: 'Czcionki osadzone w pliku', detail: [...new Set(fonts.map((f) => f.name))].slice(0, 8).join(', ') });
    } else if (text.items.length === 0) {
      checks.push({ level: 'ok', title: 'Tekst zamieniony na krzywe', detail: 'Nie ma problemu z czcionkami w drukarni.' });
    }
    const names = fonts.map((f) => f.name.toLowerCase()).join(' ');
    if (fonts.length && !/gotham|montserrat|myriad|source ?sans|sourcesans|arial|segoe/.test(names)) {
      checks.push({ level: 'warn', title: 'Czcionki spoza brand manuala', detail: 'Nagłówki: Gotham lub Montserrat, tekst: Myriad Pro lub Source Sans 3 (ew. Arial / Segoe UI).' });
    }

    // podgląd
    // getViewport sam uwzględnia userUnit, a hPt już go zawiera
    const scale = PREVIEW_H / hPt;
    const viewport = page.getViewport({ scale });
    const { canvas } = whiteCanvas(viewport.width, viewport.height);
    await page.render({ canvas, viewport }).promise;
    return { canvas, meta: { kind: 'pdf', pages: doc.numPages, w_mm: size.w_mm, h_mm: size.h_mm, scale: size.scale, images: relevant.length, min_dpi: relevant[0] ? Math.round(relevant[0].dpi) : null, fonts: fonts.map((f) => f.name).slice(0, 10) } };
  } finally {
    task.destroy();
  }
}

// ——— SVG ———
const UNIT_MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96 };
function lenToMm(v) {
  const m = String(v ?? '').trim().match(/^([\d.]+)\s*(mm|cm|in|pt|pc|px)?$/i);
  if (!m) return null;
  return { mm: parseFloat(m[1]) * UNIT_MM[(m[2] || '').toLowerCase()], unit: (m[2] || 'px').toLowerCase() };
}
function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Nie udało się wczytać obrazu.'));
    img.src = src;
  });
}

async function analyzeSvg(file, checks) {
  const text = await file.text();
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement;
  if (doc.querySelector('parsererror') || svg.nodeName.toLowerCase() !== 'svg') throw new Error('Plik SVG jest uszkodzony.');
  const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  const wAttr = lenToMm(svg.getAttribute('width'));
  const hAttr = lenToMm(svg.getAttribute('height'));
  let vbW = vb.length === 4 ? vb[2] : null;
  let vbH = vb.length === 4 ? vb[3] : null;
  const physical = wAttr && hAttr && wAttr.unit !== 'px' && hAttr.unit !== 'px';
  const wMM = physical ? wAttr.mm : (vbW ?? wAttr?.mm ?? 0);
  const hMM = physical ? hAttr.mm : (vbH ?? hAttr?.mm ?? 0);
  if (!wMM || !hMM) throw new Error('SVG nie ma wymiarów (width/height ani viewBox).');
  vbW ??= wMM;
  vbH ??= hMM;
  const size = sizeChecks(wMM, hMM, checks, { knownPhysical: physical });
  if (!physical) checks.push({ level: 'info', title: 'SVG bez jednostek fizycznych', detail: 'To grafika wektorowa: rozmiar nie ma znaczenia, liczą się proporcje.' });

  const texts = svg.querySelectorAll('text');
  if (texts.length) {
    const fams = new Set([...svg.querySelectorAll('[font-family]')].map((el) => el.getAttribute('font-family')));
    checks.push({
      level: 'warn',
      title: `Tekst nie zamieniony na krzywe (${texts.length} el.)`,
      detail: `Drukarnia może nie mieć czcionek${fams.size ? ` (${[...fams].slice(0, 4).join(', ')})` : ''}. Zamień tekst na krzywe/obiekty przed wysłaniem.`,
    });
  } else {
    checks.push({ level: 'ok', title: 'Brak tekstu jako czcionek', detail: 'Tekst jest zamieniony na krzywe (albo go nie ma).' });
  }

  let minDpi = null;
  const imgs = [...svg.querySelectorAll('image')];
  for (const im of imgs) {
    const href = im.getAttribute('href') || im.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    if (!href.startsWith('data:')) {
      checks.push({ level: 'err', title: 'Obraz podlinkowany, nieosadzony', detail: `„${href.slice(0, 60)}” nie trafi do drukarni. Osadź obraz w pliku.` });
      continue;
    }
    try {
      const el = await loadImage(href);
      const wU = parseFloat(im.getAttribute('width')) || vbW;
      const realIn = ((wU / vbW) * (CFG.settings.width_mm / 25.4));
      const dpi = el.naturalWidth / realIn;
      minDpi = Math.min(minDpi ?? Infinity, dpi);
    } catch {}
  }
  if (minDpi !== null) {
    checks.push({ level: dpiLevel(minDpi), title: `Osadzone obrazy: najniższa rozdzielczość ${Math.round(minDpi)} DPI`, detail: `W skali 1:1: ${dpiText(minDpi)}. (Szacunek, bez uwzględnienia transformacji.)` });
  } else if (!imgs.length) {
    checks.push({ level: 'ok', title: 'Brak grafik rastrowych', detail: 'Projekt w pełni wektorowy.' });
  }

  // podgląd: ustawiamy rozmiar w px i rysujemy przez <img>
  const outH = PREVIEW_H;
  const outW = Math.round((vbW / vbH) * outH);
  svg.setAttribute('width', outW);
  svg.setAttribute('height', outH);
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
  try {
    const img = await loadImage(url);
    const { canvas, ctx } = whiteCanvas(outW, outH);
    ctx.drawImage(img, 0, 0, outW, outH);
    return { canvas, meta: { kind: 'svg', w_mm: size.w_mm, h_mm: size.h_mm, physical, texts: texts.length, images: imgs.length, min_dpi: minDpi ? Math.round(minDpi) : null } };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ——— JPG / PNG / WebP ———
async function jpegInfo(file) {
  // nagłówek SOF: liczba składowych (4 = CMYK)
  const b = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  for (let i = 2; i < b.length - 9; ) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { components: b[i + 9] };
    i += 2 + len;
  }
  return null;
}

async function analyzeRaster(file, checks) {
  let source;
  try {
    source = await createImageBitmap(file);
  } catch {
    const url = URL.createObjectURL(file);
    try {
      source = await loadImage(url);
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }
  const pxW = source.width;
  const pxH = source.height;
  const W = CFG.settings.width_mm;
  const H = CFG.settings.height_mm;
  sizeChecks(pxW, pxH, checks, { knownPhysical: false });
  checks.unshift({ level: 'info', title: `Obraz ${pxW} × ${pxH} px (${fmtMB(file.size)})`, detail: 'Grafika rastrowa: liczy się liczba pikseli na wymiar rollupu.' });
  const dpi = Math.min(pxW / (W / 25.4), pxH / (H / 25.4));
  checks.push({
    level: dpiLevel(dpi),
    title: `Rozdzielczość na rollupie: ${Math.round(dpi)} DPI`,
    detail: `${dpiText(dpi)}. Minimum to ok. ${Math.round((W / 25.4) * 100)} × ${Math.round((H / 25.4) * 100)} px (100 DPI), zalecane ${Math.round((W / 25.4) * 150)} × ${Math.round((H / 25.4) * 150)} px (150 DPI). Najlepiej wyślij PDF z grafiką wektorową.`,
  });
  if (file.type === 'image/jpeg') {
    const info = await jpegInfo(file);
    if (info?.components === 4) checks.push({ level: 'ok', title: 'JPEG w CMYK', detail: 'Gotowy do druku offsetowego/wielkoformatowego.' });
    else checks.push({ level: 'info', title: 'JPEG w RGB', detail: 'Drukarnia przekonwertuje do CMYK, kolory mogą się minimalnie zmienić.' });
  }
  if (file.type === 'image/png' || file.type === 'image/webp') {
    checks.push({ level: 'info', title: 'Format ekranowy', detail: 'PNG/WebP są OK, ale drukarnie wolą PDF albo JPG/TIFF w CMYK.' });
  }
  const outH = Math.min(PREVIEW_H, pxH);
  const outW = Math.round((pxW / pxH) * outH);
  const { canvas, ctx } = whiteCanvas(outW, outH);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, outW, outH);
  source.close?.();
  return { canvas, meta: { kind: 'raster', px_w: pxW, px_h: pxH, dpi: Math.round(dpi) } };
}

// ——— główna analiza ———
async function analyze(file) {
  const checks = [];
  const name = file.name.toLowerCase();
  const type =
    file.type ||
    (name.endsWith('.pdf') ? 'application/pdf' : name.endsWith('.svg') ? 'image/svg+xml' : name.match(/\.jpe?g$/) ? 'image/jpeg' : name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : '');
  const maxBytes = CFG.settings.max_mb * 1024 * 1024;
  if (file.size > maxBytes) throw new Error(`Plik ma ${fmtMB(file.size)}, a limit to ${CFG.settings.max_mb} MB.`);
  let result;
  if (type === 'application/pdf') result = await analyzePdf(file, checks);
  else if (type === 'image/svg+xml') result = await analyzeSvg(file, checks);
  else if (['image/jpeg', 'image/png', 'image/webp'].includes(type)) result = await analyzeRaster(file, checks);
  else if (/\.(ai|eps|cdr|psd|tiff?|indd)$/.test(name))
    throw new Error('Ten format trzeba wyeksportować do PDF (zalecane) albo JPG/PNG. W Illustratorze/Corelu/Canvie: „Eksportuj → PDF do druku”.');
  else throw new Error('Nieobsługiwany format. Wyślij PDF, SVG, JPG, PNG albo WebP.');

  const colors = colorStats(result.canvas);
  const brandPct = Math.round(colors.brandShare * 100);
  const otherPct = Math.round(colors.otherShare * 100);
  checks.push({
    // kolory marki to zalecenie (decyzja klubu): co najwyżej ostrzeżenie, nigdy błąd
    level: colors.brandShare >= 0.25 ? 'ok' : 'warn',
    title: `Kolory marki: ${brandPct}% powierzchni`,
    detail:
      `Neutralne (biel, czerń, szarości): ${Math.round(colors.neutralShare * 100)}%, inne: ${otherPct}%. ` +
      (colors.brandShare < 0.25
        ? 'Zalecenie brand manualu: niech dominują Loyal Blue #004165 i True Maroon #772432 (zdjęcia mogą mieć dowolne kolory). To tylko zalecenie, nie blokuje wysłania.'
        : 'Paleta wygląda na zgodną z marką.'),
  });
  const order = { err: 0, warn: 1, info: 2, ok: 3 };
  checks.sort((a, b) => order[a.level] - order[b.level]);
  const verdict = checks.some((c) => c.level === 'err') ? 'err' : checks.some((c) => c.level === 'warn') ? 'warn' : 'ok';
  const m = result.meta;
  const summary =
    m.kind === 'raster'
      ? `${type.split('/')[1].toUpperCase()} ${m.px_w}×${m.px_h} px · ${m.dpi} DPI na rollupie`
      : `${m.kind.toUpperCase()} · ${fmt(m.w_mm / 10, 1)} × ${fmt(m.h_mm / 10, 1)} cm${m.scale && m.scale !== 1 ? ` (skala 1:${fmt(m.scale, m.scale % 1 ? 1 : 0)})` : ''}${m.min_dpi ? ` · min. ${m.min_dpi} DPI` : ''}`;
  const report = { verdict, summary, checks, colors: colors.top, brandShare: colors.brandShare, neutralShare: colors.neutralShare, meta: m };
  return { report, canvas: result.canvas, type };
}

// ——— UI ———
const ICON = { ok: '✓', warn: '!', err: '✕', info: 'i' };
const LEVEL = { ok: 'OK', warn: 'Uwaga', err: 'Błąd', info: 'Info' };
const VERDICT = { ok: ['ok', 'Technicznie OK'], warn: ['warn', 'Technicznie: są uwagi'], err: ['err', 'Technicznie: nie nadaje się do druku'] };

function checksList(checks) {
  return h(
    'ul',
    { class: 'checks' },
    checks.map((c) =>
      h('li', { class: c.level }, h('span', { class: 'ico', 'aria-hidden': 'true', text: ICON[c.level] }), h('b', {}, h('span', { class: 'visually-hidden', text: `${LEVEL[c.level]}: ` }), c.title), c.detail ? h('span', { text: c.detail }) : null),
    ),
  );
}

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

function xhrPut(url, body, onProgress) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
    x.onload = () => {
      let data = {};
      try {
        data = JSON.parse(x.responseText);
      } catch {}
      x.status < 300 && data.ok ? res(data) : rej(new Error(data.error || `Błąd wysyłki (${x.status}).`));
    };
    x.onerror = () => rej(new Error('Błąd połączenia podczas wysyłki.'));
    x.send(body);
  });
}

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!data.ok) throw new Error(data.error || `Błąd (${res.status}).`);
  return data;
}

function render(box, file, { report, canvas, type }, previewBlob) {
  const [cls, text] = VERDICT[report.verdict];
  const titleInput = h('input', { type: 'text', id: 'subm-title', name: 'title', required: true, maxlength: 120, value: file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 120) });
  const status = h('p', { class: 'status-line', role: 'status' });
  const progWrap = h('div', { class: 'upload-progress', hidden: true }, h('label', { for: 'up-prog', text: 'Wysyłanie…' }), h('progress', { id: 'up-prog', max: file.size, value: 0 }));
  const aiBox = h('div', { class: 'card', hidden: true, style: 'margin-top:16px' });
  const override = report.verdict === 'err' ? h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'override' }), h('span', { text: 'Wiem, że projekt ma błędy techniczne, ale chcę go wysłać mimo to (np. jako wstępną wersję).' })) : null;
  const sendBtn = h('button', { type: 'submit', class: 'btn', text: 'Wyślij projekt' });
  const aiBtn = CFG.aiOn ? h('button', { type: 'button', class: 'btn ghost', text: 'Sprawdź zgodność z brand manualem (AI)' }) : null;
  const previewUrl = URL.createObjectURL(previewBlob);

  const form = h(
    'form',
    { class: 'form', style: 'margin-top:20px' },
    h('label', { for: 'subm-title' }, 'Tytuł projektu', h('span', { class: 'hint', text: 'Zobaczą go głosujący (bez Twojego imienia).' }), titleInput),
    override,
    h('div', { class: 'actions', style: 'margin-top:4px' }, sendBtn, aiBtn),
    progWrap,
    status,
  );

  box.replaceChildren(
    h(
      'div',
      { class: 'analysis' },
      h('div', { class: 'preview' }, h('img', { src: previewUrl, alt: `Podgląd projektu ${file.name}` }), h('span', { class: 'muted small', text: `${file.name} · ${fmtMB(file.size)}` })),
      h('div', { class: 'stack', style: '--gap:10px' }, h('p', { class: 'row', style: 'margin:0' }, h('span', { class: `pill ${cls}`, text }), h('span', { class: 'muted small', text: report.summary })), checksList(report.checks)),
    ),
    form,
    aiBox,
  );
  box.hidden = false;

  aiBtn?.addEventListener('click', async () => {
    if (aiBtn.getAttribute('aria-disabled') === 'true') return;
    aiBtn.setAttribute('aria-disabled', 'true');
    aiBox.hidden = false;
    aiBox.replaceChildren(h('p', { class: 'muted', text: 'AI ocenia projekt, zwykle trwa to kilkanaście sekund.' }), h('progress', { 'aria-label': 'Trwa ocena AI', style: 'width:100%' }));
    try {
      const data = await postJson('/api/ocena-ai', { image: await blobToBase64(previewBlob), title: titleInput.value, report });
      const wrap = h('div');
      wrap.innerHTML = data.html; // HTML wyrenderowany i escapowany po stronie serwera
      aiBox.replaceChildren(h('h3', { text: 'Ocena AI (podgląd, niezapisana)' }), wrap);
    } catch (err) {
      aiBox.replaceChildren(h('p', { class: 'flash err', text: err.message }));
    } finally {
      aiBtn.removeAttribute('aria-disabled');
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (sendBtn.getAttribute('aria-disabled') === 'true') return;
    if (report.verdict === 'err' && !document.getElementById('override')?.checked) {
      status.className = 'status-line err';
      status.textContent = 'Popraw błędy oznaczone ✕ albo zaznacz, że chcesz wysłać mimo to.';
      return;
    }
    if (!titleInput.value.trim()) return titleInput.reportValidity();
    sendBtn.setAttribute('aria-disabled', 'true');
    aiBtn?.setAttribute('aria-disabled', 'true');
    status.className = 'status-line';
    status.textContent = 'Wysyłanie…';
    progWrap.hidden = false;
    const prog = progWrap.querySelector('progress');
    try {
      const created = await postJson(`/api/konkursy/${CFG.contestId}/zgloszenia`, { title: titleInput.value.trim(), file_name: file.name, file_type: type, file_size: file.size, report });
      let sent = 0;
      for (let n = 0; n < created.parts; n++) {
        const chunk = file.slice(n * created.chunkSize, Math.min(file.size, (n + 1) * created.chunkSize));
        await xhrPut(`/api/zgloszenia/${created.id}/czesc/${n}`, chunk, (loaded) => (prog.value = sent + loaded));
        sent += chunk.size;
        prog.value = sent;
      }
      await xhrPut(`/api/zgloszenia/${created.id}/podglad`, previewBlob, () => {});
      await postJson(`/api/zgloszenia/${created.id}/zakoncz`);
      progWrap.hidden = true;
      if (CFG.aiOn) {
        status.textContent = 'Projekt wysłany ✓ Teraz AI sprawdza zgodność z brand manualem…';
        try {
          await postJson(`/api/zgloszenia/${created.id}/ocena-ai`);
        } catch {
          /* ocenę można powtórzyć później z listy zgłoszeń */
        }
      }
      status.className = 'status-line ok';
      status.textContent = 'Gotowe ✓ Odświeżam listę zgłoszeń…';
      location.hash = `entry-${created.id}`;
      location.reload();
    } catch (err) {
      status.className = 'status-line err';
      status.textContent = err.message;
      sendBtn.removeAttribute('aria-disabled');
      aiBtn?.removeAttribute('aria-disabled');
      progWrap.hidden = true;
    }
  });
}

async function handle(file) {
  const box = document.getElementById('analysis');
  box.hidden = false;
  box.replaceChildren(h('p', { class: 'muted', role: 'status', text: `Analizuję „${file.name}”…` }), h('progress', { 'aria-label': 'Trwa analiza pliku', style: 'width:100%' }));
  try {
    const res = await analyze(file);
    const blob = await canvasToJpeg(res.canvas);
    render(box, file, res, blob);
  } catch (err) {
    console.error(err);
    box.replaceChildren(h('p', { class: 'flash err', role: 'alert', text: err.message || 'Nie udało się przeanalizować pliku.' }));
  }
}

if (CFG && app) {
  const input = document.getElementById('file');
  const drop = document.getElementById('drop');
  input.addEventListener('change', () => input.files[0] && handle(input.files[0]));
  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.add('over')));
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) handle(f);
  });
}
