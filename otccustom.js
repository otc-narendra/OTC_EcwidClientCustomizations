(function () {
  'use strict';

  // ─── CONFIG ────────────────────────────────────────────────────────────────
  // Set backendUrl to your inventory endpoint when the backend is ready. Until then
  // this script renders nothing, leaving the storefront exactly as Ecwid draws it.
  //
  // useStub is for local testing ONLY and must never be true in the deployed file:
  // the stub numbers are invented, and augmentStockMessage() prints masterRemaining
  // without checking that the data belongs to the product on screen — so a stub live
  // on the storefront tells customers a made-up figure on every product with options.
  //
  // Both display features are off, and for the same reason: otc-order-processor now syncs
  // every variation to the shared base quantity, so Ecwid's own "In stock: N available"
  // already states the true remainder. A per-choice "(23 left)" beside Adult and again
  // beside Child reads as 46 seats when there are 23, and the master suffix rendered
  // "In stock: 23 available (total 23 available)" — saying the same number twice.
  //
  // Both earned their place before the sync existed, when Adult sat at 0 while 23 seats
  // were free and Ecwid's figure was simply wrong. Fixing the data made the annotations
  // redundant. They are kept behind flags for a product that ever tracks stock genuinely
  // per variation, where the base and the variation figures would legitimately differ.
  //
  // The inventory fetch stays on: the remaining count feeds cart-quantity enforcement,
  // which is not redundant — Ecwid checks each variation separately and never sums them,
  // so one cart can still take the full remainder of every variation at once.
  var CONFIG = {
    backendUrl: 'https://webhook.ourtablefarm.com',
    useStub: false,
    showOptionLabels: false,
    showMasterSuffix: false,
    // The one feature that is not redundant — see FEATURE 3.
    enforceCartCap: true,
    // What the quantity field means. true  = "add this many more to the bag"
    //                                false = "set this line to this many"
    // Verify in the storefront before trusting it; the cap arithmetic depends on it.
    qtyFieldAddsToCart: true,
    labelInStock:   '({n} left)',
    labelSoldOut:   '(sold out)',
    masterSuffix:   '(total {n} available)',
    capNotice:      'Only {n} more available for this event.',
    capNoticeNone:  'All {n} remaining places are already in your bag.',
  };

  // ─── STUB DATA ─────────────────────────────────────────────────────────────
  // Local testing only — see CONFIG.useStub above.
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
    // How many more units may be added right now, or null when nothing is being
    // enforced. Read by the delegated input handler.
    addableCap:    null,
  };

  // ─── FETCH INVENTORY ───────────────────────────────────────────────────────
  // Returns Promise<InventoryData|null>. null means "say nothing" — both render
  // functions bail on falsy data, so the page is left untouched.
  // TO WIRE REAL BACKEND: set CONFIG.backendUrl above — no other changes needed.
  function fetchInventory(storeId, productId) {
    if (!CONFIG.backendUrl) {
      return Promise.resolve(CONFIG.useStub ? STUB_DATA : null);
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
      && (n.hasAttribute('data-otc-label') || n.hasAttribute('data-otc-master')
       || n.hasAttribute('data-otc-cap'));
  }

  // Total units of one product already in the bag, summed across every variation.
  // Ecwid lists each variation as its own cart item, so Adult and Child appear
  // separately and must be added together to compare against the shared pool.
  function cartQuantityForProduct(productId, cb) {
    Ecwid.Cart.get(function (cart) {
      var total = 0;
      (cart.items || []).forEach(function (item) {
        if (item.product && String(item.product.id) === String(productId)) {
          total += item.quantity || 0;
        }
      });
      cb(total);
    });
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
    // Quantity field. A real id rather than a generated class, so the sturdiest
    // selector here — confirmed 2026-08-10:
    //   <input class="form-control__text" type="number" id="qty-field" name="ec-qty"
    //          maxlength="10" min="1" value="2">
    qtyInput:      '#qty-field',
    // Wrapper around the add-to-bag button, used to hang the cap notice after it:
    addButtonWrap: '.details-product-purchase__add-more, .details-product-purchase__control',
  };

  // ─── FEATURE 3: CART QUANTITY CAP ─────────────────────────────────────────
  // The reason this file exists. Ecwid enforces stock per variation and never sums
  // across them, so with 23 seats left both Adult and Child read 23 and one cart can
  // take 46. otc-order-processor keeps Ecwid honest between orders; only the browser
  // can hold the line within a single cart.
  //
  // There is no pre-add hook in the Ecwid JS API, so this cannot block an add outright
  // — it caps the quantity field before the fact. A determined customer can still get
  // past it; the oversold alert in otc-order-processor is the backstop for that.
  function applyQuantityCap() {
    if (!CONFIG.enforceCartCap) return;

    document.querySelectorAll('[data-otc-cap]').forEach(function (el) {
      el.parentNode.removeChild(el);
    });

    var data = state.inventoryData;
    var input = document.querySelector(SEL.qtyInput);
    if (!input) return;

    // No shared pool to enforce — stock is genuinely per-variation, so leave Ecwid to it.
    if (!data || typeof data.masterRemaining !== 'number') {
      state.addableCap = null;
      input.removeAttribute('max');
      return;
    }

    cartQuantityForProduct(state.productId, function (inCart) {
      // CONFIG.qtyFieldAddsToCart records what the field means. If it is the number to
      // ADD, what is already in the bag has to be subtracted; if it SETS the line
      // quantity, the bag total for this variation is being replaced rather than added
      // to. Getting this wrong either under-sells or lets the cap be exceeded.
      var addable = CONFIG.qtyFieldAddsToCart
        ? Math.max(0, data.masterRemaining - inCart)
        : data.masterRemaining;

      state.addableCap = addable;
      input.max = String(Math.max(1, addable));
      if (Number(input.value) > addable) input.value = String(Math.max(1, addable));

      if (addable <= 0) {
        showCapNotice(input, CONFIG.capNoticeNone.replace('{n}', data.masterRemaining));
      } else if (inCart > 0) {
        showCapNotice(input, CONFIG.capNotice.replace('{n}', addable));
      }
    });
  }

  // `max` on a number input only constrains the spinner arrows — it does not stop
  // someone typing a larger figure, and Ecwid's add handler does not check validity.
  // Clamping on input is what makes the cap bite. Delegated from the document so it
  // survives Ecwid rebuilding the purchase panel, and installed once.
  function installQuantityClamp() {
    if (state.clampInstalled) return;
    state.clampInstalled = true;

    document.addEventListener('input', function (e) {
      var t = e.target;
      if (!t || t.id !== 'qty-field') return;
      if (typeof state.addableCap !== 'number') return;
      var cap = Math.max(1, state.addableCap);
      if (Number(t.value) > cap) t.value = String(cap);
    }, true);
  }

  function showCapNotice(input, text) {
    var anchor = document.querySelector(SEL.addButtonWrap)
      || (input.closest ? input.closest('.form-control') : null)
      || input.parentNode;
    if (!anchor || !anchor.parentNode) return;

    var note = document.createElement('div');
    note.setAttribute('data-otc-cap', '');
    note.style.cssText = 'margin-top:6px;font-size:0.9em;opacity:0.8;';
    note.textContent = text;
    anchor.parentNode.insertBefore(note, anchor.nextSibling);
  }

  // ─── FEATURE 1: OPTION LABEL ANNOTATION ───────────────────────────────────
  // Reads option name and value directly from input[name] and input[value] —
  // no label text scraping needed.
  function applyOptionLabels(inventoryData) {
    if (!CONFIG.showOptionLabels || !inventoryData) return;

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
    if (!CONFIG.showMasterSuffix || !inventoryData) return;

    // masterRemaining is null when the product has no shared pool — stock is genuinely
    // tracked per variation, so there is no total to state. Say nothing rather than
    // printing "(total null available)".
    if (typeof inventoryData.masterRemaining !== 'number') return;

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
      if (!state.inventoryData) return;
      applyOptionLabels(state.inventoryData);
      // Ecwid rebuilds the purchase panel on re-render, which discards the max we set.
      applyQuantityCap();
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
    installQuantityClamp();

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
          applyQuantityCap();
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
      // Switching variation re-renders the purchase panel, so the cap must be re-applied.
      applyQuantityCap();
    });

    // Re-apply option labels whenever the cart changes so counts stay accurate
    // (e.g. after a customer removes items from the bag).
    // The cart changing is what moves the cap: adding 2 Adult reduces what may still be
    // added as Child. Only meaningful on a product page, where there is a field to cap.
    Ecwid.OnCartChanged.add(function () {
      if (state.productId && state.inventoryData) {
        applyOptionLabels(state.inventoryData);
        applyQuantityCap();
      }
    });

  });

})();
