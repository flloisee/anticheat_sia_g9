// Minimal MV3 service worker. It exists for two reasons: the consent modal runs in the
// page and the popup closes as soon as the user clicks the page, so the Start button
// needs something that outlives the popup; and it is the only context that sees the
// labels detect.js reports from every frame of a training-host page. It unions those
// labels per tab and offers the modal once. No timers, tab listeners or page access of
// its own — detection needs activeTab and belongs to the popup, and sniffing needs a
// document, which only the content scripts have.
importScripts('sniff.js');

const AC_KEY = 'anticheat';
// Per-tab union of the labels each frame reported. In-memory only, so a worker
// restart just means the next frame report offers again, like the popup path.
// shortcut: entries for closed tabs linger until the worker is torn down, which is
// fine while the map holds one small entry per visited tab.
const frameReports = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type?.startsWith('anticheat:')) return;
  handle(message, sender).then(sendResponse, () => sendResponse({ ok: false }));
  return true;
});

async function handle(message, sender) {
  if (message.type === 'anticheat:consent') return consent(message.choice, sender.tab);
  if (message.type === 'anticheat:start-tab') return startTab(message.tabId);
  if (message.type === 'anticheat:frame-reasons') {
    return frameReasons(message.reasons, sender.tab, sender.documentId);
  }
}

async function consent(choice, tab) {
  try {
    if (!tab?.id) return { ok: false };

    if (choice === 'dismiss') {
      // "Not now" only closes the modal for this page visit; nothing is remembered, so
      // a later visit to a quiz view is offered again.
      await send(tab.id, { type: 'anticheat:close-prompt' });
      return { ok: true };
    }

    await startFlow(tab);
    // tracker.js starts paused because it assumes the popup stole focus; there is no
    // popup port on this path, so resume it explicitly.
    await send(tab.id, { type: 'anticheat:resume' });
    // A modal that offered from the popup panel must not linger over the tracker.
    await send(tab.id, { type: 'anticheat:close-prompt' });
    return { ok: true };
  } catch (error) {
    console.warn('Certification Anticheat could not start monitoring from the prompt.', error);
    return { ok: false };
  }
}

async function startTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await startFlow(tab);
    // A prompt started from the popup panel must not linger over the tracker.
    await send(tabId, { type: 'anticheat:close-prompt' });
    return { ok: true };
  } catch (error) {
    console.warn('Certification Anticheat could not start monitoring.', error);
    return { ok: false };
  }
}

async function startFlow(tab) {
  const previous = await readState();
  if (previous && previous.tabId !== tab.id) {
    await send(previous.tabId, { type: 'anticheat:stop' });
  }

  // The injected tracker reads and writes the counter from an untrusted context.
  await chrome.storage.session.setAccessLevel({
    accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
  });

  await chrome.storage.session.set({
    [AC_KEY]: {
      tabId: tab.id,
      windowId: tab.windowId,
      title: tab.title || '',
      url: tab.url || '',
      count: 0,
      // Lets only this tab's tracker start the embedded camera preview.
      token: crypto.randomUUID(),
      startedAt: Date.now(),
    },
  });

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['tracker.js'] });
    if (!(await send(tab.id, { type: 'anticheat:start', tabId: tab.id, windowId: tab.windowId }))) {
      throw new Error('tracker did not start');
    }
  } catch (error) {
    // A state that claims a watch no tracker is running would show "Watching" forever.
    await chrome.storage.session.remove(AC_KEY);
    throw error;
  }
}

// Unions the labels one frame reported with what the other frames of this document
// said, and offers the modal once per visit. It only offers: nothing is injected into
// the watched tab, and no camera or state exists until the user answers the modal.
async function frameReasons(reasons, tab, documentId) {
  try {
    if (!tab?.id || !tab.url) return { ok: false };

    // A reload or a navigation is a new visit, so start a fresh union for it. A second
    // frame of the same document must not re-offer what the user just dismissed.
    const url = tab.url;
    const document = documentId ?? '';
    let entry = frameReports.get(tab.id);
    if (entry?.url !== url || entry.documentId !== document) {
      entry = { url, documentId: document, reasons: new Set(), prompted: false };
      frameReports.set(tab.id, entry);
    }

    for (const reason of reasons ?? []) {
      if (Object.hasOwn(SIGNAL_WEIGHTS, reason)) entry.reasons.add(reason);
    }

    const score = [...entry.reasons].reduce((sum, reason) => sum + SIGNAL_WEIGHTS[reason], 0);
    if (entry.prompted || score < 3) return { ok: true };

    const state = await readState();
    if (state?.tabId === tab.id) return { ok: true };

    // Claim the tab before messaging, so a second frame cannot show a second modal.
    entry.prompted = true;
    await send(tab.id, { type: 'anticheat:show-prompt', reasons: [...entry.reasons] });
    return { ok: true };
  } catch (error) {
    console.warn('Certification Anticheat could not offer monitoring for this page.', error);
    return { ok: false };
  }
}

async function readState() {
  try {
    const stored = await chrome.storage.session.get(AC_KEY);
    return stored[AC_KEY] ?? null;
  } catch {
    return null;
  }
}

async function send(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return null;
  }
}
