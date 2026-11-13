// On-page consent modal. anticheat.js injects this and asks it to show, so the offer
// survives the popup closing. It only offers: no tracker, no camera, no state until
// the user presses a button, and then the worker does the start.
(() => {
  // The manifest declares this file as a content script in every frame, but only the
  // top frame may draw the overlay.
  if (window.top !== window) return;

  // Re-injection happens after a reload of the same page; retire the old instance so
  // a second overlay is never left behind.
  const previous = globalThis.__eyeCheckPrompt;
  if (previous) {
    try {
      previous.dispose();
    } catch {
      // The old extension context is already gone.
    }
  }

  let hostEl = null;
  let onKeydown = null;

  chrome.runtime.onMessage.addListener(onMessage);
  globalThis.__eyeCheckPrompt = { dispose };

  function dispose() {
    remove();
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      // The old extension context may already be invalid.
    }
  }

  function onMessage(message, _sender, sendResponse) {
    if (!message?.type?.startsWith('anticheat:')) return;
    if (message.type === 'anticheat:show-prompt') show(message);
    else if (message.type === 'anticheat:close-prompt') remove();
    else return;
    sendResponse({ ok: true });
  }

  // Shadow root keeps the page's CSS off the card; pointer-events stay on because
  // unlike the counter bubble this overlay is meant to be clicked.
  function show({ reasons = [] }) {
    remove();

    hostEl = document.createElement('div');
    hostEl.id = 'eye-check-prompt';
    hostEl.style.cssText =
      'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: auto;';

    const root = hostEl.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<style>' +
      '.backdrop{display:flex;align-items:center;justify-content:center;position:fixed;inset:0;padding:16px;background:rgba(2,6,12,.55)}' +
      '.card{box-sizing:border-box;width:min(420px,calc(100vw - 32px));padding:20px;border:1px solid rgba(148,163,184,.28);border-radius:14px;background:#0b1219;color:#e5edf7;font:400 13px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 24px 64px rgba(0,0,0,.45)}' +
      'h2{margin:0 0 8px;font-size:15px;font-weight:650}' +
      'p{margin:0 0 14px;color:#94a3b8}' +
      '.error{color:#fca5a5}' +
      '.actions{display:flex;flex-wrap:wrap;gap:8px}' +
      'button{padding:8px 14px;border:1px solid rgba(148,163,184,.28);border-radius:9px;background:transparent;color:#e5edf7;font:inherit;font-size:12px;cursor:pointer}' +
      'button:hover:not(:disabled){border-color:rgba(148,163,184,.5)}' +
      'button:focus-visible{outline:2px solid #38bdf8;outline-offset:2px}' +
      'button:disabled{color:#64748b;cursor:default}' +
      '.primary{border-color:transparent;background:#4ade80;color:#052e16;font-weight:650}' +
      '.primary:disabled{background:#1e293b;color:#64748b}' +
      '</style>' +
      '<div class="backdrop">' +
      '<div class="card" role="dialog" aria-modal="true" aria-labelledby="ec-title">' +
      '<h2 id="ec-title">Certification Anticheat</h2>' +
      '<p class="detail"></p>' +
      '<p class="error" hidden></p>' +
      '<div class="actions">' +
      '<button class="primary" type="button" data-choice="start">Start monitoring</button>' +
      '<button type="button" data-choice="dismiss">Not now</button>' +
      '</div></div></div>';

    const detail = root.querySelector('.detail');
    detail.textContent = `This page looks like an exam section (${reasons.join(', ')}). Monitoring stays off until you start. Start and the counter (plus the camera preview) begin only after you press Start.`;

    const buttons = [...root.querySelectorAll('button')];
    let busy = false;

    const choose = async (choice) => {
      if (busy) return;
      busy = true;
      buttons.forEach((button) => (button.disabled = true));
      try {
        const reply = await chrome.runtime.sendMessage({ type: 'anticheat:consent', choice });
        if (!reply?.ok) throw new Error('consent rejected');
        remove();
      } catch {
        busy = false;
        buttons.forEach((button) => (button.disabled = false));
        root.querySelector('.error').textContent =
          'Could not start. Open the extension and press Start monitoring.';
        root.querySelector('.error').hidden = false;
      }
    };

    for (const button of buttons) {
      button.addEventListener('click', () => choose(button.dataset.choice));
    }

    // Backdrop click dismisses, card clicks do not.
    root.querySelector('.backdrop').addEventListener('click', (event) => {
      if (event.target === event.currentTarget) choose('dismiss');
    });

    onKeydown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      choose('dismiss');
    };
    document.addEventListener('keydown', onKeydown, true);

    document.documentElement.append(hostEl);
    root.querySelector('.primary').focus();
  }

  function remove() {
    if (onKeydown) {
      document.removeEventListener('keydown', onKeydown, true);
      onKeydown = null;
    }
    hostEl?.remove();
    hostEl = null;
  }
})();
