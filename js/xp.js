/**
 * The Scout system — the motivation layer (PLANNING.md §12).
 *
 * Design: two currencies with different jobs. Karma is TRUST — other people
 * judge your accuracy, it can fall, and it gates nothing fun. XP is ACTIVITY —
 * it pays out the instant you act, never decreases, and drives levels, streaks
 * and badges. Keeping them separate means the reward loop can be generous
 * without making trust farmable.
 *
 * Everything here is a pure derivation over existing state (posts, votes,
 * flyer finds). Nothing is stored, so it cannot drift, needs no migrations,
 * and stays consistent with state that arrived over live sync.
 */

import { SCOUT } from './config.js';
import * as db from './db.js';

export const BADGES = [
  { id: 'first_find',    name: 'First Find',     desc: 'Post your first sighting' },
  { id: 'early_bird',    name: 'Early Bird',     desc: 'Post a sighting before 9:00' },
  { id: 'chain_hopper',  name: 'Chain Hopper',   desc: 'Sightings at 3 different chains' },
  { id: 'crowd_pick',    name: 'Crowd Pick',     desc: 'One sighting confirmed 5 times' },
  { id: 'confirmed_10',  name: 'Trusted Eyes',   desc: 'Collect 10 confirms in total' },
  { id: 'helper_10',     name: 'Fact Checker',   desc: 'Judge 10 sightings by others' },
  { id: 'flyer_finder',  name: 'Flyer Finder',   desc: 'A confirmed flyer find' },
  { id: 'streak_4',      name: 'Regular',        desc: 'Post in 4 weeks in a row' },
];

/** ISO-week key, Monday-based — streaks follow the weekly flyer rhythm. */
function weekKey(ts) {
  const d = new Date(ts);
  const day = (d.getDay() + 6) % 7;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  return `${monday.getFullYear()}-${monday.getMonth()}-${monday.getDate()}`;
}

function weekStart(offsetWeeks = 0) {
  const now = new Date();
  const day = (now.getDay() + 6) % 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day - offsetWeeks * 7);
  return monday.getTime();
}

/**
 * Consecutive calendar weeks with at least one sighting, counting backwards
 * from this week — or from last week, so a streak is not "broken" on Monday
 * morning before the user had any chance to post.
 */
export function postingStreakWeeks(posts) {
  const weeks = new Set(posts.map((p) => weekKey(p.captured_at)));
  let streak = 0;
  let offset = weeks.has(weekKey(Date.now())) ? 0 : 1;
  while (weeks.has(weekKey(weekStart(offset)))) {
    streak += 1;
    offset += 1;
  }
  return streak;
}

/** The full Scout profile for a user, derived on demand. */
export function deriveScout(userId) {
  const state = db.raw();
  const rules = SCOUT.xp;

  const myPosts = Object.values(state.posts)
    .filter((p) => p.author_id === userId && p.status !== 'removed');
  const myVotes = Object.values(state.votes)
    .filter((v) => v.voter_id === userId && !v.kind && v.post_id);
  const mySoldOuts = Object.values(state.votes)
    .filter((v) => v.kind === 'sold_out' && v.voter_id === userId);
  const myFinds = Object.values(state.flyer_finds)
    .filter((f) => f.reporter_id === userId && f.value === 1 && f.karma_awarded);

  const firstScoutPosts = myPosts.filter((p) => db.isFirstScout(p));
  const streakWeeks = postingStreakWeeks(myPosts);

  let xp = 0;
  xp += myPosts.length * rules.post;
  xp += firstScoutPosts.length * rules.firstScoutBonus;
  for (const post of myPosts) {
    xp += Math.min(post.up_count * rules.confirmReceived, rules.confirmCapPerPost);
  }
  xp += myVotes.length * rules.voteCast;
  xp += mySoldOuts.length * rules.soldOutFlag;
  xp += myFinds.length * rules.flyerFind;
  xp += streakWeeks * rules.streakWeekBonus;

  const levels = SCOUT.levels;
  let levelIndex = 0;
  for (let i = 0; i < levels.length; i++) if (xp >= levels[i].xp) levelIndex = i;
  const level = levels[levelIndex];
  const next = levels[levelIndex + 1] || null;
  const progress = next ? (xp - level.xp) / (next.xp - level.xp) : 1;

  const totalConfirms = myPosts.reduce((n, p) => n + p.up_count, 0);
  const chains = new Set(myPosts
    .map((p) => p.store_name?.trim().split(/[\s,]+/)[0]?.toLowerCase())
    .filter(Boolean));

  const earned = new Set();
  if (myPosts.length >= 1) earned.add('first_find');
  if (myPosts.some((p) => new Date(p.captured_at).getHours() < 9)) earned.add('early_bird');
  if (chains.size >= 3) earned.add('chain_hopper');
  if (myPosts.some((p) => p.up_count >= 5)) earned.add('crowd_pick');
  if (totalConfirms >= 10) earned.add('confirmed_10');
  if (myVotes.length >= 10) earned.add('helper_10');
  if (myFinds.length >= 1) earned.add('flyer_finder');
  if (streakWeeks >= 4) earned.add('streak_4');

  return {
    xp,
    level: levelIndex + 1,
    levelName: level.name,
    nextLevelName: next?.name || null,
    nextLevelXp: next?.xp || null,
    progress,
    streakWeeks,
    badges: BADGES.map((b) => ({ ...b, earned: earned.has(b.id) })),
    earnedCount: earned.size,
    posts: myPosts.length,
    firstFinds: firstScoutPosts.length,
  };
}

/** What one just-published post pays, for the success toast. */
export function xpForPost(post) {
  const base = SCOUT.xp.post;
  const first = db.isFirstScout(post) ? SCOUT.xp.firstScoutBonus : 0;
  return { total: base + first, first: first > 0 };
}
