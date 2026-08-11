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
CONFIG        Top of file — feature flags, labels, backendUrl
STUB_DATA     Local-testing fixture, used only when CONFIG.useStub is true
fetchInventory()          Fetches from backendUrl, or returns STUB_DATA

Feature 3 — cart cap (enforceCartCap, ON):
  cartQuantityForProduct()  Sums the bag across every variation of this product
  applyQuantityCap()        Entry point; resolves cart qty then defers to the next
  applyCapWithCartQty()     Sets the qty field's max to masterRemaining − inCart
  installQuantityClamp()    Delegated input listener — `max` alone is not enforcement
  correctEcwidRemaining()   Rewrites the digits in Ecwid's own availability text node
  setAvailabilityVisible()  Hides that line through Ecwid's repaint (see Timing)
  revealAvailabilityRegardless()  4s failsafe so the line can never stay hidden
  applyQuantityCapUntilItSticks() Decaying retry schedule after load / variation change

Features 1 & 2 — display (showOptionLabels, showMasterSuffix — both OFF):
  applyOptionLabels()       Annotates radio button labels
  augmentStockMessage()     Appends master stock to the "In stock" heading
  worstRemainingForValue()  Worst case across combinations, for multi-option products

MutationObserver  Re-applies the cap when Ecwid re-renders the product widget.
                  startObserver() must run BEFORE the first cap application —
                  that ordering is load-bearing, see Timing.
Ecwid.OnAPILoaded → OnPageLoaded        Entry point; fetches on PRODUCT pages
Ecwid.OnProductSelectedOptionsChanged   Re-caps after a variation change
Ecwid.OnCartChanged                     Re-caps after the bag changes
```

Injected DOM nodes carry `data-otc-label` or `data-otc-master` attributes. The MutationObserver filters these out to avoid re-triggering on its own mutations.

## Backend integration

**Live since 2026-08-10.** `CONFIG.backendUrl` is `https://webhook.ourtablefarm.com`.

**Setting `CONFIG.backendUrl` back to null makes this script render nothing**, leaving the
storefront exactly as Ecwid draws it. That is the safe off switch. `CONFIG.useStub` switches `STUB_DATA` back
on for local testing and **must never be true in the deployed file**: the stub figures are
invented, and `augmentStockMessage()` prints `masterRemaining` without checking the data
belongs to the product on screen, so a stub live on the storefront shows customers a
made-up number on every product that has options. It did exactly that on 2026-08-10, when
the app was installed while `backendUrl` was still null — every pizza night reported
"(total 10 available)".

The backend responds to:

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

The endpoint is `GET /inventory` on **otc-webhook-server** (`lib/inventory.js` shapes the
payload and is unit-tested there; the route is thin). It is public and unauthenticated by
necessity — a shared secret in browser JavaScript is not a secret — so it validates
`storeId` against `ECWID_STORE_ID`, restricts CORS to `https://www.ourtable.us`, caches
15s, and returns stock fields only, never price or SKU. That repo's CLAUDE.md owns the
details; do not duplicate them here.

An earlier plan called this `GET /ecwid/product/:id/stock`. That name was never built —
`/inventory` superseded it.

## CSS selectors

Ecwid does not document its CSS classes. The selectors in `SEL` were confirmed via DevTools and may break on Ecwid storefront updates. Verify them in-browser after any Ecwid platform upgrade.

## Deployment

No build step. Edit `otccustom.js`, commit, and push to GitHub — **Cloudflare Pages
deploys this repo's root automatically**, and the Ecwid custom app is registered against
the resulting URL:

```
https://otc-ecwidclientcustomizations.pages.dev/otccustom.js
```

Ecwid fetches that URL on every storefront page visit. There is no upload step and no copy
of the file inside Ecwid — the custom app holds only the URL. Pages sends
`cache-control: max-age=0, must-revalidate`, so a push propagates immediately and no
cache-busting query string is needed (Pages ignores query strings for cache keying anyway).

### Two different Cloudflare products are involved — do not conflate them

| | Serves | Path |
|---|---|---|
| Cloudflare **Pages** | `otccustom.js`, static | `otc-ecwidclientcustomizations.pages.dev`, from the edge POP |
| **cloudflared** tunnel | `GET /inventory`, dynamic | `webhook.ourtablefarm.com` → OTC-SRV-ITSUPPORT:3100 |

Only the tunnel touches our server. The script itself never does.

### Why not host it on Weebly (evaluated and rejected 2026-08-10)

`www.ourtable.us` is Weebly, fronted by Cloudflare. Serving `otccustom.js` from there
would be **slower, not faster**, and it was considered specifically to speed up loading:

- Weebly's origin is a single datacenter (`x-host: blu143.sf2p.intern.weebly.net`), and the
  site sends `cache-control: max-age=30, private, no-store`, so Cloudflare is proxying
  rather than caching it. Pages serves from whichever edge POP is nearest the customer —
  measured 105ms from this host.
- It trades push-to-deploy for manual re-uploads, and Weebly's uploader may not serve `.js`
  with a usable MIME type.

The only real cost of the current setup is one extra TLS handshake to `pages.dev` on a
first visit. If that ever matters, point a custom domain on the existing Cloudflare zone at
the Pages project — that keeps edge delivery *and* the deploy pipeline. Note that the
`/inventory` fetch is cross-origin regardless of where the script lives.

Perceived lag in the availability figure is **not** download time — it is the deliberate
350ms `VARIATION_REPAINT_HOLD_MS` hold and retry schedule described under **Timing** above.
No hosting change will affect it.

## No tests

There is no test suite. Test locally with `CONFIG.useStub = true`, or point
`CONFIG.backendUrl` at a local otc-webhook-server instance. **Never commit `useStub: true`** —
see the warning under Backend integration.

Verification is in-browser via DevTools. The checks that actually caught bugs: read the
qty field's `max` attribute, type a number above it and confirm it clamps, and compare the
availability figure across a hard reload and a variation switch with a non-empty bag —
every timing bug showed up as a brief wrong number, not a wrong final number.
