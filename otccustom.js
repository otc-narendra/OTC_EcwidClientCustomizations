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
    // FEATURE 4, the Gift card box on checkout (gift card plan WP-3b). 'off' | 'test' | 'on'.
    // 'test' draws it only in a browser that opened the store once with ?otc-giftcard-test=1
    // (remembered in localStorage; ?otc-giftcard-test=0 forgets it), so it can be tried on the
    // live store before shoppers see it. **Never 'on' before WP-3c charges the card when the
    // order arrives:** until then a gift card discount is a discount nobody pays for.
    giftCard: 'test',
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
    // Units of this product already in the bag, summed across variations. Cached so
    // switching variation can correct the figure synchronously: Ecwid.Cart.get is
    // asynchronous, and going back to it on every redraw let Ecwid's own number show
    // for a frame or two before ours replaced it. Refreshed whenever the cart changes,
    // which is the only thing that can move it.
    cartQty:       null,
    // Timestamp before which the availability line stays hidden regardless of having a
    // correct figure. Ecwid repaints the purchase panel *after* announcing a variation
    // change, so correcting synchronously and revealing immediately showed our number,
    // then Ecwid's, then ours again once the observer caught up. Holding through the
    // repaint turns that into a brief blank instead of a brief lie.
    holdHiddenUntil: 0,
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
    // Container of Ecwid's own availability line. Observed wording, 2026-08-10:
    //   empty bag        -> "In stock: 23 available"
    //   items in the bag -> "2 items in the bag   (21 more available)"
    // Both figures are per-variation and overstate a shared pool.
    stockPlace:    '.details-product-purchase__place',
  };

  // Ecwid's availability figure counts only the selected variation, so with 5 Adult and
  // 2 Child in the bag it offers "18 more" on Adult and "21 more" on Child when the true
  // shared remainder is 16. Rewriting the number in place beats adding a second, correct
  // line beside a wrong one — customers read Ecwid's, and two numbers is worse than
  // either. Only the digits change; the wording and position stay Ecwid's.
  //
  // Edits the text node's value rather than replacing nodes, so it does not trip the
  // MutationObserver (which watches childList, not characterData) and cannot loop.
  //
  // Returns true if it found a figure to correct — the caller falls back to its own
  // notice if Ecwid's wording ever changes out from under this.
  function correctEcwidRemaining(addable) {
    var place = document.querySelector(SEL.stockPlace);
    if (!place || typeof addable !== 'number') return false;

    var patterns = [
      /\((\d+)\s+more available\)/i,   // "…(21 more available)"
      /In stock:\s*(\d+)\s+available/i, // "In stock: 23 available"
    ];

    var walker = document.createTreeWalker(place, NodeFilter.SHOW_TEXT, null, false);
    var node;
    while ((node = walker.nextNode())) {
      for (var i = 0; i < patterns.length; i++) {
        var m = node.nodeValue.match(patterns[i]);
        if (!m) continue;
        if (Number(m[1]) !== addable) {
          node.nodeValue = node.nodeValue.replace(
            patterns[i],
            m[0].replace(/\d+/, String(addable))
          );
        }
        return true;
      }
    }
    return false;
  }

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

    // Not known yet — keep Ecwid's uncorrected figure out of sight.
    if (!data) {
      setAvailabilityVisible(false);
      return;
    }

    var input = document.querySelector(SEL.qtyInput);
    if (!input) return;

    // No shared pool to enforce — stock is genuinely per-variation, so leave Ecwid to
    // it, figure and all.
    if (typeof data.masterRemaining !== 'number') {
      state.addableCap = null;
      input.removeAttribute('max');
      setAvailabilityVisible(true);
      return;
    }

    if (typeof state.cartQty === 'number') {
      applyCapWithCartQty(data, input, state.cartQty);
      return;
    }
    cartQuantityForProduct(state.productId, function (inCart) {
      state.cartQty = inCart;
      applyCapWithCartQty(data, input, inCart);
    });
  }

  function applyCapWithCartQty(data, input, inCart) {
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

    // Preferred: correct Ecwid's own figure. Only if its wording has moved on do we
    // add a line of our own, so a platform change degrades to a second number rather
    // than to silence.
    var corrected = correctEcwidRemaining(addable);
    if (Date.now() >= state.holdHiddenUntil) {
      setAvailabilityVisible(true);
      clearTimeout(state.revealTimer);
    }

    if (addable <= 0) {
      showCapNotice(input, CONFIG.capNoticeNone.replace('{n}', data.masterRemaining));
    } else if (!corrected && inCart > 0) {
      showCapNotice(input, CONFIG.capNotice.replace('{n}', addable));
    }
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

  // On first load our correction can land before Ecwid has drawn its availability line,
  // or on a text node Ecwid is about to replace — the page then showed Ecwid's own
  // per-variation figure (18) until a variation change forced a redraw and we corrected
  // it to 16. Re-apply on a short decaying schedule so whichever render wins last is
  // still corrected. Every step is idempotent: the cap is recomputed from live cart data
  // and the text rewrite no-ops when the figure already matches.
  // 400 sits just past VARIATION_REPAINT_HOLD_MS so the line reveals as soon as the hold
  // lifts rather than waiting for the next step; the later ones catch a slow redraw.
  var CAP_RETRY_DELAYS_MS = [0, 250, 400, 750, 1500, 3000];

  // How long Ecwid's post-change repaint is allowed to take before we show a figure.
  // Longer than the observer's 150ms debounce, so a redraw that lands late is still
  // corrected before anything becomes visible.
  var VARIATION_REPAINT_HOLD_MS = 350;

  // Ecwid draws its own per-variation figure immediately; ours needs a network round
  // trip, so for about a second the page showed 20 before correcting to 15. A briefly
  // wrong number is worse than a briefly absent one — a customer glancing at the page
  // may act on it. Hide the line until the true figure is known, then reveal it.
  //
  // visibility rather than display, so the layout does not jump when it appears.
  function setAvailabilityVisible(visible) {
    var place = document.querySelector(SEL.stockPlace);
    if (!place) return;
    place.style.visibility = visible ? '' : 'hidden';
  }

  // A fetch that never returns must not leave the line hidden for good. Whatever
  // happens, Ecwid's own figure is back on screen within this window — wrong, but
  // present, which is how the page behaved before any of this existed.
  var AVAILABILITY_REVEAL_TIMEOUT_MS = 4000;

  function revealAvailabilityRegardless() {
    clearTimeout(state.revealTimer);
    state.revealTimer = setTimeout(function () { setAvailabilityVisible(true); },
      AVAILABILITY_REVEAL_TIMEOUT_MS);
  }

  function applyQuantityCapUntilItSticks() {
    CAP_RETRY_DELAYS_MS.forEach(function (delay) {
      setTimeout(function () {
        // Bail if the customer has navigated away in the meantime.
        if (state.inventoryData) applyQuantityCap();
      }, delay);
    });
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

  // ─── FEATURE 4: GIFT CARD BOX (checkout) ──────────────────────────────────
  // Gift card plan WP-3b (otc-qbo-admin/gift-cards-plan-brief.md). A "Gift card" panel on the
  // checkout: card number + PIN, Apply / Remove. Apply sends them to webhook-server's
  // /giftcard/apply, which checks the balance with Datacap and answers with a random token and
  // the last 4. The token — never the card — goes into the hidden checkout extra field
  // `otcGiftCardToken`; Ecwid then sends it with every cart to the member discount relay, which
  // adds "Our Table gift card −$X". WP-3a proved the field only reaches the relay after
  // Ecwid.refreshConfig(), so Apply and Remove both call it.
  //
  // The card number and PIN live only in the two inputs until Apply, and the inputs are cleared
  // as soon as the answer comes back. They are never written to an Ecwid field, storage or the
  // console. sessionStorage keeps the token, last 4 and balance so a reload keeps the card.
  //
  // Selectors here are NOT confirmed against Ecwid's checkout DOM: verify in DevTools in test
  // mode (see CLAUDE.md, "Gift card box").
  var GIFT = {
    field: 'otcGiftCardToken',
    storageKey: 'otcGiftCard',
    testFlag: 'otcGiftCardTest',
    // Where the box goes: after the first of these found. Coupon block first ("Have a discount
    // coupon?" sits on the first checkout step), then broader containers.
    anchors: ['.ec-cart__discount', '.ec-cart-coupon', '.ec-cart__coupon', '.ec-cart-step--email',
      '.ec-cart__step--email', '.ec-cart__sidebar-inner', '.ec-cart__sidebar', '.ec-cart'],
    confirmationAnchors: ['.ec-confirmation', '.ec-cart', '.ec-store'],
    ttlMs: 2 * 60 * 60 * 1000,
    statusDelaysMs: [1500, 4000],
  };

  var gift = { enabled: false, saved: null, applied: null, coversItems: false, busy: false, message: '', timer: null };

  function giftCardEnabled() {
    if (!CONFIG.backendUrl || CONFIG.giftCard === 'off') return false;
    if (CONFIG.giftCard === 'on') return true;
    try {
      var m = /[?&]otc-giftcard-test=([01])/.exec(window.location.search);
      if (m) {
        if (m[1] === '1') localStorage.setItem(GIFT.testFlag, '1');
        else localStorage.removeItem(GIFT.testFlag);
      }
      return localStorage.getItem(GIFT.testFlag) === '1';
    } catch (e) { return false; }
  }

  function loadSavedGiftCard() {
    try {
      var v = JSON.parse(sessionStorage.getItem(GIFT.storageKey) || 'null');
      if (v && typeof v.token === 'string' && Date.now() - v.at < GIFT.ttlMs) return v;
    } catch (e) { /* fall through */ }
    return null;
  }

  function saveGiftCard(v) {
    gift.saved = v;
    try {
      if (v) sessionStorage.setItem(GIFT.storageKey, JSON.stringify(v));
      else sessionStorage.removeItem(GIFT.storageKey);
    } catch (e) { /* the box still works for this page */ }
  }

  // Ecwid's documented way to add a checkout extra field: no checkoutDisplaySection keeps it
  // off the checkout form, and 'hidden' keeps it out of emails and the order details.
  function setGiftCardField(token) {
    window.ec = window.ec || {};
    window.ec.order = window.ec.order || {};
    window.ec.order.extraFields = window.ec.order.extraFields || {};
    window.ec.order.extraFields[GIFT.field] = { value: token || '', orderDetailsDisplaySection: 'hidden' };
  }

  function pushGiftCardField(token) {
    setGiftCardField(token);
    if (window.Ecwid && typeof Ecwid.refreshConfig === 'function') Ecwid.refreshConfig();
  }

  function giftPost(path, body) {
    return fetch(CONFIG.backendUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, data: data };
      });
    });
  }

  function money(s) { return '$' + Number(s).toFixed(2); }

  function refreshGiftCardStatus() {
    if (!gift.saved) return;
    var token = gift.saved.token;
    giftPost('/giftcard/status', { token: token }).then(function (r) {
      if (!gift.saved || gift.saved.token !== token) return;
      if (r.status === 404) {
        saveGiftCard(null);
        gift.applied = null;
        pushGiftCardField('');
        gift.message = r.data.error || 'Your gift card has expired. Please enter it again.';
      } else if (r.status === 200) {
        gift.applied = r.data.applied;
        gift.coversItems = !!r.data.coversItems;
      }
      renderGiftCardBox();
    }).catch(function () { /* keep what is on screen */ });
  }

  function scheduleGiftCardStatus() {
    GIFT.statusDelaysMs.forEach(function (ms) { setTimeout(refreshGiftCardStatus, ms); });
  }

  function applyGiftCard(cardInput, pinInput) {
    if (gift.busy) return;
    var card = cardInput.value;
    var pin = pinInput.value;
    gift.busy = true;
    gift.message = '';
    renderGiftCardBox();
    giftPost('/giftcard/apply', { card: card, pin: pin }).then(function (r) {
      if (r.status === 200 && r.data.token) {
        saveGiftCard({ token: r.data.token, last4: r.data.last4, balance: r.data.balance, at: Date.now() });
        gift.applied = null;
        pushGiftCardField(r.data.token);
        scheduleGiftCardStatus();
      } else {
        gift.message = r.data.error || 'That gift card could not be applied.';
      }
    }).catch(function () {
      gift.message = 'Gift cards can\'t be checked right now. Please try again in a few minutes.';
    }).then(function () {
      card = pin = null;
      gift.busy = false;
      renderGiftCardBox(true);
    });
  }

  function removeGiftCard() {
    if (!gift.saved || gift.busy) return;
    var token = gift.saved.token;
    saveGiftCard(null);
    gift.applied = null;
    gift.coversItems = false;
    gift.message = '';
    pushGiftCardField('');
    renderGiftCardBox();
    giftPost('/giftcard/remove', { token: token }).catch(function () { /* the token expires on its own */ });
  }

  function el(tag, css, text) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }

  function findAnchor(list) {
    for (var i = 0; i < list.length; i++) {
      var n = document.querySelector(list[i]);
      if (n) return n;
    }
    return null;
  }

  // Draws (or redraws) the box. clearInputs: Apply finished, so the card number and PIN go.
  function renderGiftCardBox(clearInputs) {
    var box = document.querySelector('[data-otc-giftcard]');
    if (!box) {
      var anchor = findAnchor(GIFT.anchors);
      if (!anchor || !anchor.parentNode) return;
      box = el('div', 'margin:16px 0;padding:12px 14px;border:1px solid rgba(0,0,0,0.15);border-radius:6px;');
      box.setAttribute('data-otc-giftcard', '');
      anchor.parentNode.insertBefore(box, anchor.nextSibling);
    }
    // Keep what the shopper is typing across a redraw, unless Apply just finished.
    var oldCard = box.querySelector('input[data-otc-gc-card]');
    var oldPin = box.querySelector('input[data-otc-gc-pin]');
    var typedCard = oldCard && !clearInputs ? oldCard.value : '';
    var typedPin = oldPin && !clearInputs ? oldPin.value : '';
    while (box.firstChild) box.removeChild(box.firstChild);

    box.appendChild(el('div', 'font-weight:bold;margin-bottom:8px;', 'Gift card'));

    if (gift.saved) {
      var line = 'Gift card ending ' + gift.saved.last4 + ': ' + money(gift.saved.balance) + ' available';
      if (gift.applied != null) line += ', ' + money(gift.applied) + ' applied';
      box.appendChild(el('div', '', line + '.'));
      if (gift.applied != null && gift.coversItems) {
        box.appendChild(el('div', 'margin-top:6px;font-size:0.9em;',
          'Your gift card covers the items. Shipping (if any) and memberships are paid by card.'));
      }
      var remove = el('button', 'margin-top:8px;padding:6px 14px;cursor:pointer;', 'Remove');
      remove.type = 'button';
      remove.addEventListener('click', removeGiftCard);
      box.appendChild(remove);
    } else {
      var row = el('div', 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;');
      var card = el('input', 'flex:1 1 180px;min-width:0;padding:6px 8px;');
      card.setAttribute('data-otc-gc-card', '');
      card.type = 'text';
      card.inputMode = 'numeric';
      card.autocomplete = 'off';
      card.maxLength = 23;
      card.placeholder = 'Card number';
      card.setAttribute('aria-label', 'Gift card number');
      card.value = typedCard;
      var pin = el('input', 'flex:0 0 80px;width:80px;padding:6px 8px;');
      pin.setAttribute('data-otc-gc-pin', '');
      pin.type = 'password';
      pin.inputMode = 'numeric';
      pin.autocomplete = 'off';
      pin.maxLength = 4;
      pin.placeholder = 'PIN';
      pin.setAttribute('aria-label', 'Gift card PIN');
      pin.value = typedPin;
      var apply = el('button', 'padding:6px 14px;cursor:pointer;', gift.busy ? 'Checking…' : 'Apply');
      apply.type = 'button';
      apply.disabled = gift.busy;
      apply.addEventListener('click', function () { applyGiftCard(card, pin); });
      // Enter must not submit Ecwid's checkout form.
      [card, pin].forEach(function (input) {
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); applyGiftCard(card, pin); }
        });
      });
      row.appendChild(card);
      row.appendChild(pin);
      row.appendChild(apply);
      box.appendChild(row);
      box.appendChild(el('div', 'margin-top:6px;font-size:0.85em;opacity:0.75;',
        'Gift cards pay for items, not shipping or co-op memberships.'));
    }
    if (gift.message) box.appendChild(el('div', 'margin-top:6px;color:#b00020;', gift.message));
  }

  // Ecwid re-renders the checkout as the shopper moves through it and can drop the box with it;
  // a light check puts it back. Stopped off the checkout.
  function keepGiftCardBox() {
    clearInterval(gift.timer);
    renderGiftCardBox();
    gift.timer = setInterval(function () {
      if (!document.querySelector('[data-otc-giftcard]')) renderGiftCardBox();
    }, 1000);
  }

  function dropGiftCardBox() {
    clearInterval(gift.timer);
    gift.timer = null;
    var box = document.querySelector('[data-otc-giftcard]');
    if (box && box.parentNode) box.parentNode.removeChild(box);
  }

  // Order placed: show what the card pays and what it keeps, then forget the token so the next
  // order in this session doesn't carry it. The card is charged when the order arrives (WP-3c).
  function showGiftCardOnConfirmation() {
    var saved = gift.saved;
    var applied = gift.applied;
    saveGiftCard(null);
    gift.applied = null;
    // Pushed, not just set: Ecwid keeps sending the last value pushed (WP-3a), so the next
    // order in this session would otherwise carry this token.
    pushGiftCardField('');
    if (!saved || applied == null || Number(applied) <= 0) return;
    var anchor = findAnchor(GIFT.confirmationAnchors);
    if (!anchor) return;
    var left = Math.max(0, Number(saved.balance) - Number(applied));
    var note = el('div', 'margin:16px 0;padding:12px 14px;border:1px solid rgba(0,0,0,0.15);border-radius:6px;',
      'Gift card ending ' + saved.last4 + ': ' + money(applied) + ' of this order is paid by your gift card. ' +
      'Remaining balance after this order: ' + money(left) + '.');
    note.setAttribute('data-otc-giftcard-confirmation', '');
    anchor.insertBefore(note, anchor.firstChild);
  }

  function isCheckoutPage(type) {
    return type === 'CART' || (/^CHECKOUT_/.test(type) && type !== 'CHECKOUT_RESULT');
  }

  function isConfirmationPage(type) {
    return type === 'CHECKOUT_RESULT' || type === 'ORDER_CONFIRMATION';
  }

  // Runs at load, before Ecwid's checkout reads its config (Ecwid's docs advise setting extra
  // fields outside the checkout page). A saved token is put back so a reload keeps the card.
  gift.enabled = giftCardEnabled();
  if (gift.enabled) {
    gift.saved = loadSavedGiftCard();
    if (!gift.saved) saveGiftCard(null);
    setGiftCardField(gift.saved ? gift.saved.token : '');
  }

  // ─── EVENT HOOKS ───────────────────────────────────────────────────────────
  Ecwid.OnAPILoaded.add(function () {
    installQuantityClamp();

    Ecwid.OnPageLoaded.add(function (page) {
      if (gift.enabled) {
        if (isCheckoutPage(page.type)) {
          keepGiftCardBox();
          refreshGiftCardStatus();
        } else {
          dropGiftCardBox();
          if (isConfirmationPage(page.type)) showGiftCardOnConfirmation();
        }
      }

      if (page.type !== 'PRODUCT') {
        clearTimeout(state.revealTimer);
        setAvailabilityVisible(true);
        stopObserver();
        state.inventoryData = null;
        state.productId = null;
        state.currentOptions = {};
        return;
      }

      state.productId = page.productId;
      state.currentOptions = {};
      state.inventoryData = null;
      state.cartQty = null;
      state.holdHiddenUntil = 0;
      // Hide before the fetch begins, and arm the fallback in case it never lands.
      setAvailabilityVisible(false);
      revealAvailabilityRegardless();

      fetchInventory(Ecwid.getOwnerId(), page.productId)
        .then(function (data) {
          state.inventoryData = data;
          // Observer first: Ecwid finishes rendering the purchase panel asynchronously,
          // and starting the watch afterwards can miss the very render that discards our
          // work. This ordering is load-bearing, not incidental.
          startObserver();
          applyOptionLabels(data);
          applyQuantityCapUntilItSticks();
        })
        .catch(function (err) {
          console.warn('[OTC] Inventory fetch failed for product ' + page.productId + ':', err);
          // Fall back to Ecwid's own figure rather than leaving the line blank.
          setAvailabilityVisible(true);
        });
    });

    // Fires when the customer changes a variation selection.
    // Updates the "In stock" suffix with the master remaining count.
    Ecwid.OnProductSelectedOptionsChanged.add(function (payload) {
      state.currentOptions = payload.newOptions || {};
      augmentStockMessage(state.inventoryData);
      // Switching variation re-renders the purchase panel with Ecwid's own
      // per-variation figure. Hide it, then re-apply — which is synchronous now the
      // cart total is cached, so the corrected number is in place before the next
      // paint instead of a frame or two later.
      setAvailabilityVisible(false);
      // Ride out Ecwid's repaint before showing anything. The retry schedule re-applies
      // past this point, so the figure revealed is the one that survived the redraw.
      state.holdHiddenUntil = Date.now() + VARIATION_REPAINT_HOLD_MS;
      revealAvailabilityRegardless();
      applyQuantityCapUntilItSticks();
    });

    // Re-apply option labels whenever the cart changes so counts stay accurate
    // (e.g. after a customer removes items from the bag).
    // The cart changing is what moves the cap: adding 2 Adult reduces what may still be
    // added as Child. Only meaningful on a product page, where there is a field to cap.
    // A cart change re-prices the gift card (the relay recalculates on every call); ask what it
    // applied once Ecwid has had time to call the relay.
    var giftStatusAfterCartChange = debounce(refreshGiftCardStatus, 1500);
    Ecwid.OnCartChanged.add(function () {
      if (gift.enabled && gift.saved) giftStatusAfterCartChange();
    });

    Ecwid.OnCartChanged.add(function () {
      if (!state.productId || !state.inventoryData) return;
      // Refresh the cached total first: this event is the only thing that can move it.
      cartQuantityForProduct(state.productId, function (inCart) {
        state.cartQty = inCart;
        applyOptionLabels(state.inventoryData);
        applyQuantityCap();
      });
    });

  });

})();
