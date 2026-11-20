// Panel admina: generowanie linków z zaproszeniem (z wysyłką maila, jeśli SMTP działa).

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-invite]');
  if (!btn || btn.getAttribute('aria-disabled') === 'true') return;
  const id = btn.dataset.invite;
  const out = document.querySelector(`[data-invite-out="${id}"]`);
  btn.setAttribute('aria-disabled', 'true');
  btn.classList.add('busy');
  try {
    const res = await fetch(`/admin/czlonkowie/${id}/zaproszenie`, { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Nie udało się.');
    const linkId = `invite-link-${id}`;
    const msg = data.sent
      ? `Wysłano maila na ${btn.dataset.email}. Link (ważny 14 dni) możesz też przesłać sam:`
      : data.mode === 'off'
        ? 'Maile są wyłączone. Skopiuj link i wyślij go tej osobie (ważny 14 dni):'
        : `Mail nie wyszedł (${data.error}). Skopiuj link i wyślij go ręcznie:`;
    const wrap = document.createElement('div');
    wrap.className = 'link-out';
    const p = document.createElement('span');
    p.className = 'small';
    p.textContent = msg;
    const code = document.createElement('span');
    code.className = 'mono small';
    code.id = linkId;
    code.textContent = data.link;
    const copyWrap = document.createElement('span');
    copyWrap.className = 'copy';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn ghost small';
    copyBtn.textContent = 'Kopiuj link';
    copyBtn.setAttribute('command', '--copy');
    copyBtn.setAttribute('commandfor', linkId);
    copyBtn.setAttribute('aria-label', `Kopiuj link dla ${btn.dataset.email}`);
    const bubble = document.createElement('span');
    bubble.className = 'bubble';
    bubble.setAttribute('role', 'status');
    copyWrap.append(copyBtn, bubble);
    wrap.append(p, code, copyWrap);
    out.replaceChildren(wrap);
    btn.textContent = 'Nowy link do hasła';
  } catch (err) {
    out.replaceChildren(Object.assign(document.createElement('p'), { className: 'flash err small', textContent: err.message }));
  } finally {
    btn.removeAttribute('aria-disabled');
    btn.classList.remove('busy');
  }
});

// Wczytanie listy członków z pliku CSV/TXT do pola tekstowego.
// Excel zapisuje CSV często w Windows-1250 — jeśli plik nie jest poprawnym UTF-8, dekodujemy jako cp1250.
document.addEventListener('change', async (e) => {
  const input = e.target.closest('input[type=file][data-fill]');
  if (!input?.files?.[0]) return;
  const buf = await input.files[0].arrayBuffer();
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder('windows-1250').decode(buf);
  }
  const target = document.getElementById(input.dataset.fill);
  target.value = text.replace(/^\uFEFF/, '');
  target.focus();
});
