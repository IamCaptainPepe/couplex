// Couplex — replaces images on a page with photos of Alex Cooper.
// The fast path uses the commit and index already in storage. GitHub is
// asked only after the first swaps, so a page is not blocked on the network.
// Faces stay in frame: index.json stores a face box and object-position is
// computed so the whole head fits the visible window.

const DEFAULTS = {
  enabled: true,
  pageChance: 100,  // odds that this page gets any replacement at all, %
  imagePercent: 100, // share of images on a winning page to replace, %
  minSize: 64,      // smaller images are left alone, px
  v: 3
};

const KEY = 'couplexOptions';

let IMAGES = [];
let BASES = [];
const VARIANTS = new Map();
const USED = new Set();
const SAVED = new WeakMap();
const SWAP = new WeakMap();
const SIZE_WAIT = new WeakMap();
const LAZY_ATTRS = [
  'data-src', 'data-srcset', 'data-lazy-src', 'data-lazy',
  'data-original', 'data-original-src', 'data-image', 'data-img-url', 'data-hi-res-src'
];

let deck = [];
let deckPos = 0;
let lastPicked = '';
let veilEl = null;

let replaced = 0;
let candidates = 0;
let pageAgreed = false;
let started = false;
let opts = { ...DEFAULTS };

const RAW_INDEX = 'https://raw.githubusercontent.com/IamCaptainPepe/couplex/data/images/index.json';
const BRANCH_API = 'https://api.github.com/repos/IamCaptainPepe/couplex/branches/data';
const CDN_REF = 'https://cdn.jsdelivr.net/gh/IamCaptainPepe/couplex@data/images/';
const SHA_TTL = 3600 * 1000;
const INDEX_TTL = 6 * 3600 * 1000;
let CDN = CDN_REF;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lget = (d) => new Promise((r) => chrome.storage.local.get(d, r));
const lset = (o) => new Promise((r) => chrome.storage.local.set(o, () => r()));

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

// Hide every img until our photo has decoded, or until we decide to leave it.
// Injected at document_start so the original never paints on a slow swap.
function showVeil() {
  if (veilEl) return;
  veilEl = document.createElement('style');
  veilEl.textContent = 'img:not([data-couplex-ready="1"]):not([data-couplex-skip]){visibility:hidden !important}';
  (document.head || document.documentElement).appendChild(veilEl);
}
function hideVeil() {
  if (!veilEl) return;
  veilEl.remove();
  veilEl = null;
}
try { showVeil(); } catch (e) { /* parsing has not created the document element yet */ }

function pinned(sha) {
  return `https://cdn.jsdelivr.net/gh/IamCaptainPepe/couplex@${sha}/images/`;
}

function isOurUrl(url) {
  return typeof url === 'string' && url.indexOf('cdn.jsdelivr.net/gh/IamCaptainPepe/couplex@') !== -1;
}

function isDataOrBlob(url) {
  const s = (url || '').trim().toLowerCase();
  return s.startsWith('data:') || s.startsWith('blob:');
}

function markOf(img) {
  return img.getAttribute('src') || img.getAttribute('srcset') || '';
}

// data/blob URLs are huge; the skip flag must not copy them onto the element
function stableMark(img) {
  const mark = markOf(img);
  if (isDataOrBlob(mark)) return 'embedded';
  return mark;
}

function hasLazy(img) {
  return LAZY_ATTRS.some((name) => img.hasAttribute(name));
}

function hasAddress(img) {
  return !!(img.getAttribute('src') || img.getAttribute('srcset') || hasLazy(img));
}

function normalize(raw) {
  const o = { ...DEFAULTS, ...(raw || {}) };
  const fresh = !raw || raw.v !== 3;
  if (fresh && (!raw || (Number(raw.pageChance) === 40 && Number(raw.imagePercent) === 35))) {
    o.pageChance = 100;
    o.imagePercent = 100;
  }
  if (fresh) o.v = 3;
  return { opts: o, migrated: fresh };
}

function slotOf(img) {
  const live = boxOf(img);
  if (live.bw && live.bh) return { bw: live.bw, bh: live.bh, guessed: false };
  const w = Number(img.getAttribute('width')) || 0;
  const h = Number(img.getAttribute('height')) || 0;
  if (w && h) return { bw: w, bh: h, guessed: true };
  return { bw: 0, bh: 0, guessed: true };
}

function isHot(img) {
  const r = img.getBoundingClientRect();
  const vh = window.innerHeight || 800;
  if (r.width < 1 && r.height < 1) return true;
  return r.bottom > -vh * 0.4 && r.top < vh * 2.5;
}

function boxOf(img) {
  const r = img.getBoundingClientRect();
  return {
    bw: Math.round(r.width) || img.clientWidth || 0,
    bh: Math.round(r.height) || img.clientHeight || 0
  };
}

function extreme(bw, bh) {
  if (!bw || !bh) return false;
  const ar = bw / bh;
  return ar > 5 || ar < 0.2;
}

function tooSmall(bw, bh) {
  return Math.min(bw, bh) < opts.minSize;
}

function inViewport(img) {
  const r = img.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const m = 200;
  return r.bottom > -m && r.right > -m && r.top < window.innerHeight + m && r.left < window.innerWidth + m;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function markSkip(img) {
  img.dataset.couplexSkip = stableMark(img) || '1';
}

function styleSnapshot(img) {
  return {
    objectFit: img.style.objectFit,
    objectPosition: img.style.objectPosition,
    width: img.style.width,
    height: img.style.height,
    maxWidth: img.style.maxWidth,
    maxHeight: img.style.maxHeight
  };
}

function applyStyle(img, saved) {
  if (!saved) return;
  img.style.objectFit = saved.objectFit;
  img.style.objectPosition = saved.objectPosition;
  img.style.width = saved.width;
  img.style.height = saved.height;
  img.style.maxWidth = saved.maxWidth;
  img.style.maxHeight = saved.maxHeight;
}

function setAttr(el, name, value) {
  if (value == null) el.removeAttribute(name);
  else el.setAttribute(name, value);
}

// Keep the original sources until the CDN file has actually loaded.
function remember(img) {
  if (SAVED.has(img)) return;
  const pic = img.closest('picture');
  const sources = [];
  if (pic) pic.querySelectorAll('source').forEach((s) => sources.push(s.cloneNode(true)));
  SAVED.set(img, {
    src: img.getAttribute('src'),
    srcset: img.getAttribute('srcset'),
    sizes: img.getAttribute('sizes'),
    loading: img.getAttribute('loading'),
    sources,
    style: styleSnapshot(img),
    lazy: LAZY_ATTRS.filter((name) => img.hasAttribute(name)).map((name) => [name, img.getAttribute(name)])
  });
}

function stripSources(img) {
  const pic = img.closest('picture');
  if (pic) pic.querySelectorAll('source').forEach((s) => s.remove());
  img.removeAttribute('srcset');
  img.removeAttribute('sizes');
  for (const name of LAZY_ATTRS) img.removeAttribute(name);
  img.decoding = 'async';
}

function noteRemoved() {
  if (replaced > 0) replaced -= 1;
}

function restore(img, base) {
  const saved = SAVED.get(img);
  const mark = saved ? (saved.src || saved.srcset || 'failed') : (markOf(img) || 'failed');
  const state = SWAP.get(img);
  if (state) state.abort.abort();
  SWAP.delete(img);
  delete img.dataset.couplex;
  delete img.dataset.couplexRetry;
  delete img.dataset.couplexUrl;
  delete img.dataset.couplexName;
  delete img.dataset.couplexRoll;
  delete img.dataset.couplexWon;
  delete img.dataset.couplexReady;
  delete img.dataset.couplexFights;
  img.dataset.couplexSkip = isDataOrBlob(mark) ? 'embedded' : mark;
  applyStyle(img, saved && saved.style);
  if (base) USED.delete(base);
  noteRemoved();
  if (!saved) return;
  const pic = img.closest('picture');
  if (pic && saved.sources.length) {
    pic.querySelectorAll('source').forEach((s) => s.remove());
    saved.sources.forEach((s) => pic.insertBefore(s, img));
  }
  setAttr(img, 'src', saved.src);
  setAttr(img, 'srcset', saved.srcset);
  setAttr(img, 'sizes', saved.sizes);
  setAttr(img, 'loading', saved.loading);
  for (const pair of saved.lazy || []) setAttr(img, pair[0], pair[1]);
}

function releaseForReroll(img) {
  const state = SWAP.get(img);
  if (state) state.abort.abort();
  SWAP.delete(img);
  if (state && state.base) USED.delete(state.base);
  delete img.dataset.couplex;
  delete img.dataset.couplexRetry;
  delete img.dataset.couplexUrl;
  delete img.dataset.couplexName;
  delete img.dataset.couplexSkip;
  delete img.dataset.couplexRoll;
  delete img.dataset.couplexWon;
  delete img.dataset.couplexReady;
  delete img.dataset.couplexFights;
  applyStyle(img, SAVED.get(img) && SAVED.get(img).style);
  noteRemoved();
}

// Where to place the photo inside the element box so the head survives.
// Returns { pos: 'X% Y%', fit: boolean }.
function place(item, bw, bh) {
  const iw = item.w || 1;
  const ih = item.h || 1;
  if (!bw || !bh) return { pos: '50% 50%', fit: true };

  const scale = Math.max(bw / iw, bh / ih); // object-fit: cover
  const vw = bw / scale;
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

  const fit = hw <= vw && hh <= vh;
  const x0 = iw > vw ? clamp(hx + hw / 2 - vw / 2, 0, iw - vw) : 0;
  const y0 = ih > vh ? clamp(hy + hh / 2 - vh / 2, 0, ih - vh) : 0;
  const px = iw > vw ? (x0 / (iw - vw)) * 100 : 50;
  const py = ih > vh ? (y0 / (ih - vh)) * 100 : 50;

  return { pos: `${px.toFixed(2)}% ${py.toFixed(2)}%`, fit };
}

function variantFor(base, ar) {
  const list = VARIANTS.get(base);
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

function categoryOf(base) {
  const m = /^([A-Za-z]+)/.exec(base || '');
  return m ? m[1].toLowerCase() : '?';
}

// j and w are Janitor Oil ads. One of them per 14 other photos, never a run.
const OIL_CATS = new Set(['j', 'w']);
const OIL_EVERY = 14;

// Categories take turns, so one generation series does not follow itself.
// The same photo still waits until the rest of the deck has been used.
function refillDeck() {
  const groups = new Map();
  for (const base of BASES) {
    const cat = categoryOf(base);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(base);
  }
  for (const list of groups.values()) shuffle(list);

  const oil = [];
  for (const cat of OIL_CATS) {
    if (!groups.has(cat)) continue;
    oil.push(...groups.get(cat));
    groups.delete(cat);
  }
  shuffle(oil);
  const keys = shuffle([...groups.keys()]);
  const out = [];
  let sinceOil = 0;
  if (!keys.length) {
    deck = oil;
    deckPos = 0;
    return;
  }
  while (keys.some((key) => groups.get(key).length)) {
    for (const key of keys) {
      const list = groups.get(key);
      if (!list.length) continue;
      out.push(list.pop());
      sinceOil += 1;
      if (oil.length && sinceOil >= OIL_EVERY) {
        out.push(oil.pop());
        sinceOil = 0;
      }
    }
  }
  deck = out;
  deckPos = 0;
  const prev = categoryOf(lastPicked);
  if (lastPicked && deck.length > 1 && (deck[0] === lastPicked || categoryOf(deck[0]) === prev)) {
    const swapAt = deck.findIndex((b, i) => i > 0 && b !== lastPicked && categoryOf(b) !== prev);
    if (swapAt > 0) {
      const first = deck[0];
      deck[0] = deck[swapAt];
      deck[swapAt] = first;
    }
  }
}

function nextBase() {
  if (!BASES.length) return null;
  if (deckPos >= deck.length) refillDeck();
  const base = deck[deckPos];
  deckPos += 1;
  lastPicked = base;
  return base;
}

function choose(bw, bh) {
  if (!BASES.length) return null;
  if (bw && bh && extreme(bw, bh)) return null;
  const ar = bw && bh ? bw / bh : 1.5;
  const base = nextBase();
  if (!base) return null;
  const item = variantFor(base, ar);
  if (!item) return null;
  const p = place(item, bw || item.w, bh || item.h);
  USED.add(base);
  return { item, pos: p.pos };
}

function fail(img) {
  if (img.dataset.couplex !== '1') return;
  const name = img.dataset.couplexName;
  if (!img.dataset.couplexRetry && name) {
    const fallback = CDN_REF + name;
    if (fallback !== img.src) {
      img.dataset.couplexRetry = '1';
      img.dataset.couplexUrl = fallback;
      img.src = fallback;
      return;
    }
  }
  const state = SWAP.get(img);
  restore(img, state && state.base);
}

function landed(img, item, bw, bh) {
  if (!img.isConnected || img.dataset.couplex !== '1') return;
  const r = img.getBoundingClientRect();
  let nw = Math.round(r.width) || bw;
  let nh = Math.round(r.height) || bh;
  // small slots have no CSS size of their own and would jump to the photo's
  // natural size — pin them to the box we measured before the swap
  // Only pin genuinely small slots. Locking a hero to an early box and then
  // stretching that box is what makes the 768px photo look soft.
  const small = bw && bh && Math.max(bw, bh) < 320;
  if (small) {
    img.style.width = `${bw}px`;
    img.style.height = `${bh}px`;
    img.style.maxWidth = `${bw}px`;
    img.style.maxHeight = `${bh}px`;
    nw = bw;
    nh = bh;
  }
  img.style.objectPosition = place(item, nw || item.w, nh || item.h).pos;
  img.dataset.couplexReady = '1';
}

function armIconCheck(img) {
  if (SIZE_WAIT.has(img) || hasLazy(img)) return;
  let ro = null;
  const stop = () => {
    SIZE_WAIT.delete(img);
    if (ro) ro.disconnect();
  };
  const kick = () => {
    if (!img.isConnected || img.dataset.couplex !== '1') {
      stop();
      return;
    }
    const { bw, bh } = boxOf(img);
    if (!bw || !bh) return;
    stop();
    if (tooSmall(bw, bh) || extreme(bw, bh)) {
      const state = SWAP.get(img);
      restore(img, state && state.base);
    }
  };
  if (window.ResizeObserver) {
    ro = new ResizeObserver(kick);
    ro.observe(img);
  }
  setTimeout(kick, 400);
  SIZE_WAIT.set(img, stop);
}

function swap(img) {
  if (!opts.enabled || !pageAgreed || !img.isConnected || img.dataset.couplex === '1') return;
  if (!IMAGES.length) return;
  const slot = slotOf(img);
  if (slot.bw && slot.bh && extreme(slot.bw, slot.bh)) {
    markSkip(img);
    return;
  }
  if (slot.bw && slot.bh && tooSmall(slot.bw, slot.bh) && !hasLazy(img)) {
    markSkip(img);
    return;
  }
  const picked = choose(slot.bw, slot.bh);
  if (!picked) {
    markSkip(img);
    return;
  }
  const hot = isHot(img);
  const { bw, bh } = slot;

  remember(img);
  stripSources(img);
  const name = picked.item.n;
  const url = CDN + name;
  const prev = SWAP.get(img);
  if (prev) prev.abort.abort();
  const ac = new AbortController();
  const base = picked.item.b || picked.item.n;
  SWAP.set(img, { abort: ac, base });

  img.dataset.couplex = '1';
  img.dataset.couplexName = name;
  img.dataset.couplexUrl = url;
  delete img.dataset.couplexReady;
  img.decoding = 'async';
  img.loading = 'eager';
  img.referrerPolicy = 'no-referrer';
  if ('fetchPriority' in img) img.fetchPriority = hot ? 'high' : 'low';
  img.style.objectFit = 'cover';
  img.style.objectPosition = picked.pos;
  img.addEventListener('error', () => fail(img), { signal: ac.signal });
  img.addEventListener('load', () => landed(img, picked.item, bw, bh), { signal: ac.signal });
  if (!slot.bw || slot.guessed) armIconCheck(img);
  replaced += 1;
  img.src = url;
}

function consider(img) {
  if (!opts.enabled || !pageAgreed || !img.isConnected || img.dataset.couplex === '1') return;
  if (!hasAddress(img)) return;
  const attrSrc = (img.getAttribute('src') || '').trim();
  const cur = img.currentSrc || img.src || '';
  if ((isDataOrBlob(attrSrc) || isDataOrBlob(cur)) && !hasLazy(img) && !img.getAttribute('srcset')) {
    markSkip(img);
    return;
  }
  if (isOurUrl(cur)) return;
  const mark = stableMark(img) || '1';
  if (img.dataset.couplexSkip === mark) return;

  const slot = slotOf(img);
  if (slot.bw && slot.bh && extreme(slot.bw, slot.bh)) {
    markSkip(img);
    return;
  }
  if (slot.bw && slot.bh && tooSmall(slot.bw, slot.bh) && !hasLazy(img)) {
    markSkip(img);
    return;
  }

  if (img.dataset.couplexRoll !== mark) {
    img.dataset.couplexRoll = mark;
    img.dataset.couplexWon = Math.random() * 100 < opts.imagePercent ? '1' : '0';
    candidates += 1;
  }
  if (img.dataset.couplexWon !== '1') {
    markSkip(img);
    return;
  }
  swap(img);
}

const pending = new Set();
let scheduled = false;
function queue(img) {
  if (!img || img.tagName !== 'IMG') return;
  pending.add(img);
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(flush);
}
function flush() {
  scheduled = false;
  const list = [...pending];
  pending.clear();
  list.sort((a, b) => Number(isHot(b)) - Number(isHot(a)));
  for (const img of list) consider(img);
}

function holdOurs(img) {
  const keep = img.dataset.couplexUrl;
  if (!keep) return false;
  const n = Number(img.dataset.couplexFights || '0') + 1;
  if (n > 6) return false;
  img.dataset.couplexFights = String(n);
  img.src = keep;
  return true;
}

function onAttr(img) {
  if (!img || img.tagName !== 'IMG') return;
  const src = img.currentSrc || img.src || '';
  if (img.dataset.couplex === '1') {
    if (isOurUrl(src)) return;
    // lazyload and virtualized feeds rewrite src after we do; keep ours so
    // the original does not flash in while the next photo downloads
    if (holdOurs(img)) return;
    releaseForReroll(img);
    queue(img);
    return;
  }
  if ((isDataOrBlob((img.getAttribute('src') || '').trim()) || isDataOrBlob(src)) && !hasLazy(img)) {
    markSkip(img);
    return;
  }
  const mark = stableMark(img) || '1';
  if (img.dataset.couplexSkip === mark) return;
  if (img.dataset.couplexSkip) {
    delete img.dataset.couplexSkip;
    delete img.dataset.couplexRoll;
    delete img.dataset.couplexWon;
    delete img.dataset.couplexWaited;
  }
  queue(img);
}

function installObserver() {
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        onAttr(m.target);
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
    attributeFilter: ['src', 'srcset'].concat(LAZY_ATTRS)
  });
}

function start() {
  if (started) return;
  started = true;
  installObserver();

  const soon = [];
  const rest = [];
  for (const img of document.images) {
    if (!hasAddress(img)) continue;
    const attrSrc = (img.getAttribute('src') || '').trim();
    const cur = img.currentSrc || img.src || '';
    if (isOurUrl(cur)) continue;
    if ((isDataOrBlob(attrSrc) || isDataOrBlob(cur)) && !hasLazy(img) && !img.getAttribute('srcset')) {
      markSkip(img);
      continue;
    }
    const slot = slotOf(img);
    if (slot.bw && slot.bh && (extreme(slot.bw, slot.bh) || (tooSmall(slot.bw, slot.bh) && !hasLazy(img)))) {
      markSkip(img);
      continue;
    }
    (isHot(img) ? soon : rest).push(img);
  }

  const ordered = soon.concat(rest);
  const fraction = opts.imagePercent / 100;
  const n = fraction >= 1 ? ordered.length : Math.floor(ordered.length * fraction);
  const winners = new Set(ordered.slice(0, n));
  for (const img of ordered) {
    img.dataset.couplexRoll = stableMark(img) || '1';
    img.dataset.couplexWon = winners.has(img) ? '1' : '0';
    candidates += 1;
    if (!winners.has(img)) {
      markSkip(img);
      continue;
    }
    swap(img);
  }
}

async function apiSha() {
  try {
    const res = await fetch(BRANCH_API, { cache: 'no-store' });
    if (!res.ok) return '';
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
      if (!res.ok) continue;
      const data = await res.json();
      const list = Array.isArray(data)
        ? data.map((name) => ({ n: name, w: 0, h: 0, f: null, b: name }))
        : data.images;
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
  deck = [];
  deckPos = 0;
  for (const it of IMAGES) {
    const b = it.b || it.n;
    if (!VARIANTS.has(b)) {
      VARIANTS.set(b, []);
      BASES.push(b);
    }
    VARIANTS.get(b).push(it);
  }
}

// A handful of likely crops, and only after this page won its roll.
function warmCache(n) {
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 400));
  idle(() => {
    if (!pageAgreed || !BASES.length) return;
    const pool = BASES.slice();
    shuffle(pool);
    for (const b of pool.slice(0, n)) {
      const it = variantFor(b, 1.5) || (VARIANTS.get(b) || [])[0];
      if (!it) continue;
      const im = new Image();
      im.decoding = 'async';
      im.referrerPolicy = 'no-referrer';
      im.src = CDN + it.n;
    }
  });
}

async function refresh() {
  const got = await lget({ couplexSha: null, couplexIndex: null });
  let sha = (got.couplexSha && got.couplexSha.sha) || '';
  const age = got.couplexSha ? Date.now() - (got.couplexSha.t || 0) : Infinity;
  if (!sha || age > SHA_TTL) {
    const fresh = await apiSha();
    if (fresh) {
      sha = fresh;
      await lset({ couplexSha: { t: Date.now(), sha } });
    }
  }
  if (sha) CDN = pinned(sha);

  const cached = got.couplexIndex;
  const freshIdx = cached && Date.now() - cached.t < INDEX_TTL && cached.list && cached.list.length;
  const sameSha = freshIdx && cached.sha === sha && sha;
  if (sameSha) {
    if (!BASES.length) applyIndex(cached.list);
    return;
  }
  if (!sha && freshIdx) {
    if (!BASES.length) applyIndex(cached.list);
    return;
  }

  const list = await fetchIndex(sha);
  if (!list) return;
  applyIndex(list);
  await lset({ couplexIndex: { t: Date.now(), sha: sha || '', list } });
}

async function load() {
  const stored = await chrome.storage.sync.get({ [KEY]: DEFAULTS });
  const norm = normalize(stored[KEY]);
  opts = norm.opts;
  if (norm.migrated) chrome.storage.sync.set({ [KEY]: opts });
  if (!opts.enabled) {
    hideVeil();
    return;
  }

  const got = await lget({ couplexSha: null, couplexIndex: null });
  const sha = (got.couplexSha && got.couplexSha.sha) || '';
  if (sha) CDN = pinned(sha);
  if (got.couplexIndex && got.couplexIndex.list && got.couplexIndex.list.length) {
    applyIndex(got.couplexIndex.list);
  }

  if (!BASES.length) {
    await refresh();
    if (!BASES.length) {
      hideVeil();
      return;
    }
  }

  pageAgreed = Math.random() * 100 < opts.pageChance;
  if (!pageAgreed) {
    hideVeil();
    refresh().catch(() => {});
    return;
  }

  showVeil();
  start();
  refresh().then(() => warmCache(8)).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'couplex:stats') return undefined;
  sendResponse({
    ok: true,
    replaced,
    candidates,
    pageAgreed,
    images: BASES.length,
    options: opts
  });
  return undefined;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[KEY]) {
    opts = { ...DEFAULTS, ...changes[KEY].newValue };
  }
});

load().catch(() => { if (!pageAgreed) hideVeil(); });

// Done on CyOps: categories take turns. Janitor Oil ads (j and w) appear about once every 14 photos.
