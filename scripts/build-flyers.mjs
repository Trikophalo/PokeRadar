#!/usr/bin/env node
/**
 * The daily flyer job (PLANNING.md §10.4).
 *
 * Runs once a day, fetches the current weekly flyers, runs the Pokémon
 * keyword pass over each one's offers, and writes `data/flyers.json` — the
 * contract the app reads. On GitHub Pages this job is a scheduled Action that
 * commits the result; in production it is a pg_cron-triggered edge function
 * writing to Postgres. The shape of the output is the same either way.
 *
 * SOURCE OF DATA: no German retailer publishes a free, official flyer API, so
 * production sources this from a licensed aggregator (Bonial / Offerista /
 * Marktguru) whose API exposes offer-level search — see §10.1. Until such an
 * agreement exists this script SIMULATES the feed. Everything it emits is
 * marked `"source": "simulated"` and the app labels it in the UI; nothing here
 * scrapes a retailer or pretends to be real data.
 *
 * Usage: node scripts/build-flyers.mjs [--out data/flyers.json]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/* ------------------------------------------------------------- the week --- */

/**
 * German flyers overwhelmingly run Monday to Saturday.
 *
 * On a Sunday the Mon–Sat window has already closed, so this rolls forward to
 * the week that is about to start — which is also what retailers do, publishing
 * next week's Prospekt over the weekend. Without this the tab is empty every
 * Sunday because every flyer has technically expired.
 */
function currentWeek(now = new Date()) {
  const day = now.getUTCDay();               // 0 Sun … 6 Sat
  const sinceMonday = day === 0 ? -1 : day - 1;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - sinceMonday));
  const saturday = new Date(monday.getTime() + 5 * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { valid_from: iso(monday), valid_until: iso(saturday), key: iso(monday) };
}

/* ---------------------------------------------------------------- seed --- */

/** Deterministic per week, so a re-run on the same day is a no-op commit. */
function rng(seedText) {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) {
    h ^= seedText.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* -------------------------------------------------------------- chains --- */

// `pokemonLikelihood` models how often each chain actually runs Pokémon deals:
// a drugstore like Müller nearly every week, a supermarket like REWE rarely.
const CHAINS = [
  { chain: 'Müller',      title: 'Müller Wochenangebote',        pages: 24, pokemonLikelihood: 0.85 },
  { chain: 'Rossmann',    title: 'Rossmann Prospekt',            pages: 20, pokemonLikelihood: 0.55 },
  { chain: 'dm',          title: 'dm Aktuelle Angebote',         pages: 16, pokemonLikelihood: 0.3 },
  { chain: 'EDEKA',       title: 'EDEKA Angebote der Woche',     pages: 28, pokemonLikelihood: 0.35 },
  { chain: 'REWE',        title: 'REWE Handzettel',              pages: 26, pokemonLikelihood: 0.35 },
  { chain: 'Kaufland',    title: 'Kaufland Wochenprospekt',      pages: 32, pokemonLikelihood: 0.5 },
  { chain: 'MediaMarkt',  title: 'MediaMarkt Angebote',          pages: 18, pokemonLikelihood: 0.4 },
  { chain: 'Thalia',      title: 'Thalia Aktionen',              pages: 12, pokemonLikelihood: 0.6 },
  { chain: 'Smyths Toys', title: 'Smyths Toys Superkatalog',     pages: 36, pokemonLikelihood: 0.9 },
  { chain: 'GameStop',    title: 'GameStop Deals',               pages: 10, pokemonLikelihood: 0.7 },
  { chain: 'Galeria',     title: 'Galeria Wochen-Highlights',    pages: 22, pokemonLikelihood: 0.25 },
  // Deliberately outside the app's known-store list: exercises the rule that a
  // flyer with no branch inside 25 km is not shown at all (§10.5).
  { chain: 'Netto',       title: 'Netto Wochenangebote',         pages: 20, pokemonLikelihood: 0.2 },
];

/** The keyword pass — §10.2 layer A, run against each flyer's offer list. */
const KEYWORDS = [
  'Pokémon', 'Pokemon', 'Sammelkarten', 'Trading Cards', 'TCG',
  'Booster', 'Elite Trainer Box', 'Karmesin & Purpur',
];

const OFFER_TITLES = [
  'Pokémon Booster Display',
  'Pokémon Elite Trainer Box',
  'Pokémon Sammelkarten 3er-Blister',
  'Pokémon Tin-Box sortiert',
  'Pokémon Sammelalbum mit Promokarte',
  'Trading Cards Mini-Tin',
];

function buildFlyer(spec, week, rand, index) {
  const hasPokemon = rand() < spec.pokemonLikelihood;
  const matches = [];

  if (hasPokemon) {
    // Offers cluster in the back half of a flyer, where the non-food pages are.
    const count = 1 + (rand() < 0.3 ? 1 : 0);
    const used = new Set();
    for (let i = 0; i < count; i++) {
      let page = Math.max(2, Math.round(spec.pages * (0.45 + rand() * 0.5)));
      while (used.has(page)) page = Math.max(2, ((page + 1) % spec.pages) + 1);
      used.add(page);
      matches.push({
        page,
        term: KEYWORDS[Math.floor(rand() * KEYWORDS.length)],
        offer_title: OFFER_TITLES[Math.floor(rand() * OFFER_TITLES.length)],
        price: `${(3 + Math.floor(rand() * 45))},${['49', '95', '99'][Math.floor(rand() * 3)]} €`,
        method: 'offer_api',
      });
    }
    matches.sort((a, b) => a.page - b.page);
  }

  return {
    id: `flyer_${week.key}_${spec.chain.toLowerCase().replace(/[^a-z]/g, '')}`,
    chain: spec.chain,
    title: spec.title,
    region_code: 'DE',
    valid_from: week.valid_from,
    valid_until: week.valid_until,
    page_count: spec.pages,
    // Real flyers deep-link to the retailer's own viewer (§10.1). Simulated
    // ones have none, so the app falls back to its built-in page viewer.
    viewer_url: null,
    cover_seed: `${week.key}:${spec.chain}:${index}`,
    source: 'simulated',
    matches,
  };
}

/* ----------------------------------------------------------------- main --- */

const outArg = process.argv.indexOf('--out');
const outPath = resolve(outArg > -1 ? process.argv[outArg + 1] : 'data/flyers.json');

const week = currentWeek();
const rand = rng(`flyers:${week.key}`);
const flyers = CHAINS.map((spec, i) => buildFlyer(spec, week, rand, i));

const payload = {
  // Deliberately not a timestamp: the file must be byte-identical on a re-run
  // within the same week, so the daily job produces an empty diff and does not
  // churn a commit (and a Pages deploy) every single morning.
  generated_for_week: week.key,
  source: 'simulated',
  notice: 'Simulated flyer data. No retailer content is fetched, scraped or '
        + 'redistributed. Production sources this from a licensed aggregator '
        + 'API — see PLANNING.md §10.1.',
  week,
  keywords: KEYWORDS,
  flyers,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);

const withPokemon = flyers.filter((f) => f.matches.length).length;
console.log(`Wrote ${outPath}`);
console.log(`  week ${week.valid_from} → ${week.valid_until}`);
console.log(`  ${flyers.length} flyers, ${withPokemon} with a Pokémon match`);
