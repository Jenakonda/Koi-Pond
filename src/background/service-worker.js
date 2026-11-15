importScripts('../shared/defaults.js');

const { DEFAULT_SETTINGS, sanitizeSettings } = globalThis.KoiPond;

function updateBadge(enabled) {
  if (!chrome.action) return;
  if (enabled) {
    chrome.action.setBadgeText({ text: '' });
  } else {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#475569' });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  // disabledHosts is the pre-list format; it is not among the defaults, so ask for it by name
  chrome.storage.sync.get({ ...DEFAULT_SETTINGS, disabledHosts: null }, (stored) => {
    const legacy = Array.isArray(stored.disabledHosts) ? stored.disabledHosts : [];
    const merged = sanitizeSettings({
      ...stored,
      blacklist: [...(Array.isArray(stored.blacklist) ? stored.blacklist : []), ...legacy],
    });
    chrome.storage.sync.set(merged, () => {
      if (!chrome.runtime.lastError && stored.disabledHosts !== null) {
        chrome.storage.sync.remove('disabledHosts');
      }
    });
    updateBadge(merged.enabled);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  if (changes.enabled) {
    updateBadge(Boolean(changes.enabled.newValue));
  }
});

chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
  updateBadge(Boolean(stored.enabled));
});
