// Couplex service worker.
//
// The content script cannot read the extension's own folder, so it asks here.
// This is what makes "drop new photos into images/ and reload the extension"
// work without regenerating index.json.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'couplex:scan') return undefined;

  const done = (files) => sendResponse({ files: Array.isArray(files) ? files : [] });

  if (!chrome.runtime.getPackageDirectoryEntry) return done([]);

  chrome.runtime.getPackageDirectoryEntry((root) => {
    if (!root) return done([]);
    root.getDirectory('images', {}, (dir) => {
      const names = [];
      const reader = dir.createReader();
      const read = () => {
        reader.readEntries((entries) => {
          if (!entries.length) return done(names);
          for (const e of entries) if (e.isFile) names.push(e.name);
          read();
        }, () => done(names));
      };
      read();
    }, () => done([]));
  });

  return true; // keep the message channel open for the async answer
});
