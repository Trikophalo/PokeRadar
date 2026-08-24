/* ============================================================
   SCHACH FÜR KINDER · Interaktion
   Header, Navigation, Scroll-Effekte, Countdown, Figuren-
   Trainer, Springer-Jagd, Lightbox, Formular.
   ============================================================ */
(function () {
  'use strict';

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ---------- Header: Schatten beim Scrollen ---------- */
  var header = $('#siteHeader');
  var toTop = $('#toTop');

  function onScrollChrome() {
    header.classList.toggle('is-scrolled', window.scrollY > 8);
    toTop.classList.toggle('show', window.scrollY > 600);
  }
  window.addEventListener('scroll', onScrollChrome, { passive: true });
  onScrollChrome();

  toTop.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
  });

  /* ---------- Mobile-Menü ---------- */
  var burger = $('#burger');
  var mobileMenu = $('#mobileMenu');

  function setMenu(open) {
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Menü schließen' : 'Menü öffnen');
    mobileMenu.classList.toggle('open', open);
    mobileMenu.setAttribute('aria-hidden', String(!open));
    document.body.style.overflow = open ? 'hidden' : '';
  }

  burger.addEventListener('click', function () {
    setMenu(burger.getAttribute('aria-expanded') !== 'true');
  });

  $$('[data-navclose]').forEach(function (link) {
    link.addEventListener('click', function () { setMenu(false); });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && mobileMenu.classList.contains('open')) setMenu(false);
  });

  /* ---------- Scrollspy ---------- */
  var navIds = ['home', 'ueber-uns', 'kurse', 'schnupperstunde', 'warum-schach', 'kontakt'];
  var navLinks = $$('[data-navlink]');
  var spyTicking = false;

  function updateSpy() {
    spyTicking = false;
    var line = window.scrollY + 180;
    var current = navIds[0];
    for (var i = 0; i < navIds.length; i++) {
      var el = document.getElementById(navIds[i]);
      if (el && el.offsetTop <= line) current = navIds[i];
    }
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80) {
      current = 'kontakt';
    }
    navLinks.forEach(function (link) {
      link.classList.toggle('is-active', link.getAttribute('data-navlink') === current);
    });
  }

  window.addEventListener('scroll', function () {
    if (!spyTicking) { spyTicking = true; window.requestAnimationFrame(updateSpy); }
  }, { passive: true });
  updateSpy();

  /* ---------- Reveal beim Scrollen ---------- */
  var revealEls = $$('.reveal');
  if (reducedMotion || !('IntersectionObserver' in window)) {
    revealEls.forEach(function (el) { el.classList.add('in'); });
  } else {
    var revealIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          revealIO.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -36px 0px' });
    revealEls.forEach(function (el) { revealIO.observe(el); });
  }

  /* ---------- Zahlen zählen hoch ---------- */
  var yearsSince2004 = Math.max(1, new Date().getFullYear() - 2004);

  function targetValue(el) {
    if (el.hasAttribute('data-count-years')) return yearsSince2004;
    return parseInt(el.getAttribute('data-count'), 10) || 0;
  }

  function renderCount(el, value) {
    el.textContent = (el.getAttribute('data-prefix') || '') + value;
  }

  function animateCount(el) {
    var end = targetValue(el);
    if (reducedMotion) { renderCount(el, end); return; }
    var start = null;
    var duration = 1400;
    function tick(ts) {
      if (start === null) start = ts;
      var p = Math.min(1, (ts - start) / duration);
      var eased = 1 - Math.pow(1 - p, 3);
      renderCount(el, Math.round(end * eased));
      if (p < 1) window.requestAnimationFrame(tick);
    }
    window.requestAnimationFrame(tick);
  }

  var statsBand = $('#zahlen');
  if (statsBand) {
    var statEls = $$('.stat-num', statsBand);
    if (!('IntersectionObserver' in window)) {
      statEls.forEach(function (el) { renderCount(el, targetValue(el)); });
    } else {
      var statsIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            statEls.forEach(animateCount);
            statsIO.disconnect();
          }
        });
      }, { threshold: 0.4 });
      statsIO.observe(statsBand);
    }
  }

  /* ---------- Countdown zum Turnier ---------- */
  var TURNIER_DATUM = new Date('2026-06-20T09:00:00+02:00');
  var cdEls = {
    days: $('#cdDays'), hours: $('#cdHours'), mins: $('#cdMins'), secs: $('#cdSecs'),
    label: $('#countLabel'), past: $('#countPast')
  };

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function updateCountdown() {
    var diff = TURNIER_DATUM.getTime() - Date.now();
    if (diff <= 0) {
      cdEls.days.textContent = '0';
      cdEls.hours.textContent = '00';
      cdEls.mins.textContent = '00';
      cdEls.secs.textContent = '00';
      cdEls.label.textContent = '18. Turnier · 20. Juni 2026';
      cdEls.past.hidden = false;
      return false;
    }
    var secs = Math.floor(diff / 1000);
    cdEls.days.textContent = String(Math.floor(secs / 86400));
    cdEls.hours.textContent = pad2(Math.floor(secs / 3600) % 24);
    cdEls.mins.textContent = pad2(Math.floor(secs / 60) % 60);
    cdEls.secs.textContent = pad2(secs % 60);
    return true;
  }

  if (cdEls.days && updateCountdown()) {
    var cdTimer = window.setInterval(function () {
      if (!updateCountdown()) window.clearInterval(cdTimer);
    }, 1000);
  }

  /* ---------- Tabs der Spielecke ---------- */
  var tabs = [
    { tab: $('#tabTrainer'), panel: $('#panelTrainer') },
    { tab: $('#tabJagd'), panel: $('#panelJagd') }
  ];

  tabs.forEach(function (item, index) {
    if (!item.tab) return;
    item.tab.addEventListener('click', function () { selectTab(index); });
    item.tab.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        var next = (index + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
        selectTab(next);
        tabs[next].tab.focus();
      }
    });
  });

  function selectTab(index) {
    tabs.forEach(function (item, i) {
      item.tab.setAttribute('aria-selected', String(i === index));
      item.panel.hidden = i !== index;
    });
  }

  /* ---------- Figuren-Trainer (8×8) ---------- */
  var FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  var GLYPHS = { pawn: '♟', rook: '♜', knight: '♞', bishop: '♝', queen: '♛', king: '♚' };
  var HOMES = { pawn: [4, 1], rook: [0, 0], knight: [1, 0], bishop: [2, 0], queen: [3, 0], king: [4, 0] };
  var DESCRIPTIONS = {
    pawn: 'Der Bauer zieht immer nur vorwärts – vom Start aus sogar zwei Felder. Erreicht er die andere Seite, wird er zur Dame!',
    rook: 'Der Turm zieht gerade: nach vorne, hinten, links und rechts – so weit er möchte.',
    knight: 'Der Springer zieht im L und darf als einzige Figur über andere hinwegspringen.',
    bishop: 'Der Läufer saust schräg über das Brett – immer auf seiner Farbe.',
    queen: 'Die Dame ist die stärkste Figur: Sie zieht gerade und schräg, so weit sie will.',
    king: 'Der König ist die wichtigste Figur – er zieht bedächtig ein Feld in jede Richtung.'
  };

  var trainerBoard = $('#trainerBoard');
  var trainerDesc = $('#trainerDesc');
  var pieceButtons = $$('.pp-btn');
  var trainer = { type: 'knight', f: HOMES.knight[0], r: HOMES.knight[1] };

  function trainerMoves() {
    var moves = [];
    var f = trainer.f, r = trainer.r, type = trainer.type;
    function add(tf, tr) {
      if (tf >= 0 && tf < 8 && tr >= 0 && tr < 8 && !(tf === f && tr === r)) moves.push([tf, tr]);
    }
    if (type === 'pawn') {
      add(f, r + 1);
      if (r === 1) add(f, r + 2);
    } else if (type === 'knight') {
      [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]].forEach(function (d) {
        add(f + d[0], r + d[1]);
      });
    } else if (type === 'king') {
      for (var df = -1; df <= 1; df++) for (var dr = -1; dr <= 1; dr++) add(f + df, r + dr);
    } else {
      var dirs = [];
      if (type === 'rook' || type === 'queen') dirs = dirs.concat([[1, 0], [-1, 0], [0, 1], [0, -1]]);
      if (type === 'bishop' || type === 'queen') dirs = dirs.concat([[1, 1], [1, -1], [-1, 1], [-1, -1]]);
      dirs.forEach(function (d) {
        for (var i = 1; i < 8; i++) add(f + d[0] * i, r + d[1] * i);
      });
    }
    return moves;
  }

  function squareName(f, r) { return FILES[f] + (r + 1); }

  function renderTrainer(withPop) {
    if (!trainerBoard) return;
    var legal = {};
    trainerMoves().forEach(function (m) { legal[m[0] + ',' + m[1]] = true; });
    trainerBoard.innerHTML = '';
    for (var r = 7; r >= 0; r--) {
      for (var f = 0; f < 8; f++) {
        var isLegal = legal[f + ',' + r];
        var cell = document.createElement(isLegal ? 'button' : 'div');
        cell.className = 'sq ' + (((f + r) % 2 === 0) ? 'dark' : 'light');
        if (isLegal) {
          cell.type = 'button';
          cell.classList.add('legal');
          cell.setAttribute('aria-label', 'Ziehe nach ' + squareName(f, r));
          cell.dataset.f = String(f);
          cell.dataset.r = String(r);
        }
        if (f === trainer.f && r === trainer.r) {
          var pc = document.createElement('span');
          pc.className = 'pc';
          pc.textContent = GLYPHS[trainer.type];
          if (!withPop) pc.style.animation = 'none';
          cell.appendChild(pc);
        }
        trainerBoard.appendChild(cell);
      }
    }
  }

  if (trainerBoard) {
    trainerBoard.addEventListener('click', function (e) {
      var cell = e.target.closest('.sq.legal');
      if (!cell) return;
      trainer.f = parseInt(cell.dataset.f, 10);
      trainer.r = parseInt(cell.dataset.r, 10);
      if (trainer.type === 'pawn' && trainer.r === 7) {
        trainer.type = 'queen';
        trainerDesc.textContent = 'Umwandlung auf ' + squareName(trainer.f, trainer.r) + '! Aus dem Bauern ist eine Dame geworden – die stärkste Figur im Spiel.';
        syncPieceButtons('queen');
      }
      renderTrainer(true);
    });

    pieceButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var type = btn.getAttribute('data-piece');
        trainer.type = type;
        trainer.f = HOMES[type][0];
        trainer.r = HOMES[type][1];
        trainerDesc.textContent = DESCRIPTIONS[type];
        syncPieceButtons(type);
        renderTrainer(true);
      });
    });

    renderTrainer(false);
  }

  function syncPieceButtons(type) {
    pieceButtons.forEach(function (btn) {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-piece') === type));
    });
  }

  /* ---------- Springer-Jagd (5×5) ---------- */
  var gameBoard = $('#gameBoard');
  var moveCountEl = $('#moveCount');
  var starCountEl = $('#starCount');
  var gameMsgEl = $('#gameMsg');
  var winOverlay = $('#winOverlay');
  var winText = $('#winText');
  var recordPill = $('#recordPill');
  var recordCountEl = $('#recordCount');
  var boardWrap = gameBoard ? gameBoard.closest('.board-wrap') : null;
  var RECORD_KEY = 'sfk-springer-rekord';
  var STAR_MESSAGES = ['Stern geschnappt – super Zug!', 'Klasse! Weiter geht die Jagd!', 'Wow, du springst wie ein Profi!'];

  var game = { knight: [0, 0], stars: [], moves: 0, collected: 0 };

  function readRecord() {
    try {
      var value = parseInt(window.localStorage.getItem(RECORD_KEY), 10);
      return isNaN(value) ? null : value;
    } catch (err) { return null; }
  }

  function writeRecord(value) {
    try { window.localStorage.setItem(RECORD_KEY, String(value)); } catch (err) { /* Vorschau ohne Speicher */ }
  }

  function showRecord() {
    var record = readRecord();
    if (record !== null && recordPill) {
      recordPill.hidden = false;
      recordCountEl.textContent = record + ' Züge';
    }
  }

  function knightMoves5(f, r) {
    var moves = [];
    [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]].forEach(function (d) {
      var tf = f + d[0], tr = r + d[1];
      if (tf >= 0 && tf < 5 && tr >= 0 && tr < 5) moves.push([tf, tr]);
    });
    return moves;
  }

  function resetGame() {
    game.knight = [0, 0];
    game.moves = 0;
    game.collected = 0;
    game.stars = [];
    while (game.stars.length < 3) {
      var f = Math.floor(Math.random() * 5);
      var r = Math.floor(Math.random() * 5);
      var taken = (f === 0 && r === 0) || game.stars.some(function (s) { return s[0] === f && s[1] === r; });
      if (!taken) game.stars.push([f, r]);
    }
    if (winOverlay) winOverlay.hidden = true;
    if (gameMsgEl) gameMsgEl.textContent = 'Auf die Felder, fertig, los!';
    updateHud();
    renderGame(false);
  }

  function updateHud() {
    if (moveCountEl) moveCountEl.textContent = String(game.moves);
    if (starCountEl) starCountEl.textContent = game.collected + '/3';
  }

  function renderGame(withPop) {
    if (!gameBoard) return;
    var legal = {};
    knightMoves5(game.knight[0], game.knight[1]).forEach(function (m) { legal[m[0] + ',' + m[1]] = true; });
    gameBoard.innerHTML = '';
    for (var r = 4; r >= 0; r--) {
      for (var f = 0; f < 5; f++) {
        var isLegal = legal[f + ',' + r] && game.collected < 3;
        var cell = document.createElement(isLegal ? 'button' : 'div');
        cell.className = 'sq ' + (((f + r) % 2 === 0) ? 'dark' : 'light');
        if (isLegal) {
          cell.type = 'button';
          cell.classList.add('legal');
          cell.setAttribute('aria-label', 'Springe auf Feld ' + FILES[f] + (r + 1));
          cell.dataset.f = String(f);
          cell.dataset.r = String(r);
        }
        var hasStar = game.stars.some(function (s) { return s[0] === f && s[1] === r; });
        if (hasStar) {
          var star = document.createElement('span');
          star.className = 'star';
          star.textContent = '⭐';
          cell.appendChild(star);
        }
        if (f === game.knight[0] && r === game.knight[1]) {
          var pc = document.createElement('span');
          pc.className = 'pc';
          pc.textContent = '♞';
          if (!withPop) pc.style.animation = 'none';
          cell.appendChild(pc);
        }
        gameBoard.appendChild(cell);
      }
    }
  }

  function launchConfetti() {
    if (reducedMotion || !boardWrap) return;
    var colors = ['#D0342C', '#E8A821', '#B58863', '#241E19', '#F0D9B5'];
    for (var i = 0; i < 30; i++) {
      var piece = document.createElement('span');
      piece.className = 'confetto';
      piece.style.left = (Math.random() * 96 + 2) + '%';
      piece.style.background = colors[i % colors.length];
      piece.style.animationDuration = (1.1 + Math.random()) + 's';
      piece.style.animationDelay = (Math.random() * 0.35) + 's';
      boardWrap.appendChild(piece);
    }
    window.setTimeout(function () {
      $$('.confetto', boardWrap).forEach(function (el) { el.remove(); });
    }, 2600);
  }

  function winGame() {
    var record = readRecord();
    var isRecord = record === null || game.moves < record;
    if (isRecord) writeRecord(game.moves);
    showRecord();
    if (winText) {
      winText.textContent = 'Alle Sterne in ' + game.moves + ' Zügen gesammelt' + (isRecord ? ' – neuer Rekord!' : '!');
    }
    if (winOverlay) winOverlay.hidden = false;
    launchConfetti();
  }

  if (gameBoard) {
    gameBoard.addEventListener('click', function (e) {
      var cell = e.target.closest('.sq.legal');
      if (!cell) return;
      var f = parseInt(cell.dataset.f, 10);
      var r = parseInt(cell.dataset.r, 10);
      game.knight = [f, r];
      game.moves += 1;
      var starIndex = -1;
      game.stars.forEach(function (s, i) { if (s[0] === f && s[1] === r) starIndex = i; });
      if (starIndex > -1) {
        game.stars.splice(starIndex, 1);
        game.collected += 1;
        if (gameMsgEl) gameMsgEl.textContent = STAR_MESSAGES[Math.min(game.collected - 1, STAR_MESSAGES.length - 1)];
      }
      updateHud();
      renderGame(true);
      if (game.collected === 3) winGame();
    });

    $('#gameReset').addEventListener('click', resetGame);
    $('#winRestart').addEventListener('click', resetGame);
    showRecord();
    resetGame();
  }

  /* ---------- Mehr-lesen-Umschalter ---------- */
  function setupToggle(buttonId, onToggle) {
    var btn = $(buttonId);
    if (!btn) return;
    btn.addEventListener('click', function () {
      var open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', String(open));
      btn.innerHTML = (open ? 'Weniger lesen' : 'Mehr lesen') + ' <span class="chev" aria-hidden="true">▾</span>';
      onToggle(open);
    });
  }

  setupToggle('#zieleToggle', function (open) {
    $('#zieleText').classList.toggle('clamped', !open);
  });

  setupToggle('#warumToggle', function (open) {
    $('#warumMore').hidden = !open;
  });

  /* ---------- Lightbox ---------- */
  var lightbox = $('#lightbox');
  var lightboxImg = $('#lightboxImg');
  var lightboxCap = $('#lightboxCap');
  var lightboxClose = $('#lightboxClose');
  var lightboxTrigger = null;

  function openLightbox(trigger) {
    var img = $('img', trigger);
    if (!img) return;
    lightboxTrigger = trigger;
    lightboxImg.src = img.src;
    lightboxImg.alt = img.alt;
    lightboxCap.textContent = trigger.getAttribute('data-caption') || '';
    lightbox.hidden = false;
    window.requestAnimationFrame(function () { lightbox.classList.add('open'); });
    document.body.style.overflow = 'hidden';
    lightboxClose.focus();
  }

  function closeLightbox() {
    lightbox.classList.remove('open');
    document.body.style.overflow = '';
    window.setTimeout(function () { lightbox.hidden = true; }, 300);
    if (lightboxTrigger) { lightboxTrigger.focus(); lightboxTrigger = null; }
  }

  $$('[data-lightbox]').forEach(function (trigger) {
    trigger.addEventListener('click', function () { openLightbox(trigger); });
  });

  if (lightbox) {
    lightboxClose.addEventListener('click', closeLightbox);
    lightbox.addEventListener('click', function (e) {
      if (e.target === lightbox) closeLightbox();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !lightbox.hidden) closeLightbox();
    });
  }

  /* ---------- Kontaktformular (Demo) ---------- */
  var form = $('#contactForm');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = $('#fName').value.trim();
      var mail = $('#fMail').value.trim();
      var msg = $('#fMsg').value.trim();
      var mailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(mail);
      var error = $('#formError');
      if (!name || !mailOk || !msg) {
        error.hidden = false;
        (!name ? $('#fName') : !mailOk ? $('#fMail') : $('#fMsg')).focus();
        return;
      }
      error.hidden = true;
      form.hidden = true;
      $('#successName').textContent = ', ' + name.split(' ')[0];
      $('#formSuccess').hidden = false;
    });
  }

  /* ---------- Fußzeile: Jahr ---------- */
  var footYear = $('#footYear');
  if (footYear) footYear.textContent = String(new Date().getFullYear());
})();
