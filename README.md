# PokeRadar

A live map of Pokémon merchandise restocks in physical stores. Someone spots product on a shelf, photographs it, and the sighting appears as a marker on everyone's map — for exactly one hour. Karma rewards the reporters who get it right.

**[Open the live demo →](https://trikophalo.github.io/PokeRadar/)** · **[Read the architecture plan →](PLANNING.md)**

> **First-time setup:** GitHub Pages has to be switched on once by a repository admin before that link resolves — see [Deploying](#deploying). The Actions token is not allowed to create the Pages site on its own.

---

## What this repository contains

Two things, and it is worth being clear about which is which.

**`PLANNING.md` is the product and architecture plan** — the real design: React Native (Expo) + Supabase/PostGIS + Mapbox, the data model, the karma rules, the anti-abuse strategy, the roadmap. That document is the specification.

**Everything else is a working web prototype of that plan**, built to run on GitHub Pages so the concept can be used rather than just read. It is a real application — real map, real camera, real geolocation, real rules, and **real cross-user live sync**: sightings, votes and sold-out flags travel between everyone with the app open, over a public pub/sub broker (ntfy.sh) that stands in for Supabase Realtime. The Supabase database itself is replaced by a browser-local data layer that mirrors the planned schema. Nothing is a mockup or a click-through; every screen is driven by live state.

## What actually works

- **Live map** with photo markers, each wrapped in a countdown ring that depletes over the sighting's hour. Screen-space clustering keeps it legible when markers collide.
- **Camera-first posting** — a real `getUserMedia` capture, no gallery import, exactly as the anti-abuse design requires. Title, optional description, and GPS-tagged location snapped to a nearby store.
- **One-hour expiry** enforced as a query-time filter: markers vanish at the right second, but the record survives for karma and moderation.
- **Confirm / Dispute / Sold-out**, with sold-out kept deliberately separate from downvotes so an honest reporter is not punished when the shelf empties.
- **Karma as an append-only ledger** with tiers, per-post caps, and probation for new accounts — vote retraction reverses the ledger exactly.
- **The 10-minute rate limit**, enforced in the data layer and surfaced as a countdown ring on the + button rather than a dead control.
- **Profile and karma view** — progress ring toward the next tier, accuracy stat, post history, private ledger.
- **Live cross-user sync** — post a sighting and everyone with the app open sees the marker drop within seconds, photo included; their confirms, disputes and sold-out flags flow back to you. A status dot in the top chrome shows the connection. The §6 rules cross the wire intact: incoming envelopes are validated and clamped, probation still voids karma, and rate limits still hold.
- **Store names learned from the community** — no seeded store list. Posting offers nearby known stores as one-tap chips, plus free-text entry with typing assistance (chains + every store the community has already named). A manually entered store becomes a suggestion for everyone once the post syncs.
- **The Scout system** — a second currency beside karma. Karma stays pure trust; XP pays instantly for activity: posting, first finds at a store (⭐ on the marker), confirms received, judging others, flyer finds, weekly posting streaks. Nine levels, eight badges, and a progress bar on the profile. XP buys no reach — levels are identity, not power.
- **Light and dark themes**, including a dark basemap; installable as a PWA; works offline after first load.

There is no simulated community any more — the map starts honestly empty and fills with real posts.

## Running it locally

No build step and no dependencies to install. Serve the directory over HTTP:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

It must be served over `http://` or `https://` rather than opened as a `file://` path — ES modules, the camera, and geolocation all require an origin. The camera additionally requires a secure context, so use `localhost` or HTTPS.

## Deploying

Pages must be enabled once by hand — GitHub does not let a workflow's own token create the Pages site. After that, either mode works, because the site is plain static files at the repository root:

- **Deploy from a branch** (simplest) — Settings → Pages → Source: *Deploy from a branch*, then pick `claude/pokeradar-app-planning-d769co` and the `/ (root)` folder. It publishes straight away; no Actions run involved.
- **GitHub Actions** — Settings → Pages → Source: *GitHub Actions*. `.github/workflows/deploy-pages.yml` then uploads the repository and publishes it on every push. Re-run the latest workflow once after switching, since the runs before Pages existed will have failed at the configure step.

`.nojekyll` is present so Pages serves the files as-is.

## How it is put together

```
index.html              app shell — the map, floating chrome, sheet, and modals
css/app.css             design system: tokens, both themes, every component
js/config.js            every product rule in one place (expiry, cooldown, tiers, basemap)
js/db.js                the backend stand-in — schema, constraints, karma ledger
js/map.js               MapLibre setup, photo markers, countdown rings, clustering
js/sheet.js             the bottom sheet with peek/half/full snap points
js/compose.js           camera capture and the post creation flow
js/ui.js                view rendering — cards, detail, profile, karma ring
js/sync.js              live cross-user sync over a public pub/sub broker
js/xp.js                the Scout system — XP, levels, streaks, badges (derived)
vendor/maplibre/        MapLibre GL JS 5.24.0, vendored (BSD-3-Clause)
```

Two conventions hold the thing together. Product rules live in `config.js`, so changing the expiry window or the karma formula is a one-line edit. And views never decide whether an action is allowed — they ask `db.js` and render the answer, which is the same split the real build needs when those rules move into Postgres triggers and row-level security.

### Going from the prototype to the real thing

The prototype was written so that the substitution is mechanical rather than a rewrite:

| Prototype | Production (per `PLANNING.md`) |
|---|---|
| `db.js` over `localStorage` | Supabase Postgres + PostGIS, same tables |
| Rules enforced in mutators | Row-level security and `BEFORE INSERT` triggers |
| `activePosts()` filter | `posts_in_bbox()` RPC with a GIST index |
| `sync.js` over ntfy.sh | Supabase Realtime subscriptions |
| Photos as data URLs | Supabase Storage with CDN thumbnail transforms |
| Local username sign-in | Sign in with Apple / Google / email |
| MapLibre + keyless OSM tiles | Mapbox (swap the style object in `config.js`) |

## Known limits

It is a prototype, and these are deliberate rather than overlooked:

- **Sync is best-effort.** Sightings and votes sync live over a public, unauthenticated broker topic: anyone can read it (sightings are public by design), photos are recompressed hard for the wire, and consistency converges rather than being guaranteed. Accounts and karma ledgers stay on-device. The real backend replaces all of this with authenticated Realtime + Postgres.
- **Basemap tiles come from a third party** (CARTO's OSM-derived tiles, no API key). If they are unreachable the app fails over to a backup source and then to a plain ground colour — the markers stay correctly positioned either way.
- **No moderation queue, image moderation, app attestation, or push notifications.** These are specified in `PLANNING.md` §6 and are server-side work.
- **"PokeRadar" is a working title.** The name collides with Nintendo trademark territory; `PLANNING.md` §7 covers the legal review that has to happen before any store submission. No Nintendo assets are used anywhere in this repository.

## Licence and attribution

MapLibre GL JS is vendored under BSD-3-Clause (`vendor/maplibre/LICENSE.txt`). Basemap tiles are © OpenStreetMap contributors and © CARTO. All artwork in this repository is original.
