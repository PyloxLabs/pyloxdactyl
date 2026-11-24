(function () {
  'use strict';

  var DELAY = 150;
  var MIN_VISIBLE = 400;
  var DONE_HOLD = 180;
  var FADE = 260;
  var MAX = 90;

  var SILENT_RE = /\/api\/resources(\?|$)|\/dashboard\/stats(\?|$)/;
  var SPA_RE = [
    /^\/server\/[^/]+$/,
    /^\/server\/[^/]+\/(files|databases|backups|network|schedules|startup|settings|users)$/,
    /^\/server\/[^/]+\/files\/edit$/
  ];

  var el = null;
  var barEl = null;

  var pending = 0;
  var shown = false;
  var shownAt = 0;
  var progress = 0;

  var showTimer = null;
  var tickTimer = null;
  var hideTimer = null;
  var resetTimer = null;
  var safetyTimer = null;

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function now() {
    return window.performance && performance.now ? performance.now() : Date.now();
  }

  function ensureEl() {
    if (el) return el;
    if (!document.body) return null;
    el = document.createElement('div');
    el.className = 'px-loader';
    el.setAttribute('aria-hidden', 'true');
    barEl = document.createElement('div');
    barEl.className = 'px-loader-bar';
    el.appendChild(barEl);
    document.body.appendChild(el);
    return el;
  }

  function onReady(fn) {
    if (document.body) return fn();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { fn(); }, { once: true });
    } else {
      fn();
    }
  }

  function clearTimers() {
    clearTimeout(showTimer);
    clearTimeout(tickTimer);
    clearTimeout(hideTimer);
    clearTimeout(resetTimer);
    clearTimeout(safetyTimer);
    showTimer = tickTimer = hideTimer = resetTimer = safetyTimer = null;
  }

  function hideNow() {
    shown = false;
    progress = 0;
    if (el) el.classList.remove('is-visible');
    if (barEl) {
      barEl.style.transition = 'none';
      barEl.style.width = '0%';
      void barEl.offsetWidth;
      barEl.style.transition = '';
    }
  }

  function show() {
    showTimer = null;
    if (shown) return;
    onReady(function () {
      if (shown) return;
      if (!ensureEl()) return;
      shown = true;
      shownAt = now();
      progress = 8;
      el.classList.add('is-visible');
      barEl.style.transition = 'none';
      barEl.style.width = '0%';
      void barEl.offsetWidth;
      barEl.style.transition = '';
      if (reduce) {
        barEl.style.width = progress + '%';
        return;
      }
      requestAnimationFrame(function () {
        if (!shown) return;
        barEl.style.width = progress + '%';
      });
      trickle();
    });
  }

  function trickle() {
    clearTimeout(tickTimer);
    tickTimer = setTimeout(function () {
      if (!shown || progress >= MAX) return;
      var step = Math.max(0.5, (MAX - progress) * 0.12);
      progress = Math.min(MAX, progress + step);
      barEl.style.width = progress + '%';
      trickle();
    }, 220);
  }

  function finish() {
    hideTimer = null;
    if (!shown) return;
    clearTimeout(tickTimer);
    if (reduce) {
      hideNow();
      return;
    }
    shown = false;
    progress = 100;
    barEl.style.width = '100%';
    hideTimer = setTimeout(function () {
      if (el) el.classList.remove('is-visible');
      resetTimer = setTimeout(function () {
        if (shown) return;
        if (!barEl) return;
        barEl.style.transition = 'none';
        barEl.style.width = '0%';
        progress = 0;
        void barEl.offsetWidth;
        barEl.style.transition = '';
      }, FADE);
    }, DONE_HOLD);
  }

  function start(immediate) {
    pending++;
    clearTimeout(hideTimer);
    clearTimeout(resetTimer);
    clearTimeout(safetyTimer);
    hideTimer = resetTimer = safetyTimer = null;
    if (shown) return;
    if (immediate) {
      clearTimeout(showTimer);
      showTimer = null;
      show();
      return;
    }
    if (!showTimer) showTimer = setTimeout(show, DELAY);
  }

  function done() {
    pending = Math.max(0, pending - 1);
    if (pending > 0) return;
    clearTimeout(showTimer);
    showTimer = null;
    if (!shown) return;
    var elapsed = now() - shownAt;
    hideTimer = setTimeout(finish, Math.max(0, MIN_VISIBLE - elapsed));
  }

  function isSilent(input, init) {
    if (init && (init.pyloxSilent || init.pyloxLoader === false)) return true;
    try {
      var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
      return SILENT_RE.test(url);
    } catch (e) {
      return false;
    }
  }

  function isSpa(pathname) {
    if (!document.querySelector('.server-shell')) return false;
    for (var i = 0; i < SPA_RE.length; i++) {
      if (SPA_RE[i].test(pathname)) return true;
    }
    return false;
  }

  if (window.fetch) {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      if (isSilent(input, init)) return origFetch.apply(this, arguments);
      start();
      var p = origFetch.apply(this, arguments);
      if (p && typeof p.then === 'function') {
        return p.then(function (res) { done(); return res; }, function (err) { done(); throw err; });
      }
      done();
      return p;
    };
  }

  if (window.XMLHttpRequest) {
    var origOpen = window.XMLHttpRequest.prototype.open;
    var origSend = window.XMLHttpRequest.prototype.send;
    window.XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__pxUrl = url; } catch (e) {}
      return origOpen.apply(this, arguments);
    };
    window.XMLHttpRequest.prototype.send = function () {
      var silent = this.__pxUrl && SILENT_RE.test(this.__pxUrl);
      if (!silent) {
        start();
        this.addEventListener('loadend', function () { done(); }, { once: true });
      }
      return origSend.apply(this, arguments);
    };
  }

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var link = e.target.closest ? e.target.closest('a') : null;
    if (!link) return;
    if (link.target && link.target !== '' && link.target !== '_self') return;
    if (link.hasAttribute('download')) return;
    var href = link.getAttribute('href');
    if (!href || href.charAt(0) === '#') return;
    var url;
    try { url = new URL(link.href, location.href); } catch (err) { return; }
    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname && url.search === location.search) return;
    if (isSpa(url.pathname)) return;
    start(true);
    safetyTimer = setTimeout(function () { safetyTimer = null; done(); }, 8000);
  }, true);

  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    pending = 0;
    clearTimers();
    hideNow();
  });

  window.PyloxLoader = { start: start, done: done };

  start(true);
  window.addEventListener('load', function () { done(); });
})();
