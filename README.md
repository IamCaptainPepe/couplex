# Couplex

A Chrome / Edge / Firefox extension that replaces the images on every web page
with photos of Alex Cooper.

The extension itself is tiny (~50 KB). The photo set lives on a CDN, so the
extension can grow to thousands of photos without getting any heavier.

## What it does

- Walks all `<img>` elements on the page (and any loaded later) and swaps a
  random share of them for a random photo of Alex.
- Three sliders: **page chance** (whether this page gets processed at all),
  **images to replace** (percentage of images), **minimum size**.
- Never shows the same photo twice on one page.
- Picks the crop that fits the slot: square, landscape or portrait.
- Places the photo by the head box, not by the centre, so faces are never cut.

## Install

### Chrome / Edge

1. Download this repository (Code → Download ZIP) and unpack it.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and pick the repository folder.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on** and pick `manifest.json`.

## How the photo set works

Photos are **not** shipped inside the extension. They are served from jsDelivr:

```
https://cdn.jsdelivr.net/gh/IamCaptainPepe/couplex@<commit>/images/
```

- `index.json` — the list of photos with face coordinates and dimensions.
- `*_sq.avif`, `*_l.avif`, `*_p.avif` — three crops of the same photo.

The `data` branch of this repository holds only `images/`. The `master` branch
holds only the extension code. At load time the extension asks the GitHub API
for the current commit of `data`, pins every URL to that commit (so CDN cache
can never serve a stale index) and falls back to the raw GitHub URL, then to the
`data` branch directly, if a file is not there yet.

## Adding photos

```bash
# 1. put new source images (png/jpg) into a folder, e.g. _src2/
# 2. build crops for the new files only
python3 tools/build_images.py _src2 --max 768 --quality 52 --format avif --speed 6 --incremental

# 3. publish the data branch
cd ../couplex-data        # worktree on branch `data`
git add -f images
git commit -m "data: new photos"
git push origin data
```

`build_images.py` finds the face with insightface (`buffalo_l`), crops the photo
three ways around the head box, encodes to AVIF and rewrites `images/index.json`.

## Files

| file | role |
| --- | --- |
| `manifest.json` | MV3 manifest, no background worker needed |
| `content.js` | page scanner, CDN loader, placement logic |
| `popup.html` / `popup.js` | settings UI |
| `tools/build_images.py` | photo set builder |
| `icons/` | extension icons |

## Privacy

The extension makes exactly two kinds of network requests: the photo index and
the photos themselves. Both go to jsDelivr and GitHub. No analytics, no
tracking, nothing is sent about the pages you visit.

## Limitations

- Canvas, CSS backgrounds and video are not touched — only `<img>` elements.
- Very wide or very tall slots (wider than 5:1) are skipped, the crops do not fit.
- Photos are fetched from the internet, so offline pages stay untouched.
- A face swap like this is for fun; do not use it to impersonate anyone.

## Done on CyOps

Every eligible image is replaced by default. The original stays hidden until the new photo has loaded, including images that lazy-load while you scroll. Photos are dealt by category, so one series does not follow itself, and the same picture is not repeated until the rest of the deck has been used. Iconic shots (i and k) come up a little more often. Press and magazine covers (a and v) come up about half as often. A Janitor Oil ad, from the j and w series, shows up about once every 22 photos. If the CDN photo fails to load, the original image is restored.
