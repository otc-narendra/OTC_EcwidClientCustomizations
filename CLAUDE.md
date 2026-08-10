# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

Client-side JavaScript that runs on the OTC Ecwid storefront on every page load. Loaded automatically via a custom Ecwid app installation.

**Both display features are currently OFF** (`showOptionLabels`, `showMasterSuffix`), and the reason matters. They were written when Ecwid's own stock figure was wrong: Ecwid tracks stock per variation and ignores the product-level quantity, so the Aug 14 pizza night showed Adult "Out of stock" while 23 seats were free. `otc-order-processor` now syncs every variation to the shared base quantity, which makes Ecwid's native "In stock: N available" correct — so the annotations began repeating it. The master suffix rendered literally "In stock: 23 available (total 23 available)". Fixing the data made the display redundant.

They stay behind flags for a product that ever tracks stock genuinely per variation, where base and variation figures would legitimately differ.

**Feature 3, the cart quantity cap, is the one that earns its keep** (`enforceCartCap`). Ecwid checks each variation separately and never sums across them, so with 23 seats left both Adult and Child read 23 and one cart could take 46. Product-level `maxPurchaseQuantity` does not aggregate either — verified 2026-08-10 by putting 3+3 in a cart against a cap of 3 and being offered checkout — so there is no server-side way to close this and the browser is the only place it can be done.

It caps the quantity field at `masterRemaining` minus what the bag already holds for that product across every variation, and rewrites Ecwid's own availability figure to the same number. **It caps, it does not block:** there is no pre-add hook in the Ecwid JS API, so a determined customer can still exceed it, and two simultaneous shoppers see the same number. The oversold alert in `otc-order-processor` is the backstop.

### Timing, which took most of the effort

Three separate races, all fixed by preferring a brief blank over a brief lie — Ecwid's figure is the one customers trust, and they can act on it before it settles:

- **`max` alone is not enforcement.** On a number input it only constrains the spinner arrows, and Ecwid's add handler does not check validity. A delegated `input` listener clamps the typed value, attached once to the document so it survives re-renders.
- **On load** the correction ran before Ecwid had drawn its line, and `startObserver()` was called *after* `applyQuantityCap()` so the observer missed the render that discarded our work. The observer now starts first — that ordering is load-bearing — and the cap re-applies on a decaying schedule.
- **On variation change** Ecwid repaints *after* announcing the change, so correcting synchronously and revealing immediately showed ours, then Ecwid's, then ours again. The line is now held hidden for `VARIATION_REPAINT_HOLD_MS` (350ms, longer than the observer's 150ms debounce) and revealed at the 400ms retry, so what appears is the figure that survived the repaint.

Every reveal path has a way out: a 4s timer, the fetch-failure handler, and leaving the product page all restore visibility. A fetch that never lands must leave Ecwid's own number on screen — wrong, but present, as the page behaved before any of this existed.

The two features, when enabled:

1. **Option label annotation** — appends remaining stock counts (e.g. `(4 left)` / `(sold out)`) next to each radio button choice
2. **Stock message augmentation** — appends `(total N available)` to Ecwid's native "In stock: xx available" heading. Note it is wired only to `OnProductSelectedOptionsChanged`, so it does not render on initial page load with the default variation selected — fix that before re-enabling.

## Architecture

Single file: `otccustom.js` — an IIFE, no modules, no build step.

```
CONFIG        Top of file — labels, backend URL (currently null → stub data)
STUB_DATA     Hardcoded test data used while CONFIG.backendUrl is null
fetchInventory()   Fetches from backend or returns STUB_DATA
applyOptionLabels()   Feature 1 — annotates radio button labels
augmentStockMessage()  Feature 2 — appends master stock to "In stock" heading
MutationObserver  Re-runs applyOptionLabels when Ecwid re-renders the product widget
Ecwid.OnAPILoaded → OnPageLoaded   Entry point; fires fetchInventory on PRODUCT pages
Ecwid.OnProductSelectedOptionsChanged  Triggers Feature 2
Ecwid.OnCartChanged   Re-applies labels after cart changes
```

Injected DOM nodes carry `data-otc-label` or `data-otc-master` attributes. The MutationObserver filters these out to avoid re-triggering on its own mutations.

## Backend integration (not yet wired)

**While `CONFIG.backendUrl` is null this script renders nothing**, leaving the storefront
exactly as Ecwid draws it. That is deliberate. `CONFIG.useStub` switches `STUB_DATA` back
on for local testing and **must never be true in the deployed file**: the stub figures are
invented, and `augmentStockMessage()` prints `masterRemaining` without checking the data
belongs to the product on screen, so a stub live on the storefront shows customers a
made-up number on every product that has options. It did exactly that on 2026-08-10, when
the app was installed while `backendUrl` was still null — every pizza night reported
"(total 10 available)".

`CONFIG.backendUrl` is set to `https://webhook.ourtablefarm.com`, live since 2026-08-10. The backend responds to:

```
GET {backendUrl}/inventory?storeId={storeId}&productId={productId}
```

Response shape:
```json
{
  "masterRemaining": 10,
  "variations": [
    { "options": { "Type of ticket": "Adult (no bubbles)" }, "remaining": 6 }
  ]
}
```

The planned backend endpoint is `GET /ecwid/product/:id/stock` on `otc-webhook-server` (see that repo's TODO). No other code changes are needed here once the URL is set.

## CSS selectors

Ecwid does not document its CSS classes. The selectors in `SEL` were confirmed via DevTools and may break on Ecwid storefront updates. Verify them in-browser after any Ecwid platform upgrade.

## Deployment

No build step. Edit `otccustom.js`, commit, and push. The file is served directly via the custom Ecwid app — Ecwid loads it on every storefront page visit.

## No tests

There is no test suite. Test locally using `STUB_DATA` (set `CONFIG.backendUrl = null`) or point `CONFIG.backendUrl` at a local backend instance.
