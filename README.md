# anticheat_sia_g9

A Chrome extension prototype for anti-cheat in online quizzes and certification exams. It collects two signals while an exam is on screen:

- **Tab / app switches** — counts how many times the watched exam tab is hidden or its browser window loses focus.
- **Camera attention check** — opens the device camera and flags when the candidate's eyes are closed or not visible, a rough proxy for looking away from the screen.

Everything runs locally. There are no network requests, no analytics, and nothing is uploaded.

## Project direction

This repo is the starting point for a Chrome extension based anti-cheat system. The goal is the set of controls real proctoring tools use — enforced full screen, tab and app monitoring, attention checks — added as separate, clearly-scoped features.

The tab-switch counter is the first shipped signal. The camera check is an experiment: it uses MediaPipe's face landmark model to place boxes around the eyes and read open/closed state. It is a prototype attention check, not gaze tracking, and not a finished proctoring product (see [Limitations](#limitations)).

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Pin **Eye Check** and click its toolbar icon.

## How it works

### Tab / app switch counter

- **Track this tab** injects `tracker.js` into the active `http(s)` page. That script listens to `visibilitychange`, `blur`, and `focus` and adds one to the counter each time the watched tab is hidden or its window loses focus. Leaving and returning counts once, not once per event.
- The count also shows in a floating bubble in the lower-right corner of the watched page, so it stays visible while the exam is on screen. The bubble is a shadow-root element with `pointer-events: none`, so page styles do not affect it and it never blocks the page.
- The counter lives in `chrome.storage.session` (key `anticheat`), so it survives closing the popup but is cleared when Chrome or the extension restarts. Starting to track another tab replaces the first one — only one tab is watched at a time.
- While the popup is open it pauses the tracker, because focusing the popup would otherwise look like a focus loss. The tracker resumes when the popup closes. If the watched tab reloads, the injected script is gone; opening the popup on that tab reattaches it and keeps the existing count.
- Closing the watched tab clears the tracking state.

### Camera attention check

- `camera.js` gets a camera stream with `getUserMedia` and runs `FaceLandmarker` in `VIDEO` mode on each video frame.
- Eye boxes are built from the face mesh's eye-contour landmarks, mirrored so they match the selfie preview. Green means open, amber means closed.
- `eyeBlinkLeft` / `eyeBlinkRight` blendshapes decide whether each eye is open or closed.
- The header **Camera** toggle turns the camera off on demand: it stops the media tracks, closes the landmarker, clears the overlay, and shows a card to turn it back on. The state is not persisted; closing the popup already releases the camera.
- MediaPipe's WASM runtime and the `face_landmarker.task` model are bundled under `vendor/` and `models/`, so the extension works offline and needs no remote code (required by Manifest V3).

### First run (camera permission)

Chrome closes extension popups when a permission prompt takes focus, so the first camera request is made in a small extension window instead. Click **Allow camera**, allow access in that window, and use the preview there. After that the popup can open the camera directly.

If the prompt never appears, open Chrome's site settings for the extension (`chrome://settings/content/siteDetails?site=chrome-extension://<extension-id>/`) and set **Camera** to **Allow**.

## Permissions

The extension uses `activeTab` and `scripting` to inject the tracker only into the tab the user chooses, plus `storage` for the session counter. There are no host permissions, no background worker, and no network requests. The popup is `camera.html`; the same page opens in a larger window with `?window=1` for the permission prompt and a bigger preview.

## Limitations

- The switch counter measures focus loss, not intent. It can miss a very quick tab-away-and-back, and it cannot tell a candidate checking their notes from one answering a message.
- The counter is local session state: it is cleared on browser or extension restart, and the candidate can stop tracking. If the watched tab reloads while the popup is closed, counting pauses until the popup is opened on that tab again to reattach the tracker.
- The floating counter is a normal page element. A page script can remove it, and a page element in fullscreen covers it, so it is a visible reminder, not enforcement.
- Boxes indicate that the model detected eye landmarks, not that nothing is covering the eye. Sunglasses or a hand over one eye can still produce a tracked box.
- Blink detection is a blendshape score with a fixed 0.5 threshold; very small or far-away faces are less reliable.
- The camera check does not yet estimate gaze direction. Closed or missing eyes are the only attention signal today.
- If the GPU delegate is unavailable, it falls back to CPU automatically, which is slower.
- This is not tamper-proof proctoring. It is a visible prototype of the signals an anti-cheat tool would collect.

## Credits

Face detection uses [`@mediapipe/tasks-vision`](https://www.npmjs.com/package/@mediapipe/tasks-vision) (Apache License 2.0). The license is included in `vendor/mediapipe/LICENSE`.

## License

This project is released under the [MIT License](LICENSE). The bundled MediaPipe runtime and model remain under Apache License 2.0.
