/**
 * PokeRadar — application wiring.
 *
 * Boot order: restore state → resolve a map centre → make sure the world has
 * sightings in it → bring up the map, the sheet and the compose flow.
 */

import { DEMO, FALLBACK_CENTER, PREFS_KEY, RULES } from './config.js';
import * as db from './db.js';
import { ComposeFlow } from './compose.js';
import { RadarMap } from './map.js';
import { ModalSheet, Sheet } from './sheet.js';
import { DemoHeartbeat, generateStores, seedWorld } from './seed.js';
import * as flyers from './flyers.js';
import { FlyerViewer, renderFlyers } from './flyerview.js';
import {
  avatarEl, renderFeed, renderPostDetail, renderProfile, toast, updateComposeButton,
} from './ui.js';
import { $, clear, distanceMeters, el, formatRemaining, haptic } from './util.js';

const prefs = loadPrefs();

const app = {
  map: null,
  sheet: null,
  stores: [],
  center: null,
  userLocation: null,
  mode: 'feed',        // 'feed' | 'detail'
  tab: 'radar',        // 'radar' | 'flyers'
  selectedPostId: null,
  heartbeat: null,
};

/* ----------------------------------------------------------------- prefs --- */

function loadPrefs() {
  try {
    return { theme: 'system', ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return { theme: 'system' };
  }
}

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
}

function resolvedTheme() {
  if (prefs.theme !== 'system') return prefs.theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme() {
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = prefs.theme === 'system' ? '' : prefs.theme;
  if (prefs.theme === 'system') document.documentElement.removeAttribute('data-theme');
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#0F0F11' : '#F7F7F8');
  app.map?.setTheme(theme);
}

/* ------------------------------------------------------------ geolocation --- */

/**
 * Ask once, degrade gracefully. A denied prompt is a normal state, not an
 * error: the map opens on a default city so the visitor still sees a live
 * radar, and posting explains what it needs when they try.
 */
function resolveCenter() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ ...FALLBACK_CENTER, precise: false });
    const timeout = setTimeout(() => resolve({ ...FALLBACK_CENTER, precise: false }), 6000);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        clearTimeout(timeout);
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
          precise: true,
        });
      },
      () => {
        clearTimeout(timeout);
        resolve({ ...FALLBACK_CENTER, precise: false });
      },
      { enableHighAccuracy: true, timeout: 5500, maximumAge: 30000 },
    );
  });
}

function watchLocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(
    (position) => {
      app.userLocation = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
      };
      app.map?.setUserLocation(app.userLocation);
    },
    () => { /* keep whatever fix we already have */ },
    { enableHighAccuracy: true, maximumAge: 20000, timeout: 20000 },
  );
}

/* ------------------------------------------------------------------ boot --- */

async function boot() {
  db.load();
  applyTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  const center = await resolveCenter();
  app.center = center;
  if (center.precise) app.userLocation = center;

  app.stores = generateStores(center);

  // Reseed when the visitor is somewhere else entirely — a map full of
  // sightings 400 km away is worse than no map at all.
  const meta = db.raw().meta;
  const movedFar = meta.center && distanceMeters(meta.center, center) > 25000;
  if (!meta.seeded_at || movedFar || db.activePosts().length === 0) {
    if (movedFar) resetWorldPosts();
    seedWorld(center);
  }

  app.map = new RadarMap($('#map'), {
    center,
    theme: resolvedTheme(),
    onSelect: openPost,
    onClusterTap: (postIds, at) => {
      app.map.flyTo(at, Math.min(18, app.map.map.getZoom() + 2));
      openPost(postIds[0]);
    },
  });
  await app.map.ready;
  if (app.userLocation) app.map.setUserLocation(app.userLocation);

  $('#map').addEventListener('basemap:degraded', () => {
    toast('Basemap tiles unavailable — switched to a backup source.', { tone: 'warn' });
  });

  app.sheet = new Sheet($('#sheet'), {
    onSnap: (snap) => { if (snap === 'peek' && app.mode === 'detail') showFeed(); },
  });

  wireChrome();
  startHeartbeat();

  // The flyer feed is a static file written by the daily job — load it in the
  // background so the map is never waiting on it.
  flyers.loadFlyers().then(() => { if (app.tab === 'flyers') paintFlyers(); });
  setInterval(() => flyers.loadFlyers().then(() => {
    if (app.tab === 'flyers') paintFlyers();
  }), 60 * 60 * 1000);

  db.subscribe(() => { refresh(); });
  refresh();
  setInterval(refresh, 15000);           // sweeps expired sightings off the map
  setInterval(tickCooldown, 1000);
  watchLocation();

  document.body.classList.remove('is-booting');
  $('#splash')?.remove();

  // Deliberately exposed: this is a prototype, and being able to poke at the
  // live state from the console is worth more here than hiding it.
  window.__pokeradar = { app, db };
}

function resetWorldPosts() {
  const state = db.raw();
  for (const [id, post] of Object.entries(state.posts)) {
    if (post.is_demo_seed) delete state.posts[id];
  }
}

/* ---------------------------------------------------------------- chrome --- */

function wireChrome() {
  $('#fab').addEventListener('click', () => {
    if (!db.currentUser()) return openAuth();
    compose.open();
  });

  $('#locate').addEventListener('click', () => {
    if (app.userLocation) {
      app.map.flyTo(app.userLocation, 15.5);
      haptic(8);
    } else {
      toast('Location unavailable — allow access to centre the map on you.', { tone: 'warn' });
    }
  });

  $('#theme-toggle').addEventListener('click', () => {
    const order = ['system', 'light', 'dark'];
    prefs.theme = order[(order.indexOf(prefs.theme) + 1) % order.length];
    savePrefs();
    applyTheme();
    paintThemeToggle();
    toast(`Appearance: ${prefs.theme}`);
  });
  paintThemeToggle();

  $('#account').addEventListener('click', () => {
    const me = db.currentUser();
    if (me) openProfile(me.id);
    else openAuth();
  });

  $('#sheet-back').addEventListener('click', showFeed);

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  }
}

/**
 * §10.6: the flyer tab is the first view that is not a sheet over the map, so
 * the map chrome steps aside entirely rather than layering.
 */
function switchTab(tab) {
  if (app.tab === tab) return;
  app.tab = tab;
  const onFlyers = tab === 'flyers';

  document.body.classList.toggle('is-flyers', onFlyers);
  $('#flyers-view').hidden = !onFlyers;
  for (const node of document.querySelectorAll('.tab')) {
    const active = node.dataset.tab === tab;
    node.classList.toggle('is-active', active);
    node.setAttribute('aria-selected', String(active));
  }

  if (onFlyers) {
    paintFlyers();
    flyers.loadFlyers().then(paintFlyers);
  } else {
    // The map was hidden while the tab was away; MapLibre needs to re-measure.
    requestAnimationFrame(() => app.map?.map.resize());
  }
  haptic(6);
}

function paintFlyers() {
  renderFlyers({
    stores: app.stores,
    origin: app.userLocation || app.center,
    onOpen: (flyerId) => flyerViewer.open(flyerId),
    onRequireAuth: openAuth,
  });
}

function paintThemeToggle() {
  const glyph = { system: '◐', light: '☀', dark: '☾' }[prefs.theme];
  $('#theme-toggle').textContent = glyph;
  $('#theme-toggle').setAttribute('aria-label', `Appearance: ${prefs.theme}`);
}

function paintAccount() {
  const me = db.currentUser();
  const host = $('#account');
  clear(host);
  if (me) {
    host.append(avatarEl(me));
    host.setAttribute('aria-label', `Your profile — ${me.username}`);
  } else {
    host.append(el('span', { class: 'account__signin', text: 'Sign in' }));
    host.setAttribute('aria-label', 'Sign in');
  }
}

/* ------------------------------------------------------------------ views --- */

function refresh() {
  const posts = db.activePosts();
  app.map?.render(posts);
  paintAccount();
  updateComposeButton($('#fab'));

  if (app.tab === 'flyers') paintFlyers();

  if (app.mode === 'detail' && app.selectedPostId) {
    const post = db.getPost(app.selectedPostId);
    if (!post || post.status !== 'active') return showFeed();
    // In detail mode the header describes *this* sighting; the global live
    // count here would read as a property of the post.
    $('#sheet-sub').textContent = post.store_name?.split(',')[0] || 'Sighting';
    $('#sheet-count').textContent = db.isExpired(post)
      ? 'off the map'
      : formatRemaining(post.expires_at - Date.now());
    renderPostDetail($('#sheet-content'), app.selectedPostId, detailContext());
  } else {
    $('#sheet-sub').textContent = 'last hour';
    $('#sheet-count').textContent = posts.length
      ? `${posts.length} live ${posts.length === 1 ? 'sighting' : 'sightings'}`
      : 'Nothing on the radar';
    renderFeed($('#sheet-content'), { origin: app.userLocation, onTapPost: openPost });
  }
}

function detailContext() {
  return {
    origin: app.userLocation,
    refresh,
    onRequireAuth: openAuth,
    onOpenProfile: openProfile,
    onReport: openReport,
    onDeleted: () => { showFeed(); refresh(); },
  };
}

function showFeed() {
  app.mode = 'feed';
  app.selectedPostId = null;
  app.map?.select(null);
  $('#sheet-back').hidden = true;
  $('#sheet-title').textContent = 'Nearby sightings';
  refresh();
}

function openPost(postId) {
  const post = db.getPost(postId);
  if (!post) return;
  app.mode = 'detail';
  app.selectedPostId = postId;
  app.map.select(postId);
  $('#sheet-back').hidden = false;
  $('#sheet-title').textContent = 'Sighting';
  refresh();
  app.sheet.snapTo('half');
  haptic(6);
}

function tickCooldown() {
  updateComposeButton($('#fab'));
  if (app.mode === 'detail') {
    const post = db.getPost(app.selectedPostId);
    if (post && db.isExpired(post)) refresh();
  }
}

/* ------------------------------------------------------------------ modals --- */

const profileModal = new ModalSheet($('#profile-modal'));
const authModal = new ModalSheet($('#auth-modal'));
const composeModal = new ModalSheet($('#compose-modal'));

const viewerModal = new ModalSheet($('#viewer-modal'));
const flyerViewer = new FlyerViewer(viewerModal, {
  getStores: () => app.stores,
  getOrigin: () => app.userLocation || app.center,
  onChanged: () => { paintFlyers(); refresh(); },
  onRequireAuth: openAuth,
});

const compose = new ComposeFlow(composeModal, {
  getLocation: () => app.userLocation,
  getStores: () => app.stores,
  onPosted: (post) => {
    refresh();
    app.map.flyTo(post, Math.max(15, app.map.map.getZoom()));
    setTimeout(() => openPost(post.id), 700);
  },
});

function openProfile(userId) {
  if (!userId) return;
  renderProfile(profileModal.panel, userId, {
    onTapPost: (postId) => { profileModal.close(); openPost(postId); },
    onSignOut: () => {
      db.signOut();
      profileModal.close();
      toast('Signed out.');
      refresh();
    },
    onResetDemo: () => {
      if (!confirm('Reset all demo data — sightings, karma and your account?')) return;
      db.reset();
      profileModal.close();
      location.reload();
    },
    themeControl: () => el('button', {
      class: 'linkbtn', type: 'button', text: `${prefs.theme} ▸`,
      onclick: () => { $('#theme-toggle').click(); profileModal.close(); },
    }),
  });
  profileModal.panel.prepend(el('button', {
    class: 'iconbtn iconbtn--float', type: 'button', 'aria-label': 'Close', text: '✕',
    onclick: () => profileModal.close(),
  }));
  profileModal.open();
}

/**
 * `onSuccess` matters when auth is raised from on top of another view — the
 * flyer viewer stays open behind the sheet, and needs to re-render as signed in
 * rather than leaving a stale, still-gated button.
 */
function openAuth(onSuccess) {
  const panel = authModal.panel;
  clear(panel);

  const input = el('input', {
    class: 'field__input', type: 'text', maxlength: '20', placeholder: 'e.g. regalradar',
    'aria-label': 'Username', autofocus: true,
  });
  const error = el('p', { class: 'auth__error', hidden: true });

  const submit = () => {
    const result = db.signIn(input.value);
    if (!result.ok) {
      error.textContent = result.error;
      error.hidden = false;
      return;
    }
    authModal.close();
    toast(`Welcome, ${result.profile.username}.`, { tone: 'good' });
    refresh();
    if (typeof onSuccess === 'function') onSuccess();
  };

  panel.append(
    el('div', { class: 'auth' }, [
      el('div', { class: 'auth__mark', html: markSvg() }),
      el('h2', { class: 'auth__title', text: 'Join the radar' }),
      el('p', { class: 'auth__body', text:
        'Posting and voting need an account, which is what makes karma mean anything. Pick a public name — PokeRadar is pseudonymous by design and never shows a real one.' }),
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label', text: 'Username' }),
        input,
      ]),
      error,
      el('button', { class: 'btn btn--primary btn--full', type: 'button', text: 'Continue', onclick: submit }),
      el('p', { class: 'auth__note', text:
        'Demo build: accounts live in this browser only. The production app signs in with Apple, Google or email.' }),
    ]),
  );

  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
  authModal.open();
}

function openReport(postId) {
  const reasons = [
    ['fake', 'Fake or misleading'],
    ['inappropriate', 'Inappropriate content'],
    ['contains_people', 'Photo shows people'],
    ['spam', 'Spam'],
  ];
  const label = reasons.map(([, text], i) => `${i + 1}. ${text}`).join('\n');
  const answer = prompt(`Report this sighting:\n${label}\n\nEnter 1–4:`);
  const index = Number(answer) - 1;
  if (!reasons[index]) return;

  const result = db.reportPost(postId, reasons[index][0]);
  if (!result.ok) return toast(result.error, { tone: 'warn' });
  toast(result.hidden
    ? 'Reported — this sighting is now hidden pending review.'
    : 'Reported. Thanks for keeping the map honest.');
  refresh();
}

/* --------------------------------------------------------------- heartbeat --- */

function startHeartbeat() {
  app.heartbeat = new DemoHeartbeat({
    stores: app.stores,
    onNewPost: () => { /* db.emit already drives the re-render */ },
  });
  app.heartbeat.start();
}

/* -------------------------------------------------------------------- misc --- */

function markSvg() {
  return `<svg viewBox="0 0 48 48" aria-hidden="true">
    <circle cx="24" cy="24" r="21" fill="none" stroke="var(--accent)" stroke-width="3" opacity="0.28"/>
    <circle cx="24" cy="24" r="21" fill="none" stroke="var(--accent)" stroke-width="3"
            stroke-linecap="round" stroke-dasharray="66 132" transform="rotate(-90 24 24)"/>
    <circle cx="24" cy="24" r="12" fill="var(--surface)" stroke="var(--line)" stroke-width="1.5"/>
    <circle cx="24" cy="24" r="8" fill="var(--accent)"/>
  </svg>`;
}

window.addEventListener('error', (event) => {
  console.error('[pokeradar]', event.error || event.message);
});

boot().catch((error) => {
  console.error('[pokeradar] boot failed', error);
  document.body.classList.remove('is-booting');
  const splash = $('#splash');
  if (splash) {
    splash.innerHTML = '<div class="splash__error"><h1>Could not start</h1>'
      + '<p>Reload the page, or reset stored data if this keeps happening.</p></div>';
  }
});

// Registered only over http(s) — opening the file directly would throw.
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support is optional */ });
  });
}
