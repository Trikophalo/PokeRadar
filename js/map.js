/**
 * The map surface.
 *
 * MapLibre GL JS (the open fork of Mapbox GL) is vendored into the repo so the
 * page needs no API key to run. PLANNING.md §2 recommends Mapbox for the real
 * client; the style object below is the only thing that has to change — the
 * marker and clustering code is written against the shared GL JS API.
 *
 * The marker is the product (§5): a circular photo in a white ring, wrapped in
 * a countdown ring that depletes over the sighting's hour.
 */

import { BASEMAP, RULES, tierFor } from './config.js';
import * as db from './db.js';
import { photoFor } from './db.js';
import { clamp, el, prefersReducedMotion } from './util.js';

const RING_RADIUS = 45;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const CLUSTER_RADIUS_PX = 46;

export class RadarMap {
  constructor(container, { center, theme, onSelect, onClusterTap }) {
    this.container = container;
    this.onSelect = onSelect;
    this.onClusterTap = onClusterTap;
    this.markers = new Map();      // post_id -> {marker, root, refs}
    this.clusters = [];
    this.selectedId = null;
    this.usingFallbackTiles = false;
    this.tileErrors = 0;
    // Set before the map exists: a tile error can arrive before any caller has
    // had a chance to tell us which theme we are in.
    this.currentTheme = theme;

    this.map = new maplibregl.Map({
      container,
      style: styleFor(theme, false),
      center: [center.lng, center.lat],
      zoom: 14.3,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.addControl(
      new maplibregl.AttributionControl({ compact: true, customAttribution: BASEMAP.attribution }),
      'bottom-right',
    );

    this.map.on('error', (event) => this.handleMapError(event));
    this.map.on('move', () => this.scheduleCluster());
    this.map.on('zoom', () => this.scheduleCluster());

    /**
     * Ready means "the style is parsed so we can add layers and markers" — not
     * "every tile arrived". MapLibre withholds its `load` event until sources
     * settle, so gating boot on it strands the whole app behind a splash screen
     * whenever the tile CDN is slow or blocked. The timeout is the last resort.
     */
    this.ready = new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        this.addAccuracyLayer();
        resolve();
      };
      this.map.on('styledata', done);
      this.map.on('load', done);
      setTimeout(done, 5000);
    });

    // One shared ticker drives every countdown ring — not a timer per marker.
    this.ticker = setInterval(() => this.tick(), 1000);
  }

  destroy() {
    clearInterval(this.ticker);
    this.map.remove();
  }

  /* ------------------------------------------------------------- basemap --- */

  /**
   * Tiles come from a third party, so treat an outage as a state to design for
   * rather than an impossibility: fail over once, then let the ground colour
   * carry the map. Markers stay correctly positioned either way.
   */
  handleMapError(event) {
    const url = event?.error?.url || '';
    if (!url.includes('{') && (url.includes('cartocdn') || url.includes('tile.'))) {
      this.tileErrors += 1;
      if (this.tileErrors > 6 && !this.usingFallbackTiles) {
        this.usingFallbackTiles = true;
        this.setTheme(this.currentTheme, true);
        this.container.dispatchEvent(
          new CustomEvent('basemap:degraded', { bubbles: true, detail: { fallback: true } }),
        );
      }
    }
  }

  setTheme(theme, force = false) {
    if (theme === this.currentTheme && !force) return;
    this.currentTheme = theme;
    const center = this.map.getCenter();
    const zoom = this.map.getZoom();
    this.map.setStyle(styleFor(theme, this.usingFallbackTiles));
    this.map.once('styledata', () => {
      this.map.jumpTo({ center, zoom });
      this.addAccuracyLayer();
      if (this.lastUserLocation) this.setUserLocation(this.lastUserLocation);
    });
  }

  /* ------------------------------------------------------- user location --- */

  addAccuracyLayer() {
    // Adding sources before the style is parsed throws, and the style can be
    // swapped underneath us by the theme toggle, so re-check every time.
    if (!this.map.style || !this.map.isStyleLoaded()) {
      this.map.once('styledata', () => this.addAccuracyLayer());
      return;
    }
    if (this.map.getSource('me')) return;
    this.map.addSource('me', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    this.map.addLayer({
      id: 'me-halo',
      type: 'circle',
      source: 'me',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 6, 18, 34],
        'circle-color': '#0A84FF',
        'circle-opacity': 0.16,
      },
    });
    this.map.addLayer({
      id: 'me-dot',
      type: 'circle',
      source: 'me',
      paint: {
        'circle-radius': 6.5,
        'circle-color': '#0A84FF',
        'circle-stroke-width': 2.5,
        'circle-stroke-color': '#fff',
      },
    });
  }

  setUserLocation(location) {
    this.lastUserLocation = location;
    const source = this.map.getSource('me');
    if (!source) return;
    source.setData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [location.lng, location.lat] },
        properties: {},
      }],
    });
  }

  flyTo(location, zoom = 15) {
    this.map.flyTo({
      center: [location.lng, location.lat],
      zoom,
      duration: prefersReducedMotion() ? 0 : 900,
      essential: true,
    });
  }

  /* ------------------------------------------------------------- markers --- */

  /** Reconcile the marker set against the currently visible posts. */
  render(posts) {
    const seen = new Set();

    for (const post of posts) {
      seen.add(post.id);
      let entry = this.markers.get(post.id);
      if (!entry) {
        entry = this.createMarker(post);
        this.markers.set(post.id, entry);
      }
      this.updateMarker(entry, post);
    }

    for (const [id, entry] of this.markers) {
      if (!seen.has(id)) {
        entry.marker.remove();
        this.markers.delete(id);
      }
    }

    this.scheduleCluster();
  }

  createMarker(post) {
    const refs = {};
    const root = el('button', {
      class: 'marker',
      type: 'button',
      'aria-label': `Sighting: ${post.title}`,
    });

    const ring = el('span', { class: 'marker__ring', html: `
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle class="marker__track" cx="50" cy="50" r="${RING_RADIUS}" />
        <circle class="marker__arc" cx="50" cy="50" r="${RING_RADIUS}"
                stroke-dasharray="${RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}"
                transform="rotate(-90 50 50)" />
      </svg>` });

    refs.arc = ring.querySelector('.marker__arc');
    refs.photo = el('span', { class: 'marker__photo' });
    refs.badge = el('span', { class: 'marker__badge', hidden: true });
    // First find at this store in 24 h — the Scout system's visible reward.
    refs.star = el('span', { class: 'marker__star', hidden: true, text: '★' });

    root.append(ring, refs.photo, refs.badge, refs.star);
    root.addEventListener('click', (event) => {
      event.stopPropagation();
      this.onSelect?.(post.id);
    });

    const marker = new maplibregl.Marker({ element: root, anchor: 'center' })
      .setLngLat([post.lng, post.lat])
      .addTo(this.map);

    if (!prefersReducedMotion()) {
      root.classList.add('marker--enter');
      setTimeout(() => root.classList.remove('marker--enter'), 640);
    }

    return { marker, root, refs, postId: post.id };
  }

  updateMarker(entry, post) {
    const { refs, root } = entry;

    const photo = photoFor(post);
    if (photo && refs.photoUrl !== photo) {
      refs.photo.style.backgroundImage = `url("${photo}")`;
      refs.photoUrl = photo;
    }

    const author = db.getProfile(post.author_id);
    const tier = author ? tierFor(author.karma) : null;
    // §4: a Trusted Reporter's marker reads as more credible — but it is not
    // bigger, does not rank higher, and does not outlive the hour.
    const trusted = tier && (tier.key === 'trusted' || tier.key === 'veteran' || tier.key === 'legend');
    root.classList.toggle('marker--trusted', Boolean(trusted));

    const gone = db.isLikelyGone(post);
    root.classList.toggle('marker--gone', gone);
    refs.badge.hidden = !gone;
    refs.badge.textContent = gone ? 'gone?' : '';
    refs.star.hidden = gone || !db.isFirstScout(post);

    root.classList.toggle('marker--selected', this.selectedId === post.id);
    entry.expiresAt = post.expires_at;
    entry.capturedAt = post.captured_at;
    this.paintRing(entry);
  }

  paintRing(entry) {
    const total = RULES.visibilityMs;
    const remaining = clamp(entry.expiresAt - Date.now(), 0, total);
    const fraction = remaining / total;
    entry.refs.arc.setAttribute(
      'stroke-dasharray',
      `${(RING_CIRCUMFERENCE * fraction).toFixed(2)} ${RING_CIRCUMFERENCE}`,
    );
    entry.root.classList.toggle('marker--ending', remaining < 5 * 60 * 1000);
  }

  tick() {
    for (const entry of this.markers.values()) this.paintRing(entry);
  }

  select(postId) {
    this.selectedId = postId;
    for (const [id, entry] of this.markers) {
      entry.root.classList.toggle('marker--selected', id === postId);
    }
  }

  /* ------------------------------------------------------------ clusters --- */

  scheduleCluster() {
    if (this.clusterFrame) return;
    this.clusterFrame = requestAnimationFrame(() => {
      this.clusterFrame = null;
      this.recluster();
    });
  }

  /**
   * Greedy screen-space clustering. Markers are photo thumbnails, so they
   * collide badly when zoomed out; grouping them keeps the map legible without
   * pushing the imagery into a vector layer.
   */
  recluster() {
    const entries = [...this.markers.values()];
    const projected = entries.map((entry) => {
      const lngLat = entry.marker.getLngLat();
      const point = this.map.project(lngLat);
      return { entry, point };
    });

    const claimed = new Set();
    const groups = [];

    for (const item of projected) {
      if (claimed.has(item.entry.postId)) continue;
      const members = [item];
      claimed.add(item.entry.postId);

      for (const other of projected) {
        if (claimed.has(other.entry.postId)) continue;
        const dx = item.point.x - other.point.x;
        const dy = item.point.y - other.point.y;
        if (Math.hypot(dx, dy) < CLUSTER_RADIUS_PX) {
          members.push(other);
          claimed.add(other.entry.postId);
        }
      }
      groups.push(members);
    }

    for (const cluster of this.clusters) cluster.remove();
    this.clusters = [];

    for (const group of groups) {
      const isCluster = group.length > 1;
      for (const { entry } of group) {
        entry.root.classList.toggle('marker--hidden', isCluster);
      }
      if (!isCluster) continue;

      const lat = group.reduce((s, g) => s + g.entry.marker.getLngLat().lat, 0) / group.length;
      const lng = group.reduce((s, g) => s + g.entry.marker.getLngLat().lng, 0) / group.length;
      this.clusters.push(this.createCluster(group, { lat, lng }));
    }
  }

  createCluster(group, center) {
    const root = el('button', {
      class: 'cluster',
      type: 'button',
      'aria-label': `${group.length} sightings here`,
    });

    const stack = el('span', { class: 'cluster__stack' });
    for (const { entry } of group.slice(0, 3)) {
      const chip = el('span', { class: 'cluster__chip' });
      if (entry.refs.photoUrl) chip.style.backgroundImage = `url("${entry.refs.photoUrl}")`;
      stack.append(chip);
    }
    root.append(stack, el('span', { class: 'cluster__count', text: String(group.length) }));

    root.addEventListener('click', (event) => {
      event.stopPropagation();
      this.onClusterTap?.(group.map((g) => g.entry.postId), center);
    });

    return new maplibregl.Marker({ element: root, anchor: 'center' })
      .setLngLat([center.lng, center.lat])
      .addTo(this.map);
  }
}

/* ----------------------------------------------------------------- style --- */

function styleFor(theme, useFallback) {
  const key = theme === 'dark' ? 'dark' : 'light';
  const tiles = useFallback ? BASEMAP.fallbackTiles[key] : BASEMAP.tiles[key];

  return {
    version: 8,
    sources: {
      basemap: {
        type: 'raster',
        tiles,
        tileSize: useFallback ? 256 : 512,
        maxzoom: 19,
        attribution: BASEMAP.attribution,
      },
    },
    layers: [
      // Painted under the tiles: a tile outage degrades to clean ground, not
      // a broken checkerboard.
      { id: 'ground', type: 'background', paint: { 'background-color': BASEMAP.ground[key] } },
      { id: 'basemap', type: 'raster', source: 'basemap', paint: { 'raster-opacity': 1 } },
    ],
  };
}
