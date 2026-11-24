(function () {
  'use strict';

  if (!window.HTMLSelectElement) return;

  var seq = 0;
  var openInstance = null;

  var CHEVRON =
    '<svg class="cselect-chevron" width="15" height="15" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="6 9 12 15 18 9"></polyline></svg>';

  function cleanText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function optionText(option) {
    if (!option) return '';
    return cleanText(option.label != null ? option.label : option.textContent);
  }

  function readableName(select) {
    var explicit = select.getAttribute('aria-label');
    if (explicit) return explicit;

    var labels = select.labels ? Array.prototype.slice.call(select.labels) : [];
    for (var i = 0; i < labels.length; i++) {
      var clone = labels[i].cloneNode(true);
      var inner = clone.querySelector('select');
      if (inner && inner.parentNode) inner.parentNode.removeChild(inner);
      var text = cleanText(clone.textContent);
      if (text) return text;
    }

    var name = select.getAttribute('name') || '';
    if (!name) return 'Select';
    return name.replace(/[_-]+/g, ' ').replace(/\b[a-z]/g, function (ch) {
      return ch.toUpperCase();
    });
  }

  function isEnhanceable(select) {
    if (!(select instanceof HTMLSelectElement)) return false;
    if (select.dataset.cselectReady === '1') return false;
    if (select.multiple) return false;
    if (select.size > 1) return false;
    if (select.classList.contains('cselect-native')) return false;
    return true;
  }

  function enhance(select) {
    if (!isEnhanceable(select)) return null;

    var parent = select.parentNode;
    if (!parent) return null;

    select.dataset.cselectReady = '1';

    var wrapper = document.createElement('div');
    wrapper.className = 'cselect';
    if (select.classList.contains('select-inline')) wrapper.classList.add('is-inline');
    if (select.classList.contains('select-flex')) wrapper.classList.add('is-flex');
    if (select.classList.contains('select-sm')) wrapper.classList.add('is-sm');
    if (select.classList.contains('select-xs')) wrapper.classList.add('is-xs');
    if (select.classList.contains('docker-image-select')) wrapper.classList.add('is-capped');

    parent.insertBefore(wrapper, select);
    wrapper.appendChild(select);

    select.classList.add('cselect-native');
    select.setAttribute('tabindex', '-1');
    select.setAttribute('aria-hidden', 'true');

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'cselect-trigger';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', readableName(select));
    if (select.required) trigger.setAttribute('aria-required', 'true');

    var value = document.createElement('span');
    value.className = 'cselect-value';
    trigger.appendChild(value);
    trigger.insertAdjacentHTML('beforeend', CHEVRON);

    var menu = document.createElement('div');
    menu.className = 'cselect-menu';
    menu.id = 'cselect-menu-' + (++seq);
    menu.setAttribute('role', 'listbox');
    trigger.setAttribute('aria-controls', menu.id);
    document.body.appendChild(menu);

    wrapper.appendChild(trigger);

    var state = {
      select: select,
      wrapper: wrapper,
      trigger: trigger,
      value: value,
      menu: menu,
      records: [],
      active: -1,
      open: false,
      destroyed: false,
      typeBuffer: '',
      typeTimer: null
    };

    var domObserver = new MutationObserver(function () {
      sync();
    });

    function textForValue() {
      var option = select.options[select.selectedIndex];
      if (!option) return select.getAttribute('data-placeholder') || '\u2014';
      return optionText(option) || select.getAttribute('data-placeholder') || '\u2014';
    }

    function addRecord(option, groupDisabled) {
      var index = Array.prototype.indexOf.call(select.options, option);
      if (index < 0) return;

      var disabled = !!(option.disabled || groupDisabled);
      var row = document.createElement('div');
      row.className = 'cselect-option';
      row.id = menu.id + '-opt-' + index;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', option.selected ? 'true' : 'false');
      if (option.selected) row.classList.add('is-selected');
      if (disabled) {
        row.classList.add('is-disabled');
        row.setAttribute('aria-disabled', 'true');
      }

      var label = document.createElement('span');
      label.className = 'cselect-option-label';
      label.textContent = optionText(option) || '\u00a0';
      row.appendChild(label);

      var record = { el: row, option: option, index: index, disabled: disabled };
      row.addEventListener('mouseenter', function () {
        if (!record.disabled) setActive(state.records.indexOf(record));
      });
      row.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (!record.disabled) choose(record);
      });

      state.records.push(record);
      menu.appendChild(row);
    }

    function rebuild() {
      menu.textContent = '';
      state.records = [];
      state.active = -1;

      var children = select.children;
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (child.tagName === 'OPTGROUP') {
          if (child.label) {
            var group = document.createElement('div');
            group.className = 'cselect-group';
            group.textContent = child.label;
            menu.appendChild(group);
          }
          for (var j = 0; j < child.children.length; j++) {
            if (child.children[j].tagName === 'OPTION') {
              addRecord(child.children[j], child.disabled);
            }
          }
        } else if (child.tagName === 'OPTION') {
          addRecord(child, false);
        }
      }

      if (!state.records.length) {
        var empty = document.createElement('div');
        empty.className = 'cselect-empty';
        empty.textContent = '\u2014';
        menu.appendChild(empty);
      }

      value.textContent = textForValue();
      trigger.disabled = !!select.disabled;
      wrapper.classList.toggle('is-disabled', !!select.disabled);
      trigger.setAttribute('aria-disabled', select.disabled ? 'true' : 'false');

      if (state.open) {
        var selected = selectedRecordIndex();
        setActive(selected >= 0 ? selected : firstEnabled());
      }
    }

    function selectedRecordIndex() {
      for (var i = 0; i < state.records.length; i++) {
        if (state.records[i].option.selected) return i;
      }
      return -1;
    }

    function firstEnabled() {
      for (var i = 0; i < state.records.length; i++) {
        if (!state.records[i].disabled) return i;
      }
      return -1;
    }

    function lastEnabled() {
      for (var i = state.records.length - 1; i >= 0; i--) {
        if (!state.records[i].disabled) return i;
      }
      return -1;
    }

    function setActive(index) {
      if (index < 0 || index >= state.records.length) return;
      var previous = state.records[state.active];
      if (previous) previous.el.classList.remove('is-active');
      state.active = index;
      var record = state.records[index];
      record.el.classList.add('is-active');
      if (state.open) trigger.setAttribute('aria-activedescendant', record.el.id);
      if (record.el.scrollIntoView) {
        record.el.scrollIntoView({ block: 'nearest' });
      }
    }

    function move(step) {
      var total = state.records.length;
      if (!total) return;
      var start = state.active >= 0 ? state.active : (step > 0 ? -1 : 0);
      for (var n = 1; n <= total; n++) {
        var index = ((start + step * n) % total + total) % total;
        if (!state.records[index].disabled) {
          setActive(index);
          return;
        }
      }
    }

    function close(focus) {
      if (!state.open) return;
      state.open = false;
      if (state.typeTimer) {
        clearTimeout(state.typeTimer);
        state.typeTimer = null;
        state.typeBuffer = '';
      }
      if (openInstance === state) openInstance = null;
      menu.classList.remove('is-open');
      wrapper.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-activedescendant');
      document.removeEventListener('pointerdown', onDocumentPointerDown, true);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
      if (state.active >= 0 && state.records[state.active]) {
        state.records[state.active].el.classList.remove('is-active');
      }
      state.active = -1;
      if (focus) trigger.focus();
    }

    function positionMenu() {
      var margin = 10;
      var gap = 6;
      var rect = trigger.getBoundingClientRect();
      var viewportW = document.documentElement.clientWidth || window.innerWidth;
      var viewportH = window.innerHeight;

      menu.style.maxHeight = 'none';
      menu.style.width = 'auto';

      var contentWidth = menu.scrollWidth;
      var contentHeight = menu.scrollHeight + 2;
      var maxWidth = Math.max(rect.width, Math.min(viewportW - margin * 2, 460));
      var width = Math.min(Math.max(rect.width, contentWidth), maxWidth);
      var left = Math.min(Math.max(margin, rect.left), viewportW - margin - width);

      var below = viewportH - rect.bottom - gap - margin;
      var above = rect.top - gap - margin;
      var openUp = contentHeight > below && above > below;
      var available = Math.max(96, openUp ? above : below);
      var height = Math.min(contentHeight, 320, available);

      menu.style.width = Math.round(width) + 'px';
      menu.style.left = Math.round(left) + 'px';
      menu.style.maxHeight = Math.round(height) + 'px';
      menu.style.top = Math.round(openUp ? rect.top - gap - height : rect.bottom + gap) + 'px';
      menu.classList.toggle('is-up', openUp);
    }

    function onViewportChange(event) {
      if (event && event.type === 'scroll' && menu.contains(event.target)) return;
      close();
    }

    function onDocumentPointerDown(event) {
      if (wrapper.contains(event.target) || menu.contains(event.target)) return;
      close();
    }

    function choose(record) {
      if (!record || record.disabled) return;
      var changed = select.selectedIndex !== record.index;
      if (changed) {
        select.selectedIndex = record.index;
      }
      sync();
      trigger.classList.remove('is-invalid');
      close(true);
      if (changed) {
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    function open() {
      if (select.disabled || state.destroyed) return;
      if (state.open) return;
      if (openInstance && openInstance !== state) openInstance.close();

      sync();

      state.open = true;
      openInstance = state;
      wrapper.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      menu.classList.add('is-open');
      positionMenu();

      var selected = selectedRecordIndex();
      setActive(selected >= 0 ? selected : firstEnabled());

      document.addEventListener('pointerdown', onDocumentPointerDown, true);
      window.addEventListener('resize', onViewportChange);
      window.addEventListener('scroll', onViewportChange, true);
    }

    function typeahead(character) {
      if (state.typeTimer) clearTimeout(state.typeTimer);
      state.typeBuffer += character.toLowerCase();
      state.typeTimer = setTimeout(function () {
        state.typeBuffer = '';
        state.typeTimer = null;
      }, 650);

      var total = state.records.length;
      if (!total) return;
      var start = state.active >= 0 ? state.active : -1;
      for (var n = 1; n <= total; n++) {
        var index = (start + n) % total;
        var record = state.records[index];
        if (record.disabled) continue;
        if (optionText(record.option).toLowerCase().indexOf(state.typeBuffer) === 0) {
          setActive(index);
          return;
        }
      }
    }

    function onKeyDown(event) {
      var key = event.key;

      if (!state.open) {
        if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
          event.preventDefault();
          open();
          if (key === 'ArrowDown') move(1);
          else if (key === 'ArrowUp') move(-1);
          return;
        }
        if (key === 'Home' || key === 'End') {
          event.preventDefault();
          open();
          setActive(key === 'Home' ? firstEnabled() : lastEnabled());
          return;
        }
        if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          open();
          typeahead(key);
        }
        return;
      }

      if (key === 'Escape') {
        event.preventDefault();
        close(true);
      } else if (key === 'Tab') {
        close();
      } else if (key === 'ArrowDown') {
        event.preventDefault();
        move(1);
      } else if (key === 'ArrowUp') {
        event.preventDefault();
        move(-1);
      } else if (key === 'Home') {
        event.preventDefault();
        setActive(firstEnabled());
      } else if (key === 'End') {
        event.preventDefault();
        setActive(lastEnabled());
      } else if (key === 'PageDown') {
        event.preventDefault();
        move(5);
      } else if (key === 'PageUp') {
        event.preventDefault();
        move(-5);
      } else if (key === 'Enter' || key === ' ') {
        event.preventDefault();
        if (state.active >= 0) choose(state.records[state.active]);
      } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        typeahead(key);
      }
    }

    state.close = function (focus) {
      close(focus);
    };

    function sync() {
      if (state.destroyed) return;
      if (!select.isConnected) {
        destroy();
        return;
      }
      if (select.disabled && state.open) close();
      rebuild();
    }

    function invalid(event) {
      if (select.validity && select.validity.valid) return;
      event.preventDefault();
      trigger.classList.remove('is-invalid');
      void trigger.offsetWidth;
      trigger.classList.add('is-invalid');
      trigger.focus();
      if (select.validationMessage && typeof window.showToast === 'function') {
        window.showToast(select.validationMessage);
      }
      setTimeout(function () {
        trigger.classList.remove('is-invalid');
      }, 1800);
    }

    function destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      domObserver.disconnect();
      if (openInstance === state) close();
      if (state.typeTimer) clearTimeout(state.typeTimer);
      if (menu.parentNode) menu.parentNode.removeChild(menu);
      select.removeEventListener('change', sync);
      select.removeEventListener('invalid', invalid);

      delete select.value;
      delete select.selectedIndex;
      delete select.__cselect;

      if (wrapper.parentNode) {
        wrapper.parentNode.insertBefore(select, wrapper);
        wrapper.parentNode.removeChild(wrapper);
      }
      select.classList.remove('cselect-native');
      select.removeAttribute('tabindex');
      select.removeAttribute('aria-hidden');
      select.removeAttribute('data-cselect-ready');
    }

    trigger.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      if (state.open) close();
      else open();
    });
    trigger.addEventListener('keydown', onKeyDown);
    select.addEventListener('change', sync);
    select.addEventListener('invalid', invalid);
    domObserver.observe(select, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'required', 'label', 'value', 'selected']
    });

    // Mirror programmatic value changes back into the custom UI.
    try {
      var valueDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
      if (valueDescriptor && valueDescriptor.get && valueDescriptor.set) {
        Object.defineProperty(select, 'value', {
          configurable: true,
          enumerable: false,
          get: function () { return valueDescriptor.get.call(select); },
          set: function (next) {
            valueDescriptor.set.call(select, next);
            sync();
          }
        });
      }
      var indexDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
      if (indexDescriptor && indexDescriptor.get && indexDescriptor.set) {
        Object.defineProperty(select, 'selectedIndex', {
          configurable: true,
          enumerable: false,
          get: function () { return indexDescriptor.get.call(select); },
          set: function (next) {
            indexDescriptor.set.call(select, next);
            sync();
          }
        });
      }
    } catch (err) {
      /* Property overrides are a nicety, not a requirement. */
    }

    // Clicking an associated <label> should focus the visible control.
    var labels = select.labels ? Array.prototype.slice.call(select.labels) : [];
    labels.forEach(function (label) {
      label.addEventListener('click', function (event) {
        event.preventDefault();
        trigger.focus();
      });
    });

    var api = {
      el: select,
      close: close,
      sync: sync,
      destroy: destroy
    };
    select.__cselect = api;

    sync();
    return api;
  }

  function enhanceAll(root) {
    var scope = root || document;
    if (scope.nodeType === 1 && scope.matches && scope.matches('select')) {
      enhance(scope);
    }
    if (!scope.querySelectorAll) return;
    var selects = scope.querySelectorAll('select');
    for (var i = 0; i < selects.length; i++) enhance(selects[i]);
  }

  function destroyWithin(node) {
    if (!node || node.nodeType !== 1) return;

    // Only clean up when an enhanced wrapper leaves the document. A bare
    // <select> can be "removed" simply because it was moved into its wrapper
    // while being enhanced; destroying it then would start an endless loop.
    var wrappers = [];
    if (node.matches && node.matches('.cselect')) wrappers.push(node);
    if (node.querySelectorAll) {
      wrappers = wrappers.concat(Array.prototype.slice.call(node.querySelectorAll('.cselect')));
    }
    for (var i = 0; i < wrappers.length; i++) {
      var select = wrappers[i].querySelector('select');
      if (select && select.__cselect) select.__cselect.destroy();
    }
  }

  function onDocumentReset(event) {
    var form = event.target;
    if (!form || !form.querySelectorAll) return;
    setTimeout(function () {
      var selects = form.querySelectorAll('select');
      for (var i = 0; i < selects.length; i++) {
        if (selects[i].__cselect) selects[i].__cselect.sync();
      }
    }, 0);
  }

  function start() {
    enhanceAll(document);
    document.addEventListener('reset', onDocumentReset, true);

    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var mutation = mutations[i];
        for (var a = 0; a < mutation.addedNodes.length; a++) {
          enhanceAll(mutation.addedNodes[a]);
        }
        for (var r = 0; r < mutation.removedNodes.length; r++) {
          destroyWithin(mutation.removedNodes[r]);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  window.enhanceSelects = enhanceAll;
})();
