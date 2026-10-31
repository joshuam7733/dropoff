# Drop Off · backend guide

Drop Off runs on **Supabase**: Postgres with Row Level Security, Supabase Auth (phone OTP, Google, e-mail), private Storage buckets with signed URLs, Realtime, and Edge Functions for payments and SMS.

You can run it in two ways:
- **Locally without Docker**, using the bundled dev server.
- **On a hosted Supabase project.**

---

## 1. Architecture in one picture

```
 Browser / Android WebView (prototype/)            Supabase
 ┌──────────────────────────────┐                ┌───────────────────────────────────────────────┐
 │ supabase-js (anon key + JWT) │── rpc() ──────▶│ SECURITY DEFINER functions (all writes)        │
 │ store.js / api.js            │◀─ app_state() ─│ SECURITY INVOKER app_state() filtered by RLS   │
 │ Leaflet map (OSM tiles)      │◀─ realtime ────│ postgres_changes → client refetches            │
 │                              │── storage ────▶│ private buckets, folder-based policies         │
 │                              │── functions ──▶│ Edge Functions (Deno)                          │
 └──────────────────────────────┘                │   payments-initiate  (user JWT)                │
        ▲  approve on phone                      │   payments-webhook   (provider → re-query)     │
        │                                        │   payments-reconcile (cron, every minute)      │
 Mobile money / card provider ◀────────────────▶ │   payments-sandbox   (test "phone prompt")     │
 Africa's Talking SMS ◀───────────────────────── │   send-sms-hook / sms-dispatch / recipient-proof│
                                                 └───────────────────────────────────────────────┘
```

Rules that everything follows:
- **Clients never write tables.** Every change is an RPC that checks `auth.uid()` and the caller's `profiles.role`. A role sent by the client is never trusted.
- **Clients read what RLS allows**, mostly through `app_state()`.
- **Money moves only inside `payment_apply_result()`.** That function runs with the service role and only after the provider's answer has been fetched by the server.
- **The service-role key exists only inside Edge Functions.** `scripts/gen-config.mjs` refuses to put it into the app.

---

## 2. Run locally (no Docker)

```bash
powershell -ExecutionPolicy Bypass -File devserver\restart.ps1
```

- **App:** http://localhost:3000. It includes `app.html`, `track.html`, `demo.html` (four sessions side by side) and `index.html` (the website).
- **API:** http://localhost:54321. It covers auth, REST/RPC, storage, realtime and functions.
- **Dev inbox:** http://localhost:54321/dev/mailbox. It shows the e-mails and **SMS codes** the server "sent".
- **Payment sandbox:** opened from the app's "Open sandbox phone prompt" button.
- **Demo accounts:**
  - password `DropOff#2026`: `ops@`, `rose@`, `pharmacy@`, `homestyle@`, `freshmart@`, `moses@`, `peter@`, `brian@`, `joseph@`, `faith@`, `daniel@`, `aisha@`, `ronald@`, `samuel@`, `kenneth@` (all `@dropoff.test`).
  - The demo phones also sign in with an SMS code. Moses, for example, is 0779 004 221.
- **Google sign-in** shows a clearly labelled local stand-in page. On hosted Supabase it is the real Google consent screen.
- **Reset the data:** stop the server, delete `devserver/.data`, and start it again. That re-applies the migrations and the seed.
- **Tests:**
  - `tools\node\node.exe devserver\test-api.mjs` runs 102 end-to-end checks, using real sessions for each role.
  - `tools\node\node.exe devserver\check-sql.mjs` applies every migration and the seed to a throwaway database.

The dev server (`devserver/server.mjs`) is a test harness. It runs the same SQL on PGlite (Postgres compiled to WebAssembly), a GoTrue subset, storage, realtime and the **same payment core** (`supabase/functions/_shared/payments/*.mjs`) as the Edge Functions.

It is **not** for production:
- It uses a fixed, public JWT secret.
- Its realtime does not filter by RLS. The payloads carry no row data, and clients refetch through RLS.

---

## 3. Deploy to a hosted Supabase project

1. **Create the project** at supabase.com, in the region closest to Uganda (e.g. `eu-west`).
2. **Apply the schema** with the Supabase CLI:
   ```bash
   supabase link --project-ref YOUR-REF
   supabase db push
   ```
   This applies `supabase/migrations/*` in order. **Do not** run `supabase/seed.sql` on production: it creates demo accounts with a public password.
3. **Create the first ops user.** Sign up normally, then promote the account in the SQL editor:
   ```sql
   update public.profiles set role = 'ops' where email = 'you@yourcompany.com';
   ```
   Sign-up can never create ops accounts.
4. **Auth settings** (Dashboard → Authentication):
   - **URL configuration:**
     - Site URL = `APP_URL`.
     - Redirect URLs = `APP_URL/app.html`, `/app-vendor.html`, `/app-rider.html`, `/track.html`.
   - **Phone provider:** turn it on, then **Hooks → Send SMS hook** → HTTPS → `https://YOUR-REF.supabase.co/functions/v1/send-sms-hook`. Copy the hook secret into `SEND_SMS_HOOK_SECRET`.
   - **Google:**
     1. Create an OAuth client (Web) in Google Cloud.
     2. Set its redirect URI to `https://YOUR-REF.supabase.co/auth/v1/callback`.
     3. Paste the client ID and secret into the Google provider settings.
   - **E-mail:** keep confirmations on. Set up custom SMTP for real deliverability.
5. **Edge Functions:**
   ```bash
   supabase functions deploy payments-initiate
   supabase functions deploy payments-webhook --no-verify-jwt
   supabase functions deploy payments-reconcile --no-verify-jwt
   supabase functions deploy payments-sandbox --no-verify-jwt     # only while PAYMENT_PROVIDER=sandbox
   supabase functions deploy recipient-proof --no-verify-jwt
   supabase functions deploy send-sms-hook --no-verify-jwt
   supabase functions deploy sms-dispatch --no-verify-jwt
   supabase secrets set --env-file .env.functions   # see .env.example: CRON_SECRET, PAYMENT_PROVIDER, AT_*, MTN_*…
   ```
6. **Schedule the cron jobs** (Dashboard → Integrations → Cron, or `pg_cron` + `pg_net`). Run each every minute, with header `x-cron-secret: CRON_SECRET`:
   - `POST /functions/v1/payments-reconcile`
   - `POST /functions/v1/sms-dispatch`
7. **App settings** (SQL or the ops Config tab):
   ```sql
   update public.app_settings set value = '"https://app.example.com/track.html?t="' where key = 'tracking_base_url';
   update public.app_settings set value = '"live"' where key = 'sms_mode';   -- once Africa's Talking is configured
   ```
8. **Point the apps at the project:**
   ```bash
   node scripts/gen-config.mjs
   ```
   This writes `prototype/config.js`. Host `prototype/` on any static host (Netlify, Vercel, Cloudflare Pages, Supabase Storage) at `APP_URL`, then rebuild the Android apps (`android\build.ps1`).
9. **Check:** run the test script against the hosted project with `SUPABASE_URL=… node devserver/test-api.mjs`. It needs the dev-only endpoints `/dev/keys` and `/dev/inbox.json`, so on hosted projects run the checks by hand, or adapt the script to read the anon key from `.env`.

---

## 4. Database at a glance

| Area | Tables |
|---|---|
| People | `profiles` (role new/vendor/rider/recipient/ops, phone_verified_at, NIN, DOB), `vendors`, `vendor_staff`, `vendor_locations`, `riders`, `vehicles`, `rider_locations` |
| Deliveries | `deliveries` (15-status state machine via `delivery_transitions` + trigger), `delivery_secrets` (PINs, token; column grants), `packages`, `recipients`, `delivery_offers`, `delivery_events`, `delivery_messages`, `proof_of_delivery`, `recipient_links` |
| Money | `payments` (provider, direction, idempotency key, approval, review flags), `payment_events` (append-only provider log), `payment_sandbox`, `wallets`, `wallet_transactions` (ledger) |
| Trust | `verification_requests` (+ risk_flags), `documents`, `audit_log`, `support_tickets`, `disputes`, `notifications` (in-app + SMS outbox) |
| Reference | `places` (real WGS84 coordinates), `service_areas`, `vehicle_classes`, `package_sizes`, `pricing_rules`, `app_settings` |

**Storage buckets (all private):**
- `avatars`
- `documents` (KYC files: owner and ops only)
- `proofs` (delivery photos and signatures)
- `package-photos`

Reads use short-lived signed URLs. Recipients get proof photos through the `recipient-proof` function, after their token and phone digits are checked.

---

## 5. Payments (provider-neutral)

```
app ── payment_start_topup / create_delivery(momo) / request_payout ──▶ payments: pending (nothing credited)
app ── payments-initiate ──▶ claim (owner check) ──▶ provider.collect / disburse ──▶ payments: initiated
customer approves with their PIN on their own phone (or hosted card page)
provider ── callback ──▶ payments-webhook ──▶ provider.status(ref)  ← the callback body is never trusted
                                         └─▶ payment_apply_result: amount + currency must match exactly,
                                             final states never change, replays are no-ops ──▶ ledger
cron ── payments-reconcile ──▶ sends forgotten payments, re-checks open ones, expires prompts after 30 min
```

- **Collections:**
  - A top-up credits the wallet.
  - A mobile money or card booking stays a `draft`, invisible to drivers, until the money is confirmed. Then it is reserved and published.
  - A failed payment cancels the draft.
- **Disbursements (rider cash-out, vendor withdrawal):**
  - Only for ops-verified accounts.
  - Only to the account's **OTP-verified phone**.
  - Paused for 24 hours after a phone change.
  - One in flight at a time.
  - The amount is debited as `pending` and reversed in full if the transfer fails or ops reject it.
  - Above `payout_approval_threshold` (UGX 500,000), **ops approve first** (maker-checker).
  - Before sending, the network's account-holder name is compared with the verified name. A mismatch holds the payout for ops.
- **Limits by KYC level** (`app_settings.kyc_limits`):
  - Level 0 = phone not verified (no mobile money, no cash-out).
  - Level 1 = phone verified (UGX 2M per payment, 5M per day).
  - Level 2 = ops-verified (UGX 20M / 50M, cash-out up to 5M per day).
- **Ops console → Payments:**
  - payments needing action
  - the provider log for every payment
  - approve or reject cash-outs
  - clear review flags (with a note)
  - **ledger check**: every wallet equals its ledger sum, and every confirmed collection has exactly one credit
- **Adapters** (`supabase/functions/_shared/payments/`):
  - `sandbox.mjs` (default)
  - `mtn-momo.mjs`, a reference implementation of MoMo Collections and Disbursements. It is **not yet tested with real credentials**: test it in MTN's sandbox, where the currency is EUR.
  - Airtel Money or an aggregator (Flutterwave, Pesapal, Yo! Payments) is another file with the same five methods: `collect`, `disburse`, `status`, `lookupName`, `parseWebhook`.
- **Switching provider:**
  1. Set `PAYMENT_PROVIDER` in the function secrets **and** the `payment_provider` app setting, at the same time.
  2. Deploy.
  3. Payments created under the old provider are refused by the new one rather than misapplied.

---

## 6. Identity (KYC)

- **Phone ownership** is proven by Supabase Auth OTP, either at sign-in or with `updateUser({ phone })` + `verifyOtp(type 'phone_change')`. A trigger mirrors it into `profiles.phone_verified_at`.
- **Riders** submit:
  - their NIN and date of birth (format and age 18+ are checked)
  - a National ID, a selfie holding the ID, a driving permit and the vehicle logbook
- **Business owners** submit their NIN, a National ID and one business document.
- **Duplicate NINs** across accounts are flagged to ops (`risk_flags`).
- **Ops review by hand.** Drop Off does **not** verify NINs with NIRA; the UI says so. An identity provider such as Smile ID can be added later in `save_kyc` / ops review.

---

## 7. Environment variables

- **App (public, in `config.js`):** `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `APP_URL`, optional `MAP_TILE_URL` / `MAP_TILE_ATTRIBUTION`.
- **Edge Functions (secrets):**
  - general: `APP_ORIGIN`, `CRON_SECRET`
  - payments: `PAYMENT_PROVIDER`, `SANDBOX_WEBHOOK_SECRET`, `MTN_MOMO_*`
  - SMS: `AT_USERNAME`, `AT_API_KEY`, `AT_SENDER_ID`, `SEND_SMS_HOOK_SECRET`
  - provided by Supabase: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- **Auth providers:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SEND_SMS_HOOK_URI`.

See `.env.example`.

---

## 8. Before real money

- Sign merchant agreements (MTN MoMo and Airtel Money, or an aggregator), then run the adapter against their sandbox and certify it.
- **Regulation:** holding customer balances in a wallet and paying out to third parties in Uganda is likely regulated under the **National Payment Systems Act 2020** (Bank of Uganda licensing, or operating through a licensed partner or escrow arrangement). Get legal advice before go-live. This is not legal advice.
- Register with the **Personal Data Protection Office** (Data Protection and Privacy Act 2019). Publish the terms and privacy notice the app links to, and set retention periods for KYC documents.
- Map tiles: move from OpenStreetMap's public tiles (fair-use) to a commercial tile provider with a key.
- Use real SMS sender ID registration with Africa's Talking (`AT_SENDER_ID`).
