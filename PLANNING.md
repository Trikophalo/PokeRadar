# PokeRadar — Product & Architecture Plan

*Working document, v1 — planning stage, no code yet.*

PokeRadar is a community "radar" for Pokémon merchandise restocks. A shopper who spots restocked product at a physical store (Müller, Edeka, Walmart, …) snaps a photo and posts it; the sighting appears as a photo marker on a live map for exactly one hour, so nearby collectors can act on it while it's still true. Reputation (karma) makes accurate reporters visible and makes lying expensive.

The core loop: **spot → post (≤30 seconds) → nearby users get value → they confirm/deny → poster earns karma → poster posts again.** Every design decision below is judged against that loop: posting must be near-instant, the map must feel alive and trustworthy, and honesty must be the winning strategy.

---

## 1. Recommended architecture

**Recommendation: React Native (Expo) client + Supabase backend + Mapbox for the map.** This is the smallest stack that covers every hard requirement — geospatial queries, image storage, auth, realtime updates, and server-enforced rules — without building and operating custom servers.

```
┌────────────────────── Mobile app — Expo / React Native (TypeScript) ─────────────────────┐
│  Mapbox map (photo markers,      Camera-first     Bottom-sheet UI      Offline outbox    │
│  clustering, dark style)         post flow        (Apple Maps model)   (queued posts)    │
└────┬──────────────────────┬─────────────────────┬─────────────────────┬──────────────────┘
     │ vector tiles          │ signed image upload │ REST / RPC (RLS)    │ WebSocket
     ▼                       ▼                     ▼                     ▼
  Mapbox APIs          Supabase Storage       Supabase Postgres      Supabase Realtime
  (tiles, search/      (post photos,          + PostGIS              (live new-post
   store snapping)      CDN, thumbnails)      (RLS, triggers)         markers)
                                                   │
                                          Edge Functions + pg_cron
                                          (image moderation, store snap,
                                           expiry sweep, push fan-out later)
```

### Frontend — React Native with Expo

- **Why cross-platform:** the launch market (Germany — Müller/Edeka territory) is majority Android, but the design target is Apple-quality. React Native lets one codebase serve both while still feeling native; the libraries that define this app's feel (`@rnmapbox/maps`, Gorhom bottom sheet, Reanimated, `expo-camera`, `expo-location`) are all mature.
- **Why Expo specifically:** EAS handles builds/signing/store submission, OTA updates ship UX fixes without review cycles, and config plugins make the Mapbox native SDK setup painless.
- **State/data:** TanStack Query over the Supabase client (server cache, retries, optimistic votes) + a thin Zustand store for UI state. No Redux.
- **The alternative worth naming:** if you deliberately go iOS-only for v1, native SwiftUI + MapKit is the better stack (see §2). Choose cross-platform vs. iOS-first before any code — it's the one decision that's expensive to reverse.

### Backend — Supabase (Postgres + PostGIS)

Supabase fits this app unusually well, for one central reason: **the hard problems here are relational + geospatial, and Postgres solves all of them natively.**

- **PostGIS** answers "all active posts in this map viewport" with a proper spatial index — the query Firebase-style document stores handle badly (geohash workarounds, no server-side filtering).
- **Row-Level Security** enforces the rules that must never live client-side: only authenticated users insert posts, only one vote per user per post, no self-votes, users can only edit their own content.
- **Database triggers** enforce the 10-minute rate limit atomically at insert time and maintain karma counters — the client can display the cooldown, but the database is the referee.
- **Auth** ships with Sign in with Apple, Google, and email built in.
- **Storage + CDN** holds post photos with on-the-fly thumbnail transforms (marker icons ~128 px, detail view ~1600 px).
- **Realtime** pushes new-post inserts to connected clients so markers appear on everyone's map within seconds — the "radar" feeling.
- **Edge Functions + pg_cron** cover the async work: image moderation on upload, store snapping, the hourly cleanup sweep, and (later) push notification fan-out.
- **Hosting region: Frankfurt (EU)** — a GDPR requirement in practice for a German-market location app, and lower latency.

### The expiry mechanic — visibility, not deletion

Treat the 1-hour expiry as a **query-time filter, not a delete**:

- Every post stores `expires_at = capture_time + 1 h`. Map queries return only `expires_at > now()` — markers disappear for everyone at exactly the right second, with no cleanup job on the critical path.
- Each marker carries its `expires_at` to the client, which runs a local countdown — used both to remove the marker precisely and to render the "time remaining" ring (§5).
- Expired posts **stay in the database**: they still carry votes, karma history, and moderation evidence, and they populate the user's profile history. A pg_cron job archives them and deletes the photo files after a retention window (e.g. 14 days) to cap storage cost and satisfy data-minimization.

This split — *visibility expires in 1 hour, the record does not* — is load-bearing for the karma system: the people best positioned to judge a post's accuracy are the ones who drove to the store because of it, and they arrive during or after the visibility hour. So the **voting window outlives the marker** (recommended: votable for 6 h from capture, via the Recent feed and post links), while the map stays strictly fresh.

### Real-world resilience — the offline outbox

Store interiors (basements, concrete Aldi boxes) have terrible reception, and that's exactly where posts are created. The post flow must **capture first, upload whenever**: photo, title, GPS fix, and capture timestamp are saved locally the moment the user hits Post, then a background queue retries the upload. Rules to keep this honest:

- `expires_at` derives from **capture time**, not upload time — a post that uploads 20 minutes late gets 40 minutes of visibility, not a fresh hour.
- Captures older than ~30 minutes at upload time are rejected with a friendly "this sighting is too old to post" (staleness would poison map trust).

### Cost reality (verify current pricing before committing)

MVP infrastructure is nearly free: Supabase free tier → Pro at ~$25/mo, Mapbox mobile free tier covers roughly the first ~25k monthly active users, Expo EAS has a workable free tier, image moderation is fractions of a cent per photo. Expect **$0–40/month until real traction**, with Mapbox MAU fees the first line that grows.

---

## 2. Map SDK — recommendation and trade-offs

The map requirements that actually discriminate between SDKs: **custom photo-thumbnail markers at scale** (dozens–hundreds on screen, GPU-rendered, clustered), **full visual styling** (an Apple-clean light style and a true dark style), cross-platform support, and predictable cost.

| | **Mapbox** (recommended) | Google Maps SDK | Apple MapKit | MapLibre + open tiles |
|---|---|---|---|---|
| Photo markers at scale | Excellent — symbol layers render marker images on the GPU; built-in clustering | Weak in React Native — `react-native-maps` custom markers are real views; janky on Android with many photo markers | Good (native annotation views, built-in clustering) | Same engine lineage as Mapbox — good |
| Visual styling | Best in class — Studio editor, fully custom light/dark styles to hit the Apple-clean look | Limited cloud styling; always looks like Google Maps | Beautiful by default, Apple language for free — but zero restyling | Full style-spec control, DIY tooling |
| Platforms | iOS + Android, actively maintained RN SDK (`@rnmapbox/maps`) | iOS + Android; RN wrapper is community-maintained | **iOS only** — disqualifying for cross-platform | iOS + Android, community RN fork |
| Store/POI data | Decent; Search Box API for snapping | **Best-in-class Places data** | Good in supported regions | OSM quality varies by region |
| Cost (approx., 2026) | Free ≈ first 25k MAU, then per-MAU | Native mobile map *display* is free; Places/geocoding calls are what cost | Free with Apple Developer Program | SDK free; tiles ~free (MapTiler tier / self-host Protomaps) |
| Key risk | Per-MAU bill at scale | Can't achieve the design language; RN marker performance | Locks out Android | Most integration work, least polish out of the box |

**Recommendation: Mapbox as the display map** — it's the only option that simultaneously satisfies "Apple-inspired custom look," "photo markers that stay smooth," and "both platforms." Two qualifiers:

1. **Hybrid data strategy:** use **Google Places (or Mapbox Search Box) only for store snapping** at post time — resolving GPS to "Müller, Hauptstraße 12" (§3). Display on Mapbox, enrich with the best POI source. Snapping calls are low-volume (one per post), so cost is trivial.
2. **Escape hatches:** if v1 becomes iOS-only, switch to MapKit (free, gorgeous, native). If Mapbox MAU fees bite at scale, MapLibre shares the style spec and is a realistic migration, not a rewrite.

---

## 3. Data model

Five core entities. (Field sketches, not final DDL.)

### `profiles` — public identity, 1:1 with auth accounts
| field | notes |
|---|---|
| `id` | UUID, = auth user id |
| `username` | unique, 3–20 chars; **pseudonymous by design** (GDPR-friendly) |
| `avatar` | choice from a set of geometric/color presets (no licensed imagery) |
| `karma` | int, denormalized cache of the karma ledger (trigger-maintained) |
| `created_at`, `email_verified_at` | drive new-account probation (§6) |
| `last_post_at` | rate-limit anchor; the insert trigger checks it atomically |
| `status` | `active` / `shadow_limited` / `suspended` / `banned` |

### `posts` — one restock sighting
| field | notes |
|---|---|
| `id`, `author_id` | |
| `title` | required, ≤ 80 chars |
| `description` | optional, ≤ 500 chars |
| `photo_path` | Storage reference; thumbnails derived via CDN transforms |
| `location` | `geography(Point)` — **device GPS only, never a hand-placed pin**; GIST-indexed |
| `location_accuracy_m` | from the GPS fix; plausibility signal |
| `store_name`, `store_place_id` | snapped POI ("Müller Hauptstraße 12"); groups posts per store |
| `captured_at` | client capture time (validated ≤ 30 min old at upload) |
| `expires_at` | `captured_at + 1 h`; **all map queries filter on this** |
| `up_count`, `down_count`, `sold_out_count` | denormalized, trigger-maintained |
| `status` | `active` / `hidden_pending_review` / `removed` / `archived` |

### `votes` — accuracy judgments (the karma input)
| field | notes |
|---|---|
| `post_id` + `voter_id` | **composite primary key → one vote per user per post**, changeable/retractable |
| `value` | `+1` / `−1` |
| `reason` | required on downvotes: `not_restocked` / `wrong_location` / `misleading_photo` / `spam` |
| `counts_for_karma` | frozen at vote time — false for probationary accounts (§6) |
| `created_at`, `updated_at` | velocity/anomaly signals |

Constraints enforced in the database: no voting on your own post; voting window = 6 h from `captured_at`; vote counts are public, voter identities are not.

### `karma_events` — an append-only ledger, not a mutable number
| field | notes |
|---|---|
| `user_id`, `delta`, `reason` | `post_upvoted` / `post_downvoted` / `vote_changed` / `post_removed_fake` / `adjustment` |
| `post_id`, `created_at` | provenance |

Karma = `Σ deltas`; the profile column is just a cached sum. A ledger makes every point auditable, makes vote retractions cleanly reversible, and lets you re-tune the formula historically. **Never store karma as only a mutable integer.**

### `reports` — moderation input
`post_id`, `reporter_id` (unique pair), `reason` (`fake` / `inappropriate` / `contains_people` / `spam` / `other`), `created_at`. Threshold logic in §6.

### `stores` (v1.5) — canonical store registry
Grown organically from snapped `store_place_id`s: `place_id`, `name`, `chain`, `location`. Unlocks the two best retention features later: **"follow this store"** push notifications and per-chain filtering — worth capturing `store_place_id` from day one even though the table itself can wait.

### Mechanics worth pinning now
- **Rate limit**: `BEFORE INSERT` trigger on `posts` rejects if the author posted < 10 min ago (row-lock on `profiles.last_post_at` to kill the double-tap race). Client mirrors it as a countdown on the + button; the database is the referee.
- **Viewport query**: one RPC — `posts_in_bbox(bounds)` → active, non-hidden posts intersecting the viewport. Realtime inserts layer on top; at scale, shard realtime channels by geohash cell so clients only subscribe to their region.
- **Post deletion**: the author may delete an active post, but **karma effects already accrued persist** — otherwise deleting becomes an escape hatch from downvotes.

---

## 4. Karma & reputation design

### The key refinement: separate "accurate?" from "still there?"

A restock post can be *completely honest and already stale* — someone bought out the shelf 40 minutes in. If "sold out" arrives as a **dislike**, honest posters get punished and karma stops meaning "trustworthy." So split the feedback axes:

- **👍 Confirm** ("it's there / was real") → upvote, `+1` author karma
- **👎 Dispute** ("not accurate", with required reason) → downvote, `−1` author karma
- **"Sold out now"** — a *separate, no-fault status flag*: at ≥ 3 sold-out flags the marker dims to a "likely gone" state (and can expire early after a grace period). **Zero karma impact.**

This keeps your like/dislike spec intact for accuracy, while making the map more useful — the radar shows not just *where restocks were reported* but *whether they're still worth driving to*.

### Scoring rules (v1 numbers, tune with data)

| event | author karma |
|---|---|
| Upvote from an established account | **+1** |
| Downvote from an established account | **−1** |
| Vote from a probationary account (< 72 h old / unverified) | 0 (shown in counts, excluded from karma) |
| Vote changed or retracted | prior delta reversed via ledger |
| Post confirmed fake by moderation | **−20**, post removed |
| Per-post cap | net karma contribution clamped to **± 25** |

Rationale: symmetric ±1 keeps the currency legible ("karma ≈ net people you've helped"). The per-post cap blunts both viral outliers and brigades — no single post can make or break a reputation. Probationary-vote exclusion (frozen into `counts_for_karma` at vote time) kills the cheapest attack: registering sock-puppet accounts to farm your own posts. Weighting votes by *voter* reputation is a v2 lever; don't add that complexity before there's data.

### Tiers & perks — visibility, never reach

| karma | tier (working names*) | perks |
|---|---|---|
| 0 + | Rookie | baseline |
| 25 + | Scout | colored badge on posts and profile |
| 100 + | **Trusted Reporter** | gold ring on their map markers; posts skip any review queue |
| 300 + | Veteran | votes count ±2; profile flair |
| 1000 + | Legend | early features; moderator candidacy |
| ≤ −10 | — | posts held for review before appearing |
| ≤ −25 | — | posting suspended 7 days; repeat → ban |

\* Pokéball-tier naming (Poké/Great/Ultra/Master) is thematically perfect but uses Nintendo trademarks — keep neutral names unless legal review clears it (§7).

Two principles behind the perk design: **perks confer visibility and trust, never reach** — a Trusted Reporter's marker looks more credible (gold ring), but it isn't bigger, doesn't rank higher, and doesn't last longer than an hour, so there's no mechanical payoff to farming karma. And **thresholds gate annoyances, not the product** — low karma adds friction (review queues), it never silences a good-faith user.

### Display

- **On markers/post cards**: username + tier badge + karma count — trust legible at the moment it matters ("do I drive 15 minutes for this?").
- **On profile**: big karma number with a progress ring to the next tier, badge case, post history with per-post scores, and an **accuracy stat** ("91% of rated posts confirmed") — arguably more informative than raw karma.
- Karma is public. The ledger detail is private to the user ("+4 today from your Müller post").

---

## 5. UX concept — Apple-inspired

### Design language

- **One paradigm: everything is a sheet over the map.** No screen-to-screen navigation for core flows — the map is the ground truth and bottom sheets layer over it (exactly the Apple Maps / Find My model). Detail views, the recent feed, and search are sheet snap points (peek / half / full).
- **Tokens**: near-white surfaces with translucent blur materials for floating chrome; SF Pro (Inter on Android); continuous ("squircle") corner radii; one accent — **Pokéball red `#E2350D`-family** — used only for markers, primary actions, and the brand; everything else stays neutral so red means "sighting."
- **Motion & feel**: spring physics for sheets and marker drop-in; haptics on post, vote, and tier-up; full dark mode with a true dark map style (Mapbox custom style, not a dimmed layer).
- **Empty/system states designed, not defaulted**: an empty map region gets "No sightings nearby — be the first radar in your area," not a blank map.

### Screen 1 — Map (home)

Full-bleed map. Floating over it: a translucent search/filter pill (top), locate-me button (right edge), profile avatar chip (top corner), and a persistent bottom sheet whose peek state shows "Nearby sightings · last hour" with a horizontal card strip of the freshest posts. A large centered red **+** button sits above the sheet.

**The marker is the product.** Design it to carry all critical state at a glance:

- Circular photo thumbnail inside a white ring with a soft shadow — the product photo *is* the pin.
- A thin **red countdown ring** around it depletes over the hour — freshness is visible without reading anything, and it makes the 1-hour rule self-explanatory.
- Small tier chip (gold ring) on Trusted Reporters' markers.
- "Likely gone" state: desaturated + label, after sold-out flags.
- Clusters: stacked-photos circle with a count; tapping zooms/fans out.
- New markers **drop in live** with a spring bounce (via Realtime) — the moment the app feels like a radar.

Tapping a marker snaps the sheet to half height with the post card — the map never disappears.

### Screen 2 — Post creation (the ≤ 30-second flow)

Camera-first, two steps, launched from **+**:

1. **Capture.** Full-screen in-app camera (flash toggle, tap-to-focus). **No gallery import** — camera-capture-only is an anti-abuse cornerstone (§6), and it guarantees every photo on the map was taken here, now. Retake or continue.
2. **Details.** Photo as background context; over it: title field (autofocused), optional description, and a location card showing a mini-map pin with snapped store suggestions as tappable chips — "📍 Müller, Hauptstraße 12 · 40 m" (picking one attaches the store; GPS remains the location source). One big **Post** button.

Posting is optimistic: the sheet dismisses immediately, the user's marker drops onto the map with the spring animation (their moment of pride), and upload/retry runs in the background (offline outbox, §1). If the user is inside the 10-minute cooldown, the **+** shows a countdown ring and the sheet explains it honestly — no dead buttons.

### Screen 3 — Post detail (sheet, half → full)

Half state: photo (16:9), title, store name + distance, "posted 12 min ago · **48 min left**" with a linear time bar, poster chip (avatar, username, tier badge, karma), and the action row — **👍 Confirm · 👎 Dispute · Sold out now** — plus a prominent **Directions** button (deep-links to Apple/Google Maps). Full state adds the description, larger photo, and quiet overflow actions (report, block user, share). Votes respond instantly (optimistic) with haptic ticks; downvote opens a 4-chip reason picker. Own posts show a stats strip instead of vote buttons, plus delete.

### Screen 4 — Profile & karma

Header: avatar, username, member-since. Centerpiece: **karma count inside a circular progress ring toward the next tier** ("Scout · 62 / 100 to Trusted Reporter"), badge row, then stats (posts, confirms received, accuracy %) and a post-history grid — each cell a photo thumbnail with its net score and store. Own profile adds the private karma ledger ("+4 today") and settings (account, notifications, blocked users, privacy, delete account). Other users' profiles show the public subset + block/report.

### Screen 5 — Auth & onboarding

- **Sign in with Apple + Google + email** (Apple mandates offering Sign in with Apple once any third-party login exists). One-screen value pitch → sign-in → pick a username → done.
- **Permission priming**: explain-then-ask. Location: "PokeRadar shows sightings near you and tags your posts to the store — we never track you in the background" → then the system prompt ("While Using"). Camera permission is requested only on first post attempt — in context, when motivation is highest. Notifications: not at onboarding; ask after the first meaningful moment (v1.5).

---

## 6. Trust & abuse prevention

The 10-minute rate limit is one brick. The full wall, layered — **prevent → detect → respond** — with everything enforced server-side (RLS + triggers + edge functions); the client only ever *mirrors* rules for UX.

### Prevent (make fakes expensive to create)

1. **Camera-capture-only, no gallery import.** The single highest-value rule: fakes now require physically photographing something *right now* — no downloading a stock photo of a Pokémon shelf. (Also auto-strips the "old photo, new post" failure mode.)
2. **GPS-only location, never a hand-placed pin**, with `location_accuracy_m` recorded and a required-accuracy gate. Mock-location flags (Android `isMock`) rejected outright.
3. **Capture-time freshness**: uploads with `captured_at` > 30 min old are rejected (§1).
4. **App attestation** — App Attest (iOS) / Play Integrity (Android) verified on post/vote endpoints, so scripted API abuse outside the real app fails. Cheap to add early, painful to retrofit.
5. **New-account probation (< 72 h / unverified email)**: votes don't count toward karma (§4), posts carry a subtle "new reporter" note, and per-day post caps are tighter. Kills throwaway-account economics.
6. **EXIF stripped** from published photos (privacy), after server-side capture validation.

### Detect (assume some get through)

7. **Teleport check**: posting from Hamburg 20 minutes after Munich → auto-hold for review. Trivial with PostGIS (distance/time between consecutive posts).
8. **Perceptual image hashing (pHash)** on upload: re-posted or near-duplicate photos across posts/accounts get flagged — catches the recycled-photo farm.
9. **Automated image moderation** on upload (e.g. Vision SafeSearch / Rekognition in an edge function): NSFW/violence blocked before the photo ever renders on anyone's map. Required in practice for App Store UGC approval.
10. **Vote anomaly signals**: vote velocity per post, same-device vote clusters, reciprocal voting rings — logged from day one (the `votes` timestamps + device install IDs make this queryable), acted on manually at first.

### Respond (graduated, mostly invisible)

11. **Report thresholds**: ≥ 3 unique reports (karma-weighted) auto-hides a post pending review. Confirmed fake → post removed, −20 karma; repeat → suspension → ban. False reporting also has a cost (reports from users whose reports are routinely rejected lose weight).
12. **Shadow limiting** for repeat offenders: their posts render for themselves but not for others — breaks the feedback loop trolls feed on.
13. **Device-level bans** (hashed device/install ID via attestation), so a ban isn't undone by a fresh email.
14. **Block user** (per-user mute) — also an explicit Apple UGC requirement, alongside in-app reporting and a moderation contact (App Review guideline 1.2). Plan the tiny admin/moderation queue (a simple internal web view over `reports`) as part of v1, with you as founding moderator.

### Karma-manipulation notes specifically

Self-votes blocked at the constraint level; probation excludes sock-puppet votes; the ±25 per-post cap bounds brigades in both directions; perks grant no reach (§4) so the incentive to farm is weak; and the ledger means any detected manipulation can be surgically reversed later. **V2 when data justifies it**: proximity-verified votes — a confirm from a device that was physically near the store during the post's window gets a "verified visit" mark and extra weight. That's the endgame for vote quality, but it needs users first.

---

## 7. Legal & compliance notes (short, but real)

- **GDPR (launch market is Germany)**: precise location + photos = personal data. Concretely: EU-hosted backend (Supabase Frankfurt), pseudonymous public identity (usernames, no real names), location permission "While Using" only, EXIF stripped, photo retention capped (files deleted ~14 days after expiry), self-serve account deletion with full cascade (also an App Store requirement), and a real privacy policy. In-app guidance in the camera: "avoid people in your photo" + a `contains_people` report reason.
- **IP risk — flagging, not resolving**: "PokeRadar" collides with the in-game Poké Radar item and The Pokémon Company is famously litigious. The app uses no Nintendo assets (user photos of retail products are fine), but treat the name as a working title and get an hour of trademark advice before store submission. Same reason to keep tier names and avatars original (§4).
- **App Store UGC rules**: report + block + moderation contact are mandatory for approval — they're in the v1 scope above, not a nice-to-have.
- **Audience**: Pokémon skews young; expect a 12+/13+ age gate and write the moderation policy accordingly.

---

## 8. MVP scope & roadmap

**V1 — the working radar** (everything above except where marked):
map + live photo markers with countdown rings · camera-first post flow with store snapping · offline outbox · auth + usernames · 10-min rate limit (server-enforced) · confirm/dispute votes + sold-out flag · karma ledger + tiers + profile · reports, block, image moderation, admin queue · GDPR baseline.

**V1.5 — retention**: `stores` registry + **"follow this store" push notifications** (the killer retention feature — architecture already accommodates it) · per-chain filters (show only Müller) · weekly "top reporters near you."

**V2 — trust & scale**: proximity-verified votes · voter-reputation weighting · geohash-sharded realtime · city leaderboards · DE/EN i18n.

**The non-technical risk to plan for — the empty map.** A radar with no blips retains nobody. Launch city-by-city, not nationwide: pick one metro, seed it through the (very active) German Pokémon TCG communities (Discord/Reddit/Telegram restock groups already do this manually in chat — PokeRadar is that behavior with a map), and expand only when the first city shows a heartbeat. The 1-hour expiry raises the bar here: the map needs *recent* posts to feel alive, which makes geographic density matter far more than total user count.

---

## 9. Decisions to lock before building

| decision | recommendation |
|---|---|
| Platform scope | Cross-platform via Expo/RN (Android-heavy market). iOS-first SwiftUI only if you accept halving the launch audience. |
| Map SDK | Mapbox display + Places snapping; MapKit if iOS-only; MapLibre as the cost escape hatch. |
| Backend | Supabase (Frankfurt). |
| Camera-only posting | **Yes** — cornerstone anti-abuse rule; costs some convenience, buys map trust. |
| Sold-out as separate signal | **Yes** — dislikes measure honesty, sold-out measures freshness. |
| Voting window | Votable 6 h from capture (outlives the 1-h marker). |
| Karma formula | ±1 symmetric, ±25/post cap, −20 fake penalty, probation exclusion; ledger-based. |
| App name | Treat "PokeRadar" as a working title pending trademark advice. |

---

## 10. Extension: the flyer radar (weekly Prospekte)

*Added after the v1 plan. Status: planned, not built.*

The map answers "what is on a shelf **right now**"; weekly flyers answer "what will be on a shelf **this week**." German retail runs on Prospekte — REWE, EDEKA, Müller, Rossmann, Kaufland all publish weekly — and a Pokémon listing in a flyer is the single best predictor of a restock event. A second tab that shows **only the current flyers in which Pokémon products actually appear, sorted by distance**, turns PokeRadar from a live feed into a planning tool, and it feeds the map: a flyer listing on Monday is why reporters go hunting on Thursday.

### 10.1 The hard problem first: getting the flyers

There is **no official, public, free API** from REWE, EDEKA, or any major German chain for flyer content. Everything else in this section is downstream of that fact. The realistic routes:

| route | how it works | pros | cons |
|---|---|---|---|
| **Aggregator API partnership** (Bonial/kaufDA · Offerista · Marktguru) | Aggregators license flyer content from retailers and expose commercial APIs with flyer metadata, page images, validity windows, regional editions, and — critically — **offer-level search** | Legally clean; regionalisation solved; keyword search over offers ("Pokémon") is exactly our filter; one integration covers many chains | Commercial contract needed; cost unknown until asked; dependency on one partner |
| **Retailer-site crawling** | A daily job reads each chain's public flyer index (viewer URLs, validity dates, regional selection by zip), optionally OCRs the PDF pages | No partner needed; full control | Fragile (breaks on redesigns); ToS/copyright-sensitive — flyer content is licensed material; regional editions (EDEKA alone has seven regional cooperatives) multiply the work |
| **Deep-link / embed official viewers** | We store only metadata and open the retailer's own flyer viewer (their page, their servers) | Legally the safest display layer — we never re-host content | Display only; solves neither discovery nor the Pokémon filter by itself |

**Recommendation: hybrid.** Use an aggregator's licensed API as the data source (start the Bonial/Offerista/Marktguru conversations early — this is the feature's long lead item), display via deep links into official viewers wherever possible, and store only metadata plus low-res cover thumbnails ourselves. If no aggregator deal materialises at acceptable cost, the fallback is metadata-only crawling + deep links + community detection (10.2, layer B alone) — legally reviewed first. **Do not build on unofficial app APIs** (reverse-engineered REWE/Marktguru endpoints); they work until they don't, and production cannot sit on that.

### 10.2 "Only flyers where Pokémon was actually found" — three detection layers

A flyer is **hidden by default** and becomes visible in the tab only when a detection layer marks it:

- **A — Offer-keyword match (automatic, primary).** Aggregator APIs index individual offers per flyer. The daily job searches each new flyer's offers for `pokémon / pokemon / sammelkarten / trading cards / karmesin` etc. A hit records flyer, page number, and matched term → the flyer is shown with a "Pokémon · p. 12" badge that opens the viewer on that page.
- **B — Community finds (the PokeRadar way).** A "Report a flyer find" action lists this week's not-yet-matched flyers; a user flags "Pokémon on page 8." At **2 independent flags** the flyer goes visible with a "community-found" badge, and confirmed finders earn **+2 karma** through the existing ledger (`reason: flyer_find_confirmed`, capped like everything else). This also catches what keyword search misses — image-only listings, bundle deals, misspellings.
- **C — OCR sweep (v2 fallback).** For chains outside the aggregator's coverage: daily OCR over flyer pages, same keyword list. Only worth building if coverage gaps prove real.

Visibility rule, precisely: `visible = ∃ match(layer A or C) OR confirmed_community_finds ≥ 2`, always `AND valid_until ≥ today`.

### 10.3 Data model additions

**`flyers`** — one regional edition per row: `id`, `chain`, `region_code`, `title`, `valid_from`, `valid_until`, `viewer_url` (official), `thumbnail_url` (low-res, ours), `page_count`, `source` (`aggregator / crawler / manual`), `fetched_at`.
**`flyer_matches`** — detection results: `flyer_id`, `page`, `term`, `method` (`offer_api / ocr / manual`), `created_at`.
**`flyer_finds`** — community layer: `flyer_id`, `reporter_id`, `page`, `note`, `status` (`pending / confirmed / rejected`), unique `(flyer_id, reporter_id)`; feeds `karma_events` on confirmation.

### 10.4 Refresh pipeline — "once a day" made concrete

One scheduled job, **05:30 Europe/Berlin daily** (pg_cron → edge function):

1. For each tracked chain × region: fetch the current flyer list; upsert `flyers` (new editions appear on different weekdays per chain — Sunday/Monday flips dominate, but daily polling is what guarantees "always current").
2. Run layer-A detection on anything new or changed; write `flyer_matches`.
3. Expire: anything with `valid_until < today` disappears from queries (same query-time-filter pattern as post expiry — never a hard delete during the karma-relevant window).
4. On-demand nudge: the first community find on a hidden flyer triggers a one-off re-check of that flyer, so layer A gets a second chance before the community threshold decides.

Clients just read; no client-side fetching of retailer content, ever (CORS, keys, and copyright all live server-side).

### 10.5 Location sorting & regional editions

Sort key: **distance from the user to the nearest branch of the flyer's chain** (the `stores` registry from §3 — now promoted from v1.5 to a hard dependency of this feature), tiebreak by `valid_until` (soonest-expiring first, mirroring the map's freshness bias). Regional editions are resolved by the user's coordinates → zip → edition, which aggregator APIs handle natively; this is another reason the aggregator route wins. A flyer with no branch inside ~25 km doesn't appear at all.

### 10.6 UX — the app grows a tab bar

This is the first feature that breaks the "everything is a sheet over the map" model, so navigation changes deliberately: a minimal bottom **tab bar: Radar · Flyers** (profile stays in the top chrome). The Flyers tab:

- Large-title list, "This week", cards: cover thumbnail, chain + edition, "valid until Sat", distance to nearest branch, and the find badge — red "Pokémon · p. 12" (auto) or outlined "community find · p. 8".
- Tap → official viewer deep-linked to the matched page (in-app browser sheet); actions on the card: **Confirm find / Dispute** (same 👍/👎 grammar as posts, feeding find status), **Directions** to the nearest branch, share.
- Empty state does the marketing: "No Pokémon in this week's flyers yet — first confirmed find earns +2 karma."
- A quiet secondary list ("All current flyers") hosts the layer-B reporting flow without polluting the main tab.

### 10.7 Prototype path on GitHub Pages

The static prototype cannot call retailer or aggregator APIs from the browser — CORS, credentials, and licensing all forbid it. But the **daily job maps perfectly onto a scheduled GitHub Action**: a cron workflow runs at 05:30, executes the fetch/detect pipeline, writes `data/flyers.json` + thumbnails into the repo, commits, and Pages serves the result as static files the app reads. That is a legitimate architecture up to real scale, not just a demo trick — though until a data agreement exists, the prototype ships **clearly-labelled simulated flyers** through the same `flyers.json` contract, so the UI is real while the pipeline awaits a licensed source.

### 10.8 Decisions to lock for this feature

| decision | recommendation |
|---|---|
| Data source | Aggregator API (approach Bonial/Offerista/Marktguru now); deep-link display; no unofficial APIs in production. |
| Visibility rule | Hidden until layer-A match or ≥2 community finds; always validity-bounded. |
| Community reward | +2 karma per confirmed flyer find, through the existing ledger and caps. |
| Refresh | Daily 05:30 Europe/Berlin server-side job; clients never fetch retailer content. |
| Sorting | Nearest-branch distance, tiebreak by soonest expiry; 25 km visibility radius. |
| Navigation | Introduce the two-item tab bar (Radar · Flyers) rather than burying flyers in a sheet. |
| Legal | Flyer content is licensed material — legal review before any crawling/re-hosting ships. |
