// Wspólne zachowania: pokaż hasło, kopiowanie, potwierdzenia, podgląd w <dialog>.

// — Pokaż/ukryj hasło —
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-pw-toggle]');
  if (!btn) return;
  const input = document.getElementById(btn.dataset.pwToggle);
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.setAttribute('aria-pressed', String(show));
  btn.textContent = show ? 'Ukryj' : 'Pokaż';
});
// przed wysłaniem formularza wracamy do type=password, żeby menedżer haseł zapisał hasło
document.addEventListener('submit', (e) => {
  for (const input of e.target.querySelectorAll('.pw-field input')) input.type = 'password';
});

// — Potwierdzenie przed niebezpieczną akcją —
document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-confirm]');
  if (form && !window.confirm(form.dataset.confirm)) e.preventDefault();
});

// — Blokada podwójnego wysłania formularza —
document.addEventListener('submit', (e) => {
  if (e.defaultPrevented) return;
  const btn = e.submitter;
  if (btn) setTimeout(() => btn.setAttribute('aria-disabled', 'true'), 0);
});

// — Kopiowanie (Invoker Commands + fallback na click) —
const timers = new WeakMap();
let lastMessage = '';
function report(button, ok) {
  const tip = button.nextElementSibling;
  if (!tip) return;
  clearTimeout(timers.get(button));
  let message = ok ? 'Skopiowano' : 'Nie udało się skopiować';
  if (message === lastMessage) message += ' '; // VoiceOver pomija identyczne komunikaty
  lastMessage = message;
  tip.textContent = '';
  requestAnimationFrame(() => (tip.textContent = message));
  timers.set(button, setTimeout(() => (tip.textContent = ''), 2000));
}
async function copy(button, target) {
  const text = target.matches('input, textarea') ? target.value : target.innerText.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    report(button, true);
  } catch {
    report(button, false);
  }
}
if ('CommandEvent' in window) {
  document.addEventListener(
    'command',
    (e) => {
      if (e.command === '--copy') copy(e.source, e.target);
    },
    true,
  );
} else {
  document.addEventListener('click', (e) => {
    const button = e.target.closest('button[command="--copy"]');
    if (!button) return;
    const target = document.getElementById(button.getAttribute('commandfor'));
    if (target) copy(button, target);
  });
}

// — Podgląd projektu w modalnym <dialog> (light dismiss) —
const dialog = document.getElementById('lightbox');
if (dialog) {
  // Safari nie obsługuje closedby="any" — zamykamy kliknięciem w tło ręcznie
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    dialog.addEventListener('click', (e) => {
      if (e.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      const inside = r.top <= e.clientY && e.clientY <= r.bottom && r.left <= e.clientX && e.clientX <= r.right;
      if (!inside) dialog.close();
    });
  }
  dialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-dialog]')) dialog.close();
  });
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-lightbox]');
    if (!btn) return;
    e.preventDefault();
    openLightbox(btn.dataset.lightbox, btn.dataset.title || 'Podgląd');
  });
}
function openLightbox(src, title) {
  if (!dialog) return;
  dialog.querySelector('#lb-title').textContent = title;
  const img = dialog.querySelector('#lb-img');
  img.src = src;
  img.alt = `Podgląd: ${title}`;
  dialog.showModal();
}

window.TM = { openLightbox, copy };

// — Ocena AI zapisanego zgłoszenia —
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-ai-run]');
  if (!btn || btn.getAttribute('aria-disabled') === 'true') return;
  const id = btn.dataset.aiRun;
  const status = document.querySelector(`[data-ai-status="${id}"]`);
  const box = document.querySelector(`[data-ai-box="${id}"]`);
  btn.setAttribute('aria-disabled', 'true');
  btn.classList.add('busy');
  if (status) {
    status.className = 'status-line small';
    status.textContent = 'AI ocenia projekt, zwykle trwa to kilkanaście sekund.';
  }
  try {
    const res = await fetch(`/api/zgloszenia/${id}/ocena-ai`, { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Nie udało się.');
    if (box) {
      box.innerHTML = data.html; // HTML wyrenderowany i escapowany po stronie serwera
      box.closest('details')?.setAttribute('open', '');
    }
    if (status) {
      status.className = 'status-line small ok';
      status.textContent = `Gotowe, ocena ${data.review.score}/100.`;
    }
  } catch (err) {
    if (status) {
      status.className = 'status-line small err';
      status.textContent = err.message;
    }
  } finally {
    btn.removeAttribute('aria-disabled');
    btn.classList.remove('busy');
  }
});
