/**
 * Live sync — the cross-user layer.
 *
 * Every client publishes its local mutations (posts, votes, sold-out flags,
 * deletions) as small JSON envelopes to a shared pub/sub topic, and applies
 * everyone else's envelopes through db.applyRemote*(). The default broker is
 * ntfy.sh: a public, account-less, CORS-open push service whose topic cache
 * (~12 h) comfortably outlives the 1-hour sighting window, so a freshly opened
 * app can backfill recent sightings with one poll and then ride the SSE stream.
 *
 * Honest constraints of this transport, all prototype-accepted:
 *  - the topic is public and unauthenticated — anyone can read it (sightings
 *    are public by design) and anyone could write junk to it, which is why
 *    db.applyRemote* validates every field and this module rate-limits inserts;
 *  - photos are recompressed hard (~300 px) and chunked to fit the broker's
 *    message size, so receivers see a softer image than the author;
 *  - consistency is best-effort: votes converge via idempotent application,
 *    not via a server. Production replaces exactly this file with Supabase
 *    Realtime + Postgres and deletes those caveats.
 */

import { SYNC } from './config.js';
import * as db from './db.js';
import { uid } from './util.js';

const OVERRIDE_KEY = 'pokeradar.sync.v1';

let cfg = { ...SYNC };
let deviceId = null;
let source = null;
let status = 'connecting';
let statusListener = null;
let remotePostListener = null;
let started = false;

/** Photo chunks arrive out of order and possibly before their meta envelope. */
const pending = new Map();   // post_id -> {meta, author, chunks: Map, timer}
const PENDING_TTL = 2 * 60 * 1000;

/** Flood guard: cap how many remote posts we will insert per minute. */
const insertTimes = [];
const MAX_INSERTS_PER_MIN = 30;

/* ------------------------------------------------------------- lifecycle --- */

function loadOverrides() {
  try {
    const raw = JSON.parse(localStorage.getItem(OVERRIDE_KEY) || '{}');
    if (raw.server) cfg.server = String(raw.server);
    if (raw.topic) cfg.topic = String(raw.topic);
    deviceId = raw.device || null;
    if (!deviceId) {
      deviceId = uid('dev');
      localStorage.setItem(OVERRIDE_KEY, JSON.stringify({ ...raw, device: deviceId }));
    }
  } catch {
    deviceId = uid('dev');
  }
}

export function init({ onStatus, onRemotePost } = {}) {
  statusListener = onStatus || null;
  remotePostListener = onRemotePost || null;
  loadOverrides();

  // Local mutations flow out. Remote applications never reach this bus
  // (db.applyRemote* does not fire actions), so there is no echo loop.
  db.onAction((action) => {
    if (!cfg.enabled) return;
    if (action.type === 'post') publishPost(action.post, action.author);
    else if (action.type === 'vote') publishVote(action.vote, action.voter);
    else if (action.type === 'vote:retract') send({ k: 'unvote', p: action.postId, u: action.voterId });
    else if (action.type === 'soldout') send({ k: 'sold', p: action.postId, u: action.userId });
    else if (action.type === 'delete') send({ k: 'del', p: action.postId, u: action.authorId });
  });
}

export function start() {
  if (started || !cfg.enabled) return;
  started = true;
  backfill().finally(() => subscribe());
}

export const currentStatus = () => status;

function setStatus(next) {
  if (status === next) return;
  status = next;
  statusListener?.(next);
}

/* ------------------------------------------------------------- receiving --- */

/** One poll on startup pulls the broker's cached recent messages. */
async function backfill() {
  try {
    const response = await fetch(`${cfg.server}/${cfg.topic}/json?poll=1&since=${cfg.pollWindow}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { handleBrokerMessage(JSON.parse(line)); } catch { /* skip bad line */ }
    }
  } catch {
    setStatus('offline');
  }
}

function subscribe() {
  try {
    source = new EventSource(`${cfg.server}/${cfg.topic}/sse`);
    source.onopen = () => setStatus('live');
    source.onmessage = (event) => {
      try { handleBrokerMessage(JSON.parse(event.data)); } catch { /* not ours */ }
    };
    // EventSource reconnects on its own; reflect the gap in the pill.
    source.onerror = () => setStatus(navigator.onLine === false ? 'offline' : 'connecting');
  } catch {
    setStatus('offline');
  }
}

function handleBrokerMessage(msg) {
  if (!msg || msg.event !== 'message' || typeof msg.message !== 'string') return;
  let envelope;
  try { envelope = JSON.parse(msg.message); } catch { return; }
  if (!envelope || envelope.v !== 1) return;
  if (envelope.dev === deviceId) return;              // our own echo

  switch (envelope.k) {
    case 'meta': return onMeta(envelope);
    case 'ph': return onPhotoChunk(envelope);
    case 'vote': return void db.applyRemoteVote({
      postId: envelope.p, voter: envelope.voter, value: envelope.value,
      reason: envelope.reason, countsForKarma: envelope.cfk, ts: envelope.ts,
    });
    case 'unvote': return void db.applyRemoteVoteRetraction({ postId: envelope.p, voterId: envelope.u });
    case 'sold': return void db.applyRemoteSoldOut({ postId: envelope.p, userId: envelope.u });
    case 'del': return void db.applyRemoteDelete({ postId: envelope.p, authorId: envelope.u });
    default: /* unknown kinds from newer clients are fine */ ;
  }
}

function bucketFor(id) {
  let entry = pending.get(id);
  if (!entry) {
    entry = { meta: null, author: null, chunks: new Map(), total: 0 };
    entry.timer = setTimeout(() => finalize(id, true), PENDING_TTL);
    pending.set(id, entry);
  }
  return entry;
}

function onMeta(envelope) {
  if (!envelope.t || typeof envelope.id !== 'string') return;
  const entry = bucketFor(envelope.id);
  entry.meta = envelope.t;
  entry.author = envelope.a;
  entry.total = Number(envelope.n) || 0;
  if (entry.total === 0 || entry.chunks.size >= entry.total) finalize(envelope.id);
}

function onPhotoChunk(envelope) {
  if (typeof envelope.id !== 'string' || typeof envelope.d !== 'string') return;
  const entry = bucketFor(envelope.id);
  entry.chunks.set(Number(envelope.i), envelope.d.slice(0, 4000));
  if (entry.meta && entry.total > 0 && entry.chunks.size >= entry.total) finalize(envelope.id);
}

/**
 * Insert once meta + all chunks are here — or on timeout with whatever we
 * have, because a sighting without its photo still beats no sighting.
 */
function finalize(id, timedOut = false) {
  const entry = pending.get(id);
  if (!entry) return;
  if (!entry.meta) { if (timedOut) drop(id); return; }

  let photo = null;
  if (entry.total > 0 && entry.chunks.size >= entry.total) {
    const parts = [];
    let complete = true;
    for (let i = 0; i < entry.total; i++) {
      const part = entry.chunks.get(i);
      if (part === undefined) { complete = false; break; }
      parts.push(part);
    }
    if (complete) photo = `data:image/jpeg;base64,${parts.join('')}`;
  }
  if (!timedOut && entry.total > 0 && !photo) return;   // keep waiting for chunks

  if (!floodOk()) { drop(id); return; }

  const existing = db.getPost(id);
  if (existing) {
    // Post arrived earlier without its photo; chunks completed later.
    if (photo) db.attachRemotePhoto(id, photo);
    drop(id);
    return;
  }

  const result = db.applyRemotePost({ ...entry.meta, id, photo }, entry.author);
  if (result.ok) remotePostListener?.(result.post);
  drop(id);
}

function drop(id) {
  const entry = pending.get(id);
  if (entry) clearTimeout(entry.timer);
  pending.delete(id);
}

function floodOk() {
  const now = Date.now();
  while (insertTimes.length && now - insertTimes[0] > 60000) insertTimes.shift();
  if (insertTimes.length >= MAX_INSERTS_PER_MIN) return false;
  insertTimes.push(now);
  return true;
}

/* ------------------------------------------------------------ publishing --- */

const queue = [];
let sending = false;

function send(payload) {
  queue.push(JSON.stringify({ v: 1, dev: deviceId, ...payload }));
  pump();
}

async function pump() {
  if (sending) return;
  sending = true;
  while (queue.length) {
    const body = queue.shift();
    try {
      await fetch(`${cfg.server}/${cfg.topic}`, { method: 'POST', body });
    } catch {
      // Broker unreachable: drop the message rather than block the queue —
      // the local write already succeeded, only the broadcast is lost.
      setStatus('offline');
    }
  }
  sending = false;
}

function profileSnapshot(profile) {
  if (!profile) return null;
  return {
    id: profile.id,
    username: profile.username,
    avatar: profile.avatar,
    karma: profile.karma,
    created_at: profile.created_at,
    email_verified_at: profile.email_verified_at,
  };
}

async function publishPost(post, author) {
  const meta = {
    title: post.title,
    description: post.description,
    lat: post.lat,
    lng: post.lng,
    location_accuracy_m: post.location_accuracy_m,
    store_name: post.store_name,
    store_place_id: post.store_place_id,
    captured_at: post.captured_at,
  };

  let chunks = [];
  if (post.photo) {
    try {
      const base64 = (await shrinkForWire(post.photo)).split(',')[1] || '';
      for (let i = 0; i < base64.length; i += cfg.chunkChars) {
        chunks.push(base64.slice(i, i + cfg.chunkChars));
      }
    } catch { chunks = []; }
  }

  send({ k: 'meta', id: post.id, t: meta, a: profileSnapshot(author), n: chunks.length });
  chunks.forEach((data, i) => send({ k: 'ph', id: post.id, i, n: chunks.length, d: data }));
}

function publishVote(vote, voter) {
  send({
    k: 'vote',
    p: vote.post_id,
    voter: profileSnapshot(voter),
    value: vote.value,
    reason: vote.reason,
    cfk: vote.counts_for_karma,
    ts: vote.updated_at,
  });
}

/** Recompress for the wire — the broker caps message sizes, quality is local. */
function shrinkForWire(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, cfg.photoMaxEdge / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', cfg.photoQuality));
    };
    image.onerror = reject;
    image.src = dataUrl;
  });
}
