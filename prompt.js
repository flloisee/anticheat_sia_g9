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
      '*,::before,::after{box-sizing:border-box}' +
      '.backdrop{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.42);-webkit-backdrop-filter:blur(16px) saturate(140%);backdrop-filter:blur(16px) saturate(140%);animation:ec-fade .16s ease-out}' +
      '.card{width:min(420px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:24px;border:1px solid rgba(255,255,255,.09);border-radius:20px;background:rgba(28,28,30,.78);-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%);box-shadow:0 24px 64px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.07);color:#f5f5f7;font:400 13px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,"Segoe UI",sans-serif;animation:ec-pop .2s cubic-bezier(.32,.72,0,1)}' +
      'h2{margin:0 0 8px;font-size:17px;line-height:1.3;font-weight:600;letter-spacing:-.01em}' +
      'p{margin:0 0 16px;overflow-wrap:anywhere;color:rgba(235,235,245,.62);font-size:13px;line-height:1.5}' +
      '.error{color:#ff453a}' +
      '.actions{display:flex;flex-wrap:wrap;gap:8px}' +
      'button{min-height:38px;padding:0 16px;border:1px solid rgba(255,255,255,.09);border-radius:11px;background:rgba(255,255,255,.08);color:#f5f5f7;font:500 13px/1 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,"Segoe UI",sans-serif;cursor:pointer;transition:background-color .09s ease-out,border-color .16s ease-out,transform .09s ease-out,opacity .09s ease-out}' +
      'button:hover:not(:disabled){background:rgba(255,255,255,.14)}' +
      'button:active:not(:disabled){transform:scale(.98)}' +
      'button:focus-visible{outline:2px solid #0a84ff;outline-offset:2px}' +
      'button:disabled{opacity:.45;cursor:default}' +
      '.primary{border-color:transparent;background:#0a84ff;color:#fff}' +
      '.primary:hover:not(:disabled){background:#2f96ff}' +
      '@keyframes ec-fade{from{opacity:0}to{opacity:1}}' +
      '@keyframes ec-pop{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:scale(1)}}' +
      '@media (prefers-reduced-motion:reduce){.backdrop{animation:none}.card{animation:ec-fade .2s ease-out}}' +
      '@media (prefers-reduced-transparency:reduce){.backdrop,.card{-webkit-backdrop-filter:none;backdrop-filter:none}.card{background:#1c1c1e}}' +
      '@media (prefers-contrast:more){.card{background:#1c1c1e;border-color:rgba(255,255,255,.35)}}' +
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
    detail.textContent = reasons.length
      ? `This page looks like an exam section (${reasons.join(', ')}). Nothing starts until you choose.`
      : 'This page looks like an exam section. Nothing starts until you choose.';

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
