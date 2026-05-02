# OTC Ecwid Client Customizations

Client-side JavaScript customizations for Ecwid storefronts, loaded automatically via a custom app installation.

## How It Works

The file `otccustom.js` is hosted and connected to the store through a custom Ecwid app. It loads on every storefront visit and has access to the full Ecwid JS API.

All code must wait for the API to initialize before using any Ecwid methods:

```javascript
Ecwid.OnAPILoaded.add(function() {
  // safe to use Ecwid JS API here
});
```

## Key API Areas

| Area | Methods / Events |
|---|---|
| Page lifecycle | `Ecwid.OnPageLoaded`, `Ecwid.OnPageSwitch` |
| Cart | `Ecwid.Cart.get()`, `Ecwid.Cart.addProduct()`, `Ecwid.OnCartChanged` |
| Customer | `Ecwid.Customer.get()`, `Ecwid.OnSetProfile` |
| Orders | `Ecwid.OnOrderPlaced` |
| Navigation | `Ecwid.openPage(slug, params)` |
| Store info | `Ecwid.getOwnerId()` |
| Config | `window.ec.config`, `window.ec.storefront` |

Full API reference: https://docs.ecwid.com/storefronts/

## Files

- `otccustom.js` — Main customization script loaded on every storefront page
