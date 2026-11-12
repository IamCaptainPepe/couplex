#!/usr/bin/env python3
"""Build the extension's images/ folder: PNG/JPG -> AVIF (or WebP) + index.json.

Usage:
    python3 tools/build_images.py <source_folder> [--max 768] [--quality 52]
                                  [--format avif|webp] [--speed 6] [--incremental]

Each photo is face-detected (insightface buffalo_l) and cut from the original
into three aspect ratios — square, 3:2 landscape and 2:3 portrait — with the
head kept in frame. index.json stores the face box as fractions of the frame.
content.js picks the crop that matches the slot, so the head is not cut off.

--incremental appends only new sources to the existing index.json
(old files are not re-encoded), so photos can be added as they are generated.

Run it with an interpreter that has insightface (ComfyUI venv):
    /home/openclaw/ComfyUI/venv/bin/python tools/build_images.py _src2
"""
import argparse
import json
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "images")
EXTS = (".png", ".jpg", ".jpeg", ".webp")
INSIGHT_ROOT = os.environ.get("INSIGHT_ROOT", "/home/openclaw/ComfyUI/models/insightface")

# suffix -> frame aspect ratio
ASPECTS = (("sq", 1.0), ("l", 1.5), ("p", 2 / 3))

_app = None


def detector():
    global _app
    if _app is None:
        from insightface.app import FaceAnalysis

        _app = FaceAnalysis(name="buffalo_l", root=INSIGHT_ROOT, providers=["CPUExecutionProvider"])
        _app.prepare(ctx_id=-1, det_size=(640, 640))
    return _app


def face_box(im):
    """Largest face box as fractions of the frame [x, y, w, h], or None."""
    import numpy as np

    bgr = np.array(im.convert("RGB"))[:, :, ::-1]
    faces = detector().get(bgr)
    if not faces:
        return None
    f = max(faces, key=lambda x: (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]))
    x1, y1, x2, y2 = [float(v) for v in f.bbox]
    W, H = im.size
    return [x1 / W, y1 / H, (x2 - x1) / W, (y2 - y1) / H]


def clamp(v, lo, hi):
    return min(hi, max(lo, v))


def crop_variant(im, box, aspect, maxside):
    """Crop the frame to the target aspect, keeping the head centered."""
    W, H = im.size
    if aspect >= 1:
        w = min(W, H * aspect)
        h = w / aspect
    else:
        h = min(H, W / aspect)
        w = h * aspect
    w, h = int(w), int(h)

    if box:
        cx = (box[0] + box[2] / 2) * W
        cy = (box[1] + box[3] / 2) * H
    else:
        cx, cy = W / 2, H / 2

    x0 = int(clamp(cx - w / 2, 0, max(0, W - w)))
    y0 = int(clamp(cy - h / 2, 0, max(0, H - h)))
    crop = im.crop((x0, y0, x0 + w, y0 + h))

    nb = None
    if box:
        nb = [
            round(clamp((box[0] * W - x0) / w, 0, 1), 4),
            round(clamp((box[1] * H - y0) / h, 0, 1), 4),
            round(clamp(box[2] * W / w, 0, 1), 4),
            round(clamp(box[3] * H / h, 0, 1), 4),
        ]

    crop.thumbnail((maxside, maxside), Image.LANCZOS)
    return crop, nb


def encode(im, path, fmt, quality, speed):
    if fmt == "avif":
        im.save(path, "AVIF", quality=quality, speed=speed)
    else:
        im.save(path, "WEBP", quality=quality, method=6)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("--max", type=int, default=768)
    ap.add_argument("--quality", type=int, default=52)
    ap.add_argument("--format", choices=("avif", "webp"), default="avif")
    ap.add_argument("--speed", type=int, default=6, help="AVIF speed: 0 slow/better, 10 fast/worse")
    ap.add_argument("--incremental", action="store_true", help="encode only new source files")
    a = ap.parse_args()

    src = os.path.expanduser(a.src)
    if not os.path.isdir(src):
        sys.exit(f"no such folder: {src}")

    os.makedirs(OUT, exist_ok=True)
    ext = "." + a.format
    files = sorted(f for f in os.listdir(src) if f.lower().endswith(EXTS) and not f.startswith("."))

    items, seen = [], set()
    index_path = os.path.join(OUT, "index.json")
    if a.incremental and os.path.exists(index_path):
        with open(index_path) as fh:
            old = json.load(fh)
        items = old.get("images", [])
        seen = {it["b"] for it in items}
        print(f"[inc] set already has {len(seen)} photos")

    total = 0
    no_face = 0
    added = 0
    for i, f in enumerate(files, 1):
        base = os.path.splitext(f)[0].replace("_00001_", "")
        if base in seen:
            continue
        try:
            with Image.open(os.path.join(src, f)) as im:
                im = im.convert("RGB")
                im.thumbnail((max(1536, a.max), max(1536, a.max)), Image.LANCZOS)
                box = face_box(im)
                if box is None:
                    no_face += 1
                for suf, aspect in ASPECTS:
                    crop, nb = crop_variant(im, box, aspect, a.max)
                    name = f"{base}_{suf}{ext}"
                    path = os.path.join(OUT, name)
                    encode(crop, path, a.format, a.quality, a.speed)
                    total += os.path.getsize(path)
                    items.append({"n": name, "w": crop.width, "h": crop.height, "f": nb, "b": base})
                added += 1
                seen.add(base)
        except Exception as e:
            print(f"[skip] {f}: {e}")
        if added and added % 25 == 0:
            print(f"  +{added} (scanned {i}/{len(files)})", flush=True)

    index = {"version": 4, "format": a.format, "max": a.max, "images": items}
    with open(index_path, "w") as fh:
        json.dump(index, fh, separators=(",", ":"))

    size = sum(os.path.getsize(os.path.join(OUT, it["n"])) for it in items)
    per_photo = size / max(len(seen), 1)
    print(
        f"done: {len(seen)} photos, {len(items)} files, {size / 1e6:.1f} MB, "
        f"mean file {per_photo / 3 / 1024:.0f} KB, mean photo {per_photo / 1024:.0f} KB, "
        f"new {added}, no face {no_face}"
    )


if __name__ == "__main__":
    main()
