/**
 * Demo world generation.
 *
 * PLANNING.md §8 names the empty map as the biggest non-technical risk, and a
 * public demo has exactly that problem on every first load. So the prototype
 * ships a simulated community: stores scattered around wherever the visitor
 * opens the map, reporters with plausible reputations, and a heartbeat that
 * keeps dropping fresh sightings in so the one-hour expiry is visible in
 * motion rather than described in a caption.
 */

import { DEMO, RULES } from './config.js';
import * as db from './db.js';
import { productPhoto } from './imagery.js';
import { hashString, offsetMeters, pick, rngFrom } from './util.js';

const CHAINS = [
  { chain: 'Müller',      weight: 5 },
  { chain: 'Rossmann',    weight: 4 },
  { chain: 'dm',          weight: 3 },
  { chain: 'EDEKA',       weight: 4 },
  { chain: 'REWE',        weight: 3 },
  { chain: 'Kaufland',    weight: 3 },
  { chain: 'MediaMarkt',  weight: 2 },
  { chain: 'Thalia',      weight: 2 },
  { chain: 'Smyths Toys', weight: 2 },
  { chain: 'GameStop',    weight: 1 },
  { chain: 'Galeria',     weight: 1 },
];

const STREETS = [
  'Hauptstraße', 'Bahnhofstraße', 'Marktplatz', 'Lindenweg', 'Schillerstraße',
  'Goethestraße', 'Kirchgasse', 'Ringstraße', 'Am Stadtpark', 'Rosenweg',
  'Mühlenstraße', 'Königsallee', 'Berliner Allee', 'Gartenstraße', 'Fischergasse',
];

const REPORTERS = [
  { username: 'shelfscout',    karma: 412, ageDays: 260 },
  { username: 'kanto_klara',   karma: 187, ageDays: 190 },
  { username: 'pixelroute',    karma: 143, ageDays: 120 },
  { username: 'boosterbenno',  karma: 96,  ageDays: 88 },
  { username: 'tcg_mira',      karma: 74,  ageDays: 64 },
  { username: 'regalradar',    karma: 58,  ageDays: 51 },
  { username: 'nachschub_nils',karma: 141, ageDays: 210 },
  { username: 'sammelsarah',   karma: 33,  ageDays: 29 },
  { username: 'holo_hendrik',  karma: 27,  ageDays: 22 },
  { username: 'lauras_finds',  karma: 19,  ageDays: 14 },
  { username: 'quickpick_qi',  karma: 8,   ageDays: 5 },
  { username: 'neu_im_regal',  karma: 2,   ageDays: 1 },
  { username: 'ultraball_ute', karma: 619, ageDays: 400 },
  { username: 'cardcarl',      karma: 1120,ageDays: 520 },
];

const TITLES = [
  'Booster Displays wieder da',
  'Elite Trainer Box im Regal',
  '3er-Blister nachgefüllt',
  'Neue Serie ausgepackt',
  'Tin-Boxen aufgefüllt',
  'Sammelalbum + Promokarte',
  'Mini-Tins neu eingeräumt',
  'Volle Palette gerade reingekommen',
  'Premium Collection entdeckt',
  'Plüschfiguren nachgelegt',
  'Restock im Aktionsregal',
  'Booster Bundle gesichtet',
  'Zwei Displays übrig',
  'Kartenregal komplett aufgefüllt',
  'Sonderedition aufgetaucht',
];

const DESCRIPTIONS = [
  'Ganz hinten im Spielwarengang, rechts neben den Sammelfiguren.',
  'Mitarbeiter meinte, morgen früh kommt noch mehr rein.',
  'Etwa acht Stück da, geht aber schnell.',
  'Direkt an der Kasse im Aktionskorb.',
  'Limit von zwei Stück pro Person laut Schild.',
  'Zweite Etage, Regal gegenüber der Kassen.',
  null,
  null,
  'Noch reichlich vorhanden, war gerade selbst da.',
  'Preis wie üblich, keine Aufschläge.',
];

/* --------------------------------------------------------------- stores --- */

export function generateStores(center, count = 26) {
  const rand = rngFrom(`stores:${center.lat.toFixed(3)}:${center.lng.toFixed(3)}`);
  const pool = CHAINS.flatMap((c) => Array(c.weight).fill(c.chain));
  const stores = [];

  for (let i = 0; i < count; i++) {
    // Cluster tighter near the centre, sparser at the edges — reads like a city.
    const radius = 220 + Math.pow(rand(), 1.6) * 2600;
    const angle = rand() * Math.PI * 2;
    const point = offsetMeters(center, Math.sin(angle) * radius, Math.cos(angle) * radius);
    const chain = pick(rand, pool);
    const street = pick(rand, STREETS);
    const number = 1 + Math.floor(rand() * 120);
    stores.push({
      // Derived, not random: the same centre must regenerate the same stores,
      // or reloading would orphan every post's store_place_id.
      place_id: `place_${hashString(`${chain}:${street}:${number}:${i}`).toString(36)}`,
      chain,
      name: `${chain}, ${street} ${number}`,
      short: chain,
      lat: point.lat,
      lng: point.lng,
    });
  }
  return stores;
}

/* ------------------------------------------------------------ reporters --- */

export function ensureReporters() {
  const existing = Object.values(db.raw().profiles).filter((p) => p.is_demo_seed);
  if (existing.length) return existing;

  const now = Date.now();
  return REPORTERS.map((r, i) => {
    const rand = rngFrom(`user:${r.username}`);
    return db.upsertProfile({
      id: `usr_seed_${i}`,
      username: r.username,
      avatar: { hue: Math.floor(rand() * 360), glyph: r.username[0].toUpperCase() },
      karma: r.karma,
      created_at: now - r.ageDays * 24 * 60 * 60 * 1000,
      email_verified_at: r.ageDays > 3 ? now - r.ageDays * 24 * 60 * 60 * 1000 : null,
      last_post_at: null,
      status: 'active',
      is_demo_seed: true,
    });
  });
}

/* -------------------------------------------------------------- posting --- */

/**
 * Build one simulated sighting. `ageMs` places it in the past so the countdown
 * rings on the map start at varied depletion instead of all being full.
 */
export function makeSeedPost({ stores, reporters, ageMs, seedKey }) {
  const rand = rngFrom(seedKey);
  const store = stores[Math.floor(rand() * stores.length)];
  const author = reporters[Math.floor(rand() * reporters.length)];
  const captured_at = Date.now() - ageMs;

  // Stand a few metres off the store's own point, the way a real GPS fix would.
  const jitter = offsetMeters(store, (rand() - 0.5) * 40, (rand() - 0.5) * 40);

  const up = Math.floor(Math.pow(rand(), 1.4) * 14);
  const down = rand() > 0.78 ? Math.floor(rand() * 4) : 0;

  return {
    id: `post_seed_${seedKey}`,
    author_id: author.id,
    title: pick(rand, TITLES),
    description: pick(rand, DESCRIPTIONS),
    photo: null,                 // drawn lazily from photo_seed on first render
    photo_seed: `${seedKey}:${store.chain}`,
    lat: jitter.lat,
    lng: jitter.lng,
    location_accuracy_m: Math.round(6 + rand() * 18),
    store_name: store.name,
    store_place_id: store.place_id,
    captured_at,
    expires_at: captured_at + RULES.visibilityMs,
    up_count: up,
    down_count: down,
    sold_out_count: rand() > 0.86 ? RULES.soldOutThreshold + Math.floor(rand() * 2) : 0,
    status: 'active',
    is_demo_seed: true,
  };
}

/** Resolve a post's image: real capture, or a drawing derived from its seed. */
export function photoFor(post) {
  if (post.photo) return post.photo;
  if (post.photo_seed) return productPhoto(post.photo_seed);
  return null;
}

/**
 * Fill the map on first load. Ages are spread across the visibility hour so
 * some markers are nearly full and others are minutes from vanishing.
 */
export function seedWorld(center) {
  const stores = generateStores(center);
  const reporters = ensureReporters();
  const rand = rngFrom(`world:${Date.now()}`);

  for (let i = 0; i < DEMO.targetActivePosts; i++) {
    const ageMs = Math.floor(Math.pow(rand(), 0.85) * RULES.visibilityMs * 0.94);
    db.insertPost(makeSeedPost({ stores, reporters, ageMs, seedKey: `${Date.now()}_${i}` }));
  }

  db.raw().meta.seeded_at = Date.now();
  db.raw().meta.center = center;
  db.persist();
  return stores;
}

/* ------------------------------------------------------------ heartbeat --- */

/**
 * Keeps the demo alive: tops the map back up as sightings expire, and trickles
 * votes onto recent posts. This is what stands in for Supabase Realtime — new
 * markers arrive while you are watching, which is the whole feeling of the app.
 */
export class DemoHeartbeat {
  constructor({ stores, onNewPost }) {
    this.stores = stores;
    this.onNewPost = onNewPost;
    this.reporters = ensureReporters();
    this.timers = [];
  }

  start() {
    this.timers.push(setInterval(() => this.maybeAddPost(), DEMO.heartbeatMs));
    this.timers.push(setInterval(() => this.maybeVote(), DEMO.voteTickMs));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  setStores(stores) {
    this.stores = stores;
  }

  maybeAddPost() {
    if (document.hidden) return;
    const active = db.activePosts();
    if (active.length >= DEMO.targetActivePosts) return;

    // Fresh, but a few minutes old — as if it had just been uploaded.
    const ageMs = Math.floor(Math.random() * 90 * 1000);
    const post = makeSeedPost({
      stores: this.stores,
      reporters: this.reporters,
      ageMs,
      seedKey: `${Date.now()}_live`,
    });
    post.up_count = 0;
    post.down_count = 0;
    post.sold_out_count = 0;
    db.insertPost(post);
    db.persist();
    db.emit({ type: 'post:new', post, simulated: true });
    this.onNewPost?.(post);
  }

  maybeVote() {
    if (document.hidden) return;
    const candidates = db.activePosts().filter((p) => p.is_demo_seed);
    if (!candidates.length) return;
    const post = candidates[Math.floor(Math.random() * Math.min(6, candidates.length))];
    if (Math.random() > 0.55) return;

    if (Math.random() > 0.16) post.up_count += 1;
    else post.down_count += 1;
    db.persist();
    db.emit({ type: 'vote', postId: post.id, simulated: true });
  }
}
