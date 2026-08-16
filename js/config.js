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

export const DEMO = {
  /** The simulator tops the map up to this many live sightings. */
  targetActivePosts: 22,
  /** Interval at which a new simulated sighting can drop in. */
  heartbeatMs: 22 * 1000,
  /** Simulated votes trickle in on visible posts at this interval. */
  voteTickMs: 9 * 1000,
};

export const STORAGE_KEY = 'pokeradar.state.v1';
export const PREFS_KEY = 'pokeradar.prefs.v1';
