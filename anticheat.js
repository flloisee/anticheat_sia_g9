// Popup-side anti-cheat panel. One watched tab at a time, counted by tracker.js
// whenever that tab is hidden or the browser window loses focus.
const AC_KEY = 'anticheat';
// SIGNAL_WEIGHTS and sniffExam come from sniff.js, loaded just before this file.
// camera.html is also embedded as the small preview in the tracked page; the
// panel and its listeners belong to the popup only.
const PREVIEW = new URLSearchParams(location.search).get('preview') === '1';

const trackBtn = document.getElementById('trackBtn');
const stopBtn = document.getElementById('stopBtn');
const switchCount = document.getElementById('switchCount');
const acStatus = document.getElementById('acStatus');
const acBadge = document.getElementById('acBadge');

let tracked = null;
let activeTab = null;
let busy = false;
let note = '';
let released = false;
let port = null;

if (!PREVIEW && window.top === window) {
  trackBtn.addEventListener('click', trackThisTab);
  stopBtn.addEventListener('click', stopTracking);
  chrome.storage.session.onChanged.addListener(onStorageChanged);
  chrome.tabs.onRemoved.addListener(onTabRemoved);
  addEventListener('pagehide', release);
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') release();
  });

  init();
}

async function init() {
  await allowTrackerStorage();
  await refresh(true);
}

async function allowTrackerStorage() {
  try {
    await chrome.storage.session.setAccessLevel({
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
    });
  } catch (error) {
    console.warn('Eye Check could not let the tracker use session storage.', error);
  }
}

async function refresh(attach = false) {
  tracked = await readState();

  if (tracked && !(await tabExists(tracked.tabId))) {
    tracked = null;
    await chrome.storage.session.remove(AC_KEY);
    note = 'The watched tab was closed. Start monitoring to begin again.';
  }

  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tracked) await maybeSuggest(activeTab);

  if (attach && tracked && activeTab?.id === tracked.tabId) await attachTracker();
  paint();
}

// Detection only ever offers. The tracker, camera and storage stay untouched until
// the user presses Start, either on the on-page prompt or in the popup.
async function maybeSuggest(tab) {
  if (PREVIEW || tracked || !canInject(tab)) return;

  try {
    // allFrames covers same-origin quiz iframes; cross-origin frames are skipped
    // by Chrome and simply contribute nothing.
    const frames = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: sniffExam,
    });

    const reasons = new Set();
    for (const frame of frames ?? []) {
      for (const reason of frame?.result?.reasons ?? []) {
        if (Object.hasOwn(SIGNAL_WEIGHTS, reason)) reasons.add(reason);
      }
    }

    const score = [...reasons].reduce((sum, reason) => sum + SIGNAL_WEIGHTS[reason], 0);
    if (score >= 3) await showPrompt(tab, [...reasons]);
  } catch {
    // A page we cannot inspect is simply not suggested.
  }
}

// The prompt lives in the page, so it stays clickable after this popup closes and
// the worker can still act on the answer.
async function showPrompt(tab, reasons) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['prompt.js'],
    });
  } catch {
    // A page that rejects injection gets no prompt.
    return;
  }
  await send(tab.id, { type: 'anticheat:show-prompt', reasons });
}

async function attachTracker() {
  const pong = await send(tracked.tabId, { type: 'anticheat:ping' });

  if (pong?.ok) {
    await send(tracked.tabId, { type: 'anticheat:pause', windowId: activeTab.windowId });
    keepAlive();
    return;
  }

  // The page reloaded and lost the injected script. Reattach without losing the count.
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tracked.tabId },
      files: ['tracker.js'],
    });
    await send(tracked.tabId, {
      type: 'anticheat:start',
      tabId: tracked.tabId,
      windowId: tracked.windowId,
    });
    keepAlive();
  } catch (error) {
    console.warn('Eye Check could not reattach the tab monitor.', error);
    note = 'Open this tab again and press Start monitoring to resume counting.';
  }
}

function keepAlive() {
  try {
    port = chrome.tabs.connect(tracked.tabId, { name: 'anticheat-popup' });
  } catch {
    port = null;
  }
}

async function trackThisTab() {
  if (busy) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!canInject(tab)) {
    note = 'Open a normal web page (http or https) and try again.';
    paint();
    return;
  }

  busy = true;
  paint();

  disconnect();

  try {
    // The worker owns the start so the on-page prompt can use the same path after
    // this popup has closed.
    const reply = await chrome.runtime.sendMessage({ type: 'anticheat:start-tab', tabId: tab.id });
    if (!reply?.ok) throw new Error('start rejected');
    keepAlive();
    note = '';
  } catch (error) {
    console.warn('Eye Check could not track this tab.', error);
    await chrome.storage.session.remove(AC_KEY);
    note = 'This page cannot be watched. Try a normal web page.';
  }

  busy = false;
  await refresh();
}

async function stopTracking() {
  if (busy || !tracked) return;
  busy = true;
  paint();

  disconnect();
  await send(tracked.tabId, { type: 'anticheat:stop' });
  await chrome.storage.session.remove(AC_KEY);
  tracked = null;
  note = 'Tracking stopped.';
  busy = false;
  paint();
}

function paint() {
  switchCount.textContent = String(tracked?.count ?? 0);
  acBadge.textContent = tracked ? 'Watching' : 'Off';
  acBadge.className = `pill${tracked ? ' on' : ''}`;

  if (!tracked) {
    acStatus.textContent =
      note || 'Not monitoring this page. If this is your exam, start monitoring manually.';
    acStatus.title = '';
    trackBtn.textContent = 'Start monitoring';
    trackBtn.disabled = busy || !canInject(activeTab);
    trackBtn.title = canInject(activeTab) ? '' : 'Open a normal web page to monitor it.';
    stopBtn.hidden = true;
    return;
  }

  const where = tracked.title || hostOf(tracked.url) || `tab ${tracked.tabId}`;
  acStatus.textContent = `Watching: ${where}`;
  acStatus.title = `${tracked.title || ''}\n${tracked.url || ''}`.trim();

  const sameTab = activeTab?.id === tracked.tabId;
  trackBtn.textContent = sameTab ? 'Monitoring this tab' : 'Monitor this tab instead';
  trackBtn.disabled = sameTab || busy || !canInject(activeTab);
  trackBtn.title = canInject(activeTab) ? '' : 'Open a normal web page to track it.';
  stopBtn.hidden = false;
  stopBtn.disabled = busy;
}

function onStorageChanged(changes) {
  if (!changes[AC_KEY]) return;
  tracked = changes[AC_KEY].newValue ?? null;
  paint();
}

async function onTabRemoved(tabId) {
  if (tracked?.tabId !== tabId) return;
  tracked = null;
  await chrome.storage.session.remove(AC_KEY);
  note = 'The watched tab was closed. Track a tab to start again.';
  paint();
}

function release() {
  if (released) return;
  released = true;
  disconnect();
  if (tracked) send(tracked.tabId, { type: 'anticheat:resume' });
}

function disconnect() {
  if (!port) return;
  try {
    port.disconnect();
  } catch {
    // Already disconnected.
  }
  port = null;
}

async function readState() {
  try {
    const stored = await chrome.storage.session.get(AC_KEY);
    return stored[AC_KEY] ?? null;
  } catch {
    return null;
  }
}

async function tabExists(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

async function send(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return null;
  }
}

function canInject(tab) {
  return /^https?:\/\//.test(tab?.url ?? '');
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
