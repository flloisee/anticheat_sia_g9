// Injected into the watched tab by anticheat.js. Runs in the extension's isolated
// world, so the page cannot see or call any of this.
(() => {
  const KEY = 'anticheat';
  const RESUME_DELAY = 250;

  // Re-injection happens after a reloaded page is reattached and after an extension
  // reload. Retire the previous instance so listeners and timers don't stack up.
  const previous = globalThis.__eyeCheckTracker;
  if (previous) {
    try {
      previous.dispose();
    } catch {
      // The old extension context is already gone.
    }
  }

  let disposed = false;
  let enabled = false;
  let paused = false;
  let resuming = false;
  let resumeTimer = 0;
  let away = false;
  let awayAtPause = false;
  let tabId = null;
  let windowId = null;
  let hostEl = null;
  let valueEl = null;

  const pageEvents = [
    ['visibilitychange', onStateChange],
    ['blur', onStateChange],
    ['focus', onStateChange],
    ['pageshow', onStateChange],
  ];

  pageEvents.forEach(([type, listener]) => addEventListener(type, listener));
  chrome.runtime.onMessage.addListener(onMessage);
  chrome.runtime.onConnect.addListener(onConnect);

  globalThis.__eyeCheckTracker = { dispose };

  function dispose() {
    disposed = true;
    clearTimeout(resumeTimer);
    removeBubble();
    pageEvents.forEach(([type, listener]) => removeEventListener(type, listener));
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.runtime.onConnect.removeListener(onConnect);
    } catch {
      // The old extension context may already be invalid.
    }
  }

  function onMessage(message, _sender, sendResponse) {
    if (disposed || !message?.type?.startsWith('anticheat:')) return;
    handle(message).then(
      () => sendResponse({ ok: true }),
      (error) => {
        console.warn('Eye Check tracker:', error);
        sendResponse({ ok: false });
      },
    );
    return true;
  }

  // The popup holds this port open while it is visible. Closing the popup disconnects
  // it, which is a more reliable "resume" signal than a message during teardown.
  function onConnect(port) {
    if (disposed || port.name !== 'anticheat-popup') return;
    port.onDisconnect.addListener(() => resume());
  }

  async function handle(message) {
    if (message.type === 'anticheat:start') await start(message);
    else if (message.type === 'anticheat:pause') await pause(message);
    else if (message.type === 'anticheat:resume') resume();
    else if (message.type === 'anticheat:stop') stop();
  }

  async function start(message) {
    clearTimeout(resumeTimer);
    resuming = false;
    tabId = message.tabId;
    windowId = message.windowId;
    enabled = true;
    // The popup that injected us has focus, so resume when it closes.
    paused = true;
    away = isAway();
    awayAtPause = false;

    const state = await readState();
    if (!disposed && enabled) paintBubble(state?.tabId === tabId ? state.count || 0 : 0);
  }

  async function pause(message) {
    if (!enabled) return;
    clearTimeout(resumeTimer);
    resuming = false;
    paused = true;

    // Opening the extension popup blurs the page even though the user never left it.
    const popupBlur =
      message.windowId === windowId &&
      document.visibilityState === 'visible' &&
      !document.hasFocus();

    if (popupBlur) {
      if (away) await undo();
      away = false;
      awayAtPause = false;
    } else {
      awayAtPause = isAway();
      away = awayAtPause;
    }
  }

  function resume() {
    if (!enabled || !paused || resuming) return;
    resuming = true;
    const wasAway = awayAtPause;
    awayAtPause = false;

    // Let focus settle after the popup closes before deciding whether this was a real
    // switch or just the user returning to the page.
    resumeTimer = setTimeout(() => {
      resuming = false;
      if (!enabled || !paused) return;
      paused = false;
      const nowAway = isAway();
      if (nowAway && !wasAway) {
        away = true;
        count();
      } else {
        away = nowAway;
      }
    }, RESUME_DELAY);
  }

  function stop() {
    clearTimeout(resumeTimer);
    enabled = false;
    paused = false;
    resuming = false;
    tabId = null;
    windowId = null;
    away = false;
    awayAtPause = false;
    removeBubble();
  }

  function onStateChange() {
    if (disposed || !enabled || paused) return;
    const nowAway = isAway();
    if (nowAway && !away) {
      away = true;
      count();
    } else if (!nowAway) {
      away = false;
    }
  }

  function isAway() {
    return document.visibilityState === 'hidden' || !document.hasFocus();
  }

  // Floating on-page counter. Shadow root keeps the page's CSS off it; pointer-events
  // stay off so the bubble never blocks the page.
  // shortcut: an element in fullscreen covers it (top layer), revisit before enforcing fullscreen.
  function ensureBubble() {
    if (hostEl) {
      if (!hostEl.isConnected) document.documentElement.append(hostEl);
      return;
    }

    hostEl = document.createElement('div');
    hostEl.id = 'eye-check-anticheat';
    hostEl.style.cssText =
      'all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; pointer-events: none;';

    const root = hostEl.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<style>' +
      '.bubble{display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid rgba(148,163,184,.28);border-radius:999px;background:rgba(11,16,26,.88);color:#e5edf7;font:500 12px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35);backdrop-filter:blur(8px)}' +
      '.value{font-size:18px;font-weight:650;font-variant-numeric:tabular-nums;color:#4ade80}' +
      '.label{color:#94a3b8;font-size:11px}' +
      '</style>' +
      '<div class="bubble" role="status" aria-live="polite">' +
      '<span class="value">0</span><span class="label">tab / app switches</span></div>';

    valueEl = root.querySelector('.value');
    document.documentElement.append(hostEl);
  }

  function paintBubble(count) {
    if (disposed || !enabled) return;
    ensureBubble();
    const text = String(count);
    if (valueEl.textContent !== text) valueEl.textContent = text;
  }

  function removeBubble() {
    hostEl?.remove();
    hostEl = null;
    valueEl = null;
  }

  async function count() {
    const state = await readState();
    if (disposed || !enabled || !state || state.tabId !== tabId) {
      enabled = false;
      return;
    }
    await writeState({ ...state, count: (state.count || 0) + 1 });
  }

  async function undo() {
    const state = await readState();
    if (disposed || !state || state.tabId !== tabId) return;
    await writeState({ ...state, count: Math.max(0, (state.count || 0) - 1) });
  }

  async function readState() {
    try {
      const stored = await chrome.storage.session.get(KEY);
      return stored[KEY] ?? null;
    } catch {
      return null;
    }
  }

  async function writeState(state) {
    try {
      await chrome.storage.session.set({ [KEY]: state });
      paintBubble(state.count || 0);
    } catch (error) {
      console.warn('Eye Check tracker could not save the count.', error);
    }
  }
})();
