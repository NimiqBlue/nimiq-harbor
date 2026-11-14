# Lightning integration

## Scope and source layout

The standalone browser implementation is ported from the production cancellation/recovery release, not reconstructed from a minified bundle. `src/web/lightning/lightning.js` mounts one dialog outside the React root and observes the root to insert actions into the connected wallet menu and footer. It never inserts a disconnected header bolt or an above-Bank panel. React StrictMode therefore does not double-mount it. Polygon Pay and the DeFi execution/backend flows remain separate.

`settlement.js` validates invoices and verifies the read-only settlement response. `rejection.js` defines the narrowly allowed cancellation/recovery classifications. The production logic and stylesheet are retained; imports are adapted to installed packages. `browser-globals.js` supplies local Buffer/process/global shims before bolt11 evaluates; Vite aliases stream/events to browser implementations. No CDN scripts, generated production bundles or private payment evidence are required.

The widget retains `rfr=yZkss3Rs`, all three tabs, existing Polygon defaults (`net`, `snet`, `dnet`), and adds `sat` / `lightning_mainnet` only to the global currency/network choices. This allows BUY output, SELL input and both SWAP directions. These defaults are not directional restrictions. The Lightning action pays an invoice; it does not implement receiving Lightning into NIM or choose output-side receiving details for you. Bank stays fail-closed without your browser-visible `VITE_MTPELERIN_KEY`.

## Capture and explicit payment

Only an object envelope `{type: 'orderCreated', data: order}` from the current widget iframe's exact `contentWindow` and `https://widget.mtpelerin.com` origin is eligible. The module validates SELL or SWAP Lightning input, numeric order ID, future expiration, integer sat input amount, and a matching fixed-amount mainnet BOLT11 invoice. It never prompts the wallet from a message, and never replaces edited or pending input. Manual paste stays available even if the widget's event is absent or changes.

Payment requires an explicit click, a native Nimiq Pay provider with `payLightningInvoice`, durable localStorage readback and a Web Lock. Use HTTPS in deployment (loopback HTTP for local tests). The wallet chooses the spending account and supported asset; Harbor cannot force NIM rather than USDT. Connecting a Polygon wallet is not required.

A fresh unknown attempt is saved before the physical wallet request. Unknown/submitted/paid/duplicate attempts cannot be repaid. Only SDK 0.2.5's normalized physical `NimiqProviderError` / `PERMISSION_DENIED` (numeric 4001 or absent code, no recovery data), with unchanged durable attempt identity under the lock, records new cancellation provenance. A later explicit click may retry that attempt. Generic errors, cancellation text, nested errors, malformed successes and stale writes never unlock payment. Legacy cancelled records without the new provenance stay blocked. Nothing automatically restarts a wallet payment.

## Settlement and recovery

Wallet `{hash, swapId}` means submitted, not settled. Verification GETs `https://api.go.fastspot.io/swap/{swapId}` without credentials/referrer and requires the exact swap ID, one matching BTC_LN contract, exact invoice/recipient, payment hash and amount. Paid additionally requires FINISHED, all contracts REDEEMED, and SHA256(preimage) equal to the invoice payment hash. This establishes only the Lightning payment leg, never merchant credit, fiat delivery or Polygon payout.

Checks pause when hidden, after a fetch failure, after the bounded automatic window or after unverifiable data. Manual status checks do not request a payment. Existing invoice + wallet swap ID can be reconciled without paying, including expired invoices. Closing is cosmetic; export preserves the saved attempt. Never clear storage to resolve an unknown payment. If there is no swap ID, preserve evidence and ask the wallet to establish the outcome.

Recovery is per browser origin/device, not a cross-device payment registry. Browser-data removal loses protection. See README and the Privacy page for fields, local retention and third-party disclosures. An independent reverse proxy must preserve the server's `frame-src https://widget.mtpelerin.com` and `connect-src https://api.go.fastspot.io` allowances without broadening script policy.

## Reproducible checks

```sh
npm ci --ignore-scripts
npm run check
npm run build
npm test
npx playwright install chromium
npm run test:e2e
npm run test:ui
npm run test:lightning:browser
python3 scripts/generate-license-notices.py --check
```

The Lightning runner builds a separate source artifact with `synthetic-test-key`, starts the actual unconfigured backend/static server on an ephemeral loopback port, and exercises the rendered app under its real CSP. It never replaces the ordinary unconfigured `dist`. All external requests are blocked or fulfilled with synthetic data; all financial/signing methods are forbidden except the inert mock `payLightningInvoice`. No public swap, live order, wallet approval or real payment is used. Generated invoices, swap response, preimage and deterministic signing bytes are synthetic test fixtures only and must never be paid.

The browser suite covers 23 settlement/menu/capture cases and 24 cancellation/replay cases at desktop and touch-mobile viewport sizes. It includes SELL and SWAP capture, invalid source/origin/amount/network/expiry, edited/pending capture protection, exact and tampered settlement, failed reads, reloads, duplicate/unknown outcomes, cross-tab Web Locks, stale durable attempts, legacy recovery/export and storage failures. Evidence is ignored under `artifacts/lightning`; the fixture build is ignored under `artifacts/lightning-server`. Browser emulation does not prove installed native-app behavior, live provider activation, receiving-side support or live CORS/settlement.

Dependencies are pinned to the production SDK/decoder versions. `npm audit` currently reports low-severity elliptic/secp256k1/bolt11 advisories (the app decodes; it does not sign invoices) and moderate development-tool advisories. No automatic major downgrade or unrelated dependency rewrite is applied to payment code. Audit results are not a security certification; review decoder exposure and upstream fixes before broader release. Vite also warns about the existing large combined application chunk.
