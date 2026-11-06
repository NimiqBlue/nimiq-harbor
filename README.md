# Harbor

A mini app for Nimiq Pay: buy and sell crypto by bank transfer without KYC up to **CHF 999 per rolling 30-day period**, swap Polygon tokens and send payments from your wallet.

- **Bank:** fiat buying and selling through an embedded Mt Pelerin widget. No-KYC bank transfers are available up to CHF 999 in total exchange volume per rolling 30 days (or the equivalent in other currencies).
- **Swap:** USDC ↔ USDT0 on Polygon through 1inch Fusion, with a fixed 15-minute order deadline.
- **Pay:** POL, USDT0, USDC and WBTC transfers, with fee review and a fee-aware POL Max.

## Run locally

Install **Node.js 24–26** and npm, then run these commands from the repository root:

```sh
npm ci --ignore-scripts
cp .env.example .env
npm run dev
```

Open **http://localhost:14173**. The launcher starts the frontend and backend together; `/api` is proxied to the backend on port 18787. Stop both with Ctrl+C. Use `localhost` consistently and keep development dependencies installed.

No API keys are needed to start the app. Unconfigured integrations show an unavailable state, not demo quotes. Wallet features require a compatible injected wallet or Nimiq Pay.

To serve the compiled frontend and API from one process instead:

```sh
npm run build
APP_ORIGIN=http://localhost:18787 npm start
```

Open http://localhost:18787. The environment assignment above uses POSIX-shell syntax. Keep local HTTP in development mode; production requires HTTPS. Never disable origin or execution guards to make a demo work.

## Configuration

Copy `.env.example` and insert your own values only when needed. Never commit `.env`, database files or diagnostic journals.

| Variable | Purpose |
| --- | --- |
| `VITE_MTPELERIN_KEY` | Your widget activation key. Browser-visible; restart or rebuild after changing it. Never use a server-secret key here. |
| `ONEINCH_API_KEY` | Server-only credential for Fusion quotes. |
| `FUSION_EXECUTION_ENABLED` | Defaults to `false`. Execution additionally requires HTTPS `APP_ORIGIN`, an HTTPS `POLYGON_RPC_URL`, a 1inch key and persistent encryption. |
| `TOKEN_ENCRYPTION_KEY` | Persistent encryption key: base64 of 32 random bytes. Keep private and stable across restarts. |
| `POLYGON_RPC_URL` | Server-side Polygon RPC endpoint; keep credential-bearing URLs private. |
| `APP_ORIGIN` | Exact browser origin; defaults to `http://localhost:14173`. |
| `HOST` / `PORT` | API bind address and port; defaults are `127.0.0.1` / `18787`. |
| `HARBOR_DB_PATH` | Writable local SQLite path, supplied in the example. |
| `NODE_ENV` | `development` for loopback HTTP; HTTPS is required in production. |

Generate an encryption key privately when required:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Provider access may require activation and additional account configuration, not just an API key. Keep execution disabled while evaluating. That flag does **not** disable Pay transfers or wallet requests during manual use.

## Privacy

The Bank widget loads directly from Mt Pelerin. Harbor does not proxy its requests or receive the phone numbers, SMS codes, IBANs, identity documents, KYC data or order details entered within it. Those are handled by Mt Pelerin under its privacy policy.

Pay and Swap separately process wallet addresses and operational data. Copied recipient/amount details may be shared with RPC services; blockchain activity is public and not necessarily anonymous. Hosting infrastructure may receive ordinary access metadata such as IP addresses. See the in-app Privacy page.

## Checks and limitations

```sh
npm run check
npm run build
npm test
npx playwright install chromium
npm run test:e2e
```

The offline tests exercise API/SDK control flow, deadline, approval, recovery and replay protections using synthetic provider/chain evidence and mocked signature recovery. Browser checks use simulated wallet/RPC responses at mobile and desktop widths and block external requests. They do not sign or send transactions. Linux may need additional Chromium system libraries; `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can select an existing browser.

These checks do **not** prove live widget activation, every wallet/WebView's compatibility, real gas costs, liquidity, resolver acceptance or on-chain settlement. No funded wallet is needed for tests. Install/download steps require internet access.

An optional recovery path verifies operator-signed attestations. Its public verification key is included, but the signing service and private key are not. Other operators must configure their own trust/signing process; missing evidence leaves recovery unavailable, never implicitly approved.

This source release excludes production credentials, private history, runtime data and artwork/fonts without cleared redistribution rights. Text identifiers and system fonts replace excluded branding. Experimental WBTC Swap support is not included; WBTC remains available in Pay. Dependency security patches and portable launch configuration intentionally differ from the original production packaging.

## License

Harbor code is [MIT licensed](LICENSE). Dependencies retain their own terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `THIRD_PARTY_LICENSES.txt`. Verify their generated inventory after lockfile changes with `python3 scripts/generate-license-notices.py --check` (requires Python 3 and public npm access). No trademark rights are granted.

