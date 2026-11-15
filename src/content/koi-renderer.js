(function (root) {
  'use strict';

  const KoiPond = (root.KoiPond = root.KoiPond || {});

  const BUF_SIZE = 96;
  const HALF = BUF_SIZE >> 1;
  const ATLAS_COLS = 5;
  const ATLAS_ROWS = 4;
  const ATLAS_W = BUF_SIZE * ATLAS_COLS; // 480
  const ATLAS_H = BUF_SIZE * ATLAS_ROWS; // 384 (up to 20 fish)

  const LUT_U = 96;
  const LUT_V = 28;
  const ZONE_BASE = 0;
  const ZONE_A = 1;
  const ZONE_B = 2;
  const ZONE_DITHER = 3;

  // Mask cell types
  const M_EMPTY = 0;
  const M_SHADOW = 1;
  const M_FIN = 2;
  const M_FIN_RAY = 3;
  const M_BODY = 4;
  const M_DORSAL = 5;
  const M_EYE = 6;
  const M_OUTLINE = 7;

  const SHADOW_OFFSET_X = 2.6; // drop-shadow shift in pond pixels, scaled by fish depth
  const SHADOW_OFFSET_Y = 3.4;
  const EYE_U = 0.105; // position of the eyes along the spine (0 = snout, 1 = tail root)
  const DORSAL_FIRST_STEP = 10;
  const DORSAL_LAST_STEP = 22;

  const BODY_STEPS = 30;
  const BODY_HW_LUT = new Float32Array(BODY_STEPS + 1);
  for (let i = 0; i <= BODY_STEPS; i++) {
    BODY_HW_LUT[i] = koiHalfWidth(i / BODY_STEPS);
  }

  // Detect host endianness once for direct Uint32Array RGBA writes
  const IS_LITTLE_ENDIAN = (() => {
    const ab = new ArrayBuffer(4);
    new DataView(ab).setUint32(0, 0x01020304, true);
    return new Uint8Array(ab)[0] === 0x04;
  })();

  function packColor(r, g, b, a) {
    if (IS_LITTLE_ENDIAN) {
      return ((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255);
    }
    return ((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | (a & 255);
  }

  // Koi anatomical width curve along normalized spine t in [0, 1]
  function koiHalfWidth(u) {
    if (u < 0.24) {
      const k = u / 0.24;
      return 1.35 + 3.25 * Math.sin(k * Math.PI * 0.5);
    }
    const k = (u - 0.24) / 0.76;
    return 4.6 * Math.pow(1 - k * 0.78, 1.38);
  }

  function insideAnyEllipse(ellipses, u, v) {
    if (!ellipses) return false;
    for (let i = 0; i < ellipses.length; i++) {
      const e = ellipses[i];
      const du = (u - e.u) / e.ru;
      const dv = (v - e.v) / e.rv;
      if (du * du + dv * dv <= 1.0) return true;
    }
    return false;
  }

  // Deterministic organic pattern evaluation in body-local (u, v) coordinates
  function evaluateKoiPattern(fish, u, v) {
    const pal = fish.variety;
    const pat = pal.pattern;
    const phase = fish.patternPhase || 0;

    if (pat === 'tancho') {
      const du = (u - 0.13) / 0.085;
      const dv = v / 0.44;
      return du * du + dv * dv <= 1.0 ? 'A' : 'base';
    }

    if (pat === 'zigzag') {
      const centerV = Math.sin(u * 15 + phase) * 0.44;
      if (u > 0.07 && u < 0.9 && Math.abs(v - centerV) < 0.36) {
        return 'A';
      }
      return 'base';
    }

    if (pat === 'bands') {
      const wA = Math.sin(u * 12 + v * 1.4 + phase);
      const wB = Math.cos(u * 9 - v * 1.1 + phase * 1.7);
      if (wA > 0.32) return 'A';
      if (wB > 0.15) return 'B';
      return 'base';
    }

    if (pat === 'utsuri') {
      const w = Math.sin(u * 15 + v * 1.3 + phase);
      return w > 0.05 ? 'A' : 'base';
    }

    if (pat === 'asagi') {
      if (Math.abs(v) > 0.62 && u > 0.14 && u < 0.88) return 'A';
      if (u < 0.12 && Math.abs(v) < 0.45) return 'A';
      return 'base';
    }

    if (pat === 'shusui') {
      if (Math.abs(v) > 0.62 && u > 0.15 && u < 0.88) return 'A';
      if (u < 0.11 && Math.abs(v) < 0.42) return 'A';
      if (u > 0.18 && u < 0.86) {
        const uCell = ((u - 0.18) * 14) % 1;
        const du = (uCell - 0.5) * 2.2;
        const dv = (Math.abs(v) - 0.28) / 0.14;
        if (du * du + dv * dv < 0.85) return 'B';
      }
      return 'base';
    }

    if (pat === 'kujaku') {
      if (insideAnyEllipse(fish.patches, u, v)) return 'A';
      if (u > 0.16 && u < 0.92 && Math.abs(v) < 0.78) {
        const col = Math.floor(u * 20);
        const su = ((u * 20) % 1) - 0.5;
        const sv = (((v + 1) * 5 + (col & 1) * 0.5) % 1) - 0.5;
        if (Math.abs(su) + Math.abs(sv) < 0.25) return 'B';
      }
      return 'base';
    }

    if (pat === 'goromo') {
      if (fish.patches) {
        let bestDistSq = Infinity;
        for (let i = 0; i < fish.patches.length; i++) {
          const p = fish.patches[i];
          const du = (u - p.u) / p.ru;
          const dv = (v - p.v) / p.rv;
          const dSq = du * du + dv * dv;
          if (dSq < bestDistSq) bestDistSq = dSq;
        }
        if (bestDistSq <= 0.68) return 'A';
        if (bestDistSq <= 1.04) return 'B';
      }
      return 'base';
    }

    if (pat === 'scales') {
      return 'base';
    }

    if ((pat === 'sanke' || pat === 'calico') && insideAnyEllipse(fish.spotsB, u, v)) return 'B';
    if (insideAnyEllipse(fish.patches, u, v)) return 'A';
    return 'base';
  }

  function buildPatternLut(fish) {
    const lut = new Uint8Array(LUT_U * LUT_V);
    const pat = fish.variety.pattern;
    const hasScaleMesh = pat === 'scales' || pat === 'asagi' || pat === 'ochiba';

    for (let iu = 0; iu < LUT_U; iu++) {
      const u = (iu + 0.5) / LUT_U;
      const rowOff = iu * LUT_V;
      for (let iv = 0; iv < LUT_V; iv++) {
        const v = ((iv + 0.5) / LUT_V) * 2 - 1;
        const zone = evaluateKoiPattern(fish, u, v);
        if (zone === 'A') {
          lut[rowOff + iv] = ZONE_A;
        } else if (zone === 'B') {
          lut[rowOff + iv] = ZONE_B;
        } else if (
          hasScaleMesh &&
          u > 0.16 &&
          u < 0.9 &&
          ((Math.round(u * 22) + Math.round(v * 7)) & 1) === 0
        ) {
          lut[rowOff + iv] = ZONE_DITHER;
        } else {
          lut[rowOff + iv] = ZONE_BASE;
        }
      }
    }
    fish.patternLut = lut;
    return lut;
  }

  function sampleSpineOut(spine, nSeg, t, ox, oy, out) {
    const ft = (t < 0 ? 0 : t > 1 ? 1 : t) * nSeg;
    const i0 = Math.min(nSeg - 1, ft | 0);
    const f = ft - i0;
    const p0 = spine[i0];
    const p1 = spine[i0 + 1];
    out.x = p0.x + (p1.x - p0.x) * f + ox;
    out.y = p0.y + (p1.y - p0.y) * f + oy;
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    out.tx = dx / len;
    out.ty = dy / len;
    out.nx = -out.ty;
    out.ny = out.tx;
  }

  class KoiRenderer {
    constructor() {
      this.maskBuf = new Uint8Array(BUF_SIZE * BUF_SIZE);
      this.uBuf = new Float32Array(BUF_SIZE * BUF_SIZE);
      this.vBuf = new Float32Array(BUF_SIZE * BUF_SIZE);
      this.tmpSample = { x: 0, y: 0, tx: 0, ty: 0, nx: 0, ny: 0 };
      this.rippleFills = {};

      this.drawQueue = new Array(ATLAS_COLS * ATLAS_ROWS);
      for (let i = 0; i < this.drawQueue.length; i++) {
        this.drawQueue[i] = { sx: 0, sy: 0, w: 0, h: 0, dx: 0, dy: 0, alpha: 1 };
      }

      if (typeof document !== 'undefined') {
        this.atlasCanvas = document.createElement('canvas');
        this.atlasCanvas.width = ATLAS_W;
        this.atlasCanvas.height = ATLAS_H;
        this.atlasCtx = this.atlasCanvas.getContext('2d');
        this.atlasImgData = this.atlasCtx.createImageData(ATLAS_W, ATLAS_H);
      } else {
        this.atlasCanvas = null;
        this.atlasCtx = null;
        this.atlasImgData = {
          data: new Uint8ClampedArray(ATLAS_W * ATLAS_H * 4),
          width: ATLAS_W,
          height: ATLAS_H,
        };
      }
      this.atlasBuf32 = new Uint32Array(this.atlasImgData.data.buffer);

      this.minX = BUF_SIZE;
      this.minY = BUF_SIZE;
      this.maxX = 0;
      this.maxY = 0;
    }

    resetBounds() {
      this.minX = BUF_SIZE - 1;
      this.minY = BUF_SIZE - 1;
      this.maxX = 0;
      this.maxY = 0;
    }

    markCell(x, y, type, u = 0, v = 0, overwrite = true) {
      if (x < 1 || x >= BUF_SIZE - 1 || y < 1 || y >= BUF_SIZE - 1) return;
      const idx = y * BUF_SIZE + x;
      if (!overwrite && this.maskBuf[idx] !== M_EMPTY && this.maskBuf[idx] !== M_SHADOW) {
        return;
      }
      this.maskBuf[idx] = type;
      this.uBuf[idx] = u;
      this.vBuf[idx] = v;
      if (x < this.minX) this.minX = x;
      if (y < this.minY) this.minY = y;
      if (x > this.maxX) this.maxX = x;
      if (y > this.maxY) this.maxY = y;
    }

    stampDisc(cx, cy, r, type, u, nx, ny, overwrite = true) {
      const ir = Math.ceil(r);
      const rSq = r * r;
      const invR = r > 0.05 ? 1 / r : 0;
      const x0 = Math.round(cx - ir);
      const x1 = Math.round(cx + ir);
      const y0 = Math.round(cy - ir);
      const y1 = Math.round(cy + ir);

      for (let py = y0; py <= y1; py++) {
        const dy = py - cy;
        const dySq = dy * dy;
        for (let px = x0; px <= x1; px++) {
          const dx = px - cx;
          if (dx * dx + dySq <= rSq) {
            const v = (dx * nx + dy * ny) * invR;
            this.markCell(px, py, type, u, v, overwrite);
          }
        }
      }
    }

    // Fan of pixel rays with a drop shadow. Tail fans are notched in the middle, step per ray,
    // and store u > 1 so shading can tell them apart from body-side fins.
    stampFinFan(ox, oy, baseAngle, spreadAngle, length, rays, shadowOx, shadowOy, isTail = false) {
      const fanSteps = Math.max(4, Math.ceil(length * 1.4));
      for (let r = 0; r < rays; r++) {
        const frac = rays > 1 ? r / (rays - 1) : 0.5;
        const ang = baseAngle + (frac - 0.5) * spreadAngle;
        const cos = Math.cos(ang);
        const sin = Math.sin(ang);
        const rayLen = isTail
          ? length * (0.72 + 0.28 * Math.abs(frac - 0.5) * 2)
          : length * (0.78 + 0.22 * Math.sin(frac * Math.PI));
        const steps = isTail ? Math.ceil(rayLen * 1.5) : fanSteps;
        const type = (r & 1) === 0 ? M_FIN_RAY : M_FIN;

        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const dist = t * rayLen;
          const fx = Math.round(ox + cos * dist);
          const fy = Math.round(oy + sin * dist);
          this.markCell(Math.round(fx + shadowOx), Math.round(fy + shadowOy), M_SHADOW, 0, 0, false);
          this.markCell(fx, fy, type, isTail ? 1.0 + t * 0.3 : t, 0, false);
        }
      }
    }

    // Mirrored left/right fins at the spine sample `sp`, swept back by (PI - sweep) from the fish's
    // heading. The spine runs head to tail, so the sample tangent (tx, ty) points TOWARD THE TAIL;
    // the forward direction is its opposite.
    stampFinPair(sp, offset, sweep, spreadAngle, length, rays, shadowOx, shadowOy) {
      const angle = Math.atan2(-sp.ty, -sp.tx);
      this.stampFinFan(
        sp.x + sp.nx * offset,
        sp.y + sp.ny * offset,
        angle - sweep,
        spreadAngle,
        length,
        rays,
        shadowOx,
        shadowOy
      );
      this.stampFinFan(
        sp.x - sp.nx * offset,
        sp.y - sp.ny * offset,
        angle + sweep,
        spreadAngle,
        length,
        rays,
        shadowOx,
        shadowOy
      );
    }

    // Rasterizes one fish into the mask buffer, shades it into its atlas slot and returns the
    // tight source/destination rect for drawImage.
    rasterizeFishToSlot(fish, slotX, slotY) {
      const spine = fish.spine;
      if (!spine || spine.length < 4) return null;

      // The buffer is centered on a node behind the head so head and tail both fit
      const anchorX = Math.round(spine[3].x);
      const anchorY = Math.round(spine[3].y);
      const ox = HALF - anchorX;
      const oy = HALF - anchorY;
      const nSeg = spine.length - 1;
      const shadowOx = SHADOW_OFFSET_X * fish.depth;
      const shadowOy = SHADOW_OFFSET_Y * fish.depth;

      this.resetBounds();
      this.stampFins(fish, spine, nSeg, ox, oy, shadowOx, shadowOy);
      this.stampBody(fish, spine, nSeg, ox, oy, shadowOx, shadowOy);
      this.stampDetails(fish, spine, nSeg, ox, oy);

      const xStart = Math.max(1, this.minX - 1);
      const yStart = Math.max(1, this.minY - 1);
      const xEnd = Math.min(BUF_SIZE - 2, this.maxX + 1);
      const yEnd = Math.min(BUF_SIZE - 2, this.maxY + 1);

      this.stampOutline(xStart, yStart, xEnd, yEnd);
      this.shadeToAtlas(fish, slotX, slotY, xStart, yStart, xEnd, yEnd);

      return {
        sx: slotX + xStart,
        sy: slotY + yStart,
        w: xEnd - xStart + 1,
        h: yEnd - yStart + 1,
        dx: anchorX - HALF + xStart,
        dy: anchorY - HALF + yStart,
      };
    }

    // Pectoral and pelvic fin pairs plus the forked tail. Stamped first so the body covers their roots.
    stampFins(fish, spine, nSeg, ox, oy, shadowOx, shadowOy) {
      const size = fish.size;
      const sp = this.tmpSample;
      const pecWave = Math.sin(fish.swimPhase * 0.9) * 0.22;

      sampleSpineOut(spine, nSeg, 0.27, ox, oy, sp);
      this.stampFinPair(sp, 2.2 * size, 2.05 + pecWave, 0.78, 6.2 * size, 6, shadowOx, shadowOy);

      sampleSpineOut(spine, nSeg, 0.56, ox, oy, sp);
      this.stampFinPair(sp, 1.4 * size, 2.25 + pecWave * 0.5, 0.55, 3.5 * size, 4, shadowOx, shadowOy);

      sampleSpineOut(spine, nSeg, 0.98, ox, oy, sp);
      // The tail fan points away from the body: along the tail-ward tangent
      const tailAngle = Math.atan2(sp.ty, sp.tx) + Math.sin(fish.swimPhase - 3.6) * 0.28;
      this.stampFinFan(sp.x, sp.y, tailAngle, 1.05, 8.4 * size, 8, shadowOx, shadowOy, true);
    }

    // Body as overlapping discs along the spine, then its drop shadow
    stampBody(fish, spine, nSeg, ox, oy, shadowOx, shadowOy) {
      const sp = this.tmpSample;
      for (let i = 0; i <= BODY_STEPS; i++) {
        const u = i / BODY_STEPS;
        sampleSpineOut(spine, nSeg, u, ox, oy, sp);
        this.stampDisc(sp.x, sp.y, BODY_HW_LUT[i] * fish.size, M_BODY, u, sp.nx, sp.ny, true);
      }

      // Shadow: the finished silhouette shifted by the depth offset (cheaper than a second disc pass)
      const shDx = Math.round(shadowOx);
      const shDy = Math.round(shadowOy);
      const bx0 = this.minX;
      const by0 = this.minY;
      const bx1 = this.maxX;
      const by1 = this.maxY;
      for (let py = by0; py <= by1; py++) {
        const row = py * BUF_SIZE;
        for (let px = bx0; px <= bx1; px++) {
          if (this.maskBuf[row + px] === M_BODY) {
            this.markCell(px + shDx, py + shDy, M_SHADOW, 0, 0, false);
          }
        }
      }
    }

    // Barbels, dorsal ridge and eyes
    stampDetails(fish, spine, nSeg, ox, oy) {
      const size = fish.size;
      const sp = this.tmpSample;

      // Barbels (tiny koi whiskers) only on medium/large fish
      if (size >= 0.95) {
        sampleSpineOut(spine, nSeg, 0.02, ox, oy, sp);
        const bAng = Math.atan2(-sp.ty, -sp.tx); // forward, from the snout
        for (let side = -1; side <= 1; side += 2) {
          const wx = Math.round(sp.x + Math.cos(bAng + side * 0.85) * 2.1 * size);
          const wy = Math.round(sp.y + Math.sin(bAng + side * 0.85) * 2.1 * size);
          this.markCell(wx, wy, M_OUTLINE, 0, side, false);
        }
      }

      for (let i = DORSAL_FIRST_STEP; i <= DORSAL_LAST_STEP; i++) {
        const u = i / BODY_STEPS;
        sampleSpineOut(spine, nSeg, u, ox, oy, sp);
        const sway = Math.sin(fish.swimPhase - u * 4.2) * 0.6 * size;
        this.markCell(Math.round(sp.x + sp.nx * sway), Math.round(sp.y + sp.ny * sway), M_DORSAL, u, 0, true);
      }

      sampleSpineOut(spine, nSeg, EYE_U, ox, oy, sp);
      const eyeOffset = koiHalfWidth(EYE_U) * size * 0.68;
      this.markCell(Math.round(sp.x + sp.nx * eyeOffset), Math.round(sp.y + sp.ny * eyeOffset), M_EYE, 0.1, 1, true);
      this.markCell(Math.round(sp.x - sp.nx * eyeOffset), Math.round(sp.y - sp.ny * eyeOffset), M_EYE, 0.1, -1, true);
    }

    // 1px outline: empty or shadow cells that touch the body
    stampOutline(xStart, yStart, xEnd, yEnd) {
      const maskBuf = this.maskBuf;
      for (let py = yStart; py <= yEnd; py++) {
        const row = py * BUF_SIZE;
        for (let px = xStart; px <= xEnd; px++) {
          const idx = row + px;
          const m = maskBuf[idx];
          if (m !== M_EMPTY && m !== M_SHADOW) continue;
          if (
            maskBuf[idx - 1] === M_BODY ||
            maskBuf[idx + 1] === M_BODY ||
            maskBuf[idx - BUF_SIZE] === M_BODY ||
            maskBuf[idx + BUF_SIZE] === M_BODY
          ) {
            maskBuf[idx] = M_OUTLINE;
          }
        }
      }
    }

    // Packed 32-bit colors for one fish. Depth and variety do not change, so this is built once
    // per fish instead of every frame.
    getFishColors(fish) {
      const cached = fish.colorCache;
      if (cached && cached.variety === fish.variety) return cached;

      const pal = fish.variety;
      const depthAlpha = Math.max(0.6, Math.min(1.0, 0.72 + (fish.depth - 0.75) * 0.9));
      const bodyAlpha = Math.round(255 * depthAlpha);
      const pack = (c, alpha = bodyAlpha) => packColor(c[0], c[1], c[2], alpha);

      const base = pack(pal.base);
      const baseHi = pack(pal.baseHighlight);
      const baseSh = pack(pal.baseShadow);
      const dither = packColor(
        (pal.base[0] + pal.baseHighlight[0]) >> 1,
        (pal.base[1] + pal.baseHighlight[1]) >> 1,
        (pal.base[2] + pal.baseHighlight[2]) >> 1,
        bodyAlpha
      );

      const colors = {
        variety: pal,
        shadow: packColor(8, 24, 34, Math.round(54 * depthAlpha)),
        outline: pack(pal.outline, Math.round(150 * depthAlpha)),
        fin: pack(pal.fin, Math.round((pal.fin[3] || 185) * depthAlpha)),
        finHi: pack(pal.finHighlight, Math.round((pal.finHighlight[3] || 215) * depthAlpha)),
        moto: pal.motoguro ? pack(pal.base, Math.round(220 * depthAlpha)) : 0,
        motoHi: pal.motoguro ? pack(pal.baseHighlight, Math.round(230 * depthAlpha)) : 0,
        eye: pack(pal.eye),
        // Body tones indexed by pattern zone: [ZONE_BASE, ZONE_A, ZONE_B, ZONE_DITHER]
        mid: [base, pal.patchA ? pack(pal.patchA) : base, pal.patchB ? pack(pal.patchB) : base, dither],
        hi: [
          baseHi,
          pal.patchA ? pack(pal.patchAHighlight) : baseHi,
          pal.patchB ? pack(pal.patchBHighlight) : baseHi,
          baseHi,
        ],
        shade: [
          baseSh,
          pal.patchA ? pack(pal.patchAShadow) : baseSh,
          pal.patchB ? pack(pal.patchBShadow) : baseSh,
          baseSh,
        ],
      };
      fish.colorCache = colors;
      return colors;
    }

    // Turns mask cells into pixels in the fish's atlas slot and clears the mask as it goes
    shadeToAtlas(fish, slotX, slotY, xStart, yStart, xEnd, yEnd) {
      const lut = fish.patternLut || buildPatternLut(fish);
      const c = this.getFishColors(fish);
      const motoguro = Boolean(fish.variety.motoguro);
      const atlas32 = this.atlasBuf32;
      const maskBuf = this.maskBuf;
      const uBuf = this.uBuf;
      const vBuf = this.vBuf;

      for (let py = yStart; py <= yEnd; py++) {
        const row = py * BUF_SIZE;
        const atlasRow = (slotY + py) * ATLAS_W + slotX;
        for (let px = xStart; px <= xEnd; px++) {
          const idx = row + px;
          const m = maskBuf[idx];
          if (m === M_EMPTY) continue;

          let packed;
          if (m === M_SHADOW) {
            packed = c.shadow;
          } else if (m === M_OUTLINE) {
            packed = c.outline;
          } else if (m === M_FIN) {
            // Motoguro varieties have dark fin bases
            packed = motoguro && uBuf[idx] > 0 && uBuf[idx] < 0.42 ? c.moto : c.fin;
          } else if (m === M_FIN_RAY) {
            packed = motoguro && uBuf[idx] > 0 && uBuf[idx] < 0.34 ? c.motoHi : c.finHi;
          } else if (m === M_EYE) {
            packed = c.eye;
          } else {
            // Body / dorsal: pattern zone from the LUT, tone from the position across the body
            const v = vBuf[idx];
            let iu = (uBuf[idx] * LUT_U) | 0;
            if (iu < 0) iu = 0;
            else if (iu >= LUT_U) iu = LUT_U - 1;
            let iv = ((v + 1) * 0.5 * LUT_V) | 0;
            if (iv < 0) iv = 0;
            else if (iv >= LUT_V) iv = LUT_V - 1;

            const zone = lut[iu * LUT_V + iv];
            const below = maskBuf[idx + BUF_SIZE + 1];
            const isBottomRightEdge = below !== M_BODY && below !== M_DORSAL;
            const absV = v < 0 ? -v : v;

            if (m === M_DORSAL || absV < 0.24) {
              packed = c.hi[zone];
            } else if (isBottomRightEdge || absV > 0.8) {
              packed = c.shade[zone];
            } else {
              packed = c.mid[zone];
            }
          }

          atlas32[atlasRow + px] = packed;
          maskBuf[idx] = M_EMPTY;
        }
      }
    }

    renderFrame(ctx, fishList) {
      const count = Math.min(fishList.length, ATLAS_COLS * ATLAS_ROWS);
      if (count <= 0) return;

      let queued = 0;

      for (let i = 0; i < count; i++) {
        const slotX = (i % ATLAS_COLS) * BUF_SIZE;
        const slotY = ((i / ATLAS_COLS) | 0) * BUF_SIZE;
        const rect = this.rasterizeFishToSlot(fishList[i], slotX, slotY);
        if (!rect) continue;
        const q = this.drawQueue[queued++];
        q.sx = rect.sx;
        q.sy = rect.sy;
        q.w = rect.w;
        q.h = rect.h;
        q.dx = rect.dx;
        q.dy = rect.dy;
        q.alpha = fishList[i].alpha === undefined ? 1 : fishList[i].alpha;
      }

      if (queued === 0) return;

      if (this.atlasCtx) {
        // Upload only each fish's tight rect, not everything from the atlas origin to the farthest fish
        for (let i = 0; i < queued; i++) {
          const q = this.drawQueue[i];
          this.atlasCtx.putImageData(this.atlasImgData, 0, 0, q.sx, q.sy, q.w, q.h);
        }
        for (let i = 0; i < queued; i++) {
          const q = this.drawQueue[i];
          // Fish that are fading in or out are drawn translucent
          ctx.globalAlpha = q.alpha < 0 ? 0 : q.alpha > 1 ? 1 : q.alpha;
          ctx.drawImage(this.atlasCanvas, q.sx, q.sy, q.w, q.h, q.dx, q.dy, q.w, q.h);
        }
        ctx.globalAlpha = 1;
      }

      // Clear only the dirty rects in atlasBuf32
      const atlas32 = this.atlasBuf32;
      for (let i = 0; i < queued; i++) {
        const q = this.drawQueue[i];
        const xEnd = q.sx + q.w;
        for (let row = q.sy; row < q.sy + q.h; row++) {
          const off = row * ATLAS_W;
          atlas32.fill(0, off + q.sx, off + xEnd);
        }
      }
    }

    // Single-fish convenience wrapper (used by the tests)
    renderFish(ctx, fish) {
      this.renderFrame(ctx, [fish]);
    }

    // Bresenham midpoint pixel circle for razor-sharp pixel water ripples
    drawPixelCircle(ctx, cx, cy, radius) {
      const r = Math.round(radius);
      if (r <= 0) return;
      const ix = Math.round(cx);
      const iy = Math.round(cy);

      let x = r;
      let y = 0;
      let err = 1 - x;

      // One path and a single fill per circle instead of a draw call per pixel
      ctx.beginPath();
      while (x >= y) {
        ctx.rect(ix + x, iy + y, 1, 1);
        ctx.rect(ix + y, iy + x, 1, 1);
        ctx.rect(ix - y, iy + x, 1, 1);
        ctx.rect(ix - x, iy + y, 1, 1);
        ctx.rect(ix - x, iy - y, 1, 1);
        ctx.rect(ix - y, iy - x, 1, 1);
        ctx.rect(ix + y, iy - x, 1, 1);
        ctx.rect(ix + x, iy - y, 1, 1);
        y++;
        if (err < 0) {
          err += 2 * y + 1;
        } else {
          x--;
          err += 2 * (y - x + 1);
        }
      }
      ctx.fill();
    }

    renderRipple(ctx, ripple) {
      const life = 1 - ripple.age / ripple.maxAge;
      if (life <= 0) return;
      const alpha = life * ripple.strength;
      const a1 = ((alpha * 100) | 0) * 0.01;
      if (a1 <= 0.01) return;

      // Constant fill string per ripple color; the fade goes through globalAlpha (no per-frame strings)
      ctx.fillStyle = this.rippleFills[ripple.color] || (this.rippleFills[ripple.color] = `rgb(${ripple.color})`);
      ctx.globalAlpha = a1;
      this.drawPixelCircle(ctx, ripple.x, ripple.y, ripple.radius);

      if (ripple.radius > 5) {
        const a2 = ((alpha * 45) | 0) * 0.01;
        if (a2 > 0.01) {
          ctx.globalAlpha = a2;
          this.drawPixelCircle(ctx, ripple.x, ripple.y, ripple.radius - 3);
        }
      }
      ctx.globalAlpha = 1;
    }

    renderPellet(ctx, pellet, time) {
      const bob = Math.round(Math.sin(time * 4 + pellet.phase) * 0.6);
      const px = Math.round(pellet.x);
      const py = Math.round(pellet.y) + bob;

      ctx.fillStyle = 'rgba(12, 34, 42, 0.28)';
      ctx.fillRect(px + 1, py + 2, 2, 2);

      ctx.fillStyle = 'rgba(196, 134, 58, 0.95)';
      ctx.fillRect(px, py, 2, 2);
      ctx.fillStyle = 'rgb(255, 224, 138)';
      ctx.fillRect(px, py, 1, 1);
    }
  }

  KoiPond.KoiRenderer = KoiRenderer;
  KoiPond.koiHalfWidth = koiHalfWidth;
  KoiPond.evaluateKoiPattern = evaluateKoiPattern;
  KoiPond.buildPatternLut = buildPatternLut;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { KoiRenderer, koiHalfWidth, evaluateKoiPattern, buildPatternLut };
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
