# AGENTS.md (Eye Check)

## What this is
- MV3 Chrome extension, popup-only: no background/service worker. `manifest.json` points the action popup at `camera.html`, which loads `anticheat.js` and `camera.js` as scripts.
- Camera logic is in `camera.js`: `getUserMedia` → MediaPipe `FaceLandmarker` (VIDEO mode, 1 face, blendshapes) → boxes around the eyes, open/closed from `eyeBlinkLeft`/`eyeBlinkRight`.
- Anti-cheat logic is in `anticheat.js` (popup panel) and `tracker.js` (a script injected on demand into the one watched tab).
- Fully offline by design. `vendor/mediapipe/` (bundle + WASM + Apache-2.0 LICENSE) and `models/face_landmarker.task` are vendored. Never switch to CDN/npm imports or remote URLs — MV3 CSP blocks remote code.
- Same page opens in a larger window via `?window=1` for the first-run permission prompt.

## Project direction (why it exists)
- This repo is the seed of a Chrome extension based anti-cheat system for online certification quizzes/exams.
- Planned features are the usual anti-cheat controls: enforced full screen and similar. Add them as separate, clearly-scoped features; the camera is only one signal.
- Shipped anti-cheat signal: the popup can watch one tab and count how many times that tab is hidden or its window loses focus (tab/app switches). That is `anticheat.js` + injected `tracker.js`.
- The camera feature is an experiment: use the device camera to notice when the candidate looks away from the screen (e.g. glancing at a phone to cheat). Today that means eye-landmark boxes plus open/closed state — there is no real gaze-heading estimate yet, so don't describe it as one.
- Keep the honest framing: a prototype attention check, not a reliable proctoring system. Future anti-cheat work should not make the README over-claim accuracy.

## Run / verify
- No `package.json`, build, lint, or test scripts. Don't add a bundler or package manager; the folder is loaded raw.
- `chrome://extensions` → Developer mode → Load unpacked → repo root. After editing, click Reload on the extension card, then reopen the popup (Chrome caches the popup page/module).
- Manual verification: open the popup, right-click inside it → Inspect for console output (GPU fallback warning, detection errors, tracker errors). Check boxes, badge text, green/amber states. For anti-cheat, track a normal web page, close the popup, switch tabs/apps a few times, then reopen the popup and check the counter.
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
- Anti-cheat state is one object under `chrome.storage.session` key `anticheat`: `{ tabId, windowId, title, url, count, startedAt }`. One object means one watched tab; `trackThisTab()` stops the previous tracker before storing the new one. Never keep a list of tabs without a product decision.
- `anticheat.js` calls `chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })` so the injected content script can read/write the counter. Do this before injecting; otherwise tracker writes fail silently.
- Injection uses `chrome.scripting.executeScript({ files: ['tracker.js'] })` with `activeTab` (no host permissions). It only works on `http(s)` pages the user is currently on; keep `canInject()` in sync if that changes.
- `tracker.js` counts one departure per away episode, not one per event: `visibilitychange`, `blur`, `focus`, and `pageshow` all call `onStateChange()`, which only increments when the tab goes from focused/visible to hidden/unfocused and only resets when it comes back.
- The same count is mirrored on the watched page as a bubble (`#eye-check-anticheat`, fixed bottom-right, `pointer-events: none`) inside a shadow root, so page CSS cannot restyle it. `tracker.js` paints it from storage on `start` and after every successful `writeState`; `stop()` and `dispose()` remove it. Repaint is gated on `enabled` so a late write cannot recreate it after Stop. An element in fullscreen covers the bubble (top layer).
- The extension popup steals focus, so the tracker must be paused while the popup is open or checking the counter would inflate it. `anticheat.js` sends `anticheat:pause` and holds a `chrome.tabs.connect` port; the port disconnecting is the reliable resume signal. `tracker.js` also undoes an increment caused by the popup's own blur in the same window (`popupBlur` / `undo()`), and waits 250 ms after resume before deciding a switch is real.
- `tracker.js` must stay idempotent (`globalThis.__eyeCheckTracker`) because re-injection happens when a reloaded page needs reattaching. `start` re-enables an existing tracker instead of relying on a fresh injection.
- If the watched tab navigates/reloads while the popup is closed, the injected script is gone. Opening the popup on that tab pings it and re-injects, keeping the stored count. Don't add a background worker just for this without discussing it.
- `chrome.tabs.onRemoved` and the tab-exists check in `refresh()` clear stale tracking state when the watched tab is closed.

## Gotchas
- MV3 CSP requires `'wasm-unsafe-eval'` for MediaPipe (already set in `manifest.json`).
- Popup width is fixed at 360px in CSS; `html.window` (added from `?window=1`) widens it to 620px. Window size lives only in `openWindow` (620×780).
- Boxes mean eye landmarks were found, not that the eye is unobstructed; fixed 0.5 threshold. Limitations are documented in README — don't over-claim detection accuracy.
- No analytics or network calls. `chrome.storage.session` is the only storage, used for the anti-cheat counter; it is intentionally in-memory and cleared on restart. Keep it that way.
