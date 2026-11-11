// Couplex — replaces images on a page with photos of Alex Cooper.
// Same idea as nCage: the page first wins or loses a single roll, then a
// percentage of the images on a winning page get swapped.
//
// Faces are never cut off: index.json stores a face box per photo and
// object-position is computed so the whole face fits the visible window.

const DEFAULTS = {
  enabled: true,
  pageChance: 40,   // odds that this page gets any replacement at all, %
  imagePercent: 35, // share of images on a winning page to replace, %
  minSize: 64       // smaller images are left alone, px
};

const KEY = 'couplexOptions';

let IMAGES = [];
let BASES = [];
const VARIANTS = new Map();
const USED = new Set();
let replaced = 0;
let candidates = 0;
let pageAgreed = false;
let opts = { ...DEFAULTS };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function prepare(img) {
  // <picture><source> overrides src, so drop the sources first
  const pic = img.closest('picture');
  if (pic) pic.querySelectorAll('source').forEach((s) => s.remove());
  img.removeAttribute('srcset');
  img.removeAttribute('sizes');
  img.loading = 'eager';
  img.decoding = 'sync';
}

// Where to place the photo inside the element box so the head survives.
// Returns { pos: 'X% Y%', fit: boolean }.
function place(item, bw, bh) {
  const iw = item.w || 1;
  const ih = item.h || 1;
  if (!bw || !bh) return { pos: '50% 50%', fit: true };

  const scale = Math.max(bw / iw, bh / ih); // object-fit: cover
  const vw = bw / scale;                    // visible part of the photo, px
  const vh = bh / scale;

  const f = item.f;
  if (!f) return { pos: '50% 50%', fit: true };

  const fx = f[0] * iw;
  const fy = f[1] * ih;
  const fw = f[2] * iw;
  const fh = f[3] * ih;

  // the detector box covers the face only — grow it up and sideways so the
  // hair and the top of the head stay in frame
  const hw = Math.min(iw, fw * 1.7);
  const hh = Math.min(ih, fh * 2.2);
  const hx = clamp(fx + fw / 2 - hw / 2, 0, Math.max(0, iw - hw));
  const hy = clamp(fy - fh * 0.7, 0, Math.max(0, ih - hh));

  // the window is already smaller than the head — no crop can save it
  const fit = hw <= vw && hh <= vh;

  const x0 = iw > vw ? clamp(hx + hw / 2 - vw / 2, 0, iw - vw) : 0;
  const y0 = ih > vh ? clamp(hy + hh / 2 - vh / 2, 0, ih - vh) : 0;
  const px = iw > vw ? (x0 / (iw - vw)) * 100 : 50;
  const py = ih > vh ? (y0 / (ih - vh)) * 100 : 50;

  return { pos: `${px.toFixed(2)}% ${py.toFixed(2)}%`, fit };
}

// Pick a photo that fits the element's aspect ratio; for every photo there are
// square, landscape and portrait crops, so the head always has room.
function choose(bw, bh) {
  if (!BASES.length) return null;
  const ar = bw && bh ? bw / bh : 1;
  // skip extreme banners (5:1 and worse) — only a strip of a person would remain
  if (ar > 5 || ar < 1 / 5) return null;

  // never show the same photo twice on one page
  const free = BASES.filter((b) => !USED.has(b));
  const pool = free.length ? free : BASES;

  const start = Math.floor(Math.random() * pool.length);
  let fallback = null;
  for (let k = 0; k < Math.min(6, pool.length); k += 1) {
    const base = pool[(start + k) % pool.length];
    const item = variantFor(base, ar);
    if (!item) continue;
    const p = place(item, bw, bh);
    if (p.fit) {
      USED.add(base);
      return { item, pos: p.pos };
    }
    if (!fallback) fallback = { item, pos: p.pos };
  }
  if (fallback) USED.add(fallback.item.b || fallback.item.n);
  return fallback;
}

// photos live in the `data` branch of the repo and are served by jsDelivr,
// so the extension itself stays tiny
const CDN = 'https://cdn.jsdelivr.net/gh/IamCaptainPepe/couplex@data/images/';
const LIST_API = 'https://data.jsdelivr.com/v1/package/gh/IamCaptainPepe/couplex@data/flat?structure=flat';
const LIST_TTL = 6 * 3600 * 1000;

// files in the data branch that index.json does not know about yet
async function cdnFiles() {
  try {
    const got = await new Promise((r) => chrome.storage.local.get({ couplexFiles: null }, r));
    const hit = got.couplexFiles;
    if (hit && Date.now() - hit.t < LIST_TTL) return hit.files || [];
  } catch (e) {
    /* storage may be unavailable, fall through to the network */
  }
  try {
    const res = await fetch(LIST_API, { cache: 'no-cache' });
    const data = await res.json();
    const files = (data.files || [])
      .map((f) => (f.name || '').replace(/^\/?images\//, ''))
      .filter((n) => /\.(avif|webp|png|jpe?g)$/i.test(n));
    chrome.storage.local.set({ couplexFiles: { t: Date.now(), files } });
    return files;
  } catch (e) {
    return [];
  }
}

// name, crop suffix gives the shape
function mergeScanned(files) {
  const known = new Set(IMAGES.map((it) => it.n));
  const shapes = { sq: 1, l: 1.5, p: 2 / 3 };
  let added = 0;
  for (const name of files || []) {
    if (known.has(name)) continue;
    const m = /^(.+)_(sq|l|p)\.(webp|avif|png|jpe?g)$/i.exec(name);
    if (!m) continue;
    const shape = shapes[m[2].toLowerCase()];
    IMAGES.push({ n: name, w: Math.round(1000 * shape), h: 1000, f: null, b: m[1] });
    added += 1;
  }
  return added;
}

// among the crops of one photo take the one closest to the element's shape
function variantFor(base, ar) {  const list = VARIANTS.get(base);
  if (!list || !list.length) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const it of list) {
    const d = Math.abs(Math.log((it.w || 1) / (it.h || 1) / ar));
    if (d < bestDiff) {
      bestDiff = d;
      best = it;
    }
  }
  return best;
}

function replace(img) {
  if (!IMAGES.length || img.dataset.couplex === '1') return;
  const rect = img.getBoundingClientRect();
  const bw = Math.round(rect.width) || img.clientWidth || 0;
  const bh = Math.round(rect.height) || img.clientHeight || 0;

  const picked = choose(bw, bh);
  if (!picked) return;

  prepare(img);
  img.dataset.couplex = '1';
  img.src = CDN + picked.item.n;
  img.style.objectFit = 'cover';
  img.style.objectPosition = picked.pos;

  // the box may resize once the new image is decoded — recompute then
  img.addEventListener('load', () => {
    const r = img.getBoundingClientRect();
    const p = place(picked.item, Math.round(r.width) || bw, Math.round(r.height) || bh);
    img.style.objectPosition = p.pos;
  }, { once: true });

  replaced += 1;
}

function bigEnough(img) {
  const w = img.naturalWidth || img.width || 0;
  const h = img.naturalHeight || img.height || 0;
  return Math.min(w, h) >= opts.minSize;
}

function collect() {
  return Array.from(document.images).filter(
    (img) => img.dataset.couplex !== '1' && bigEnough(img) && img.src
  );
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function runBatch(list, fraction) {
  const n = fraction >= 1 ? list.length : Math.floor(list.length * fraction);
  shuffle(list).slice(0, n).forEach(replace);
}

function start() {
  // one roll per page
  pageAgreed = Math.random() * 100 < opts.pageChance;
  if (!pageAgreed) return;

  const all = collect();
  candidates = all.length;
  if (!all.length) return;

  runBatch(all, opts.imagePercent / 100);

  // catch images that arrive later (lazy-load, infinite feeds, SPAs)
  const mo = new MutationObserver((muts) => {
    const fresh = [];
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'IMG') fresh.push(node);
        else if (node.querySelectorAll) fresh.push(...node.querySelectorAll('img'));
      }
    }
    if (!fresh.length) return;
    // new images get the same share, each one rolled separately
    for (const img of fresh) {
      if (Math.random() * 100 < opts.imagePercent) replace(img);
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
}

async function load() {
  const stored = await chrome.storage.sync.get({ [KEY]: DEFAULTS });
  opts = { ...DEFAULTS, ...stored[KEY] };
  if (!opts.enabled) return;

  try {
    const res = await fetch(CDN + 'index.json', { cache: 'force-cache' });
    const data = await res.json();
    IMAGES = Array.isArray(data) ? data.map((n) => ({ n, w: 0, h: 0, f: null, b: n })) : data.images;
  } catch (e) {
    IMAGES = [];
  }
  if (!IMAGES || !IMAGES.length) return;

  // photos added to the data branch after index.json was built
  try {
    const extra = await cdnFiles();
    mergeScanned(extra);
  } catch (e) {
    /* the worker may be asleep or blocked, the generated set still works */
  }

  VARIANTS.clear();
  BASES = [];
  for (const it of IMAGES) {
    const b = it.b || it.n;
    if (!VARIANTS.has(b)) {
      VARIANTS.set(b, []);
      BASES.push(b);
    }
    VARIANTS.get(b).push(it);
  }

  start();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'couplex:stats') {
    sendResponse({
      ok: true,
      replaced,
      candidates,
      pageAgreed,
      images: BASES.length,
      options: opts
    });
  }
  return true;
});

// popup changed the settings — reloading the page applies them
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[KEY]) {
    opts = { ...DEFAULTS, ...changes[KEY].newValue };
  }
});

load();
