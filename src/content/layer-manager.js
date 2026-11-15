(function (root) {
  'use strict';

  const KoiPond = (root.KoiPond = root.KoiPond || {});

  const HOST_ID = 'koi-pond-extension-root';
  const SKIP_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'LINK',
    'META',
    'NOSCRIPT',
    'TEMPLATE',
    'VIDEO',
    'IMG',
    'PICTURE',
    'CANVAS',
    'SVG',
    'IFRAME',
    'EMBED',
    'OBJECT',
    'HEADER',
    'NAV',
    'FOOTER',
    'ASIDE',
    'DIALOG',
    'BUTTON',
    'INPUT',
    'TEXTAREA',
    'SELECT',
    'A',
    'TABLE',
  ]);

  const IGNORE_MUTATION_TAGS = new Set([
    'SPAN',
    'B',
    'I',
    'EM',
    'STRONG',
    'SMALL',
    'TIME',
    'SVG',
    'PATH',
    'CIRCLE',
    'RECT',
    'G',
    'LINE',
    'TEXT',
    'TSPAN',
  ]);

  const MEDIA_BLOCK_TAGS = new Set(['VIDEO', 'CANVAS', 'IFRAME', 'EMBED', 'OBJECT', 'IMG', 'SVG']);
  const TEXT_BLOCK_TAGS = new Set([
    'P',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'PRE',
    'CODE',
    'BLOCKQUOTE',
    'LI',
    'TD',
    'TH',
    'FIGCAPTION',
  ]);
  const CLEAR_GRID_COLS = 16;
  const CLEAR_GRID_ROWS = 10;

  const SKIP_ROLES = new Set(['dialog', 'alertdialog', 'banner', 'navigation', 'menu', 'menubar']);
  // Share of open viewport cells below which the pond pauses, and above which it comes back.
  // The gap between the two keeps it from flickering on and off around the threshold.
  const PAUSE_RATIO = 0.12;
  const RESUME_RATIO = 0.16;
  const SCRIM_MAX_ALPHA = 0.9; // a full-viewport layer at least this opaque really hides the pond
  const MAX_SCAN_NODES = 1400;
  const MAX_SCAN_DEPTH = 22;

  function viewportWidth() {
    return window.innerWidth || document.documentElement.clientWidth || 0;
  }

  function viewportHeight() {
    return window.innerHeight || document.documentElement.clientHeight || 0;
  }

  function parseAlpha(token) {
    if (token === undefined) return 1;
    return token.endsWith('%') ? parseFloat(token) / 100 : parseFloat(token);
  }

  const resolvedColorCache = new Map();
  let colorProbeCtx = null;

  // Fallback for computed colors the regexes cannot read (oklch, lab, display-p3, color-mix...):
  // let the browser paint one pixel and read it back as sRGB. Cached per color string.
  function resolveCssColorViaCanvas(str) {
    if (typeof document === 'undefined' || str.indexOf('(') === -1) return null;
    if (resolvedColorCache.has(str)) return resolvedColorCache.get(str);

    let result = null;
    try {
      if (!colorProbeCtx) {
        const probe = document.createElement('canvas');
        probe.width = 1;
        probe.height = 1;
        colorProbeCtx = probe.getContext('2d', { willReadFrequently: true });
      }
      const ctx = colorProbeCtx;
      if (ctx) {
        // An unparseable value leaves fillStyle untouched, so the sentinel survives
        ctx.fillStyle = '#010203';
        ctx.fillStyle = str;
        if (ctx.fillStyle !== '#010203') {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillRect(0, 0, 1, 1);
          const d = ctx.getImageData(0, 0, 1, 1).data;
          result = { r: d[0], g: d[1], b: d[2], a: Math.round((d[3] / 255) * 100) / 100 };
        }
      }
    } catch (_) {
      result = null;
    }

    if (resolvedColorCache.size >= 256) resolvedColorCache.clear();
    resolvedColorCache.set(str, result);
    return result;
  }

  function parseCssColor(str) {
    if (!str || typeof str !== 'string') return null;
    const m = str.match(
      /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i
    );
    if (m) {
      const r = Math.round(Number(m[1]));
      const g = Math.round(Number(m[2]));
      const b = Math.round(Number(m[3]));
      const a = parseAlpha(m[4]);
      if (![r, g, b, a].every(Number.isFinite)) return null;
      return { r, g, b, a };
    }

    const srgb = str.match(
      /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/i
    );
    if (!srgb) return resolveCssColorViaCanvas(str);
    const r = Math.round(Number(srgb[1]) * 255);
    const g = Math.round(Number(srgb[2]) * 255);
    const b = Math.round(Number(srgb[3]) * 255);
    const a = parseAlpha(srgb[4]);
    if (![r, g, b, a].every(Number.isFinite)) return null;
    return { r, g, b, a };
  }

  function colorLuminance(c) {
    return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  }

  function isSameColor(c1, c2, tolerance = 18) {
    if (!c1 || !c2) return false;
    return (
      Math.abs(c1.r - c2.r) <= tolerance &&
      Math.abs(c1.g - c2.g) <= tolerance &&
      Math.abs(c1.b - c2.b) <= tolerance
    );
  }

  function isCompatibleBackdrop(bgCol, baseColor) {
    if (!bgCol || !baseColor) return false;
    if (isSameColor(bgCol, baseColor, 16)) return true;
    const l1 = colorLuminance(bgCol);
    const l2 = colorLuminance(baseColor);
    const bothLight = l1 >= 205 && l2 >= 205;
    const bothDark = l1 <= 50 && l2 <= 50;
    return (bothLight || bothDark) && Math.abs(l1 - l2) <= 30;
  }

  // Elements the smart scan never touches or descends into.
  // aria-hidden is deliberately not a reason to skip: apps put it on their whole root while a modal
  // is open, and skipping the root would undo our overrides and hide the pond behind the dialog.
  function isScanExcluded(el) {
    if (!el || SKIP_TAGS.has(el.tagName)) return true;
    if (!el.getAttribute) return false;
    return SKIP_ROLES.has(el.getAttribute('role'));
  }

  function findModalDialog() {
    try {
      return document.querySelector('dialog:modal');
    } catch (_) {
      return null; // :modal not supported
    }
  }

  // A modal's dimming layer: translucent and stretched over (almost) the whole viewport.
  // The pond stays visible through it, so it must not count as cover or be restyled.
  function isScrim(rect, bgCol, vw, vh) {
    if (!bgCol || bgCol.a <= 0.05 || bgCol.a >= SCRIM_MAX_ALPHA) return false;
    return rect.width >= vw * 0.9 && rect.height >= vh * 0.9;
  }

  // Fixed/sticky top toolbars and narrow full-height navigation sidebars
  function isToolbarOrSidebar(rect, cs, vw, vh, scrollY) {
    const isTopBar =
      rect.top >= -10 &&
      rect.top < 80 &&
      rect.height < 72 &&
      rect.width > vw * 0.65 &&
      (cs.position === 'fixed' || cs.position === 'sticky' || scrollY < 40);
    return isTopBar || (rect.width < vw * 0.34 && rect.height >= vh * 0.5);
  }

  function getBorderInfo(cs) {
    const sides = [
      [cs.borderTopWidth, cs.borderTopStyle, cs.borderTopColor],
      [cs.borderBottomWidth, cs.borderBottomStyle, cs.borderBottomColor],
      [cs.borderLeftWidth, cs.borderLeftStyle, cs.borderLeftColor],
      [cs.borderRightWidth, cs.borderRightStyle, cs.borderRightColor],
    ];
    let visibleCount = 0;
    for (let i = 0; i < 4; i++) {
      const [wStr, style, colStr] = sides[i];
      const w = parseFloat(wStr) || 0;
      if (w >= 0.8 && style !== 'none') {
        const bc = parseCssColor(colStr);
        if (bc && bc.a > 0.08) visibleCount++;
      }
    }
    const ow = parseFloat(cs.outlineWidth) || 0;
    let hasOutline = false;
    if (ow >= 0.8 && cs.outlineStyle && cs.outlineStyle !== 'none') {
      const oc = parseCssColor(cs.outlineColor);
      if (oc && oc.a > 0.08) hasOutline = true;
    }
    return { visibleCount, hasOutline };
  }

  function hasVisibleBorder(cs) {
    const info = getBorderInfo(cs);
    return info.visibleCount >= 2 || info.hasOutline;
  }

  function countSignificantChildren(el) {
    if (!el || !el.children) return 0;
    let count = 0;
    const stack = Array.from(el.children);
    let head = 0;
    while (head < stack.length && head < 140) {
      const child = stack[head++];
      if (!child || SKIP_TAGS.has(child.tagName)) continue;
      const r = child.getBoundingClientRect ? child.getBoundingClientRect() : null;
      if (!r) continue;
      if (r.width >= 140 && r.height >= 48) {
        count++;
        if (count >= 3) return count;
      }
      if (child.children && child.children.length > 0 && (r.height === 0 || r.height > 100)) {
        for (let i = 0; i < child.children.length; i++) {
          stack.push(child.children[i]);
        }
      }
    }
    return count;
  }

  // bgOverride: the element's original background when our own inline override is currently applied
  function isWorkspaceOrShell(el, rect, cs, vw, vh, bgOverride) {
    const bgCol = parseCssColor(bgOverride || cs.backgroundColor);
    const hasBgImage = cs.backgroundImage && cs.backgroundImage !== 'none';
    if (hasBgImage || !bgCol || bgCol.a <= 0.72) return false;

    const hasCardShadow = Boolean(cs.boxShadow && cs.boxShadow !== 'none');
    const borderRadius = parseFloat(cs.borderTopLeftRadius) || 0;
    const bordered = hasVisibleBorder(cs);
    if (hasCardShadow || bordered) return false;

    // Never touch centered article/comment sheets that already leave left+right background margins
    const isCenteredSheet =
      typeof rect.left === 'number' &&
      typeof rect.right === 'number' &&
      rect.left > vw * 0.08 &&
      rect.right < vw * 0.92 &&
      rect.width < vw * 0.84;
    if (isCenteredSheet) return false;

    // Classic full-bleed page shell (no card styling)
    if (rect.width >= vw * 0.9 && rect.height >= vh * 0.75 && borderRadius <= 12) {
      return true;
    }

    // Dominant split-pane workspace container (supports Material 3 rounded panes up to 32px)
    const areaRatio = (rect.width * rect.height) / Math.max(1, vw * vh);
    if (rect.width >= vw * 0.64 && rect.height >= vh * 0.68 && areaRatio >= 0.44 && borderRadius <= 32) {
      if (el.tagName === 'MAIN' || (el.getAttribute && el.getAttribute('role') === 'main')) {
        return true;
      }
      if (countSignificantChildren(el) >= 2) {
        return true;
      }
    }

    return false;
  }

  function isBoundedTransparentCard(el, rect, cs, vw, vh, bgOverride) {
    if (rect.width < 140 || rect.height < 64) return false;
    if (rect.width >= vw * 0.94 && rect.height >= vh * 0.82) return false;
    if (rect.height >= Math.max(vh * 0.9, 720)) return false;

    const bgCol = parseCssColor(bgOverride || cs.backgroundColor);
    const hasBgImage = cs.backgroundImage && cs.backgroundImage !== 'none';
    if (hasBgImage || (bgCol && bgCol.a >= 0.14)) return false;

    const borderRadius = parseFloat(cs.borderTopLeftRadius) || 0;
    const hasShadow = Boolean(cs.boxShadow && cs.boxShadow !== 'none');
    const borderInfo = getBorderInfo(cs);

    const isCardStyled =
      hasShadow ||
      borderInfo.hasOutline ||
      borderInfo.visibleCount >= 4 ||
      (borderInfo.visibleCount >= 2 && borderRadius >= 2);
    if (!isCardStyled) return false;

    if (el.tagName === 'BODY' || el.tagName === 'HTML' || el.tagName === 'MAIN') return false;
    return true;
  }

  class LayerManager {
    constructor() {
      this.host = null;
      this.backdrop = null;
      this.canvas = null;
      this.ctx = null;
      this.modifiedElements = new Map(); // Element -> { value, priority, origBg, applied }
      this.pendingApply = false; // a scan was requested while the tab was hidden
      this.pendingHard = false; // next scheduled refresh must re-read original page colors
      this.refreshInterval = 900; // min gap between mutation-driven scans; grows while nothing changes
      this.lastScanSig = '';
      this.onVisibility = () => {
        if (!document.hidden && this.pendingApply && this.host && this.host.isConnected) {
          this.applySettings(this.lastSettings);
        }
      };
      this.observer = null;
      this.themeObserver = null;
      this.refreshTimer = null;
      this.scrollTimer = null;
      this.lastScanAt = 0;
      this.currentMode = 'smart';
      this.isPaused = false; // too little open space on the page: host hidden, nothing drawn
      this.smartBackdropColor = 'transparent';
      this.lastClearMap = null;
      this.lastVisibleRatio = 1;
      this.preModalCells = null; // openness grid from the last measurement without a modal <dialog>
      this.onLayoutChange = null; // called after clear map / visible ratio / paused state update
      this.lastSettings = { layerMode: 'smart', opacity: 0.9 };
      this.onAsyncLoad = () => this.scheduleSmartRefresh(true);
      this.onScroll = () => this.scheduleClearMapRefresh();
    }

    mount(settings) {
      if (this.host && this.host.isConnected) {
        this.applySettings(settings);
        return this.canvas;
      }

      const existing = document.getElementById(HOST_ID);
      if (existing) existing.remove();

      const host = document.createElement('div');
      host.id = HOST_ID;
      host.setAttribute('aria-hidden', 'true');

      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `
        :host {
          all: initial;
          position: fixed !important;
          inset: 0 !important;
          width: 100vw !important;
          height: 100vh !important;
          pointer-events: none !important;
          overflow: hidden !important;
          margin: 0 !important;
          padding: 0 !important;
          border: 0 !important;
          background: transparent !important;
          display: block !important;
          z-index: -1 !important;
        }
        :host([data-layer="top"]) {
          z-index: 2147483645 !important;
        }
        :host([data-paused]) {
          display: none !important;
        }
        .pond-backdrop {
          position: fixed;
          inset: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
          background: transparent;
        }
        canvas.pond-canvas {
          position: fixed;
          inset: 0;
          width: 100%;
          height: 100%;
          display: block;
          pointer-events: none;
          image-rendering: pixelated;
          image-rendering: crisp-edges;
        }
      `;

      const backdrop = document.createElement('div');
      backdrop.className = 'pond-backdrop';

      const canvas = document.createElement('canvas');
      canvas.className = 'pond-canvas';

      shadow.appendChild(style);
      shadow.appendChild(backdrop);
      shadow.appendChild(canvas);

      const docEl = document.documentElement;
      if (docEl.firstChild) {
        docEl.insertBefore(host, docEl.firstChild);
      } else {
        docEl.appendChild(host);
      }

      this.host = host;
      this.backdrop = backdrop;
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: true });

      this.applySettings(settings);
      this.startObserver();

      return canvas;
    }

    setPaused(paused) {
      this.isPaused = paused;
      if (this.host) this.host.toggleAttribute('data-paused', paused);
    }

    emitLayout(clearMap, visibleRatio) {
      this.lastClearMap = clearMap;
      this.lastVisibleRatio = visibleRatio;
      if (typeof this.onLayoutChange === 'function') {
        this.onLayoutChange();
      }
    }

    // Pause decision with hysteresis, shared by every place that measures the page
    shouldPause(visibleRatio) {
      return visibleRatio < (this.isPaused ? RESUME_RATIO : PAUSE_RATIO);
    }

    // Stacking only; canvas opacity is decided in one place, applyOpacity()
    setHostLayer(mode) {
      const docEl = document.documentElement;
      if (!docEl || !this.host || !this.canvas) return;
      if (mode === 'top') {
        this.host.setAttribute('data-layer', 'top');
        if (docEl.lastChild !== this.host) {
          docEl.appendChild(this.host);
        }
        this.backdrop.style.backgroundColor = 'transparent';
      } else {
        this.host.setAttribute('data-layer', 'behind');
        if (docEl.firstChild !== this.host) {
          docEl.insertBefore(this.host, docEl.firstChild);
        }
        this.backdrop.style.backgroundColor = this.smartBackdropColor || 'transparent';
      }
    }

    // Opacity-only update: no page scan
    applyOpacity(settings) {
      if (!this.host || !this.canvas) return;
      this.lastSettings = { ...settings };
      this.canvas.style.opacity = String(settings.opacity);
    }

    // soft = keep our current overrides in place and only write the difference (mutation-driven refresh).
    // A hard apply restores the page first, so changed page colors (theme switch, navigation) are re-read.
    applySettings(settings, soft = false) {
      if (!this.host || !this.canvas) return;
      this.lastSettings = { ...settings };
      this.currentMode = settings.layerMode || 'smart';

      // Hidden tabs do no layout work; the scan runs once the tab is shown again
      if (document.hidden) {
        this.pendingApply = true;
        return;
      }
      this.pendingApply = false;

      if (!soft || this.currentMode !== 'smart') {
        this.restorePageBackgrounds();
        this.smartBackdropColor = 'transparent';
        this.backdrop.style.backgroundColor = 'transparent';
        this.refreshInterval = 900;
        this.lastScanSig = '';
      }

      if (this.currentMode === 'ambient-top') {
        // Drawn over the page, so there is always room: never paused
        this.setHostLayer('top');
        this.setPaused(false);
        this.emitLayout(null, 1);
      } else {
        // Behind page elements ('smart' or 'strict-behind')
        this.setHostLayer('behind');
        if (this.currentMode === 'smart') {
          this.applySmartBackground(soft);
        } else {
          this.measureAndEmit();
        }
      }
      this.applyOpacity(settings);
    }

    // Strict-behind: the page is left untouched, just measure how much of the pond shows through
    measureAndEmit() {
      const vw = viewportWidth();
      const vh = viewportHeight();
      if (vw < 100 || vh < 100) return;
      const clearMap = this.buildClearMap(vw, vh);
      const paused = this.shouldPause(clearMap.visibleRatio);
      this.setPaused(paused);
      this.emitLayout(paused ? null : clearMap, clearMap.visibleRatio);
    }

    // origBg: the element's computed background before we touched it (read during the scan phase)
    saveAndSetBackground(el, newBgValue, origBg) {
      if (!el || !el.style) return;
      let entry = this.modifiedElements.get(el);
      if (!entry) {
        entry = {
          value: el.style.getPropertyValue('background-color'),
          priority: el.style.getPropertyPriority('background-color'),
          origBg,
          applied: null,
        };
        this.modifiedElements.set(el, entry);
      }
      if (entry.applied !== newBgValue) {
        el.style.setProperty('background-color', newBgValue, 'important');
        entry.applied = newBgValue;
      }
    }

    restoreElementBackground(el, prev) {
      if (!el || !el.style) return;
      if (prev.value) {
        el.style.setProperty('background-color', prev.value, prev.priority || '');
      } else {
        el.style.removeProperty('background-color');
      }
    }

    restorePageBackgrounds() {
      for (const [el, prev] of this.modifiedElements.entries()) {
        this.restoreElementBackground(el, prev);
      }
      this.modifiedElements.clear();
    }

    // Applies the planned overrides, writing only the difference from what is already in place
    commitBackgroundWrites(plannedWrites, pendingBackdrop) {
      this.smartBackdropColor = pendingBackdrop || 'transparent';
      if (this.backdrop.style.backgroundColor !== this.smartBackdropColor) {
        this.backdrop.style.backgroundColor = this.smartBackdropColor;
      }
      const wanted = new Set();
      for (let i = 0; i < plannedWrites.length; i++) {
        wanted.add(plannedWrites[i].el);
      }
      for (const [el, prev] of this.modifiedElements) {
        if (!wanted.has(el)) {
          this.restoreElementBackground(el, prev);
          this.modifiedElements.delete(el);
        }
      }
      for (let i = 0; i < plannedWrites.length; i++) {
        this.saveAndSetBackground(plannedWrites[i].el, plannedWrites[i].bg, plannedWrites[i].orig);
      }
    }

    applySmartBackground(soft = false) {
      const body = document.body;
      const docEl = document.documentElement;
      if (!body || !docEl) return;

      const vw = viewportWidth();
      const vh = viewportHeight();
      if (vw < 100 || vh < 100) return;

      this.lastScanAt = Date.now();

      // --- PHASE 1: READ-ONLY DOM & STYLE SCAN (zero interleaved style writes) ---
      const htmlStyle = getComputedStyle(docEl);
      const bodyStyle = getComputedStyle(body);
      const htmlColor = parseCssColor(htmlStyle.backgroundColor);
      // Elements still carrying our override report their remembered original color instead
      const origBgOf = (el, cs) => {
        const entry = this.modifiedElements.get(el);
        return entry && entry.origBg ? entry.origBg : cs.backgroundColor;
      };
      const bodyBgStr = origBgOf(body, bodyStyle);
      const bodyColor = parseCssColor(bodyBgStr);
      const htmlHasBgImage = Boolean(htmlStyle.backgroundImage && htmlStyle.backgroundImage !== 'none');
      const bodyHasBgImage = Boolean(bodyStyle.backgroundImage && bodyStyle.backgroundImage !== 'none');
      const htmlHasBg = (htmlColor && htmlColor.a > 0.05) || htmlHasBgImage;
      const hasRootBgImage = htmlHasBgImage || bodyHasBgImage;

      let baseColor = null;
      if (bodyColor && bodyColor.a > 0.1) {
        baseColor = bodyColor;
      } else if (htmlColor && htmlColor.a > 0.1) {
        baseColor = htmlColor;
      }

      let pendingBackdrop = null;
      const plannedWrites = [];

      if (htmlHasBg && !bodyHasBgImage && bodyColor && bodyColor.a > 0.1) {
        pendingBackdrop = `rgba(${bodyColor.r}, ${bodyColor.g}, ${bodyColor.b}, ${bodyColor.a})`;
        plannedWrites.push({ el: body, bg: 'transparent', orig: bodyBgStr });
      }

      const queue = [];
      for (let i = 0; i < body.children.length; i++) {
        queue.push({ el: body.children[i], depth: 1 });
      }

      const cardsToSolidify = [];
      let qHead = 0;
      const scrollY = window.scrollY || 0;

      while (qHead < queue.length && qHead < MAX_SCAN_NODES) {
        const { el, depth } = queue[qHead++];

        if (el === this.host || isScanExcluded(el)) continue;

        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;

        const isTransparentWrapper = cs.display === 'contents' || cs.display === 'inline';
        const rect = el.getBoundingClientRect();

        if (!isTransparentWrapper) {
          if (rect.height > 0 && (rect.bottom < -120 || rect.top > vh + 600)) {
            continue;
          }

          if (rect.width < 120 || rect.height < 56) {
            const clipped =
              (cs.overflowY === 'hidden' || cs.overflowY === 'clip') &&
              rect.height > 0 &&
              rect.height < 56;
            if (!clipped && el.childElementCount > 0 && depth < MAX_SCAN_DEPTH) {
              for (let i = 0; i < el.children.length; i++) {
                queue.push({ el: el.children[i], depth: depth + 1 });
              }
            }
            continue;
          }

          if (isToolbarOrSidebar(rect, cs, vw, vh, scrollY)) continue;

          // Only hoist matching outer workspace shells onto opaque backdrop when no image wallpaper is behind them;
          // never turn contrasting reading columns or patterned pages semi-transparent.
          const bgStr = origBgOf(el, cs);
          const scrim = isScrim(rect, parseCssColor(bgStr), vw, vh);
          if (!hasRootBgImage && !scrim && isWorkspaceOrShell(el, rect, cs, vw, vh, bgStr)) {
            const shellCol = parseCssColor(bgStr);
            if (!baseColor) {
              baseColor = shellCol;
              pendingBackdrop = `rgb(${shellCol.r}, ${shellCol.g}, ${shellCol.b})`;
            }
            if (isCompatibleBackdrop(shellCol, baseColor)) {
              pendingBackdrop = `rgb(${shellCol.r}, ${shellCol.g}, ${shellCol.b})`;
              plannedWrites.push({ el, bg: 'transparent', orig: bgStr });
            }
          } else if (isBoundedTransparentCard(el, rect, cs, vw, vh, bgStr)) {
            cardsToSolidify.push({ el, orig: bgStr });
            continue;
          }
        }

        if (depth < MAX_SCAN_DEPTH) {
          for (let i = 0; i < el.children.length; i++) {
            queue.push({ el: el.children[i], depth: depth + 1 });
          }
        }
      }

      if (cardsToSolidify.length > 0) {
        let cardCol = baseColor;
        if (!cardCol) {
          const textCol = parseCssColor(bodyStyle.color);
          const textLum = textCol ? colorLuminance(textCol) : 0;
          cardCol = textLum >= 128 ? { r: 22, g: 27, b: 34 } : { r: 255, g: 255, b: 255 };
        }
        const cardBg = `rgb(${cardCol.r}, ${cardCol.g}, ${cardCol.b})`;
        for (let i = 0; i < cardsToSolidify.length; i++) {
          plannedWrites.push({ el: cardsToSolidify[i].el, bg: cardBg, orig: cardsToSolidify[i].orig });
        }
      }

      // --- PHASE 2: BATCHED STYLE WRITES ---
      this.commitBackgroundWrites(plannedWrites, pendingBackdrop);

      // --- PHASE 3: CLEAR-ZONE VISIBILITY GRID & VERIFICATION ---
      const clearMap = this.buildClearMap(vw, vh);
      const paused = this.shouldPause(clearMap.visibleRatio);

      // Back off while repeated mutation-driven scans keep producing the same result
      const sig = `${this.smartBackdropColor}|${plannedWrites.length}|${paused}|${clearMap.visibleRatio.toFixed(2)}`;
      this.refreshInterval = soft && sig === this.lastScanSig ? Math.min(4000, this.refreshInterval * 2) : 900;
      this.lastScanSig = sig;

      if (paused) {
        // Too little open water even with our overrides: give the page back untouched and hide
        this.restorePageBackgrounds();
        this.smartBackdropColor = 'transparent';
        this.backdrop.style.backgroundColor = 'transparent';
      }
      this.setPaused(paused);
      this.emitLayout(paused ? null : clearMap, clearMap.visibleRatio);
    }

    buildClearMap(vw, vh) {
      const cols = CLEAR_GRID_COLS;
      const rows = CLEAR_GRID_ROWS;
      const cells = new Float32Array(cols * rows);
      if (!document.elementsFromPoint || vw < 60 || vh < 60) {
        cells.fill(1);
        return { cols, rows, cells, visibleRatio: 1 };
      }

      const docEl = document.documentElement;
      const body = document.body;
      const htmlStyle = getComputedStyle(docEl);
      const htmlColor = parseCssColor(htmlStyle.backgroundColor);
      const htmlHasBg =
        (htmlColor && htmlColor.a > 0.05) ||
        Boolean(htmlStyle.backgroundImage && htmlStyle.backgroundImage !== 'none');

      // Per-scan cache avoids repeating getComputedStyle & color parsing across 96 points
      const metaCache = new Map();
      const getElMeta = (el) => {
        let meta = metaCache.get(el);
        if (meta) return meta;
        const cs = getComputedStyle(el);
        const col = parseCssColor(cs.backgroundColor);
        const hasBgImage = Boolean(cs.backgroundImage && cs.backgroundImage !== 'none');
        const bgAlpha = col ? Math.min(1, col.a) : 0;
        let isLargeMedia = false;
        if (MEDIA_BLOCK_TAGS.has(el.tagName)) {
          if (el.tagName === 'IMG' || el.tagName === 'SVG') {
            const r = el.getBoundingClientRect();
            isLargeMedia = r.width >= 24 && r.height >= 24;
          } else {
            isLargeMedia = true;
          }
        }
        meta = {
          hasBgImage,
          bgAlpha,
          isLargeMedia,
          isTextBlock: TEXT_BLOCK_TAGS.has(el.tagName),
          isScrim:
            !hasBgImage &&
            !isLargeMedia &&
            bgAlpha > 0.05 &&
            bgAlpha < SCRIM_MAX_ALPHA &&
            isScrim(el.getBoundingClientRect(), col, vw, vh),
        };
        metaCache.set(el, meta);
        return meta;
      };

      // A native modal <dialog> makes the rest of the page inert, so hit testing only ever returns
      // the dialog (even on its ::backdrop). Outside the dialog box the page is unchanged underneath,
      // so reuse the openness measured before the dialog opened.
      const modal = findModalDialog();
      const modalRect = modal ? modal.getBoundingClientRect() : null;
      const remembered =
        modal && this.preModalCells && this.preModalCells.length === cells.length ? this.preModalCells : null;

      let visibleCells = 0;
      for (let row = 0; row < rows; row++) {
        const py = Math.min(vh - 2, Math.max(1, Math.floor(((row + 0.5) / rows) * vh)));
        for (let col = 0; col < cols; col++) {
          const px = Math.min(vw - 2, Math.max(1, Math.floor(((col + 0.5) / cols) * vw)));
          if (
            modalRect &&
            (px < modalRect.left || px > modalRect.right || py < modalRect.top || py > modalRect.bottom)
          ) {
            const kept = remembered ? remembered[row * cols + col] : 1;
            cells[row * cols + col] = kept;
            if (kept >= 0.5) visibleCells++;
            continue;
          }
          const stack = document.elementsFromPoint(px, py);
          let transmittance = 1.0;
          let textPenalty = 1.0;

          for (let i = 0; i < stack.length; i++) {
            // The pond host never shows up here: it is pointer-events: none, so hit testing skips it
            const el = stack[i];
            if (el === docEl) break;
            if (el === body && !htmlHasBg) continue;

            const meta = getElMeta(el);
            // Fish keep swimming under a modal's dimming layer: it tints the pond, it does not hide it
            if (meta.isScrim) continue;
            if (meta.isLargeMedia || meta.hasBgImage) {
              transmittance = 0;
              break;
            }
            if (meta.bgAlpha > 0.05) {
              transmittance *= 1 - meta.bgAlpha;
              if (transmittance < 0.35) {
                transmittance = 0;
                break;
              }
            }
            if (meta.isTextBlock) {
              textPenalty = Math.min(textPenalty, 0.25);
            }
          }

          const openness = transmittance < 0.35 ? 0 : Math.min(transmittance, textPenalty);
          cells[row * cols + col] = openness;
          if (openness >= 0.5) visibleCells++;
        }
      }

      if (!modal) this.preModalCells = cells;

      return {
        cols,
        rows,
        cells,
        visibleRatio: visibleCells / (cols * rows),
      };
    }

    refreshClearMap() {
      if (!this.host || !this.host.isConnected || this.currentMode === 'ambient-top') return;
      if (document.hidden) {
        this.pendingApply = true;
        return;
      }
      if (this.currentMode !== 'smart') {
        this.measureAndEmit();
        return;
      }
      // While paused our overrides are off, so a plain measurement would understate the open
      // area; only a full scan can tell whether the pond fits again.
      if (this.isPaused) {
        this.scheduleSmartRefresh();
        return;
      }
      const vw = viewportWidth();
      const vh = viewportHeight();
      if (vw < 100 || vh < 100) return;

      const clearMap = this.buildClearMap(vw, vh);
      if (this.shouldPause(clearMap.visibleRatio)) {
        this.applySettings(this.lastSettings);
        return;
      }
      this.emitLayout(clearMap, clearMap.visibleRatio);
    }

    scheduleClearMapRefresh() {
      if (this.currentMode === 'ambient-top') return;
      // Debounce: rebuild once after scrolling settles instead of hit-testing 160 points mid-scroll
      if (this.scrollTimer) clearTimeout(this.scrollTimer);
      this.scrollTimer = setTimeout(() => {
        this.scrollTimer = null;
        this.refreshClearMap();
      }, 160);
    }

    // hard = page colors may have changed (theme switch, navigation): restore and re-read everything
    scheduleSmartRefresh(hard = false) {
      if (this.currentMode !== 'smart') return;
      if (hard && !this.pendingHard && this.refreshTimer) {
        // Do not let a theme change wait behind a backed-off soft refresh
        clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
      }
      if (hard) this.pendingHard = true;
      if (this.refreshTimer) return;

      const elapsed = Date.now() - this.lastScanAt;
      const minGap = this.pendingHard ? 900 : this.refreshInterval;
      const delay = elapsed < minGap ? minGap - elapsed : 300;
      this.refreshTimer = setTimeout(() => {
        const run = () => {
          this.refreshTimer = null;
          const soft = !this.pendingHard;
          this.pendingHard = false;
          if (this.host && this.host.isConnected && this.currentMode === 'smart') {
            this.applySettings(this.lastSettings, soft);
          }
        };
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(run, { timeout: 600 });
        } else {
          run();
        }
      }, delay);
    }

    isSignificantNode(node) {
      if (!node || node.nodeType !== 1 || node === this.host) return false;
      if (node.ownerSVGElement || IGNORE_MUTATION_TAGS.has(node.tagName)) return false;
      return true;
    }

    startObserver() {
      if (this.observer || !document.body) return;
      this.observer = new MutationObserver((mutations) => {
        if (this.currentMode !== 'smart') return;
        for (let i = 0; i < mutations.length; i++) {
          const m = mutations[i];
          if (m.target === this.host) continue;
          if (m.target && (m.target.ownerSVGElement || IGNORE_MUTATION_TAGS.has(m.target.tagName))) {
            continue;
          }
          for (let j = 0; j < m.addedNodes.length; j++) {
            if (this.isSignificantNode(m.addedNodes[j])) {
              this.scheduleSmartRefresh();
              return;
            }
          }
          for (let j = 0; j < m.removedNodes.length; j++) {
            if (this.isSignificantNode(m.removedNodes[j])) {
              this.scheduleSmartRefresh();
              return;
            }
          }
        }
      });

      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
      });

      // Lightweight observer for site dark/light theme toggles via class or data-theme attributes
      this.themeObserver = new MutationObserver(() => {
        if (this.currentMode === 'smart') {
          this.scheduleSmartRefresh(true);
        }
      });
      const attrOpts = {
        attributes: true,
        attributeFilter: ['class', 'data-theme', 'data-color-mode', 'data-bs-theme'],
      };
      this.themeObserver.observe(document.documentElement, attrOpts);
      this.themeObserver.observe(document.body, attrOpts);

      document.addEventListener('turbo:load', this.onAsyncLoad);
      document.addEventListener('turbo:frame-load', this.onAsyncLoad);
      window.addEventListener('popstate', this.onAsyncLoad);
      document.addEventListener('visibilitychange', this.onVisibility);
      // Capture phase: scroll does not bubble, so inner scroll containers are only visible this way
      window.addEventListener('scroll', this.onScroll, { passive: true, capture: true });
    }

    unmount() {
      if (this.observer) {
        this.observer.disconnect();
        this.observer = null;
      }
      if (this.themeObserver) {
        this.themeObserver.disconnect();
        this.themeObserver = null;
      }
      document.removeEventListener('turbo:load', this.onAsyncLoad);
      document.removeEventListener('turbo:frame-load', this.onAsyncLoad);
      window.removeEventListener('popstate', this.onAsyncLoad);
      document.removeEventListener('visibilitychange', this.onVisibility);
      this.pendingApply = false;
      this.pendingHard = false;
      window.removeEventListener('scroll', this.onScroll, { capture: true });

      if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
      }
      if (this.scrollTimer) {
        clearTimeout(this.scrollTimer);
        this.scrollTimer = null;
      }
      this.lastClearMap = null;
      this.lastVisibleRatio = 1;
      this.preModalCells = null;
      this.isPaused = false;
      this.restorePageBackgrounds();
      if (this.host && this.host.parentNode) {
        this.host.parentNode.removeChild(this.host);
      }
      this.host = null;
      this.backdrop = null;
      this.canvas = null;
      this.ctx = null;
    }
  }

  KoiPond.LayerManager = LayerManager;
  KoiPond.parseCssColor = parseCssColor;
  KoiPond.colorLuminance = colorLuminance;
  KoiPond.viewportWidth = viewportWidth;
  KoiPond.viewportHeight = viewportHeight;
  KoiPond.isBoundedTransparentCard = isBoundedTransparentCard;
  KoiPond.isWorkspaceOrShell = isWorkspaceOrShell;
  KoiPond.isCompatibleBackdrop = isCompatibleBackdrop;
  KoiPond.isScrim = isScrim;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      LayerManager,
      parseCssColor,
      isBoundedTransparentCard,
      isWorkspaceOrShell,
      isCompatibleBackdrop,
      isScrim,
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
