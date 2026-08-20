/**
 * PokeRadar — configuration.
 *
 * Every tunable from PLANNING.md lives here so the rules of the product are
 * readable in one place instead of scattered through the UI code.
 */

export const RULES = {
  /** How long a sighting stays visible on the map. §1 "expiry as a query filter". */
  visibilityMs: 60 * 60 * 1000,
  /** One post per user per 10 minutes, enforced in db.createPost(). */
  postCooldownMs: 10 * 60 * 1000,
  /** Votes stay open after the marker expires — the drive-there crowd arrives late. */
  votingWindowMs: 6 * 60 * 60 * 1000,
  /** A capture older than this cannot be uploaded (staleness poisons map trust). */
  maxCaptureAgeMs: 30 * 60 * 1000,
  /** Accounts younger than this are probationary: their votes never move karma. */
  probationMs: 72 * 60 * 60 * 1000,
  /** Sold-out flags needed before a marker dims to "likely gone". No karma effect. */
  soldOutThreshold: 3,
  /** Unique reports that auto-hide a post pending review. */
  reportThreshold: 3,
  /** Net karma a single post can contribute, in either direction. */
  perPostKarmaCap: 25,
  /** Penalty when moderation confirms a post was fake. */
  fakePostPenalty: -20,
  titleMaxLength: 80,
  descriptionMaxLength: 500,
};

/** Karma tiers. Perks confer visibility and trust — never reach. */
export const TIERS = [
  { min: 1000, key: 'legend',   name: 'Legend',           accent: '#8E5BF0', perk: 'Early features · moderator candidacy' },
  { min: 300,  key: 'veteran',  name: 'Veteran',          accent: '#0A84D6', perk: 'Votes count double · profile flair' },
  { min: 100,  key: 'trusted',  name: 'Trusted Reporter', accent: '#C9911A', perk: 'Gold ring on your markers · skips review' },
  { min: 25,   key: 'scout',    name: 'Scout',            accent: '#2FA36B', perk: 'Badge on your posts and profile' },
  { min: 0,    key: 'rookie',   name: 'Rookie',           accent: '#8A8A90', perk: 'Baseline posting and voting' },
  { min: -Infinity, key: 'limited', name: 'Limited',      accent: '#B04A3A', perk: 'Posts held for review' },
];

export function tierFor(karma) {
  return TIERS.find((t) => karma >= t.min) || TIERS[TIERS.length - 1];
}

export function nextTierFor(karma) {
  const ranked = TIERS.filter((t) => t.min > karma && Number.isFinite(t.min));
  return ranked.length ? ranked[ranked.length - 1] : null;
}

/**
 * Basemap sources.
 *
 * The deployed demo uses keyless OSM-derived raster tiles so the page works for
 * anyone who opens it. PLANNING.md recommends Mapbox for the real client — swap
 * `provider` to 'mapbox' and drop a token in to switch; nothing else changes.
 */
export const BASEMAP = {
  provider: 'carto',
  mapboxToken: '',
  attribution:
    '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors · © <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
  tiles: {
    light: [
      'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
      'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
      'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
    ],
    dark: [
      'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
      'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
      'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
    ],
  },
  /** Used if the primary provider fails to serve tiles. */
  fallbackTiles: {
    light: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    dark: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
  },
  /** Ground colour painted under the tiles, so a tile outage degrades cleanly. */
  ground: { light: '#E9E7E2', dark: '#15161A' },
};

/** Where the map opens when the visitor declines location. */
export const FALLBACK_CENTER = { lat: 52.5211, lng: 13.4059, label: 'Berlin Mitte' };

/**
 * Live sync (prototype transport).
 *
 * GitHub Pages has no backend, so cross-user delivery runs over a public
 * pub/sub broker: every client publishes its posts/votes to a shared ntfy
 * topic and subscribes to the same topic via SSE. No account, no API key —
 * and therefore also no server-side validation: clients validate incoming
 * envelopes themselves, and the topic is public by design (so is every
 * sighting). Production swaps this module for Supabase Realtime; the rest
 * of the app only ever talks to sync.js.
 */
export const SYNC = {
  enabled: true,
  server: 'https://ntfy.sh',
  topic: 'pokeradar-live-v1-de',
  /** How far back a fresh client pulls cached messages on load. */
  pollWindow: '3h',
  /** Max JSON payload per broker message; larger photos are chunked. */
  chunkChars: 3000,
  /** Photos are recompressed to roughly this size before broadcast. */
  photoMaxEdge: 300,
  photoQuality: 0.52,
};

/** Chains offered by the store autocomplete when no known store matches. */
export const KNOWN_CHAINS = [
  'Müller', 'Rossmann', 'dm', 'EDEKA', 'REWE', 'Kaufland', 'Lidl', 'Aldi',
  'Penny', 'Netto', 'MediaMarkt', 'Saturn', 'Thalia', 'Smyths Toys',
  'GameStop', 'Galeria', 'Woolworth', 'Hugendubel',
];

/**
 * The Scout system (motivation layer). Karma stays pure trust — it can fall,
 * and it only moves when other people judge your accuracy. XP is the second
 * currency: activity-only, never decreases, and pays out the moment you act,
 * which is exactly the feedback posting itself was missing. Everything here
 * is derived from existing state (posts, votes, finds), never stored — so it
 * cannot drift and needs no extra write paths.
 */
export const SCOUT = {
  xp: {
    post: 10,             // publishing a sighting
    firstScoutBonus: 5,   // first sighting at that store in 24 h
    confirmReceived: 3,   // per confirm on your posts…
    confirmCapPerPost: 10 * 3, // …capped, so one viral post cannot carry a level
    voteCast: 2,          // judging someone else's sighting
    soldOutFlag: 1,       // freshness housekeeping
    flyerFind: 10,        // confirmed community flyer find
    streakWeekBonus: 5,   // per week of the current posting streak
  },
  levels: [
    { xp: 0,    name: 'Rookie Scout' },
    { xp: 40,   name: 'Trail Scout' },
    { xp: 100,  name: 'Shelf Scout' },
    { xp: 200,  name: 'City Scout' },
    { xp: 350,  name: 'Radar Pro' },
    { xp: 550,  name: 'Master Scout' },
    { xp: 800,  name: 'Elite Scout' },
    { xp: 1100, name: 'Radar Captain' },
    { xp: 1500, name: 'Radar Legend' },
  ],
};

/**
 * Flyer radar (PLANNING.md §10). A flyer is hidden until Pokémon has actually
 * been found in it — either by the keyword pass that runs in the daily job, or
 * by the community reaching the flag threshold below.
 */
export const FLYER_RULES = {
  /** Independent community flags that make a flyer visible. */
  communityFindThreshold: 2,
  /** Karma each confirmed finder earns once the threshold is crossed. */
  findKarma: 2,
  /** A flyer whose chain has no branch this close is not shown at all. */
  maxBranchDistanceM: 25000,
  /** Written by the daily job; served as a static file. */
  dataUrl: './data/flyers.json',
  /** How often a long-lived session re-checks for the day's refresh. */
  recheckMs: 6 * 60 * 60 * 1000,
};

export const STORAGE_KEY = 'pokeradar.state.v1';
export const PREFS_KEY = 'pokeradar.prefs.v1';
