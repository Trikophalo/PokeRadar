/**
 * The post creation flow.
 *
 * PLANNING.md §6 makes camera-capture-only the cornerstone anti-abuse rule:
 * no gallery import, so faking a sighting means physically photographing
 * something right now. There is deliberately no fallback path — a device
 * without camera access cannot post, and the screen says why.
 */

import { KNOWN_CHAINS, RULES } from './config.js';
import * as db from './db.js';
import { xpForPost } from './xp.js';
import { toast } from './ui.js';
import { clear, downscaleImage, el, formatDistance, haptic, normalizeText } from './util.js';

export class ComposeFlow {
  constructor(modal, { getLocation, getStores, onPosted }) {
    this.modal = modal;
    this.getLocation = getLocation;
    this.getStores = getStores;
    this.onPosted = onPosted;
    this.panel = modal.panel;
    this.stream = null;
    this.capture = null;

    modal.onClosed = () => this.teardown();
  }

  async open() {
    const cooldown = db.cooldownRemaining();
    if (cooldown > 0) {
      this.renderCooldown(cooldown);
      this.modal.open();
      return;
    }
    this.capture = null;
    this.modal.open();
    await this.renderCameraStep();
  }

  teardown() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
  }

  /* ------------------------------------------------------------ cooldown --- */

  renderCooldown(remaining) {
    clear(this.panel);
    const minutes = Math.ceil(remaining / 60000);
    this.panel.append(
      header('Rate limited', () => this.modal.close()),
      el('div', { class: 'compose__cooldown' }, [
        el('div', { class: 'compose__cooldown-glyph', text: '⏳' }),
        el('h2', { text: `Next sighting in ${minutes} min` }),
        el('p', { class: 'muted', text:
          'One post per user every 10 minutes. The limit runs in the database, not the app — it is what keeps a single account from flooding the map.' }),
        el('button', {
          class: 'btn btn--secondary', type: 'button', text: 'Got it',
          onclick: () => this.modal.close(),
        }),
      ]),
    );
  }

  /* -------------------------------------------------------------- step 1 --- */

  async renderCameraStep() {
    clear(this.panel);
    const video = el('video', { class: 'compose__video', autoplay: true, playsinline: true, muted: true });

    // The shutter is laid over the preview rather than placed below it. A phone's
    // rear camera is portrait, so a stage sized to the video pushed the button
    // past the bottom of the screen and made you scroll to take a photo.
    const shutter = el('button', { class: 'shutter', type: 'button', 'aria-label': 'Take photo' }, [
      el('span', { class: 'shutter__inner' }),
    ]);
    const hint = el('p', { class: 'compose__hint', text: 'Photograph the shelf. Avoid including people.' });
    const stage = el('div', { class: 'compose__stage' }, [video, hint, shutter]);

    this.panel.append(
      header('New sighting', () => this.modal.close()),
      stage,
    );

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
        audio: false,
      });
      video.srcObject = this.stream;
      shutter.addEventListener('click', () => {
        if (!video.videoWidth) return;
        haptic(14);
        this.capture = { photo: downscaleImage(video), capturedAt: Date.now() };
        this.teardown();
        this.renderDetailsStep();
      });
    } catch {
      // No camera, or permission refused. Camera-capture-only is the
      // anti-abuse cornerstone (§6), so there is no fallback path — the
      // screen explains the rule instead of quietly weakening it.
      clear(stage);
      stage.append(el('div', { class: 'compose__nocam' }, [
        el('div', { class: 'compose__nocam-glyph', text: '📷' }),
        el('h3', { text: 'Camera required' }),
        el('p', { class: 'muted', text:
          'Sightings are camera-only — no gallery uploads — so every photo on the map was really taken at the shelf, right then. Allow camera access or open PokeRadar on your phone to post.' }),
      ]));
    }
  }

  /* -------------------------------------------------------------- step 2 --- */

  renderDetailsStep() {
    clear(this.panel);
    const location = this.getLocation();
    const stores = this.getStores();
    const nearby = location
      ? db.nearbyStores(location, stores, 4).filter((n) => n.distance <= 600)
      : [];
    let selectedStore = nearby[0]?.store || null;
    let manualName = '';

    const preview = el('div', { class: 'compose__preview' });
    preview.style.backgroundImage = `url("${this.capture.photo}")`;

    const title = el('input', {
      class: 'field__input', type: 'text', maxlength: String(RULES.titleMaxLength),
      placeholder: 'What did you find?', autofocus: true, 'aria-label': 'Title',
    });
    const description = el('textarea', {
      class: 'field__input field__input--area', rows: '2',
      maxlength: String(RULES.descriptionMaxLength),
      placeholder: 'Optional: aisle, how many left, staff info…', 'aria-label': 'Description',
    });

    /* Known stores nearby (learned from earlier sightings) as one-tap chips. */
    const storeChips = el('div', { class: 'chips' });
    const paintChips = () => {
      clear(storeChips);
      for (const { store, distance } of nearby) {
        const active = selectedStore?.name === store.name && !manualName;
        const chip = el('button', {
          class: `chip chip--tappable ${active ? 'is-active' : ''}`,
          type: 'button',
        }, [
          el('span', { text: `📍 ${store.name}` }),
          el('span', { class: 'chip__distance', text: formatDistance(distance) }),
        ]);
        chip.addEventListener('click', () => {
          selectedStore = active ? null : store;
          manualName = '';
          storeInput.value = '';
          paintChips();
          paintSuggestions();
        });
        storeChips.append(chip);
      }
    };

    /*
     * Manual entry with typing assistance: if the store is not (yet) known to
     * the radar, the user writes it themselves. Suggestions come from every
     * store the community has already taught the app, plus the chain list —
     * tapping a chain drops it into the field so only the street is left to
     * type. A manually named store becomes a learned store for everyone after
     * this post syncs.
     */
    const storeInput = el('input', {
      class: 'field__input', type: 'text', maxlength: '80',
      placeholder: nearby.length ? 'Different store? Type its name…' : 'Store name, e.g. Müller Bahnhofstr. 12',
      'aria-label': 'Store name',
    });
    const suggestions = el('div', { class: 'suggest', hidden: true });

    const paintSuggestions = () => {
      clear(suggestions);
      const query = normalizeText(storeInput.value);
      if (query.length < 1) { suggestions.hidden = true; return; }

      const fromLearned = stores
        .filter((store) => normalizeText(store.name).includes(query))
        .slice(0, 3)
        .map((store) => ({ label: store.name, value: store.name, complete: true }));
      const fromChains = KNOWN_CHAINS
        .filter((chain) => normalizeText(chain).startsWith(query))
        .filter((chain) => !fromLearned.some((s) => normalizeText(s.value).startsWith(normalizeText(chain))))
        .slice(0, 4)
        .map((chain) => ({ label: `${chain}…`, value: `${chain} `, complete: false }));

      const items = [...fromLearned, ...fromChains];
      suggestions.hidden = items.length === 0;
      for (const item of items) {
        suggestions.append(el('button', {
          class: 'suggest__item', type: 'button', text: item.label,
          onclick: () => {
            storeInput.value = item.value;
            manualName = item.value.trim();
            selectedStore = null;
            paintChips();
            if (item.complete) { suggestions.hidden = true; }
            else { storeInput.focus(); paintSuggestions(); }
          },
        }));
      }
    };

    storeInput.addEventListener('input', () => {
      manualName = storeInput.value.trim();
      if (manualName) selectedStore = null;
      paintChips();
      paintSuggestions();
    });

    paintChips();

    const submit = el('button', { class: 'btn btn--primary btn--full', type: 'button', text: 'Post sighting' });

    this.panel.append(
      header('Details', () => this.modal.close(), () => this.renderCameraStep()),
      el('div', { class: 'compose__details' }, [
        preview,
        el('label', { class: 'field' }, [
          el('span', { class: 'field__label', text: 'Title' }),
          title,
        ]),
        el('label', { class: 'field' }, [
          el('span', { class: 'field__label', text: 'Description (optional)' }),
          description,
        ]),
        el('div', { class: 'field' }, [
          el('span', { class: 'field__label', text: 'Store' }),
          el('p', { class: 'compose__geo', text: location
            ? (location.accuracy
              ? `Position tagged from GPS ±${Math.round(location.accuracy)} m — the pin cannot be placed by hand.`
              : 'Position tagged from your GPS fix — the pin cannot be placed by hand.')
            : 'No GPS fix yet. Allow location access to post.' }),
          storeChips,
          storeInput,
          suggestions,
        ]),
        submit,
      ]),
    );

    title.focus();
    submit.addEventListener('click', () => {
      const store = selectedStore
        || (manualName.length >= 3 ? { name: manualName, place_id: null } : null);
      this.submit({ title, description, location, selectedStore: store });
    });
  }

  submit({ title, description, location, selectedStore }) {
    const result = db.createPost({
      title: title.value,
      description: description.value,
      photo: this.capture.photo,
      location,
      accuracy: location?.accuracy,
      store: selectedStore,
      capturedAt: this.capture.capturedAt,
    });

    if (!result.ok) {
      if (result.error === 'cooldown') {
        this.renderCooldown(result.remaining);
        return;
      }
      toast(result.error, { tone: 'warn' });
      return;
    }

    haptic([12, 40, 18]);
    this.modal.close();
    const gain = xpForPost(result.post);
    toast(gain.first
      ? `First find at this store! Live for one hour · +${gain.total} XP`
      : `Sighting live for one hour · +${gain.total} XP`, { tone: 'good' });
    this.onPosted?.(result.post);
  }
}

function header(titleText, onClose, onBack) {
  return el('div', { class: 'compose__header' }, [
    onBack
      ? el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Back', text: '‹', onclick: onBack })
      : el('span', { class: 'iconbtn iconbtn--ghost' }),
    el('h2', { class: 'compose__heading', text: titleText }),
    el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Close', text: '✕', onclick: onClose }),
  ]);
}
