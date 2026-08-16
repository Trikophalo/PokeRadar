/**
 * The post creation flow.
 *
 * PLANNING.md §6 makes camera-capture-only the cornerstone anti-abuse rule:
 * no gallery import, so faking a sighting means physically photographing
 * something right now. This build keeps that rule — the one concession is an
 * explicitly labelled demo frame for visitors on a device with no camera,
 * which is a property of the public demo and not of the product.
 */

import { RULES } from './config.js';
import * as db from './db.js';
import { productPhoto } from './imagery.js';
import { toast } from './ui.js';
import { $, clear, downscaleImage, el, formatDistance, haptic, uid } from './util.js';

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
        this.capture = { photo: downscaleImage(video), capturedAt: Date.now(), simulated: false };
        this.teardown();
        this.renderDetailsStep();
      });
    } catch {
      // No camera, or permission refused. Say so plainly and offer the demo path.
      clear(stage);
      stage.append(el('div', { class: 'compose__nocam' }, [
        el('div', { class: 'compose__nocam-glyph', text: '📷' }),
        el('h3', { text: 'Camera unavailable' }),
        el('p', { class: 'muted', text:
          'PokeRadar posts are camera-only — no gallery uploads — so every photo is taken at the shelf. This browser has no camera available, so you can continue with a generated demo frame instead.' }),
        el('button', {
          class: 'btn btn--primary', type: 'button', text: 'Use a demo photo',
          onclick: () => {
            this.capture = {
              photo: productPhoto(uid('demo'), { width: 720 }),
              capturedAt: Date.now(),
              simulated: true,
            };
            this.renderDetailsStep();
          },
        }),
      ]));
    }
  }

  /* -------------------------------------------------------------- step 2 --- */

  renderDetailsStep() {
    clear(this.panel);
    const location = this.getLocation();
    const stores = this.getStores();
    const nearby = location ? db.nearbyStores(location, stores, 4) : [];
    let selectedStore = nearby[0]?.store || null;

    const preview = el('div', { class: 'compose__preview' });
    preview.style.backgroundImage = `url("${this.capture.photo}")`;
    if (this.capture.simulated) {
      preview.append(el('span', { class: 'compose__preview-flag', text: 'demo frame' }));
    }

    const title = el('input', {
      class: 'field__input', type: 'text', maxlength: String(RULES.titleMaxLength),
      placeholder: 'What did you find?', autofocus: true, 'aria-label': 'Title',
    });
    const description = el('textarea', {
      class: 'field__input field__input--area', rows: '2',
      maxlength: String(RULES.descriptionMaxLength),
      placeholder: 'Optional: aisle, how many left, staff info…', 'aria-label': 'Description',
    });

    const storeChips = el('div', { class: 'chips' });
    const paintChips = () => {
      clear(storeChips);
      if (!nearby.length) {
        storeChips.append(el('span', { class: 'muted', text: 'No known store within range — the raw GPS point will be used.' }));
        return;
      }
      for (const { store, distance } of nearby) {
        const chip = el('button', {
          class: `chip chip--tappable ${selectedStore?.place_id === store.place_id ? 'is-active' : ''}`,
          type: 'button',
        }, [
          el('span', { text: `📍 ${store.name}` }),
          el('span', { class: 'chip__distance', text: formatDistance(distance) }),
        ]);
        chip.addEventListener('click', () => {
          selectedStore = selectedStore?.place_id === store.place_id ? null : store;
          paintChips();
        });
        storeChips.append(chip);
      }
    };
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
          el('span', { class: 'field__label', text: 'Location' }),
          el('p', { class: 'compose__geo', text: location
            ? (location.accuracy
              ? `Tagged from GPS ±${Math.round(location.accuracy)} m — location cannot be placed by hand.`
              : 'Tagged from your GPS fix — location cannot be placed by hand.')
            : 'No GPS fix yet. Allow location access to post.' }),
          storeChips,
        ]),
        submit,
      ]),
    );

    title.focus();
    submit.addEventListener('click', () => this.submit({ title, description, location, selectedStore }));
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
    toast('Sighting posted — live on the map for one hour.', { tone: 'good' });
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
