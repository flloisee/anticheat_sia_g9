import { FilesetResolver, FaceLandmarker } from './vendor/mediapipe/vision_bundle.mjs';

const $ = (id) => document.getElementById(id);
const isWindow = new URLSearchParams(location.search).get('window') === '1';
if (isWindow) document.documentElement.classList.add('window');

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

// Subject's eyes: 33/263 are the outer corners, the rest trace the lids.
const RIGHT_EYE = [33, 160, 158, 133, 153, 144, 163, 7, 246];
const LEFT_EYE = [263, 387, 385, 380, 373, 362, 390, 249, 466];

let landmarker = null;
let stream = null;
let running = false;
let starting = false;
let session = 0;

$('windowBtn').hidden = isWindow;
$('windowBtn').addEventListener('click', openWindow);
camToggle.addEventListener('change', () => {
  if (camToggle.checked) enableCamera();
  else stopCamera();
});
video.addEventListener('resize', resizeToVideo);

init();

async function init() {
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
  setBadge('No eyes visible', 'idle');
  empty.hidden = true;
  video.requestVideoFrameCallback(() => tick(id));
}

function stopCamera() {
  session += 1;
  running = false;
  starting = false;
  stopStream();
  landmarker?.close();
  landmarker = null;
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

  if (video.readyState >= 2) {
    let result = null;
    try {
      result = landmarker.detectForVideo(video, performance.now());
    } catch (error) {
      console.warn(error);
    }
    draw(result);
  }

  video.requestVideoFrameCallback(() => tick(id));
}

function resizeToVideo() {
  if (!video.videoWidth) return;
  stage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
}

function draw(result) {
  const width = canvas.width;
  const height = canvas.height;
  const landmarks = result?.faceLandmarks?.[0];
  ctx.clearRect(0, 0, width, height);

  if (!landmarks) {
    setBadge('No eyes visible', 'idle');
    return;
  }

  const categories = result.faceBlendshapes?.[0]?.categories ?? [];
  const blink = (name) => categories.find((c) => c.categoryName === name)?.score ?? 0;
  const rightOpen = blink('eyeBlinkRight') < 0.5;
  const leftOpen = blink('eyeBlinkLeft') < 0.5;

  const rightBox = eyeBox(landmarks, RIGHT_EYE, width, height);
  const leftBox = eyeBox(landmarks, LEFT_EYE, width, height);

  if (!rightBox || !leftBox) {
    setBadge('Keep both eyes in frame', 'warn');
    return;
  }

  drawEye(rightBox, 'R', rightOpen);
  drawEye(leftBox, 'L', leftOpen);

  if (!rightOpen && !leftOpen) {
    setBadge('Eyes visible · closed', 'warn');
  } else if (!rightOpen || !leftOpen) {
    setBadge('Eyes visible · one closed', 'warn');
  } else {
    setBadge('Eyes visible · open', 'live');
  }
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
    'Allow camera access for this extension in Chrome site settings, then reopen Eye Check.',
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
  stopStream();
  landmarker?.close();
  landmarker = null;
});
