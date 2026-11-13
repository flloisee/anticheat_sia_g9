# Certification Anticheat

A Chrome extension prototype for anti-cheat in online quizzes and certification exams. It collects two signals while an exam is on screen:

- **Tab / app switches** — counts how many times the watched exam tab is hidden or its browser window loses focus.
- **Camera attention check** — opens the device camera and flags when the candidate's eyes are closed, not visible, or turned away from the screen, a rough proxy for looking away.

Everything runs locally. There are no network requests, no analytics, and nothing is uploaded.

## Project direction

This repo is the starting point for a Chrome extension based anti-cheat system. The goal is the set of controls real proctoring tools use — enforced full screen, tab and app monitoring, attention checks — added as separate, clearly-scoped features.

The tab-switch counter is the first shipped signal. The camera check is an experiment: it uses MediaPipe's face landmark model to draw the detected face mesh as dots, place boxes around the eyes, read open/closed state, and make a crude estimate of which way the eyes point from where the iris sits inside each eye. The mesh colour shows that estimate: white while the eyes are on screen, yellow as they drift off centre, red once they reach the away threshold. That estimate uses fixed thresholds with no per-user calibration, so it is a prototype attention check, not reliable gaze tracking, and not a finished proctoring product (see [Limitations](#limitations)).

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Pin **Certification Anticheat** and click its toolbar icon.

## How it works

### Tab / app switch counter

- **Start monitoring** asks the background worker to inject `tracker.js` into the active `http(s)` page. That script listens to `visibilitychange`, `blur`, and `focus` and adds one to the counter each time the watched tab is hidden or its window loses focus. Leaving and returning counts once, not once per event.
- The count also shows in a floating bubble in the lower-right corner of the watched page, so it stays visible while the exam is on screen. The bubble is a shadow-root element with `pointer-events: none`, so page styles do not affect it and it never blocks the page. It shows one total of both signals with the last trigger beside it, for example `4 events · looked away`. The total is only how the two are displayed: the stored state still keeps tab / app switches and look-aways apart, so nothing is merged or lost. A three-ping burst of short, loud, high-pitched tones plays when the total goes up, generated in the browser with the Web Audio API at a fixed level (no volume setting) — no audio files, nothing downloaded — and, because of the browser's autoplay rule, it can only sound once the page has been clicked at least once.
- A small camera preview sits just above that bubble while a tab is tracked. It is the same `camera.html` in a tiny iframe, so the camera belongs to the watched tab and returns when that tab is focused again. It stays hidden until camera access has been granted once from the popup.
- The counter lives in `chrome.storage.session` (key `anticheat`), so it survives closing the popup but is cleared when Chrome or the extension restarts. Starting to track another tab replaces the first one — only one tab is watched at a time.
- While the popup is open it pauses the tracker, because focusing the popup would otherwise look like a focus loss. The tracker resumes when the popup closes. If the watched tab reloads, the injected script is gone; opening the popup on that tab reattaches it and keeps the existing count.
- Closing the watched tab clears the tracking state.

### Suggesting monitoring

On the supported training sites the prompt appears by itself: open a quiz or exam section on NetAcad, Skills for All, Fortinet Training, Juniper, Palo Alto Networks, Check Point, Cybrary, A Cloud Guru, Pluralsight, KodeKloud, Coursera, Udemy, edX, OffSec, ISC2, Certiport, Pearson VUE, Prometric, PSI Exams, TestOut or CompTIA and it offers monitoring within a few seconds, no toolbar click needed. That detection runs inside the page, because those hosts are declared in the manifest for it. Every other site still needs the toolbar popup: host permissions cover only those training hosts, so a click is what grants access to any other page. Either way the prompt is a centered modal with a dimmed backdrop drawn over the page, not a row in the popup, because the popup closes as soon as you click the page. It is a shadow-root element so page styles cannot change it, and it offers **Start monitoring** and **Not now**. Escape, a click on the backdrop, or **Not now** only closes the modal for that page visit: nothing is remembered, so a later visit to a quiz page in the same tab (a reload, a new page or a new URL) is offered again. Nothing is injected into the exam tab, no camera starts and no state is written until you press Start.

It looks for a timer, repeated question blocks, question counters ("1 of 10 Questions"), a quiz/exam word in the page title or in a real heading, a "Question 1"-style question start, dropdown or checkbox question groups, LMS quiz modules (`/mod/quiz/`, `/mod/scorm/`), known quiz/proctoring hosts and known certification-training hosts such as NetAcad and Fortinet Training. Wording in a sidebar or in ordinary body copy is not enough on its own, because a training site lists its quiz section on every page, and an exam-looking URL only counts together with one of the question signals above. It also re-checks when a single-page app changes route and again half a second, two seconds and five seconds later, because quiz views usually render after the route changes. Every frame of the tab reports on its own, and a small background worker adds those reports up and shows the prompt once per page visit, which is the only thing it does besides handling the buttons you press. Frames on an unrelated third-party host run no detector, so a quiz inside one stays invisible. Detection is still a guess: it can miss pages such as LockDown Browser, native exam apps, PDFs, `chrome://` pages and those third-party frames, and it is not proctoring. Tracking a tab you open manually still works as before.

### Camera attention check

- `camera.js` gets a camera stream with `getUserMedia` and runs `FaceLandmarker` in `VIDEO` mode on each video frame.
- Eye boxes are built from the face mesh's eye-contour landmarks, mirrored so they match the selfie preview. Green means open, amber means closed. The full face mesh is drawn as small dots over the preview, coloured by how far the eyes are from the screen: white while on screen, yellow as they move off centre, red when the estimate reaches the away threshold — the same point that starts the look-away timer, so the counter moves only once the estimate gets there. The **Overlay** toggle in the footer legend hides the dots and the eye boxes, and applies to the on-page preview as well because the value is mirrored through session storage; it is purely visual, so the badge and the counting — including look-aways — are unaffected.
- `eyeBlinkLeft` / `eyeBlinkRight` blendshapes decide whether each eye is open or closed.
- Looking away is a crude iris-position heuristic, not calibrated gaze tracking. For each eye it takes the iris centre (mesh landmarks 468 and 473), works out where that sits inside the eye's bounding box in normalized coordinates (0.5 is centred), averages both eyes, and smooths the result. A sustained offset from centre — sideways or down — counts as looking away, with a tighter threshold to come back, so it does not flap. Only one count per episode: the eyes have to stay away for 1.2 s, and each new look-away is counted again. The first two seconds after the camera starts are ignored. No face, too few landmarks, closed eyes and a degenerate eye box never count, because camera glitches and blinks are not evidence of anything.
- The look-away count is added to the same session state as the tab-switch count, so it counts towards the one total shown in the popup and in the on-page bubble while staying a separate field in storage. Only the camera preview inside the watched, focused tab can increment it: it checks the state's token and tab id before writing, never creates the state, and pauses while the extension popup is open or the tab is hidden (the frame is told when its tab is focused, because an iframe cannot tell that itself). The camera in the popup or the larger window still shows its live badge and mesh so the detector can be checked, but it never counts.
- The header **Camera** toggle turns the camera off on demand: it stops the media tracks, closes the landmarker, clears the overlay, and shows a card to turn it back on. The state is not persisted; closing the popup already releases the camera.
- While the page is hidden (a minimized window or another app in front), the detection loop falls back to a slower timer and keeps running; Chrome throttles hidden timers (down to about once a minute after five minutes), so detection is coarse there and resumes at full rate when the window is back. When a Chrome window regains focus, the camera resumes or reacquires the capture on its own, without the user clicking the extension, even if the camera page stays minimized.
- MediaPipe's WASM runtime and the `face_landmarker.task` model are bundled under `vendor/` and `models/`, so the extension works offline and needs no remote code (required by Manifest V3).

### First run (camera permission)

Chrome closes extension popups when a permission prompt takes focus, so the first camera request is made in a small extension window instead. Click **Allow camera**, allow access in that window, and use the preview there. After that the popup can open the camera directly.

If the prompt never appears, open Chrome's site settings for the extension (`chrome://settings/content/siteDetails?site=chrome-extension://<extension-id>/`) and set **Camera** to **Allow**.

## Permissions

The extension uses `activeTab` and `scripting` to inject the tracker only into the tab the user chooses, plus `storage` for the session counter; it makes no network requests. Host permissions are limited to the 22 certification-training sites listed above — the same list the auto-detector runs on. That does not change the install warning, because the extension already had access to exactly those sites through `content_scripts`; what the `host_permissions` entry adds is the ability for **Start monitoring** on the auto-prompt to inject the tracker there, since `executeScript` needs host permission or `activeTab` and the auto-prompt has no toolbar click behind it. On those hosts the extension also declares `content_scripts`, which is how it can look at the page before you click the toolbar icon; it only reads the page there and reports which signal labels it saw. Every other site still needs the toolbar click, and nothing grants access beyond it. A small background service worker (`worker.js`) handles the consent buttons, the popup's Start button and the union of those labels: it is not allowed to poll or watch tabs. The popup is `camera.html`; the same page opens in a larger window with `?window=1` for the permission prompt and a bigger preview, and is embedded as the on-page camera preview, so it is listed in `web_accessible_resources` for the tracked page to load it as a frame.

## Limitations

- The switch counter measures focus loss, not intent. It can miss a very quick tab-away-and-back, and it cannot tell a candidate checking their notes from one answering a message.
- The counter is local session state: it is cleared on browser or extension restart, and the candidate can stop tracking. If the watched tab reloads while the popup is closed, counting pauses until the popup is opened on that tab again to reattach the tracker.
- The exam prompt is only a suggestion, and it can be dismissed. **Not now** (or Escape, or a backdrop click) closes it for that page visit only, so the next visit to a quiz page in the same tab offers again. On hosts outside the supported training list it is offered only after you open the popup on that page.
- The floating counter is a normal page element. A page script can remove it, and a page element in fullscreen covers it, so it is a visible reminder, not enforcement.
- Boxes indicate that the model detected eye landmarks, not that nothing is covering the eye. Sunglasses or a hand over one eye can still produce a tracked box.
- Blink detection is a blendshape score with a fixed 0.5 threshold; very small or far-away faces are less reliable.
- The look-away check is a rough iris-position heuristic with fixed thresholds and no per-user calibration: head turns, glasses glare, lighting, camera angle and low resolution can all fool it in either direction, so a white, yellow or red mesh is a guess, not a measurement. It is a prototype attention check, not reliable gaze tracking, and it cannot tell a glance at a phone from a glance at a scratch pad.
- If the GPU delegate is unavailable, it falls back to CPU automatically, which is slower.
- A minimized or covered extension window slows the camera loop to a throttled timer, so detection while another app is in front is coarse (about once a minute after five minutes); the camera stream itself stays open, and it is reacquired automatically when a Chrome window regains focus.
- This is not tamper-proof proctoring. It is a visible prototype of the signals an anti-cheat tool would collect.

## Credits

Face detection uses [`@mediapipe/tasks-vision`](https://www.npmjs.com/package/@mediapipe/tasks-vision) (Apache License 2.0). The license is included in `vendor/mediapipe/LICENSE`.

## License

This project is released under the [MIT License](LICENSE). The bundled MediaPipe runtime and model remain under Apache License 2.0.
