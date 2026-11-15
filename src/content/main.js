(function (root) {
  'use strict';

  // Run only in top-level HTML documents (skip embedded ad/widget iframes or raw XML/SVG)
  if (window.top !== window.self) return;
  if (!(document.documentElement instanceof HTMLElement)) return;

  const KoiPond = root.KoiPond;
  if (!KoiPond) return;

  const {
    DEFAULT_SETTINGS,
    sanitizeSettings,
    isSiteAllowed,
    fishCountForSpace,
    LayerManager,
    KoiRenderer,
    PondSimulation,
    parseCssColor,
    colorLuminance,
    viewportWidth,
    viewportHeight,
  } = KoiPond;

  const DARK_LUMINANCE_MAX = 130;
  const FISH_COUNT_SETTLE_MS = 700; // how long a page-driven change of the school size must hold

  // Local files have no hostname; use the same key the popup stores for them
  const hostname =
    (window.location && window.location.hostname) ||
    (window.location && window.location.protocol === 'file:' ? 'local-file' : '');
  const layerManager = new LayerManager();
  let renderer = null; // created on first start: its buffers are wasted on pages where the pond is off

  let settings = sanitizeSettings(DEFAULT_SETTINGS);
  let simulation = null;
  let canvas = null;
  let ctx = null;
  let rafId = null;
  let lastTs = 0;
  let nextFrameAt = 0;
  let targetFps = 60;
  let batteryLowPower = false;
  let resizeTimer = null;
  let isRunning = false;
  let fishCountTimer = null;
  let isPaused = false; // running, but the page leaves too little room: nothing is simulated or drawn
  let cssScale = 3; // CSS px per pond pixel, snapped to whole device pixels

  const INTERACTIVE_SELECTOR =
    'a[href], button, input, textarea, select, label, summary, [contenteditable]:not([contenteditable="false"]), ' +
    '[role="button"], [role="link"], [role="textbox"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"]';

  function updateFrameBudget() {
    if (settings.fpsMode === '30') {
      targetFps = 30;
    } else if (settings.fpsMode === '60') {
      targetFps = 60;
    } else {
      const saveData = Boolean(navigator.connection && navigator.connection.saveData);
      const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      // Smooth by default; halve the frame rate only when the device asks to save power or motion
      targetFps =
        batteryLowPower || saveData || reducedMotion || (coarsePointer && settings.fishCount > 10) ? 30 : 60;
    }
  }

  if (typeof navigator.getBattery === 'function') {
    try {
      navigator
        .getBattery()
        .then((battery) => {
          if (!battery) return;
          const syncBattery = () => {
            batteryLowPower = !battery.charging && typeof battery.level === 'number' && battery.level <= 0.3;
            updateFrameBudget();
          };
          syncBattery();
          if (typeof battery.addEventListener === 'function') {
            battery.addEventListener('chargingchange', syncBattery);
            battery.addEventListener('levelchange', syncBattery);
          }
        })
        .catch(() => {});
    } catch (_) {
      // Ignore environments restricting Battery Status API
    }
  }

  function detectDarkBackground() {
    const candidates = [document.body, document.documentElement];
    for (const el of candidates) {
      if (!el) continue;
      const col = parseCssColor(getComputedStyle(el).backgroundColor);
      if (col && col.a > 0.25) {
        return colorLuminance(col) < DARK_LUMINANCE_MAX;
      }
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function updateCanvasSize() {
    if (!canvas || !ctx) return;
    // Snap so one pond pixel covers a whole number of device pixels (OS scaling / browser zoom)
    const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    const scale = Math.max(1, Math.round((settings.pixelScale || 3) * dpr)) / dpr;
    cssScale = scale;
    const vw = viewportWidth() || 800;
    const vh = viewportHeight() || 600;
    const cw = Math.max(120, Math.ceil(vw / scale));
    const ch = Math.max(120, Math.ceil(vh / scale));

    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    ctx.imageSmoothingEnabled = false;
    // Exact size instead of stretching to 100%: the overhang past the viewport is clipped by the host
    canvas.style.width = `${cw * scale}px`;
    canvas.style.height = `${ch * scale}px`;

    if (!simulation) {
      simulation = new PondSimulation(cw, ch);
    }
    simulation.resize(cw, ch, vw);
    simulation.setThemeBrightness(detectDarkBackground());
  }

  function startFrames() {
    if (!isRunning || isPaused || document.hidden || rafId !== null) return;
    lastTs = performance.now();
    nextFrameAt = 0;
    rafId = requestAnimationFrame(tick);
  }

  function stopFrames() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  // Resizes the school to what the settings and the free space on the page allow. Changes caused by
  // the page (scrolling, content loading) wait a moment, so a count that flickers around a threshold
  // does not make fish come and go; the change itself is a fade, never a pop.
  function applyFishCount(delayMs) {
    if (!simulation) return;
    const target = () => fishCountForSpace(settings.fishCount, layerManager.lastVisibleRatio);
    if (fishCountTimer !== null) {
      clearTimeout(fishCountTimer);
      fishCountTimer = null;
    }
    if (simulation.fish.length === 0) {
      simulation.syncFishCount(target()); // first fill: no one to fade
    } else if (delayMs <= 0) {
      simulation.syncFishCount(target(), true);
    } else {
      fishCountTimer = setTimeout(() => {
        fishCountTimer = null;
        if (simulation && isRunning) simulation.syncFishCount(target(), true);
      }, delayMs);
    }
  }

  // Pulls the latest page measurement from the layer manager: where the open water is, how many
  // fish fit in it, and whether there is room for the pond at all.
  function syncLayout() {
    if (!simulation) return;
    simulation.setClearMap(layerManager.lastClearMap);
    simulation.setThemeBrightness(detectDarkBackground());
    applyFishCount(FISH_COUNT_SETTLE_MS);

    isPaused = layerManager.isPaused;
    if (isPaused) {
      stopFrames();
    } else {
      startFrames();
    }
  }

  function startPond() {
    if (isRunning) return;
    layerManager.onLayoutChange = syncLayout;
    if (!renderer) renderer = new KoiRenderer();
    canvas = layerManager.mount(settings);
    ctx = layerManager.ctx;
    if (!canvas || !ctx) return;

    updateCanvasSize();
    updateFrameBudget();
    isRunning = true;
    syncLayout(); // the first measurement happened inside mount(), before the simulation existed
  }

  function stopPond() {
    isRunning = false;
    isPaused = false;
    if (fishCountTimer !== null) {
      clearTimeout(fishCountTimer);
      fishCountTimer = null;
    }
    stopFrames();
    if (resizeTimer !== null) {
      clearTimeout(resizeTimer);
      resizeTimer = null;
    }
    layerManager.onLayoutChange = null;
    layerManager.unmount();
    canvas = null;
    ctx = null;
  }

  function applyCurrentSettings(nextRaw) {
    const prev = settings;
    const next = sanitizeSettings(nextRaw);
    const shouldRun = next.enabled && isSiteAllowed(next, hostname);

    // The popup message and storage.onChanged deliver the same change twice; ignore the echo
    if (shouldRun === isRunning && JSON.stringify(next) === JSON.stringify(prev)) return;

    settings = next;
    updateFrameBudget();

    if (!shouldRun) {
      stopPond();
      return;
    }

    if (!isRunning) {
      startPond();
      return;
    }

    // Only a layer-mode change needs the full page scan; everything else is applied in place
    if (prev.layerMode !== settings.layerMode) {
      layerManager.applySettings(settings);
    } else {
      layerManager.applyOpacity(settings);
    }
    if (prev.pixelScale !== settings.pixelScale) {
      updateCanvasSize();
    }
    applyFishCount(0);
  }

  function tick(ts) {
    if (!isRunning || isPaused || document.hidden || !ctx || !simulation) {
      rafId = null;
      return;
    }

    const frameBudget = 1000 / targetFps;
    if (nextFrameAt > 0 && ts + 4 < nextFrameAt) {
      rafId = requestAnimationFrame(tick);
      return;
    }
    if (nextFrameAt <= 0 || ts - nextFrameAt > frameBudget * 2) {
      nextFrameAt = ts + frameBudget;
    } else {
      nextFrameAt += frameBudget;
    }

    const dt = Math.min(0.05, Math.max(0.001, (ts - lastTs) / 1000));
    lastTs = ts;

    simulation.step(dt, settings);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 1. Water ripples underneath fish
    if (settings.ripples) {
      for (let i = 0; i < simulation.ripples.length; i++) {
        renderer.renderRipple(ctx, simulation.ripples[i]);
      }
    }

    // 2. Koi fish sorted by depth (single sprite-atlas pass)
    renderer.renderFrame(ctx, simulation.fish);

    // 3. Floating pixel food pellets on top of fish
    for (let i = 0; i < simulation.pellets.length; i++) {
      renderer.renderPellet(ctx, simulation.pellets[i], simulation.time);
    }

    rafId = requestAnimationFrame(tick);
  }

  // Event listeners (passive, zero interference with page interactions)
  window.addEventListener(
    'resize',
    () => {
      if (!isRunning) return;
      updateCanvasSize();
      if (resizeTimer !== null) {
        clearTimeout(resizeTimer);
      }
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        if (isRunning) {
          layerManager.applySettings(settings);
        }
      }, 150);
    },
    { passive: true }
  );

  window.addEventListener(
    'pointermove',
    (e) => {
      if (!isRunning || !simulation || settings.cursorMode === 'none') return;
      const scale = cssScale;
      simulation.onCursorMove(e.clientX / scale, e.clientY / scale, settings);
    },
    { passive: true }
  );

  window.addEventListener(
    'pointerdown',
    (e) => {
      if (!isRunning || !simulation || e.button !== 0) return;
      if (settings.cursorMode !== 'feed') return;
      const target = e.target;
      // Clicks meant for the page's own controls or editable text are not feeding
      if (target && (target.isContentEditable || (target.closest && target.closest(INTERACTIVE_SELECTOR)))) {
        return;
      }
      const scale = cssScale;
      simulation.dropFood(e.clientX / scale, e.clientY / scale, 2 + Math.floor(Math.random() * 2), settings.ripples);
    },
    { passive: true }
  );

  document.addEventListener('visibilitychange', () => {
    if (!isRunning) return;
    if (document.hidden) {
      stopFrames();
    } else {
      startFrames();
    }
  });

  window.addEventListener('pagehide', () => {
    if (isRunning) {
      stopPond();
    }
  });

  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      applyCurrentSettings(settings);
    }
  });

  // Storage & Popup messaging
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
      if (chrome.runtime && chrome.runtime.lastError) {
        applyCurrentSettings(DEFAULT_SETTINGS);
        return;
      }
      applyCurrentSettings(stored);
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync') return;
      const updated = { ...settings };
      for (const [key, change] of Object.entries(changes)) {
        updated[key] = change.newValue;
      }
      applyCurrentSettings(updated);
    });
  } else {
    applyCurrentSettings(DEFAULT_SETTINGS);
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'KOI_APPLY_SETTINGS') {
        applyCurrentSettings(msg.settings);
        sendResponse({ ok: true, active: isRunning, paused: isPaused });
      } else if (msg.type === 'KOI_DROP_FOOD') {
        if (isRunning && !isPaused && simulation) {
          simulation.dropFoodBurst();
        }
        sendResponse({ ok: true });
      } else if (msg.type === 'KOI_RESPAWN') {
        if (isRunning && !isPaused && simulation) {
          simulation.respawnAll(fishCountForSpace(settings.fishCount, layerManager.lastVisibleRatio));
        }
        sendResponse({ ok: true });
      } else if (msg.type === 'KOI_GET_STATUS') {
        sendResponse({ active: isRunning, paused: isPaused, hostname });
      }
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
