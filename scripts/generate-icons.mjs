import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ICONS_DIR = path.resolve('icons');
fs.mkdirSync(ICONS_DIR, { recursive: true });

// Minimal pure-Node PNG encoder (RGBA)
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

// 16x16 pixel-art koi pond icon template
// Legend:
// . = deep pond teal
// ~ = water ripple / shimmer
// s = submerged shadow
// w = ivory white koi
// W = bright white highlight
// r = vermilion red patch
// R = deep red shade
// k = eye / dark outline
// o = fin translucent cream
const TEMPLATE_16 = [
  '................',
  '..~~............',
  '.~..~......oo...',
  '....s.....oWWo..',
  '...srr...oWWro..',
  '..srrWo.oWWrro..',
  '..sWWWooWWrrs...',
  '..sWWWWWWrrs....',
  '...sWWWWrrs..~..',
  '...oWWWWWs..~.~.',
  '..oWWrWWk.......',
  '..oWWrrkW.......',
  '...oWWWWs.......',
  '....ssss........',
  '.........~~.....',
  '................',
];

const PALETTE = {
  '.': [15, 45, 56, 255],
  '~': [44, 118, 132, 255],
  's': [9, 27, 35, 255],
  'w': [242, 238, 228, 255],
  'W': [255, 253, 248, 255],
  'r': [232, 74, 48, 255],
  'R': [186, 46, 28, 255],
  'k': [24, 24, 30, 255],
  'o': [224, 212, 198, 235],
};

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = size / 16;

  // Rounded square mask radius in target pixels
  const corner = Math.max(2, Math.floor(size * 0.22));

  for (let y = 0; y < size; y++) {
    const ty = Math.min(15, Math.floor(y / scale));
    for (let x = 0; x < size; x++) {
      const tx = Math.min(15, Math.floor(x / scale));
      const ch = TEMPLATE_16[ty][tx];
      const col = PALETTE[ch] || PALETTE['.'];

      // Check rounded corners for clean extension icon silhouette
      let alpha = col[3];
      const dx = Math.max(corner - x - 0.5, x + 0.5 - (size - corner), 0);
      const dy = Math.max(corner - y - 0.5, y + 0.5 - (size - corner), 0);
      if (dx > 0 && dy > 0 && Math.hypot(dx, dy) > corner) {
        alpha = 0;
      }

      // Subtle border highlight inside rounded edge on >= 48px
      let [r, g, b] = col;
      if (alpha > 0 && size >= 48) {
        const edgeDist = Math.min(x, y, size - 1 - x, size - 1 - y);
        if (edgeDist === 0 || (dx > 0 && dy > 0 && Math.hypot(dx, dy) > corner - 1.2)) {
          r = Math.min(255, r + 24);
          g = Math.min(255, g + 36);
          b = Math.min(255, b + 40);
        }
      }

      const idx = (y * size + x) * 4;
      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = alpha;
    }
  }

  return encodePNG(size, size, rgba);
}

for (const size of [16, 48, 128]) {
  const out = path.join(ICONS_DIR, `icon${size}.png`);
  fs.writeFileSync(out, renderIcon(size));
  console.log(`Generated ${out}`);
}
