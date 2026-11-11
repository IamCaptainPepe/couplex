# Couplex

A Chrome / Edge / Firefox extension that replaces images on web pages with photos of Alex Cooper.
Inspired by [nCage](https://github.com/Fortyseven/nCage), which swapped every image for a picture of Nicolas Cage.

## What it does

- When a page loads, it rolls the dice once: **page chance** (40% by default).
- If the page wins the roll, it replaces a **share of the images** (35% by default) — picked at random, not every Nth one.
- Images smaller than the **minimum size** (64 px by default) are left alone, so tiny icons don't turn into mush.
- Images that arrive later are handled too — lazy loading, infinite feeds, single-page apps.
- Every photo ships in three shapes (square, landscape 3:2, portrait 2:3). The extension picks the crop that matches the slot on the page and positions it so the face and the top of the head stay in frame.

The toggles live in the popup on the toolbar icon. Settings apply after you reload the page.

## Install in Chrome

1. Download this repository — **Code → Download ZIP** and unpack it, or `git clone`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top-right switch).
4. Click **Load unpacked** and pick the `couplex` folder.
5. The icon appears in the toolbar — open any site.

## Install in Edge

Same steps: `edge://extensions` → **Developer mode** → **Load unpacked**.

## Install in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Pick `couplex/manifest.json`.

In Firefox the extension lives until the browser restarts — that is a limit of temporary add-ons, not of the extension itself.

## Adding photos

Photos live in `images/` as WebP, and the list is `images/index.json`.

```bash
# from a folder of PNG/JPG files
python3 tools/build_images.py /path/to/photos
```

The script needs Pillow and insightface, because it detects the face in every photo and makes three head-centred crops. To install them:

```bash
pip install pillow insightface onnxruntime
```

Each source photo becomes three files:

- `<name>_sq.webp` — 1:1
- `<name>_l.webp` — 3:2 landscape
- `<name>_p.webp` — 2:3 portrait

`images/index.json` stores the pixel size of each crop and the face box as fractions of the frame:

```json
{"version": 3, "images": [{"n": "m001_sq.webp", "w": 1024, "h": 1024, "f": [0.2752, 0.0487, 0.1038, 0.1403], "b": "m001"}]}
```

### Adding more photos to a published build

1. Drop the new source files into a folder.
2. Run the script on that folder.
3. Bump `version` in `manifest.json` (for example `0.1.0` → `0.1.1`).
4. Commit and push.

Existing installs pick up the new photos after the browser updates the unpacked folder — or simply reload the extension on `chrome://extensions`.

## How it works

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3, `<all_urls>` host permission, content script at `document_idle` |
| `content.js` | rolls the page, picks images, swaps the sources, keeps the face in frame |
| `popup.html`, `popup.js`, `popup.css` | the three sliders, the on/off switch and the counters |
| `images/` | the photo set: three crops per photo plus `index.json` |
| `tools/build_images.py` | builds `images/` from a folder of originals |
| `icons/` | toolbar icons |

The content script rewrites `img.src` to a `chrome-extension://` URL and removes `srcset`, `sizes` and any `<source>` inside a `<picture>` element, because those would otherwise override the swap. Images already replaced are marked with `data-couplex="1"`, so a second pass never touches them.

## Privacy

The extension makes no network requests. Everything it shows ships inside the package; the only local read is `images/index.json` and the browser's own `storage.sync` for the settings.

## Limitations

- `canvas`, CSS background images and `<video>` posters are not replaced.
- Slots with extreme proportions (5:1 and wider) are skipped — only a strip of a person would be left.
- Chrome Web Store review does not accept extensions that replace other people's pictures on every site, so this is distributed as an unpacked build.
- The photos are generated images of one person; use them for personal fun, not to impersonate anybody.
