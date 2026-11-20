// Kopiuje pdf.js z node_modules do public/vendor (serwowane jako statyczne pliki Workers).
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pdfjs-dist');
const dst = join(root, 'public', 'vendor', 'pdfjs');

rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
// build „legacy” zawiera polyfille (np. Map.getOrInsertComputed) — działa też na starszych przeglądarkach i iOS
for (const f of ['legacy/build/pdf.min.mjs', 'legacy/build/pdf.worker.min.mjs']) cpSync(join(src, f), join(dst, f.split('/').pop()));
for (const d of ['wasm', 'cmaps', 'standard_fonts', 'iccs']) cpSync(join(src, d), join(dst, d), { recursive: true });
cpSync(join(src, 'LICENSE'), join(dst, 'LICENSE'));
console.log('pdf.js skopiowany do public/vendor/pdfjs');
