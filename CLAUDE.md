# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

Client-side JavaScript that runs on the OTC Ecwid storefront on every page load. Loaded automatically via a custom Ecwid app installation.

**Both display features are currently OFF** (`showOptionLabels`, `showMasterSuffix`), and the reason matters. They were written when Ecwid's own stock figure was wrong: Ecwid tracks stock per variation and ignores the product-level quantity, so the Aug 14 pizza night showed Adult "Out of stock" while 23 seats were free. `otc-order-processor` now syncs every variation to the shared base quantity, which makes Ecwid's native "In stock: N available" correct — so the annotations began repeating it. The master suffix rendered literally "In stock: 23 available (total 23 available)". Fixing the data made the display redundant.

They stay behind flags for a product that ever tracks stock genuinely per variation, where base and variation figures would legitimately differ.

**The inventory fetch stays on** — the remaining count is there to feed cart-quantity enforcement, which is *not* redundant. Ecwid checks each variation separately and never sums across them, so one cart can still take the full remainder of every variation at once (with 23 left, 23 Adult + 23 Child both pass). That enforcement is not yet built; see the TODO in `otc-order-processor/CLAUDE.md`.

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
