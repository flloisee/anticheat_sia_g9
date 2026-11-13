import { FilesetResolver, FaceLandmarker } from './vendor/mediapipe/vision_bundle.mjs';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const isWindow = params.get('window') === '1';
const isPreview = params.get('preview') === '1';
if (isWindow) document.documentElement.classList.add('window');
if (isPreview) document.documentElement.classList.add('preview');

const video = $('video');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');
const stage = $('stage');
const dot = $('dot');
const badge = $('badge');
const empty = $('empty');
const emptyTitle = $('emptyTitle');
const emptyText = $('emptyText');
const startBtn = $('startBtn');
const camToggle = $('camToggle');
const overlayToggle = $('overlayToggle');

// Subject's eyes: 33/263 are the outer corners, the rest trace the lids.
const RIGHT_EYE = [33, 160, 158, 133, 153, 144, 163, 7, 246];
const LEFT_EYE = [263, 387, 385, 380, 373, 362, 390, 249, 466];
// Iris centres in the 478-point mesh: the subject's right eye, then the left.
const RIGHT_IRIS = 468;
const LEFT_IRIS = 473;

// Crude gaze heuristic: where the iris sits inside the eye's bounding box, averaged
// over both eyes and smoothed. Fixed thresholds, no per-user calibration.
const GAZE_ENTER_X = 0.12;
const GAZE_ENTER_Y = 0.1;
const GAZE_EXIT_X = 0.08;
const GAZE_EXIT_Y = 0.07;
const GAZE_SMOOTH = 0.3;
const GAZE_WARMUP_MS = 2000;
const AWAY_MS = 1200;

// Mesh colour: white while on screen, yellow as the iris drifts, red at the away
// entry threshold — the same point that starts the look-away timer.
const GAZE_ON_COLOR = '#ffffff';
const GAZE_MID_COLOR = '#facc15';
const GAZE_AWAY_COLOR = '#ef4444';

// The overlay switch is shared by every camera page (popup, window, on-page
// preview) through session storage; a missing key means on.
const OVERLAY_KEY = 'overlay';

let landmarker = null;
let stream = null;
let running = false;
let starting = false;
let session = 0;
let loopTimer = 0;
let loopToken = 0;
let lastRestart = 0;
let wanted = false;
// Smoothed iris offset from 0.5 in normalized eye-box space, its severity (0 on
// screen, 1 away), plus the away episode.
let gaze = { h: 0.5, v: 0.5, severity: 0, away: false, awaySince: 0, counted: false, warmupUntil: 0 };
// The tracked tab's state, captured from the preview's token handshake in init().
let trackedToken = null;
let trackedTabId = null;
// True while the tracked tab is focused and visible; posted by tracker.js (an iframe
// reports document.hasFocus() false unless it is clicked itself).
let previewFocused = false;
// Visual only: hides the mesh and the eye boxes, never the badge or the counting.
let overlayOn = true;

// A preview only counts gaze while its tab is actually in front, so the popup it
// opens on, or a tab switch, cannot bank an away episode.
addEventListener('message', (event) => {
  if (!isPreview || event.source !== window.parent) return;
  if (event.data?.type === 'anticheat:focus') previewFocused = event.data.focused === true;
});

$('windowBtn').hidden = isWindow;
$('windowBtn').addEventListener('click', openWindow);
camToggle.addEventListener('change', () => {
  if (camToggle.checked) enableCamera();
  else stopCamera();
});

// The checkbox is the input, session storage the mirror every camera page reads.
function setOverlay(on) {
  overlayOn = on !== false;
  if (overlayToggle) overlayToggle.checked = overlayOn;
}

async function loadOverlay() {
  try {
    const stored = await chrome.storage.session.get(OVERLAY_KEY);
    setOverlay(stored?.[OVERLAY_KEY]);
  } catch (error) {
    console.warn('Certification Anticheat could not read the overlay toggle.', error);
  }
}

loadOverlay();
overlayToggle?.addEventListener('change', () => {
  setOverlay(overlayToggle.checked);
  chrome.storage.session.set({ [OVERLAY_KEY]: overlayOn }).catch((error) => {
    console.warn('Certification Anticheat could not save the overlay toggle.', error);
  });
});
// Another camera page toggled it: follow, so the popup and preview cannot disagree.
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes[OVERLAY_KEY]) setOverlay(changes[OVERLAY_KEY].newValue);
});

video.addEventListener('resize', resizeToVideo);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resumeCamera();
});
addEventListener('focus', resumeCamera);
// The camera page often sits minimized while the exam tab is in use, so any
// Chrome window getting focus is the cue to bring the camera back.
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) resumeCamera();
});

init();

async function init() {
  // Any embedded frame must be the tracked tab's preview: its tracker holds the
  // token, so other pages cannot use this page to turn the camera on. Never prompt.
  if (window.top !== window) {
    const { anticheat } = await chrome.storage.session.get('anticheat');
    if (!isPreview || anticheat?.token !== params.get('token')) return;
    trackedToken = anticheat.token;
    trackedTabId = anticheat.tabId;
    if ((await cameraPermission()) === 'granted') start();
    return;
  }

  const permission = await cameraPermission();

  if (permission === 'granted' || permission === null || isWindow) {
    start();
    return;
  }

  if (permission === 'denied') {
    showBlocked();
    return;
  }

  showCard(
    'Check if your eyes are visible',
    'Chrome closes popups while asking for camera access, so this opens a small window instead. Video stays on your device.',
    'Open camera',
    openWindow,
  );
}

async function cameraPermission() {
  try {
    return (await navigator.permissions.query({ name: 'camera' })).state;
  } catch {
    return null;
  }
}

async function enableCamera() {
  const permission = await cameraPermission();

  if (permission === 'denied') {
    setToggle(false);
    showBlocked();
    return;
  }

  if (permission === 'granted' || permission === null || isWindow) {
    start();
    return;
  }

  // Chrome closes popups when it shows the permission prompt, so use the window.
  setToggle(false);
  openWindow();
}

async function start() {
  if (starting || running) return;
  const id = ++session;
  starting = true;
  wanted = true;
  setToggle(true);
  hideCard();
  setBadge('Starting camera…', 'warn');

  let nextStream;
  try {
    nextStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    });
  } catch (error) {
    if (id !== session) return;
    starting = false;
    setToggle(false);
    handleCameraError(error);
    return;
  }

  // The toggle was switched off while the camera was starting.
  if (id !== session) {
    nextStream.getTracks().forEach((track) => track.stop());
    return;
  }

  stream = nextStream;
  video.srcObject = stream;
  nextStream.getVideoTracks()[0]?.addEventListener('ended', onTrackEnded);
  await video.play().catch(() => {});
  if (id !== session) return;
  resizeToVideo();

  setBadge('Loading eye detector…', 'warn');
  let nextLandmarker;
  try {
    nextLandmarker = await createLandmarker();
  } catch (error) {
    if (id !== session) return;
    console.error(error);
    stopStream();
    starting = false;
    setToggle(false);
    setBadge('Camera off', 'idle');
    showCard(
      'The eye detector could not load',
      'Reload the extension and try again. If it keeps failing, your browser may be blocking WebAssembly.',
      'Try again',
      start,
    );
    return;
  }

  // The toggle was switched off while the detector was loading.
  if (id !== session) {
    nextLandmarker.close();
    return;
  }

  landmarker = nextLandmarker;
  running = true;
  starting = false;
  // Samples from before the camera was live are useless; the warm-up also covers
  // the moment the eye detector settles.
  resetGaze();
  setBadge('No eyes visible', 'idle');
  empty.hidden = true;
  schedule(id);
}

function stopCamera() {
  wanted = false;
  session += 1;
  running = false;
  starting = false;
  stopLoop();
  stopStream();
  landmarker?.close();
  landmarker = null;
  resetGaze();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  setToggle(false);
  setBadge('Camera off', 'idle');
  showCard(
    'Camera is off',
    'The camera is released until you turn it back on. Nothing is recorded or uploaded.',
    'Turn on camera',
    enableCamera,
  );
}

async function createLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(
    new URL('./vendor/mediapipe/wasm', import.meta.url).href,
  );
  const options = {
    baseOptions: { modelAssetPath: new URL('./models/face_landmarker.task', import.meta.url).href },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
  };

  try {
    return await FaceLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: 'GPU' },
    });
  } catch (error) {
    console.warn('GPU delegate unavailable, using CPU instead.', error);
    return FaceLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: 'CPU' },
    });
  }
}

function tick(id) {
  if (!running || id !== session) return;

  // A dropped capture may never fire another frame; recover without waiting
  // for the user to touch the extension.
  if (!stream?.active) {
    restartCamera();
    return;
  }

  if (video.readyState >= 2) {
    let result = null;
    try {
      result = landmarker.detectForVideo(video, performance.now());
    } catch (error) {
      console.warn(error);
    }
    draw(result);
  }
}

// Detect on a timer instead of requestVideoFrameCallback: hidden or occluded
// windows stop presenting frames, which kills that loop for good. Timers always
// resume, and Chrome only throttles them while the page is hidden (about once a
// minute after five minutes, so minimized detection is coarse but not dead).
function schedule(id) {
  if (!running || id !== session) return;
  const token = loopToken;
  loopTimer = setTimeout(
    () => {
      if (token !== loopToken) return;
      tick(id);
      schedule(id);
    },
    document.visibilityState === 'hidden' ? 1000 : 100,
  );
}

function stopLoop() {
  loopToken += 1;
  clearTimeout(loopTimer);
}

// The browser can release the capture while another app is in front. Reacquire
// it in the background so it is already live when the user comes back. The
// cooldown keeps a dead device from turning this into a getUserMedia loop.
function restartCamera() {
  if (starting || Date.now() - lastRestart < 5000) return;
  lastRestart = Date.now();
  running = false;
  session += 1;
  stopLoop();
  stopStream();
  landmarker?.close();
  landmarker = null;
  resetGaze();
  start();
}

// The window or any Chrome window is active again: make sure the camera is live
// without waiting for a click. Works while the camera page stays minimized, and
// retries a start that failed earlier.
function resumeCamera() {
  if (!wanted || starting) return;

  if (!running) {
    start();
    return;
  }

  if (!stream?.active) {
    restartCamera();
    return;
  }

  video.play().catch(() => {});
  stopLoop();
  schedule(session);
}

function onTrackEnded() {
  if (running) restartCamera();
}

function resizeToVideo() {
  if (!video.videoWidth) return;
  stage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
}

// Every detected landmark as a dot, mirrored like the boxes. The vendored bundle
// does not export the mesh tesselation, so this is points, not a wireframe.
function drawMesh(landmarks, color) {
  const width = canvas.width;
  const height = canvas.height;
  const scale = Math.max(1, canvas.width / 320);
  const radius = Math.max(0.8, 1.3 * scale);

  ctx.fillStyle = color;
  ctx.beginPath();
  for (const point of landmarks) {
    const x = (1 - point.x) * width;
    const y = point.y * height;
    ctx.moveTo(x + radius, y);
    ctx.arc(x, y, radius, 0, Math.PI * 2);
  }
  ctx.fill();
}

function draw(result) {
  const width = canvas.width;
  const height = canvas.height;
  const landmarks = result?.faceLandmarks?.[0];
  ctx.clearRect(0, 0, width, height);

  if (!landmarks) {
    // A missing face is a glitch, never evidence of looking away.
    clearAway();
    setBadge('No eyes visible', 'idle');
    return;
  }

  const categories = result.faceBlendshapes?.[0]?.categories ?? [];
  const blink = (name) => categories.find((c) => c.categoryName === name)?.score ?? 0;
  const rightOpen = blink('eyeBlinkRight') < 0.5;
  const leftOpen = blink('eyeBlinkLeft') < 0.5;

  const rightBox = eyeBox(landmarks, RIGHT_EYE, width, height);
  const leftBox = eyeBox(landmarks, LEFT_EYE, width, height);

  updateGaze(result, rightOpen && leftOpen);
  if (overlayOn) drawMesh(landmarks, gazeColor(gaze.severity));

  if (!rightBox || !leftBox) {
    clearAway();
    setBadge('Keep both eyes in frame', 'warn');
    return;
  }

  const away = gaze.away;

  if (overlayOn) {
    drawEye(rightBox, 'R', rightOpen);
    drawEye(leftBox, 'L', leftOpen);
  }

  if (!rightOpen && !leftOpen) {
    setBadge('Eyes visible · closed', 'warn');
  } else if (!rightOpen || !leftOpen) {
    setBadge('Eyes visible · one closed', 'warn');
  } else if (away) {
    setBadge('Eyes visible · looking away', 'warn');
  } else {
    setBadge('Eyes visible · open', 'live');
  }
}

// Iris position inside the eye's normalized bounding box; 0.5, 0.5 is centred.
// Unmirrored, like the landmarks: mirroring belongs to eyeBox() and the CSS.
function irisOffset(landmarks, indices, irisIndex) {
  const iris = landmarks[irisIndex];
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;

  for (const index of indices) {
    const point = landmarks[index];
    if (!point) continue;
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }

  if (!iris || maxX <= minX || maxY <= minY) return null;

  return {
    h: (iris.x - minX) / (maxX - minX),
    v: (iris.y - minY) / (maxY - minY),
  };
}

// One usable gaze sample, or null when this frame cannot support an estimate.
// Closed eyes and a missing 478-point mesh (no iris) fail conservatively.
function gazeSample(result, open) {
  if (!open) return null;
  const landmarks = result?.faceLandmarks?.[0];
  if (!landmarks || landmarks.length < 478) return null;

  const right = irisOffset(landmarks, RIGHT_EYE, RIGHT_IRIS);
  const left = irisOffset(landmarks, LEFT_EYE, LEFT_IRIS);
  if (!right || !left) return null;

  return { h: (right.h + left.h) / 2, v: (right.v + left.v) / 2 };
}

// Hysteresis: entering needs the wider threshold, leaving the tighter one, so a
// value parked on the edge cannot flap the counter.
function gazeAway(h, v, wasAway) {
  const dx = Math.abs(h - 0.5);
  const dy = Math.abs(v - 0.5);
  if (wasAway) return !(dx <= GAZE_EXIT_X && dy <= GAZE_EXIT_Y);
  return dx >= GAZE_ENTER_X || dy >= GAZE_ENTER_Y;
}

// 0 is centred, 1 is exactly the away entry threshold, flat above so red stays red.
function gazeSeverity(h, v) {
  const sx = Math.abs(h - 0.5) / GAZE_ENTER_X;
  const sy = Math.abs(v - 0.5) / GAZE_ENTER_Y;
  return Math.min(1, Math.max(sx, sy));
}

// Mesh colour across the severity scale, as a two-stop lerp.
function gazeColor(severity) {
  const s = Math.min(1, Math.max(0, severity));
  const low = s < 0.5;
  const from = rgb(low ? GAZE_ON_COLOR : GAZE_MID_COLOR);
  const to = rgb(low ? GAZE_MID_COLOR : GAZE_AWAY_COLOR);
  const t = low ? s * 2 : s * 2 - 1;
  return `rgb(${from.map((value, i) => Math.round(value + (to[i] - value) * t)).join(', ')})`;
}

function rgb(hex) {
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
}

function updateGaze(result, open) {
  const now = performance.now();
  if (now < gaze.warmupUntil) return;

  // Only the preview inside the tracked tab counts, and only while that tab is
  // focused and visible: reading the popup is not looking away. The mesh and badge
  // keep updating everywhere, so the gate never blocks the visual. Clearing here,
  // before the sample check, keeps an unfocused blink from banking into a count.
  const gated = isPreview && (!previewFocused || document.visibilityState !== 'visible');
  if (gated) clearAway();

  const sample = gazeSample(result, open);
  if (!sample) return;

  gaze.h += GAZE_SMOOTH * (sample.h - gaze.h);
  gaze.v += GAZE_SMOOTH * (sample.v - gaze.v);
  gaze.severity = gazeSeverity(gaze.h, gaze.v);

  if (gated) return;

  const away = gazeAway(gaze.h, gaze.v, gaze.away);
  if (away !== gaze.away) {
    gaze.away = away;
    gaze.awaySince = away ? now : 0;
    gaze.counted = false;
  } else if (away && !gaze.counted && now - gaze.awaySince >= AWAY_MS) {
    gaze.counted = true;
    countLookAway();
  }
}

// One count per sustained episode, and only ever into the tracked tab's own state.
async function countLookAway() {
  if (!isPreview || !trackedToken || !trackedTabId) return;

  try {
    const { anticheat } = await chrome.storage.session.get('anticheat');
    if (!anticheat || anticheat.token !== trackedToken || anticheat.tabId !== trackedTabId) return;
    await chrome.storage.session.set({
      anticheat: {
        ...anticheat,
        lookAway: (anticheat.lookAway || 0) + 1,
        last: { kind: 'away', at: Date.now() },
      },
    });
  } catch (error) {
    console.warn('Certification Anticheat could not save the look-away count.', error);
  }
}

function clearAway() {
  gaze.away = false;
  gaze.awaySince = 0;
  gaze.counted = false;
}

// Fresh camera session: forget the offset and start the warm-up again.
function resetGaze() {
  gaze = {
    h: 0.5,
    v: 0.5,
    severity: 0,
    away: false,
    awaySince: 0,
    counted: false,
    warmupUntil: performance.now() + GAZE_WARMUP_MS,
  };
}

// Mirrored coordinates so boxes line up with the selfie-style preview.
function eyeBox(landmarks, indices, width, height) {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;

  for (const index of indices) {
    const point = landmarks[index];
    if (!point) continue;
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }

  if (maxX < minX) return null;

  const x0 = (1 - maxX) * width;
  const x1 = (1 - minX) * width;
  const y0 = minY * height;
  const y1 = maxY * height;
  const eyeWidth = x1 - x0;
  const padX = eyeWidth * 0.35;
  const padY = Math.max((y1 - y0) * 0.7, eyeWidth * 0.45);

  const box = {
    x: x0 - padX,
    y: y0 - padY,
    w: x1 - x0 + padX * 2,
    h: y1 - y0 + padY * 2,
  };

  if (box.x + box.w < 0 || box.x > width || box.y + box.h < 0 || box.y > height) {
    return null;
  }
  return box;
}

function drawEye(box, label, open) {
  const color = open ? '#4ade80' : '#fbbf24';
  const scale = Math.max(1, canvas.width / 320);
  const radius = Math.min(10 * scale, box.w / 4);

  ctx.save();
  ctx.lineWidth = 2.5 * scale;
  ctx.strokeStyle = color;
  ctx.fillStyle = `${color}1f`;
  ctx.beginPath();
  ctx.roundRect(box.x, box.y, box.w, box.h, radius);
  ctx.fill();
  ctx.stroke();

  const fontSize = 11 * scale;
  ctx.font = `650 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
  const labelW = ctx.measureText(label).width + 10 * scale;
  const labelH = fontSize + 6 * scale;
  const labelX = box.x;
  const labelY = Math.max(2 * scale, box.y - labelH - 4 * scale);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(labelX, labelY, labelW, labelH, 4 * scale);
  ctx.fill();
  ctx.fillStyle = '#07120a';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, labelX + 5 * scale, labelY + labelH / 2);
  ctx.restore();
}

function setBadge(text, tone) {
  badge.textContent = text;
  dot.className = `dot ${tone}`;
}

function setToggle(on) {
  camToggle.checked = on;
}

function showCard(title, text, actionLabel, onAction) {
  emptyTitle.textContent = title;
  emptyText.textContent = text;
  startBtn.textContent = actionLabel;
  startBtn.onclick = onAction;
  empty.hidden = false;
}

function hideCard() {
  empty.hidden = true;
}

function showBlocked() {
  showCard(
    'Camera is blocked',
    'Allow camera access for this extension in Chrome site settings, then reopen Certification Anticheat.',
    'Open settings',
    openSettings,
  );
  setBadge('Camera off', 'idle');
}

function handleCameraError(error) {
  if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
    showBlocked();
  } else if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
    showCard(
      'No camera found',
      'Connect a webcam and try again.',
      'Try again',
      start,
    );
  } else if (error.name === 'NotReadableError') {
    showCard(
      'Camera is busy',
      'Another app is using the camera. Close it and try again.',
      'Try again',
      start,
    );
  } else {
    showCard(
      'Could not start the camera',
      `${error.name}: ${error.message}`,
      'Try again',
      start,
    );
  }
  setBadge('Camera off', 'idle');
}

function openWindow() {
  if (globalThis.chrome?.windows) {
    chrome.windows.create({
      url: chrome.runtime.getURL('camera.html?window=1'),
      type: 'popup',
      width: 620,
      height: 780,
    });
  } else {
    window.open('camera.html?window=1', '_blank', 'width=620,height=780');
  }
}

function openSettings() {
  const url = `chrome://settings/content/siteDetails?site=${encodeURIComponent(
    `chrome-extension://${chrome.runtime.id}/`,
  )}`;
  if (globalThis.chrome?.tabs) {
    chrome.tabs.create({ url });
  }
}

function stopStream() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
}

window.addEventListener('pagehide', () => {
  session += 1;
  running = false;
  starting = false;
  stopLoop();
  stopStream();
  landmarker?.close();
  landmarker = null;
  resetGaze();
});

// Silent self-check for the gaze math: logs only if a threshold regresses.
(() => {
  const check = (label, actual, expected) => {
    if (actual !== expected) {
      console.error(`Certification Anticheat gaze self-check failed: ${label}`);
    }
  };

  const eye = [{ x: 0.4, y: 0.4 }, { x: 0.6, y: 0.5 }];
  const centred = irisOffset([...eye, { x: 0.5, y: 0.45 }], [0, 1], 2);
  check(
    'centred iris is 0.5, 0.5',
    !!centred && Math.abs(centred.h - 0.5) < 1e-9 && Math.abs(centred.v - 0.5) < 1e-9,
    true,
  );
  check('centred is not away', gazeAway(0.5, 0.5, false), false);
  check('enter x is away', gazeAway(0.5 + GAZE_ENTER_X, 0.5, false), true);
  check('enter y is away', gazeAway(0.5, 0.5 - GAZE_ENTER_Y - 0.001, false), true);
  const band = 0.5 + (GAZE_EXIT_X + GAZE_ENTER_X) / 2;
  check('hysteresis band holds away', gazeAway(band, 0.5, true), true);
  check('exit threshold releases', gazeAway(0.5 + GAZE_EXIT_X - 0.001, 0.5, true), false);

  check('centred severity is 0', gazeSeverity(0.5, 0.5), 0);
  check(
    'half the enter threshold is about 0.5',
    Math.abs(gazeSeverity(0.5 + GAZE_ENTER_X / 2, 0.5) - 0.5) < 1e-9,
    true,
  );
  check('enter threshold is severity 1', gazeSeverity(0.5 + GAZE_ENTER_X, 0.5), 1);
  check('beyond the threshold is clamped', gazeSeverity(0.5 + GAZE_ENTER_X * 3, 0.5), 1);
  const edges = [
    [0.5 + GAZE_ENTER_X * 1.5, 0.5],
    [0.5 - GAZE_ENTER_X * 1.5, 0.5],
    [0.5, 0.5 + GAZE_ENTER_Y * 1.5],
    [0.5, 0.5 - GAZE_ENTER_Y * 1.5],
  ];
  check(
    'severity 1 matches gazeAway on both axes',
    edges.every(([h, v]) => (gazeSeverity(h, v) >= 1) === gazeAway(h, v, false)),
    true,
  );

  const flatFace = {
    faceLandmarks: [Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }))],
  };
  check('closed eyes are skipped', gazeSample(flatFace, false), null);
  check('degenerate eye box is skipped', gazeSample(flatFace, true), null);
  check('short landmark list is skipped', gazeSample({ faceLandmarks: [[]] }, true), null);
})();
