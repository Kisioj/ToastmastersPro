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

// — Podgląd maila przed wysłaniem: dokładna treść w oknie, mail wychodzi dopiero po „Wyślij” —
let mailDialog;
function showMail({ to, subject, html, note, okLabel }) {
  if (!mailDialog) {
    mailDialog = document.createElement('dialog');
    mailDialog.className = 'lightbox mail-dialog';
    mailDialog.setAttribute('closedby', 'any');
    mailDialog.setAttribute('aria-labelledby', 'md-title');
    mailDialog.innerHTML = `
      <form method="dialog">
        <div class="lb-head">
          <h2 id="md-title">Podgląd maila</h2>
          <button class="btn ghost small" value="cancel">Anuluj</button>
        </div>
        <div class="lb-body stack" style="--gap:12px">
          <dl class="mail-meta"><dt>Do</dt><dd data-md="to"></dd><dt>Temat</dt><dd data-md="subject"></dd></dl>
          <p class="hint" data-md="note"></p>
          <iframe class="mail-frame" sandbox="" title="Treść maila"></iframe>
        </div>
        <div class="lb-foot">
          <button class="btn" value="ok" data-md="ok"></button>
          <button class="btn ghost" value="cancel">Anuluj</button>
        </div>
      </form>`;
    document.body.append(mailDialog);
  }
  const $ = (k) => mailDialog.querySelector(`[data-md="${k}"]`);
  $('to').textContent = to;
  $('subject').textContent = subject;
  $('note').textContent = note || '';
  $('note').hidden = !note;
  $('ok').textContent = okLabel || 'Wyślij';
  mailDialog.querySelector('iframe').srcdoc = html;
  mailDialog.returnValue = '';
  mailDialog.showModal();
  return new Promise((resolve) => mailDialog.addEventListener('close', () => resolve(mailDialog.returnValue === 'ok'), { once: true }));
}
window.tmShowMail = showMail;

// Formularz z data-mail-preview: najpierw podgląd (POST tych samych pól), wysyłka dopiero po potwierdzeniu.
// data-mail-preview-if="pole": podgląd tylko, gdy to pole wyboru jest zaznaczone (bez niego mail nie wychodzi).
// Faza przechwytywania: zatrzymujemy inne obsługi (np. blokadę podwójnego wysłania), dopóki nie ma zgody.
document.addEventListener(
  'submit',
  async (e) => {
    const form = e.target.closest('form[data-mail-preview]');
    if (!form) return;
    if (form.dataset.previewOk) {
      delete form.dataset.previewOk;
      return;
    }
    const cond = form.dataset.mailPreviewIf;
    if (cond && !form.elements[cond]?.checked) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const submitter = e.submitter;
    const go = () => {
      form.dataset.previewOk = '1';
      form.requestSubmit(submitter && submitter.form === form ? submitter : undefined);
    };
    try {
      const res = await fetch(form.dataset.mailPreview, { method: 'POST', body: new FormData(form) });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Nie udało się przygotować podglądu maila.');
      if (data.skip || (await showMail(data))) go();
    } catch (err) {
      window.alert(err.message);
    }
  },
  true,
);

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
  // ta sama karta może być na stronie dwa razy (Twoje zgłoszenia + widok admina) — szukamy w obrębie karty
  const card = btn.closest('article') ?? document;
  const status = card.querySelector('[data-ai-status]');
  const box = card.querySelector('[data-ai-box]');
  btn.setAttribute('aria-disabled', 'true');
  btn.classList.add('busy');
  if (status) {
    status.className = 'status-line small';
    status.textContent = 'AI ocenia projekt, zwykle trwa to do minuty.';
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
