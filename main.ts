// SPDX-License-Identifier: MIT
//
// news-image-01 entry: "The World on Friday 13 November 2026".
// A hand-drawn front page summing up the day's world news, rendered
// procedurally with the Node standard library only (node:fs, node:path,
// node:zlib). No network, no clock, no randomness: two runs write
// byte-identical PNGs to /output/entry.png (or $MAKEFUN_OUTPUT_DIR).
//
// Stories depicted (all first reported on Friday 13 Nov 2026):
//   1. Nvidia chief Jensen Huang resigns; shares fall 16%; CFO Colette
//      Kress named interim CEO; Huang and Commerce Secretary Lutnick
//      summoned by the US Senate Banking Committee.
//   2. Europe wins a seat at the Ukraine peace talks: US envoys Witkoff
//      and Kushner meet Zelensky in Dublin after talks with Putin.
//   3. A Ukrainian drone hits the Russian warship Naro-Fominsk in the
//      Gulf of Finland, the first such strike in open Baltic waters.
//   4. Iran claims it struck a US radar site in Bahrain; four tankers
//      hit in the Strait of Hormuz.
//   5. Microsoft 365 goes down worldwide: mail and Teams offline.
//   6. FBI: North Korean hackers stole $400m in crypto through fake
//      video calls; DOJ moves to seize $1.2bn from the Binance hack.
// Footer: Kane breaks England's caps record (126); Israeli strike on a
// Gaza hospital kills six; US deportations hit a record 483,200 in 2026;
// Pope Leo meets abuse survivors in Peru.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

// ---------------------------------------------------------------- PNG ---

// CRC-32 (IEEE) table, built once at load.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// Encode an RGB buffer (width*height*3) as a deterministic PNG.
function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0; // filter: none
    rgb.copy(raw, y * (1 + width * 3) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------- canvas ---

const W = 1024;
const H = 1024;

class Canvas {
  constructor(w, h, fill) {
    this.w = w;
    this.h = h;
    this.px = Buffer.alloc(w * h * 3);
    this.fillRect(0, 0, w, h, fill);
  }
  set(x, y, c) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    this.px[i] = c[0];
    this.px[i + 1] = c[1];
    this.px[i + 2] = c[2];
  }
  fillRect(x, y, w, h, c) {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.w, x + w);
    const y1 = Math.min(this.h, y + h);
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const i = (yy * this.w + xx) * 3;
        this.px[i] = c[0];
        this.px[i + 1] = c[1];
        this.px[i + 2] = c[2];
      }
    }
  }
  // Filled circle.
  disc(cx, cy, r, c) {
    for (let y = cy - r; y <= cy + r; y++) {
      const dy = y - cy;
      const dx = Math.floor(Math.sqrt(r * r - dy * dy));
      for (let x = cx - dx; x <= cx + dx; x++) this.set(x, y, c);
    }
  }
  // Filled ellipse.
  ellipse(cx, cy, rx, ry, c) {
    for (let y = cy - ry; y <= cy + ry; y++) {
      const t = (y - cy) / ry;
      const dx = Math.floor(rx * Math.sqrt(Math.max(0, 1 - t * t)));
      for (let x = cx - dx; x <= cx + dx; x++) this.set(x, y, c);
    }
  }
  // Bresenham line, thickness 1 (or t for a square brush).
  line(x0, y0, x1, y1, c, t = 1) {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let x = x0;
    let y = y0;
    for (;;) {
      this.fillRect(x - Math.floor(t / 2), y - Math.floor(t / 2), t, t, c);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  }
  // Filled triangle.
  tri(x0, y0, x1, y1, x2, y2, c) {
    const minY = Math.min(y0, y1, y2);
    const maxY = Math.max(y0, y1, y2);
    for (let y = minY; y <= maxY; y++) {
      const xs = [];
      const edges = [[x0, y0, x1, y1], [x1, y1, x2, y2], [x2, y2, x0, y0]];
      for (const [ax, ay, bx, by] of edges) {
        if ((ay <= y && by > y) || (by <= y && ay > y)) {
          xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
        }
      }
      if (xs.length >= 2) {
        const a = Math.min(...xs);
        const b = Math.max(...xs);
        for (let x = Math.ceil(a); x <= Math.floor(b); x++) this.set(x, y, c);
      }
    }
  }
}

// --------------------------------------------------------------- font ---
// 5x7 bitmap font, uppercase + digits + punctuation. Each glyph is 7 rows
// of 5 bits ('1' = ink). Space advances like any other character.

const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ',': ['00000', '00000', '00000', '00000', '01100', '00100', '01000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '-': ['00000', '00000', '00000', '01110', '00000', '00000', '00000'],
  "'": ['00100', '00100', '01000', '00000', '00000', '00000', '00000'],
  '%': ['11001', '11010', '00010', '00100', '01000', '01011', '10011'],
  $: ['00100', '01111', '10100', '01110', '00101', '11110', '00100'],
  '&': ['01100', '10010', '10100', '01000', '10101', '10010', '01101'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '?': ['01110', '10001', '00001', '00110', '00100', '00000', '00100'],
  '+': ['00000', '00100', '00100', '01110', '00100', '00100', '00000'],
  '=': ['00000', '00000', '11111', '00000', '11111', '00000', '00000'],
  '•': ['00000', '00100', '01110', '01110', '01110', '00100', '00000'],
};

const ADVANCE = 6; // glyph width 5 + 1 gap, in font units

function textWidth(str, scale) {
  return str.length * ADVANCE * scale - scale;
}

function drawChar(cv, x, y, ch, scale, color) {
  const glyph = FONT[ch] ?? FONT['?'];
  for (let r = 0; r < 7; r++) {
    for (let col = 0; col < 5; col++) {
      if (glyph[r][col] === '1') {
        cv.fillRect(x + col * scale, y + r * scale, scale, scale, color);
      }
    }
  }
}

function drawText(cv, x, y, str, scale, color) {
  let cx = x;
  for (const ch of str) {
    drawChar(cv, cx, y, ch, scale, color);
    cx += ADVANCE * scale;
  }
}

function drawTextCentered(cv, cx, y, str, scale, color) {
  drawText(cv, cx - Math.floor(textWidth(str, scale) / 2), y, str, scale, color);
}

// Greedy word wrap to maxWidth pixels; returns lines.
function wrapText(str, maxWidth, scale) {
  const words = str.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const trial = cur ? cur + ' ' + w : w;
    if (textWidth(trial, scale) <= maxWidth || !cur) {
      cur = trial;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function drawWrappedCentered(cv, cx, y, str, scale, color, maxWidth, lineGap) {
  const lines = wrapText(str, maxWidth, scale);
  const lh = 7 * scale + lineGap;
  lines.forEach((ln, i) => drawTextCentered(cv, cx, y + i * lh, ln, scale, color));
  return lines.length;
}

// -------------------------------------------------------------- palette ---

const INK = [24, 24, 28];
const PAPER = [247, 245, 240];
const NAVY = [20, 33, 61];
const RED = [192, 57, 43];
const WHITE = [255, 255, 255];
const GREY = [110, 116, 124];
const LIGHT_GREY = [226, 224, 218];

// --------------------------------------------------------------- scenes ---
// Each scene draws inside a panel's picture area: x, y is the top-left,
// w the panel width (496), the picture is ~140 tall.

function sceneChip(cv, x, y, w) {
  const cx = x + 130;
  const cy = y + 70;
  // Chip body with pins.
  cv.fillRect(cx - 52, cy - 52, 104, 104, [27, 122, 61]);
  cv.fillRect(cx - 34, cy - 34, 68, 68, [46, 160, 84]);
  cv.fillRect(cx - 18, cy - 18, 36, 36, [20, 33, 61]);
  for (let i = 0; i < 5; i++) {
    const off = -40 + i * 20;
    cv.fillRect(cx + off - 3, cy - 64, 6, 12, [212, 175, 55]);
    cv.fillRect(cx + off - 3, cy + 52, 6, 12, [212, 175, 55]);
    cv.fillRect(cx - 64, cy + off - 3, 12, 6, [212, 175, 55]);
    cv.fillRect(cx + 52, cy + off - 3, 12, 6, [212, 175, 55]);
  }
  drawTextCentered(cv, cx, cy - 11, 'NV', 3, WHITE);
  // Red down arrow + -16%.
  const ax = x + 330;
  const ay = y + 22;
  cv.fillRect(ax + 14, ay, 18, 62, RED);
  cv.tri(ax, ay + 62, ax + 46, ay + 62, ax + 23, ay + 104, RED);
  drawText(cv, x + 300, y + 118, '-16%', 3, RED);
}

function sceneTalks(cv, x, y, w) {
  // Three flags on poles above a round table.
  const poleY = y + 12;
  const poleH = 62;
  const flagW = 64;
  const flagH = 34;
  const centres = [x + 96, x + 248, x + 400];
  const flags = [
    // Ukraine: blue over yellow.
    (fx, fy) => {
      cv.fillRect(fx, fy, flagW, flagH / 2, [0, 91, 187]);
      cv.fillRect(fx, fy + flagH / 2, flagW, flagH / 2, [255, 213, 0]);
    },
    // USA: stripes + blue canton (canton kept small so stripes read).
    (fx, fy) => {
      for (let s = 0; s < 7; s++) {
        cv.fillRect(fx, fy + Math.floor((s * flagH) / 7), flagW, Math.ceil(flagH / 7), s % 2 === 0 ? [178, 34, 52] : WHITE);
      }
      cv.fillRect(fx, fy, 26, 15, [20, 33, 61]);
      cv.disc(fx + 7, fy + 5, 2, WHITE);
      cv.disc(fx + 18, fy + 10, 2, WHITE);
    },
    // EU: blue field, ring of stars.
    (fx, fy) => {
      cv.fillRect(fx, fy, flagW, flagH, [0, 51, 153]);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        cv.disc(fx + 32 + Math.round(11 * Math.cos(a)), fy + 17 + Math.round(9 * Math.sin(a)), 2, [255, 213, 0]);
      }
    },
  ];
  centres.forEach((cx, i) => {
    cv.fillRect(cx - 2, poleY, 4, poleH, [90, 80, 70]);
    flags[i](cx - flagW / 2, poleY + 4);
  });
  // Round table.
  cv.ellipse(x + 248, y + 108, 150, 26, [120, 84, 50]);
  cv.fillRect(x + 228, y + 108, 40, 26, [96, 66, 38]);
  cv.fillRect(x + 118, y + 100, 16, 10, WHITE);
  cv.fillRect(x + 358, y + 100, 16, 10, WHITE);
}

function sceneWarship(cv, x, y, w) {
  // Sky, sea, grey warship, smoke, drone.
  cv.fillRect(x + 16, y + 96, w - 32, 44, [52, 110, 164]);
  cv.fillRect(x + 16, y + 118, w - 32, 4, [255, 255, 255]);
  // Hull: trapezoid.
  const hx = x + 90;
  const hy = y + 66;
  cv.tri(hx, hy + 30, hx + 300, hy + 30, hx + 316, hy, [90, 100, 110]);
  cv.fillRect(hx + 10, hy, 290, 30, [90, 100, 110]);
  // Superstructure + mast + funnel.
  cv.fillRect(hx + 130, hy - 30, 90, 30, [110, 120, 130]);
  cv.fillRect(hx + 165, hy - 52, 8, 24, [70, 78, 88]);
  cv.fillRect(hx + 60, hy - 20, 26, 20, [70, 78, 88]);
  // Smoke.
  cv.disc(hx + 73, hy - 30, 12, [150, 150, 150]);
  cv.disc(hx + 66, hy - 46, 15, [170, 170, 170]);
  cv.disc(hx + 82, hy - 58, 11, [190, 190, 190]);
  // Drone top-right with dashed approach line.
  const dx = x + 420;
  const dy = y + 26;
  cv.line(dx - 70, dy + 34, dx - 14, dy + 8, GREY, 2);
  cv.fillRect(dx - 12, dy - 6, 24, 12, INK);
  cv.fillRect(dx - 22, dy - 10, 10, 4, INK);
  cv.fillRect(dx + 12, dy - 10, 10, 4, INK);
  cv.fillRect(dx - 22, dy + 6, 10, 4, INK);
  cv.fillRect(dx + 12, dy + 6, 10, 4, INK);
}

function sceneRadar(cv, x, y, w) {
  // Desert coast, radar dome, missile streak.
  cv.fillRect(x + 16, y + 8, w - 32, 44, [246, 214, 160]);
  cv.disc(x + 420, y + 30, 18, [240, 180, 60]);
  cv.fillRect(x + 16, y + 100, w - 32, 40, [52, 110, 164]);
  // Radar dome on a base, grey outline so it reads on the paper.
  const bx = x + 120;
  const by = y + 100;
  cv.fillRect(bx - 8, by - 18, 16, 18, [120, 120, 120]);
  cv.ellipse(bx, by - 18, 55, 43, [150, 150, 150]);
  cv.ellipse(bx, by - 18, 52, 40, WHITE);
  cv.fillRect(bx - 52, by - 22, 104, 6, [200, 200, 200]);
  // Dish on top of the dome.
  cv.line(bx, by - 56, bx + 22, by - 72, [120, 120, 120], 3);
  cv.line(bx + 22, by - 72, bx + 30, by - 62, [120, 120, 120], 3);
  // Missile streak from top right.
  cv.line(x + 300, y + 8, x + 430, y + 66, RED, 4);
  cv.tri(x + 430, y + 66, x + 414, y + 52, x + 446, y + 58, RED);
  cv.disc(x + 300, y + 8, 6, [255, 160, 40]);
  // Small second dome.
  cv.ellipse(x + 330, y + 100, 30, 22, [230, 230, 230]);
}

function sceneOutage(cv, x, y, w) {
  // Monitor with a red X, envelope, plug.
  const mx = x + 90;
  const my = y + 14;
  cv.fillRect(mx, my, 170, 104, [30, 40, 60]);
  cv.fillRect(mx + 8, my + 8, 154, 80, [200, 220, 235]);
  cv.fillRect(mx + 70, my + 118, 30, 12, [30, 40, 60]);
  cv.fillRect(mx + 40, my + 130, 90, 8, [30, 40, 60]);
  // Red X on screen.
  cv.line(mx + 34, my + 26, mx + 136, my + 70, RED, 7);
  cv.line(mx + 136, my + 26, mx + 34, my + 70, RED, 7);
  // Envelope (mail) at right.
  const ex = x + 300;
  const ey = y + 40;
  cv.fillRect(ex, ey, 120, 74, WHITE);
  cv.fillRect(ex, ey, 120, 74, WHITE);
  cv.line(ex + 2, ey + 2, ex + 60, ey + 40, [150, 160, 175], 3);
  cv.line(ex + 118, ey + 2, ex + 60, ey + 40, [150, 160, 175], 3);
  cv.fillRect(ex, ey, 120, 4, [150, 160, 175]);
  cv.fillRect(ex, ey + 70, 120, 4, [150, 160, 175]);
  cv.fillRect(ex, ey, 4, 74, [150, 160, 175]);
  cv.fillRect(ex + 116, ey, 4, 74, [150, 160, 175]);
  // Small "365" tag.
  drawText(cv, x + 322, y + 118, '365', 2, INK);
}

function sceneHack(cv, x, y, w) {
  // Laptop with masked face on a video call, coins spilling out.
  const lx = x + 100;
  const ly = y + 10;
  cv.fillRect(lx, ly, 220, 112, INK);
  cv.fillRect(lx + 8, ly + 8, 204, 96, [24, 90, 110]);
  // Masked face: dark hood + white mask.
  cv.ellipse(lx + 110, ly + 56, 34, 38, [20, 20, 26]);
  cv.ellipse(lx + 110, ly + 58, 24, 28, WHITE);
  cv.fillRect(lx + 96, ly + 50, 10, 5, INK);
  cv.fillRect(lx + 114, ly + 50, 10, 5, INK);
  cv.fillRect(lx + 104, ly + 72, 12, 3, INK);
  // Laptop base.
  cv.fillRect(lx - 24, ly + 122, 268, 10, [60, 60, 66]);
  // Falling gold coins with $.
  const coins = [[x + 380, y + 30], [x + 410, y + 62], [x + 360, y + 92], [x + 420, y + 104]];
  for (const [cx, cy] of coins) {
    cv.disc(cx, cy, 16, [212, 175, 55]);
    cv.disc(cx, cy, 12, [240, 200, 90]);
    drawTextCentered(cv, cx, cy - 7, '$', 2, [140, 110, 20]);
  }
}

// -------------------------------------------------------------- layout ---

function drawPanel(cv, x, y, w, h, accent, scene, caption, sub) {
  cv.fillRect(x, y, w, h, PAPER);
  cv.fillRect(x, y, w, 8, accent);
  cv.fillRect(x, y, w, 2, INK);
  cv.fillRect(x, y + h - 2, w, 2, INK);
  cv.fillRect(x, y, 2, h, INK);
  cv.fillRect(x + w - 2, y, 2, h, INK);
  scene(cv, x + 8, y + 14, w - 16);
  const capY = y + 168;
  drawWrappedCentered(cv, x + w / 2, capY, caption, 3, INK, w - 28, 6);
  const lines = wrapText(caption, w - 28, 3).length;
  const subY = capY + lines * (7 * 3 + 6) + 8;
  drawTextCentered(cv, x + w / 2, subY, sub, 2, GREY);
}

function drawFrontPage() {
  const cv = new Canvas(W, H, PAPER);

  // Masthead.
  cv.fillRect(0, 0, W, 112, NAVY);
  drawTextCentered(cv, W / 2, 16, 'THE WORLD TODAY', 5, WHITE);
  drawTextCentered(cv, W / 2, 62, 'FRIDAY 13 NOVEMBER 2026', 3, [255, 213, 0]);
  cv.fillRect(32, 100, W - 64, 4, RED);

  // Six panels, 2 columns x 3 rows.
  const px = 16;
  const py = 128;
  const pw = 488;
  const ph = 272;
  const gx = 16;
  const gy = 12;
  const panels = [
    {
      accent: [27, 122, 61],
      scene: sceneChip,
      caption: 'HUANG RESIGNS, NVIDIA SHARES -16%',
      sub: 'CEO OUT, COLETTE KRESS INTERIM',
    },
    {
      accent: [42, 93, 176],
      scene: sceneTalks,
      caption: 'EUROPE JOINS UKRAINE PEACE TALKS',
      sub: 'ZELENSKY MEETS US ENVOYS IN DUBLIN',
    },
    {
      accent: [90, 100, 110],
      scene: sceneWarship,
      caption: 'DRONE HITS RUSSIAN WARSHIP',
      sub: 'GULF OF FINLAND, FIRST IN OPEN SEA',
    },
    {
      accent: [183, 121, 31],
      scene: sceneRadar,
      caption: 'IRAN CLAIMS STRIKE ON US RADAR',
      sub: 'BAHRAIN - CLAIM NOT VERIFIED',
    },
    {
      accent: [192, 57, 43],
      scene: sceneOutage,
      caption: 'MICROSOFT 365 DOWN WORLDWIDE',
      sub: 'MAIL AND TEAMS OFFLINE GLOBALLY',
    },
    {
      accent: [108, 52, 131],
      scene: sceneHack,
      caption: 'FBI: N. KOREA $400M CRYPTO HACK',
      sub: 'FAKE VIDEO CALLS, DOJ SEIZES $1.2BN',
    },
  ];
  panels.forEach((p, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    drawPanel(cv, px + col * (pw + gx), py + row * (ph + gy), pw, ph, p.accent, p.scene, p.caption, p.sub);
  });

  // Footer strip: more of the day.
  const fy = py + 3 * ph + 2 * gy + 8;
  cv.fillRect(0, fy, W, H - fy, NAVY);
  drawTextCentered(cv, W / 2, fy + 10, 'ALSO: KANE BREAKS ENGLAND CAPS RECORD (126) • ISRAEL STRIKE ON GAZA HOSPITAL KILLS 6', 2, WHITE);
  drawTextCentered(cv, W / 2, fy + 32, 'US DEPORTATIONS HIT RECORD 483,200 IN 2026 • POPE LEO MEETS ABUSE SURVIVORS IN PERU', 2, [255, 213, 0]);

  return cv;
}

// ----------------------------------------------------------------- main ---

const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });
const png = encodePng(W, H, drawFrontPage().px);
writeFileSync(join(outDir, 'entry.png'), png);
