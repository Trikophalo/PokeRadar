/**
 * Flyer radar (PLANNING.md §10).
 *
 * The catalogue is read-only and comes from `data/flyers.json`, written once a
 * day by the job in `scripts/build-flyers.mjs`. The client never talks to a
 * retailer or an aggregator directly — CORS, API keys and content licensing all
 * live on the server side of that file.
 *
 * The rule that defines the feature: a flyer is hidden until Pokémon has
 * actually been found in it, either by the keyword pass in the daily job
 * (layer A) or by the community reaching the flag threshold (layer B).
 */

import { FLYER_RULES } from './config.js';
import * as db from './db.js';
import { distanceMeters } from './util.js';

let catalogue = null;
let lastFetched = 0;
let lastError = null;

export const catalogueMeta = () => (catalogue
  ? { week: catalogue.week, source: catalogue.source, notice: catalogue.notice, error: lastError }
  : { week: null, source: null, notice: null, error: lastError });

/**
 * Fetch the day's file. Cheap and idempotent — safe to call on every tab visit;
 * it only re-fetches once the recheck window has passed.
 */
export async function loadFlyers({ force = false } = {}) {
  const fresh = Date.now() - lastFetched < FLYER_RULES.recheckMs;
  if (catalogue && fresh && !force) return catalogue;

  try {
    const response = await fetch(FLYER_RULES.dataUrl, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.flyers)) throw new Error('malformed flyer feed');
    catalogue = data;
    lastFetched = Date.now();
    lastError = null;
  } catch (error) {
    lastError = error.message;
    // Keep serving the copy we already have rather than emptying the tab.
    if (!catalogue) catalogue = { week: null, flyers: [], source: null };
  }
  return catalogue;
}

export const allFlyers = () => (catalogue?.flyers || []);

/* --------------------------------------------------------------- rules --- */

/** Layer A: the keyword pass that ran in the daily job. */
export const autoMatch = (flyer) => (flyer.matches || [])[0] || null;

/** Today, in the same YYYY-MM-DD form the feed uses. */
function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export const isCurrent = (flyer) => !flyer.valid_until || flyer.valid_until >= today();

/**
 * The whole feature in one function: which flyers may be shown, and why.
 * `visible = (layer A match OR ≥N community flags) AND still valid AND a
 * branch of that chain is within range`.
 */
export function evaluate(flyer, { stores = [], origin = null } = {}) {
  const branch = nearestBranch(flyer.chain, stores, origin);
  const auto = autoMatch(flyer);
  const community = db.flyerFindStats(flyer.id);

  // Hide on distance only when we positively know the nearest branch is too
  // far. Branches are learned from sightings now, so "no branch known" means
  // "no data", not "no branch" — and no data must never empty the tab (§10.5).
  const inRange = !origin || !branch
    ? true
    : branch.distance <= FLYER_RULES.maxBranchDistanceM;

  return {
    flyer,
    branch,
    auto,
    community,
    page: auto?.page || community.page || null,
    badge: auto ? 'auto' : community.confirmed ? 'community' : null,
    current: isCurrent(flyer),
    inRange,
    visible: Boolean(auto || community.confirmed) && isCurrent(flyer) && inRange,
  };
}

/** Nearest branch of a chain, from the store registry the map already builds. */
export function nearestBranch(chain, stores, origin) {
  if (!origin) return null;
  let best = null;
  for (const store of stores) {
    if (store.chain !== chain) continue;
    const distance = distanceMeters(origin, store);
    if (!best || distance < best.distance) best = { store, distance };
  }
  return best;
}

/**
 * §10.5: nearest branch first, then soonest to expire — the same freshness
 * bias the map uses, applied to a weekly rhythm instead of an hourly one.
 */
function bySortOrder(a, b) {
  const da = a.branch ? a.branch.distance : Infinity;
  const dbb = b.branch ? b.branch.distance : Infinity;
  if (da !== dbb) return da - dbb;
  return String(a.flyer.valid_until).localeCompare(String(b.flyer.valid_until));
}

export function partition({ stores = [], origin = null } = {}) {
  const evaluated = allFlyers().map((flyer) => evaluate(flyer, { stores, origin }));
  return {
    visible: evaluated.filter((e) => e.visible).sort(bySortOrder),
    // Candidates for the community layer: current and reachable, but nothing
    // found in them yet. This is the list the "report a find" flow works from.
    candidates: evaluated
      .filter((e) => !e.visible && e.current && e.inRange)
      .sort(bySortOrder),
    outOfRange: evaluated.filter((e) => e.current && !e.inRange).length,
  };
}
