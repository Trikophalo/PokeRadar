/**
 * View rendering.
 *
 * Everything here builds DOM from the data layer. Views never decide whether an
 * action is allowed — they ask db.js and render whatever it says, so the rules
 * in PLANNING.md have exactly one home.
 */

import { RULES, tierFor, nextTierFor } from './config.js';
import * as db from './db.js';
import { photoFor } from './db.js';
import { deriveScout } from './xp.js';
import {
  clear, el, escapeHtml, formatAgo, formatCountdown, formatDistance,
  formatRemaining, distanceMeters, haptic,
} from './util.js';

/* ---------------------------------------------------------------- atoms --- */

export function avatarEl(profile, size = 'sm') {
  const hue = profile?.avatar?.hue ?? 210;
  const node = el('span', {
    class: `avatar avatar--${size}`,
    'aria-hidden': 'true',
    text: profile?.avatar?.glyph || profile?.username?.[0]?.toUpperCase() || '?',
  });
  node.style.setProperty('--avatar-hue', hue);
  return node;
}

export function tierBadgeEl(profile) {
  if (!profile) return null;
  const tier = tierFor(profile.karma);
  const node = el('span', { class: `badge badge--${tier.key}`, text: tier.name });
  node.style.setProperty('--badge-accent', tier.accent);
  return node;
}

export function karmaChipEl(profile) {
  if (!profile) return null;
  const value = profile.karma;
  return el('span', {
    class: `karma-chip ${value < 0 ? 'is-negative' : ''}`,
    text: `${value > 0 ? '+' : ''}${value}`,
    title: 'Karma',
  });
}

export function reporterChipEl(profile, { onTap } = {}) {
  const chip = el('button', { class: 'reporter', type: 'button' }, [
    avatarEl(profile),
    el('span', { class: 'reporter__meta' }, [
      el('span', { class: 'reporter__name', text: profile?.username || 'unknown' }),
      el('span', { class: 'reporter__sub' }, [tierBadgeEl(profile), karmaChipEl(profile)]),
    ]),
  ]);
  chip.addEventListener('click', (event) => {
    event.stopPropagation();
    onTap?.(profile?.id);
  });
  return chip;
}

export function toast(message, { tone = 'neutral' } = {}) {
  const host = document.getElementById('toasts');
  const node = el('div', { class: `toast toast--${tone}`, role: 'status', text: message });
  host.append(node);
  requestAnimationFrame(() => node.classList.add('toast--in'));
  setTimeout(() => {
    node.classList.remove('toast--in');
    setTimeout(() => node.remove(), 240);
  }, 2600);
}

/* ------------------------------------------------------------ post card --- */

export function postCardEl(post, { origin, onTap, variant = 'row' } = {}) {
  const author = db.getProfile(post.author_id);
  const distance = origin ? distanceMeters(origin, post) : null;
  const gone = db.isLikelyGone(post);
  const expired = db.isExpired(post);

  const thumb = el('span', { class: 'card__thumb' });
  const photo = photoFor(post);
  if (photo) thumb.style.backgroundImage = `url("${photo}")`;

  const card = el('button', {
    class: `card card--${variant} ${gone ? 'is-gone' : ''} ${expired ? 'is-expired' : ''}`,
    type: 'button',
  }, [
    thumb,
    el('span', { class: 'card__body' }, [
      el('span', { class: 'card__title', text: post.title }),
      el('span', { class: 'card__store', text: post.store_name || 'Unknown location' }),
      el('span', { class: 'card__meta' }, [
        el('span', {
          class: `card__time ${expired ? 'is-expired' : ''}`,
          text: expired ? 'off the map' : formatRemaining(post.expires_at - Date.now()),
        }),
        distance !== null ? el('span', { class: 'card__dot', text: '·' }) : null,
        distance !== null ? el('span', { text: formatDistance(distance) }) : null,
        post.up_count ? el('span', { class: 'card__dot', text: '·' }) : null,
        post.up_count ? el('span', { text: `${post.up_count} confirmed` }) : null,
      ]),
    ]),
    gone ? el('span', { class: 'card__flag', text: 'likely gone' }) : null,
    author ? el('span', { class: 'card__author' }, [avatarEl(author)]) : null,
  ]);

  card.addEventListener('click', () => onTap?.(post.id));
  return card;
}

/* ---------------------------------------------------------- feed / list --- */

export function renderFeed(container, { origin, onTapPost }) {
  clear(container);
  const posts = db.activePosts();

  if (!posts.length) {
    container.append(el('div', { class: 'empty' }, [
      el('div', { class: 'empty__glyph', text: '📡' }),
      el('p', { class: 'empty__title', text: 'No sightings nearby' }),
      el('p', { class: 'empty__body', text: 'Nothing on the radar in the last hour. Be the first radar in your area — first finds at a store earn bonus XP and a star on the marker.' }),
    ]));
    return;
  }

  const sorted = origin
    ? [...posts].sort((a, b) => distanceMeters(origin, a) - distanceMeters(origin, b))
    : posts;

  for (const post of sorted) {
    container.append(postCardEl(post, { origin, onTap: onTapPost }));
  }
}

/* --------------------------------------------------------- post detail  --- */

export function renderPostDetail(container, postId, ctx) {
  const post = db.getPost(postId);
  clear(container);
  if (!post) {
    container.append(el('div', { class: 'empty' }, [
      el('p', { class: 'empty__title', text: 'This sighting is gone' }),
    ]));
    return;
  }

  const author = db.getProfile(post.author_id);
  const me = db.currentUser();
  const mine = me && me.id === post.author_id;
  const expired = db.isExpired(post);
  const gone = db.isLikelyGone(post);
  const distance = ctx.origin ? distanceMeters(ctx.origin, post) : null;
  const remaining = post.expires_at - Date.now();
  const progress = Math.max(0, Math.min(1, remaining / RULES.visibilityMs));

  const hero = el('div', { class: `detail__hero ${gone ? 'is-gone' : ''}` });
  const photo = photoFor(post);
  if (photo) hero.style.backgroundImage = `url("${photo}")`;
  else hero.append(el('span', { class: 'detail__hero-missing', text: 'Photo released after expiry' }));
  if (gone) hero.append(el('span', { class: 'detail__hero-flag', text: 'Likely gone' }));

  const timebar = el('div', { class: 'timebar' }, [
    el('div', { class: 'timebar__fill' }),
  ]);
  timebar.querySelector('.timebar__fill').style.width = `${progress * 100}%`;
  if (progress < 0.1) timebar.classList.add('is-ending');

  const body = el('div', { class: 'detail__body' }, [
    el('h2', { class: 'detail__title', text: post.title }),
    el('p', { class: 'detail__store' }, [
      el('span', { text: post.store_name || 'Unknown location' }),
      distance !== null ? el('span', { class: 'detail__distance', text: ` · ${formatDistance(distance)} away` }) : null,
    ]),
    db.isFirstScout(post)
      ? el('p', { class: 'detail__first', text: '★ First find at this store today' })
      : null,
    el('p', { class: 'detail__timing' }, [
      el('span', { text: `posted ${formatAgo(Date.now() - post.captured_at)}` }),
      el('span', { class: 'detail__dot', text: '·' }),
      el('strong', {
        class: expired ? 'is-expired' : '',
        text: expired ? 'off the map' : formatRemaining(remaining),
      }),
    ]),
    timebar,
    post.description ? el('p', { class: 'detail__description', text: post.description }) : null,
  ]);

  const actions = mine
    ? renderOwnerActions(post, ctx)
    : renderVoteActions(post, ctx);

  const footer = el('div', { class: 'detail__footer' }, [
    reporterChipEl(author, { onTap: ctx.onOpenProfile }),
    el('button', {
      class: 'btn btn--secondary btn--compact',
      type: 'button',
      text: 'Directions',
      onclick: () => {
        window.open(
          `https://www.google.com/maps/dir/?api=1&destination=${post.lat},${post.lng}`,
          '_blank',
          'noopener',
        );
      },
    }),
  ]);

  const overflow = el('div', { class: 'detail__overflow' }, [
    el('button', {
      class: 'linkbtn', type: 'button', text: 'Report this sighting',
      onclick: () => ctx.onReport?.(post.id),
    }),
    el('span', { class: 'detail__accuracy', text: post.location_accuracy_m ? `GPS ±${post.location_accuracy_m} m` : '' }),
  ]);

  container.append(hero, body, actions, footer, overflow);
}

function renderVoteActions(post, ctx) {
  const me = db.currentUser();
  const vote = db.myVote(post.id);
  const flagged = db.hasFlaggedSoldOut(post.id);
  const windowOpen = db.voteWindowOpen(post);

  const row = el('div', { class: 'actions' });

  const confirm = el('button', {
    class: `action action--confirm ${vote?.value === 1 ? 'is-active' : ''}`,
    type: 'button',
    disabled: !windowOpen,
  }, [
    el('span', { class: 'action__glyph', text: '👍' }),
    el('span', { class: 'action__label', text: 'Confirm' }),
    el('span', { class: 'action__count', text: String(post.up_count) }),
  ]);
  confirm.addEventListener('click', () => {
    if (!me) return ctx.onRequireAuth?.();
    const result = db.castVote(post.id, 1);
    if (!result.ok) return toast(result.error, { tone: 'warn' });
    haptic(10);
    announceVote(result);
    ctx.refresh?.();
  });

  const dispute = el('button', {
    class: `action action--dispute ${vote?.value === -1 ? 'is-active' : ''}`,
    type: 'button',
    disabled: !windowOpen,
  }, [
    el('span', { class: 'action__glyph', text: '👎' }),
    el('span', { class: 'action__label', text: 'Dispute' }),
    el('span', { class: 'action__count', text: String(post.down_count) }),
  ]);
  dispute.addEventListener('click', () => {
    if (!me) return ctx.onRequireAuth?.();
    if (vote?.value === -1) {
      db.castVote(post.id, -1, vote.reason);
      haptic(10);
      return ctx.refresh?.();
    }
    reasonPicker.hidden = false;
    reasonPicker.querySelector('button')?.focus();
  });

  // The no-fault freshness signal (§4). Deliberately not a downvote: an honest
  // post whose shelf emptied should not cost its author karma.
  const soldOut = el('button', {
    class: `action action--soldout ${flagged ? 'is-active' : ''}`,
    type: 'button',
    disabled: flagged,
  }, [
    el('span', { class: 'action__glyph', text: '🛒' }),
    el('span', { class: 'action__label', text: flagged ? 'Flagged' : 'Sold out now' }),
    post.sold_out_count ? el('span', { class: 'action__count', text: String(post.sold_out_count) }) : null,
  ]);
  soldOut.addEventListener('click', () => {
    if (!me) return ctx.onRequireAuth?.();
    const result = db.flagSoldOut(post.id);
    if (!result.ok) return toast(result.error, { tone: 'warn' });
    haptic([6, 40, 6]);
    toast('Marked as sold out — no karma effect on the reporter.');
    ctx.refresh?.();
  });

  row.append(confirm, dispute, soldOut);

  const reasonPicker = el('div', { class: 'reasons', hidden: true }, [
    el('p', { class: 'reasons__label', text: 'What was wrong?' }),
    el('div', { class: 'reasons__chips' }, [
      ['not_restocked', 'Not restocked'],
      ['wrong_location', 'Wrong location'],
      ['misleading_photo', 'Misleading photo'],
      ['spam', 'Spam'],
    ].map(([value, label]) =>
      el('button', {
        class: 'chip chip--tappable', type: 'button', text: label,
        onclick: () => {
          const result = db.castVote(post.id, -1, value);
          if (!result.ok) return toast(result.error, { tone: 'warn' });
          haptic(12);
          announceVote(result);
          ctx.refresh?.();
        },
      })),
    ),
  ]);

  const wrap = el('div', {}, [row, reasonPicker]);
  if (!windowOpen) {
    wrap.append(el('p', { class: 'actions__note', text: 'Voting closed — sightings stay votable for 6 hours after capture.' }));
  }
  return wrap;
}

/**
 * A probationary vote counts in the visible tally but never moves karma (§6).
 * Silently doing nothing would read as a bug, so say what happened and why.
 */
function announceVote(result) {
  if (result.retracted) return toast('Vote retracted.');
  if (result.vote && !result.vote.counts_for_karma) {
    toast('Counted — but new accounts do not move karma for their first 72 hours.');
  }
}

function renderOwnerActions(post, ctx) {
  const net = post.up_count - post.down_count;
  return el('div', { class: 'ownerbar' }, [
    el('div', { class: 'ownerbar__stats' }, [
      statEl(String(post.up_count), 'confirmed'),
      statEl(String(post.down_count), 'disputed'),
      statEl(`${net >= 0 ? '+' : ''}${net}`, 'net karma'),
    ]),
    el('button', {
      class: 'linkbtn linkbtn--danger', type: 'button', text: 'Delete sighting',
      onclick: () => {
        if (!confirm('Delete this sighting? Karma already earned stays on your ledger.')) return;
        db.deletePost(post.id);
        toast('Sighting deleted.');
        ctx.onDeleted?.();
      },
    }),
  ]);
}

function statEl(value, label) {
  return el('div', { class: 'stat' }, [
    el('div', { class: 'stat__value', text: value }),
    el('div', { class: 'stat__label', text: label }),
  ]);
}

/* -------------------------------------------------------------- profile --- */

export function renderProfile(container, userId, ctx) {
  const profile = db.getProfile(userId);
  clear(container);
  if (!profile) return;

  const me = db.currentUser();
  const isMe = me && me.id === userId;
  const tier = tierFor(profile.karma);
  const next = nextTierFor(profile.karma);
  const stats = db.statsFor(userId);

  container.append(
    el('header', { class: 'profile__head' }, [
      avatarEl(profile, 'lg'),
      el('div', {}, [
        el('h2', { class: 'profile__name', text: profile.username }),
        el('p', { class: 'profile__since', text: `on the radar since ${new Date(profile.created_at).toLocaleDateString()}` }),
      ]),
    ]),
    karmaRingEl(profile, tier, next),
    el('div', { class: 'profile__tier' }, [
      tierBadgeEl(profile),
      el('span', { class: 'profile__perk', text: tier.perk }),
    ]),
    el('div', { class: 'profile__stats' }, [
      statEl(String(stats.posts), 'sightings'),
      statEl(String(stats.confirms), 'confirms'),
      statEl(stats.accuracy === null ? '—' : `${stats.accuracy}%`, 'accuracy'),
    ]),
  );

  if (isMe) {
    const scout = deriveScout(userId);
    container.append(scoutSectionEl(scout));

    const today = db.karmaToday(userId);
    container.append(el('div', { class: 'ledger' }, [
      el('span', { class: 'ledger__label', text: 'Your ledger today' }),
      el('span', {
        class: `ledger__value ${today < 0 ? 'is-negative' : ''}`,
        text: `${today > 0 ? '+' : ''}${today} karma`,
      }),
    ]));
    if (db.isProbationary(profile)) {
      container.append(el('p', { class: 'notice', text:
        'New account: your votes are shown but do not move anyone\'s karma for the first 72 hours. This is what makes sock-puppet farming pointless.' }));
    }
  }

  const posts = db.postsByAuthor(userId);
  container.append(el('h3', { class: 'section-title', text: isMe ? 'Your sightings' : 'Recent sightings' }));

  if (!posts.length) {
    container.append(el('p', { class: 'muted', text: 'No sightings posted yet.' }));
  } else {
    const grid = el('div', { class: 'history' });
    for (const post of posts.slice(0, 18)) {
      const cell = el('button', { class: 'history__cell', type: 'button' });
      const photo = photoFor(post);
      if (photo) cell.style.backgroundImage = `url("${photo}")`;
      const net = post.up_count - post.down_count;
      cell.append(
        el('span', { class: `history__score ${net < 0 ? 'is-negative' : ''}`, text: `${net > 0 ? '+' : ''}${net}` }),
        el('span', { class: 'history__store', text: post.store_name?.split(',')[0] || '' }),
      );
      cell.addEventListener('click', () => ctx.onTapPost?.(post.id));
      grid.append(cell);
    }
    container.append(grid);
  }

  if (isMe) {
    container.append(
      el('h3', { class: 'section-title', text: 'Settings' }),
      el('div', { class: 'settings' }, [
        settingsRow('Appearance', ctx.themeControl?.()),
        settingsRow('Account', el('button', {
          class: 'linkbtn', type: 'button', text: 'Sign out',
          onclick: () => ctx.onSignOut?.(),
        })),
        settingsRow('Stored data', el('button', {
          class: 'linkbtn linkbtn--danger', type: 'button', text: 'Reset app data',
          onclick: () => ctx.onResetDemo?.(),
        })),
      ]),
    );
  }
}

function settingsRow(label, control) {
  return el('div', { class: 'settings__row' }, [
    el('span', { class: 'settings__label', text: label }),
    control || null,
  ]);
}

/**
 * The Scout block (§12): level + XP progress, the weekly streak, and the badge
 * case. Sits apart from the karma ring on purpose — trust above, activity here.
 */
function scoutSectionEl(scout) {
  const wrap = el('div', { class: 'scout' });

  const streak = scout.streakWeeks > 0
    ? el('span', { class: 'scout__streak', text: `🔥 ${scout.streakWeeks}-week streak` })
    : el('span', { class: 'scout__streak is-idle', text: 'No streak yet — one sighting this week starts it' });

  wrap.append(
    el('div', { class: 'scout__head' }, [
      el('div', {}, [
        el('div', { class: 'scout__level', text: scout.levelName }),
        el('div', { class: 'scout__xp', text: scout.nextLevelXp
          ? `${scout.xp} XP · ${scout.nextLevelXp - scout.xp} to ${scout.nextLevelName}`
          : `${scout.xp} XP · top level` }),
      ]),
      el('span', { class: 'scout__ln', text: `Lv ${scout.level}` }),
    ]),
    (() => {
      const bar = el('div', { class: 'scout__bar' }, [el('div', { class: 'scout__fill' })]);
      bar.querySelector('.scout__fill').style.width = `${Math.round(scout.progress * 100)}%`;
      return bar;
    })(),
    streak,
    el('div', { class: 'scout__badges' }, scout.badges.map((badge) =>
      el('div', {
        class: `sbadge ${badge.earned ? 'is-earned' : ''}`,
        title: badge.desc,
      }, [
        el('span', { class: 'sbadge__name', text: badge.name }),
        el('span', { class: 'sbadge__desc', text: badge.desc }),
      ]))),
  );
  return wrap;
}

/** Karma inside a progress ring toward the next tier (§4 "Display"). */
function karmaRingEl(profile, tier, next) {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const floor = tier.min === -Infinity ? -25 : tier.min;
  const ceiling = next ? next.min : floor + 100;
  const span = Math.max(1, ceiling - floor);
  const progress = Math.max(0, Math.min(1, (profile.karma - floor) / span));

  const wrap = el('div', { class: 'karma-ring' });
  wrap.style.setProperty('--tier-accent', tier.accent);
  // A rounded cap on a zero-length arc still paints a dot, which reads as a
  // stray bug at 0 karma — so the arc is omitted entirely until there is one.
  const arc = progress > 0.004
    ? `<circle class="karma-ring__arc" cx="64" cy="64" r="${radius}"
               stroke-dasharray="${(circumference * progress).toFixed(1)} ${circumference}"
               transform="rotate(-90 64 64)" />`
    : '';
  wrap.innerHTML = `
    <svg viewBox="0 0 128 128" aria-hidden="true">
      <circle class="karma-ring__track" cx="64" cy="64" r="${radius}" />
      ${arc}
    </svg>
    <div class="karma-ring__center">
      <div class="karma-ring__value">${escapeHtml(String(profile.karma))}</div>
      <div class="karma-ring__unit">karma</div>
    </div>`;

  const caption = next
    ? `${tier.name} · ${Math.max(0, next.min - profile.karma)} to ${next.name}`
    : `${tier.name} · top tier`;
  wrap.append(el('p', { class: 'karma-ring__caption', text: caption }));
  return wrap;
}

/* -------------------------------------------------------- compose entry --- */

/** The + button doubles as the cooldown display (§5: no dead buttons). */
export function updateComposeButton(button) {
  const remaining = db.cooldownRemaining();
  const label = button.querySelector('.fab__label');
  button.classList.toggle('is-cooling', remaining > 0);
  if (remaining > 0) {
    const fraction = 1 - remaining / RULES.postCooldownMs;
    button.style.setProperty('--cooldown', String(fraction));
    label.textContent = formatCountdown(remaining);
    button.setAttribute('aria-label', `Next post available in ${formatCountdown(remaining)}`);
  } else {
    button.style.setProperty('--cooldown', '1');
    label.textContent = '+';
    button.setAttribute('aria-label', 'Report a restock');
  }
}
