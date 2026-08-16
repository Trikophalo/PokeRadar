/**
 * Flyer tab rendering and the page viewer.
 *
 * The list only ever shows flyers that passed the visibility rule in
 * flyers.js; the "All current flyers" section below it exists so the community
 * layer has somewhere to report from (PLANNING.md §10.6).
 */

import { FLYER_RULES } from './config.js';
import * as db from './db.js';
import * as flyers from './flyers.js';
import { chainColor, flyerCover, flyerPage } from './flyerart.js';
import { toast } from './ui.js';
import { $, clear, el, formatDistance, haptic } from './util.js';

/* ----------------------------------------------------------------- list --- */

export function renderFlyers({ stores, origin, onOpen, onRequireAuth, refresh }) {
  const { visible, candidates, outOfRange } = flyers.partition({ stores, origin });
  const meta = flyers.catalogueMeta();

  $('#flyers-week').textContent = meta.week
    ? `${deDate(meta.week.valid_from)} – ${deDate(meta.week.valid_until)}`
    : 'This week';
  $('#flyers-count').textContent = visible.length
    ? `${visible.length} with Pokémon`
    : 'nothing found yet';

  const list = clear($('#flyers-list'));
  if (!visible.length) {
    list.append(el('div', { class: 'empty' }, [
      el('div', { class: 'empty__glyph', text: '📰' }),
      el('p', { class: 'empty__title', text: meta.error ? 'Flyers unavailable' : 'No Pokémon in this week’s flyers yet' }),
      el('p', { class: 'empty__body', text: meta.error
        ? 'The weekly flyer feed could not be loaded. It refreshes once a day — try again later.'
        : `Flyers appear here only once Pokémon has actually been found in them. Spot one in the list below and report the page — the first confirmed find earns +${FLYER_RULES.findKarma} karma.` }),
    ]));
  } else {
    for (const entry of visible) list.append(flyerCard(entry, { onOpen }));
  }

  const candidateSection = $('#flyers-candidates');
  candidateSection.hidden = candidates.length === 0;
  const candidateList = clear($('#flyers-candidate-list'));
  for (const entry of candidates) {
    candidateList.append(flyerCard(entry, { onOpen, muted: true }));
  }

  const notes = [];
  if (meta.source === 'simulated') {
    notes.push('Simulated flyer data — no retailer content is fetched or redistributed. '
      + 'Production sources this from a licensed aggregator API.');
  }
  notes.push('Refreshed once a day.');
  if (outOfRange) notes.push(`${outOfRange} hidden: no branch within ${FLYER_RULES.maxBranchDistanceM / 1000} km.`);
  $('#flyers-notice').textContent = notes.join(' ');
}

function flyerCard(entry, { onOpen, muted = false }) {
  const { flyer, branch, badge, page } = entry;
  const color = chainColor(flyer.chain);

  const cover = el('span', { class: 'fcard__cover' });
  cover.style.backgroundImage = `url("${flyerCover(flyer, { width: 210 })}")`;

  const badgeNode = badge === 'auto'
    ? el('span', { class: 'fbadge fbadge--auto', text: `Pokémon · p. ${page}` })
    : badge === 'community'
      ? el('span', { class: 'fbadge fbadge--community', text: `Community find · p. ${page}` })
      : null;

  const card = el('button', { class: `fcard ${muted ? 'is-muted' : ''}`, type: 'button' }, [
    cover,
    el('span', { class: 'fcard__body' }, [
      el('span', { class: 'fcard__chain' }, [
        el('span', { class: 'fcard__dot' }),
        el('span', { text: flyer.chain }),
      ]),
      el('span', { class: 'fcard__title', text: flyer.title }),
      el('span', { class: 'fcard__meta', text: branch
        ? `${formatDistance(branch.distance)} away · valid to ${deDate(flyer.valid_until)}`
        : `valid to ${deDate(flyer.valid_until)}` }),
      badgeNode,
    ]),
  ]);
  card.querySelector('.fcard__dot').style.background = color.bg;
  card.addEventListener('click', () => onOpen?.(flyer.id));
  return card;
}

/* --------------------------------------------------------------- viewer --- */

export class FlyerViewer {
  constructor(modal, { getStores, getOrigin, onChanged, onRequireAuth }) {
    this.modal = modal;
    this.getStores = getStores;
    this.getOrigin = getOrigin;
    this.onChanged = onChanged;
    this.onRequireAuth = onRequireAuth;
    this.page = 1;
  }

  open(flyerId) {
    const flyer = flyers.allFlyers().find((f) => f.id === flyerId);
    if (!flyer) return;
    this.flyer = flyer;
    this.entry = flyers.evaluate(flyer, { stores: this.getStores(), origin: this.getOrigin() });

    // Real flyers deep-link into the retailer's own viewer (§10.1); only the
    // simulated feed falls through to the built-in pages.
    if (flyer.viewer_url) {
      window.open(flyer.viewer_url, '_blank', 'noopener');
      return;
    }

    this.page = this.entry.page || 1;
    this.render();
    this.modal.open();
  }

  render() {
    const panel = clear(this.modal.panel);
    const flyer = this.flyer;
    this.entry = flyers.evaluate(flyer, { stores: this.getStores(), origin: this.getOrigin() });
    const match = (flyer.matches || []).find((m) => m.page === this.page);

    panel.append(
      el('div', { class: 'compose__header' }, [
        el('span', { class: 'iconbtn iconbtn--ghost' }),
        el('h2', { class: 'compose__heading', text: flyer.chain }),
        el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Close', text: '✕',
          onclick: () => this.modal.close() }),
      ]),
      this.pageStage(match),
      this.pager(),
      this.actions(),
    );
  }

  pageStage(match) {
    const stage = el('div', { class: 'viewer__stage' });
    const img = el('img', {
      class: 'viewer__page',
      alt: `${this.flyer.chain} flyer, page ${this.page}`,
      src: flyerPage(this.flyer, this.page, { width: 720 }),
    });
    stage.append(img);
    if (match) {
      stage.append(el('span', { class: 'viewer__flag', text: `${match.term} · ${match.offer_title || ''}`.trim() }));
    }
    return stage;
  }

  pager() {
    const prev = el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Previous page', text: '‹',
      onclick: () => this.go(-1) });
    const next = el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Next page', text: '›',
      onclick: () => this.go(1) });
    prev.disabled = this.page <= 1;
    next.disabled = this.page >= this.flyer.page_count;

    const jump = this.entry.page && this.entry.page !== this.page
      ? el('button', { class: 'btn btn--secondary btn--compact', type: 'button',
          text: `Jump to p. ${this.entry.page}`,
          onclick: () => { this.page = this.entry.page; this.render(); } })
      : null;

    return el('div', { class: 'viewer__pager' }, [
      prev,
      el('span', { class: 'viewer__count', text: `${this.page} / ${this.flyer.page_count}` }),
      next,
      jump,
    ]);
  }

  go(delta) {
    const next = this.page + delta;
    if (next < 1 || next > this.flyer.page_count) return;
    this.page = next;
    haptic(6);
    this.render();
  }

  actions() {
    const flyer = this.flyer;
    const stats = db.flyerFindStats(flyer.id);
    const mine = db.myFlyerFind(flyer.id);
    const auto = this.entry.auto;

    const row = el('div', { class: 'viewer__actions' });

    if (auto) {
      // Already found automatically — the community vote here is about whether
      // the listing is really there, not about surfacing it.
      row.append(el('p', { class: 'viewer__note', text:
        `Found automatically in this week's offers: “${auto.term}” on page ${auto.page}.` }));
    } else {
      const confirm = el('button', {
        class: `btn ${mine?.value === 1 ? 'btn--secondary' : 'btn--primary'} btn--compact`,
        type: 'button',
        text: mine?.value === 1 ? `Reported p. ${mine.page} ✓` : `Pokémon on page ${this.page}`,
      });
      confirm.addEventListener('click', () => {
        if (!db.currentUser()) return this.onRequireAuth?.(() => this.render());
        const result = db.reportFlyerFind(flyer.id, { page: this.page, value: 1 });
        if (!result.ok) return toast(result.error, { tone: 'warn' });
        haptic(12);
        if (result.retracted) toast('Report withdrawn.');
        else if (result.stats?.confirmed) {
          toast(`Confirmed by the community — +${FLYER_RULES.findKarma} karma.`, { tone: 'good' });
        } else {
          const need = FLYER_RULES.communityFindThreshold - result.stats.found;
          toast(`Reported. ${need} more independent report${need === 1 ? '' : 's'} makes it public.`);
        }
        this.render();
        this.onChanged?.();
      });

      const dispute = el('button', {
        class: `linkbtn ${mine?.value === -1 ? 'linkbtn--danger' : ''}`,
        type: 'button',
        text: mine?.value === -1 ? 'Disputed ✓' : 'No Pokémon in here',
      });
      dispute.addEventListener('click', () => {
        if (!db.currentUser()) return this.onRequireAuth?.(() => this.render());
        const result = db.reportFlyerFind(flyer.id, { value: -1 });
        if (!result.ok) return toast(result.error, { tone: 'warn' });
        haptic(8);
        this.render();
        this.onChanged?.();
      });

      row.append(confirm, dispute);
      if (stats.found) {
        row.append(el('p', { class: 'viewer__note', text:
          `${stats.found} report${stats.found === 1 ? '' : 's'} so far${stats.disputed ? `, ${stats.disputed} disputed` : ''}.` }));
      }
    }

    if (this.entry.branch) {
      row.append(el('button', {
        class: 'btn btn--secondary btn--compact', type: 'button',
        text: `Directions · ${formatDistance(this.entry.branch.distance)}`,
        onclick: () => {
          const s = this.entry.branch.store;
          window.open(`https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`, '_blank', 'noopener');
        },
      }));
    }

    return row;
  }
}

function deDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}
