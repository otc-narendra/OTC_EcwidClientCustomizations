(function () {
  'use strict';

  // ─── CONFIG ────────────────────────────────────────────────────────────────
  // Set backendUrl to your inventory endpoint when the backend is ready.
  // While null, STUB_DATA below is used instead.
  var CONFIG = {
    backendUrl: null,
    labelInStock:   '({n} left)',
    labelSoldOut:   '(sold out)',
    masterSuffix:   '(total {n} available)',
  };

  // ─── STUB DATA ─────────────────────────────────────────────────────────────
  // Replace with real product/variation data to test locally.
  // Shape must match the backend contract:
  //   { masterRemaining: number,
  //     variations: [{ options: { [name]: value, ... }, remaining: number }] }
  var STUB_DATA = {
    masterRemaining: 10,
    variations: [
      { options: { 'Type of ticket': 'Child 12 or under' }, remaining: 0 },
      { options: { 'Type of ticket': 'Adult (no bubbles)' }, remaining: 6 },
      { options: { 'Type of ticket': 'Adult (with bubbles!)' }, remaining: 4 },
    ],
  };

  // ─── STATE ─────────────────────────────────────────────────────────────────
  var state = {
    productId:     null,
    inventoryData: null,
    currentOptions: {},
    observer:      null,
  };

  // ─── FETCH INVENTORY ───────────────────────────────────────────────────────
  // Returns Promise<InventoryData>.
  // TO WIRE REAL BACKEND: set CONFIG.backendUrl above — no other changes needed.
  function fetchInventory(storeId, productId) {
    if (!CONFIG.backendUrl) {
      return Promise.resolve(STUB_DATA);
    }
    var url = CONFIG.backendUrl
      + '/inventory?storeId=' + storeId
      + '&productId=' + productId;
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  // ─── HELPERS ───────────────────────────────────────────────────────────────
  function computeEffective(varRemaining, masterRemaining) {
    return Math.min(varRemaining, masterRemaining);
  }

  function formatOptionLabel(n) {
    if (n <= 0) return CONFIG.labelSoldOut;
    return CONFIG.labelInStock.replace('{n}', n);
  }

  // Find variations that match a single option name+value (for labelling each
  // choice before all options have been selected).
  function matchVariationsByValue(variations, optionName, optionValue) {
    return variations.filter(function (v) { return v.options[optionName] === optionValue; });
  }

  // Lowest remaining across all variations that share this option value.
  function worstRemainingForValue(variations, optionName, optionValue, masterRemaining) {
    var matches = matchVariationsByValue(variations, optionName, optionValue);
    if (!matches.length) return null;
    var worst = matches.reduce(function (min, v) {
      return Math.min(min, computeEffective(v.remaining, masterRemaining));
    }, Infinity);
    return worst === Infinity ? null : worst;
  }

  function isOurNode(n) {
    return n.nodeType === Node.ELEMENT_NODE
      && (n.hasAttribute('data-otc-label') || n.hasAttribute('data-otc-master'));
  }

  function debounce(fn, ms) {
    var t;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  // ─── DOM SELECTORS ─────────────────────────────────────────────────────────
  // Ecwid does not document its CSS classes. Verify / update these selectors
  // by opening a product page in browser DevTools after deploying.
  var SEL = {
    productWidget: '.ec-store',
    // Each individual radio choice div (contains both the input and the label):
    radioItem:     '.form-control--radio',
    // The radio input — carries option name and value as attributes:
    radioInput:    '.form-control__radio',
    // The visible label element inside each choice:
    labelEl:       '.form-control__inline-label label',
    // "In stock: X available" heading confirmed via DevTools:
    stockMessage:  '.details-product-purchase__place span',
  };

  // ─── FEATURE 1: OPTION LABEL ANNOTATION ───────────────────────────────────
  // Reads option name and value directly from input[name] and input[value] —
  // no label text scraping needed.
  function applyOptionLabels(inventoryData) {
    if (!inventoryData) return;

    var scope = document.querySelector(SEL.productWidget) || document;
    var items = scope.querySelectorAll(SEL.radioItem);
    if (!items.length) return;

    items.forEach(function (item) {
      var input = item.querySelector(SEL.radioInput);
      if (!input) return;

      var optionName  = input.name;
      var optionValue = input.value;
      var label = item.querySelector(SEL.labelEl);
      if (!label) return;

      var old = label.querySelector('[data-otc-label]');
      if (old) old.parentNode.removeChild(old);

      var n = worstRemainingForValue(inventoryData.variations, optionName, optionValue, inventoryData.masterRemaining);
      if (n === null) return;

      var span = document.createElement('span');
      span.setAttribute('data-otc-label', '');
      span.style.cssText = 'font-size:0.85em;opacity:0.7;margin-left:4px;white-space:nowrap;';
      span.textContent = formatOptionLabel(n);
      label.appendChild(span);
    });
  }

  // ─── FEATURE 2: STOCK MESSAGE AUGMENTATION ────────────────────────────────
  // Appends "(total N available)" to Ecwid's "In stock: xx available" message
  // after the customer selects a variation.
  function augmentStockMessage(inventoryData) {
    document.querySelectorAll('[data-otc-master]').forEach(function (el) {
      el.parentNode.removeChild(el);
    });
    if (!inventoryData) return;

    var stockEl = findStockMessageElement();
    if (!stockEl) return;

    var suffix = document.createElement('span');
    suffix.setAttribute('data-otc-master', '');
    suffix.style.cssText = 'margin-left:6px;font-size:0.9em;opacity:0.75;';
    suffix.textContent = CONFIG.masterSuffix.replace('{n}', inventoryData.masterRemaining);
    stockEl.appendChild(suffix);
  }

  function findStockMessageElement() {
    return document.querySelector(SEL.stockMessage);
  }

  // ─── MUTATION OBSERVER ─────────────────────────────────────────────────────
  // Watches the product widget for Ecwid re-renders so labels stay current.
  // Mutations caused by our own injections are filtered out to prevent loops.
  function startObserver() {
    if (state.observer) state.observer.disconnect();

    var container = document.querySelector(SEL.productWidget) || document.body;
    var debouncedApply = debounce(function () {
      if (state.inventoryData) applyOptionLabels(state.inventoryData);
    }, 150);

    state.observer = new MutationObserver(function (mutations) {
      var external = mutations.some(function (m) {
        return Array.from(m.addedNodes).some(function (n) { return !isOurNode(n); })
            || Array.from(m.removedNodes).some(function (n) { return !isOurNode(n); });
      });
      if (external) debouncedApply();
    });

    state.observer.observe(container, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
  }

  // ─── EVENT HOOKS ───────────────────────────────────────────────────────────
  Ecwid.OnAPILoaded.add(function () {

    Ecwid.OnPageLoaded.add(function (page) {
      if (page.type !== 'PRODUCT') {
        stopObserver();
        state.inventoryData = null;
        state.productId = null;
        state.currentOptions = {};
        return;
      }

      state.productId = page.productId;
      state.currentOptions = {};

      fetchInventory(Ecwid.getOwnerId(), page.productId)
        .then(function (data) {
          state.inventoryData = data;
          applyOptionLabels(data);
          startObserver();
        })
        .catch(function (err) {
          console.warn('[OTC] Inventory fetch failed for product ' + page.productId + ':', err);
        });
    });

    // Fires when the customer changes a variation selection.
    // Updates the "In stock" suffix with the master remaining count.
    Ecwid.OnProductSelectedOptionsChanged.add(function (payload) {
      state.currentOptions = payload.newOptions || {};
      augmentStockMessage(state.inventoryData);
    });

    // Re-apply option labels whenever the cart changes so counts stay accurate
    // (e.g. after a customer removes items from the bag).
    Ecwid.OnCartChanged.add(function () {
      if (state.productId && state.inventoryData) {
        applyOptionLabels(state.inventoryData);
      }
    });

  });

})();
