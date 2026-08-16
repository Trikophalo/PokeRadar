/**
 * Procedurally drawn shelf photography for the demo sightings.
 *
 * Seed posts need pictures, and the honest options were a third-party image
 * host (a runtime dependency that can break) or shipping copyrighted product
 * shots (which we will not do). So the demo draws its own: original geometric
 * "collectible" packaging on a shelf, deterministic per seed, generated in the
 * browser. Real user posts use the camera instead.
 */

import { rngFrom, pick } from './util.js';

const cache = new Map();

const PALETTES = [
  { name: 'ember',   base: '#D5372A', deep: '#8E1C16', light: '#FF8A6B', ink: '#2A0D0A' },
  { name: 'tide',    base: '#2C6FD1', deep: '#173F82', light: '#79B4F5', ink: '#0B1B33' },
  { name: 'meadow',  base: '#2E9C63', deep: '#166139', light: '#7BD6A2', ink: '#0B2418' },
  { name: 'dusk',    base: '#7A4FD0', deep: '#452a82', light: '#B79BF2', ink: '#1A1030' },
  { name: 'amber',   base: '#E0A21C', deep: '#96660A', light: '#FFD673', ink: '#33230A' },
  { name: 'rose',    base: '#D64B86', deep: '#8C2453', light: '#F79CC2', ink: '#33101F' },
  { name: 'slate',   base: '#4A5A6B', deep: '#293440', light: '#9AAAB9', ink: '#141A20' },
  { name: 'citrus',  base: '#4FB03A', deep: '#2A6B1E', light: '#A5E88F', ink: '#132808' },
];

const FORMS = ['pack', 'box', 'tin', 'blister'];

/**
 * @param {string} seed  stable identifier — same seed always draws the same photo
 * @param {{width?:number, height?:number, form?:string}} [opts]
 * @returns {string} a JPEG data URL
 */
export function productPhoto(seed, opts = {}) {
  const key = `${seed}:${opts.width || 640}:${opts.form || 'auto'}`;
  if (cache.has(key)) return cache.get(key);

  const width = opts.width || 640;
  const height = opts.height || Math.round(width * 0.75);
  const rand = rngFrom(seed);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const palette = PALETTES[Math.floor(rand() * PALETTES.length)];
  const form = opts.form || pick(rand, FORMS);

  drawShelf(ctx, width, height, rand);
  drawProducts(ctx, width, height, rand, palette, form);
  drawLighting(ctx, width, height, rand);

  const url = canvas.toDataURL('image/jpeg', 0.72);
  cache.set(key, url);
  return url;
}

/* ------------------------------------------------------------- backdrop --- */

function drawShelf(ctx, w, h, rand) {
  const warmth = 8 + rand() * 14;
  const wall = ctx.createLinearGradient(0, 0, 0, h);
  wall.addColorStop(0, `hsl(${30 + warmth}, 12%, ${78 + rand() * 6}%)`);
  wall.addColorStop(1, `hsl(${30 + warmth}, 10%, ${62 + rand() * 6}%)`);
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, w, h);

  // Back-of-shelf pegboard texture, kept faint so products stay dominant.
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = '#000';
  const step = 18 + rand() * 8;
  for (let y = step; y < h * 0.84; y += step) {
    for (let x = step; x < w; x += step) {
      ctx.beginPath();
      ctx.arc(x, y, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // Shelf lip the products stand on.
  const lipY = h * (0.855 + rand() * 0.03);
  const lip = ctx.createLinearGradient(0, lipY - 12, 0, h);
  lip.addColorStop(0, 'rgba(0,0,0,0.20)');
  lip.addColorStop(0.14, '#C9C3B8');
  lip.addColorStop(1, '#8E887E');
  ctx.fillStyle = lip;
  ctx.fillRect(0, lipY, w, h - lipY);

  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillRect(0, lipY + (h - lipY) * 0.18, w, 2);
}

/* ------------------------------------------------------------- products --- */

function drawProducts(ctx, w, h, rand, palette, form) {
  // Products fill most of the frame: these images are read at 40 px inside a
  // map marker, where a wide shelf shot turns into an indistinct grey dot.
  const baseline = h * 0.88;
  const count = form === 'box' ? 1 : 2 + Math.floor(rand() * 2);
  const slotWidth = w / (count + 0.35);

  for (let i = 0; i < count; i++) {
    const jitter = (rand() - 0.5) * slotWidth * 0.18;
    const cx = slotWidth * (i + 0.8) + jitter;
    const scale = 0.82 + rand() * 0.22;
    const tilt = (rand() - 0.5) * 0.07;
    const shade = i / Math.max(1, count - 1);

    ctx.save();
    ctx.translate(cx, baseline);
    ctx.rotate(tilt);
    ctx.scale(scale, scale);
    drawOne(ctx, rand, palette, form, shade);
    ctx.restore();
  }
}

function drawOne(ctx, rand, palette, form, shade) {
  const dims = {
    pack:    { w: 168, h: 268, r: 11 },
    box:     { w: 330, h: 250, r: 14 },
    tin:     { w: 232, h: 176, r: 22 },
    blister: { w: 190, h: 292, r: 9 },
  }[form];

  const x = -dims.w / 2;
  const y = -dims.h;

  // Contact shadow.
  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(0, 5, dims.w * 0.56, 12, 0, 0, Math.PI * 2);
  ctx.filter = 'blur(3px)';
  ctx.fill();
  ctx.restore();

  // Body.
  const body = ctx.createLinearGradient(x, y, x + dims.w, y + dims.h);
  body.addColorStop(0, palette.light);
  body.addColorStop(0.45, palette.base);
  body.addColorStop(1, palette.deep);
  roundRect(ctx, x, y, dims.w, dims.h, dims.r);
  ctx.fillStyle = body;
  ctx.fill();

  // Foil band across the upper third.
  const bandH = dims.h * (0.10 + rand() * 0.05);
  const bandY = y + dims.h * 0.14;
  const foil = ctx.createLinearGradient(x, bandY, x + dims.w, bandY + bandH);
  foil.addColorStop(0, 'rgba(255,255,255,0.78)');
  foil.addColorStop(0.5, 'rgba(255,255,255,0.26)');
  foil.addColorStop(1, 'rgba(255,255,255,0.62)');
  ctx.fillStyle = foil;
  ctx.fillRect(x, bandY, dims.w, bandH);

  drawEmblem(ctx, rand, palette, x + dims.w / 2, y + dims.h * 0.55, dims.w * 0.3);

  // Title block + barcode-ish footer, suggesting packaging without any wordmark.
  ctx.fillStyle = 'rgba(255,255,255,0.82)';
  const tw = dims.w * 0.62;
  ctx.fillRect(x + (dims.w - tw) / 2, y + dims.h * 0.76, tw, 6);
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillRect(x + (dims.w - tw * 0.7) / 2, y + dims.h * 0.83, tw * 0.7, 4);

  ctx.fillStyle = palette.ink;
  for (let i = 0; i < 16; i++) {
    const bx = x + dims.w * 0.3 + i * (dims.w * 0.026);
    ctx.fillRect(bx, y + dims.h * 0.9, rand() > 0.5 ? 2.2 : 1.2, 11);
  }

  // Gloss.
  ctx.globalAlpha = 0.16 + shade * 0.08;
  const gloss = ctx.createLinearGradient(x, y, x + dims.w * 0.6, y + dims.h);
  gloss.addColorStop(0, '#fff');
  gloss.addColorStop(0.35, 'rgba(255,255,255,0)');
  roundRect(ctx, x, y, dims.w, dims.h, dims.r);
  ctx.fillStyle = gloss;
  ctx.fill();
  ctx.globalAlpha = 1;

  // Outline.
  roundRect(ctx, x, y, dims.w, dims.h, dims.r);
  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  ctx.lineWidth = 1.4;
  ctx.stroke();
}

/** An abstract badge — deliberately not resembling any real franchise mark. */
function drawEmblem(ctx, rand, palette, cx, cy, radius) {
  const style = Math.floor(rand() * 3);
  ctx.save();
  ctx.translate(cx, cy);

  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fill();
  ctx.strokeStyle = palette.ink;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = palette.deep;
  if (style === 0) {
    const points = 6;
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? radius * 0.66 : radius * 0.28;
      const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
      ctx[i === 0 ? 'moveTo' : 'lineTo'](Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
  } else if (style === 1) {
    ctx.beginPath();
    ctx.moveTo(0, -radius * 0.62);
    ctx.lineTo(radius * 0.58, radius * 0.4);
    ctx.lineTo(-radius * 0.58, radius * 0.4);
    ctx.closePath();
    ctx.fill();
  } else {
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(0, 0, radius * (0.62 - i * 0.2), 0, Math.PI * 2);
      ctx.strokeStyle = i % 2 ? palette.base : palette.deep;
      ctx.lineWidth = radius * 0.16;
      ctx.stroke();
    }
  }
  ctx.restore();
}

/* ------------------------------------------------------------- lighting --- */

function drawLighting(ctx, w, h, rand) {
  const glow = ctx.createRadialGradient(w * (0.3 + rand() * 0.4), h * 0.1, 10, w * 0.5, h * 0.5, w * 0.9);
  glow.addColorStop(0, 'rgba(255,248,230,0.34)');
  glow.addColorStop(1, 'rgba(255,248,230,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  const vignette = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.32, w / 2, h / 2, Math.max(w, h) * 0.78);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.34)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);

  // A little sensor grain so it reads as a phone photo rather than a vector.
  const grain = ctx.getImageData(0, 0, w, h);
  const data = grain.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (Math.random() - 0.5) * 13;
    data[i] += n;
    data[i + 1] += n;
    data[i + 2] += n;
  }
  ctx.putImageData(grain, 0, 0);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Flat colour tile used while a photo is still being drawn. */
export function placeholderFor(seed) {
  const rand = rngFrom(`ph:${seed}`);
  const p = PALETTES[Math.floor(rand() * PALETTES.length)];
  return p.base;
}
