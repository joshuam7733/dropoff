# Drop Off — project state

_Last updated: 2026-10-18. Snapshot of where the project stands and exactly where to pick up._

---

## 0. Resume here (short version)

**Current phase:** Phase 5 is complete (2026-10-19). Sections 1–10 below describe phase 4; section 11 describes phase 5.

**Status:**
- **Backend:** passes **102/102** end-to-end API checks (`devserver/test-api.mjs`) and the grants/RLS audit (`devserver/audit-grants.mjs`).
- **UI:** clicked through end to end in the built-in browser:
  - phone OTP sign-up and onboarding
  - Google (dev stand-in)
  - mobile money top-up
  - mobile money booking
  - rider accept and delivery
  - recipient PIN confirmation
  - rider cash-out
  - ops payments and the ledger check
- **Docs and setup:**
  - Docs: `BACKEND.md` and `README.md`.
  - Setup files: `.env.example`, `scripts/gen-config.mjs`, `supabase/config.toml` and `.gitignore`.
- **APKs:** rebuilt as **dev LAN builds** pointing at `http://192.168.110.121:54321`.

**To resume:**
1. Start the local backend:
   ```
   powershell -ExecutionPolicy Bypass -File devserver\restart.ps1
   ```
   Then open `http://localhost:3000/demo.html`.
2. Next real steps are decisions or accounts only the owner can provide:
   - a hosted Supabase project
   - payment provider contracts (MTN/Airtel or an aggregator)
   - Africa's Talking keys
   - a Google OAuth client
   - legal review of wallet regulation (National Payment Systems Act)

   See `BACKEND.md` §3 and §8.
3. Known gaps are listed in section 11, "Remaining".

---

## 1. What Drop Off is

A B2B delivery and logistics platform (Kampala). It is not ride-hailing and not a consumer marketplace.

- **Vendors** (businesses) book deliveries.
- **Riders/drivers** (boda → car → minivan → pickup → truck) see jobs that fit their vehicle and accept them.
- **Recipients** track a delivery through a secure link (no account needed) and confirm it with a PIN.
- **Operations** monitors the network, verifies people and intervenes.
- Proof of delivery is central.

---

## 2. Project history and deliverables

| Phase | What | Status |
|---|---|---|
| 1 | High-fidelity design canvas (60 artboards) — artifact https://claude.ai/artifact/GQ2A3H5BmFaPHEjkkrLu6R | Done. Static design reference. |
| 2 | Functional single-browser prototype (localStorage, simulated network) — artifact https://claude.ai/artifact/2SnSZ9gNDkQNmkWH7EGkL3 | Done. **Superseded by phase 4.** The artifact still shows the old simulated version. |
| 3 | Android WebView APKs (`android/out/*.apk`) | Built from the **phase-2** code. **They must be rebuilt** for phase 4 and are not yet tested on hardware. |
| **4** | **Real backend MVP: Supabase (Postgres, Auth, RLS, Storage, Realtime), real auth, verification, shared data across all roles** | **In progress** (sections 4–10). |

---

## 3. Architecture (phase 4)

```
prototype/ (static web app, no build step)        supabase/ (the real backend definition)
  index.html  → marketing website                    migrations/  6 SQL files (schema, logic, API, read model,
  app.html    → the app: splash → session → role                  reference data, security)
  track.html  → recipient tracking (token + code)    seed.sql     DEV-ONLY demo accounts + history
  demo.html   → 4 iframes, 4 separate sessions
  app-vendor.html / app-rider.html → Android entries devserver/ (local Supabase-compatible backend for dev/test)
  config.js   → window.DO_CONFIG {supabaseUrl,          server.mjs  :54321 API, :3000 app
                 supabaseAnonKey}                     shim.sql    Supabase auth/storage/roles emulation
  lib/        → preact, htm, supabase-js (UMD)        test-api.mjs end-to-end API test (57 checks)
  js/         → data, store, api, ui, auth, vendor,   check-sql.mjs applies migrations+seed to in-memory PG
                rider, recipient, ops, site, main     restart.ps1 start/restart in background
```

### 3.1 Backend (Supabase)
- **Postgres** is the single source of truth. There is one `deliveries` row per delivery. Vendor, rider, recipient and ops all read that same row.
- **Writes:** clients never write tables directly. Every change goes through about 60 `SECURITY DEFINER` RPC functions in `20261007000300_api.sql`.
  - Each function checks `auth.uid()` and the role in `profiles`. A role sent by the client is never trusted.
- **Reads:** `app_state()` is `SECURITY INVOKER`, so **RLS decides what each user receives**. It returns one JSON snapshot for the signed-in user.
  - Recipients (anonymous) read only through `recipient_view(token, code)`.
- **State machine:**
  - The `delivery_transitions` table holds the 15 statuses: draft, pending, searching, assigned, en_route_pickup, at_pickup, picked_up, in_transit, approaching, arrived, awaiting_confirmation, delivered, failed, cancelled, disputed.
  - The trigger `_guard_status` rejects any invalid move.
  - `_set_status()` runs the side effects: events, notifications, SMS records and settlement.
- **Ledger:** `wallets` and `wallet_transactions`.
  - Balances change only in `_wallet_post()`, with `CHECK` constraints for no overdraft and the credit limit.
  - Money is held at booking, captured on delivery, refunded 50% on failure and in full on cancel.
  - Dispute refunds go to the main wallet, and the rider is deducted half.
  - Reattempts are handled without double charging (logic in `_settle_*`, `_release_hold`, `resolve_failed`).
- **Payment provider seam:** `_provider_charge()` is **simulated**. Every payment has `simulated = true` and the UI says so.
- **Pricing:** `_quote()` / `_grid_len()` use integer maths identical to the client (`store.js quote()`). The server recomputes the price and rejects a stale `quoted_total`.
- **Matching:** this is a real driver action, not auto-assignment.
  - A new `searching` delivery is visible (via RLS) to every verified driver whose vehicle fits (`_rider_fits`), and is pushed to online drivers as an "offer" notification.
  - The first `accept_delivery` wins (row lock). `decline_delivery` hides the job for that driver.
  - Ops can `ops_assign` / `ops_reassign`, including a handover after pickup.
  - `no_driver` is flagged when nobody eligible is online, and cleared when a fitting driver goes online.
- **PINs and tokens:** these live in `delivery_secrets`.
  - Column grants let vendors read only `pickup_pin` and `tracking_token`. **Nobody can SELECT `delivery_pin`.**
  - Wrong delivery PINs: an ops alert at 3, a lock for 10 minutes at 5.
  - Wrong recipient codes: a lock for 15 minutes at 8.
- **Location:** the `rider_locations` table holds only the device's real GPS (`rider_update_location`).
  - Setting a delivery to `approaching` automatically depends on that GPS.
  - An optional arrival geofence (`app_settings.enforce_geofence`, off by default).
  - Without a fix, the UI shows "estimate" and no rider marker. Nothing is simulated.
- **Verification:**
  - `verification_requests` plus `documents`, stored in the private `documents` bucket.
  - Statuses: pending, submitted, under_review, verified, rejected, suspended, plus `info_requested`.
  - Ops can approve, reject, request info, suspend or start a review. Each decision is audited and notifies the person.
- **Audit:** `delivery_events` is the per-delivery history. `audit_log` is the platform history (registrations, verification, bookings, ops actions, payouts, settings).
- **Storage:** four **private** buckets:
  - `avatars`
  - `documents`
  - `proofs` (pickup/drop photos and signatures)
  - `package-photos`

  Each has path-based RLS policies. Reads use signed URLs. Recipients get proof photos through the Edge Function `recipient-proof` (service role). That function exists in the devserver but **not yet** in `supabase/functions/` (see section 10).
- **Realtime:** the tables are in the `supabase_realtime` publication. The client subscribes and refetches `app_state()` on any change, with polling every 8 s or 30 s as a safety net.

### 3.2 Frontend (`prototype/js`)
- **`store.js`** is the read model.
  - `S.load(raw)` maps the snapshot into the shapes the existing screens use. A delivery's `id` is its ref (DO-48xxx) and its `uuid` is the real id.
  - It holds pricing, validation and the grid route maths.
  - `S.act.*` are async wrappers: RPC, then `D.api.refresh()`.
  - The simulation engine, autopilot, seed data and demo panel are removed.
- **`api.js`** contains:
  - the supabase client (`storageKey` per `?slot=` so `demo.html` can hold four sessions)
  - auth: sign in, sign up, sign out, reset, update password
  - snapshot loading, realtime and polling
  - storage upload and signed-URL cache
  - public reference data for signed-out screens (`loadPublic`)
  - the GPS service `D.loc`, which can be swapped for a production provider
  - the payments label
- **`auth.js`** has the welcome screens (business or rider), sign in, business registration, rider/driver registration (with a plate-availability check), forgot password, reset password, e-mail confirmation and the suspended screen.
- **`vendor.js`, `rider.js`, `recipient.js`, `ops.js`, `site.js`** keep the existing design but use real data:
  - Vendor and rider apps now have verification document upload, a profile/vehicle editor, notifications and real photo capture/upload.
  - The ops console has new Verification, SMS outbox and Audit log tabs, account suspension, credit limits and delivery-rule settings.
- **`main.js`** is the shell:
  - a launch animation (`#splash` markup in the HTML plus CSS in `app.css`, about 1.1 s, respects reduced motion)
  - then routing by `profiles.role` from the database: vendor, rider, ops (full-width console) or recipient
  - Android back handling (`D.androidBack`)
- **`ui.js`** changes:
  - `D.run` awaits server calls (no fake latency).
  - `PhotoCapture` uses the real camera/file input and uploads compressed JPEGs.
  - `PhotoView` and `SigView` load from storage.
  - `MapView` draws a rider only with a real fix (prop `rider` override for the recipient page).

### 3.3 Local dev backend (`devserver/`)
- Portable **Node 20** is in `tools/node/` (not system-wide). npm packages are PGlite 0.5.8 (Postgres 18 + pgcrypto, WASM), ws and @supabase/supabase-js.
- **`server.mjs` implements the Supabase API subset the app uses:**
  - Auth: signup with auto-confirm, password and refresh-token grants, user get/update, logout, recover/verify with a **dev mailbox** at `/dev/mailbox`
  - REST: `rpc/*` runs as the anon/authenticated/service role with JWT claims, so RLS is enforced for real. Simple GETs work too.
  - Storage: upload, sign and download, with `storage.objects` RLS enforced.
  - `/functions/v1/recipient-proof`
  - Realtime over phoenix vsn 2.0
  - Static app on :3000
- The database persists in `devserver/.data/pg`.
- On first start it applies `shim.sql`, then the migrations, then `seed.sql`.
- It writes `prototype/config.js` with fixed dev keys. It only does this if the file is missing or devserver-generated.
- The fixed dev JWT secret is **for development only**.

---

## 4. What is implemented and verified

**Automated API end-to-end test** (`tools\node\node.exe devserver\test-api.mjs` while the server runs): **57 passed, 0 failed.** It covers:
- **Accounts:**
  - vendor sign-up creates the profile, vendor, wallet and location
  - asking for the ops role at sign-up yields recipient
  - a non-ops user can't call ops functions
  - an outsider reads no deliveries
- **Booking:**
  - wallet top-up
  - a booking validation error
  - booking reserves the amount
  - the vendor sees the pickup PIN and tracking token
- **Matching and access:**
  - an eligible boda rider sees the job, without the recipient's details
  - a car driver doesn't see a boda-only job
  - a rider cannot read `delivery_pin`
  - only the first driver to accept wins
  - vendor and ops see the assignment
- **Recipient link:** wrong digits are rejected, and the right ones show the same delivery and rider without full phone numbers.
- **Pickup:**
  - real GPS location update
  - private photo upload, refused for other drivers
  - wrong pickup PIN refused, right one accepted
  - in transit is visible to vendor, ops and recipient (with live location)
  - signed URLs: vendor yes, anonymous no
- **Handover:**
  - wrong delivery PIN refused
  - the recipient's PIN completes the delivery
  - proof record, payment captured with receipt (simulated), hold released, driver earning
  - vendor, driver and ops notified
  - full lifecycle in the events
  - the recipient-proof function returns a signed photo URL
- **Persistence:** data persists after signing out and back in.
- **Verification:**
  - an unverified rider can't go online
  - submitting needs documents
  - ops sees the request and documents and can open them; vendors can't
  - approval verifies the rider, who can then go online
  - the decision is in the audit log
- **Suspension:** suspension blocks actions, and reactivation works.

**UI checks so far (built-in browser, http://localhost:3000):**
- The app shell, splash and business welcome screen render.
- The registration form validation messages appear.
- **A real UI registration** (Kampala Fresh Juices, `juices@dropoff.test`) succeeded. It routed to the vendor home with real empty data.
- `app_state` takes about 130 ms. Realtime status is "live". No console errors so far.

**Demo seed** (`supabase/seed.sql`, dev only, all `is_demo`, password **`DropOff#2026`**):
- Ops: `ops@`.
- Vendors: `rose@` (Mama Rose Cakes), `pharmacy@`, `homestyle@` (credit), `freshmart@`.
- Riders: `moses@`, `peter@` and `brian@` (boda); `joseph@` and `faith@` (car); `daniel@` and `aisha@` (minivan); `ronald@` (pickup); `samuel@` (truck); `kenneth@` (applicant with a submitted verification).
- All addresses use `@dropoff.test`.
- History is generated **by calling the real RPCs as each user**:
  - delivered deliveries
  - one disputed delivery with an open case
  - one failed delivery that was returned
  - live: in transit to Sarah Achieng, with token `demo2640sarah` and code `2640`
  - live: driver en route to pickup (paid on credit)
  - one searching with no driver
- Plus wallet top-ups and 7 days of rider earnings.

---

## 5. What remains (in order)

1. **UI end-to-end test of the whole journey** (the 37 steps in the brief) through the real screens, then fix the bugs it finds. Expected areas to check:
   - wizard → booking
   - rider offer overlay and job board
   - photo upload from `<input type=file>` (in tests, set files with DataTransfer through javascript_tool)
   - PIN pads
   - signature save
   - recipient `track.html` (verify → track → confirm → proof)
   - ops tabs: verification review, disputes, config
   - `demo.html` with four sessions
   - website tracking form and CTAs
   - password reset through the dev mailbox
   - responsive check at 375 px and on desktop
   - console error sweep
2. **Supabase project files still missing:**
   - `supabase/config.toml`
   - `supabase/functions/recipient-proof/index.ts` (Deno, service role: call `recipient_proof_paths`, then `createSignedUrl`)
   - `supabase/functions/sms-dispatch/index.ts` (provider hook; marks SMS rows, Africa's Talking when `AT_API_KEY` is set)
3. **Configuration:**
   - `.env.example` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `APP_URL`; service role only for the functions)
   - `scripts/gen-config.mjs` (writes `prototype/config.js` from `.env`)
   - `.gitignore` (`.env`, `devserver/.data`, `prototype/config.js`, `node_modules`, `tools/`)
4. **Docs:**
   - `BACKEND.md`: setup on a real Supabase project (migrations, seed only for dev, Auth URL and redirect settings, buckets, RLS summary, Edge Function deploy, the `tracking_base_url` setting, promoting an ops user with SQL), plus the local devserver guide
   - update `README.md`
   - delete or update the leftover `devserver/probe.mjs` (scratch)
5. **Android rebuild** with `android\build.ps1`. It has not been re-run since the move to the path with a space.
   - The build must copy `lib/supabase.js` and `config.js`.
   - `app-demo.html` was deleted: replace the demo APK with the universal `app.html`, or drop it.
   - The APK needs a reachable Supabase URL, because a phone cannot reach the PC's localhost.
6. **Final audit and fixes** (brief section 38), then the **final implementation report** (brief section 39 list).
7. Optionally republish the web artifact. Note that it can't reach a backend unless one is configured.

---

## 6. Important design decisions

- **The design is preserved.** Same colours, fonts, components and layouts. Only screens needed for real functionality were added: auth, verification, profile/vehicle, and the ops Verification, SMS outbox and Audit tabs. These reuse the existing classes.
- **Supabase is the backend.** The local devserver is only a dev/test harness. Without Docker, it was the only way to run the real SQL and RLS and test end to end on this PC.
- **RPC-only writes plus RLS-filtered snapshot reads.** This keeps the existing synchronous screen code (which reads `S.state`) and puts every rule on the server.
- **Roles live in `profiles.role` and are enforced server-side.** Sign-up can only create vendor, rider or recipient. Ops accounts are promoted with SQL by an administrator.
- **A delivery is visible to all fitting drivers. The first to accept wins.** The system ranks but never auto-assigns. Ops can assign.
- **The PIN can be confirmed by the rider (the existing design) or by the recipient on `track.html`** (as the brief asks). Both go through one server check with attempt limits.
- **No fake GPS.** A position comes only from the device, otherwise ETAs are labelled estimates.
- **Payments are real records with a simulated provider.** Mobile money and card bookings are recorded as a simulated payment into the vendor wallet, then charged. Refunds go to the wallet (or the credit account).
- **Business credit is a controlled credit line for verified vendors.** The UI states it is not a lending product.
- **Recipient phone numbers are masked in recipient payloads.** Riders can't see the recipient before accepting. Riders and vendors can't read each other's private profile fields.
- **The map stays stylised.** The grid has a fixed lat/lng projection (`D.GEO` = the SQL formula in the places seed), so real GPS can plot on it. A maps provider is a later integration.
- **Seed data runs through the real API**, so demo records follow the same rules as live data.

---

## 7. Database / backend status

- **Migrations:** `supabase/migrations/20261007000100…000600`. They apply cleanly (PGlite = Postgres 18).
  - **Not yet applied to a hosted Supabase project.**
  - Possible differences on hosted Supabase (PG 15/17) are untested. Watch for:
    - `security_invoker` views (needs PG15+, which is fine)
    - inserting the seed's `auth.users` / `auth.identities` rows on current GoTrue
    - the storage policy owner
- **Tables:** profiles, vendors, vendor_staff, vendor_locations, riders, vehicles, rider_locations, recipients, packages, deliveries, delivery_secrets, delivery_offers, delivery_events, delivery_messages, proof_of_delivery, recipient_links, payments, wallets, wallet_transactions, notifications, support_tickets, disputes, verification_requests, documents, audit_log, service_areas, places, vehicle_classes, package_sizes, pricing_rules, app_settings, delivery_transitions.
  - Plus the view `drivers`.
  - "users" are Supabase's `auth.users`.
- **Local DB:** `devserver/.data/pg`. It contains the seed plus the API-test records and the `juices@dropoff.test` vendor.
  - To start clean: stop the server, delete `devserver/.data`, then restart. It re-applies the migrations and seed.
- **Edge Functions:** only emulated in the devserver so far.

---

## 8. Files created or changed in phase 4

```
supabase/migrations/20261007000100_schema.sql        29 KB  tables, keys, indexes, sequences, triggers
supabase/migrations/20261007000200_core_logic.sql    37 KB  helpers, pricing, matching, ledger, state machine, settlement
supabase/migrations/20261007000300_api.sql          108 KB  sign-up trigger, ~60 RPCs (vendor, rider, recipient, ops, verification)
supabase/migrations/20261007000400_read_model.sql    15 KB  app_state(), recipient_my_deliveries()
supabase/migrations/20261007000500_reference_data.sql 6 KB  transitions, classes, sizes, pricing, areas, places, settings
supabase/migrations/20261007000600_security.sql      18 KB  grants, RLS, column grants, storage buckets/policies, realtime
supabase/seed.sql                                    23 KB  DEV demo accounts + history (never production)
devserver/server.mjs, shim.sql, test-api.mjs, check-sql.mjs, restart.ps1, package.json (+ node_modules, .data/)
tools/node/                                                 portable Node 20.20.2
prototype/js/data.js, store.js, api.js (new), auth.js (new), ui.js, vendor.js, rider.js, recipient.js, ops.js, site.js, main.js
prototype/index.html (website), app.html (new), track.html (new), demo.html (new), app-vendor.html, app-rider.html
prototype/config.js (generated), lib/supabase.js (new, 207 KB), app.css (splash + app frame styles appended)
prototype/app-demo.html                                     deleted
```

---

## 9. Known issues and risks

1. **The power cut on 2026-10-18 corrupted two files.** `store.js` and `vendor.js` were zero-filled and both were rewritten. An integrity check of all project files now finds no corruption. If anything else looks odd, check for NUL bytes.
2. **UI testing has only just started.** Bugs in the rewritten screens are likely: data shape mismatches between `S.load` and the old screen code, or crash paths when data is missing. Run the full UI pass before calling the work finished.
3. **The devserver realtime does not filter by RLS.** Its payloads carry no row data, only "table changed"; the client then refetches through RLS. Real Supabase Realtime enforces RLS itself.
4. **Signed-out screens need `loadPublic()` for places, zones and classes.** This was fixed just now. The website's estimator still calls `publicRef()` directly.
5. **No real SMS, masked calls, payment provider, maps or routing, or identity checks.** All are clearly labelled: the SMS outbox shows "simulated", and calls are "logged only".
6. **The pickup-to-drop-off route is the stylised grid, not road routing.**
7. **The Android APKs are stale (phase-2 build).** They need rebuilding and a reachable Supabase URL. The demo keystore is not for release.
8. **Hosted Supabase compatibility is unverified** (section 7).
9. **The dev JWT secret and keys are fixed and public in `server.mjs`.** This is acceptable only for local development.
10. **The `prototype/config.js` written by the devserver contains the dev anon key.** It must be regenerated for a real project and is not to be committed.
11. Seeded proof photos and documents reference storage objects that don't exist. The UI shows "Photo not available". This is expected.

---

## 10. Exactly where to resume

1. Start the backend with `devserver\restart.ps1`. Open `http://localhost:3000/app.html` in the built-in browser. The vendor `juices@dropoff.test` may still be signed in.
2. Continue the UI journey:
   - as the vendor:
     - top up 100,000 by MTN (simulated)
     - **New delivery**: Lugogo Mall → Bukoto; recipient with phone 0753…; small, food, 2 kg; boda; pay from the wallet
   - in a second session (`app.html?slot=rider#rider`):
     - sign in `moses@dropoff.test`
     - go online; the offer overlay should appear
     - accept, start trip, arrive, pickup photo, vendor PIN, start delivery, arrive, start handover, drop photo
   - as the recipient (`track.html?t=<token from the vendor's "Share tracking link">`): last 4 digits, then confirm with the PIN
   - verify the receipt, proof, earnings, notifications and the ops view (`app.html?slot=ops#ops`, `ops@dropoff.test`)
   - sign out and back in
3. Fix the bugs found, then complete section 5 items 2 to 7.

---

## 11. Phase 5 (requested 2026-10-18, completed 2026-10-19)

**Built:**
- **Migration:** `supabase/migrations/20261018000100_phase5.sql`.
- **Payment core:** `supabase/functions/_shared/payments/*.mjs`.
- **Edge Functions:** `payments-initiate`, `payments-webhook`, `payments-reconcile`, `payments-sandbox`, `send-sms-hook`, `sms-dispatch`, `recipient-proof`.
- **Dev server additions:** phone OTP, a Google stand-in, a dev SMS inbox and the payment functions.
- **New app code:** `prototype/js/pay.js`, and a rewritten `auth.js` (simple sign-up and onboarding).
- **Map:** Leaflet with OpenStreetMap tiles, plus the `available_drivers()` supply layer.
- **Look and feel:** a new splash animation and a depth layer in `app.css`.
- **Real coordinates and distances:**
  - Places moved to real coordinates.
  - Pricing uses real distance × 1.3.
  - The rider's "Navigate" button opens the phone's maps app.
- **Android:** the shell now has GPS permission and opens external links in their own apps; the APKs are rebuilt.

**Bugs found and fixed during UI testing:**
- The splash was cut off by render-blocking CSS. Fonts and Leaflet CSS now load without blocking, and the splash waits for its own `animationend`.
- Cards in the scroll column collapsed. Fixed with `.app-scroll > * { flex-shrink: 0 }`.
- CARTO tiles now require a key, so the map switched to OpenStreetMap with a dark tint.
- Leaflet z-index covered the overlays. The map is now an isolated stacking context and its controls sit bottom-right.
- `D.run` treated a null result from void RPCs as a failure (for example, accepting from the offer didn't open the job).
- The OTP resend timer was lost on navigation.
- The rider/business audience was lost after the Google redirect. It is now kept in `sessionStorage`.

**Remaining:**
- Hosted deploy and real provider credentials (see `BACKEND.md` §8).
- The MTN MoMo adapter is untested.
- No Airtel adapter yet.
- Google sign-in is not available inside the Android WebView (Custom Tabs + deep link needed).
- OSM tiles are fair-use only.
- Seeded KYC documents have no files.
- Recipient tracking links in dev point to localhost.

---

### Original plan (kept for reference)

**User decisions (answered in chat):**
- Payments: provider-neutral layer now, real provider later (no MTN/Airtel/aggregator contract yet).
- Backend: stay local for now. Build Google and phone sign-in plus payment callbacks so they are ready. Test them with dev stand-ins and document how to switch them on.
- SMS / OTP: Africa's Talking, through the Supabase Send SMS Hook.
- KYC / security: use best practice. Miro is not connected, so skip it.

**User requests:**
- Careful payments (mobile money + banking).
- Less flat UI, keeping the colours.
- A real zoom/pan map showing what is available in the area.
- A new opening logo animation.
- Simple sign-up with Google and phone OTP.
- Then finish everything in section 5.

**Plan (new migration `supabase/migrations/20261018000100_phase5.sql`, applied incrementally by the devserver):**

1. **Payments core.** Mobile money is asynchronous; money moves only after the provider confirms.
   - **Schema changes:**
     - Extend `payments`: `direction` (collection/disbursement), `msisdn`, `idempotency_key` (unique per user), `currency`, `expires_at`, `needs_review`/`review_reason`, `approval_status`/`approved_by` (payouts), `checkout_url`.
     - New append-only `payment_events` table, with the provider event id unique for webhook dedupe.
   - **Top-up:** `payment_start_topup` creates a pending payment, and nothing is credited at this point. The Edge Function `payments-initiate` (service role) calls the adapter and marks the payment initiated.
   - **Webhook:** `payments-webhook` treats the callback ONLY as a hint. It re-queries the status from the provider (MTN callbacks are unsigned), verifies the HMAC where the provider supports one, and then calls the service-role-only `payment_apply_result`. That function locks the row, checks that amount and currency match exactly, and enforces the transitions. On success it applies the ledger.
   - **Reconciliation:** `payments-reconcile` (cron) re-checks stale payments and expires them after 30 minutes.
   - **Bookings paid by MoMo, Airtel or card:**
     - The delivery stays `draft` (not visible to drivers) until the payment succeeds; it is cancelled if the payment fails.
     - Card uses a hosted checkout only, so card data never touches Drop Off.
     - Refunds go to the Drop Off wallet.
   - **Payouts (rider cash-out, vendor withdrawal):**
     - Only for verified accounts, only to the OTP-verified phone, and blocked for 24 h after the phone changes.
     - The wallet is debited as pending and reversed if the payout fails.
     - Ops approval (maker-checker) is required above the `payout_approval_threshold` setting.
     - Daily limits depend on the KYC tier.
     - Before the first payout, the account holder's name is checked against the KYC name through the adapter's `lookupAccountName`.
   - **Adapters:**
     - Shared plain-ESM core in `supabase/functions/_shared/payments/` (WebCrypto, so it runs in both Deno and the Node devserver).
     - `sandbox` adapter, with a devserver page `/dev/pay/:id` that plays the role of the phone approval prompt (Approve / Decline).
     - `mtn-momo` reference adapter (requesttopay / transfer / status), marked untested until credentials exist.
   - **Ops:** payouts awaiting approval, payments needing review, and a reconciliation view.
   - **Regulatory note for the report:** holding customer wallet funds in Uganda likely needs a Bank of Uganda licensed partner (National Payment Systems Act 2020). This is not legal advice.
2. **Auth.**
   - Methods: phone OTP (`signInWithOtp` / `verifyOtp`), Google (`signInWithOAuth`), and email.
   - Users from phone or Google get a profile with role `new`. The onboarding screen offers "I send packages" (vendor) or "I deliver" (rider) and calls `complete_signup` with minimal details. The `handle_new_user` body is refactored into `_provision_role`.
   - Phone verification: email and Google users verify their phone through the `phone_change` OTP. An auth.users update trigger syncs `profiles.phone_verified_at`.
   - Consent: add `terms_accepted_at`.
   - **Devserver additions:**
     - `/auth/v1/otp`, verify with types sms and phone_change, and PUT /user with a phone, with OTP codes shown in a dev SMS inbox.
     - `/auth/v1/authorize?provider=google` is a dev stand-in page, clearly labelled.
   - Edge Function `send-sms-hook`: verifies the standard-webhooks signature, then sends through Africa's Talking.
3. **KYC (best practice).**
   - Tiers:
     - Tier 0: phone verified, low limits, no payouts.
     - Tier 1: ops-verified documents, higher limits, payouts and credit.
   - Data: NIN field kept in a restricted column, a selfie document for riders, and duplicate-NIN detection flagged to ops.
   - A provider hook for later NIRA checks (e.g. Smile ID). Never claim government verification.
4. **Map.**
   - Replace the SVG `D.MapView` (`ui.js` ~line 218) with Leaflet 1.9.4 from a CDN and CARTO/OSM tiles, with the tile URL configurable in `config.js`.
   - Zoom/pan, place markers, pickup/drop pins, a route line, and the live rider marker.
   - New RPC `available_drivers()`: coarse (~300 m) positions plus vehicle class, with no identities.
   - **Places:** the `places.lat/lng` values are currently derived from the fake grid. Update them to real Kampala coordinates (e.g. Lugogo Mall 0.3283, 32.6046) and price on real distance: haversine × road factor 1.3 (`_route_km`) in both SQL `_quote` and the store.js mirror. This affects `_grid_len` uses in core_logic (lines 100-127, 508) and api.js line 335.
   - **Rider directions:** the fake turn-by-turn in `rider.js` (lines 44-52) becomes a "Navigate" link that opens the device's maps app.
5. **UI.**
   - Depth: layered shadows, gradients, elevated nav, and press states in `app.css`.
   - A new splash animation: the logo pin drops in, the route draws, then the wordmark reveals. Reduced-motion aware.
   - Simpler sign-up in `auth.js`.
   - A payment waiting screen ("Approve on your phone") and payout status displays.
6. **Seed.** It must still work after the migration: momo and airtel top-ups in the seed have to complete through a pg_temp helper that calls `payment_apply_result` as the service role.
7. **Then section 5:**
   - Update `test-api.mjs` and run it.
   - UI end-to-end test.
   - Config files and edge functions.
   - Docs.
   - Android rebuild.
   - Audit.
   - Final report.
