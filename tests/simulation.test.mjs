import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_SETTINGS,
  KOI_VARIETIES,
  sanitizeSettings,
  normalizeHostEntry,
  hostMatches,
  isSiteAllowed,
  fishCountForSpace,
} = require('../src/shared/defaults.js');
const {
  parseCssColor,
  isBoundedTransparentCard,
  isWorkspaceOrShell,
  isCompatibleBackdrop,
  isScrim,
} = require('../src/content/layer-manager.js');
const { KoiRenderer, koiHalfWidth, evaluateKoiPattern, buildPatternLut } = require('../src/content/koi-renderer.js');
const { PondSimulation, wrapAngle } = require('../src/content/pond-simulation.js');

test('sanitizeSettings clamps bounds and preserves valid options', () => {
  const clean = sanitizeSettings({
    enabled: false,
    fishCount: 99,
    speed: 0.1,
    pixelScale: 10,
    opacity: 0.01,
    layerMode: 'invalid',
    cursorMode: 'scatter',
    fpsMode: '30',
    ripples: false,
    disabledHosts: ['example.com', 'example.com', '', 123],
  });

  assert.equal(clean.enabled, false);
  assert.equal(clean.fishCount, 20);
  assert.equal(clean.speed, 0.4);
  assert.equal(clean.pixelScale, 4);
  assert.equal(clean.opacity, 0.25);
  assert.equal(clean.layerMode, 'smart');
  assert.equal(clean.cursorMode, 'scatter');
  assert.equal(clean.fpsMode, '30');
  assert.equal(sanitizeSettings({ fpsMode: '144' }).fpsMode, 'auto');
  assert.equal(clean.ripples, false);
  // Legacy disabledHosts becomes the blacklist; duplicates and junk are dropped
  assert.deepEqual(clean.blacklist, ['example.com']);
  assert.deepEqual(clean.whitelist, []);
  assert.equal(clean.siteMode, 'blacklist');
  assert.equal('disabledHosts' in clean, false);
  assert.equal(isSiteAllowed(clean, 'example.com'), false);
  assert.equal(isSiteAllowed(clean, 'other.com'), true);

  // An explicit blacklist wins over the legacy key
  assert.deepEqual(sanitizeSettings({ blacklist: ['a.com'], disabledHosts: ['b.com'] }).blacklist, ['a.com']);
  assert.equal(sanitizeSettings({ siteMode: 'nonsense' }).siteMode, 'blacklist');
});

test('normalizeHostEntry accepts hosts, URLs and wildcards and rejects junk', () => {
  assert.equal(normalizeHostEntry('Example.COM'), 'example.com');
  assert.equal(normalizeHostEntry('  https://www.Example.com:8080/path?q=1#x  '), 'example.com');
  assert.equal(normalizeHostEntry('*.google.com'), 'google.com');
  assert.equal(normalizeHostEntry('drive.google.com/drive/u/0'), 'drive.google.com');
  assert.equal(normalizeHostEntry('localhost:3000'), 'localhost');
  assert.equal(normalizeHostEntry('local-file'), 'local-file');
  assert.equal(normalizeHostEntry(''), '');
  assert.equal(normalizeHostEntry('not a site'), '');
  assert.equal(normalizeHostEntry(42), '');
});

test('site lists: entries cover subdomains, whitelist and blacklist modes', () => {
  assert.equal(hostMatches(['google.com'], 'drive.google.com'), true);
  assert.equal(hostMatches(['google.com'], 'www.google.com'), true);
  assert.equal(hostMatches(['google.com'], 'notgoogle.com'), false);
  assert.equal(hostMatches(['drive.google.com'], 'google.com'), false);
  assert.equal(hostMatches([], 'google.com'), false);

  const black = sanitizeSettings({ siteMode: 'blacklist', blacklist: ['google.com'], whitelist: ['github.com'] });
  assert.equal(isSiteAllowed(black, 'drive.google.com'), false);
  assert.equal(isSiteAllowed(black, 'github.com'), true);
  assert.equal(isSiteAllowed(black, ''), true);

  const white = sanitizeSettings({ siteMode: 'whitelist', blacklist: ['google.com'], whitelist: ['github.com'] });
  assert.equal(isSiteAllowed(white, 'gist.github.com'), true);
  assert.equal(isSiteAllowed(white, 'drive.google.com'), false);
  assert.equal(isSiteAllowed(white, 'example.com'), false);

  // Empty whitelist: the pond runs nowhere
  assert.equal(isSiteAllowed(sanitizeSettings({ siteMode: 'whitelist' }), 'example.com'), false);

  // Lists are capped
  const many = Array.from({ length: 500 }, (_, i) => `site${i}.com`);
  assert.equal(sanitizeSettings({ blacklist: many }).blacklist.length, 200);
});

test('fishCountForSpace scales the school down when little of the page is open', () => {
  assert.equal(fishCountForSpace(7, 1), 7);
  assert.equal(fishCountForSpace(7, 0.5), 7);
  assert.equal(fishCountForSpace(7, 0.25), 4);
  assert.equal(fishCountForSpace(7, 0.15), 2);
  assert.equal(fishCountForSpace(7, 0.01), 1);
  assert.equal(fishCountForSpace(20, 0.3), 12);
});

test('syncFishCount lets go of hidden fish before visible ones', () => {
  const sim = new PondSimulation(400, 300, KOI_VARIETIES);
  const cols = 16;
  const rows = 10;
  const cells = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells[r * cols + c] = c >= 8 ? 1 : 0; // left half covered, right half open
    }
  }
  sim.setClearMap({ cols, rows, cells, visibleRatio: 0.5 });
  sim.syncFishCount(6);
  // Park three fish deep under cover and three in open water
  sim.fish.forEach((f, i) => {
    f.x = i < 3 ? 60 : 340;
    f.y = 150;
    f.tag = i < 3 ? 'hidden' : 'visible';
  });

  sim.syncFishCount(3);
  assert.equal(sim.fish.length, 3);
  assert.ok(sim.fish.every((f) => f.tag === 'visible'), 'Only the visible fish should remain');
});

test('parseCssColor parses rgb, rgba, and space-separated syntax', () => {
  assert.deepEqual(parseCssColor('rgb(255, 128, 0)'), { r: 255, g: 128, b: 0, a: 1 });
  assert.deepEqual(parseCssColor('rgba(12, 34, 56, 0.5)'), { r: 12, g: 34, b: 56, a: 0.5 });
  assert.deepEqual(parseCssColor('rgb(10 20 30 / 40%)'), { r: 10, g: 20, b: 30, a: 0.4 });
  assert.deepEqual(parseCssColor('color(srgb 1 0.5 0 / 0.5)'), { r: 255, g: 128, b: 0, a: 0.5 });
  assert.equal(parseCssColor('transparent'), null);
  assert.equal(parseCssColor(null), null);
});

test('PondSimulation manages fish count, movement, feeding, and ripples', () => {
  const sim = new PondSimulation(400, 300, KOI_VARIETIES);
  sim.syncFishCount(6);
  assert.equal(sim.fish.length, 6);

  // Depth sorting
  for (let i = 1; i < sim.fish.length; i++) {
    assert.ok(sim.fish[i].depth >= sim.fish[i - 1].depth);
  }

  // Step simulation and verify spine continuity
  const initialHead = { x: sim.fish[0].x, y: sim.fish[0].y };
  for (let frame = 0; frame < 30; frame++) {
    sim.step(1 / 60, DEFAULT_SETTINGS);
  }
  const movedDist = Math.hypot(sim.fish[0].x - initialHead.x, sim.fish[0].y - initialHead.y);
  assert.ok(movedDist > 0.5, 'Fish should swim forward over time');

  const f = sim.fish[0];
  for (let k = 1; k < f.centerSpine.length; k++) {
    const segDist = Math.hypot(
      f.centerSpine[k].x - f.centerSpine[k - 1].x,
      f.centerSpine[k].y - f.centerSpine[k - 1].y
    );
    assert.ok(Math.abs(segDist - f.segLen) < 0.01, 'Centerline spine segments stay fixed length');
  }

  // Drop food directly in front of fish 0 and verify it eats it
  sim.pellets = [];
  sim.dropFood(f.x + Math.cos(f.heading) * 2, f.y + Math.sin(f.heading) * 2, 1, true);
  assert.equal(sim.pellets.length, 1);
  assert.ok(sim.ripples.length >= 1);

  for (let frame = 0; frame < 20; frame++) {
    sim.step(1 / 60, DEFAULT_SETTINGS);
  }
  assert.equal(sim.pellets.length, 0, 'Fish should eat nearby food pellet');
});

test('PondSimulation scatter mode accelerates fish away from cursor', () => {
  const sim = new PondSimulation(400, 300, KOI_VARIETIES);
  sim.syncFishCount(1);
  const f = sim.fish[0];
  f.x = 200;
  f.y = 150;
  sim.onCursorMove(195, 150, { ...DEFAULT_SETTINGS, cursorMode: 'scatter' });
  sim.step(1 / 60, { ...DEFAULT_SETTINGS, cursorMode: 'scatter' });
  assert.ok(f.boost > 0.5, 'Startled fish should gain speed boost');
});

test('KoiRenderer geometry and patterns produce valid pixels and clean up dirty buffer', () => {
  assert.ok(koiHalfWidth(0.24) > koiHalfWidth(0.0));
  assert.ok(koiHalfWidth(0.24) > koiHalfWidth(1.0));

  const renderer = new KoiRenderer();
  const sim = new PondSimulation(400, 300, KOI_VARIETIES);
  sim.syncFishCount(KOI_VARIETIES.length);

  // Ensure tancho pattern detects red head spot
  const tanchoVar = KOI_VARIETIES.find((v) => v.id === 'tancho');
  assert.equal(evaluateKoiPattern({ variety: tanchoVar, patches: [] }, 0.13, 0), 'A');
  assert.equal(evaluateKoiPattern({ variety: tanchoVar, patches: [] }, 0.6, 0), 'base');

  // Ensure new procedural patterns evaluate all expected zones
  const inazumaVar = KOI_VARIETIES.find((v) => v.id === 'inazuma');
  assert.equal(
    evaluateKoiPattern({ variety: inazumaVar, patternPhase: 0, patches: [] }, 0.5, Math.sin(0.5 * 15) * 0.44),
    'A'
  );

  const shusuiVar = KOI_VARIETIES.find((v) => v.id === 'shusui');
  assert.equal(evaluateKoiPattern({ variety: shusuiVar, patches: [] }, 0.4, 0.75), 'A');

  const goromoVar = KOI_VARIETIES.find((v) => v.id === 'goromo');
  const gPatches = [{ u: 0.5, v: 0, ru: 0.2, rv: 0.5 }];
  assert.equal(evaluateKoiPattern({ variety: goromoVar, patches: gPatches }, 0.5, 0), 'A');
  assert.equal(evaluateKoiPattern({ variety: goromoVar, patches: gPatches }, 0.68, 0), 'B');

  // Render every single koi variety and verify clean buffer reset
  const fakeCtx = {
    drawImage() {},
    fillRect() {},
    fillStyle: '',
  };

  assert.equal(KOI_VARIETIES.length, 15);
  for (let idx = 0; idx < KOI_VARIETIES.length; idx++) {
    sim.fish[idx].variety = KOI_VARIETIES[idx];
    const fish = sim.fish[idx];
    fish.patternLut = null;
    buildPatternLut(fish);
    assert.ok(fish.patternLut instanceof Uint8Array, `buildPatternLut should populate Uint8Array for ${fish.variety.id}`);
    renderer.renderFish(fakeCtx, fish, 1);
    let nonZeroMask = 0;
    for (let i = 0; i < renderer.maskBuf.length; i++) {
      if (renderer.maskBuf[i] !== 0) nonZeroMask++;
    }
    assert.equal(nonZeroMask, 0, `Renderer must clear dirty maskBuf for ${fish.variety.id}`);
  }

  // Batched atlas render across all 15 fish at once must clear both maskBuf and atlasBuf32
  renderer.renderFrame(fakeCtx, sim.fish, 1);
  let nonZeroAtlas = 0;
  for (let i = 0; i < renderer.atlasBuf32.length; i++) {
    if (renderer.atlasBuf32[i] !== 0) nonZeroAtlas++;
  }
  assert.equal(nonZeroAtlas, 0, 'Renderer must clear dirty atlasBuf32 after renderFrame');
});

test('PondSimulation adapts fish scale for mobile viewports and caps active ripples', () => {
  const sim = new PondSimulation(130, 260, KOI_VARIETIES);
  sim.resize(130, 260, 390);
  assert.equal(sim.sizeMultiplier, 0.76);
  sim.syncFishCount(2);
  const mobileSize = sim.fish[0].size;
  const mobileSegLen = sim.fish[0].segLen;

  sim.resize(400, 300, 1200);
  assert.equal(sim.sizeMultiplier, 1);
  assert.ok(sim.fish[0].size > mobileSize, 'Desktop resize should restore full fish scale');
  assert.ok(sim.fish[0].segLen > mobileSegLen, 'Desktop resize should restore spine segment length');

  for (let i = 0; i < 60; i++) {
    sim.spawnRipple(50 + i, 50, 12);
  }
  assert.ok(sim.ripples.length <= 40, 'Active ripple pool must stay capped');
});

test('wrapAngle normalizes angles into [-PI, PI]', () => {
  assert.ok(Math.abs(wrapAngle(Math.PI * 3) - Math.PI) < 1e-6);
  assert.ok(Math.abs(wrapAngle(-Math.PI * 3) + Math.PI) < 1e-6);
});

test('isBoundedTransparentCard separates bordered/shadowed cards from shells and buttons', () => {
  const vw = 1280;
  const vh = 800;
  const cardStyle = {
    backgroundColor: 'rgba(0, 0, 0, 0)',
    backgroundImage: 'none',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'rgb(48, 54, 61)',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: 'rgb(48, 54, 61)',
    borderLeftWidth: '1px',
    borderLeftStyle: 'solid',
    borderLeftColor: 'rgb(48, 54, 61)',
    borderRightWidth: '1px',
    borderRightStyle: 'solid',
    borderRightColor: 'rgb(48, 54, 61)',
    borderTopLeftRadius: '6px',
    outlineWidth: '0px',
    outlineStyle: 'none',
    boxShadow: 'none',
  };

  // Bounded card (e.g. GitHub chart box): should be treated as cohesive block
  assert.equal(
    isBoundedTransparentCard({ tagName: 'DIV' }, { width: 900, height: 360 }, cardStyle, vw, vh),
    true
  );

  // Small button/dropdown: should NOT be modified
  assert.equal(
    isBoundedTransparentCard({ tagName: 'DIV' }, { width: 140, height: 36 }, cardStyle, vw, vh),
    false
  );

  // Card styled with 1px outline or inset box-shadow instead of border
  assert.equal(
    isBoundedTransparentCard(
      { tagName: 'DIV' },
      { width: 480, height: 260 },
      {
        backgroundColor: 'transparent',
        backgroundImage: 'none',
        borderTopWidth: '0px',
        borderBottomWidth: '0px',
        borderLeftWidth: '0px',
        borderRightWidth: '0px',
        borderTopStyle: 'none',
        borderBottomStyle: 'none',
        borderLeftStyle: 'none',
        borderRightStyle: 'none',
        borderTopLeftRadius: '6px',
        outlineWidth: '0px',
        outlineStyle: 'none',
        boxShadow: 'inset 0 0 0 1px rgb(48, 54, 61)',
      },
      vw,
      vh
    ),
    true
  );

  // Single bottom divider line (not a card box) should NOT become a solid block
  assert.equal(
    isBoundedTransparentCard(
      { tagName: 'DIV' },
      { width: 600, height: 120 },
      {
        backgroundColor: 'rgba(0, 0, 0, 0)',
        backgroundImage: 'none',
        borderTopWidth: '0px',
        borderBottomWidth: '1px',
        borderLeftWidth: '0px',
        borderRightWidth: '0px',
        borderTopStyle: 'none',
        borderBottomStyle: 'solid',
        borderLeftStyle: 'none',
        borderRightStyle: 'none',
        borderBottomColor: 'rgb(48, 54, 61)',
        borderTopLeftRadius: '6px',
        outlineWidth: '0px',
        outlineStyle: 'none',
        boxShadow: 'none',
      },
      vw,
      vh
    ),
    false
  );

  // Full-height column wrapper: should NOT be solidified
  assert.equal(
    isBoundedTransparentCard({ tagName: 'DIV' }, { width: 960, height: 740 }, cardStyle, vw, vh),
    false
  );

  // Already opaque card: leave untouched
  assert.equal(
    isBoundedTransparentCard(
      { tagName: 'DIV' },
      { width: 500, height: 280 },
      { ...cardStyle, backgroundColor: 'rgb(22, 27, 34)' },
      vw,
      vh
    ),
    false
  );
});

test('isWorkspaceOrShell detects split-pane app workspaces while keeping cards/sidebars opaque', () => {
  const vw = 1280;
  const vh = 800;
  const surfaceStyle = {
    backgroundColor: 'rgb(255, 255, 255)',
    backgroundImage: 'none',
    borderTopWidth: '0px',
    borderBottomWidth: '0px',
    borderLeftWidth: '0px',
    borderRightWidth: '0px',
    borderTopStyle: 'none',
    borderBottomStyle: 'none',
    borderLeftStyle: 'none',
    borderRightStyle: 'none',
    borderTopLeftRadius: '16px',
    outlineWidth: '0px',
    outlineStyle: 'none',
    boxShadow: 'none',
  };

  // Google Classroom-like main rounded pane containing banner + post cards
  const classroomPane = {
    tagName: 'DIV',
    children: [
      { tagName: 'DIV', getBoundingClientRect: () => ({ width: 820, height: 180 }), children: [] },
      { tagName: 'DIV', getBoundingClientRect: () => ({ width: 520, height: 140 }), children: [] },
    ],
  };
  assert.equal(
    isWorkspaceOrShell(classroomPane, { width: 1010, height: 730 }, surfaceStyle, vw, vh),
    true
  );

  // Narrow left sidebar (20% width) -> NOT workspace
  assert.equal(
    isWorkspaceOrShell(classroomPane, { width: 256, height: 736 }, surfaceStyle, vw, vh),
    false
  );

  // Single chart card (86% width, 45% height) -> NOT workspace
  assert.equal(
    isWorkspaceOrShell(classroomPane, { width: 1100, height: 360 }, surfaceStyle, vw, vh),
    false
  );

  // Centered article/comments column (60% width) -> MUST stay opaque so text contrast stays readable
  assert.equal(
    isWorkspaceOrShell(
      classroomPane,
      { left: 256, right: 1024, width: 768, height: 700 },
      surfaceStyle,
      vw,
      vh
    ),
    false
  );

  // Material 3 Classroom split-pane with 24px rounded corner anchored to right edge
  assert.equal(
    isWorkspaceOrShell(
      classroomPane,
      { left: 260, right: 1270, width: 1010, height: 730 },
      { ...surfaceStyle, borderTopLeftRadius: '24px' },
      vw,
      vh
    ),
    true
  );

  // Compatible surface palette check: Material #ffffff over #f0f4f9 allowed, dark vs light blocked
  assert.equal(isCompatibleBackdrop({ r: 255, g: 255, b: 255 }, { r: 240, g: 244, b: 249 }), true);
  assert.equal(isCompatibleBackdrop({ r: 255, g: 255, b: 255 }, { r: 28, g: 40, b: 51 }), false);
});

test('PondSimulation steers fish toward clear open zones while permitting periodic crossings', () => {
  const sim = new PondSimulation(400, 300, KOI_VARIETIES);
  const cols = 12;
  const rows = 8;
  const cells = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Simulate centered opaque column (cols 3..8 blocked) with open left/right margins
      cells[r * cols + c] = c >= 3 && c <= 8 ? 0 : 1;
    }
  }
  sim.setClearMap({ cols, rows, cells, visibleRatio: 0.5 });
  assert.ok(sim.clearField, 'Clear field should initialize for partial-cover layouts');
  assert.equal(sim.clearField.openSpots.length, 48);

  sim.syncFishCount(1);
  const f = sim.fish[0];
  // Place fish just right of center inside covered zone (col ~7, nearest clear right margin is cols 9..11)
  f.x = 240;
  f.y = 150;
  f.heading = Math.PI; // Facing left deeper into covered column
  f.baseSpeed = 20;
  f.depth = 1.0;
  f.roamUnderTimer = 0;
  f.nextRoamCooldown = 30;
  for (let i = 0; i < f.spine.length; i++) {
    f.spine[i].x = f.x + f.segLen * i;
    f.spine[i].y = f.y;
    f.centerSpine[i].x = f.x + f.segLen * i;
    f.centerSpine[i].y = f.y;
  }

  for (let frame = 0; frame < 150; frame++) {
    sim.step(1 / 60, DEFAULT_SETTINGS);
  }
  assert.ok(f.x > 270, `Fish should steer out of covered column toward open right margin (x=${f.x.toFixed(1)})`);

  // When roamUnderTimer is active ("not constantly"), fish should still swim across for food/exploration
  f.roamUnderTimer = 3.0;
  f.x = 340;
  f.y = 150;
  f.heading = Math.PI;
  f.zoneTarget = { x: 40, y: 150 };
  for (let frame = 0; frame < 60; frame++) {
    sim.step(1 / 60, DEFAULT_SETTINGS);
  }
  assert.ok(f.x < 330, `During roamUnderTimer fish should freely cross covered zone (x=${f.x.toFixed(1)})`);

  // Nearly empty or nearly full coverage disables artificial steering
  sim.setClearMap({ cols, rows, cells: new Float32Array(cols * rows).fill(1), visibleRatio: 0.98 });
  assert.equal(sim.clearField, null);
  sim.setClearMap({ cols, rows, cells: new Float32Array(cols * rows), visibleRatio: 0.04 });
  assert.equal(sim.clearField, null);
});

test('PondSimulation keeps majority of 7 fish visible inside narrow open margin (Google Docs layout)', () => {
  const sim = new PondSimulation(426, 266, KOI_VARIETIES);
  sim.syncFishCount(7);

  // Left sidebar + giant centered document (cols 0..11 blocked), only right ~25% open (cols 12..15)
  const cols = 16;
  const rows = 10;
  const cells = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells[r * cols + c] = c >= 12 ? 1 : 0;
    }
  }
  sim.setClearMap({ cols, rows, cells, visibleRatio: 0.25 });

  let visibleSamples = 0;
  let totalSamples = 0;
  for (let frame = 0; frame < 600; frame++) {
    sim.step(1 / 60, DEFAULT_SETTINGS);
    if (frame >= 180 && frame % 10 === 0) {
      for (let i = 0; i < sim.fish.length; i++) {
        totalSamples++;
        if (sim.sampleClearField(sim.fish[i].x, sim.fish[i].y).openness >= 0.5) {
          visibleSamples++;
        }
      }
    }
  }

  const avgVisible = (visibleSamples / totalSamples) * 7;
  assert.ok(
    avgVisible >= 5.0,
    `At least 5/7 fish should stay in visible clear zone on average (got ${avgVisible.toFixed(2)}/7)`
  );
});

test('isScrim recognises a modal dimming layer but not opaque covers or small overlays', () => {
  const vw = 1280;
  const vh = 800;
  const full = { width: 1280, height: 800 };

  // Typical modal backdrop: translucent black over the whole viewport
  assert.equal(isScrim(full, { r: 0, g: 0, b: 0, a: 0.5 }, vw, vh), true);
  assert.equal(isScrim(full, { r: 15, g: 23, b: 42, a: 0.75 }, vw, vh), true);

  // Opaque full-screen cover really hides the pond
  assert.equal(isScrim(full, { r: 0, g: 0, b: 0, a: 1 }, vw, vh), false);
  assert.equal(isScrim(full, { r: 0, g: 0, b: 0, a: 0.95 }, vw, vh), false);

  // Translucent but small (tooltip, dropdown shadow layer) or fully transparent wrapper
  assert.equal(isScrim({ width: 400, height: 300 }, { r: 0, g: 0, b: 0, a: 0.5 }, vw, vh), false);
  assert.equal(isScrim(full, { r: 0, g: 0, b: 0, a: 0 }, vw, vh), false);
  assert.equal(isScrim(full, null, vw, vh), false);
});
