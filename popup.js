// Couplex popup — three sliders + live counters.

const DEFAULTS = { enabled: true, pageChance: 40, imagePercent: 35, minSize: 64 };
const KEY = 'couplexOptions';

const el = (id) => document.getElementById(id);
const controls = {
  enabled: el('enabled'),
  pageChance: el('pageChance'),
  imagePercent: el('imagePercent'),
  minSize: el('minSize')
};
const labels = {
  pageChance: el('pageChanceVal'),
  imagePercent: el('imagePercentVal'),
  minSize: el('minSizeVal')
};

function paint(opts) {
  controls.enabled.checked = opts.enabled;
  controls.pageChance.value = opts.pageChance;
  controls.imagePercent.value = opts.imagePercent;
  controls.minSize.value = opts.minSize;
  labels.pageChance.textContent = `${opts.pageChance}%`;
  labels.imagePercent.textContent = `${opts.imagePercent}%`;
  labels.minSize.textContent = `${opts.minSize} px`;
}

function read() {
  return {
    enabled: controls.enabled.checked,
    pageChance: Number(controls.pageChance.value),
    imagePercent: Number(controls.imagePercent.value),
    minSize: Number(controls.minSize.value)
  };
}

let saveTimer = null;
function save() {
  const opts = read();
  paint(opts);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.sync.set({ [KEY]: opts }), 120);
}

for (const control of Object.values(controls)) {
  control.addEventListener('input', save);
  control.addEventListener('change', save);
}

async function init() {
  const stored = await chrome.storage.sync.get({ [KEY]: DEFAULTS });
  const opts = { ...DEFAULTS, ...stored[KEY] };
  paint(opts);

  try {
    const res = await fetch(chrome.runtime.getURL('images/index.json'));
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.images || [];
    el('setCount').textContent = new Set(list.map((it) => (it && it.b) || it)).size;
  } catch (e) {
    el('setCount').textContent = '0';
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('no tab');
    const stats = await chrome.tabs.sendMessage(tab.id, { type: 'couplex:stats' });
    el('pageCount').textContent = stats && stats.ok ? `${stats.replaced} / ${stats.candidates}` : 'n/a';
  } catch (e) {
    el('pageCount').textContent = 'n/a';
  }
}

init();
