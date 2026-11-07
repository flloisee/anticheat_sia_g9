# AGENTS.md (Eye Check)

## What this is
- MV3 Chrome extension, popup-only: no background/service worker and no content scripts. `manifest.json` points the action popup at `camera.html`, which loads `camera.js` as an ES module.
- All logic is in `camera.js`: `getUserMedia` → MediaPipe `FaceLandmarker` (VIDEO mode, 1 face, blendshapes) → boxes around the eyes, open/closed from `eyeBlinkLeft`/`eyeBlinkRight`.
- Fully offline by design. `vendor/mediapipe/` (bundle + WASM + Apache-2.0 LICENSE) and `models/face_landmarker.task` are vendored. Never switch to CDN/npm imports or remote URLs — MV3 CSP blocks remote code.
- Same page opens in a larger window via `?window=1` for the first-run permission prompt.

## Project direction (why it exists)
- This repo is the seed of a Chrome extension based anti-cheat system for online certification quizzes/exams.
- Planned features are the usual anti-cheat controls: enforced full screen, tab-switch / focus-loss detection, and similar. Add them as separate, clearly-scoped features; the camera is only one signal.
- The current shipped feature is an experiment: use the device camera to notice when the candidate looks away from the screen (e.g. glancing at a phone to cheat). Today that means eye-landmark boxes plus open/closed state — there is no real gaze-heading estimate yet, so don't describe it as one.
- Keep the honest framing: a prototype attention check, not a reliable proctoring system. Future anti-cheat work should not make the README over-claim accuracy.

## Run / verify
- No `package.json`, build, lint, or test scripts. Don't add a bundler or package manager; the folder is loaded raw.
- `chrome://extensions` → Developer mode → Load unpacked → repo root. After editing, click Reload on the extension card, then reopen the popup (Chrome caches the popup page/module).
- Manual verification: open the popup, right-click inside it → Inspect for console output (GPU fallback warning, detection errors). Check boxes, badge text, green/amber states.
- To re-test first-run permission: reset camera permission for `chrome-extension://<id>/` in Chrome site settings.

## Key behavior (don't accidentally break)
- Mirroring is split across two places: CSS flips only the video (`transform: scaleX(-1)`), not the canvas, so `eyeBox()` mirrors x as `(1 - x) * width`. Change both together or boxes drift off the eyes.
- Eye landmarks are hardcoded: `RIGHT_EYE = [33,160,158,133,153,144,163,7,246]`, `LEFT_EYE = [263,387,385,380,373,362,390,249,466]`.
- Blink: blendshape score `< 0.5` ⇒ open. `drawEye` draws green (open) / amber (closed); badge wording and tones are set in `draw()`/`setBadge` (`idle`/`warn`/`live`).
- Permission flow in `init()`: `navigator.permissions.query({name:'camera'})`; granted/null or `?window=1` → start; denied → blocked card with settings link; unknown → card that calls `openWindow()`.
- `openWindow`/`openSettings` use `chrome.windows.create` / `chrome.tabs.create` when present, with `window.open`/no-op fallbacks. No manifest `permissions` are needed for these; don't add broad permissions.
- Camera failures are mapped by `DOMException.name` in `handleCameraError` (NotAllowed/Security → blocked, NotFound/Overconstrained → no camera, NotReadable → busy). Add new cases there, not in `start()`.
- The header **Camera** toggle (`#camToggle`) enables/starts the camera via `enableCamera()` and turns it off via `stopCamera()`, which releases the stream, closes the landmarker, clears the canvas, and shows the off card. Don't persist the toggle in storage; closing the popup already releases the camera.
- `start()` is async and cancellable via the `session` counter: toggling off while the camera or detector is still loading must not leave a live track or landmarker behind.
- Detection loop is `video.requestVideoFrameCallback(tick)`; canvas is sized from `videoWidth`/`videoHeight` on video `resize` and after play. `starting`/`running` guard against double starts.
- `pagehide` stops tracks and closes the landmarker. Any new long-lived resource must be cleaned up there.
- WASM and model paths use `new URL(..., import.meta.url)` so they resolve in both popup and window. Keep them relative.

## Gotchas
- MV3 CSP requires `'wasm-unsafe-eval'` for MediaPipe (already set in `manifest.json`).
- Popup width is fixed at 360px in CSS; `html.window` (added from `?window=1`) widens it to 620px. Window size lives only in `openWindow` (620×780).
- Boxes mean eye landmarks were found, not that the eye is unobstructed; fixed 0.5 threshold. Limitations are documented in README — don't over-claim detection accuracy.
- No analytics, storage, or network calls; keep it that way.
