-- Drop Off · DEVELOPMENT / DEMO SEED. Never run this against production.
-- Creates demo accounts (password for all: DropOff#2026) and a small, realistic history by calling the
-- real API functions as each demo user, so every record (events, payments, ledger, notifications)
-- comes from the same code paths the apps use. Everything created here is flagged is_demo.
--
--   ops@dropoff.test            Operations (Anita Namubiru)
--   rose@dropoff.test           Vendor · Mama Rose Cakes (verified, credit line)
--   pharmacy@dropoff.test       Vendor · Kololo Pharmacy
--   homestyle@dropoff.test      Vendor · HomeStyle Furniture (credit)
--   freshmart@dropoff.test      Vendor · FreshMart Bugolobi
--   moses@ peter@ brian@        Riders · boda
--   joseph@ faith@              Drivers · car
--   daniel@ aisha@              Drivers · minivan
--   ronald@                     Driver · pickup
--   samuel@                     Driver · truck
--   kenneth@                    Driver applicant (pending verification)

create or replace function pg_temp.mk_user(p_id uuid, p_email text, p_meta jsonb) returns void language plpgsql as $$
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at, confirmation_token, email_change, email_change_token_new, recovery_token)
  values ('00000000-0000-0000-0000-000000000000', p_id, 'authenticated', 'authenticated', p_email,
    extensions.crypt('DropOff#2026', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', p_meta,
    now(), now(), '', '', '', '');
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), p_id, p_id::text, jsonb_build_object('sub', p_id::text, 'email', p_email, 'email_verified', true), 'email', now(), now(), now());
end $$;

create or replace function pg_temp.act_as(p_id uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, false);
  select set_config('request.jwt.claim.sub', p_id::text, false);
$$;

create or replace function pg_temp.rider_profile(p_rider_user uuid) returns uuid language sql as $$
  select id from public.riders where profile_id = p_rider_user
$$;

-- Drives one delivery through the rider's steps, as that rider, up to the given status.
create or replace function pg_temp.run(p_delivery uuid, p_rider_user uuid, p_until text) returns void language plpgsql as $$
declare pin text; dpin text; did text := p_delivery::text;
begin
  perform pg_temp.act_as(p_rider_user);
  if not (select online from public.riders where profile_id = p_rider_user) then perform public.rider_set_online(true); end if;
  perform public.accept_delivery(p_delivery);
  if p_until = 'assigned' then return; end if;
  perform public.rider_start_trip(p_delivery);
  if p_until = 'en_route_pickup' then return; end if;
  perform public.rider_arrive_pickup(p_delivery);
  perform public.rider_set_photo(p_delivery, 'pickup', did || '/seed-pickup.jpg');
  select pickup_pin, delivery_pin into pin, dpin from public.delivery_secrets where delivery_id = p_delivery;
  perform public.rider_confirm_pickup(p_delivery, pin);
  perform public.rider_start_delivery(p_delivery);
  if p_until = 'in_transit' then return; end if;
  perform public.rider_arrive_dropoff(p_delivery);
  perform public.rider_start_handoff(p_delivery);
  if p_until = 'awaiting_confirmation' then return; end if;
  perform public.rider_submit_pin(p_delivery, dpin);
  perform public.rider_set_photo(p_delivery, 'drop', did || '/seed-handover.jpg');
  if (select sig_required from public.deliveries where id = p_delivery) then perform public.rider_set_signature(p_delivery, did || '/seed-signature.png'); end if;
  perform public.rider_complete(p_delivery);
end $$;

-- Spreads a seeded delivery's history back in time so timelines and charts look like real days.
create or replace function pg_temp.age(p_delivery uuid, p_start timestamptz, p_step_min int) returns void language plpgsql as $$
declare base timestamptz; shift interval;
begin
  select min(created_at) into base from public.delivery_events where delivery_id = p_delivery;
  shift := base - p_start;
  with e as (select id, row_number() over (order by id) - 1 as rn from public.delivery_events where delivery_id = p_delivery)
  update public.delivery_events x set created_at = p_start + make_interval(mins => (e.rn * p_step_min)::int) from e where x.id = e.id;
  update public.deliveries d set created_at = p_start,
    status_at = (select max(created_at) from public.delivery_events where delivery_id = p_delivery),
    promised_at = d.promised_at - shift where id = p_delivery;
  update public.notifications set created_at = created_at - shift, read_at = case when read_at is null and created_at - shift < now() - interval '2 hours' then now() else read_at end where delivery_id = p_delivery;
  update public.wallet_transactions set created_at = (select max(created_at) from public.delivery_events where delivery_id = p_delivery) where delivery_id = p_delivery and type <> 'charge' and type <> 'topup';
  update public.wallet_transactions set created_at = p_start where delivery_id = p_delivery and type in ('charge', 'topup');
  update public.payments set created_at = p_start, captured_at = case when captured_at is not null then (select max(created_at) from public.delivery_events where delivery_id = p_delivery) end where delivery_id = p_delivery;
  update public.proof_of_delivery set created_at = p_start,
    pickup_at = case when pickup_at is not null then (select created_at from public.delivery_events where delivery_id = p_delivery and type = 'picked_up' order by id limit 1) end,
    photo_at = case when photo_at is not null then (select created_at from public.delivery_events where delivery_id = p_delivery and type = 'drop_photo' order by id limit 1) end,
    pin_confirmed_at = case when pin_confirmed_at is not null then (select created_at from public.delivery_events where delivery_id = p_delivery and type = 'pin_ok' order by id limit 1) end,
    delivered_at = case when delivered_at is not null then (select created_at from public.delivery_events where delivery_id = p_delivery and type = 'delivered' order by id limit 1) end
  where delivery_id = p_delivery;
  update public.audit_log set created_at = created_at - shift where delivery_id = p_delivery;
  update public.support_tickets set created_at = created_at - shift, updated_at = updated_at - shift where delivery_id = p_delivery;
  update public.disputes set created_at = created_at - shift where delivery_id = p_delivery;
end $$;

-- Confirms a seeded payment the way the sandbox provider would (service-role path, same function as webhooks).
create or replace function pg_temp.pay_ok(p_payment uuid) returns void language plpgsql as $$
begin
  perform public.payment_apply_result(jsonb_build_object('payment_id', p_payment, 'provider', 'sandbox', 'status', 'successful',
    'amount', (select amount from public.payments where id = p_payment), 'currency', 'UGX', 'source', 'seed'));
end $$;

create or replace function pg_temp.book(p_vendor_user uuid, p jsonb) returns uuid language plpgsql as $$
begin
  perform pg_temp.act_as(p_vendor_user);
  return (public.create_delivery(p)->>'id')::uuid;
end $$;

do $seed$
declare
  ops uuid := '30000000-0000-4000-a000-000000000001';
  rose uuid := '10000000-0000-4000-a000-000000000001';
  kp uuid := '10000000-0000-4000-a000-000000000002';
  hs uuid := '10000000-0000-4000-a000-000000000003';
  fm uuid := '10000000-0000-4000-a000-000000000004';
  moses uuid := '20000000-0000-4000-a000-000000000001';
  peter uuid := '20000000-0000-4000-a000-000000000002';
  brian uuid := '20000000-0000-4000-a000-000000000003';
  joseph uuid := '20000000-0000-4000-a000-000000000004';
  faith uuid := '20000000-0000-4000-a000-000000000005';
  daniel uuid := '20000000-0000-4000-a000-000000000006';
  aisha uuid := '20000000-0000-4000-a000-000000000007';
  ronald uuid := '20000000-0000-4000-a000-000000000008';
  samuel uuid := '20000000-0000-4000-a000-000000000009';
  kenneth uuid := '20000000-0000-4000-a000-000000000010';
  d uuid; w uuid; i int; amt int[]; r record; t jsonb;
begin
  if exists (select 1 from auth.users where email = 'rose@dropoff.test') then
    raise notice 'Demo seed already applied';
    return;
  end if;

  -- accounts (the sign-up trigger creates profiles, vendors, riders, vehicles, wallets, verification requests)
  perform pg_temp.mk_user(ops, 'ops@dropoff.test', '{"role":"ops","full_name":"Anita Namubiru","phone":"0700100200"}');
  perform pg_temp.mk_user(rose, 'rose@dropoff.test', '{"role":"vendor","full_name":"Rose Nakato","business_name":"Mama Rose Cakes","category":"Bakery & cakes","phone":"0772418905","place_id":"kisementi","location_label":"Kisementi branch","address":"Plot 12, Kisementi, Kololo","registration_no":"80020001234567","tin":"1002345678"}');
  perform pg_temp.mk_user(kp, 'pharmacy@dropoff.test', '{"role":"vendor","full_name":"Dr. Paul Mukasa","business_name":"Kololo Pharmacy","category":"Pharmacy","phone":"0772230118","place_id":"kololo_pharm","location_label":"Acacia Ave","address":"Acacia Avenue, Kololo"}');
  perform pg_temp.mk_user(hs, 'homestyle@dropoff.test', '{"role":"vendor","full_name":"Grace Achen","business_name":"HomeStyle Furniture","category":"Furniture","phone":"0772220471","place_id":"homestyle","location_label":"Industrial Area showroom","address":"5th Street, Industrial Area"}');
  perform pg_temp.mk_user(fm, 'freshmart@dropoff.test', '{"role":"vendor","full_name":"Ali Ssekandi","business_name":"FreshMart Bugolobi","category":"Supermarket","phone":"0772501330","place_id":"freshmart","location_label":"Bugolobi store","address":"Bugolobi shopping centre"}');
  perform pg_temp.mk_user(moses, 'moses@dropoff.test', '{"role":"rider","full_name":"Moses Kato","phone":"0779004221","vehicle_class":"boda","make":"Bajaj Boxer 150","color":"Red","plate":"UEX 219K","has_box":true,"license_no":"DL-0412233"}');
  perform pg_temp.mk_user(peter, 'peter@dropoff.test', '{"role":"rider","full_name":"Peter Wasswa","phone":"0701330118","vehicle_class":"boda","make":"TVS HLX 125","color":"Black","plate":"UFA 330M","has_box":true,"license_no":"DL-0388120"}');
  perform pg_temp.mk_user(brian, 'brian@dropoff.test', '{"role":"rider","full_name":"Brian Tumusiime","phone":"0782551090","vehicle_class":"boda","make":"Bajaj Boxer 100","color":"Blue","plate":"UFB 551C","license_no":"DL-0299871"}');
  perform pg_temp.mk_user(joseph, 'joseph@dropoff.test', '{"role":"rider","full_name":"Joseph Okello","phone":"0772640482","vehicle_class":"car","make":"Toyota Premio","color":"Silver","plate":"UBK 482T","license_no":"DL-0177345"}');
  perform pg_temp.mk_user(faith, 'faith@dropoff.test', '{"role":"rider","full_name":"Faith Akello","phone":"0756771300","vehicle_class":"car","make":"Toyota Fielder","color":"White","plate":"UBM 771P","license_no":"DL-0510902"}');
  perform pg_temp.mk_user(daniel, 'daniel@dropoff.test', '{"role":"rider","full_name":"Daniel Ssali","phone":"0774640117","vehicle_class":"minivan","make":"Toyota Noah","color":"Grey","plate":"UBJ 640R","license_no":"DL-0233410"}');
  perform pg_temp.mk_user(aisha, 'aisha@dropoff.test', '{"role":"rider","full_name":"Aisha Namuli","phone":"0703208555","vehicle_class":"minivan","make":"Toyota Sienta","color":"White","plate":"UBN 208K","license_no":"DL-0344981"}');
  perform pg_temp.mk_user(ronald, 'ronald@dropoff.test', '{"role":"rider","full_name":"Ronald Bwire","phone":"0772117902","vehicle_class":"pickup","make":"Isuzu D-Max","color":"White","plate":"UBQ 117A","license_no":"DL-0155021"}');
  perform pg_temp.mk_user(samuel, 'samuel@dropoff.test', '{"role":"rider","full_name":"Samuel Opio","phone":"0712902664","vehicle_class":"truck","make":"Isuzu FRR 5t","color":"Blue","plate":"UAZ 902G","license_no":"DL-0098770"}');
  perform pg_temp.mk_user(kenneth, 'kenneth@dropoff.test', '{"role":"rider","full_name":"Kenneth Mwesigwa","phone":"0772551908","vehicle_class":"truck","make":"Mitsubishi Fuso 4t","color":"White","plate":"UBR 330D","license_no":"DL-0601144"}');

  -- an administrator promotes the ops account (sign-up can never create ops)
  update public.profiles set role = 'ops' where id = ops;
  update public.profiles set is_demo = true where id in (ops, rose, kp, hs, fm, moses, peter, brian, joseph, faith, daniel, aisha, ronald, samuel, kenneth);
  -- demo phones count as verified (as if each user had confirmed an OTP), so phone sign-in works for them too
  update auth.users u set phone = '256' || right(regexp_replace(p.phone, '\D', '', 'g'), 9), phone_confirmed_at = now() - interval '30 days'
    from public.profiles p where p.id = u.id and p.is_demo and p.phone is not null;
  update public.profiles set phone_verified_at = now() - interval '30 days', phone_changed_at = null, terms_accepted_at = now() - interval '30 days' where is_demo;
  update public.profiles x set national_id_no = s.nin, date_of_birth = s.dob from (values
    (rose, 'CF85012345KRNA', date '1985-04-12'), (kp, 'CM78033344PMUK', date '1978-09-30'), (hs, 'CF88021190GACH', date '1988-02-11'),
    (fm, 'CM82051277ASSE', date '1982-05-27'), (moses, 'CM93040112MKAT', date '1993-04-01'), (peter, 'CM95110833PWAS', date '1995-11-08'),
    (brian, 'CM97072019BTUM', date '1997-07-20'), (joseph, 'CM89060554JOKE', date '1989-06-05'), (faith, 'CF96121700FAKE', date '1996-12-17'),
    (daniel, 'CM91030921DSSA', date '1991-03-09'), (aisha, 'CF94081466ANAM', date '1994-08-14'), (ronald, 'CM87112803RBWI', date '1987-11-28'),
    (samuel, 'CM84020215SOPI', date '1984-02-02'), (kenneth, 'CM99050630KMWE', date '1999-05-06')) s(uid, nin, dob)
  where x.id = s.uid;

  -- businesses: verified, with credit where the demo needs it
  update public.vendors set is_demo = true, verification_status = 'verified' where owner_id in (rose, kp, hs, fm);
  update public.vendors set credit_eligible = true, credit_limit = 2000000, default_method = 'wallet' where owner_id = rose;
  update public.vendors set credit_eligible = true, credit_limit = 10000000, default_method = 'credit' where owner_id = hs;
  update public.vendors set credit_eligible = true, credit_limit = 15000000, default_method = 'wallet' where owner_id = fm;
  update public.vendors set default_method = 'wallet' where owner_id = kp;
  update public.wallets w set credit_limit = v.credit_limit from public.vendors v where w.vendor_id = v.id and w.kind = 'credit';
  update public.verification_requests set status = 'verified', reviewed_at = now() - interval '30 days', reviewer_id = ops, submitted_at = now() - interval '31 days'
    where vendor_id in (select id from public.vendors where owner_id in (rose, kp, hs, fm));
  insert into public.vendor_locations (vendor_id, place_id, label) select id, 'ntinda_kitchen', 'Ntinda kitchen' from public.vendors where owner_id = rose;
  insert into public.vendor_staff (vendor_id, name, role) select id, x.n, x.r from public.vendors, (values ('Ivan Mugisha', 'dispatcher'), ('Sarah Atim', 'finance')) x(n, r) where owner_id = rose;

  -- riders: verified (except the applicant), with their track record
  update public.riders set is_demo = true where profile_id in (moses, peter, brian, joseph, faith, daniel, aisha, ronald, samuel, kenneth);
  update public.riders set verification_status = 'verified' where profile_id in (moses, peter, brian, joseph, faith, daniel, aisha, ronald, samuel);
  update public.vehicles set verification_status = 'verified' where rider_id in (select id from public.riders where verification_status = 'verified');
  update public.verification_requests set status = 'verified', reviewed_at = now() - interval '60 days', reviewer_id = ops, submitted_at = now() - interval '61 days'
    where rider_id in (select id from public.riders where verification_status = 'verified');
  update public.verification_requests set status = 'submitted', submitted_at = now() - interval '4 hours'
    where rider_id = (select id from public.riders where profile_id = kenneth);
  update public.riders set verification_status = 'submitted' where profile_id = kenneth;
  insert into public.documents (owner_id, verification_request_id, kind, storage_path, file_name, mime_type, size_bytes, created_at)
  select kenneth, vr.id, k.kind, kenneth::text || '/seed-' || k.kind || '.pdf', k.fname, 'application/pdf', 182000, now() - interval '4 hours'
  from public.verification_requests vr, (values ('national_id', 'national-id.pdf'), ('selfie', 'selfie.jpg'), ('driving_permit', 'driving-permit.pdf'), ('vehicle_logbook', 'logbook.pdf')) k(kind, fname)
  where vr.rider_id = (select id from public.riders where profile_id = kenneth);

  -- wallet top-ups: sandbox mobile money / card, confirmed through the same path as provider callbacks
  perform pg_temp.act_as(rose); perform pg_temp.pay_ok((public.wallet_topup(1000000, 'momo')->>'paymentId')::uuid);
  perform pg_temp.pay_ok((public.wallet_topup(500000, 'momo')->>'paymentId')::uuid);
  perform pg_temp.act_as(kp); perform pg_temp.pay_ok((public.wallet_topup(640000, 'momo')->>'paymentId')::uuid);
  perform pg_temp.act_as(hs); perform pg_temp.pay_ok((public.wallet_topup(210000, 'card')->>'paymentId')::uuid);
  perform pg_temp.act_as(fm); perform pg_temp.pay_ok((public.payment_start_topup(3100000, 'momo', null, null)->>'paymentId')::uuid);
  update public.payments set created_at = now() - interval '2 days', captured_at = now() - interval '2 days' where purpose = 'topup';
  update public.payment_events set created_at = now() - interval '2 days';
  update public.wallet_transactions set created_at = now() - interval '2 days' where type = 'topup' and delivery_id is null;
  update public.notifications set created_at = now() - interval '2 days', read_at = now() where title = 'Wallet topped up';

  -- history: completed deliveries
  d := pg_temp.book(rose, '{"pickup":"kisementi","dropoff":"speke","recipient_name":"Grace Namutebi","recipient_phone":"0701552318","notes":"Lakeview Ballroom, service entrance at Gate B.","type":"cake","description":"3-tier wedding cake, white fondant with fresh roses","size":"medium","weight":12,"value":450000,"fragile":true,"upright":true,"urgency":"standard","vehicle_class":"car","method":"wallet"}');
  perform pg_temp.run(d, joseph, 'delivered'); perform pg_temp.age(d, now() - interval '2 days 6 hours', 4);

  d := pg_temp.book(rose, '{"pickup":"kisementi","dropoff":"kabalagala","recipient_name":"Kabalagala Café","recipient_phone":"0756220114","notes":"Back door, ask for Ruth","type":"food","description":"Pastry trays ×12","size":"large","weight":40,"value":0,"urgency":"standard","vehicle_class":"minivan","method":"wallet"}');
  perform pg_temp.run(d, daniel, 'delivered'); perform pg_temp.age(d, now() - interval '1 day 9 hours', 5);

  d := pg_temp.book(fm, '{"pickup":"freshmart","dropoff":"nakawa","recipient_name":"Nakawa stores","recipient_phone":"0772501331","type":"stock","description":"Restock · 120 crates of beverages","size":"freight","weight":1800,"value":0,"urgency":"standard","vehicle_class":"truck","method":"wallet"}');
  perform pg_temp.run(d, samuel, 'delivered'); perform pg_temp.age(d, now() - interval '1 day 3 hours', 6);

  d := pg_temp.book(rose, '{"pickup":"kisementi","dropoff":"bukoto","recipient_name":"Brian Kasozi","recipient_phone":"0782640115","type":"food","description":"Birthday cupcakes ×12","size":"small","weight":3,"value":80000,"fragile":true,"urgency":"standard","vehicle_class":"boda","method":"wallet"}');
  perform pg_temp.run(d, moses, 'delivered'); perform pg_temp.age(d, now() - interval '3 hours', 3);

  -- a delivered order the vendor disputes (open case for ops)
  d := pg_temp.book(rose, '{"pickup":"kisementi","dropoff":"bukoto","recipient_name":"Brian Kasozi","recipient_phone":"0782640115","type":"food","description":"Cupcake box ×12","size":"small","weight":3,"value":60000,"fragile":true,"urgency":"standard","vehicle_class":"boda","method":"wallet"}');
  perform pg_temp.run(d, brian, 'delivered');
  perform pg_temp.act_as(rose); perform public.open_ticket(d, 'damaged', 'Lid crushed, cupcakes squashed. Customer sent a photo.');
  perform pg_temp.age(d, now() - interval '3 days 4 hours', 4);

  -- a failed attempt (recipient unreachable), returned to the vendor
  d := pg_temp.book(rose, '{"pickup":"kisementi","dropoff":"kyanja","recipient_name":"Joan Nabirye","recipient_phone":"0772300118","type":"food","description":"Cupcakes ×6","size":"small","weight":2,"value":0,"urgency":"standard","vehicle_class":"boda","method":"wallet"}');
  perform pg_temp.run(d, peter, 'awaiting_confirmation');
  perform pg_temp.act_as(peter);
  perform public.rider_report_unreachable(d);
  perform public.log_call(d, 'recipient'); perform public.log_call(d, 'recipient'); perform public.log_call(d, 'recipient');
  update public.deliveries set unreachable_at = now() - interval '11 minutes' where id = d;
  perform public.rider_mark_failed(d, 'Recipient unreachable after 3 calls');
  perform pg_temp.act_as(rose); perform public.resolve_failed(d, 'return');
  perform pg_temp.age(d, now() - interval '1 day 5 hours', 4);

  -- live: on its way to the demo recipient (Sarah Achieng · last 4 digits 2640)
  d := pg_temp.book(kp, '{"pickup":"kololo_pharm","dropoff":"kigowa","recipient_name":"Sarah Achieng","recipient_phone":"0753512640","notes":"Blue gate opposite the church. Call when outside.","type":"pharmacy","description":"Pharmacy order · 1 sealed bag","size":"small","weight":1,"value":0,"urgency":"standard","vehicle_class":"boda","method":"wallet"}');
  perform pg_temp.run(d, peter, 'in_transit'); perform pg_temp.age(d, now() - interval '22 minutes', 3);
  update public.delivery_secrets set tracking_token = 'demo2640sarah' where delivery_id = d;

  -- live: driver heading to the pickup (paid on business credit)
  d := pg_temp.book(hs, '{"pickup":"homestyle","dropoff":"kira","recipient_name":"Patrick Ouma","recipient_phone":"0772884201","notes":"Two flights of stairs. Loading help paid.","type":"furniture","description":"3-seater sofa, wrapped","size":"bulky","weight":85,"value":2400000,"urgency":"standard","vehicle_class":"pickup","method":"credit"}');
  perform pg_temp.run(d, ronald, 'en_route_pickup'); perform pg_temp.age(d, now() - interval '9 minutes', 2);

  -- riders who are not on a job end the seed offline: they go online themselves when they sign in
  for r in select profile_id from public.riders where online and active_delivery_id is null loop
    perform pg_temp.act_as(r.profile_id); perform public.rider_set_online(false);
  end loop;

  -- live: still looking for a minivan driver
  d := pg_temp.book(rose, '{"pickup":"ntinda_kitchen","dropoff":"kajjansi","recipient_name":"St. Luke Parish Hall","recipient_phone":"0701447320","notes":"Wedding reception, deliver to the kitchen side door.","type":"food","description":"Catering order · 14 boxes","size":"large","weight":85,"value":900000,"urgency":"standard","vehicle_class":"minivan","method":"wallet"}');
  perform pg_temp.age(d, now() - interval '2 minutes', 1);

  -- earlier earnings (day totals before this demo history) for the 7-day chart, plus a nightly payout
  amt := array[58000, 64500, 49000, 71000, 82500, 49000];
  for i in 1..6 loop
    w := public._wallet_id('rider', pg_temp.rider_profile(moses));
    perform public._wallet_post(w, 'earning', amt[i], 'balance', 'Deliveries · day total (seed)', 'completed');
    update public.wallet_transactions set created_at = date_trunc('day', now()) - make_interval(days => 7 - i) + interval '19 hours' where id = (select id from public.wallet_transactions where wallet_id = w order by created_at desc, ref desc limit 1);
    w := public._wallet_id('rider', pg_temp.rider_profile(joseph));
    perform public._wallet_post(w, 'earning', amt[i] * 2 - 20000, 'balance', 'Deliveries · day total (seed)', 'completed');
    update public.wallet_transactions set created_at = date_trunc('day', now()) - make_interval(days => 7 - i) + interval '19 hours' where id = (select id from public.wallet_transactions where wallet_id = w order by created_at desc, ref desc limit 1);
  end loop;
  perform pg_temp.act_as(moses); t := public.rider_request_payout(300000);
  perform pg_temp.pay_ok((t->>'paymentId')::uuid);
  update public.wallet_transactions set created_at = now() - interval '1 day 2 hours' where type = 'payout';
  update public.payments set created_at = now() - interval '1 day 2 hours', captured_at = now() - interval '1 day 2 hours' where purpose = 'payout';
  update public.notifications set created_at = now() - interval '1 day 2 hours', read_at = now() where title = 'Cash-out sent';

  -- track records
  update public.riders x set rating = s.rating, trips = x.trips + s.trips, acceptance = s.acc, created_at = s.since
  from (values (moses, 4.92, 1845, 94, timestamptz '2025-03-02'), (peter, 4.81, 931, 90, timestamptz '2025-07-11'), (brian, 4.61, 1202, 89, timestamptz '2025-01-20'),
               (joseph, 4.90, 1239, 97, timestamptz '2024-11-04'), (faith, 4.86, 310, 92, timestamptz '2026-08-14'), (daniel, 4.95, 620, 96, timestamptz '2025-02-08'),
               (aisha, 4.91, 402, 88, timestamptz '2025-05-19'), (ronald, 4.88, 288, 91, timestamptz '2025-03-27'), (samuel, 4.84, 163, 93, timestamptz '2024-10-15'),
               (kenneth, 5.0, 0, 100, now() - interval '4 hours')) s(uid, rating, trips, acc, since)
  where x.profile_id = s.uid;

  update public.deliveries set is_demo = true;
  -- older notifications are read
  update public.notifications set read_at = coalesce(read_at, now()) where created_at < now() - interval '2 hours';
  perform set_config('request.jwt.claims', '', false);
  perform set_config('request.jwt.claim.sub', '', false);
end $seed$;
