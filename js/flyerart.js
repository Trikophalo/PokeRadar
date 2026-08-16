/**
 * Procedurally drawn flyer covers and pages.
 *
 * Real flyers are licensed retailer content: production deep-links into the
 * retailer's own viewer and never re-hosts pages (PLANNING.md §10.1). The
 * simulated feed has no viewer to link to, so the prototype draws its own
 * stand-in pages — generic layouts with no retailer logos or artwork.
 */

import { rngFrom } from './util.js';

const cache = new Map();

/** Plausible brand-ish colours, not reproductions of any retailer's mark. */
const CHAIN_COLORS = {
  'Müller':      { bg: '#F07E13', ink: '#FFFFFF' },
  'Rossmann':    { bg: '#D6002A', ink: '#FFFFFF' },
  'dm':          { bg: '#00327A', ink: '#FFFFFF' },
  'EDEKA':       { bg: '#1B4EA2', ink: '#FFFFFF' },
  'REWE':        { bg: '#C8102E', ink: '#FFFFFF' },
  'Kaufland':    { bg: '#B4141E', ink: '#FFFFFF' },
  'MediaMarkt':  { bg: '#E1091A', ink: '#FFFFFF' },
  'Thalia':      { bg: '#0F7BB8', ink: '#FFFFFF' },
  'Smyths Toys': { bg: '#8E2C8E', ink: '#FFFFFF' },
  'GameStop':    { bg: '#2B2F77', ink: '#FFFFFF' },
  'Galeria':     { bg: '#0B6B45', ink: '#FFFFFF' },
  'Netto':       { bg: '#FFD100', ink: '#1B1B1B' },
};

export const chainColor = (chain) => CHAIN_COLORS[chain] || { bg: '#4A5A6B', ink: '#FFFFFF' };

const GENERIC_OFFERS = [
  'Frische Milch 1 l', 'Kaffeebohnen 500 g', 'Waschmittel 2 kg', 'Zahnpasta 75 ml',
  'Duschgel 250 ml', 'Nudeln 500 g', 'Schokolade 100 g', 'Küchenrolle 4 Rollen',
  'Mineralwasser 6×1,5 l', 'Shampoo 300 ml', 'Batterien AA 8 St.', 'Taschentücher 30×10',
];

/* ---------------------------------------------------------------- cover --- */

export function flyerCover(flyer, { width = 300 } = {}) {
  const key = `cover:${flyer.id}:${width}`;
  if (cache.has(key)) return cache.get(key);

  const height = Math.round(width * 4 / 3);
  const { canvas, ctx } = surface(width, height);
  const rand = rngFrom(flyer.cover_seed || flyer.id);
  const color = chainColor(flyer.chain);
  const s = width / 300;                      // everything below is drawn at 300px wide

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  // Masthead
  const bandH = 78 * s;
  ctx.fillStyle = color.bg;
  ctx.fillRect(0, 0, width, bandH);
  ctx.fillStyle = color.ink;
  ctx.textAlign = 'center';
  ctx.font = `800 ${Math.round(30 * s)}px system-ui, sans-serif`;
  ctx.fillText(flyer.chain.toUpperCase(), width / 2, bandH * 0.52);
  ctx.font = `600 ${Math.round(11 * s)}px system-ui, sans-serif`;
  ctx.globalAlpha = 0.92;
  ctx.fillText('ANGEBOTE DER WOCHE', width / 2, bandH * 0.78);
  ctx.globalAlpha = 1;

  // Validity strip
  ctx.fillStyle = '#111114';
  ctx.fillRect(0, bandH, width, 22 * s);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `600 ${Math.round(10 * s)}px system-ui, sans-serif`;
  ctx.fillText(`gültig ${deShort(flyer.valid_from)} – ${deShort(flyer.valid_until)}`, width / 2, bandH + 15 * s);

  // Offer grid
  const top = bandH + 34 * s;
  const pad = 12 * s;
  const cellW = (width - pad * 3) / 2;
  const cellH = (height - top - pad * 3) / 2;
  for (let i = 0; i < 4; i++) {
    const cx = pad + (i % 2) * (cellW + pad);
    const cy = top + Math.floor(i / 2) * (cellH + pad);
    drawOfferTile(ctx, cx, cy, cellW, cellH, rand, s, {
      label: GENERIC_OFFERS[Math.floor(rand() * GENERIC_OFFERS.length)],
      price: `${1 + Math.floor(rand() * 9)},${['49', '99', '95'][Math.floor(rand() * 3)]}`,
    });
  }

  const url = canvas.toDataURL('image/jpeg', 0.78);
  cache.set(key, url);
  return url;
}

/* ----------------------------------------------------------------- page --- */

export function flyerPage(flyer, pageNumber, { width = 640 } = {}) {
  const key = `page:${flyer.id}:${pageNumber}:${width}`;
  if (cache.has(key)) return cache.get(key);

  const height = Math.round(width * 1.35);
  const { canvas, ctx } = surface(width, height);
  const rand = rngFrom(`${flyer.cover_seed || flyer.id}:p${pageNumber}`);
  const color = chainColor(flyer.chain);
  const s = width / 640;
  const match = (flyer.matches || []).find((m) => m.page === pageNumber);

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  // Running header
  const headH = 46 * s;
  ctx.fillStyle = color.bg;
  ctx.fillRect(0, 0, width, headH);
  ctx.fillStyle = color.ink;
  ctx.textAlign = 'left';
  ctx.font = `800 ${Math.round(19 * s)}px system-ui, sans-serif`;
  ctx.fillText(flyer.chain.toUpperCase(), 18 * s, headH * 0.64);
  ctx.textAlign = 'right';
  ctx.font = `600 ${Math.round(12 * s)}px system-ui, sans-serif`;
  ctx.fillText(`Seite ${pageNumber} / ${flyer.page_count}`, width - 18 * s, headH * 0.62);

  const pad = 14 * s;
  const top = headH + pad;
  const cols = 2;
  const rows = 3;
  const cellW = (width - pad * (cols + 1)) / cols;
  const cellH = (height - top - pad * rows) / rows;

  // The matched offer takes the hero cell so the page reads at a glance.
  const heroIndex = match ? 0 : -1;
  for (let i = 0; i < cols * rows; i++) {
    const cx = pad + (i % cols) * (cellW + pad);
    const cy = top + Math.floor(i / cols) * (cellH + pad);
    if (i === heroIndex) {
      drawOfferTile(ctx, cx, cy, cellW, cellH, rand, s, {
        label: match.offer_title || 'Pokémon Sammelkarten',
        price: (match.price || '').replace(' €', '') || '9,99',
        highlight: true,
        tag: 'SAMMELKARTEN',
      });
    } else {
      drawOfferTile(ctx, cx, cy, cellW, cellH, rand, s, {
        label: GENERIC_OFFERS[Math.floor(rand() * GENERIC_OFFERS.length)],
        price: `${1 + Math.floor(rand() * 12)},${['49', '99', '95'][Math.floor(rand() * 3)]}`,
      });
    }
  }

  const url = canvas.toDataURL('image/jpeg', 0.8);
  cache.set(key, url);
  return url;
}

/* ----------------------------------------------------------------- tile --- */

function drawOfferTile(ctx, x, y, w, h, rand, s, { label, price, highlight = false, tag = null }) {
  ctx.save();
  roundRect(ctx, x, y, w, h, 8 * s);
  ctx.fillStyle = highlight ? '#FFF6F3' : '#F6F6F8';
  ctx.fill();
  ctx.strokeStyle = highlight ? '#E3350D' : '#E6E6EA';
  ctx.lineWidth = highlight ? 2.4 * s : 1 * s;
  ctx.stroke();
  ctx.clip();

  // Product silhouette
  const artH = h * 0.5;
  const bw = w * (0.3 + rand() * 0.12);
  const bh = artH * (0.72 + rand() * 0.2);
  const bx = x + w / 2 - bw / 2;
  const by = y + h * 0.1 + (artH - bh) / 2;
  const hue = highlight ? 6 : Math.floor(rand() * 360);
  const grad = ctx.createLinearGradient(bx, by, bx + bw, by + bh);
  grad.addColorStop(0, `hsl(${hue} ${highlight ? 82 : 46}% 62%)`);
  grad.addColorStop(1, `hsl(${hue + 18} ${highlight ? 76 : 42}% 40%)`);
  roundRect(ctx, bx, by, bw, bh, 5 * s);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillRect(bx, by + bh * 0.24, bw, bh * 0.12);

  if (tag) {
    ctx.fillStyle = '#E3350D';
    const tw = ctx.measureText(tag).width;
    roundRect(ctx, x + 8 * s, y + 8 * s, tw + 16 * s, 16 * s, 8 * s);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left';
    ctx.font = `700 ${Math.round(9 * s)}px system-ui, sans-serif`;
    ctx.fillText(tag, x + 16 * s, y + 19.5 * s);
  }

  // Name, wrapped to two lines
  ctx.fillStyle = '#1B1B20';
  ctx.textAlign = 'center';
  ctx.font = `${highlight ? 700 : 600} ${Math.round(11 * s)}px system-ui, sans-serif`;
  const lines = wrap(ctx, label, w - 16 * s).slice(0, 2);
  lines.forEach((line, i) => {
    ctx.fillText(line, x + w / 2, y + h * 0.68 + i * 13 * s);
  });

  // Price badge
  const badgeW = w * 0.44;
  const badgeH = 22 * s;
  roundRect(ctx, x + w / 2 - badgeW / 2, y + h - badgeH - 10 * s, badgeW, badgeH, 6 * s);
  ctx.fillStyle = highlight ? '#E3350D' : '#1B1B20';
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `800 ${Math.round(13 * s)}px system-ui, sans-serif`;
  ctx.fillText(`${price} €`, x + w / 2, y + h - badgeH * 0.36 - 10 * s);

  ctx.restore();
}

/* ---------------------------------------------------------------- utils --- */

function surface(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return { canvas, ctx: canvas.getContext('2d') };
}

function wrap(ctx, text, maxWidth) {
  const words = String(text).split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
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

function deShort(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.`;
}
