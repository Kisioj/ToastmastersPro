// Panel admina: linki z zaproszeniem. „Link do skopiowania” niczego nie wysyła, „Wyślij zaproszenie” wysyła maila.
// Przed mailem pokazujemy jego dokładną treść (okno z app.js), przed nowym linkiem pytamy, bo unieważnia poprzedni.

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-invite], [data-invite-link]');
  if (!btn || btn.getAttribute('aria-disabled') === 'true') return;
  const byMail = btn.hasAttribute('data-invite');
  const id = byMail ? btn.dataset.invite : btn.dataset.inviteLink;
  const out = document.querySelector(`[data-invite-out="${id}"]`);
  if (byMail) {
    try {
      const res = await fetch(`/admin/czlonkowie/${id}/podglad-maila`, { method: 'POST' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Nie udało się przygotować podglądu maila.');
      if (!(await window.tmShowMail(data))) return;
    } catch (err) {
      out.replaceChildren(Object.assign(document.createElement('p'), { className: 'flash err small', textContent: err.message }));
      return;
    }
  } else if (btn.dataset.ask && !window.confirm(btn.dataset.ask)) return;
  btn.setAttribute('aria-disabled', 'true');
  btn.classList.add('busy');
  try {
    const res = await fetch(`/admin/czlonkowie/${id}/${byMail ? 'zaproszenie' : 'link'}`, { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Nie udało się.');
    let copied = false;
    if (!byMail) {
      try {
        await navigator.clipboard.writeText(data.link);
        copied = true;
      } catch {
        // np. Safari po await: zostaje przycisk „Kopiuj link”
      }
    }
    const msg = !byMail
      ? copied
        ? 'Link skopiowany do schowka. Mail nie został wysłany: prześlij link tej osobie sam (ważny 14 dni).'
        : 'Mail nie został wysłany. Skopiuj link i prześlij go tej osobie sam (ważny 14 dni):'
      : data.sent
        ? `Wysłano maila na ${btn.dataset.email}. Link (ważny 14 dni) możesz też przesłać sam:`
        : `Mail nie wyszedł (${data.error}). Skopiuj link i wyślij go ręcznie:`;
    const linkId = `invite-link-${id}`;
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
    // osoba ma już link: kolejne kliknięcia (oba przyciski) tworzą nowy link i pytają o zgodę
    for (const b of document.querySelectorAll(`[data-invite="${id}"], [data-invite-link="${id}"]`)) {
      if (b.dataset.askAgain) b.dataset.ask = b.dataset.askAgain;
      b.textContent = b.dataset.labelAgain;
    }
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
