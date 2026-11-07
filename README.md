# Eye Check

A Chrome extension that opens your camera in the popup, finds your eyes with MediaPipe's face landmark model, and draws a box around each one. Green means open, amber means closed.

Everything runs locally. There are no network requests and no analytics.

## Project direction

This repo is the starting point for a Chrome extension based anti-cheat system for taking quizzes and exams in online certifications. More features will be added that line up with what real anti-cheat tools do, such as requiring full screen and detecting when the candidate tabs out of the exam.

Right now it is a camera experiment: the extension watches the candidate's face to catch attention drifting away from the screen — for example when they look down at a phone to look up answers. Eye state is the current signal; gaze-away detection is the behaviour being tested. Treat it as a prototype, not a finished proctoring product (see [Limitations](#limitations)).

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Pin **Eye Check** and click its toolbar icon.

## First run (camera permission)

Chrome closes extension popups when a permission prompt takes focus, so the first camera request is made in a small extension window instead. Click **Allow camera**, allow access in that window, and use the preview there. After that the popup can open the camera directly.

If the prompt never appears, open Chrome's site settings for the extension (`chrome://settings/content/siteDetails?site=chrome-extension://<extension-id>/`) and set **Camera** to **Allow**.

## How it works

- `camera.js` gets a camera stream with `getUserMedia` and runs `FaceLandmarker` in `VIDEO` mode on each video frame.
- Eye boxes are built from the face mesh's eye-contour landmarks, mirrored so they match the selfie preview.
- `eyeBlinkLeft` / `eyeBlinkRight` blendshapes decide whether each eye is open or closed.
- The **Camera** toggle in the header turns the camera off on demand: it stops the media tracks, closes the landmarker, clears the overlay, and shows a card to turn it back on. The state is not persisted; closing the popup already releases the camera.
- The popup is `camera.html`; the same page opens in a larger window with `?window=1` for the permission prompt and a bigger preview.

The MediaPipe WASM runtime and the `face_landmarker.task` model are bundled under `vendor/` and `models/`, so the extension works offline and needs no remote code (required by Manifest V3).

## Limitations

- Boxes indicate that the model detected eye landmarks, not that nothing is covering your eye. Sunglasses or a hand over one eye can still produce a tracked box.
- Blink detection is a blendshape score with a fixed 0.5 threshold; very small or far-away faces are less reliable.
- If the GPU delegate is unavailable, it falls back to CPU automatically, which is slower.

## Credits

Face detection uses [`@mediapipe/tasks-vision`](https://www.npmjs.com/package/@mediapipe/tasks-vision) (Apache License 2.0). The license is included in `vendor/mediapipe/LICENSE`.

## License

This project is released under the [MIT License](LICENSE). The bundled MediaPipe runtime and model remain under Apache License 2.0.
