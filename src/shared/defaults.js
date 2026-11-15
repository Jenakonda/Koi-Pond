(function (root) {
  'use strict';

  const KoiPond = (root.KoiPond = root.KoiPond || {});

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    fishCount: 7,
    speed: 1.0,
    pixelScale: 3,
    opacity: 0.9,
    layerMode: 'smart', // 'smart' | 'strict-behind' | 'ambient-top'
    cursorMode: 'feed', // 'feed' | 'scatter' | 'none'
    fpsMode: 'auto', // 'auto' (60, or 30 when saving power) | '60' | '30'
    ripples: true,
    language: 'auto', // control panel language: 'auto' (browser) | 'en' | 'uk'
    siteMode: 'blacklist', // 'blacklist' = everywhere except the list | 'whitelist' = only on the list
    blacklist: [],
    whitelist: [],
  });

  const MAX_SITE_ENTRIES = 200;
  const FULL_SPACE_RATIO = 0.5; // share of open viewport at which the full fish count is shown

  // Rich pixel-art color palettes & texture patterns inspired by traditional Chinese/Japanese pond koi.
  // Each RGB color is [R, G, B], fin colors are [R, G, B, A].
  const KOI_VARIETIES = Object.freeze([
    {
      id: 'kohaku',
      name: 'Кохаку',
      weight: 16,
      base: [246, 242, 232],
      baseHighlight: [255, 254, 250],
      baseShadow: [198, 192, 182],
      outline: [48, 44, 52],
      fin: [240, 234, 224, 190],
      finHighlight: [255, 252, 246, 220],
      patchA: [228, 68, 42],
      patchAHighlight: [248, 108, 66],
      patchAShadow: [176, 40, 26],
      patchB: null,
      eye: [24, 22, 28],
      pattern: 'patches',
    },
    {
      id: 'inazuma',
      name: 'Іназума Кохаку',
      weight: 10,
      base: [248, 245, 238],
      baseHighlight: [255, 255, 252],
      baseShadow: [200, 196, 188],
      outline: [46, 42, 50],
      fin: [242, 238, 230, 190],
      finHighlight: [255, 253, 248, 225],
      patchA: [224, 54, 38],
      patchAHighlight: [248, 92, 64],
      patchAShadow: [170, 32, 22],
      patchB: null,
      eye: [24, 22, 28],
      pattern: 'zigzag',
    },
    {
      id: 'sanke',
      name: 'Тайшо Санке',
      weight: 14,
      base: [244, 239, 229],
      baseHighlight: [255, 253, 247],
      baseShadow: [196, 190, 180],
      outline: [42, 40, 48],
      fin: [236, 230, 220, 185],
      finHighlight: [255, 250, 242, 215],
      patchA: [226, 70, 40],
      patchAHighlight: [246, 108, 66],
      patchAShadow: [172, 42, 24],
      patchB: [34, 34, 42],
      patchBHighlight: [60, 62, 74],
      patchBShadow: [18, 18, 24],
      eye: [20, 18, 24],
      pattern: 'sanke',
    },
    {
      id: 'showa',
      name: 'Шова',
      weight: 12,
      base: [42, 42, 50],
      baseHighlight: [68, 70, 82],
      baseShadow: [24, 24, 30],
      outline: [18, 18, 24],
      fin: [232, 226, 216, 185],
      finHighlight: [248, 244, 236, 215],
      patchA: [228, 66, 38],
      patchAHighlight: [248, 102, 62],
      patchAShadow: [170, 38, 22],
      patchB: [242, 238, 228],
      patchBHighlight: [255, 253, 248],
      patchBShadow: [188, 184, 174],
      eye: [224, 188, 92],
      pattern: 'bands',
      motoguro: true,
    },
    {
      id: 'yamabuki',
      name: 'Ямабукі Огон',
      weight: 10,
      base: [242, 184, 48],
      baseHighlight: [255, 226, 112],
      baseShadow: [184, 126, 22],
      outline: [64, 44, 18],
      fin: [248, 206, 98, 195],
      finHighlight: [255, 236, 152, 225],
      patchA: [252, 212, 82],
      patchAHighlight: [255, 240, 148],
      patchAShadow: [204, 146, 32],
      patchB: null,
      eye: [26, 22, 20],
      pattern: 'scales',
    },
    {
      id: 'platinum',
      name: 'Платінум Огон',
      weight: 8,
      base: [224, 232, 238],
      baseHighlight: [252, 254, 255],
      baseShadow: [164, 178, 192],
      outline: [54, 66, 80],
      fin: [236, 242, 248, 195],
      finHighlight: [255, 255, 255, 230],
      patchA: [240, 246, 252],
      patchAHighlight: [255, 255, 255],
      patchAShadow: [186, 198, 212],
      patchB: null,
      eye: [24, 28, 36],
      pattern: 'scales',
    },
    {
      id: 'tancho',
      name: 'Танчо',
      weight: 8,
      base: [248, 246, 240],
      baseHighlight: [255, 255, 254],
      baseShadow: [204, 202, 198],
      outline: [52, 54, 64],
      fin: [244, 242, 238, 190],
      finHighlight: [255, 255, 255, 225],
      patchA: [230, 56, 42],
      patchAHighlight: [250, 96, 74],
      patchAShadow: [178, 32, 26],
      patchB: null,
      eye: [24, 22, 28],
      pattern: 'tancho',
    },
    {
      id: 'asagi',
      name: 'Асагі',
      weight: 9,
      base: [96, 134, 168],
      baseHighlight: [148, 188, 218],
      baseShadow: [58, 88, 118],
      outline: [30, 44, 62],
      fin: [240, 128, 66, 195],
      finHighlight: [252, 172, 112, 225],
      patchA: [234, 108, 52],
      patchAHighlight: [250, 148, 86],
      patchAShadow: [178, 74, 34],
      patchB: null,
      eye: [22, 24, 30],
      pattern: 'asagi',
    },
    {
      id: 'shusui',
      name: 'Шусуй',
      weight: 9,
      base: [122, 174, 212],
      baseHighlight: [176, 218, 244],
      baseShadow: [78, 122, 158],
      outline: [28, 44, 64],
      fin: [236, 98, 58, 195],
      finHighlight: [252, 146, 98, 225],
      patchA: [228, 74, 46],
      patchAHighlight: [248, 114, 76],
      patchAShadow: [174, 44, 28],
      patchB: [34, 54, 88],
      patchBHighlight: [56, 84, 128],
      patchBShadow: [20, 34, 58],
      eye: [20, 22, 30],
      pattern: 'shusui',
    },
    {
      id: 'kujaku',
      name: 'Куджаку',
      weight: 9,
      base: [238, 236, 230],
      baseHighlight: [254, 254, 250],
      baseShadow: [178, 178, 176],
      outline: [44, 44, 52],
      fin: [242, 238, 230, 190],
      finHighlight: [255, 254, 248, 225],
      patchA: [242, 118, 44],
      patchAHighlight: [255, 164, 78],
      patchAShadow: [188, 76, 24],
      patchB: [58, 62, 74],
      patchBHighlight: [92, 98, 114],
      patchBShadow: [34, 36, 46],
      eye: [22, 22, 28],
      pattern: 'kujaku',
    },
    {
      id: 'goromo',
      name: 'Ай-Горомо',
      weight: 8,
      base: [246, 244, 238],
      baseHighlight: [255, 255, 252],
      baseShadow: [198, 196, 190],
      outline: [42, 42, 56],
      fin: [242, 240, 234, 190],
      finHighlight: [255, 255, 252, 225],
      patchA: [216, 56, 44],
      patchAHighlight: [240, 92, 70],
      patchAShadow: [164, 34, 28],
      patchB: [58, 56, 98],
      patchBHighlight: [86, 84, 134],
      patchBShadow: [36, 34, 68],
      eye: [22, 20, 28],
      pattern: 'goromo',
    },
    {
      id: 'hi-utsuri',
      name: 'Хі Уцурі',
      weight: 8,
      base: [34, 34, 40],
      baseHighlight: [60, 62, 72],
      baseShadow: [18, 18, 22],
      outline: [14, 14, 18],
      fin: [232, 102, 44, 185],
      finHighlight: [250, 146, 76, 215],
      patchA: [236, 94, 36],
      patchAHighlight: [254, 138, 68],
      patchAShadow: [176, 56, 20],
      patchB: null,
      eye: [234, 178, 72],
      pattern: 'utsuri',
      motoguro: true,
    },
    {
      id: 'ki-utsuri',
      name: 'Кі Уцурі',
      weight: 7,
      base: [32, 34, 40],
      baseHighlight: [58, 60, 70],
      baseShadow: [16, 18, 22],
      outline: [14, 14, 18],
      fin: [244, 204, 72, 190],
      finHighlight: [255, 232, 128, 220],
      patchA: [244, 198, 48],
      patchAHighlight: [255, 230, 98],
      patchAShadow: [184, 138, 24],
      patchB: null,
      eye: [236, 210, 96],
      pattern: 'utsuri',
      motoguro: true,
    },
    {
      id: 'ochiba',
      name: 'Очіба Шігуре',
      weight: 8,
      base: [148, 162, 172],
      baseHighlight: [184, 198, 208],
      baseShadow: [104, 118, 128],
      outline: [42, 48, 56],
      fin: [192, 188, 178, 185],
      finHighlight: [224, 218, 206, 215],
      patchA: [194, 114, 58],
      patchAHighlight: [224, 148, 86],
      patchAShadow: [142, 76, 36],
      patchB: null,
      eye: [22, 22, 26],
      pattern: 'ochiba',
    },
    {
      id: 'shubunkin',
      name: 'Шубункін (Каліко)',
      weight: 9,
      base: [204, 222, 234],
      baseHighlight: [238, 248, 254],
      baseShadow: [152, 172, 188],
      outline: [44, 52, 64],
      fin: [232, 238, 242, 185],
      finHighlight: [252, 254, 255, 220],
      patchA: [236, 108, 42],
      patchAHighlight: [254, 150, 74],
      patchAShadow: [180, 68, 24],
      patchB: [38, 42, 54],
      patchBHighlight: [68, 74, 92],
      patchBShadow: [22, 24, 32],
      eye: [20, 20, 26],
      pattern: 'calico',
    },
  ]);

  // Turns user input (a host, a pasted URL, "*.site.com") into a bare lowercase hostname without "www.".
  // Returns '' when it is not a usable host.
  function normalizeHostEntry(input) {
    if (typeof input !== 'string') return '';
    let s = input.trim().toLowerCase();
    if (!s) return '';
    if (s === 'local-file') return s; // key used for file:// pages
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\*\./, '');
    s = s.split(/[/?#]/)[0];
    if (!s || /\s/.test(s)) return '';
    try {
      s = new URL(`http://${s}`).hostname; // validates, drops port/userinfo, punycodes IDN
    } catch (_) {
      return '';
    }
    s = s.replace(/^www\./, '').replace(/\.$/, '');
    return s.length > 0 && s.length <= 253 ? s : '';
  }

  // An entry covers its own host and every subdomain: "google.com" matches "drive.google.com"
  function hostMatches(list, hostname) {
    const host = normalizeHostEntry(hostname);
    if (!host || !Array.isArray(list)) return false;
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (host === entry || host.endsWith(`.${entry}`)) return true;
    }
    return false;
  }

  function isSiteAllowed(settings, hostname) {
    if (settings && settings.siteMode === 'whitelist') {
      return hostMatches(settings.whitelist, hostname);
    }
    return !hostMatches(settings && settings.blacklist, hostname);
  }

  // Fewer fish when little of the viewport is open water, so they do not crowd into narrow gaps
  function fishCountForSpace(fishCount, visibleRatio) {
    if (!(visibleRatio < FULL_SPACE_RATIO)) return fishCount;
    return Math.max(1, Math.round((fishCount * visibleRatio) / FULL_SPACE_RATIO));
  }

  function sanitizeHostList(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (let i = 0; i < list.length && out.length < MAX_SITE_ENTRIES; i++) {
      const host = normalizeHostEntry(list[i]);
      if (host && !seen.has(host)) {
        seen.add(host);
        out.push(host);
      }
    }
    return out;
  }

  function sanitizeSettings(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const clamp = (v, min, max, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };
    const validLayers = ['smart', 'strict-behind', 'ambient-top'];
    const validCursors = ['feed', 'scatter', 'none'];
    const validFps = ['auto', '60', '30'];

    return {
      enabled: typeof src.enabled === 'boolean' ? src.enabled : DEFAULT_SETTINGS.enabled,
      fishCount: Math.round(clamp(src.fishCount, 1, 20, DEFAULT_SETTINGS.fishCount)),
      speed: Number(clamp(src.speed, 0.4, 2.2, DEFAULT_SETTINGS.speed).toFixed(2)),
      pixelScale: Math.round(clamp(src.pixelScale, 2, 4, DEFAULT_SETTINGS.pixelScale)),
      opacity: Number(clamp(src.opacity, 0.25, 1.0, DEFAULT_SETTINGS.opacity).toFixed(2)),
      layerMode: validLayers.includes(src.layerMode) ? src.layerMode : DEFAULT_SETTINGS.layerMode,
      cursorMode: validCursors.includes(src.cursorMode) ? src.cursorMode : DEFAULT_SETTINGS.cursorMode,
      fpsMode: validFps.includes(src.fpsMode) ? src.fpsMode : DEFAULT_SETTINGS.fpsMode,
      ripples: typeof src.ripples === 'boolean' ? src.ripples : DEFAULT_SETTINGS.ripples,
      language: ['en', 'uk'].includes(src.language) ? src.language : 'auto',
      siteMode: src.siteMode === 'whitelist' ? 'whitelist' : 'blacklist',
      // disabledHosts is the pre-list format: it becomes the blacklist when no blacklist is given
      blacklist: sanitizeHostList(Array.isArray(src.blacklist) ? src.blacklist : src.disabledHosts),
      whitelist: sanitizeHostList(src.whitelist),
    };
  }

  KoiPond.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  KoiPond.KOI_VARIETIES = KOI_VARIETIES;
  KoiPond.sanitizeSettings = sanitizeSettings;
  KoiPond.normalizeHostEntry = normalizeHostEntry;
  KoiPond.hostMatches = hostMatches;
  KoiPond.isSiteAllowed = isSiteAllowed;
  KoiPond.fishCountForSpace = fishCountForSpace;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      DEFAULT_SETTINGS,
      KOI_VARIETIES,
      sanitizeSettings,
      normalizeHostEntry,
      hostMatches,
      isSiteAllowed,
      fishCountForSpace,
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
