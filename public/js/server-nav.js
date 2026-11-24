(function () {
  'use strict';

  var initialShell = document.querySelector('.server-shell');
  if (!initialShell) return;

  var CONSOLE_RE = /^\/server\/[^/]+$/;
  var SECTION_RE = /^\/server\/[^/]+\/(files|databases|backups|network|schedules|startup|settings|users)$/;
  var EDITOR_RE = /^\/server\/[^/]+\/files\/edit$/;

  function isSection(pathname) {
    return CONSOLE_RE.test(pathname) || SECTION_RE.test(pathname) || EDITOR_RE.test(pathname);
  }

  function keyOf(url) {
    return url.pathname + url.search;
  }

  var sections = {};
  var current = null;
  var loading = false;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var vtEnabled = !reduceMotion && typeof document.startViewTransition === 'function';

  function runTransition(update) {
    if (!vtEnabled) {
      update();
      return;
    }
    document.startViewTransition(function () { update(); });
  }

  function register(pathname, el, key) {
    sections[pathname] = { el: el, key: key };
    el.classList.add('server-shell');
  }

  function activeIndex(tabs) {
    var items = tabs.querySelectorAll('.tab');
    for (var i = 0; i < items.length; i++) {
      if (items[i].classList.contains('active')) return i;
    }
    return -1;
  }

  function ensureUnderline(tabs) {
    var u = tabs.querySelector('.tab-underline');
    if (!u) {
      u = document.createElement('span');
      u.className = 'tab-underline';
      tabs.appendChild(u);
    }
    tabs.classList.add('has-underline');
    return u;
  }

  function placeUnderline(tabs, index) {
    if (!tabs || index < 0) return;
    var tab = tabs.querySelectorAll('.tab')[index];
    if (!tab) return;
    var u = ensureUnderline(tabs);
    u.style.transition = 'none';
    u.style.width = tab.offsetWidth + 'px';
    u.style.transform = 'translateX(' + tab.offsetLeft + 'px)';
    void u.offsetWidth;
    u.style.transition = '';
  }

  function refreshUnderline(shell) {
    var tabs = shell.querySelector('.tabs');
    if (!tabs) return;
    placeUnderline(tabs, activeIndex(tabs));
  }

  function show(pathname) {
    var target = sections[pathname];
    if (!target) return;
    Object.keys(sections).forEach(function (p) {
      sections[p].el.classList.add('is-hidden');
    });
    target.el.classList.remove('is-hidden');
    current = pathname;
    refreshUnderline(target.el);
    window.scrollTo(0, 0);
  }

  function removeExisting(pathname) {
    var existing = sections[pathname];
    if (!existing) return;
    if (existing.el.parentNode) existing.el.parentNode.removeChild(existing.el);
    delete sections[pathname];
  }

  function runScripts(shell) {
    var scripts = [];
    Array.prototype.forEach.call(shell.querySelectorAll('script'), function (s) {
      scripts.push(s);
    });
    scripts.forEach(function (s) { s.parentNode.removeChild(s); });
    scripts.forEach(function (s) {
      var copy = document.createElement('script');
      Array.prototype.forEach.call(s.attributes, function (a) {
        copy.setAttribute(a.name, a.value);
      });
      copy.textContent = s.textContent;
      document.body.appendChild(copy);
    });
  }

  function load(url, push) {
    if (loading) return;
    loading = true;
    var pathname = url.pathname;
    var key = keyOf(url);

    fetch(key, { credentials: 'same-origin', cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('status ' + res.status);
        return res.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var nextShell = doc.querySelector('.server-shell');
        if (!nextShell) throw new Error('no server shell');
        var imported = document.importNode(nextShell, true);
        imported.classList.add('is-hidden');
        runTransition(function () {
          removeExisting(pathname);
          document.body.appendChild(imported);
          runScripts(imported);
          register(pathname, imported, key);
          show(pathname);
          if (push) history.pushState({ serverNav: true }, '', key);
        });
      })
      .catch(function () {
        window.location.href = key;
      })
      .finally(function () {
        loading = false;
      });
  }

  function navigate(url, push) {
    if (!isSection(url.pathname)) return;
    var key = keyOf(url);
    if (key === location.pathname + location.search && current === url.pathname) return;
    var existing = sections[url.pathname];
    if (existing && existing.key === key) {
      runTransition(function () { show(url.pathname); });
      if (push) history.pushState({ serverNav: true }, '', key);
      return;
    }
    load(url, push);
  }

  register(location.pathname, initialShell, keyOf(location));
  current = location.pathname;
  refreshUnderline(initialShell);

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (current && sections[current]) refreshUnderline(sections[current].el);
    }, 120);
  });

  if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
    document.fonts.ready.then(function () {
      if (current && sections[current]) refreshUnderline(sections[current].el);
    });
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
    if (!isSection(url.pathname)) return;
    e.preventDefault();
    navigate(url, true);
  });

  window.pyloxSectionNavigate = function (target) {
    var url = target instanceof URL ? target : new URL(target, window.location.origin);
    navigate(url, true);
  };

  window.addEventListener('popstate', function () {
    var url = new URL(location.href);
    var existing = sections[url.pathname];
    if (existing && existing.key === keyOf(url)) {
      runTransition(function () { show(url.pathname); });
      return;
    }
    if (isSection(url.pathname)) load(url, false);
    else window.location.reload();
  });
})();
