// Auto-detector for the known certification hosts (see manifest content_scripts).
// It only reports signal labels to the worker: it never starts a watch, writes
// storage or touches the camera, so the page is untouched until the user consents.
(() => {
  // Declared content scripts run once per document; this guards a second injection.
  if (globalThis.__eyeCheckDetect) return;
  globalThis.__eyeCheckDetect = true;

  // A quiz view is usually rendered after the route changes, so a single snapshot at
  // document_idle is too early. Sniff again shortly after each route change.
  const DELAYS = [500, 2000, 5000];
  let lastSent = '';
  let timers = [];

  function send() {
    try {
      const reasons = sniffExam().reasons.filter((reason) => Object.hasOwn(SIGNAL_WEIGHTS, reason));
      // The url is part of the key because an SPA quiz view can reuse the same labels,
      // which would otherwise look unchanged. An empty snapshot clears the baseline.
      const labels = reasons.sort().join('|');
      const key = labels ? location.href + '|' + labels : '';
      // Report only what changed.
      if (key === lastSent) return;
      lastSent = key;
      if (!key) return;
      // A dead extension context must not throw into the page.
      chrome.runtime.sendMessage({ type: 'anticheat:frame-reasons', reasons })?.catch(() => {});
    } catch {
      // A frame we cannot inspect reports nothing.
    }
  }

  function rescan() {
    // Route changes can fire before the previous batch ran; an early timer would
    // then read a view that is already gone.
    for (const id of timers) clearTimeout(id);
    send();
    timers = DELAYS.map((delay) => setTimeout(send, delay));
  }

  // SPA routes change the path without a load, which is exactly when a quiz appears.
  // shortcut: a content script's isolated world has its own `history` wrapper, so a
  // page-initiated pushState is only caught if it reaches this wrapper; popstate,
  // hashchange and the delayed rescans above cover the rest. Upgrade with a MAIN-world
  // hook if in-app route changes have to be exact.
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      rescan();
      return result;
    };
  }
  addEventListener('popstate', rescan);
  addEventListener('hashchange', rescan);

  rescan();
})();
