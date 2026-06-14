# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

Client-side JavaScript that runs on the OTC Ecwid storefront on every page load. Loaded automatically via a custom Ecwid app installation. Currently implements two features on product pages:

1. **Option label annotation** — appends remaining stock counts (e.g. `(4 left)` / `(sold out)`) next to each radio button choice
2. **Stock message augmentation** — appends `(total N available)` to Ecwid's native "In stock: xx available" heading after a customer selects a variation

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

Set `CONFIG.backendUrl` to enable real inventory data. The backend must respond to:

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
