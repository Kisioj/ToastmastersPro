# Strefa członka — Toastmasters Częstochowa

Zamknięta strona dla członków klubu: logowanie mailem (hasło albo link jednorazowy), konkursy z głosowaniem
i konkurs na projekt rollupu z automatycznym sprawdzaniem plików. Działa w całości na darmowym planie Cloudflare.

## Co potrafi

- **Logowanie tylko dla osób z listy.** Admin dodaje maile (hurtowo, np. „Anna Nowak <anna@example.com>”),
  każda osoba dostaje unikalny link do ustawienia hasła (ważny 14 dni, jednorazowy). Potem loguje się
  mailem i hasłem albo samym mailem — wtedy dostaje link do logowania (ważny 20 min).
  Bez skonfigurowanego SMTP linki pokazują się w panelu admina z przyciskiem „Kopiuj”.
- **Konkursy z 7 sposobami głosowania:** podium (top 3), pełny ranking (Borda + zwycięzca Condorceta),
  aprobata, gwiazdki 1–5, rozdanie 10 punktów, pojedynki parami, jeden głos.
  Zaznacz jeden sposób = oficjalne głosowanie; kilka = **tryb testowy** (każdy sposób w osobnej zakładce
  + ankieta „który sposób najlepszy?”, a w panelu admina tabela porównania zwycięzców wg metod).
- **Konkurs na rollup 85 × 200 cm.** Przeglądarka analizuje plik (PDF/SVG/JPG/PNG/WebP): proporcje,
  skalę (1:1, 1:2, 1:5, 1:10), efektywne DPI każdej grafiki rastrowej w PDF, osadzenie czcionek,
  zgodność czcionek i udział kolorów marki (Loyal Blue, True Maroon, Cool Gray, Happy Yellow).
  Następnie AI ocenia zgodność z [Brand Manualem Toastmasters](https://content.toastmasters.org/image/upload/02330-001-0001-brand-manual.pdf)
  (logo, kolory, typografia, tagline, zdjęcia, czytelność z 3 m, układ na rollupie).
  Pliki do 95 MB są wysyłane w kawałkach po 20 MB.
- Panel admina: członkowie (zaproszenia, role, dezaktywacja), konkursy (etapy, sposoby głosowania,
  widoczność wyników), propozycje, zgłoszenia, wyniki, zerowanie głosów.

## Architektura

| Element | Usługa (darmowy plan) |
|---|---|
| Serwer (Hono + JSX, TypeScript) | Cloudflare Workers — 100 tys. żądań/dzień, **10 ms CPU na żądanie** |
| Baza (członkowie, głosy, konkursy) | D1 (SQLite) — 5 GB |
| Pliki rollupów | Workers KV (1 GB, bez karty) albo R2 (10 GB, wymaga podpięcia karty w panelu) |
| Ocena AI | Workers AI (10 000 „neuronów”/dzień) albo Claude API |
| Maile | Gmail SMTP z hasłem aplikacji (biblioteka `worker-mailer`) |

Limit 10 ms CPU wymusił kilka decyzji: analiza plików odbywa się w przeglądarce (pdf.js),
pliki są strumieniowane prosto do KV/R2 bez kopiowania w Workerze, a PBKDF2 ma 50 000 iteracji (~5 ms).

## Uruchomienie lokalne

```bash
npm install
npm run db:migrate:local
# dane startowe (konkursy) — plik seed/ jest poza repo:
npx wrangler d1 execute DB --local --file seed/demo.sql
# konto admina — wypisze link do ustawienia hasła:
node scripts/admin-link.mjs twoj@mail.pl --name "Imię Nazwisko" --admin
npm run dev            # http://localhost:8787
```

Bez SMTP linki do logowania wypisują się w konsoli `wrangler dev` (a na localhost także na stronie).
Workers AI w trybie lokalnym łączy się z Cloudflare (wymaga `npx wrangler login`).

## Wdrożenie

```bash
npx wrangler login
npx wrangler d1 create toastmasters-czestochowa      # wpisz database_id do wrangler.jsonc
npx wrangler kv namespace create FILES_KV            # wpisz id do wrangler.jsonc
npm run deploy                                       # migracje + deploy
node scripts/admin-link.mjs twoj@mail.pl --admin --remote --url https://<twoj-adres>.workers.dev
```

### Maile z toastmastersczwa@gmail.com

1. Na koncie Google klubu włącz weryfikację dwuetapową.
2. Wygeneruj [hasło aplikacji](https://myaccount.google.com/apppasswords) (16 znaków).
3. `npx wrangler secret put SMTP_PASS` i wklej hasło.
4. W panelu admina kliknij „Wyślij testowego maila do mnie”.

Limity wysyłki (Gmail pozwala zwykłemu kontu na ok. 500 maili/dobę i po przekroczeniu blokuje całe konto
nawet na 24 h, także ręczną korespondencję klubu):

- maile idą wyłącznie do aktywnych osób z listy członków,
- maks. 1 mail na 5 minut na adres (link do logowania lub zaproszenie),
- maks. `MAIL_DAILY_LIMIT` maili na dobę z całej aplikacji (domyślnie 300),
- zaproszenia hurtowe po 15 naraz (limit połączeń na darmowym planie Workers).

### Import listy członków

Panel admina → „Dodaj osoby albo wklej całą listę członków”: wklej wiersze z Excela/Arkuszy, linie
„Imię Nazwisko <mail>” albo wczytaj CSV (UTF-8 lub Windows-1250). Przed zapisem pokazuje się podgląd,
a opcja „Tylko te osoby mają mieć dostęp” dezaktywuje członków spoza listy (adminów nie rusza).

### Ocena AI — co wybrać

- **Workers AI** (domyślnie, `AI_PROVIDER=workers-ai`): darmowe, bez dodatkowego konta. Model Llama 4 Scout
  radzi sobie z oczywistymi problemami (brak logo, złe czcionki, za dużo tekstu), ale ocena trwa 30–90 s
  i bywa powierzchowna.
- **Claude** (`AI_PROVIDER=claude` w `wrangler.jsonc` + `npx wrangler secret put ANTHROPIC_API_KEY`):
  wyraźnie trafniejsza ocena projektów graficznych. Płatne za użycie: domyślny `claude-opus-5-5` to ok.
  5–10 groszy amerykańskich za ocenę, a `CLAUDE_MODEL=claude-haiku-5-5` około 40× taniej.
  Przy kilkunastu zgłoszeniach to łącznie najwyżej kilka dolarów.

Limit ocen: `AI_DAILY_LIMIT` na osobę dziennie (admin bez limitu).

### R2 zamiast KV

Po włączeniu R2 w panelu Cloudflare: `npx wrangler r2 bucket create toastmasters-czestochowa-pliki`,
odkomentuj `r2_buckets` w `wrangler.jsonc` i zrób deploy. Nowe pliki trafią do R2, a stare zostaną w KV
(można je usunąć i wysłać ponownie).

### Własna domena

W panelu Cloudflare: Workers → toastmasters-czestochowa → Settings → Domains & Routes → Add custom domain.
Linki w mailach budują się z adresu, pod którym działa strona, więc nic więcej nie trzeba zmieniać.

## Uwaga z brand manuala

Brand Manual (sekcja Logo Usage) mówi, że kluby nie mogą tworzyć własnego logo, motywu ani **taglinu**.
Przed oficjalnym użyciem zwycięskiego hasła warto więc zapytać brand@toastmasters.org albo używać go
jako wewnętrznego motta, a nie taglinu marki.
