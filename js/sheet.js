/**
 * The bottom sheet.
 *
 * PLANNING.md §5 commits to one navigation paradigm: the map is ground truth
 * and everything else is a sheet layered over it, with peek / half / full snap
 * points. That is the Apple Maps and Find My model, and it is why this app has
 * no screen-to-screen navigation for its core flows.
 */

import { clamp, prefersReducedMotion } from './util.js';

const SNAP_FRACTIONS = { peek: 0.16, half: 0.52, full: 0.93 };

export class Sheet {
  constructor(root, { onSnap } = {}) {
    this.root = root;
    this.scroller = root.querySelector('.sheet__scroll');
    this.grabber = root.querySelector('.sheet__grabber');
    this.onSnap = onSnap;
    this.state = 'peek';
    this.dragging = false;

    // Measure the sheet's own box, not the window: on desktop the app renders
    // inside a phone-sized frame, and the sheet stops above the tab bar — the
    // snap points have to follow that box, not the viewport.
    this.height = () => this.root.clientHeight
      || this.root.parentElement?.clientHeight
      || window.innerHeight;
    this.offsetFor = (snap) => Math.round(this.height() * (1 - SNAP_FRACTIONS[snap]));

    this.bindDrag();
    window.addEventListener('resize', () => this.snapTo(this.state, true));
    this.snapTo('peek', true);
  }

  /**
   * Publish the sheet's top edge so the floating chrome can ride above it.
   * Without this the + button sits underneath the sheet the moment it opens.
   */
  syncChrome(offset, snap = this.state) {
    // The shell, not the immediate parent — the sheet now sits inside a
    // clipping layer, and the floating chrome reads these off the shell.
    const shell = this.root.closest('.shell');
    if (!shell) return;
    shell.style.setProperty('--sheet-top', `${offset}px`);
    shell.dataset.sheet = snap;
  }

  snapTo(snap, immediate = false) {
    this.state = snap;
    const offset = this.offsetFor(snap);
    this.root.classList.toggle('sheet--immediate', immediate || prefersReducedMotion());
    this.root.style.transform = `translate3d(0, ${offset}px, 0)`;
    this.root.dataset.snap = snap;
    this.syncChrome(offset, snap);
    // Half and full both scroll: at half, a post's action row sits below the
    // fold, and making the user drag to full just to reach Confirm is friction
    // for no gain. Peek shows only the header, so it stays locked.
    this.scroller.style.overflowY = snap === 'peek' ? 'hidden' : 'auto';
    if (snap === 'peek') this.scroller.scrollTop = 0;
    this.fitScroller(offset);

    if (immediate) {
      requestAnimationFrame(() => this.root.classList.remove('sheet--immediate'));
    }
    this.onSnap?.(snap);
  }

  /**
   * The sheet is positioned by translating a full-height box downwards, so its
   * scroll container runs off the bottom of the screen. Left alone, the browser
   * believes content down there is "in view" and refuses to scroll to it —
   * which strands anything below the fold at the half snap. Cap the scroller at
   * the height that is genuinely on screen.
   */
  fitScroller(offset) {
    const chrome = (this.grabber?.offsetHeight || 0)
      + (this.root.querySelector('.sheet__head')?.offsetHeight || 0);
    const visible = this.height() - offset - chrome;
    this.scroller.style.maxHeight = `${Math.max(0, visible)}px`;
  }

  bindDrag() {
    let startY = 0;
    let startOffset = 0;
    let pointerId = null;

    const canStartDrag = (event) => {
      if (this.grabber.contains(event.target)) return true;
      if (event.target.closest('button, a, input, textarea, select, .no-drag')) return false;
      // From the content area, only take over the gesture at the top of scroll —
      // otherwise the sheet fights the list it is showing.
      return this.state === 'peek' || this.scroller.scrollTop <= 0;
    };

    const onDown = (event) => {
      if (!canStartDrag(event)) return;
      pointerId = event.pointerId;
      startY = event.clientY;
      startOffset = this.currentOffset();
      this.dragging = true;
      this.root.classList.add('sheet--dragging');
      this.root.closest('.shell')?.classList.add('is-dragging-sheet');
      this.root.setPointerCapture?.(pointerId);
    };

    const onMove = (event) => {
      if (!this.dragging || event.pointerId !== pointerId) return;
      const delta = event.clientY - startY;
      if (this.state === 'full' && delta < 0) return;
      const next = clamp(startOffset + delta, this.offsetFor('full'), this.height() - 44);
      this.root.style.transform = `translate3d(0, ${next}px, 0)`;
      this.syncChrome(next);
      if (Math.abs(delta) > 4) event.preventDefault();
    };

    const onUp = (event) => {
      if (!this.dragging || event.pointerId !== pointerId) return;
      this.dragging = false;
      this.root.classList.remove('sheet--dragging');
      this.root.closest('.shell')?.classList.remove('is-dragging-sheet');
      this.root.releasePointerCapture?.(pointerId);

      const offset = this.currentOffset();
      const velocity = event.clientY - startY;
      this.snapTo(this.nearestSnap(offset, velocity));
    };

    this.root.addEventListener('pointerdown', onDown);
    this.root.addEventListener('pointermove', onMove, { passive: false });
    this.root.addEventListener('pointerup', onUp);
    this.root.addEventListener('pointercancel', onUp);
  }

  currentOffset() {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(this.root).transform);
    return matrix.m42 || 0;
  }

  /** A decisive flick beats proximity — otherwise short drags feel sticky. */
  nearestSnap(offset, velocity) {
    const order = ['full', 'half', 'peek'];
    if (Math.abs(velocity) > 90) {
      const index = order.indexOf(this.state);
      const next = velocity > 0 ? index + 1 : index - 1;
      return order[clamp(next, 0, order.length - 1)];
    }
    return order.reduce((best, snap) =>
      Math.abs(this.offsetFor(snap) - offset) < Math.abs(this.offsetFor(best) - offset) ? snap : best,
    this.state);
  }
}

/**
 * Modal sheets — compose, profile, sign-in. These cover the map rather than
 * layering over it, so they get their own presentation and a scrim.
 */
export class ModalSheet {
  constructor(root) {
    this.root = root;
    this.scrim = root.querySelector('.modal__scrim');
    this.panel = root.querySelector('.modal__panel');
    this.openState = false;

    this.scrim.addEventListener('click', () => this.close());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.openState) this.close();
    });
  }

  open() {
    this.openState = true;
    this.root.hidden = false;
    this.previouslyFocused = document.activeElement;
    requestAnimationFrame(() => {
      this.root.classList.add('modal--open');
      const target = this.panel.querySelector('[autofocus], input, button');
      target?.focus({ preventScroll: true });
    });
    document.body.classList.add('is-modal-open');
  }

  close() {
    if (!this.openState) return;
    this.openState = false;
    this.root.classList.remove('modal--open');
    document.body.classList.remove('is-modal-open');
    const done = () => {
      this.root.hidden = true;
      this.onClosed?.();
    };
    if (prefersReducedMotion()) done();
    else setTimeout(done, 260);
    this.previouslyFocused?.focus?.({ preventScroll: true });
  }
}
