// Couplex — replaces images on a page with photos of Alex Cooper.
// Every page first wins or loses a single roll, then a percentage of the
// images on a winning page get swapped.
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
let started = false;
let opts = { ...DEFAULTS };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// start the TLS handshake with the photo CDN before anything else happens
try {
  const pc = document.createElement('link');
  pc.rel = 'preconnect';
  pc.href = 'https://cdn.jsdelivr.net';
  pc.crossOrigin = '';
  (document.head || document.documentElement).appendChild(pc);
} catch (e) {
  /* document is empty this early, the first request will pay the handshake */
}

function prepare(img) {
  // <picture><source> overrides src, so drop the sources first
  const pic = img.closest('picture');
  if (pic) pic.querySelectorAll('source').forEach((s) => s.remove());
  img.removeAttribute('srcset');
  img.removeAttribute('sizes');
  img.loading = 'eager';
  img.decoding = 'async';
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

// photos live in the `data` branch of the repo: the list comes from
// raw.githubusercontent (updates within a minute of a push), the files
// themselves from jsDelivr pinned to the exact commit (immutable, cached)
const RAW_INDEX = 'https://raw.githubusercontent.com/IamCaptainPepe/couplex/data/images/index.json';
const BRANCH_API = 'https://api.github.com/repos/IamCaptainPepe/couplex/branches/data';
const CDN_REF = 'https://cdn.jsdelivr.net/gh/IamCaptainPepe/couplex@data/images/';
const SHA_TTL = 3600 * 1000;
let CDN = CDN_REF;

// current commit of the data branch, so jsDelivr never serves a stale ref
async function cdnRef() {
  try {
    const got = await new Promise((r) => chrome.storage.local.get({ couplexSha: null }, r));
    const hit = got.couplexSha;
    if (hit && hit.sha && Date.now() - hit.t < SHA_TTL) return hit.sha;
  } catch (e) {
    /* storage unavailable, ask the api */
  }
  try {
    const res = await fetch(BRANCH_API, { cache: 'no-store' });
    const sha = (await res.json()).commit.sha;
    if (sha) chrome.storage.local.set({ couplexSha: { t: Date.now(), sha } });
    return sha;
  } catch (e) {
    return '';
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

  // the element has no layout yet (hidden menu, lazy node): swapping now would
  // let the photo define the size and blow the page up. Try again later.
  if (!bw || !bh) return;

  const picked = choose(bw, bh);
  if (!picked) return;

  prepare(img);
  img.dataset.couplex = '1';
  img.src = CDN + picked.item.n;

  // a photo may be newer than the cached branch sha — fall back to the branch
  img.addEventListener('error', function retry() {
    if (img.dataset.couplexRetry) return;
    img.dataset.couplexRetry = '1';
    img.src = CDN_REF + picked.item.n;
  }, { once: true });
  img.style.objectFit = 'cover';
  img.style.objectPosition = picked.pos;

  // the box may resize once the new image is decoded — recompute then
  img.addEventListener('load', () => {
    if (!img.isConnected) return;
    const r = img.getBoundingClientRect();
    let nw = Math.round(r.width) || bw;
    let nh = Math.round(r.height) || bh;
    // small icons (avatars, favicons) have no CSS size of their own and would
    // blow up to the full natural size of the photo — pin them to the old box
    const small = Math.max(bw, bh) < 320;
    if (small || nw > bw * 1.25 || nh > bh * 1.25) {
      img.style.width = `${bw}px`;
      img.style.height = `${bh}px`;
      img.style.maxWidth = `${bw}px`;
      img.style.maxHeight = `${bh}px`;
      nw = bw;
      nh = bh;
    }
    const p = place(picked.item, nw, nh);
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
  if (started) return;
  started = true;

  // one roll per page
  pageAgreed = Math.random() * 100 < opts.pageChance;
  if (!pageAgreed) return;

  const all = collect();
  candidates = all.length;
  if (all.length) runBatch(all, opts.imagePercent / 100);

  // images that arrive later (lazy-load, infinite feeds, SPAs) and images whose
  // src is swapped in place (virtualised feeds like YouTube) — both count
  const pending = new Set();
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    const list = [...pending].filter(
      (img) => img.isConnected && img.dataset.couplex !== '1' && img.src
    );
    pending.clear();
    if (!list.length) return;
    candidates += list.length;
    for (const img of list) {
      const mark = img.currentSrc || img.src;
      if (img.dataset.couplexSkip === mark) continue; // already lost its roll
      if (Math.random() * 100 < opts.imagePercent) replace(img);
      else img.dataset.couplexSkip = mark;
    }
  };

  const queue = (img) => {
    if (!img || img.tagName !== 'IMG' || img.dataset.couplex === '1') return;
    pending.add(img);
    if (scheduled) return;
    scheduled = true;
    setTimeout(flush, 150);
  };

  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        queue(m.target);
        continue;
      }
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'IMG') queue(node);
        else if (node.querySelectorAll) node.querySelectorAll('img').forEach(queue);
      }
    }
  });
  mo.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset']
  });

  // safety net: some feeds reuse nodes and never fire a mutation we can see
  setInterval(() => {
    let n = 0;
    for (const img of document.images) {
      if (n >= 40) break;
      if (img.dataset.couplex === '1' || !img.src) continue;
      const mark = img.currentSrc || img.src;
      if (img.dataset.couplexSkip === mark) continue;
      const r = img.getBoundingClientRect();
      if (r.width < 16 || r.height < 16) continue; // offscreen or lazy placeholder
      queue(img);
      n += 1;
    }
  }, 2000);
}

const INDEX_TTL = 6 * 3600 * 1000;
const lget = (d) => new Promise((r) => chrome.storage.local.get(d, r));
const lset = (o) => new Promise((r) => chrome.storage.local.set(o, () => r()));

async function apiSha() {
  try {
    const res = await fetch(BRANCH_API, { cache: 'no-store' });
    const j = await res.json();
    return (j && j.commit && j.commit.sha) || '';
  } catch (e) {
    return '';
  }
}

async function fetchIndex(sha) {
  const sources = sha ? [CDN + 'index.json', RAW_INDEX] : [RAW_INDEX, CDN_REF + 'index.json'];
  for (const url of sources) {
    try {
      const res = await fetch(url, { cache: url === RAW_INDEX ? 'no-cache' : 'force-cache' });
      const data = await res.json();
      const list = Array.isArray(data) ? data.map((n) => ({ n, w: 0, h: 0, f: null, b: n })) : data.images;
      if (list && list.length) return list;
    } catch (e) {
      /* next source */
    }
  }
  return null;
}

function applyIndex(list) {
  IMAGES = list;
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
}

// the first screenful of a feed should not wait for the network at all
function warmCache(n) {
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 900));
  idle(() => {
    if (!BASES.length) return;
    const pool = BASES.slice();
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    for (const b of pool.slice(0, n)) {
      const it = variantFor(b, 1.5) || (VARIANTS.get(b) || [])[0];
      if (!it) continue;
      const im = new Image();
      im.decoding = 'async';
      im.src = CDN + it.n;
    }
  });
}

// everything network-related happens after the first frame
async function refresh() {
  const got = await lget({ couplexSha: null, couplexIndex: null });
  let sha = (got.couplexSha && got.couplexSha.sha) || '';
  if (!sha || Date.now() - (got.couplexSha.t || 0) > SHA_TTL) {
    const fresh = await apiSha();
    if (fresh) {
      sha = fresh;
      lset({ couplexSha: { t: Date.now(), sha } });
    }
  }
  if (sha) CDN = `https://cdn.jsdelivr.net/gh/IamCaptainPepe/couplex@${sha}/images/`;

  const stale = !got.couplexIndex || Date.now() - got.couplexIndex.t > INDEX_TTL;
  if (!stale) return;
  const list = await fetchIndex(sha);
  if (!list) return;
  applyIndex(list);
  lset({ couplexIndex: { t: Date.now(), list } });
}

async function load() {
  const stored = await chrome.storage.sync.get({ [KEY]: DEFAULTS });
  opts = { ...DEFAULTS, ...stored[KEY] };
  if (!opts.enabled) return;

  // instant path: whatever was cached from the previous page
  const got = await lget({ couplexIndex: null });
  if (got.couplexIndex && got.couplexIndex.list && got.couplexIndex.list.length) {
    applyIndex(got.couplexIndex.list);
    start();
    warmCache(24);
  }

  // slow path: refresh the commit sha and the index in the background
  refresh().then(() => {
    if (!BASES.length) return;
    start();
    if (!got.couplexIndex) warmCache(24);
  });
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
