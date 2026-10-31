# Drop Off

Delivery platform for Kampala businesses. It covers four parts:
- **Vendors** book riders and drivers.
- **Riders and drivers** accept jobs, deliver them with proof, and cash out to mobile money.
- **Recipients** track the delivery and confirm it with a PIN, without needing an account.
- **Ops** run the network from a console.

## What's here
| Path | What it is |
|---|---|
| `prototype/` | The web apps (no build step). `index.html` is the website. `app.html` is the app for every role, routed by the signed-in account. `track.html` is the recipient page. `demo.html` shows four live sessions side by side. `app-vendor.html` / `app-rider.html` are the pages the Android apps load. |
| `supabase/migrations/` | Database schema, business logic, row-level security, storage, read model (apply in order). |
| `supabase/functions/` | Edge Functions: payments (initiate, webhook, reconcile, sandbox), SMS (Africa's Talking OTP hook and dispatcher), recipient proof. |
| `supabase/seed.sql` | **Development-only** demo accounts and history. |
| `devserver/` | Local Supabase-compatible backend (no Docker), the end-to-end API test (`test-api.mjs`) and the security audit (`audit-grants.mjs`). |
| `scripts/gen-config.mjs` | Writes `prototype/config.js` from `.env` for a hosted Supabase project. |
| `android/` | Native WebView shell and build script. The APKs are in `android/out/`. |
| `BACKEND.md` | Setup, deployment, payments, KYC and environment variables. **Start here.** |

## Run it locally
```bash
powershell -ExecutionPolicy Bypass -File devserver\restart.ps1
```
1. Open http://localhost:3000/demo.html to see every role at once, or http://localhost:3000/app.html for a single app.
2. Sign in:
   - **Demo accounts:** password `DropOff#2026` (`rose@dropoff.test`, `moses@dropoff.test`, `ops@dropoff.test` …).
   - **Phone:** any Ugandan number. The SMS code appears in the dev inbox at http://localhost:54321/dev/mailbox.
3. Payments use the **sandbox provider**. The app shows "Open sandbox phone prompt", where you approve or decline, playing the customer's phone. No real money moves.

## Android
`android/out/` contains:
- `DropOff-Business.apk`
- `DropOff-Rider.apk`
- `DropOff-All.apk` (every role, including ops)

They are signed with a demo key. Install them on Android 8+ and allow "Install unknown apps".

- **Current build (default): on-device.** The real database (Postgres via PGlite), the backend (`devserver/core.mjs`, the same code as the dev server) and the demo data run inside the app. It works on any phone with no server. Each phone keeps its own data, payments use the in-app sandbox, and SMS codes appear on screen. Rebuild with:
  ```bash
  powershell -ExecutionPolicy Bypass -File android\build.ps1
  ```
- **Shared, real-time data across phones:** run `node scripts/gen-config.mjs` for a hosted Supabase project, then `android\build.ps1 -Hosted`.
- **Dev server on this PC over Wi-Fi:** `android\build.ps1 -DevHost <this PC's Wi-Fi IP>`.
- **Sign-in on Android:** phone code or e-mail. Google blocks sign-in inside app WebViews, so "Continue with Google" appears only on the web.

## Status
- **Real:** the backend, roles and security, deliveries, live GPS, proof of delivery, ledger, KYC workflow, phone OTP, Google sign-in (on hosted Supabase) and the provider-neutral payment flow.
- **Sandbox until contracts and keys exist:** the payment provider, SMS delivery and Google OAuth client.

See `BACKEND.md` §8, "Before real money".
