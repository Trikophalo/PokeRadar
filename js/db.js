/**
 * PokeRadar — data layer.
 *
 * This is the browser stand-in for the Supabase/Postgres backend described in
 * PLANNING.md §3. The table shapes, the constraints and the write paths mirror
 * the real schema deliberately, so the production port is "replace the storage
 * calls", not "rethink the model":
 *
 *   profiles · posts · votes · karma_events · reports
 *
 * Rules that PLANNING.md puts in triggers and row-level security are enforced
 * here in the mutators rather than in the UI — the views ask this module for
 * permission, they never decide for themselves.
 */

import { FLYER_RULES, RULES, STORAGE_KEY, tierFor } from './config.js';
import { distanceMeters, uid } from './util.js';

const listeners = new Set();

/**
 * Synchronous action bus, separate from the coalesced emit() below. emit()
 * batches per microtask and drops details, which is right for view refreshes
 * and wrong for sync — the transport needs every local mutation exactly once,
 * with its payload. Remote applications fire with {remote:true} so the
 * transport never echoes them back out.
 */
const actionListeners = new Set();
export function onAction(fn) {
  actionListeners.add(fn);
  return () => actionListeners.delete(fn);
}
function fireAction(action) {
  for (const fn of actionListeners) {
    try { fn(action); } catch { /* one bad listener must not break writes */ }
  }
}

/** A post's display photo. Absent on pruned or partially-synced posts. */
export const photoFor = (post) => post?.photo || null;

const emptyState = () => ({
  version: 1,
  profiles: {},
  posts: {},
  votes: {},          // key: `${post_id}:${voter_id}` — the composite primary key
  karma_events: [],
  reports: [],        // {post_id, reporter_id, reason, created_at}
  flyer_finds: {},    // key: `${flyer_id}:${reporter_id}` — §10 community layer
  session: { user_id: null },
  meta: { seeded_at: null, center: null },
});

let state = emptyState();

/* ------------------------------------------------------------ lifecycle --- */

export function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1) state = { ...emptyState(), ...parsed };
    }
  } catch {
    state = emptyState();
  }
  purgeDemoData();
  pruneExpiredPhotos();
  reconcileFlyerFinds();
  return state;
}

/**
 * Migration: earlier builds seeded a simulated community (posts, reporters,
 * trickled votes) so the map was never empty. With real cross-user sync that
 * scaffolding is gone — and any of it still sitting in a visitor's
 * localStorage from a previous version is deleted here.
 */
function purgeDemoData() {
  let dirty = false;
  for (const [id, post] of Object.entries(state.posts)) {
    if (post.is_demo_seed) { delete state.posts[id]; dirty = true; }
  }
  for (const [id, profile] of Object.entries(state.profiles)) {
    if (profile.is_demo_seed) { delete state.profiles[id]; dirty = true; }
  }
  for (const [key, vote] of Object.entries(state.votes)) {
    const postId = vote.post_id;
    if (postId && !state.posts[postId]) { delete state.votes[key]; dirty = true; }
  }
  if (dirty) persist();
}

/**
 * Pay out any flyer find that crossed the threshold without being awarded.
 *
 * The award normally fires on the write that crosses it, but that only covers
 * finds this client submitted. State can also arrive by other routes — a
 * restored backup, a replayed offline queue, or (in production) another user's
 * insert syncing in — and the ledger, not the write path, is the source of
 * truth. Idempotent: the karma_awarded flag makes re-running it a no-op.
 */
function reconcileFlyerFinds() {
  const before = state.karma_events.length;
  const flyerIds = new Set(Object.values(state.flyer_finds).map((f) => f.flyer_id));
  for (const flyerId of flyerIds) awardFlyerFindKarma(flyerId);
  // Write back, or the payout exists only in memory and is re-derived (and
  // re-awarded) on the next load.
  if (state.karma_events.length !== before) persist();
}

export function reset() {
  state = emptyState();
  persist();
  emit();
}

let persistTimer = null;
export function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(writeThrough, 120);
}

function writeThrough() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota exceeded: drop the heaviest payloads (photos of dead posts) and retry once.
    pruneExpiredPhotos(true);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch { /* give up quietly — the session still works in memory */ }
  }
}

/**
 * PLANNING.md §1: visibility expires after an hour but the record survives for
 * karma and moderation. Photo *files* are the part that gets collected, which
 * here means dropping data URLs once a post is well past its window.
 */
function pruneExpiredPhotos(aggressive = false) {
  const cutoff = Date.now() - (aggressive ? 0 : RULES.votingWindowMs);
  for (const post of Object.values(state.posts)) {
    if (post.photo && post.photo.startsWith('data:') && post.expires_at < cutoff) {
      post.photo_pruned = true;
      delete post.photo;
    }
  }
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let emitScheduled = false;
export function emit(detail = {}) {
  if (emitScheduled) return;
  emitScheduled = true;
  queueMicrotask(() => {
    emitScheduled = false;
    for (const fn of listeners) fn(detail);
  });
}

export const raw = () => state;

/* --------------------------------------------------------------- session --- */

export function currentUser() {
  return state.session.user_id ? state.profiles[state.session.user_id] || null : null;
}

export function signIn(username, { avatar } = {}) {
  const name = String(username || '').trim();
  if (name.length < 3 || name.length > 20) {
    return { ok: false, error: 'Pick a name between 3 and 20 characters.' };
  }
  const taken = Object.values(state.profiles).some(
    (p) => p.username.toLowerCase() === name.toLowerCase() && p.id !== state.session.user_id,
  );
  if (taken) return { ok: false, error: 'That name is already on the radar.' };

  const now = Date.now();
  const profile = {
    id: uid('usr'),
    username: name,
    avatar: avatar || { hue: Math.floor(Math.random() * 360), glyph: name[0].toUpperCase() },
    karma: 0,
    created_at: now,
    email_verified_at: null,
    last_post_at: null,
    status: 'active',
  };
  state.profiles[profile.id] = profile;
  state.session.user_id = profile.id;
  persist();
  emit({ type: 'auth' });
  return { ok: true, profile };
}

export function signOut() {
  state.session.user_id = null;
  persist();
  emit({ type: 'auth' });
}

/** PLANNING.md §6: probationary accounts (<72 h) can vote, but it never counts. */
export function isProbationary(profile) {
  if (!profile) return true;
  const age = Date.now() - profile.created_at;
  return age < RULES.probationMs && !profile.email_verified_at;
}

/* ---------------------------------------------------------------- posts --- */

export function upsertProfile(profile) {
  state.profiles[profile.id] = { ...state.profiles[profile.id], ...profile };
  return state.profiles[profile.id];
}

export function insertPost(post) {
  state.posts[post.id] = post;
  return post;
}

/** Milliseconds until the author may post again; 0 when they're clear. */
export function cooldownRemaining(userId = state.session.user_id) {
  const profile = state.profiles[userId];
  if (!profile || !profile.last_post_at) return 0;
  return Math.max(0, profile.last_post_at + RULES.postCooldownMs - Date.now());
}

/**
 * The write path for a real sighting. Mirrors the BEFORE INSERT trigger in
 * PLANNING.md §3: authentication, the 10-minute cooldown and capture freshness
 * are all rejected here rather than hidden in the UI.
 */
export function createPost({ title, description, photo, location, accuracy, store, capturedAt }) {
  const author = currentUser();
  if (!author) return { ok: false, error: 'Sign in to post a sighting.' };
  if (author.status === 'suspended' || author.status === 'banned') {
    return { ok: false, error: 'Posting is suspended on this account.' };
  }

  const remaining = cooldownRemaining(author.id);
  if (remaining > 0) return { ok: false, error: 'cooldown', remaining };

  const clean = String(title || '').trim();
  if (!clean) return { ok: false, error: 'Give the sighting a title.' };
  if (!photo) return { ok: false, error: 'A photo is required.' };
  if (!location) return { ok: false, error: 'We could not tag a location for this post.' };

  const captured_at = capturedAt || Date.now();
  if (Date.now() - captured_at > RULES.maxCaptureAgeMs) {
    return { ok: false, error: 'This capture is too old to post.' };
  }

  const post = {
    id: uid('post'),
    author_id: author.id,
    title: clean.slice(0, RULES.titleMaxLength),
    description: String(description || '').trim().slice(0, RULES.descriptionMaxLength) || null,
    photo,
    photo_seed: null,
    lat: location.lat,
    lng: location.lng,
    location_accuracy_m: accuracy ?? null,
    store_name: store?.name || null,
    store_place_id: store?.place_id || null,
    captured_at,
    // §1: the hour is measured from capture, so a late upload gets the remainder.
    expires_at: captured_at + RULES.visibilityMs,
    up_count: 0,
    down_count: 0,
    sold_out_count: 0,
    status: 'active',
    is_remote: false,
  };

  state.posts[post.id] = post;
  author.last_post_at = Date.now();
  persist();
  emit({ type: 'post:new', post });
  fireAction({ type: 'post', post, author });
  return { ok: true, post };
}

export function deletePost(postId) {
  const post = state.posts[postId];
  const me = currentUser();
  if (!post || !me || post.author_id !== me.id) return { ok: false };
  // §3: karma already earned or lost stays on the ledger — deleting is not an
  // escape hatch from downvotes.
  post.status = 'removed';
  persist();
  emit({ type: 'post:removed', post });
  fireAction({ type: 'delete', postId: post.id, authorId: me.id });
  return { ok: true };
}

export const getPost = (id) => state.posts[id] || null;
export const getProfile = (id) => state.profiles[id] || null;

/** The map query: active, visible, non-hidden posts. Equivalent to posts_in_bbox(). */
export function activePosts(now = Date.now()) {
  return Object.values(state.posts)
    .filter((p) => p.status === 'active' && p.expires_at > now)
    .sort((a, b) => b.captured_at - a.captured_at);
}

/** Posts that have left the map but can still be voted on (§1, 6 h window). */
export function votablePosts(now = Date.now()) {
  return Object.values(state.posts)
    .filter((p) => p.status === 'active' && now - p.captured_at < RULES.votingWindowMs)
    .sort((a, b) => b.captured_at - a.captured_at);
}

export function postsByAuthor(userId) {
  return Object.values(state.posts)
    .filter((p) => p.author_id === userId && p.status !== 'removed')
    .sort((a, b) => b.captured_at - a.captured_at);
}

export const isExpired = (post, now = Date.now()) => post.expires_at <= now;

export function isLikelyGone(post) {
  return post.sold_out_count >= RULES.soldOutThreshold;
}

/* ---------------------------------------------------------------- votes --- */

const voteKey = (postId, userId) => `${postId}:${userId}`;

export function myVote(postId, userId = state.session.user_id) {
  if (!userId) return null;
  return state.votes[voteKey(postId, userId)] || null;
}

export function voteWindowOpen(post, now = Date.now()) {
  return now - post.captured_at < RULES.votingWindowMs;
}

/**
 * Confirm (+1) or dispute (−1). One row per (post, voter) — changing your mind
 * updates the row and reverses the previous karma delta through the ledger.
 */
export function castVote(postId, value, reason = null) {
  const voter = currentUser();
  const post = state.posts[postId];
  if (!voter) return { ok: false, error: 'Sign in to vote.' };
  if (!post || post.status !== 'active') return { ok: false, error: 'This sighting is gone.' };
  if (post.author_id === voter.id) return { ok: false, error: 'You cannot vote on your own post.' };
  if (!voteWindowOpen(post)) return { ok: false, error: 'Voting has closed on this sighting.' };
  if (value === -1 && !reason) return { ok: false, error: 'Pick a reason for disputing.' };

  const key = voteKey(postId, voter.id);
  const existing = state.votes[key];

  if (existing && existing.value === value) {
    // Tapping the active choice retracts it.
    removeVoteEffect(existing, post);
    delete state.votes[key];
    persist();
    emit({ type: 'vote', postId });
    fireAction({ type: 'vote:retract', postId, voterId: voter.id });
    return { ok: true, retracted: true };
  }

  if (existing) removeVoteEffect(existing, post);

  const vote = {
    post_id: postId,
    voter_id: voter.id,
    value,
    reason: value === -1 ? reason : null,
    // §4: frozen at vote time, so a probationary voter never counts even later.
    counts_for_karma: !isProbationary(voter),
    created_at: existing?.created_at || Date.now(),
    updated_at: Date.now(),
  };
  state.votes[key] = vote;
  applyVoteEffect(vote, post);
  persist();
  emit({ type: 'vote', postId });
  fireAction({ type: 'vote', vote, voter });
  return { ok: true, vote };
}

function applyVoteEffect(vote, post) {
  if (vote.value === 1) post.up_count += 1;
  else post.down_count += 1;
  if (!vote.counts_for_karma) return;

  const weight = voteWeight(state.profiles[vote.voter_id]);
  const delta = vote.value * weight;
  const capped = capForPost(post.author_id, post.id, delta);
  if (capped !== 0) {
    addKarmaEvent(post.author_id, capped, vote.value === 1 ? 'post_upvoted' : 'post_downvoted', post.id);
  }
}

function removeVoteEffect(vote, post) {
  if (vote.value === 1) post.up_count = Math.max(0, post.up_count - 1);
  else post.down_count = Math.max(0, post.down_count - 1);
  if (!vote.counts_for_karma) return;

  // Reverse exactly what this vote contributed, per the ledger.
  const contributed = state.karma_events
    .filter((e) => e.post_id === post.id && e.user_id === post.author_id && e.vote_id === voteKey(vote.post_id, vote.voter_id))
    .reduce((sum, e) => sum + e.delta, 0);
  if (contributed !== 0) {
    addKarmaEvent(post.author_id, -contributed, 'vote_changed', post.id);
  }
}

/** §4: Veterans (300+) carry double weight. Everyone else is ±1. */
function voteWeight(voter) {
  if (!voter) return 1;
  return tierFor(voter.karma).key === 'veteran' || tierFor(voter.karma).key === 'legend' ? 2 : 1;
}

/** §4: no single post can move a reputation more than ±25 net. */
function capForPost(userId, postId, delta) {
  const already = state.karma_events
    .filter((e) => e.user_id === userId && e.post_id === postId && e.reason !== 'post_removed_fake')
    .reduce((sum, e) => sum + e.delta, 0);
  const next = already + delta;
  const cap = RULES.perPostKarmaCap;
  if (next > cap) return Math.max(0, cap - already);
  if (next < -cap) return Math.min(0, -cap - already);
  return delta;
}

/** The no-fault freshness signal. Deliberately has zero karma effect (§4). */
export function flagSoldOut(postId) {
  const user = currentUser();
  const post = state.posts[postId];
  if (!user) return { ok: false, error: 'Sign in to flag a sighting.' };
  if (!post) return { ok: false, error: 'This sighting is gone.' };

  const key = `soldout:${postId}:${user.id}`;
  if (state.votes[key]) return { ok: false, error: 'You already flagged this.' };
  state.votes[key] = { kind: 'sold_out', post_id: postId, voter_id: user.id, created_at: Date.now() };
  post.sold_out_count += 1;
  persist();
  emit({ type: 'soldout', postId });
  fireAction({ type: 'soldout', postId, userId: user.id });
  return { ok: true };
}

export function hasFlaggedSoldOut(postId, userId = state.session.user_id) {
  return Boolean(userId && state.votes[`soldout:${postId}:${userId}`]);
}

/* ---------------------------------------------------------------- karma --- */

/**
 * The append-only ledger from PLANNING.md §3. `profiles.karma` is only ever a
 * cached sum of these rows, which is what makes retractions and moderation
 * reversals exact instead of approximate.
 */
export function addKarmaEvent(userId, delta, reason, postId = null, voteId = null, flyerId = null) {
  if (!delta) return;
  const profile = state.profiles[userId];
  if (!profile) return;
  const event = {
    id: uid('ke'),
    user_id: userId,
    delta,
    reason,
    post_id: postId,
    flyer_id: flyerId,
    vote_id: voteId || (postId ? voteKey(postId, state.session.user_id) : null),
    created_at: Date.now(),
  };
  state.karma_events.push(event);
  profile.karma += delta;
  if (state.karma_events.length > 4000) state.karma_events.splice(0, 1000);
}

export function karmaLedger(userId, sinceMs = 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - sinceMs;
  return state.karma_events.filter((e) => e.user_id === userId && e.created_at >= cutoff);
}

export function karmaToday(userId) {
  return karmaLedger(userId).reduce((sum, e) => sum + e.delta, 0);
}

/** Share of this author's rated posts that came out net-positive. */
export function accuracyFor(userId) {
  const rated = postsByAuthor(userId).filter((p) => p.up_count + p.down_count > 0);
  if (!rated.length) return null;
  const good = rated.filter((p) => p.up_count >= p.down_count).length;
  return Math.round((good / rated.length) * 100);
}

export function statsFor(userId) {
  const posts = postsByAuthor(userId);
  return {
    posts: posts.length,
    confirms: posts.reduce((n, p) => n + p.up_count, 0),
    disputes: posts.reduce((n, p) => n + p.down_count, 0),
    accuracy: accuracyFor(userId),
  };
}

/* -------------------------------------------------------------- reports --- */

export function reportPost(postId, reason) {
  const user = currentUser();
  if (!user) return { ok: false, error: 'Sign in to report.' };
  const post = state.posts[postId];
  if (!post) return { ok: false, error: 'This sighting is gone.' };
  if (state.reports.some((r) => r.post_id === postId && r.reporter_id === user.id)) {
    return { ok: false, error: 'You already reported this sighting.' };
  }
  state.reports.push({ post_id: postId, reporter_id: user.id, reason, created_at: Date.now() });

  const unique = new Set(
    state.reports.filter((r) => r.post_id === postId).map((r) => r.reporter_id),
  ).size;
  // §6: crossing the threshold auto-hides pending review.
  if (unique >= RULES.reportThreshold) post.status = 'hidden_pending_review';

  persist();
  emit({ type: 'report', postId });
  return { ok: true, hidden: post.status === 'hidden_pending_review' };
}

/* ---------------------------------------------------------- flyer finds --- */

const findKey = (flyerId, userId) => `${flyerId}:${userId}`;

export function myFlyerFind(flyerId, userId = state.session.user_id) {
  if (!userId) return null;
  return state.flyer_finds[findKey(flyerId, userId)] || null;
}

/**
 * Community detection for flyers (§10.2 layer B). Rows are one per
 * (flyer, reporter): +1 means "Pokémon is on page N", −1 disputes it.
 */
export function flyerFindStats(flyerId) {
  const rows = Object.values(state.flyer_finds).filter((f) => f.flyer_id === flyerId);
  const found = rows.filter((f) => f.value === 1);
  const disputed = rows.filter((f) => f.value === -1);
  const pages = found.map((f) => f.page).filter(Boolean).sort((a, b) => a - b);
  return {
    found: found.length,
    disputed: disputed.length,
    // Independent flags carry it, but a disputed majority takes it back down.
    confirmed: found.length >= FLYER_RULES.communityFindThreshold && found.length > disputed.length,
    page: pages.length ? pages[0] : null,
  };
}

export function reportFlyerFind(flyerId, { page = null, value = 1 } = {}) {
  const user = currentUser();
  if (!user) return { ok: false, error: 'Sign in to report a flyer find.' };
  if (value === 1 && !page) return { ok: false, error: 'Which page is it on?' };

  const key = findKey(flyerId, user.id);
  const existing = state.flyer_finds[key];
  if (existing && existing.value === value) {
    delete state.flyer_finds[key];
    persist();
    emit({ type: 'flyer:find', flyerId });
    return { ok: true, retracted: true };
  }

  state.flyer_finds[key] = {
    flyer_id: flyerId,
    reporter_id: user.id,
    page: value === 1 ? Number(page) : null,
    value,
    status: 'pending',
    karma_awarded: existing?.karma_awarded || false,
    created_at: existing?.created_at || Date.now(),
  };

  awardFlyerFindKarma(flyerId);
  persist();
  emit({ type: 'flyer:find', flyerId });
  return { ok: true, stats: flyerFindStats(flyerId) };
}

/**
 * Crossing the threshold pays every finder once (§10.2). The karma_awarded flag
 * is what stops a flyer being farmed by flagging and re-flagging it.
 */
function awardFlyerFindKarma(flyerId) {
  if (!flyerFindStats(flyerId).confirmed) return;
  for (const row of Object.values(state.flyer_finds)) {
    if (row.flyer_id !== flyerId || row.value !== 1 || row.karma_awarded) continue;
    row.karma_awarded = true;
    row.status = 'confirmed';
    addKarmaEvent(row.reporter_id, FLYER_RULES.findKarma, 'flyer_find_confirmed', null, null, flyerId);
  }
}

/* --------------------------------------------------------------- stores --- */

/**
 * The store registry, learned from real sightings instead of a seeded list.
 * Every post that names a store teaches the app where that store is; the
 * newest post per name wins the coordinates. This is the §3 `stores` table
 * growing organically — in production it is fed by Places snapping, here it
 * is fed by the community itself.
 */
export function learnedStores() {
  const byName = new Map();
  for (const post of Object.values(state.posts)) {
    if (!post.store_name || post.status === 'removed') continue;
    const key = post.store_name.trim().toLowerCase();
    const existing = byName.get(key);
    if (!existing || post.captured_at > existing.captured_at) {
      byName.set(key, post);
    }
  }
  return [...byName.values()].map((post) => ({
    place_id: post.store_place_id || null,
    name: post.store_name.trim(),
    chain: post.store_name.trim().split(/[\s,]+/)[0],
    lat: post.lat,
    lng: post.lng,
    captured_at: post.captured_at,
  }));
}

export function nearbyStores(location, stores, limit = 4) {
  return stores
    .map((store) => ({ store, distance: distanceMeters(location, store) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

/**
 * First find: was this the first sighting at its store in the 24 h before it?
 * The Scout system pays a bonus for it and the marker wears a star — being
 * first is the behaviour the app most wants to reward.
 */
export function isFirstScout(post) {
  if (!post?.store_name) return false;
  const name = post.store_name.trim().toLowerCase();
  const windowStart = post.captured_at - 24 * 60 * 60 * 1000;
  for (const other of Object.values(state.posts)) {
    if (other.id === post.id || !other.store_name || other.status === 'removed') continue;
    if (other.store_name.trim().toLowerCase() !== name) continue;
    if (other.captured_at >= windowStart && other.captured_at < post.captured_at) return false;
  }
  return true;
}

/* --------------------------------------------------------------- remote --- */
/*
 * Apply-side of the live sync. These functions accept envelopes that arrived
 * over the wire, so they trust nothing: every field is validated and clamped
 * before it touches state, and every application is idempotent so replays
 * (SSE echo + catch-up poll delivering the same message) are harmless. They
 * emit with {remote:true} — the transport ignores those, breaking the loop.
 */

const finiteIn = (n, lo, hi) => Number.isFinite(n) && n >= lo && n <= hi;

function sanitizeRemoteProfile(raw) {
  if (!raw || typeof raw.id !== 'string' || raw.id.length > 64) return null;
  return {
    id: raw.id,
    username: String(raw.username || 'scout').slice(0, 20),
    avatar: {
      hue: finiteIn(Number(raw.avatar?.hue), 0, 360) ? Number(raw.avatar.hue) : 200,
      glyph: String(raw.avatar?.glyph || '?').slice(0, 2),
    },
    karma: finiteIn(Number(raw.karma), -10000, 100000) ? Math.round(Number(raw.karma)) : 0,
    created_at: finiteIn(Number(raw.created_at), 0, Date.now() + 60000)
      ? Number(raw.created_at) : Date.now(),
    email_verified_at: raw.email_verified_at ? Number(raw.email_verified_at) : null,
    last_post_at: null,
    status: 'active',
    is_remote: true,
  };
}

/** Upsert a shadow profile for a remote author/voter. Never touches local users. */
function upsertRemoteProfile(raw) {
  const clean = sanitizeRemoteProfile(raw);
  if (!clean) return null;
  const existing = state.profiles[clean.id];
  if (existing && !existing.is_remote) return existing;   // never overwrite a local account
  state.profiles[clean.id] = { ...existing, ...clean };
  return state.profiles[clean.id];
}

export function applyRemotePost(rawPost, rawAuthor) {
  if (!rawPost || typeof rawPost.id !== 'string' || rawPost.id.length > 64) return { ok: false };
  if (state.posts[rawPost.id]) return { ok: false, duplicate: true };

  const captured_at = Number(rawPost.captured_at);
  const now = Date.now();
  // Stale or future-dated envelopes are dropped outright.
  if (!finiteIn(captured_at, now - RULES.votingWindowMs, now + 5 * 60 * 1000)) return { ok: false };
  if (!finiteIn(Number(rawPost.lat), -90, 90) || !finiteIn(Number(rawPost.lng), -180, 180)) return { ok: false };

  const author = upsertRemoteProfile(rawAuthor);
  if (!author) return { ok: false };

  const photo = typeof rawPost.photo === 'string'
    && rawPost.photo.startsWith('data:image/')
    && rawPost.photo.length < 160000
    ? rawPost.photo : null;

  const post = {
    id: rawPost.id,
    author_id: author.id,
    title: String(rawPost.title || '').slice(0, RULES.titleMaxLength) || 'Sighting',
    description: rawPost.description ? String(rawPost.description).slice(0, RULES.descriptionMaxLength) : null,
    photo,
    lat: Number(rawPost.lat),
    lng: Number(rawPost.lng),
    location_accuracy_m: finiteIn(Number(rawPost.location_accuracy_m), 0, 10000)
      ? Math.round(Number(rawPost.location_accuracy_m)) : null,
    store_name: rawPost.store_name ? String(rawPost.store_name).slice(0, 80) : null,
    store_place_id: rawPost.store_place_id ? String(rawPost.store_place_id).slice(0, 64) : null,
    captured_at,
    expires_at: captured_at + RULES.visibilityMs,
    up_count: 0,
    down_count: 0,
    sold_out_count: 0,
    status: 'active',
    is_remote: true,
  };
  state.posts[post.id] = post;
  persist();
  emit({ type: 'post:new', post, remote: true });
  return { ok: true, post };
}

/** Late-arriving photo chunks completing a post that was inserted without one. */
export function attachRemotePhoto(postId, photo) {
  const post = state.posts[postId];
  if (!post || !post.is_remote || post.photo) return false;
  if (typeof photo !== 'string' || !photo.startsWith('data:image/') || photo.length > 160000) return false;
  post.photo = photo;
  persist();
  emit({ type: 'post:photo', postId, remote: true });
  return true;
}

export function applyRemoteVote({ postId, voter, value, reason, countsForKarma, ts }) {
  const post = state.posts[postId];
  if (!post || post.status !== 'active') return { ok: false };
  if (value !== 1 && value !== -1) return { ok: false };

  const profile = upsertRemoteProfile(voter);
  if (!profile) return { ok: false };
  if (profile.id === post.author_id) return { ok: false };

  const key = `${postId}:${profile.id}`;
  const existing = state.votes[key];
  const stamp = finiteIn(Number(ts), 0, Date.now() + 60000) ? Number(ts) : Date.now();
  // Idempotence: same value again (replay) is a no-op; older than what we have loses.
  if (existing && existing.value === value) return { ok: true, duplicate: true };
  if (existing && existing.updated_at > stamp) return { ok: false, stale: true };

  if (existing) removeVoteEffectRemote(existing, post);

  const vote = {
    post_id: postId,
    voter_id: profile.id,
    value,
    reason: value === -1 ? String(reason || 'not_restocked').slice(0, 32) : null,
    counts_for_karma: Boolean(countsForKarma),
    created_at: existing?.created_at || stamp,
    updated_at: stamp,
    is_remote: true,
  };
  state.votes[key] = vote;
  applyVoteEffectRemote(vote, post);
  persist();
  emit({ type: 'vote', postId, remote: true });
  return { ok: true };
}

export function applyRemoteVoteRetraction({ postId, voterId }) {
  const post = state.posts[postId];
  const key = `${postId}:${voterId}`;
  const existing = state.votes[key];
  if (!post || !existing) return { ok: false };
  removeVoteEffectRemote(existing, post);
  delete state.votes[key];
  persist();
  emit({ type: 'vote', postId, remote: true });
  return { ok: true };
}

/**
 * Counts always move; karma only when the vote qualifies AND the author is a
 * profile this device owns — that is the author's device receiving judgement
 * on their own post, the one place the real ledger lives. For remote authors
 * only the shadow karma number shifts, so their chip stays roughly current.
 */
function applyVoteEffectRemote(vote, post) {
  if (vote.value === 1) post.up_count += 1;
  else post.down_count += 1;
  if (!vote.counts_for_karma) return;

  const author = state.profiles[post.author_id];
  if (!author) return;
  if (author.is_remote) {
    author.karma += vote.value;
  } else {
    const capped = capForPost(post.author_id, post.id, vote.value);
    if (capped !== 0) {
      // The vote_id must name the REMOTE voter — addKarmaEvent's default
      // derives it from the session user, which on the author's device is the
      // author, and the retraction lookup would then never match.
      addKarmaEvent(post.author_id, capped, vote.value === 1 ? 'post_upvoted' : 'post_downvoted',
        post.id, `${post.id}:${vote.voter_id}`);
    }
  }
}

function removeVoteEffectRemote(vote, post) {
  if (vote.value === 1) post.up_count = Math.max(0, post.up_count - 1);
  else post.down_count = Math.max(0, post.down_count - 1);
  if (!vote.counts_for_karma) return;

  const author = state.profiles[post.author_id];
  if (!author) return;
  if (author.is_remote) {
    author.karma -= vote.value;
  } else {
    const contributed = state.karma_events
      .filter((e) => e.post_id === post.id && e.user_id === post.author_id
        && e.vote_id === `${vote.post_id}:${vote.voter_id}`)
      .reduce((sum, e) => sum + e.delta, 0);
    if (contributed !== 0) addKarmaEvent(post.author_id, -contributed, 'vote_changed', post.id);
  }
}

export function applyRemoteSoldOut({ postId, userId }) {
  const post = state.posts[postId];
  if (!post || typeof userId !== 'string') return { ok: false };
  const key = `soldout:${postId}:${userId}`;
  if (state.votes[key]) return { ok: true, duplicate: true };
  state.votes[key] = { kind: 'sold_out', post_id: postId, voter_id: userId, created_at: Date.now() };
  post.sold_out_count += 1;
  persist();
  emit({ type: 'soldout', postId, remote: true });
  return { ok: true };
}

export function applyRemoteDelete({ postId, authorId }) {
  const post = state.posts[postId];
  // Only the author may retract their own sighting — same rule as locally.
  if (!post || post.author_id !== authorId) return { ok: false };
  post.status = 'removed';
  persist();
  emit({ type: 'post:removed', post, remote: true });
  return { ok: true };
}
