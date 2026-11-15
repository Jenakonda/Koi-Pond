(function () {
  'use strict';

  const {
    DEFAULT_SETTINGS,
    sanitizeSettings,
    isSiteAllowed,
    hostMatches,
    normalizeHostEntry,
    resolveLanguage,
    translate,
    PondSimulation,
    KoiRenderer,
  } = globalThis.KoiPond;

  const $ = (id) => document.getElementById(id);

  const els = {
    enabledToggle: $('enabledToggle'),
    statusDot: $('statusDot'),
    siteHost: $('siteHost'),
    siteState: $('siteState'),
    siteToggleBtn: $('siteToggleBtn'),
    tabs: [$('tabPond'), $('tabSites')],
    panels: { pond: $('panelPond'), sites: $('panelSites') },
    siteCount: $('siteCount'),
    feedBtn: $('feedBtn'),
    respawnBtn: $('respawnBtn'),
    fishCountRange: $('fishCountRange'),
    fishCountVal: $('fishCountVal'),
    speedRange: $('speedRange'),
    speedVal: $('speedVal'),
    opacityRange: $('opacityRange'),
    opacityVal: $('opacityVal'),
    pixelScaleGroup: $('pixelScaleGroup'),
    layerModeGroup: $('layerModeGroup'),
    cursorModeGroup: $('cursorModeGroup'),
    fpsModeGroup: $('fpsModeGroup'),
    ripplesToggle: $('ripplesToggle'),
    pondHint: $('pondHint'),
    languageGroup: $('languageGroup'),
    siteModeGroup: $('siteModeGroup'),
    siteModeHint: $('siteModeHint'),
    siteAddForm: $('siteAddForm'),
    siteInput: $('siteInput'),
    siteError: $('siteError'),
    siteList: $('siteList'),
  };

  const TAB_STORAGE_KEY = 'koiPopupTab';

  let currentSettings = sanitizeSettings(DEFAULT_SETTINGS);
  let language = resolveLanguage(currentSettings.language, navigator.language);

  const t = (key, params) => translate(language, key, params);

  // Fills every element marked with data-i18n (text), data-i18n-aria, data-i18n-title or
  // data-i18n-placeholder, and updates the document language.
  function applyTranslations() {
    document.documentElement.lang = language;
    document.title = t('pageTitle');
    for (const el of document.querySelectorAll('[data-i18n]')) {
      el.textContent = t(el.dataset.i18n);
    }
    for (const el of document.querySelectorAll('[data-i18n-aria]')) {
      el.setAttribute('aria-label', t(el.dataset.i18nAria));
    }
    for (const el of document.querySelectorAll('[data-i18n-title]')) {
      el.title = t(el.dataset.i18nTitle);
    }
    for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    }
  }
  let activeTabId = null;
  let activeHostname = '';
  let isWebTab = false;
  let tabConnected = true;
  let tabPaused = false; // the page leaves too little room and the pond is hidden there
  let syncWriteTimer = null;
  let hasPendingSync = false;

  // ---------- Settings persistence ----------

  function persistSettingsToSync() {
    hasPendingSync = false;
    if (syncWriteTimer !== null) {
      clearTimeout(syncWriteTimer);
      syncWriteTimer = null;
    }
    chrome.storage.sync.set(currentSettings, () => {
      void chrome.runtime.lastError;
    });
  }

  function applyTabStatus(resp) {
    tabConnected = !chrome.runtime.lastError && Boolean(resp);
    tabPaused = Boolean(tabConnected && resp && resp.paused);
    renderUI();
  }

  function savePatch(patch, immediateSync = true) {
    currentSettings = sanitizeSettings({ ...currentSettings, ...patch });
    renderUI();

    if (immediateSync) {
      persistSettingsToSync();
    } else {
      hasPendingSync = true;
      if (syncWriteTimer !== null) {
        clearTimeout(syncWriteTimer);
      }
      syncWriteTimer = setTimeout(persistSettingsToSync, 250);
    }

    if (activeTabId && isWebTab) {
      chrome.tabs.sendMessage(activeTabId, { type: 'KOI_APPLY_SETTINGS', settings: currentSettings }, applyTabStatus);
    }
  }

  function sendTabCommand(type) {
    if (!activeTabId || !isWebTab) return;
    chrome.tabs.sendMessage(activeTabId, { type }, () => {
      if (chrome.runtime.lastError) {
        tabConnected = false;
        renderUI();
      }
    });
  }

  // ---------- Site lists ----------

  function activeListKey() {
    return currentSettings.siteMode === 'whitelist' ? 'whitelist' : 'blacklist';
  }

  function activeList() {
    return currentSettings[activeListKey()];
  }

  function addSite(host) {
    if (activeList().includes(host)) return;
    savePatch({ [activeListKey()]: [...activeList(), host] });
  }

  function removeSite(host) {
    savePatch({ [activeListKey()]: activeList().filter((entry) => entry !== host) });
  }

  // The current site may be covered by a parent entry ("google.com" for "drive.google.com"),
  // so toggling it off the list removes every entry that matches it.
  function toggleCurrentSite() {
    const host = normalizeHostEntry(activeHostname);
    if (!host) return;
    if (hostMatches(activeList(), host)) {
      savePatch({
        [activeListKey()]: activeList().filter((entry) => !(host === entry || host.endsWith(`.${entry}`))),
      });
    } else {
      addSite(host);
    }
  }

  function renderSiteList() {
    const list = activeList();
    const current = normalizeHostEntry(activeHostname);
    const whitelist = currentSettings.siteMode === 'whitelist';

    els.siteCount.textContent = list.length > 0 ? String(list.length) : '';
    els.siteModeHint.textContent = t(whitelist ? 'siteHintWhitelist' : 'siteHintBlacklist');

    els.siteList.textContent = '';
    if (list.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'site-empty';
      empty.textContent = t(whitelist ? 'siteEmptyWhitelist' : 'siteEmptyBlacklist');
      els.siteList.appendChild(empty);
      return;
    }

    for (const host of list) {
      const item = document.createElement('li');
      if (current && (current === host || current.endsWith(`.${host}`))) {
        item.className = 'current';
      }

      const name = document.createElement('span');
      name.className = 'site-name';
      name.textContent = host;
      name.title = host;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'site-remove';
      remove.textContent = '✕';
      remove.setAttribute('aria-label', t('siteRemoveAria', { host }));
      remove.addEventListener('click', () => removeSite(host));

      item.appendChild(name);
      item.appendChild(remove);
      els.siteList.appendChild(item);
    }
  }

  // ---------- Rendering ----------

  function setSegmentedValue(container, value) {
    for (const btn of container.querySelectorAll('button[data-val]')) {
      const selected = btn.dataset.val === String(value);
      btn.classList.toggle('active', selected);
      btn.setAttribute('aria-pressed', String(selected));
    }
  }

  function setRange(rangeEl, value) {
    rangeEl.value = value;
    const min = Number(rangeEl.min);
    const max = Number(rangeEl.max);
    rangeEl.style.setProperty('--fill', `${((Number(value) - min) / (max - min)) * 100}%`);
  }

  function describeState(siteAllowed) {
    if (!isWebTab) return t('stateUnavailable');
    if (!currentSettings.enabled) return t('stateOffEverywhere');
    if (!siteAllowed) {
      return t(currentSettings.siteMode === 'whitelist' ? 'stateNotWhitelisted' : 'stateBlacklisted');
    }
    if (!tabConnected) return t('stateReload');
    if (tabPaused) return t('statePaused');
    return t('stateActive');
  }

  function describeHint() {
    if (currentSettings.layerMode === 'strict-behind') return t('hintBehind');
    if (currentSettings.layerMode === 'ambient-top') return t('hintTop');
    if (currentSettings.cursorMode === 'feed') return t('hintFeed');
    if (currentSettings.cursorMode === 'scatter') return t('hintScare');
    return t('hintCalm');
  }

  let appliedLanguage = null;

  function renderUI() {
    const s = currentSettings;

    language = resolveLanguage(s.language, navigator.language);
    if (language !== appliedLanguage) {
      appliedLanguage = language;
      applyTranslations();
      els.siteError.textContent = ''; // a shown error would stay in the previous language
    }
    setSegmentedValue(els.languageGroup, language);

    els.enabledToggle.checked = s.enabled;
    document.body.classList.toggle('pond-off', !s.enabled);

    setRange(els.fishCountRange, s.fishCount);
    els.fishCountVal.textContent = String(s.fishCount);
    setRange(els.speedRange, s.speed);
    els.speedVal.textContent = `${s.speed.toFixed(1)}x`;
    setRange(els.opacityRange, s.opacity);
    els.opacityVal.textContent = `${Math.round(s.opacity * 100)}%`;

    setSegmentedValue(els.pixelScaleGroup, s.pixelScale);
    setSegmentedValue(els.layerModeGroup, s.layerMode);
    setSegmentedValue(els.cursorModeGroup, s.cursorMode);
    setSegmentedValue(els.fpsModeGroup, s.fpsMode);
    setSegmentedValue(els.siteModeGroup, s.siteMode);
    els.ripplesToggle.checked = s.ripples;

    const siteAllowed = isSiteAllowed(s, activeHostname);
    const pondActive = s.enabled && isWebTab && siteAllowed && tabConnected;
    const pondDrawing = pondActive && !tabPaused;

    els.statusDot.classList.toggle('off', !pondActive);
    els.statusDot.classList.toggle('paused', pondActive && tabPaused);
    els.siteHost.textContent = isWebTab ? activeHostname || t('hostCurrentPage') : t('hostSystemPage');
    els.siteState.textContent = describeState(siteAllowed);

    const onList = hostMatches(activeList(), activeHostname);
    els.siteToggleBtn.disabled = !isWebTab;
    if (!isWebTab) {
      els.siteToggleBtn.textContent = t('siteUnavailable');
    } else if (s.siteMode === 'whitelist') {
      els.siteToggleBtn.textContent = t(onList ? 'siteRemove' : 'siteAdd');
    } else {
      els.siteToggleBtn.textContent = t(onList ? 'siteOnHere' : 'siteOffHere');
    }

    els.feedBtn.disabled = !pondDrawing;
    els.respawnBtn.disabled = !pondDrawing;
    els.pondHint.textContent = describeHint();

    renderSiteList();
  }

  // ---------- Tabs ----------

  function selectTab(name) {
    for (const tab of els.tabs) {
      const selected = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const [key, panel] of Object.entries(els.panels)) {
      panel.classList.toggle('inactive', key !== name);
      // Hidden panels stay in layout (so the popup keeps one height) but out of the tab order
      panel.inert = key !== name;
    }
    try {
      localStorage.setItem(TAB_STORAGE_KEY, name);
    } catch (_) {
      // Remembering the tab is a convenience only
    }
  }

  for (const tab of els.tabs) {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const other = els.tabs.find((t) => t !== tab);
      selectTab(other.dataset.tab);
      other.focus();
    });
  }

  let initialTab = 'pond';
  try {
    if (localStorage.getItem(TAB_STORAGE_KEY) === 'sites') initialTab = 'sites';
  } catch (_) {
    // Fall back to the first tab
  }
  selectTab(initialTab);

  // ---------- Controls ----------

  function wireSegmented(container, key, numeric = false) {
    container.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-val]');
      if (!btn) return;
      savePatch({ [key]: numeric ? Number(btn.dataset.val) : btn.dataset.val });
    });
  }

  function wireRangeInput(rangeEl, key) {
    rangeEl.addEventListener('input', () => {
      savePatch({ [key]: Number(rangeEl.value) }, false);
    });
    rangeEl.addEventListener('change', () => {
      if (hasPendingSync) {
        persistSettingsToSync();
      }
    });
  }

  els.enabledToggle.addEventListener('change', () => savePatch({ enabled: els.enabledToggle.checked }));
  els.ripplesToggle.addEventListener('change', () => savePatch({ ripples: els.ripplesToggle.checked }));
  els.siteToggleBtn.addEventListener('click', toggleCurrentSite);
  els.feedBtn.addEventListener('click', () => sendTabCommand('KOI_DROP_FOOD'));
  els.respawnBtn.addEventListener('click', () => sendTabCommand('KOI_RESPAWN'));

  wireRangeInput(els.fishCountRange, 'fishCount');
  wireRangeInput(els.speedRange, 'speed');
  wireRangeInput(els.opacityRange, 'opacity');

  wireSegmented(els.pixelScaleGroup, 'pixelScale', true);
  wireSegmented(els.layerModeGroup, 'layerMode');
  wireSegmented(els.cursorModeGroup, 'cursorMode');
  wireSegmented(els.fpsModeGroup, 'fpsMode');
  wireSegmented(els.siteModeGroup, 'siteMode');
  wireSegmented(els.languageGroup, 'language');

  els.siteAddForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = els.siteInput.value;
    if (!raw.trim()) return;
    const host = normalizeHostEntry(raw);
    if (!host) {
      els.siteError.textContent = t('siteInvalid');
      return;
    }
    if (activeList().includes(host)) {
      els.siteError.textContent = t('siteDuplicate', { host });
      return;
    }
    els.siteError.textContent = '';
    els.siteInput.value = '';
    addSite(host);
  });

  els.siteInput.addEventListener('input', () => {
    els.siteError.textContent = '';
  });

  window.addEventListener('pagehide', () => {
    if (hasPendingSync) {
      persistSettingsToSync();
    }
  });

  // ---------- Banner: a tiny live pond using the same simulation and renderer as the page ----------

  function startBannerPond() {
    const canvas = $('pondBanner');
    if (!canvas || !PondSimulation || !KoiRenderer) return;

    const scale = 2;
    const width = Math.round(canvas.clientWidth / scale) || 170;
    const height = Math.round(canvas.clientHeight / scale) || 36;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    const sim = new PondSimulation(width, height, undefined, 24);
    sim.resize(width, height, canvas.clientWidth); // narrow width selects the smaller fish size
    sim.syncFishCount(2);
    const renderer = new KoiRenderer();
    const simSettings = { speed: 0.7, ripples: false, cursorMode: 'none' };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      renderer.renderFrame(ctx, sim.fish);
    };

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (let i = 0; i < 90; i++) sim.step(1 / 30, simSettings);
      draw();
      return;
    }

    let last = performance.now();
    const frame = (ts) => {
      if (ts - last >= 32) {
        sim.step(Math.min(0.05, (ts - last) / 1000), simSettings);
        last = ts;
        draw();
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  startBannerPond();

  // ---------- Initialize from storage + active tab ----------

  chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
    currentSettings = sanitizeSettings(stored);
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (tab && tab.url) {
        activeTabId = tab.id;
        try {
          const url = new URL(tab.url);
          isWebTab = url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'file:';
          activeHostname = url.hostname || (url.protocol === 'file:' ? 'local-file' : '');
        } catch {
          isWebTab = false;
        }
      }
      renderUI();
      requestAnimationFrame(() => document.body.classList.remove('preload'));
      if (activeTabId && isWebTab) {
        chrome.tabs.sendMessage(activeTabId, { type: 'KOI_GET_STATUS' }, applyTabStatus);
      }
    });
  });
})();
