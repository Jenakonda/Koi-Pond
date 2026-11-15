(function (root) {
  'use strict';

  const KoiPond = (root.KoiPond = root.KoiPond || {});

  const SPINE_NODES = 12;
  const WAVE_AMP_LUT = new Float32Array(SPINE_NODES);
  const WAVE_PHASE_LUT = new Float32Array(SPINE_NODES);
  for (let k = 0; k < SPINE_NODES; k++) {
    const t = k / (SPINE_NODES - 1);
    WAVE_AMP_LUT[k] = 0.1 + Math.pow(t, 1.45) * 1.85;
    WAVE_PHASE_LUT[k] = t * 4.5;
  }

  // Behaviour tuning (distances in pond pixels, angles in radians, openness in 0..1)
  const FOOD_SENSE_RADIUS = 155;
  const SCATTER_RADIUS = 58;
  const EDGE_CLAMP = 4; // fish heads never get closer than this to the pond border
  const SPAWN_CLAMP = 12;
  const BUSY_BOOST = 0.45; // above this a fish is darting and ignores zone steering
  const OPEN_COMFORT = 0.72; // openness below this under/ahead of a fish starts steering it back out
  const DEEP_COVER = 0.45; // openness below this means properly hidden: steer hard and speed up
  const HIDDEN_OPENNESS = 0.25; // fish below this are relocated when clear zones first appear
  const MAX_ESCAPE_TURN = 2.85; // just under PI so a fish never attempts an exact about-face
  const ZONE_ARRIVE_DIST_SQ = 22 * 22;
  const CURSOR_RIPPLE_MIN_MOVE_SQ = 14 * 14;
  const FADE_SECONDS = 0.8; // time for a fish to fade in or out when the school size changes

  function pickWeightedVariety(varieties) {
    let total = 0;
    for (let i = 0; i < varieties.length; i++) {
      total += varieties[i].weight || 1;
    }
    let roll = Math.random() * total;
    for (let i = 0; i < varieties.length; i++) {
      roll -= varieties[i].weight || 1;
      if (roll <= 0) return varieties[i];
    }
    return varieties[0];
  }

  function generatePatches(pattern) {
    const patches = [];
    const spotsB = [];
    const patternPhase = Math.random() * Math.PI * 2;

    if (
      pattern === 'patches' ||
      pattern === 'sanke' ||
      pattern === 'kujaku' ||
      pattern === 'goromo' ||
      pattern === 'ochiba'
    ) {
      const count = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < count; i++) {
        patches.push({
          u: 0.13 + (i / count) * 0.68 + (Math.random() - 0.5) * 0.12,
          v: (Math.random() - 0.5) * 0.85,
          ru: 0.11 + Math.random() * 0.11,
          rv: 0.46 + Math.random() * 0.45,
        });
      }
    } else if (pattern === 'calico') {
      const count = 4 + Math.floor(Math.random() * 3);
      for (let i = 0; i < count; i++) {
        patches.push({
          u: 0.1 + Math.random() * 0.78,
          v: (Math.random() - 0.5) * 1.15,
          ru: 0.06 + Math.random() * 0.07,
          rv: 0.3 + Math.random() * 0.35,
        });
      }
    }

    if (pattern === 'sanke') {
      const bCount = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < bCount; i++) {
        spotsB.push({
          u: 0.22 + Math.random() * 0.62,
          v: (Math.random() - 0.5) * 1.1,
          ru: 0.055 + Math.random() * 0.05,
          rv: 0.28 + Math.random() * 0.28,
        });
      }
    } else if (pattern === 'calico') {
      const bCount = 5 + Math.floor(Math.random() * 4);
      for (let i = 0; i < bCount; i++) {
        spotsB.push({
          u: 0.12 + Math.random() * 0.82,
          v: (Math.random() - 0.5) * 1.25,
          ru: 0.035 + Math.random() * 0.04,
          rv: 0.18 + Math.random() * 0.22,
        });
      }
    }

    return { patches, spotsB, patternPhase };
  }

  function wrapAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  function buildClearField(clearMap) {
    if (
      !clearMap ||
      !clearMap.cells ||
      !clearMap.cols ||
      !clearMap.rows ||
      clearMap.visibleRatio < 0.08 ||
      clearMap.visibleRatio > 0.9
    ) {
      return null;
    }

    const cols = clearMap.cols;
    const rows = clearMap.rows;
    const cells = clearMap.cells;
    const total = cols * rows;
    const openSpots = [];
    const dist = new Int16Array(total);
    const bfsQueue = new Int16Array(total);
    let qHead = 0;
    let qTail = 0;

    for (let idx = 0; idx < total; idx++) {
      if (cells[idx] >= 0.55) {
        dist[idx] = 0;
        bfsQueue[qTail++] = idx;
        const c = idx % cols;
        const r = (idx / cols) | 0;
        openSpots.push({
          nx: (c + 0.5) / cols,
          ny: (r + 0.5) / rows,
          weight: cells[idx],
        });
      } else {
        dist[idx] = -1;
      }
    }

    if (openSpots.length === 0) return null;

    while (qHead < qTail) {
      const idx = bfsQueue[qHead++];
      const nextD = dist[idx] + 1;
      const c = idx % cols;
      const r = (idx / cols) | 0;

      if (c > 0 && dist[idx - 1] === -1) {
        dist[idx - 1] = nextD;
        bfsQueue[qTail++] = idx - 1;
      }
      if (c + 1 < cols && dist[idx + 1] === -1) {
        dist[idx + 1] = nextD;
        bfsQueue[qTail++] = idx + 1;
      }
      if (r > 0 && dist[idx - cols] === -1) {
        dist[idx - cols] = nextD;
        bfsQueue[qTail++] = idx - cols;
      }
      if (r + 1 < rows && dist[idx + cols] === -1) {
        dist[idx + cols] = nextD;
        bfsQueue[qTail++] = idx + cols;
      }
    }

    // Scalar potential: positive in open water (+center bias), negative deeper under cover
    const potential = new Float32Array(total);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        if (dist[idx] === 0) {
          let openNeighbors = 0;
          if (c > 0 && dist[idx - 1] === 0) openNeighbors++;
          if (c + 1 < cols && dist[idx + 1] === 0) openNeighbors++;
          if (r > 0 && dist[idx - cols] === 0) openNeighbors++;
          if (r + 1 < rows && dist[idx + cols] === 0) openNeighbors++;
          potential[idx] = cells[idx] + openNeighbors * 0.08;
        } else {
          potential[idx] = -dist[idx];
        }
      }
    }

    const dirX = new Float32Array(total);
    const dirY = new Float32Array(total);
    for (let r = 0; r < rows; r++) {
      const rUp = Math.max(0, r - 1);
      const rDn = Math.min(rows - 1, r + 1);
      for (let c = 0; c < cols; c++) {
        const cLt = Math.max(0, c - 1);
        const cRt = Math.min(cols - 1, c + 1);
        const gx =
          (potential[rUp * cols + cRt] - potential[rUp * cols + cLt]) +
          2 * (potential[r * cols + cRt] - potential[r * cols + cLt]) +
          (potential[rDn * cols + cRt] - potential[rDn * cols + cLt]);
        const gy =
          (potential[rDn * cols + cLt] - potential[rUp * cols + cLt]) +
          2 * (potential[rDn * cols + c] - potential[rUp * cols + c]) +
          (potential[rDn * cols + cRt] - potential[rUp * cols + cRt]);
        const mag = Math.hypot(gx, gy);
        if (mag > 0.05) {
          dirX[r * cols + c] = gx / mag;
          dirY[r * cols + c] = gy / mag;
        }
      }
    }

    return {
      cols,
      rows,
      cells,
      dirX,
      dirY,
      openSpots,
      visibleRatio: clearMap.visibleRatio,
    };
  }

  class PondSimulation {
    // minSize: smallest pond side in pond pixels (the popup banner uses a much smaller pond)
    constructor(width, height, varieties, minSize = 120) {
      this.minSize = minSize;
      this.width = Math.max(this.minSize, width);
      this.height = Math.max(this.minSize, height);
      this.varieties = varieties || KoiPond.KOI_VARIETIES;
      this.fish = [];
      this.pellets = [];
      this.ripples = [];
      this.time = 0;
      this.isDarkPage = false;
      this.sizeMultiplier = 1.0;
      this.clearField = null;
      // Preallocated scratch objects (no per-frame garbage). Each probe has its own sample so that
      // reading one never silently overwrites another.
      this.fieldSample = { openness: 1, gx: 0, gy: 0 };
      this.sampleCurr = { openness: 1, gx: 0, gy: 0 };
      this.sampleNear = { openness: 1, gx: 0, gy: 0 };
      this.sampleFar = { openness: 1, gx: 0, gy: 0 };
      this.steer = { heading: 0, chasingFood: false, escapingCover: false, clearPullX: 0, clearPullY: 0, currOpen: 1 };
      this.cursor = { x: -9999, y: -9999, active: false, lastRippleAt: 0 };
      this.ambientRippleTimer = 2.0;
    }

    setClearMap(clearMap) {
      const hadField = Boolean(this.clearField);
      this.clearField = buildClearField(clearMap);
      if (!this.clearField || this.fish.length === 0) return;

      // On initial layout lock (or when clear zones first appear), move hidden fish into open water seamlessly
      if (!hadField || this.time < 4.5) {
        let hiddenCount = 0;
        for (let i = 0; i < this.fish.length; i++) {
          if (this.sampleClearField(this.fish[i].x, this.fish[i].y).openness < HIDDEN_OPENNESS) {
            hiddenCount++;
          }
        }
        if (hiddenCount > 0) {
          for (let i = 0; i < this.fish.length; i++) {
            const f = this.fish[i];
            if (this.sampleClearField(f.x, f.y).openness < HIDDEN_OPENNESS && Math.random() < 0.92) {
              const spot = this.pickOpenSpot(f.x, f.y, false);
              if (spot) {
                this.relocateFishToSpot(f, spot);
              }
            }
          }
        }
      }
    }

    // Random point inside the clear-map cell around an open spot, kept away from the pond border
    jitterWithinCell(spot) {
      const cellW = this.width / this.clearField.cols;
      const cellH = this.height / this.clearField.rows;
      return {
        x: Math.max(SPAWN_CLAMP, Math.min(this.width - SPAWN_CLAMP, spot.x + (Math.random() - 0.5) * cellW * 0.55)),
        y: Math.max(SPAWN_CLAMP, Math.min(this.height - SPAWN_CLAMP, spot.y + (Math.random() - 0.5) * cellH * 0.55)),
      };
    }

    relocateFishToSpot(f, spot) {
      const pos = this.jitterWithinCell(spot);
      f.x = pos.x;
      f.y = pos.y;
      f.roamUnderTimer = 0;
      f.zoneTarget = null;
      for (let k = 0; k < f.spine.length; k++) {
        const sx = f.x - Math.cos(f.heading) * f.segLen * k;
        const sy = f.y - Math.sin(f.heading) * f.segLen * k;
        f.spine[k].x = sx;
        f.spine[k].y = sy;
        f.centerSpine[k].x = sx;
        f.centerSpine[k].y = sy;
      }
    }

    // Bilinear sample of openness and the direction toward open water. Without `out` the result lands
    // in a shared scratch object that the next call overwrites, so read it immediately.
    sampleClearField(x, y, out = this.fieldSample) {
      const field = this.clearField;
      if (!field) {
        out.openness = 1;
        out.gx = 0;
        out.gy = 0;
        return out;
      }

      const cols = field.cols;
      const rows = field.rows;
      const u = Math.max(0, Math.min(cols - 1.0001, (x / Math.max(1, this.width)) * cols - 0.5));
      const v = Math.max(0, Math.min(rows - 1.0001, (y / Math.max(1, this.height)) * rows - 0.5));
      const c0 = u | 0;
      const r0 = v | 0;
      const c1 = Math.min(cols - 1, c0 + 1);
      const r1 = Math.min(rows - 1, r0 + 1);
      const fx = u - c0;
      const fy = v - r0;

      const i00 = r0 * cols + c0;
      const i10 = r0 * cols + c1;
      const i01 = r1 * cols + c0;
      const i11 = r1 * cols + c1;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      out.openness =
        field.cells[i00] * w00 + field.cells[i10] * w10 + field.cells[i01] * w01 + field.cells[i11] * w11;
      out.gx = field.dirX[i00] * w00 + field.dirX[i10] * w10 + field.dirX[i01] * w01 + field.dirX[i11] * w11;
      out.gy = field.dirY[i00] * w00 + field.dirY[i10] * w10 + field.dirY[i01] * w01 + field.dirY[i11] * w11;
      return out;
    }

    pickOpenSpot(fromX, fromY, preferRemote = false) {
      const spots = this.clearField && this.clearField.openSpots;
      if (!spots || spots.length === 0) return null;
      if (!preferRemote || spots.length === 1) {
        const s = spots[Math.floor(Math.random() * spots.length)];
        return { x: s.nx * this.width, y: s.ny * this.height };
      }
      // Best-of-4 sample keeps selection O(1) while favoring distant clear zones across cover
      let bestSpot = spots[0];
      let bestDistSq = -1;
      for (let k = 0; k < 4; k++) {
        const cand = spots[Math.floor(Math.random() * spots.length)];
        const dx = cand.nx * this.width - fromX;
        const dy = cand.ny * this.height - fromY;
        const dSq = dx * dx + dy * dy;
        if (dSq > bestDistSq) {
          bestDistSq = dSq;
          bestSpot = cand;
        }
      }
      return { x: bestSpot.nx * this.width, y: bestSpot.ny * this.height };
    }

    resize(width, height, cssWidth = 1024) {
      const prevW = this.width || 1;
      const prevH = this.height || 1;
      this.width = Math.max(this.minSize, width);
      this.height = Math.max(this.minSize, height);
      const sx = this.width / prevW;
      const sy = this.height / prevH;

      const nextMul = cssWidth > 0 && cssWidth < 540 ? 0.76 : 1.0;
      const mulChanged = nextMul !== this.sizeMultiplier;
      this.sizeMultiplier = nextMul;

      for (let idx = 0; idx < this.fish.length; idx++) {
        const f = this.fish[idx];
        f.x = Math.max(SPAWN_CLAMP, Math.min(this.width - SPAWN_CLAMP, f.x * sx));
        f.y = Math.max(SPAWN_CLAMP, Math.min(this.height - SPAWN_CLAMP, f.y * sy));
        if (mulChanged) {
          f.size = f.baseSize * nextMul;
          f.segLen = 2.35 * f.size;
        }
        for (let i = 0; i < f.spine.length; i++) {
          f.spine[i].x *= sx;
          f.spine[i].y *= sy;
          f.centerSpine[i].x *= sx;
          f.centerSpine[i].y *= sy;
        }
      }
    }

    setThemeBrightness(isDark) {
      this.isDarkPage = Boolean(isDark);
    }

    createFish() {
      const variety = pickWeightedVariety(this.varieties);
      const baseSize = 0.8 + Math.random() * 0.5; // 0.80 .. 1.30
      const size = baseSize * this.sizeMultiplier;
      const depth = 0.76 + Math.random() * 0.28; // 0.76 .. 1.04
      const margin = Math.min(36, Math.floor(Math.min(this.width, this.height) * 0.22));
      let x = margin + Math.random() * Math.max(40, this.width - margin * 2);
      let y = margin + Math.random() * Math.max(40, this.height - margin * 2);
      if (this.clearField && this.clearField.openSpots.length > 0 && Math.random() < 0.95) {
        const pos = this.jitterWithinCell(this.pickOpenSpot(x, y, false));
        x = pos.x;
        y = pos.y;
      }
      const heading = Math.random() * Math.PI * 2;
      const segLen = 2.35 * size;
      const spine = [];
      const centerSpine = [];

      for (let i = 0; i < SPINE_NODES; i++) {
        const sx = x - Math.cos(heading) * segLen * i;
        const sy = y - Math.sin(heading) * segLen * i;
        spine.push({ x: sx, y: sy });
        centerSpine.push({ x: sx, y: sy });
      }

      const { patches, spotsB, patternPhase } = generatePatches(variety.pattern);

      return {
        x,
        y,
        heading,
        targetHeading: heading,
        baseSize,
        size,
        depth,
        segLen,
        baseSpeed: 15 + Math.random() * 9,
        speed: 18,
        boost: 0,
        swimPhase: Math.random() * Math.PI * 2,
        wanderSeed: Math.random() * 100,
        glideTimer: 1 + Math.random() * 4,
        roamUnderTimer: 0,
        nextRoamCooldown: 12 + Math.random() * 20,
        zoneTarget: null,
        variety,
        patches,
        spotsB,
        patternPhase,
        patternLut: null,
        colorCache: null,
        alpha: 1, // 0..1, animated while the fish fades in or out
        leaving: false, // fading out; removed once invisible
        spine,
        centerSpine,
      };
    }

    // Sorts fish so the ones most worth keeping come first: those in open water, then the rest
    sortByVisibility(list) {
      if (!this.clearField) return list;
      const openness = new Map();
      for (let i = 0; i < list.length; i++) {
        openness.set(list[i], this.sampleClearField(list[i].x, list[i].y).openness);
      }
      return list.sort((a, b) => openness.get(b) - openness.get(a));
    }

    // Makes the school `targetCount` fish large. Without `fade`, fish are added and removed at once.
    // With `fade`, added fish fade in and removed fish fade out while they keep swimming, so the
    // school never visibly pops. Fish hidden under page content are let go first.
    syncFishCount(targetCount, fade = false) {
      const count = Math.max(1, Math.min(20, Math.round(targetCount)));

      if (!fade) {
        this.fish = this.fish.filter((f) => !f.leaving);
        for (const f of this.fish) f.alpha = 1;
        while (this.fish.length < count) {
          this.fish.push(this.createFish());
        }
        if (this.fish.length > count) {
          this.fish = this.sortByVisibility(this.fish.slice()).slice(0, count);
        }
        this.fish.sort((a, b) => a.depth - b.depth);
        return;
      }

      let staying = this.fish.filter((f) => !f.leaving);
      if (staying.length < count) {
        // Bring back fish that were on their way out before creating new ones
        for (const f of this.fish) {
          if (staying.length >= count) break;
          if (f.leaving) {
            f.leaving = false;
            staying.push(f);
          }
        }
        while (staying.length < count) {
          const f = this.createFish();
          f.alpha = 0;
          this.fish.push(f);
          staying.push(f);
        }
      } else if (staying.length > count) {
        const keep = new Set(this.sortByVisibility(staying.slice()).slice(0, count));
        for (const f of staying) {
          if (!keep.has(f)) f.leaving = true;
        }
      }
      this.fish.sort((a, b) => a.depth - b.depth);
    }

    respawnAll(targetCount) {
      this.fish = [];
      this.syncFishCount(targetCount);
    }

    spawnRipple(x, y, strength = 0.42, maxRadius = 22) {
      if (this.ripples.length >= 40) {
        this.ripples.shift();
      }
      this.ripples.push({
        x,
        y,
        radius: 2,
        maxRadius,
        age: 0,
        maxAge: 1.05 + maxRadius * 0.025,
        strength,
        color: this.isDarkPage ? '156, 226, 238' : '48, 124, 146',
      });
    }

    dropFood(x, y, count = 3, withRipples = true) {
      const n = Math.max(1, Math.min(8, count));
      for (let i = 0; i < n; i++) {
        if (this.pellets.length >= 45) {
          this.pellets.shift();
        }
        const spread = i === 0 ? 0 : 4 + Math.random() * 10;
        const ang = Math.random() * Math.PI * 2;
        const px = Math.max(8, Math.min(this.width - 8, x + Math.cos(ang) * spread));
        const py = Math.max(8, Math.min(this.height - 8, y + Math.sin(ang) * spread));
        this.pellets.push({
          x: px,
          y: py,
          age: 0,
          maxAge: 16 + Math.random() * 5,
          phase: Math.random() * Math.PI * 2,
        });
      }
      if (withRipples) {
        this.spawnRipple(x, y, 0.48, 24);
      }
    }

    dropFoodBurst() {
      const cx = this.width * (0.25 + Math.random() * 0.5);
      const cy = this.height * (0.25 + Math.random() * 0.5);
      this.dropFood(cx, cy, 5, true);
    }

    onCursorMove(x, y, settings) {
      const dx = x - this.cursor.x;
      const dy = y - this.cursor.y;
      this.cursor.x = x;
      this.cursor.y = y;
      this.cursor.active = true;

      if (settings.ripples && settings.cursorMode !== 'none') {
        if (dx * dx + dy * dy > CURSOR_RIPPLE_MIN_MOVE_SQ && this.time - this.cursor.lastRippleAt > 0.24) {
          this.cursor.lastRippleAt = this.time;
          this.spawnRipple(x, y, 0.24, 14);
        }
      }
    }

    step(dt, settings) {
      const clampedDt = Math.min(0.05, Math.max(0.001, dt));
      this.time += clampedDt;
      const speedMul = settings.speed || 1.0;

      this.stepEffects(clampedDt, settings);
      this.stepFades(clampedDt);

      const baseMargin = Math.min(32, Math.floor(Math.min(this.width, this.height) * 0.2));
      const margin = this.clearField ? Math.min(10, baseMargin) : baseMargin;
      const scatterActive = settings.cursorMode === 'scatter' && this.cursor.active;
      const s = this.steer;

      for (let i = 0; i < this.fish.length; i++) {
        const f = this.fish[i];

        f.glideTimer -= clampedDt;
        if (f.glideTimer <= 0) {
          f.glideTimer = 2.0 + Math.random() * 4.5;
          f.boost = Math.max(f.boost, 0.35 + Math.random() * 0.35);
        }

        const wanderTurn =
          Math.sin(this.time * 0.85 + f.wanderSeed) * 0.7 +
          Math.sin(this.time * 1.9 + f.wanderSeed * 1.7) * 0.35;
        s.heading = f.heading + wanderTurn * clampedDt * 1.3;
        s.chasingFood = false;
        s.escapingCover = false;
        s.clearPullX = 0;
        s.clearPullY = 0;
        s.currOpen = 1;

        // Each rule adjusts s.heading in turn; later rules take priority over earlier ones
        this.steerTowardFood(f, s, settings);
        if (scatterActive) this.steerAwayFromCursor(f, s, settings);
        this.steerApartFromOthers(f, i, s);
        if (this.clearField) this.steerTowardOpenWater(f, s, clampedDt);
        this.steerAwayFromEdges(f, s, margin);

        this.moveFish(f, s, clampedDt, speedMul);
        this.updateSpine(f);
      }
    }

    // Fades newly added fish in and removed fish out; removed fish disappear once invisible
    stepFades(dt) {
      const rate = dt / FADE_SECONDS;
      for (let i = this.fish.length - 1; i >= 0; i--) {
        const f = this.fish[i];
        if (f.leaving) {
          f.alpha -= rate;
          if (f.alpha <= 0) this.fish.splice(i, 1);
        } else if (f.alpha < 1) {
          f.alpha = Math.min(1, f.alpha + rate);
        }
      }
    }

    // Ambient ripples plus ageing of ripples and food pellets
    stepEffects(dt, settings) {
      if (settings.ripples) {
        this.ambientRippleTimer -= dt;
        if (this.ambientRippleTimer <= 0) {
          this.ambientRippleTimer = 2.4 + Math.random() * 3.6;
          this.spawnRipple(
            24 + Math.random() * Math.max(20, this.width - 48),
            24 + Math.random() * Math.max(20, this.height - 48),
            0.22,
            16
          );
        }
      }

      for (let i = this.ripples.length - 1; i >= 0; i--) {
        const r = this.ripples[i];
        r.age += dt;
        if (r.age >= r.maxAge) {
          this.ripples.splice(i, 1);
          continue;
        }
        const inv = 1 - r.age / r.maxAge;
        r.radius = 2 + (r.maxRadius - 2) * (1 - inv * inv);
      }

      for (let i = this.pellets.length - 1; i >= 0; i--) {
        const p = this.pellets[i];
        p.age += dt;
        if (p.age >= p.maxAge) {
          this.pellets.splice(i, 1);
        }
      }
    }

    // Head for the nearest pellet within sensing range, eating it on contact
    steerTowardFood(f, s, settings) {
      if (this.pellets.length === 0) return;

      let bestPellet = null;
      let bestDistSq = FOOD_SENSE_RADIUS * FOOD_SENSE_RADIUS;
      let bestIdx = -1;
      for (let pIdx = 0; pIdx < this.pellets.length; pIdx++) {
        const p = this.pellets[pIdx];
        const dx = p.x - f.x;
        const dy = p.y - f.y;
        const dSq = dx * dx + dy * dy;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestPellet = p;
          bestIdx = pIdx;
        }
      }
      if (!bestPellet) return;

      s.chasingFood = true;
      const eatRadius = 5.5 * f.size;
      if (bestDistSq <= eatRadius * eatRadius) {
        this.pellets.splice(bestIdx, 1);
        f.boost = Math.max(f.boost, 0.65);
        if (settings.ripples) {
          this.spawnRipple(bestPellet.x, bestPellet.y, 0.45, 20);
        }
      } else {
        s.heading = Math.atan2(bestPellet.y - f.y, bestPellet.x - f.x);
        f.boost = Math.max(f.boost, 0.55);
      }
    }

    // Scatter mode: dart directly away from a nearby cursor
    steerAwayFromCursor(f, s, settings) {
      const cdx = f.x - this.cursor.x;
      const cdy = f.y - this.cursor.y;
      const cDistSq = cdx * cdx + cdy * cdy;
      if (cDistSq >= SCATTER_RADIUS * SCATTER_RADIUS || cDistSq <= 0.01) return;

      s.heading = Math.atan2(cdy, cdx);
      const panic = 1 - Math.sqrt(cDistSq) / SCATTER_RADIUS;
      if (panic > 0.45 && f.boost < 0.8 && settings.ripples) {
        this.spawnRipple(f.x, f.y, 0.35, 18);
      }
      f.boost = Math.max(f.boost, 0.95 * panic + 0.3);
    }

    // Soft separation so fish do not swim through each other
    steerApartFromOthers(f, selfIdx, s) {
      let sepX = 0;
      let sepY = 0;
      for (let j = 0; j < this.fish.length; j++) {
        if (j === selfIdx) continue;
        const other = this.fish[j];
        const dx = f.x - other.x;
        const dy = f.y - other.y;
        const minSep = 8 * (f.size + other.size);
        const dSq = dx * dx + dy * dy;
        if (dSq < minSep * minSep && dSq > 0.0001) {
          const d = Math.sqrt(dSq);
          const push = (minSep - d) / minSep;
          sepX += (dx / d) * push;
          sepY += (dy / d) * push;
        }
      }
      if (sepX === 0 && sepY === 0) return;

      const diff = wrapAngle(Math.atan2(sepY, sepX) - s.heading);
      const sepWeight = s.chasingFood ? 0.18 : this.clearField ? 0.22 : 0.42;
      s.heading += diff * sepWeight;
    }

    // Clear-zone preference: mostly stay in visible open water, with brief excursions under cover
    steerTowardOpenWater(f, s, dt) {
      if (f.roamUnderTimer > 0) {
        f.roamUnderTimer -= dt;
        if (f.zoneTarget) {
          const tdx = f.zoneTarget.x - f.x;
          const tdy = f.zoneTarget.y - f.y;
          if (tdx * tdx + tdy * tdy < ZONE_ARRIVE_DIST_SQ) {
            f.zoneTarget = null;
            f.roamUnderTimer = 0;
          } else if (!s.chasingFood && f.boost <= BUSY_BOOST) {
            const targetAngle = Math.atan2(tdy, tdx);
            s.heading += wrapAngle(targetAngle - s.heading) * 0.35;
          }
        }
      } else {
        f.nextRoamCooldown -= dt;
        if (f.nextRoamCooldown <= 0) {
          f.nextRoamCooldown = 18 + Math.random() * 22;
          if (Math.random() < 0.42) {
            f.roamUnderTimer = 1.6 + Math.random() * 1.4;
            f.zoneTarget = this.pickOpenSpot(f.x, f.y, true);
          }
        }
      }

      if (s.chasingFood || f.boost > BUSY_BOOST || f.roamUnderTimer > 0) return;

      // Probe openness under the fish and at two points ahead of it
      const cosH = Math.cos(f.heading);
      const sinH = Math.sin(f.heading);
      const nearDist = 14 * f.size;
      const farDist = 30 * f.size;
      const curr = this.sampleClearField(f.x, f.y, this.sampleCurr);
      const near = this.sampleClearField(f.x + cosH * nearDist, f.y + sinH * nearDist, this.sampleNear);
      const far = this.sampleClearField(f.x + cosH * farDist, f.y + sinH * farDist, this.sampleFar);

      s.currOpen = curr.openness;
      const minOpen = Math.min(curr.openness, near.openness, far.openness);
      if (minOpen >= OPEN_COMFORT) return;

      // Direction toward open water: blended field gradient, or a random open spot on flat ground
      let fgX = near.gx * 0.45 + far.gx * 0.35 + curr.gx * 0.2;
      let fgY = near.gy * 0.45 + far.gy * 0.35 + curr.gy * 0.2;
      if (fgX * fgX + fgY * fgY < 0.01) {
        const spot = this.pickOpenSpot(f.x, f.y, false);
        if (spot) {
          const sLen = Math.hypot(spot.x - f.x, spot.y - f.y) || 1;
          fgX = (spot.x - f.x) / sLen;
          fgY = (spot.y - f.y) / sLen;
        }
      }
      const fgMag = Math.hypot(fgX, fgY);
      if (fgMag <= 0.001) return;

      const nX = fgX / fgMag;
      const nY = fgY / fgMag;
      const deepUnderCover = s.currOpen < DEEP_COVER;
      const coverDepth = Math.min(1, 1 - minOpen);
      const weight = deepUnderCover ? 1.85 : 0.75 + coverDepth * 0.9;
      s.clearPullX = nX * weight;
      s.clearPullY = nY * weight;

      let escapeDiff = wrapAngle(Math.atan2(nY, nX) - f.heading);
      if (Math.abs(escapeDiff) > MAX_ESCAPE_TURN) {
        escapeDiff = (f.wanderSeed % 2 >= 1 ? 1 : -1) * MAX_ESCAPE_TURN;
      }
      const steerBlend = deepUnderCover ? 0.92 : 0.38 + coverDepth * 0.48;
      s.heading = f.heading + escapeDiff * steerBlend;
      s.escapingCover = true;
      if (deepUnderCover) {
        f.boost = Math.max(f.boost, 0.32);
      }
    }

    // Turn back toward the pond interior near the borders (combined with any open-water pull)
    steerAwayFromEdges(f, s, margin) {
      let edgePushX = 0;
      let edgePushY = 0;
      if (f.x < margin) edgePushX += (margin - f.x) / margin;
      if (f.x > this.width - margin) edgePushX -= (f.x - (this.width - margin)) / margin;
      if (f.y < margin) edgePushY += (margin - f.y) / margin;
      if (f.y > this.height - margin) edgePushY -= (f.y - (this.height - margin)) / margin;
      if (edgePushX === 0 && edgePushY === 0) return;

      const combX = edgePushX + s.clearPullX;
      const combY = edgePushY + s.clearPullY;
      if (combX === 0 && combY === 0) return;

      const centerAngle = Math.atan2(combY, combX);
      const strength = Math.min(1, Math.sqrt(edgePushX * edgePushX + edgePushY * edgePushY));
      s.heading = f.heading + wrapAngle(centerAngle - f.heading) * Math.min(1, strength * 0.85);
    }

    // Turn toward the chosen heading at a limited rate, then advance
    moveFish(f, s, dt, speedMul) {
      let turnRate = 2.5;
      if (s.chasingFood) turnRate = 4.4;
      else if (s.escapingCover) turnRate = s.currOpen < DEEP_COVER ? 4.2 : 3.4;

      const maxTurn = turnRate * speedMul * dt;
      const deltaHeading = wrapAngle(s.heading - f.heading);
      f.heading = wrapAngle(f.heading + Math.max(-maxTurn, Math.min(maxTurn, deltaHeading)));

      f.boost = Math.max(0, f.boost - dt * 0.85);
      const targetSpeed = f.baseSpeed * speedMul * (1 + f.boost * 0.95) * f.depth;
      f.speed += (targetSpeed - f.speed) * Math.min(1, dt * 4.5);

      f.x += Math.cos(f.heading) * f.speed * dt;
      f.y += Math.sin(f.heading) * f.speed * dt;
      f.x = Math.max(EDGE_CLAMP, Math.min(this.width - EDGE_CLAMP, f.x));
      f.y = Math.max(EDGE_CLAMP, Math.min(this.height - EDGE_CLAMP, f.y));

      f.swimPhase += (3.8 + (f.speed / 18) * 3.6) * dt;
    }

    // Drag the fixed-length centerline behind the head, then add the swimming wave for rendering
    updateSpine(f) {
      const cSpine = f.centerSpine;
      const rSpine = f.spine;
      cSpine[0].x = f.x;
      cSpine[0].y = f.y;
      rSpine[0].x = f.x;
      rSpine[0].y = f.y;

      for (let k = 1; k < cSpine.length; k++) {
        const prev = cSpine[k - 1];
        const curr = cSpine[k];
        const ang = Math.atan2(curr.y - prev.y, curr.x - prev.x);
        const cos = Math.cos(ang);
        const sin = Math.sin(ang);

        curr.x = prev.x + cos * f.segLen;
        curr.y = prev.y + sin * f.segLen;

        const wave = Math.sin(f.swimPhase - WAVE_PHASE_LUT[k]) * WAVE_AMP_LUT[k] * f.size;
        rSpine[k].x = curr.x - sin * wave;
        rSpine[k].y = curr.y + cos * wave;
      }
    }
  }

  KoiPond.PondSimulation = PondSimulation;
  KoiPond.wrapAngle = wrapAngle;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PondSimulation, wrapAngle };
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
