import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const UNITS = 32;
const SCALE = SIZE / UNITS;
const PIXEL = 1 / SCALE;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(scriptDirectory, '..', 'assets', 'icon.png');

function cubic(p0, p1, p2, p3, steps = 64) {
  const points = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const mt = 1 - t;
    points.push({
      x: mt ** 3 * p0.x + 3 * mt ** 2 * t * p1.x + 3 * mt * t ** 2 * p2.x + t ** 3 * p3.x,
      y: mt ** 3 * p0.y + 3 * mt ** 2 * t * p1.y + 3 * mt * t ** 2 * p2.y + t ** 3 * p3.y
    });
  }
  return points;
}

const shield = [
  { x: 6, y: 7 },
  { x: 16, y: 3 },
  { x: 26, y: 7 },
  { x: 26, y: 16 },
  ...cubic({ x: 26, y: 16 }, { x: 26, y: 22.5 }, { x: 16, y: 29 }, { x: 16, y: 29 }),
  ...cubic({ x: 16, y: 29 }, { x: 16, y: 29 }, { x: 6, y: 22.5 }, { x: 6, y: 16 }),
  { x: 6, y: 7 }
];

const glyph = [
  { x: 20, y: 11 },
  { x: 13.5, y: 11 },
  ...cubic({ x: 13.5, y: 11 }, { x: 12.1193, y: 11 }, { x: 11, y: 12.1193 }, { x: 11, y: 13.5 }),
  ...cubic({ x: 11, y: 13.5 }, { x: 11, y: 14.8807 }, { x: 12.1193, y: 16 }, { x: 13.5, y: 16 }),
  { x: 18.5, y: 16 },
  ...cubic({ x: 18.5, y: 16 }, { x: 19.8807, y: 16 }, { x: 21, y: 17.1193 }, { x: 21, y: 18.5 }),
  ...cubic({ x: 21, y: 18.5 }, { x: 21, y: 19.8807 }, { x: 19.8807, y: 21 }, { x: 18.5, y: 21 }),
  { x: 11, y: 21 }
];

function distanceToSegment(px, py, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lengthSquared));
  const x = a.x + t * dx;
  const y = a.y + t * dy;
  return Math.hypot(px - x, py - y);
}

function distanceToPolyline(px, py, points) {
  let best = Infinity;
  for (let i = 1; i < points.length; i += 1) {
    best = Math.min(best, distanceToSegment(px, py, points[i - 1], points[i]));
  }
  return best;
}

function coverage(distance, halfWidth) {
  return Math.max(0, Math.min(1, (halfWidth + PIXEL / 2 - distance) / PIXEL));
}

function insideRoundedRect(x, y, radius) {
  const cx = Math.max(radius, Math.min(UNITS - radius, x));
  const cy = Math.max(radius, Math.min(UNITS - radius, y));
  return Math.hypot(x - cx, y - cy) <= radius;
}

function hexToRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function blend(target, index, color, alpha) {
  if (alpha <= 0) return;
  target[index] = Math.round(target[index] * (1 - alpha) + color.r * alpha);
  target[index + 1] = Math.round(target[index + 1] * (1 - alpha) + color.g * alpha);
  target[index + 2] = Math.round(target[index + 2] * (1 - alpha) + color.b * alpha);
  target[index + 3] = Math.round(target[index + 3] * (1 - alpha) + 255 * alpha);
}

const background = hexToRgb('#090a0d');
const glow = hexToRgb('#7c3aed');
const shieldColor = hexToRgb('#f4f4f5');
const glyphColor = hexToRgb('#10b981');
const dotColor = hexToRgb('#34d399');
const cornerRadius = 6.5;

const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const ux = (x + 0.5) / SCALE;
    const uy = (y + 0.5) / SCALE;
    const index = (y * SIZE + x) * 4;

    const edge = insideRoundedRect(ux, uy, cornerRadius) ? 1 : 0;
    if (!edge) {
      pixels[index + 3] = 0;
      continue;
    }

    blend(pixels, index, background, 1);

    const glowDistance = Math.hypot(ux - 10, uy - 7);
    const glowAlpha = Math.max(0, 1 - glowDistance / 24) ** 2 * 0.28;
    blend(pixels, index, glow, glowAlpha);

    const shieldDistance = distanceToPolyline(ux, uy, shield);
    blend(pixels, index, shieldColor, coverage(shieldDistance, 1.1));

    const glyphDistance = distanceToPolyline(ux, uy, glyph);
    blend(pixels, index, glyphColor, coverage(glyphDistance, 1.2));

    for (const dot of [{ x: 11, y: 11 }, { x: 21, y: 21 }]) {
      const dotDistance = Math.hypot(ux - dot.x, uy - dot.y);
      blend(pixels, index, dotColor, coverage(dotDistance, 1.5));
    }
  }
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0;
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8;
header[9] = 6;
header[10] = 0;
header[11] = 0;
header[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, png);
console.log(`Wrote ${outputPath} (${SIZE}x${SIZE}, ${Math.round(png.length / 1024)} KB)`);
