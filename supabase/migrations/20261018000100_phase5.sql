-- Drop Off · phase 5
--   1. Real map coordinates and distance-based pricing (road distance ≈ straight line × 1.3)
--   2. Simple sign-up: phone OTP / Google / e-mail → "new" profile → complete_signup() picks vendor or rider
--   3. Phone verification and KYC tiers (NIN, date of birth, selfie, duplicate-ID flags)
--   4. Provider-neutral payments: nothing is credited until a payment provider confirms it.
--        client → payment_start_topup / create_delivery / request_payout     (pending, no money moved)
--        Edge Function payments-initiate → provider adapter → payment_mark_initiated
--        provider callback → payments-webhook → re-query provider → payment_apply_result (service role only)
--        payments-reconcile (cron) → re-checks stale payments, expires abandoned ones
--   5. available_drivers(): coarse, anonymous driver supply for the map

/* ================================================================== 1. coordinates & pricing */

update public.places p set lat = v.lat, lng = v.lng from (values
  ('kisementi', 0.33400, 32.59250), ('ntinda_kitchen', 0.35270, 32.61630), ('kololo_pharm', 0.33550, 32.58700),
  ('homestyle', 0.31850, 32.60200), ('freshmart', 0.31750, 32.62000), ('speke', 0.24200, 32.61700),
  ('kigowa', 0.35800, 32.62700), ('bukoto', 0.34900, 32.59300), ('kabalagala', 0.29600, 32.59800),
  ('naguru', 0.34400, 32.60600), ('kira', 0.39700, 32.63900), ('nakasero', 0.31350, 32.57900),
  ('wandegeya', 0.33100, 32.57300), ('kyanja', 0.38300, 32.60100), ('muyenga', 0.29300, 32.61100),
  ('acacia', 0.33750, 32.58830), ('nateete', 0.29900, 32.54400), ('kajjansi', 0.21400, 32.55000),
  ('mukono', 0.35300, 32.75500), ('nakawa', 0.33000, 32.61500), ('kansanga', 0.28500, 32.60000),
  ('lugogo', 0.32830, 32.60460), ('wandegeya_mkt', 0.33300, 32.57200), ('mengo', 0.30200, 32.56400)
) as v(id, lat, lng) where p.id = v.id;
-- x/y are kept for legacy ETA maths only and now follow the real coordinates
update public.places set x = round(((lng - 32.4702) / 0.0002247)::numeric), y = round(((0.4196 - lat) / 0.0002248)::numeric);
update public.deliveries d set pickup_lat = p.lat, pickup_lng = p.lng, pickup_x = p.x, pickup_y = p.y from public.places p where p.id = d.pickup_place_id;
update public.deliveries d set dropoff_lat = p.lat, dropoff_lng = p.lng, dropoff_x = p.x, dropoff_y = p.y from public.places p where p.id = d.dropoff_place_id;

-- Road distance in tenths of a km: straight-line metres (rounded) × 1.3. The client mirrors this exactly
-- (DO.store.geo.km10) so the price a vendor sees equals the price charged. A routing provider can replace it.
create or replace function public._route_km10(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns int language sql immutable as $$
  select greatest(1, round(public._dist_m(lat1, lng1, lat2, lng2) * 13 / 1000.0)::int)
$$;

create or replace function public._quote(p_pickup text, p_dropoff text, p_class text, p_fragile boolean, p_express boolean)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  a public.places; b public.places; pr public.pricing_rules; c public.vehicle_classes;
  km10 int; km numeric; lines jsonb; total int; dist int;
begin
  select * into a from public.places where id = p_pickup;
  select * into b from public.places where id = p_dropoff;
  select * into pr from public.pricing_rules where class_id = p_class;
  select * into c from public.vehicle_classes where id = p_class;
  if a.id is null or b.id is null or pr.class_id is null then raise exception 'Unknown route or vehicle.'; end if;
  km10 := public._route_km10(a.lat, a.lng, b.lat, b.lng);
  km := km10 / 10.0;
  dist := round(km10 * pr.per_km / 5000.0) * 500;
  lines := jsonb_build_array(
    jsonb_build_object('label', 'Base fare · ' || lower(c.label), 'amount', pr.base),
    jsonb_build_object('label', 'Distance · ' || km || ' km', 'amount', dist));
  total := pr.base + dist;
  if p_fragile then lines := lines || jsonb_build_array(jsonb_build_object('label', 'Fragile handling', 'amount', pr.fragile)); total := total + pr.fragile; end if;
  if p_express then lines := lines || jsonb_build_array(jsonb_build_object('label', 'Express · first available driver', 'amount', pr.express)); total := total + pr.express; end if;
  if total < pr.min_fare then
    lines := lines || jsonb_build_array(jsonb_build_object('label', 'Minimum fare top-up', 'amount', pr.min_fare - total));
    total := pr.min_fare;
  end if;
  total := round(total / 500.0) * 500;
  return jsonb_build_object('km', km, 'lines', lines, 'total', total, 'commission', pr.commission_pct);
end $$;

/* ================================================================== 2/3. profiles, onboarding, KYC */

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('new', 'vendor', 'rider', 'recipient', 'ops'));
alter table public.profiles
  add column if not exists phone_verified_at timestamptz,
  add column if not exists phone_changed_at timestamptz,
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists signup_method text not null default 'email',
  add column if not exists national_id_no text,
  add column if not exists date_of_birth date;
create index if not exists profiles_nin_idx on public.profiles(national_id_no) where national_id_no is not null;

alter table public.verification_requests add column if not exists risk_flags text[] not null default '{}';
alter table public.documents drop constraint if exists documents_kind_check;
alter table public.documents add constraint documents_kind_check check (kind in ('national_id', 'driving_permit', 'vehicle_logbook', 'insurance',
  'profile_photo', 'selfie', 'business_registration', 'tin_certificate', 'trading_licence', 'other'));

-- demo accounts (development seed only) count as phone-verified
update public.profiles set phone_verified_at = coalesce(phone_verified_at, created_at) where is_demo and phone is not null;

-- Creates the vendor or rider records for a profile. Used by sign-up (role chosen in the form) and by
-- complete_signup() (role chosen after a phone or Google sign-in).
create or replace function public._provision_role(p_profile uuid, p_role text, m jsonb, p_email text, p_name text, p_phone text) returns void
language plpgsql security definer set search_path = public as $$
declare vid uuid; rid uuid; pl public.places; bname text; cls text; nm text := coalesce(nullif(trim(p_name), ''), '');
begin
  if p_role = 'vendor' then
    bname := coalesce(nullif(trim(m->>'business_name'), ''), nullif(nm, ''), 'New business');
    insert into public.vendors (owner_id, name, initials, category, contact_name, phone, email, address, registration_no, tin, payment_methods, default_method)
    values (p_profile, bname, public._initials(bname), coalesce(nullif(m->>'category', ''), 'Other'), coalesce(nullif(nm, ''), bname),
            coalesce(p_phone, ''), p_email, nullif(trim(m->>'address'), ''), nullif(trim(m->>'registration_no'), ''), nullif(trim(m->>'tin'), ''),
            jsonb_build_array(
              jsonb_build_object('id', 'wallet', 'label', 'Drop Off Wallet'),
              jsonb_build_object('id', 'momo', 'label', 'MTN Mobile Money', 'detail', public._mask_phone(p_phone)),
              jsonb_build_object('id', 'airtel', 'label', 'Airtel Money', 'detail', public._mask_phone(p_phone)),
              jsonb_build_object('id', 'card', 'label', 'Card', 'detail', 'Hosted checkout'),
              jsonb_build_object('id', 'credit', 'label', 'Business credit account', 'detail', 'Monthly invoice')),
            'momo')
    returning id into vid;
    insert into public.vendor_staff (vendor_id, profile_id, name, role) values (vid, p_profile, coalesce(nullif(nm, ''), bname), 'owner');
    select * into pl from public.places where id = m->>'place_id' and is_active;
    if pl.id is not null then
      insert into public.vendor_locations (vendor_id, place_id, label, is_default) values (vid, pl.id, coalesce(nullif(trim(m->>'location_label'), ''), pl.area), true);
    end if;
    perform public._wallet_id('vendor', vid, 'main');
    perform public._wallet_id('vendor', vid, 'credit');
    insert into public.verification_requests (subject_type, vendor_id, profile_id) values ('vendor', vid, p_profile);
    perform public._notify('vendor', vid, null, 'Welcome to Drop Off', 'You can book deliveries now. Verify your business to unlock credit, invoicing and higher payment limits.', null, 'ok');
    perform public._notify('ops', null, null, 'New vendor sign-up', bname || ' · ' || coalesce(m->>'category', 'Other'), null);
  elsif p_role = 'rider' then
    insert into public.riders (profile_id, display_name, initials, license_no)
    values (p_profile, coalesce(nullif(nm, ''), 'New rider'), public._initials(coalesce(nullif(nm, ''), 'New rider')), nullif(trim(m->>'license_no'), ''))
    returning id into rid;
    cls := case when m->>'vehicle_class' in (select id from public.vehicle_classes) then m->>'vehicle_class' else 'boda' end;
    if coalesce(trim(m->>'plate'), '') <> '' then
      insert into public.vehicles (rider_id, class_id, make, color, plate, registration_no, has_box)
      values (rid, cls, coalesce(nullif(trim(m->>'make'), ''), (select label from public.vehicle_classes where id = cls)),
              coalesce(trim(m->>'color'), ''), upper(trim(m->>'plate')), nullif(trim(m->>'vehicle_registration'), ''), coalesce((m->>'has_box')::boolean, false));
    end if;
    perform public._wallet_id('rider', rid);
    insert into public.verification_requests (subject_type, rider_id, profile_id) values ('rider', rid, p_profile);
    perform public._notify('rider', null, rid, 'Application received', 'Add your ID details and documents so ops can verify you.', null, 'ok');
    perform public._notify('ops', null, null, 'Rider application · ' || coalesce(nullif(nm, ''), 'New rider'), initcap(cls) || ' · ' || upper(coalesce(m->>'plate', '')), null, 'warn');
  end if;
end $$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}');
  r text := m->>'role';
  nm text := trim(coalesce(m->>'full_name', m->>'name', m->>'contact_name', ''));
  ph text := coalesce(public._norm_phone(m->>'phone'), public._norm_phone(new.phone));
  method text := coalesce(new.raw_app_meta_data->>'provider', case when new.phone is not null and new.email is null then 'phone' else 'email' end);
begin
  -- Roles are never taken from the client beyond vendor/rider/recipient. Ops accounts are promoted by an admin.
  -- Phone and Google sign-ups start as "new" and choose vendor or rider in complete_signup().
  if r is null or r not in ('vendor', 'rider', 'recipient') then r := 'new'; end if;
  insert into public.profiles (id, role, full_name, phone, email, signup_method, terms_accepted_at, phone_verified_at)
  values (new.id, r, coalesce(nullif(nm, ''), split_part(coalesce(new.email, ''), '@', 1)), ph, new.email, method,
    case when coalesce((m->>'terms')::boolean, false) then now() end,
    case when new.phone_confirmed_at is not null and public._norm_phone(new.phone) is not null then now() end);
  if r in ('vendor', 'rider') then perform public._provision_role(new.id, r, m, new.email, nm, ph); end if;
  insert into public.audit_log (event_type, actor_id, actor_role, actor_name, target_type, target_id, metadata)
  values ('user.registered', new.id, r, nm, 'profile', new.id::text, jsonb_build_object('email', new.email, 'method', method));
  return new;
end $$;

-- Phone ownership is proven by Supabase Auth (OTP sign-in or phone change). Mirror it into the profile.
create or replace function public.handle_user_updated() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.phone_confirmed_at is not null and public._norm_phone(new.phone) is not null
     and (old.phone_confirmed_at is distinct from new.phone_confirmed_at or old.phone is distinct from new.phone) then
    update public.profiles set phone = public._norm_phone(new.phone), phone_verified_at = now(),
      phone_changed_at = case when old.phone is not null and old.phone <> '' and old.phone is distinct from new.phone then now() else phone_changed_at end
    where id = new.id;
    insert into public.audit_log (event_type, actor_id, actor_role, target_type, target_id, metadata)
    values ('user.phone_verified', new.id, (select role from public.profiles where id = new.id), 'profile', new.id::text,
      jsonb_build_object('phone', public._mask_phone(public._norm_phone(new.phone))));
  end if;
  if new.email is distinct from old.email and new.email is not null then
    update public.profiles set email = new.email where id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated after update on auth.users for each row execute function public.handle_user_updated();

-- Second step of the simple sign-up: the user says whether they send packages or deliver them.
create or replace function public.complete_signup(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._me(); r text := p->>'role'; nm text := trim(coalesce(p->>'full_name', '')); ph text; cls text := p->>'vehicle_class';
begin
  if me.role <> 'new' then raise exception 'Your account is already set up.'; end if;
  if r is null or r not in ('vendor', 'rider') then raise exception 'Choose how you will use Drop Off.'; end if;
  if length(nm) < 2 then raise exception 'Enter your full name.'; end if;
  if not coalesce((p->>'terms')::boolean, false) then raise exception 'Accept the terms and privacy notice to continue.'; end if;
  ph := case when me.phone_verified_at is not null then me.phone else public._norm_phone(p->>'phone') end;
  if ph is null then raise exception 'Enter a Ugandan mobile number, e.g. 0772 418 905.'; end if;
  if r = 'vendor' then
    if length(trim(coalesce(p->>'business_name', ''))) < 2 then raise exception 'Enter your business name.'; end if;
    if coalesce(p->>'place_id', '') <> '' and not exists (select 1 from public.places where id = p->>'place_id' and is_active) then raise exception 'Choose your pickup area from the list.'; end if;
  else
    if cls is null or not exists (select 1 from public.vehicle_classes where id = cls) then raise exception 'Choose your vehicle type.'; end if;
    if coalesce(trim(p->>'plate'), '') !~* '^U[A-Z]{2} ?\d{3}[A-Z]$' then raise exception 'Enter a plate like UEX 219K.'; end if;
    if not public.plate_available(p->>'plate') then raise exception 'That plate is already registered with Drop Off.'; end if;
  end if;
  update public.profiles set role = r, full_name = nm, phone = ph, terms_accepted_at = now() where id = me.id;
  perform public._provision_role(me.id, r, p, me.email, nm, ph);
  perform public._audit('user.onboarded', 'profile', me.id::text, null, jsonb_build_object('role', r, 'method', me.signup_method));
  return jsonb_build_object('ok', true, 'role', r);
end $$;

-- A verified phone can only be replaced through an OTP (supabase.auth.updateUser({ phone })).
create or replace function public.update_my_profile(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._me(); ph text;
begin
  if p ? 'phone' then
    ph := public._norm_phone(p->>'phone');
    if ph is null then raise exception 'Enter a Ugandan mobile number, e.g. 0772 418 905.'; end if;
    if me.phone_verified_at is not null and ph is distinct from me.phone then
      raise exception 'Change your phone number with a verification code: tap "Change number" under Phone.';
    end if;
  end if;
  if p ? 'full_name' and length(trim(p->>'full_name')) < 2 then raise exception 'Enter your full name.'; end if;
  if p ? 'full_name' and trim(p->>'full_name') is distinct from me.full_name and exists (
      select 1 from public.verification_requests where profile_id = me.id and status in ('verified', 'under_review')) then
    raise exception 'Your name is part of your verified identity. Contact support to change it.';
  end if;
  if p ? 'avatar_path' and coalesce(p->>'avatar_path', '') <> '' and split_part(p->>'avatar_path', '/', 1) <> me.id::text then
    raise exception 'Upload the photo again.';
  end if;
  update public.profiles set
    full_name = coalesce(nullif(trim(p->>'full_name'), ''), full_name),
    phone = coalesce(ph, phone),
    avatar_path = case when p ? 'avatar_path' then nullif(p->>'avatar_path', '') else avatar_path end
  where id = me.id;
  if me.role = 'rider' and p ? 'full_name' then
    update public.riders set display_name = trim(p->>'full_name'), initials = public._initials(p->>'full_name') where profile_id = me.id;
  end if;
  if me.role = 'vendor' then
    update public.vendors set
      contact_name = coalesce(nullif(trim(p->>'contact_name'), ''), contact_name),
      phone = coalesce(public._norm_phone(p->>'business_phone'), phone),
      address = coalesce(nullif(trim(p->>'address'), ''), address),
      registration_no = coalesce(nullif(trim(p->>'registration_no'), ''), registration_no),
      tin = coalesce(nullif(trim(p->>'tin'), ''), tin)
    where id in (select public.my_vendor_ids()) and owner_id = me.id;
  end if;
  perform public._audit('profile.updated', 'profile', me.id::text, null, p - 'avatar_path');
end $$;

-- Identity details for KYC. The NIN format is checked here; whether it belongs to the person is checked
-- by ops against the uploaded ID (and later by an identity provider). Drop Off never claims a NIRA check.
create or replace function public.save_kyc(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._me(); nin text := upper(regexp_replace(coalesce(p->>'nin', ''), '\s', '', 'g')); dob date; vr public.verification_requests; dup int;
begin
  if me.role not in ('vendor', 'rider') then raise exception 'Only business owners and drivers add ID details.'; end if;
  select * into vr from public.verification_requests where profile_id = me.id order by created_at limit 1;
  if vr.status in ('verified', 'under_review') and not vr.info_requested then raise exception 'Your ID details are being reviewed or already verified. Contact support to change them.'; end if;
  if nin !~ '^C[MF][0-9A-Z]{12}$' then raise exception 'Enter the 14-character NIN from your National ID, e.g. CM90012345ABCD.'; end if;
  begin dob := (p->>'date_of_birth')::date; exception when others then dob := null; end;
  if dob is null then raise exception 'Enter your date of birth.'; end if;
  if dob > (current_date - interval '18 years') then raise exception 'You must be 18 or older to use Drop Off.'; end if;
  if dob < date '1920-01-01' then raise exception 'Check your date of birth.'; end if;
  update public.profiles set national_id_no = nin, date_of_birth = dob where id = me.id;
  select count(*) into dup from public.profiles where national_id_no = nin and id <> me.id;
  if dup > 0 and vr.id is not null then
    update public.verification_requests set risk_flags = array(select distinct unnest(risk_flags || array['duplicate_nin'])) where id = vr.id;
    perform public._notify('ops', null, null, 'Duplicate ID number', me.full_name || ' entered a NIN already used by another account. Review before approving.', null, 'bad');
  end if;
  perform public._audit('kyc.details_saved', 'profile', me.id::text, null, jsonb_build_object('nin', left(nin, 4) || '••••' || right(nin, 2)));
  return jsonb_build_object('ok', true, 'duplicate', dup > 0);
end $$;

create or replace function public.submit_verification() returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._me(); vr public.verification_requests; kinds text[]; missing text[];
begin
  select * into vr from public.verification_requests where profile_id = me.id order by created_at limit 1;
  if vr.id is null then raise exception 'There is no verification to submit.'; end if;
  if vr.status in ('submitted', 'under_review') and not vr.info_requested then raise exception 'Already submitted. Ops will review it shortly.'; end if;
  if vr.status = 'verified' then raise exception 'You are already verified.'; end if;
  if vr.status = 'suspended' then raise exception 'This account is suspended. Contact support.'; end if;
  if me.phone_verified_at is null then raise exception 'Verify your phone number first.'; end if;
  if me.national_id_no is null or me.date_of_birth is null then raise exception 'Add your NIN and date of birth first.'; end if;
  select coalesce(array_agg(distinct kind), '{}') into kinds from public.documents where verification_request_id = vr.id;
  if vr.subject_type = 'rider' then
    select coalesce(array_agg(k), '{}') into missing from unnest(array['national_id', 'selfie', 'driving_permit', 'vehicle_logbook']) k where not k = any(kinds);
    if not exists (select 1 from public.vehicles v where v.rider_id = vr.rider_id) then raise exception 'Add your vehicle before submitting.'; end if;
  else
    if not ('national_id' = any(kinds)) then missing := array['national_id']; end if;
    if not (kinds && array['business_registration', 'trading_licence', 'tin_certificate']) then missing := coalesce(missing, '{}') || array['business_registration']; end if;
  end if;
  if array_length(missing, 1) > 0 then
    raise exception 'Upload these documents first: %.', array_to_string(array(select replace(x, '_', ' ') from unnest(missing) x), ', ');
  end if;
  update public.verification_requests set status = 'submitted', info_requested = false, submitted_at = now() where id = vr.id;
  if vr.vendor_id is not null then update public.vendors set verification_status = 'submitted' where id = vr.vendor_id; end if;
  if vr.rider_id is not null then update public.riders set verification_status = 'submitted' where id = vr.rider_id; end if;
  perform public._notify('ops', null, null, 'Verification submitted', me.full_name || ' · ' || vr.subject_type ||
    case when array_length(vr.risk_flags, 1) > 0 then ' · flags: ' || array_to_string(vr.risk_flags, ', ') else '' end, null, 'warn');
  perform public._audit('verification.submitted', 'verification_request', vr.id::text);
end $$;

-- KYC tier: 0 = phone not verified · 1 = phone verified · 2 = phone verified and ops-verified business or driver.
create or replace function public._kyc_tier(p_profile uuid) returns int
language sql stable security definer set search_path = public as $$
  select case
    when p.phone_verified_at is null then 0
    when p.role = 'ops' then 2
    when exists (select 1 from public.verification_requests vr where vr.profile_id = p.id and vr.status = 'verified')
      or exists (select 1 from public.vendors v join public.vendor_staff s on s.vendor_id = v.id where s.profile_id = p.id and v.verification_status = 'verified')
      then 2
    else 1 end
  from public.profiles p where p.id = p_profile
$$;

/* ================================================================== 4. payments */

alter table public.payments drop constraint if exists payments_purpose_check;
alter table public.payments add constraint payments_purpose_check check (purpose in ('delivery', 'topup', 'invoice', 'payout', 'withdrawal'));
alter table public.payments
  add column if not exists direction text not null default 'collection' check (direction in ('collection', 'disbursement', 'internal')),
  add column if not exists currency text not null default 'UGX',
  add column if not exists msisdn text,
  add column if not exists idempotency_key text,
  add column if not exists initiated_by uuid references public.profiles(id),
  add column if not exists expires_at timestamptz,
  add column if not exists claimed_at timestamptz,
  add column if not exists provider_status text,
  add column if not exists provider_txn_id text,
  add column if not exists last_checked_at timestamptz,
  add column if not exists check_count int not null default 0,
  add column if not exists needs_review boolean not null default false,
  add column if not exists review_reason text,
  add column if not exists approval_status text not null default 'not_required'
    check (approval_status in ('not_required', 'awaiting_approval', 'approved', 'rejected')),
  add column if not exists approved_by uuid references public.profiles(id),
  add column if not exists approved_at timestamptz,
  add column if not exists checkout_url text,
  add column if not exists ledger_tx uuid references public.wallet_transactions(id),
  add column if not exists account_name text;
create unique index if not exists payments_idem_unique on public.payments(initiated_by, idempotency_key) where idempotency_key is not null;
create unique index if not exists payments_provider_ref_unique on public.payments(provider, provider_ref) where provider_ref is not null and provider not in ('simulated', 'internal');
create index if not exists payments_open_idx on public.payments(status, created_at) where status in ('pending', 'initiated');
create index if not exists payments_review_idx on public.payments(needs_review) where needs_review;

-- classify older rows
update public.payments set direction = 'internal', provider = 'internal' where method in ('wallet', 'credit') and direction = 'collection';
update public.payments set direction = 'disbursement' where purpose = 'payout';

-- Append-only log of everything that happened to a payment (requests, provider answers, callbacks, decisions).
create table if not exists public.payment_events (
  id                bigint generated always as identity primary key,
  payment_id        uuid references public.payments(id) on delete cascade,
  provider          text not null,
  kind              text not null,
  provider_event_id text,
  status_before     text,
  status_after      text,
  detail            jsonb not null default '{}',
  created_at        timestamptz not null default now()
);
create unique index if not exists payment_events_dedupe on public.payment_events(provider, provider_event_id) where provider_event_id is not null;
create index if not exists payment_events_payment_idx on public.payment_events(payment_id, id);

-- Sandbox provider state (stands in for the provider's own systems until a real provider is connected).
create table if not exists public.payment_sandbox (
  provider_ref  text primary key,
  payment_id    uuid not null references public.payments(id) on delete cascade,
  direction     text not null,
  method        text not null,
  amount        int not null,
  currency      text not null,
  msisdn        text,
  status        text not null default 'pending' check (status in ('pending', 'successful', 'failed')),
  reason        text,
  created_at    timestamptz not null default now(),
  decided_at    timestamptz
);

insert into public.app_settings (key, value, note) values
  ('payment_provider', '"sandbox"', 'Provider recorded on new payments. Must match PAYMENT_PROVIDER in the payment Edge Functions. Change only together with a deploy.'),
  ('payment_expiry_min', '30', 'Minutes a customer has to approve a mobile money prompt before the payment expires'),
  ('payout_approval_threshold', '500000', 'Cash-outs above this amount (UGX) wait for ops approval'),
  ('kyc_limits', '{"0":{"collect_tx":0,"collect_day":0,"payout_day":0},"1":{"collect_tx":2000000,"collect_day":5000000,"payout_day":0},"2":{"collect_tx":20000000,"collect_day":50000000,"payout_day":5000000}}',
    'Per-tier limits in UGX. Tier 0 = phone not verified, 1 = phone verified, 2 = ops-verified')
on conflict (key) do nothing;

create or replace function public._payment_provider() returns text
language sql stable security definer set search_path = public as $$ select coalesce(public._setting('payment_provider', '"sandbox"')#>>'{}', 'sandbox') $$;

create or replace function public._msisdn_network(p_phone text) returns text language sql immutable as $$
  select case when substr(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 4, 2) in ('76', '77', '78', '79') then 'momo'
              when substr(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 4, 2) in ('70', '74', '75') then 'airtel' end
$$;

create or replace function public._limit(p_tier int, p_key text) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce((public._setting('kyc_limits', '{}') -> p_tier::text ->> p_key)::bigint, 0)
$$;

create or replace function public._pay_event(p_payment uuid, p_kind text, p_before text, p_after text, p_detail jsonb default '{}', p_event_id text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.payment_events (payment_id, provider, kind, provider_event_id, status_before, status_after, detail)
  values (p_payment, coalesce((select provider from public.payments where id = p_payment), 'unknown'), p_kind, p_event_id, p_before, p_after, coalesce(p_detail, '{}'));
end $$;

-- Validates a mobile money / card collection against the caller's KYC tier, limits and velocity.
create or replace function public._check_collection(p_me public.profiles, p_amount int, p_method text, p_msisdn text) returns void
language plpgsql security definer set search_path = public as $$
declare tier int := public._kyc_tier(p_me.id); today bigint; open_n int;
begin
  if tier = 0 then raise exception 'Verify your phone number before paying with mobile money or card.'; end if;
  if p_method in ('momo', 'airtel') then
    if p_msisdn is null then raise exception 'Enter the mobile money number to charge, e.g. 0772 418 905.'; end if;
    if public._msisdn_network(p_msisdn) is distinct from p_method then
      raise exception '% is not an % number. Check the number or choose the other network.', public._mask_phone(p_msisdn), case p_method when 'momo' then 'MTN' else 'Airtel' end;
    end if;
  end if;
  if p_amount > public._limit(tier, 'collect_tx') then
    raise exception 'Payments above % need a verified business. Pay from your wallet, split the payment, or verify your business.', public._fmt_ugx(public._limit(tier, 'collect_tx'));
  end if;
  select coalesce(sum(amount), 0) into today from public.payments
    where initiated_by = p_me.id and direction = 'collection' and status in ('pending', 'initiated', 'successful') and created_at > now() - interval '24 hours';
  if today + p_amount > public._limit(tier, 'collect_day') then
    raise exception 'This would pass your 24-hour limit of %. Verify your business for higher limits.', public._fmt_ugx(public._limit(tier, 'collect_day'));
  end if;
  select count(*) into open_n from public.payments
    where initiated_by = p_me.id and direction = 'collection' and status in ('pending', 'initiated') and created_at > now() - interval '30 minutes';
  if open_n >= 3 then raise exception 'You have 3 payments waiting for approval. Approve or cancel them on your phone first.'; end if;
end $$;

create or replace function public._new_collection(p_me public.profiles, p_vendor uuid, p_purpose text, p_method text, p_amount int, p_msisdn text,
  p_key text, p_delivery uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare pay uuid; prov text := public._payment_provider();
begin
  insert into public.payments (vendor_id, delivery_id, purpose, method, amount, status, direction, provider, simulated, msisdn, idempotency_key,
    initiated_by, expires_at)
  values (p_vendor, p_delivery, p_purpose, p_method, p_amount, 'pending', 'collection', prov, prov = 'sandbox', p_msisdn, nullif(p_key, ''),
    p_me.id, now() + make_interval(mins => (public._setting('payment_expiry_min', '30'))::int))
  returning id into pay;
  perform public._pay_event(pay, 'created', null, 'pending', jsonb_build_object('purpose', p_purpose, 'method', p_method, 'amount', p_amount,
    'msisdn', public._mask_phone(p_msisdn)));
  return pay;
end $$;

-- Vendor wallet top-up. Creates a pending payment only; the wallet is credited when the provider confirms.
create or replace function public.payment_start_topup(p_amount int, p_method text, p_phone text default null, p_key text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v public.vendors := public._my_vendor(); me public.profiles := public._me(); pay public.payments; ph text; id_ uuid;
begin
  if p_key is not null then
    select * into pay from public.payments where initiated_by = me.id and idempotency_key = p_key;
    if pay.id is not null then return jsonb_build_object('ok', true, 'paymentId', pay.id, 'status', pay.status, 'repeat', true); end if;
  end if;
  if p_amount is null or p_amount < 5000 then raise exception 'Top up at least UGX 5,000.'; end if;
  if p_amount > 20000000 then raise exception 'Top-ups above UGX 20,000,000 need a bank transfer. Contact support.'; end if;
  if p_method not in ('momo', 'airtel', 'card') then raise exception 'Choose MTN Mobile Money, Airtel Money or card.'; end if;
  ph := case when p_method = 'card' then null else public._norm_phone(coalesce(nullif(p_phone, ''), me.phone)) end;
  perform public._check_collection(me, p_amount, p_method, ph);
  id_ := public._new_collection(me, v.id, 'topup', p_method, p_amount, ph, p_key);
  perform public._audit('payment.requested', 'payment', id_::text, null, jsonb_build_object('purpose', 'topup', 'amount', p_amount, 'method', p_method));
  return jsonb_build_object('ok', true, 'paymentId', id_, 'status', 'pending');
end $$;

-- Kept for older clients: same as payment_start_topup with the account phone.
create or replace function public.wallet_topup(p_amount int, p_method text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin return public.payment_start_topup(p_amount, p_method, null, null); end $$;

-- Publishes a paid booking to drivers (draft → pending → searching) and sends the recipient their link.
create or replace function public._publish_delivery(p_delivery uuid, p_paid_label text) returns void
language plpgsql security definer set search_path = public as $$
declare d public.deliveries; v public.vendors; rc public.recipients; pk public.packages; pay public.payments; elig int := 0; rr record; actor jsonb;
begin
  select * into d from public.deliveries where id = p_delivery for update;
  if d.status <> 'draft' then return; end if;
  select * into v from public.vendors where id = d.vendor_id;
  select * into rc from public.recipients where id = d.recipient_id;
  select * into pk from public.packages where id = d.package_id;
  select * into pay from public.payments where id = d.payment_id;
  actor := coalesce(case when auth.uid() is not null then public._actor() end,
    jsonb_build_object('role', 'vendor', 'id', d.created_by, 'name', v.name));
  perform public._set_status(d.id, 'pending', actor);
  perform public._event(d.id, 'payment', 'Payment ' || p_paid_label || ' · ' || public._method_label(pay.method) || ' · ' || public._fmt_ugx(pay.amount) ||
    case when pay.simulated then ' · sandbox' else '' end);
  perform public._notify('vendor', v.id, null, 'Delivery created: ' || d.ref, pk.description || ' → ' || rc.name || ' · ' || public._fmt_ugx(d.price_total), d.id, 'ok');
  perform public._sms(d.id, v.name || ' is sending you a delivery with Drop Off. Track it: ' || public._tracking_link(d.id) ||
    ' · Your delivery PIN is ' || (select delivery_pin from public.delivery_secrets where delivery_id = d.id) || '. Only share it with your rider once you have the package.');
  perform public._set_status(d.id, 'searching', public._sys());
  perform public._notify('ops', null, null, 'New delivery ' || d.ref, v.name || ' · ' || initcap(d.vehicle_class) || ' · ' || d.pickup_area || ' → ' || d.dropoff_area, d.id);
  for rr in select r.id from public.riders r where r.online and r.active_delivery_id is null and public._rider_fits(d.id, r.id) loop
    perform public._notify('rider', null, rr.id, 'New delivery request', d.pickup_name || ' → ' || d.dropoff_area || ' · earn ' ||
      public._fmt_ugx(public._rider_share(d.price_total, d.commission_pct)), d.id, 'offer');
    elig := elig + 1;
  end loop;
  if elig = 0 then
    update public.deliveries set no_driver = true where id = d.id;
    perform public._event(d.id, 'no_driver', 'No suitable driver online right now · still visible to drivers who come online');
    perform public._notify('vendor', v.id, null, 'No driver available yet', 'No ' || d.vehicle_class || ' drivers are free near ' || d.pickup_area || '. We keep searching.', d.id, 'bad');
    perform public._notify('ops', null, null, 'No driver for ' || d.ref, initcap(d.vehicle_class) || ' needed at ' || d.pickup_area, d.id, 'bad');
  else
    perform public._event(d.id, 'broadcast', 'Request shown to ' || elig || ' eligible driver' || case when elig = 1 then '' else 's' end || ' online');
  end if;
end $$;

-- A booking that was never paid for is cancelled without touching drivers, the recipient or the ledger.
create or replace function public._cancel_draft(p_delivery uuid, p_reason text, p_actor jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare d public.deliveries;
begin
  select * into d from public.deliveries where id = p_delivery for update;
  if d.status <> 'draft' then return; end if;
  update public.deliveries set status = 'cancelled', cancel_reason = p_reason where id = d.id;
  perform public._event(d.id, 'cancelled', 'Booking not sent · ' || p_reason, p_actor);
  perform public._notify('vendor', d.vendor_id, null, d.ref || ' not booked', p_reason || '. Nothing was sent to drivers.', d.id, 'warn');
  perform public._audit('delivery.draft_cancelled', 'delivery', d.ref, d.id, jsonb_build_object('reason', p_reason));
end $$;

create or replace function public.create_delivery(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.vendors := public._my_vendor();
  me public.profiles := public._me();
  pick public.places; drop_ public.places; dz public.service_areas; pz public.service_areas;
  ph text; nm text := trim(coalesce(p->>'recipient_name', '')); w numeric; val int; sz public.package_sizes;
  el text[]; cls text := p->>'vehicle_class'; q jsonb; total int; method text := coalesce(p->>'method', v.default_method);
  rec uuid; pkg uuid; did uuid; ref_ text; pay uuid; wmain uuid; wcred uuid; avail bigint; used bigint; travel numeric; payer text;
  prov text := public._payment_provider();
begin
  if p ? 'idempotency_key' and nullif(p->>'idempotency_key', '') is not null then
    select delivery_id into did from public.payments where initiated_by = me.id and idempotency_key = p->>'idempotency_key';
    if did is not null then
      return (select jsonb_build_object('id', d.id, 'ref', d.ref, 'total', d.price_total, 'paymentId', d.payment_id, 'awaitingPayment', d.status = 'draft', 'repeat', true)
        from public.deliveries d where d.id = did);
    end if;
  end if;
  -- route
  select * into pick from public.places where id = p->>'pickup' and is_active;
  if pick.id is null or not exists (select 1 from public.vendor_locations where vendor_id = v.id and place_id = pick.id) then
    raise exception 'Choose where the driver collects the package.';
  end if;
  select * into drop_ from public.places where id = p->>'dropoff' and is_active;
  if drop_.id is null then raise exception 'Choose where the package is going.'; end if;
  if drop_.id = pick.id then raise exception 'Drop-off must be different from pickup.'; end if;
  select * into dz from public.service_areas where id = drop_.zone_id;
  select * into pz from public.service_areas where id = pick.zone_id;
  if not dz.enabled then raise exception '% is outside our live service area. Pick another address or ask ops to open %.', drop_.area, dz.name; end if;
  if not pz.enabled then raise exception 'Pickups from % are paused right now.', pz.name; end if;
  -- recipient
  if length(nm) < 2 then raise exception 'Enter the recipient''s name.'; end if;
  ph := public._norm_phone(p->>'recipient_phone');
  if ph is null then raise exception 'Enter a Ugandan mobile number, e.g. 0753 512 640.'; end if;
  -- package
  if coalesce(p->>'type', '') not in ('food', 'groceries', 'pharmacy', 'documents', 'clothing', 'electronics', 'cake', 'flowers', 'furniture', 'appliance', 'stock', 'other') then
    raise exception 'Pick what you are sending.';
  end if;
  if length(trim(coalesce(p->>'description', ''))) < 3 then raise exception 'Describe the package so the driver can recognise it.'; end if;
  select * into sz from public.package_sizes where id = p->>'size';
  if sz.id is null then raise exception 'Choose a package size.'; end if;
  begin w := (p->>'weight')::numeric; exception when others then w := null; end;
  if w is null or w <= 0 then raise exception 'Enter an approximate weight.'; end if;
  if w > 5000 then raise exception 'Our largest truck carries 5,000 kg. Split this into several deliveries.'; end if;
  if w > sz.max_kg then raise exception '% kg is too heavy for a % package. Choose a larger size.', w, sz.label; end if;
  begin val := coalesce(nullif(p->>'value', '')::numeric, 0)::int; exception when others then val := -1; end;
  if val < 0 then raise exception 'Declared value cannot be negative.'; end if;
  el := public._eligible_classes(sz.id, w);
  if array_length(el, 1) is null then raise exception 'No enabled vehicle class can carry this. Ops has switched off the vehicles it needs.'; end if;
  if cls is null then raise exception 'Choose a vehicle.'; end if;
  if not cls = any(el) then raise exception 'A % can''t carry this package. Pick one of the available vehicles.', cls; end if;
  if coalesce(p->>'photo_path', '') <> '' and split_part(p->>'photo_path', '/', 1) <> v.id::text then raise exception 'Upload the package photo again.'; end if;
  -- price (computed here; the client only previews it)
  q := public._quote(pick.id, drop_.id, cls, coalesce((p->>'fragile')::boolean, false), coalesce(p->>'urgency', 'standard') = 'express');
  total := (q->>'total')::int;
  if p ? 'quoted_total' and (p->>'quoted_total')::int <> total then
    raise exception 'Prices changed while you were booking. The new price is %. Review it and confirm again.', public._fmt_ugx(total);
  end if;
  if method not in ('wallet', 'momo', 'airtel', 'card', 'credit') then raise exception 'Choose how to pay.'; end if;
  if method in ('momo', 'airtel', 'card') then
    payer := case when method = 'card' then null else public._norm_phone(coalesce(nullif(p->>'payer_phone', ''), me.phone)) end;
    perform public._check_collection(me, total, method, payer);
  end if;

  -- records
  insert into public.recipients (vendor_id, name, phone, default_place_id, notes)
  values (v.id, nm, ph, drop_.id, coalesce(trim(p->>'notes'), ''))
  on conflict (vendor_id, phone) do update set name = excluded.name, default_place_id = excluded.default_place_id, notes = excluded.notes
  returning id into rec;
  insert into public.packages (vendor_id, type, description, size, weight_kg, declared_value, fragile, upright, photo_path)
  values (v.id, p->>'type', trim(p->>'description'), sz.id, w, val, coalesce((p->>'fragile')::boolean, false), coalesce((p->>'upright')::boolean, false), nullif(p->>'photo_path', ''))
  returning id into pkg;
  travel := public._route_km10(pick.lat, pick.lng, drop_.lat, drop_.lng) / 10.0 / (select speed_kmh from public.vehicle_classes where id = cls) * 60;
  insert into public.deliveries (vendor_id, created_by, recipient_id, package_id, status,
    pickup_place_id, pickup_name, pickup_area, pickup_x, pickup_y, pickup_lat, pickup_lng,
    dropoff_place_id, dropoff_name, dropoff_area, dropoff_x, dropoff_y, dropoff_lat, dropoff_lng,
    recipient_notes, vehicle_class, recommended_class, urgency, price_total, price_km, price_lines, commission_pct,
    sig_required, promised_at, is_demo)
  values (v.id, me.id, rec, pkg, 'draft',
    pick.id, pick.name, pick.area, pick.x, pick.y, pick.lat, pick.lng,
    drop_.id, drop_.name, drop_.area, drop_.x, drop_.y, drop_.lat, drop_.lng,
    coalesce(trim(p->>'notes'), ''), cls, public._recommend(sz.id, w), coalesce(p->>'urgency', 'standard'), total, (q->>'km')::numeric, q->'lines',
    (q->>'commission')::numeric, val >= 300000 or p->>'type' = 'documents', now() + make_interval(mins => ceil(8 + travel + 10)::int), v.is_demo)
  returning id, ref into did, ref_;
  insert into public.delivery_secrets (delivery_id, pickup_pin, delivery_pin, tracking_token)
  values (did, public._random_pin(), public._random_pin(), public._random_token());
  insert into public.proof_of_delivery (delivery_id, delivery_ref) values (did, ref_);
  update public.deliveries set proof_id = (select id from public.proof_of_delivery where delivery_id = did) where id = did;

  -- payment
  if method in ('momo', 'airtel', 'card') then
    -- collected first; the booking reaches drivers only when the provider confirms the money (payment_apply_result)
    pay := public._new_collection(me, v.id, 'delivery', method, total, payer, p->>'idempotency_key', did);
    update public.deliveries set payment_id = pay where id = did;
    perform public._event(did, 'awaiting_payment', 'Waiting for ' || public._method_label(method) || ' payment · ' || public._fmt_ugx(total), public._actor());
    perform public._audit('delivery.created', 'delivery', ref_, did, jsonb_build_object('amount', total, 'method', method, 'class', cls, 'awaiting_payment', true));
    return jsonb_build_object('id', did, 'ref', ref_, 'total', total, 'paymentId', pay, 'awaitingPayment', true);
  end if;
  wmain := public._wallet_id('vendor', v.id, 'main');
  insert into public.payments (delivery_id, vendor_id, purpose, method, amount, status, direction, provider, simulated, initiated_by, idempotency_key)
  values (did, v.id, 'delivery', method, total, 'pending', 'internal', 'internal', prov = 'sandbox', me.id, nullif(p->>'idempotency_key', '')) returning id into pay;
  if method = 'wallet' then
    select balance into avail from public.wallets where id = wmain for update;
    if avail < total then
      raise exception 'Your wallet has %, which is not enough for %. Top up or choose another payment method.', public._fmt_ugx(avail), public._fmt_ugx(total);
    end if;
    perform public._wallet_post(wmain, 'charge', -total, 'wallet', 'Delivery ' || ref_, 'held', did, pay, total);
  else
    if not v.credit_eligible or v.verification_status <> 'verified' then raise exception 'Credit accounts open after business verification.'; end if;
    wcred := public._wallet_id('vendor', v.id, 'credit');
    select -balance, credit_limit into used, avail from public.wallets where id = wcred for update;
    if avail - used < total then raise exception 'Only % of credit remains. Pay your invoice or choose another method.', public._fmt_ugx(avail - used); end if;
    perform public._wallet_post(wcred, 'charge', -total, 'credit', 'Delivery ' || ref_, 'held', did, pay, total);
  end if;
  update public.payments set status = 'initiated' where id = pay;
  update public.deliveries set payment_id = pay where id = did;
  perform public._publish_delivery(did, 'reserved');
  perform public._audit('delivery.created', 'delivery', ref_, did, jsonb_build_object('amount', total, 'method', method, 'class', cls));
  return jsonb_build_object('id', did, 'ref', ref_, 'total', total, 'paymentId', pay, 'awaitingPayment', false);
end $$;

create or replace function public.vendor_cancel(p_delivery uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._vendor_delivery(p_delivery);
begin
  if d.status = 'draft' then
    -- a payment that was never sent to the provider is closed; one already on the customer's phone may still be
    -- approved, in which case payment_apply_result credits the wallet instead
    update public.payments set status = 'failed', failure_reason = 'Booking cancelled before payment' where id = d.payment_id and status = 'pending';
    perform public._cancel_draft(d.id, coalesce(nullif(trim(p_reason), ''), 'Cancelled by vendor'), public._actor());
    return;
  end if;
  if d.status not in ('pending', 'searching', 'assigned', 'en_route_pickup', 'at_pickup') then
    raise exception 'The package is already with the driver. Contact support to stop this delivery.';
  end if;
  perform public._set_status(d.id, 'cancelled', public._actor(), jsonb_build_object('reason', coalesce(nullif(trim(p_reason), ''), 'Cancelled by vendor')));
end $$;

/* ---- payouts (rider cash-out, vendor withdrawal) ---- */

create or replace function public.request_payout(p_amount int default null, p_key text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me public.profiles := public._me(); r public.riders; v public.vendors; w uuid; bal bigint; amt int; pay uuid; tx uuid;
  tier int; today bigint; thr int; method text; prov text := public._payment_provider(); existing public.payments;
begin
  if p_key is not null then
    select * into existing from public.payments where initiated_by = me.id and idempotency_key = p_key;
    if existing.id is not null then return jsonb_build_object('ok', true, 'paymentId', existing.id, 'status', existing.status, 'repeat', true); end if;
  end if;
  if me.role = 'rider' then
    select * into r from public.riders where profile_id = me.id;
    if r.verification_status <> 'verified' then raise exception 'Cash-out opens once ops verify your account.'; end if;
    w := public._wallet_id('rider', r.id);
  elsif me.role = 'vendor' then
    select * into v from public.vendors where owner_id = me.id order by created_at limit 1;
    if v.id is null then raise exception 'Only the business owner can withdraw.'; end if;
    if v.verification_status <> 'verified' then raise exception 'Withdrawals open once your business is verified.'; end if;
    w := public._wallet_id('vendor', v.id, 'main');
  else
    raise exception 'Only drivers and business owners can cash out.';
  end if;
  if me.phone_verified_at is null then raise exception 'Verify your phone number first. Cash-outs only go to your verified number.'; end if;
  if me.phone_changed_at is not null and me.phone_changed_at > now() - interval '24 hours' then
    raise exception 'For your security, cash-out is paused for 24 hours after a phone number change.';
  end if;
  method := public._msisdn_network(me.phone);
  if method is null then raise exception 'Your verified number is not an MTN or Airtel mobile money line.'; end if;
  if exists (select 1 from public.payments where initiated_by = me.id and direction = 'disbursement' and status in ('pending', 'initiated')) then
    raise exception 'You already have a cash-out in progress. Wait for it to finish.';
  end if;
  select balance into bal from public.wallets where id = w for update;
  amt := coalesce(p_amount, bal::int);
  if amt is null or amt < 1000 then raise exception 'You need at least UGX 1,000 to cash out.'; end if;
  if amt > bal then raise exception 'You can cash out up to %.', public._fmt_ugx(bal); end if;
  tier := public._kyc_tier(me.id);
  select coalesce(sum(amount), 0) into today from public.payments
    where initiated_by = me.id and direction = 'disbursement' and status in ('pending', 'initiated', 'successful') and created_at > now() - interval '24 hours';
  if today + amt > public._limit(tier, 'payout_day') then
    raise exception 'This would pass your 24-hour cash-out limit of %.', public._fmt_ugx(public._limit(tier, 'payout_day'));
  end if;
  thr := (public._setting('payout_approval_threshold', '500000'))::int;
  insert into public.payments (rider_id, vendor_id, purpose, method, amount, status, direction, provider, simulated, msisdn, idempotency_key, initiated_by,
    approval_status, expires_at)
  values (r.id, v.id, case when r.id is not null then 'payout' else 'withdrawal' end, method, amt, 'pending', 'disbursement', prov, prov = 'sandbox',
    me.phone, p_key, me.id, case when amt > thr then 'awaiting_approval' else 'approved' end, now() + interval '3 days')
  returning id into pay;
  -- the money leaves the balance now (status pending) and comes back if the transfer fails
  tx := public._wallet_post(w, 'payout', -amt, method, 'Cash out to ' || public._method_label(method) || ' ' || public._mask_phone(me.phone), 'pending', null, pay);
  update public.payments set ledger_tx = tx where id = pay;
  perform public._pay_event(pay, 'created', null, 'pending', jsonb_build_object('purpose', 'payout', 'amount', amt, 'msisdn', public._mask_phone(me.phone),
    'approval', case when amt > thr then 'awaiting_approval' else 'approved' end));
  if amt > thr then
    perform public._notify('ops', null, null, 'Cash-out needs approval', me.full_name || ' · ' || public._fmt_ugx(amt) || ' to ' || public._mask_phone(me.phone), null, 'warn');
  end if;
  perform public._audit('payout.requested', 'payment', pay::text, null, jsonb_build_object('amount', amt, 'needs_approval', amt > thr));
  return jsonb_build_object('ok', true, 'paymentId', pay, 'status', 'pending', 'needsApproval', amt > thr, 'amount', amt);
end $$;

create or replace function public.rider_request_payout(p_amount int default null) returns jsonb
language plpgsql security definer set search_path = public as $$
begin return public.request_payout(p_amount, null); end $$;

create or replace function public._reverse_payout(p_payment uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare pay public.payments; t public.wallet_transactions;
begin
  select * into pay from public.payments where id = p_payment;
  select * into t from public.wallet_transactions where id = pay.ledger_tx for update;
  if t.id is null or t.status <> 'pending' then return; end if;
  update public.wallet_transactions set status = 'failed' where id = t.id;
  perform public._wallet_post(t.wallet_id, 'adjustment', -t.amount, t.method, 'Cash-out reversed · ' || p_reason, 'completed', null, pay.id);
end $$;

/* ---- provider results (service role only) ---- */

create or replace function public._notify_payer(pay public.payments, p_title text, p_body text, p_kind text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if pay.rider_id is not null then perform public._notify('rider', null, pay.rider_id, p_title, p_body, pay.delivery_id, p_kind);
  elsif pay.vendor_id is not null then perform public._notify('vendor', pay.vendor_id, null, p_title, p_body, pay.delivery_id, p_kind); end if;
end $$;

create or replace function public._flag_payment(p_payment uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.payments set needs_review = true, review_reason = p_reason where id = p_payment;
  perform public._pay_event(p_payment, 'review', null, null, jsonb_build_object('reason', p_reason));
  perform public._notify('ops', null, null, 'Payment needs review', p_reason, (select delivery_id from public.payments where id = p_payment), 'bad');
end $$;

-- The single place where a provider's answer changes money. Idempotent: replays and late callbacks never
-- move money twice. Amount and currency must match exactly or the payment is held for review.
create or replace function public.payment_apply_result(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  pay public.payments; st text := p->>'status'; d public.deliveries; w uuid; amt bigint; cur text; label text; ev text := nullif(p->>'provider_event_id', '');
begin
  if st not in ('successful', 'failed', 'pending') then raise exception 'Unknown payment status %', st; end if;
  if ev is not null and exists (select 1 from public.payment_events where provider = coalesce(p->>'provider', '') and provider_event_id = ev) then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  if p ? 'payment_id' then select * into pay from public.payments where id = (p->>'payment_id')::uuid for update;
  else select * into pay from public.payments where provider = p->>'provider' and provider_ref = p->>'provider_ref' for update; end if;
  if pay.id is null then return jsonb_build_object('ok', false, 'error', 'unknown payment'); end if;
  if p ? 'provider' and p->>'provider' <> pay.provider then
    perform public._flag_payment(pay.id, 'A ' || (p->>'provider') || ' result arrived for a ' || pay.provider || ' payment.');
    return jsonb_build_object('ok', false, 'error', 'provider mismatch');
  end if;
  perform public._pay_event(pay.id, coalesce(p->>'source', 'result'), pay.status, st,
    jsonb_strip_nulls(jsonb_build_object('amount', p->'amount', 'currency', p->'currency', 'reason', p->'reason', 'provider_txn_id', p->'provider_txn_id',
      'provider_status', p->'provider_status')), ev);
  update public.payments set last_checked_at = now(), check_count = check_count + 1, provider_status = coalesce(p->>'provider_status', st) where id = pay.id;

  if st = 'pending' then return jsonb_build_object('ok', true, 'status', pay.status); end if;
  if pay.status not in ('pending', 'initiated') then
    if pay.status = 'successful' and st = 'failed' or pay.status = 'failed' and st = 'successful' then
      perform public._flag_payment(pay.id, 'Provider now reports ' || st || ' for a payment recorded as ' || pay.status || ' (' || coalesce(pay.provider_ref, pay.id::text) || ').');
    end if;
    return jsonb_build_object('ok', true, 'status', pay.status, 'final', true);
  end if;

  if st = 'successful' then
    amt := (p->>'amount')::bigint; cur := coalesce(p->>'currency', pay.currency);
    if amt is distinct from pay.amount::bigint or cur is distinct from pay.currency then
      perform public._flag_payment(pay.id, 'Amount mismatch: expected ' || pay.currency || ' ' || pay.amount || ', provider reported ' || coalesce(cur, '?') || ' ' || coalesce(amt::text, '?') || '. No money was credited.');
      return jsonb_build_object('ok', false, 'error', 'amount mismatch');
    end if;
    update public.payments set status = 'successful', provider_txn_id = coalesce(p->>'provider_txn_id', provider_txn_id),
      captured_at = case when purpose = 'delivery' then captured_at else now() end, failure_reason = null where id = pay.id;
    label := public._method_label(pay.method) || case when pay.simulated then ' (sandbox)' else '' end;
    if pay.direction = 'collection' then
      w := public._wallet_id('vendor', pay.vendor_id, 'main');
      if pay.purpose = 'topup' then
        perform public._wallet_post(w, 'topup', pay.amount, pay.method, 'Top up · ' || label, 'completed', null, pay.id);
        perform public._notify_payer(pay, 'Wallet topped up', public._fmt_ugx(pay.amount) || ' added via ' || label || '.', 'money');
      elsif pay.purpose = 'delivery' then
        select * into d from public.deliveries where id = pay.delivery_id for update;
        perform public._wallet_post(w, 'topup', pay.amount, pay.method, label || ' payment · ' || d.ref, 'completed', d.id, pay.id);
        if d.status = 'draft' then
          perform public._wallet_post(w, 'charge', -pay.amount, pay.method, 'Delivery ' || d.ref, 'held', d.id, pay.id, pay.amount);
          perform public._publish_delivery(d.id, 'received');
        else
          perform public._notify_payer(pay, 'Payment kept in your wallet', public._fmt_ugx(pay.amount) || ' for ' || d.ref ||
            ' arrived after the booking was cancelled. It is in your Drop Off wallet.', 'money');
        end if;
      end if;
    else
      update public.wallet_transactions set status = 'paid' where id = pay.ledger_tx;
      perform public._notify_payer(pay, 'Cash-out sent', public._fmt_ugx(pay.amount) || ' sent to ' || label || ' ' || public._mask_phone(pay.msisdn) || '.', 'money');
    end if;
    perform public._audit('payment.successful', 'payment', pay.id::text, pay.delivery_id, jsonb_build_object('amount', pay.amount, 'purpose', pay.purpose, 'provider', pay.provider));
  else
    update public.payments set status = 'failed', failure_reason = coalesce(nullif(p->>'reason', ''), 'Declined by the provider') where id = pay.id;
    if pay.direction = 'disbursement' then
      perform public._reverse_payout(pay.id, coalesce(nullif(p->>'reason', ''), 'transfer failed'));
      perform public._notify_payer(pay, 'Cash-out failed', public._fmt_ugx(pay.amount) || ' is back in your balance. ' || coalesce(p->>'reason', ''), 'bad');
    elsif pay.purpose = 'delivery' then
      perform public._cancel_draft(pay.delivery_id, 'Payment not completed · ' || coalesce(nullif(p->>'reason', ''), 'declined'), public._sys());
    else
      perform public._notify_payer(pay, 'Top-up not completed', coalesce(nullif(p->>'reason', ''), 'The payment was declined') || '. Nothing was charged.', 'bad');
    end if;
    perform public._audit('payment.failed', 'payment', pay.id::text, pay.delivery_id, jsonb_build_object('amount', pay.amount, 'reason', p->>'reason'));
  end if;
  return jsonb_build_object('ok', true, 'status', st);
end $$;

-- Called by payments-initiate with the USER's token: checks the caller owns the payment and claims it once.
create or replace function public.payment_request_initiation(p_payment uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._me(); pay public.payments; nm text;
begin
  select * into pay from public.payments where id = p_payment for update;
  if pay.id is null or not (pay.initiated_by = me.id or public.is_ops()) then raise exception 'Payment not found.' using errcode = 'P0002'; end if;
  return public._claim_payment(pay.id);
end $$;

create or replace function public._claim_payment(p_payment uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pay public.payments; nm text; descr text;
begin
  select * into pay from public.payments where id = p_payment for update;
  if pay.direction = 'internal' then raise exception 'This payment does not use a provider.'; end if;
  if pay.status <> 'pending' then return jsonb_build_object('ok', false, 'error', 'This payment was already sent.', 'status', pay.status); end if;
  if pay.approval_status in ('awaiting_approval', 'rejected') then return jsonb_build_object('ok', false, 'error', 'This cash-out is waiting for ops approval.'); end if;
  if pay.expires_at is not null and pay.expires_at < now() then
    perform public.payment_apply_result(jsonb_build_object('payment_id', pay.id, 'status', 'failed', 'reason', 'Expired before it was sent', 'source', 'expiry'));
    return jsonb_build_object('ok', false, 'error', 'This payment expired. Start again.');
  end if;
  if pay.claimed_at is not null and pay.claimed_at > now() - interval '2 minutes' then return jsonb_build_object('ok', false, 'error', 'Already being sent.'); end if;
  update public.payments set claimed_at = now() where id = pay.id;
  select full_name into nm from public.profiles where id = pay.initiated_by;
  descr := case pay.purpose when 'topup' then 'Drop Off wallet top-up' when 'delivery' then 'Drop Off delivery ' || coalesce((select ref from public.deliveries where id = pay.delivery_id), '')
    else 'Drop Off cash-out' end;
  return jsonb_build_object('ok', true, 'payment', jsonb_build_object('id', pay.id, 'provider', pay.provider, 'direction', pay.direction, 'purpose', pay.purpose,
    'method', pay.method, 'amount', pay.amount, 'currency', pay.currency, 'msisdn', regexp_replace(coalesce(pay.msisdn, ''), '\D', '', 'g'),
    'description', descr, 'kycName', nm, 'nameChecked', pay.account_name is not null));
end $$;

create or replace function public.payment_claim(p_payment uuid) returns jsonb
language sql security definer set search_path = public as $$ select public._claim_payment(p_payment) $$;

create or replace function public.payment_mark_initiated(p_payment uuid, p_provider_ref text, p_checkout_url text default null, p_detail jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public as $$
declare pay public.payments;
begin
  select * into pay from public.payments where id = p_payment for update;
  if pay.status <> 'pending' then return jsonb_build_object('ok', false, 'status', pay.status); end if;
  update public.payments set status = 'initiated', provider_ref = p_provider_ref, checkout_url = p_checkout_url, claimed_at = null where id = pay.id;
  perform public._pay_event(pay.id, 'initiated', 'pending', 'initiated', coalesce(p_detail, '{}') || jsonb_build_object('provider_ref', p_provider_ref));
  return jsonb_build_object('ok', true);
end $$;

-- The adapter's account-holder lookup (where the provider offers one) is compared with the KYC name before a first payout.
create or replace function public.payment_record_name_check(p_payment uuid, p_account_name text, p_match boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.payments set account_name = coalesce(p_account_name, '(not returned)') where id = p_payment;
  perform public._pay_event(p_payment, 'name_check', null, null, jsonb_build_object('account_name', p_account_name, 'match', p_match));
  if not p_match then
    update public.payments set approval_status = 'awaiting_approval', claimed_at = null where id = p_payment;
    perform public._flag_payment(p_payment, 'Mobile money account name "' || coalesce(p_account_name, '?') || '" does not match the verified name. Cash-out held for ops approval.');
  end if;
end $$;

create or replace function public.payment_lookup_ref(p_provider text, p_ref text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', id, 'direction', direction, 'status', status, 'providerRef', provider_ref)
  from public.payments where provider = p_provider and (provider_ref = p_ref or id::text = p_ref) limit 1
$$;

-- Work list for payments-reconcile.
create or replace function public.payments_due(p_limit int default 50) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x), '[]') from (
    select jsonb_build_object('id', id, 'provider', provider, 'direction', direction, 'status', status, 'providerRef', provider_ref,
      'action', case when status = 'pending' then 'initiate' else 'check' end, 'expired', expires_at is not null and expires_at < now()) x
    from public.payments
    where direction <> 'internal' and (
      (status = 'pending' and approval_status in ('not_required', 'approved') and created_at < now() - interval '20 seconds'
        and (claimed_at is null or claimed_at < now() - interval '2 minutes'))
      or (status = 'initiated' and (last_checked_at is null or last_checked_at < now() - interval '45 seconds')))
    order by created_at limit p_limit) s
$$;

/* ---- sandbox provider (stands in for MTN/Airtel/card until a real provider is configured) ---- */

create or replace function public.sandbox_create(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ref_ text := 'SBX-' || upper(encode(extensions.gen_random_bytes(6), 'hex'));
begin
  insert into public.payment_sandbox (provider_ref, payment_id, direction, method, amount, currency, msisdn)
  values (ref_, (p->>'payment_id')::uuid, p->>'direction', p->>'method', (p->>'amount')::int, p->>'currency', p->>'msisdn');
  return jsonb_build_object('provider_ref', ref_);
end $$;

create or replace function public.sandbox_get(p_ref text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('providerRef', s.provider_ref, 'paymentId', s.payment_id, 'direction', s.direction, 'method', s.method, 'amount', s.amount,
    'currency', s.currency, 'msisdn', s.msisdn, 'status', s.status, 'reason', s.reason, 'createdAt', s.created_at,
    'payee', case when s.direction = 'collection' then 'Drop Off' else null end,
    'purpose', p.purpose, 'paymentStatus', p.status)
  from public.payment_sandbox s join public.payments p on p.id = s.payment_id where s.provider_ref = p_ref
$$;

create or replace function public.sandbox_decide(p_ref text, p_approve boolean, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.payment_sandbox;
begin
  select * into s from public.payment_sandbox where provider_ref = p_ref for update;
  if s.provider_ref is null then return jsonb_build_object('ok', false, 'error', 'Unknown request'); end if;
  if s.status <> 'pending' then return jsonb_build_object('ok', false, 'error', 'Already ' || s.status); end if;
  update public.payment_sandbox set status = case when p_approve then 'successful' else 'failed' end,
    reason = case when p_approve then null else coalesce(p_reason, 'Declined by customer') end, decided_at = now() where provider_ref = p_ref;
  return jsonb_build_object('ok', true);
end $$;

-- Sandbox "telco register": the name on file for a number (the profile with that verified phone).
create or replace function public.sandbox_account_name(p_msisdn text) returns text
language sql stable security definer set search_path = public as $$
  select case when right(regexp_replace(coalesce(p_msisdn, ''), '\D', '', 'g'), 3) = '999' then 'Unregistered Holder'
    else (select full_name from public.profiles where phone = public._norm_phone(p_msisdn) and phone_verified_at is not null order by created_at limit 1) end
$$;

/* ---- ops ---- */

create or replace function public.ops_review_payout(p_payment uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_ops(); pay public.payments;
begin
  select * into pay from public.payments where id = p_payment for update;
  if pay.id is null or pay.direction <> 'disbursement' then raise exception 'Cash-out not found.'; end if;
  if pay.status <> 'pending' or pay.approval_status <> 'awaiting_approval' then raise exception 'This cash-out is not waiting for approval.'; end if;
  if pay.initiated_by = me.id then raise exception 'Another ops member must approve your own cash-out.'; end if;
  if not p_approve and length(trim(coalesce(p_note, ''))) < 3 then raise exception 'Add a note explaining the rejection. The requester sees it.'; end if;
  if p_approve then
    update public.payments set approval_status = 'approved', approved_by = me.id, approved_at = now(), needs_review = false where id = pay.id;
    perform public._pay_event(pay.id, 'approved', 'pending', 'pending', jsonb_build_object('by', me.full_name, 'note', p_note));
  else
    update public.payments set approval_status = 'rejected', approved_by = me.id, approved_at = now(), status = 'failed',
      failure_reason = 'Rejected by Drop Off: ' || trim(p_note) where id = pay.id;
    perform public._pay_event(pay.id, 'rejected', 'pending', 'failed', jsonb_build_object('by', me.full_name, 'note', p_note));
    perform public._reverse_payout(pay.id, 'rejected by ops');
    perform public._notify_payer(pay, 'Cash-out not approved', trim(p_note) || ' · ' || public._fmt_ugx(pay.amount) || ' is back in your balance.', 'bad');
  end if;
  perform public._audit(case when p_approve then 'ops.payout_approved' else 'ops.payout_rejected' end, 'payment', pay.id::text, null,
    jsonb_build_object('amount', pay.amount, 'note', p_note));
end $$;

create or replace function public.ops_clear_payment_review(p_payment uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_ops();
begin
  if length(trim(coalesce(p_note, ''))) < 3 then raise exception 'Note what you checked before clearing the flag.'; end if;
  update public.payments set needs_review = false where id = p_payment and needs_review;
  if not found then raise exception 'This payment is not flagged.'; end if;
  perform public._pay_event(p_payment, 'review_cleared', null, null, jsonb_build_object('by', me.full_name, 'note', p_note));
  perform public._audit('ops.payment_review_cleared', 'payment', p_payment::text, null, jsonb_build_object('note', p_note));
end $$;

-- Ledger integrity check for ops: every wallet balance equals the sum of its ledger rows, and every
-- confirmed collection has exactly one matching credit.
create or replace function public.ledger_check() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me public.profiles := public._require_ops(); wm jsonb; pm jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('wallet', w.id, 'owner', w.owner_type, 'balance', w.balance, 'ledger', s.total)), '[]') into wm
  from public.wallets w left join (select wallet_id, sum(amount) total from public.wallet_transactions group by wallet_id) s on s.wallet_id = w.id
  where w.balance <> coalesce(s.total, 0);
  select coalesce(jsonb_agg(jsonb_build_object('payment', p.id, 'amount', p.amount, 'credits', c.n)), '[]') into pm
  from public.payments p left join (select payment_id, count(*) n from public.wallet_transactions where type = 'topup' group by payment_id) c on c.payment_id = p.id
  where p.direction = 'collection' and p.status in ('successful', 'refunded', 'partially_refunded', 'disputed') and coalesce(c.n, 0) <> 1;
  return jsonb_build_object('ok', jsonb_array_length(wm) = 0 and jsonb_array_length(pm) = 0, 'walletMismatches', wm, 'paymentMismatches', pm, 'checkedAt', now());
end $$;

create or replace function public.ops_set_setting(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_ops();
begin
  if p_key not in ('enforce_geofence', 'geofence_m', 'approach_radius_m', 'unreachable_wait_min', 'tracking_base_url', 'payout_approval_threshold', 'payment_expiry_min') then
    raise exception 'Unknown setting.';
  end if;
  if p_key = 'payout_approval_threshold' and ((p_value#>>'{}')::numeric < 0 or (p_value#>>'{}')::numeric > 50000000) then raise exception 'Use 0 to UGX 50,000,000.'; end if;
  if p_key = 'payment_expiry_min' and ((p_value#>>'{}')::numeric < 5 or (p_value#>>'{}')::numeric > 120) then raise exception 'Use 5 to 120 minutes.'; end if;
  update public.app_settings set value = p_value, updated_at = now() where key = p_key;
  perform public._audit('ops.setting_updated', 'setting', p_key, null, jsonb_build_object('value', p_value));
end $$;

/* ================================================================== 5. driver supply for the map */

-- Online, free, verified drivers with a fresh GPS fix, grouped into ~330 m cells. No identities are returned.
create or replace function public.available_drivers() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('cls', cls, 'lat', lat, 'lng', lng, 'n', n)), '[]') from (
    select v.class_id cls, round(l.lat::numeric / 0.003) * 0.003 lat, round(l.lng::numeric / 0.003) * 0.003 lng, count(*) n
    from public.riders r join public.profiles pr on pr.id = r.profile_id and pr.status = 'active'
      join public.vehicles v on v.rider_id = r.id and v.is_active
      join public.rider_locations l on l.rider_id = r.id and l.updated_at > now() - interval '10 minutes'
    where r.online and r.active_delivery_id is null and r.verification_status = 'verified' and auth.uid() is not null
    group by 1, 2, 3) x
$$;

/* ================================================================== recipient payload: pickup coordinates for the real map */

create or replace function public._recipient_json(d public.deliveries) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v public.vendors; r public.riders; veh public.vehicles; rp public.recipients; pk public.packages; pod public.proof_of_delivery;
  sec public.delivery_secrets; loc public.rider_locations; live boolean;
begin
  select * into v from public.vendors where id = d.vendor_id;
  select * into r from public.riders where id = d.rider_id;
  select * into veh from public.vehicles where id = d.vehicle_id;
  select * into rp from public.recipients where id = d.recipient_id;
  select * into pk from public.packages where id = d.package_id;
  select * into pod from public.proof_of_delivery where delivery_id = d.id;
  select * into sec from public.delivery_secrets where delivery_id = d.id;
  live := d.status in ('assigned', 'en_route_pickup', 'at_pickup', 'picked_up', 'in_transit', 'approaching', 'arrived', 'awaiting_confirmation');
  if live and r.id is not null then select * into loc from public.rider_locations where rider_id = r.id and updated_at > now() - interval '10 minutes'; end if;
  return jsonb_build_object(
    'id', d.id, 'ref', d.ref, 'status', d.status, 'statusAt', d.status_at, 'createdAt', d.created_at, 'promisedAt', d.promised_at,
    'vendor', jsonb_build_object('name', v.name, 'initials', v.initials),
    'recipient', jsonb_build_object('name', rp.name, 'phoneMasked', public._mask_phone(rp.phone), 'notes', d.recipient_notes),
    'pickup', jsonb_build_object('name', d.pickup_name, 'area', d.pickup_area, 'lat', d.pickup_lat, 'lng', d.pickup_lng),
    'dropoff', jsonb_build_object('name', d.dropoff_name, 'area', d.dropoff_area, 'lat', d.dropoff_lat, 'lng', d.dropoff_lng),
    'pkg', jsonb_build_object('desc', pk.description, 'type', pk.type, 'size', pk.size, 'weight', pk.weight_kg),
    'cls', d.vehicle_class, 'km', d.price_km, 'failReason', d.fail_reason, 'cancelReason', d.cancel_reason, 'resolution', d.resolution, 'rating', d.rating,
    'deliveryPin', sec.delivery_pin, 'pinAttempts', sec.pin_attempts, 'sigRequired', d.sig_required,
    'rider', case when r.id is null then null else jsonb_build_object('id', r.id, 'name', public._first(r.display_name), 'initials', r.initials,
      'rating', r.rating, 'trips', r.trips, 'verified', r.verification_status = 'verified',
      'cls', veh.class_id, 'make', veh.make, 'color', veh.color, 'plate', veh.plate) end,
    'loc', case when loc.rider_id is null then null else jsonb_build_object('lat', loc.lat, 'lng', loc.lng, 'heading', loc.heading, 'updatedAt', loc.updated_at) end,
    'proof', jsonb_build_object('pinConfirmed', pod.pin_confirmed, 'pinConfirmedBy', pod.pin_confirmed_by, 'hasPhoto', pod.photo_path is not null,
      'hasSignature', pod.signature_path is not null, 'receivedBy', pod.received_by, 'receiverName', pod.receiver_name, 'distanceM', pod.distance_m,
      'deliveredAt', pod.delivered_at, 'lat', pod.lat, 'lng', pod.lng),
    'events', coalesce((select jsonb_agg(jsonb_build_object('ts', e.created_at, 'type', e.type, 'label', e.label, 'actor', e.actor_role) order by e.created_at)
      from public.delivery_events e where e.delivery_id = d.id and e.type not in ('payment', 'settled', 'broadcast', 'declined', 'call', 'ticket', 'awaiting_payment')), '[]'),
    'chat', coalesce((select jsonb_agg(jsonb_build_object('from', m.sender_role, 'text', m.body, 'ts', m.created_at) order by m.created_at)
      from public.delivery_messages m where m.delivery_id = d.id), '[]'),
    'sms', coalesce((select jsonb_agg(jsonb_build_object('ts', n.created_at, 'body', n.body) order by n.created_at desc)
      from public.notifications n where n.delivery_id = d.id and n.channel = 'sms'), '[]'));
end $$;

/* ================================================================== SMS outbox (Africa's Talking via sms-dispatch) */

alter table public.notifications add column if not exists sms_ref text;
alter table public.notifications drop constraint if exists notifications_sms_status_check;
alter table public.notifications add constraint notifications_sms_status_check check (sms_status in ('queued', 'sending', 'sent', 'failed', 'simulated'));
insert into public.app_settings (key, value, note) values
  ('sms_mode', '"simulated"', '"live" queues recipient SMS for the sms-dispatch Edge Function (Africa''s Talking); "simulated" only records them')
on conflict (key) do nothing;

create or replace function public._sms(p_delivery uuid, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare ph text;
begin
  select r.phone into ph from public.deliveries d join public.recipients r on r.id = d.recipient_id where d.id = p_delivery;
  insert into public.notifications (audience, phone, channel, sms_status, title, body, delivery_id, kind)
  values ('recipient', ph, 'sms', case when public._setting('sms_mode', '"simulated"')#>>'{}' = 'live' then 'queued' else 'simulated' end,
    'DROPOFF', p_body, p_delivery, 'sms');
end $$;

create or replace function public.sms_queue(p_limit int default 50) returns jsonb
language plpgsql security definer set search_path = public as $$
declare out jsonb;
begin
  with c as (
    select id from public.notifications where channel = 'sms' and sms_status = 'queued' order by created_at limit p_limit for update skip locked)
  update public.notifications n set sms_status = 'sending' from c where n.id = c.id;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'phone', phone, 'body', body)), '[]') into out
  from public.notifications where channel = 'sms' and sms_status = 'sending';
  return out;
end $$;

create or replace function public.sms_mark(p_id uuid, p_ok boolean, p_ref text) returns void
language sql security definer set search_path = public as $$
  update public.notifications set sms_status = case when p_ok then 'sent' else 'failed' end, sms_ref = p_ref where id = p_id
$$;

/* ================================================================== read model */

create or replace function public.my_limits() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid(); tier int; c bigint; o bigint;
begin
  if uid is null then return null; end if;
  tier := public._kyc_tier(uid);
  select coalesce(sum(amount), 0) into c from public.payments where initiated_by = uid and direction = 'collection' and status in ('pending', 'initiated', 'successful') and created_at > now() - interval '24 hours';
  select coalesce(sum(amount), 0) into o from public.payments where initiated_by = uid and direction = 'disbursement' and status in ('pending', 'initiated', 'successful') and created_at > now() - interval '24 hours';
  return jsonb_build_object('tier', tier, 'collectTx', public._limit(tier, 'collect_tx'), 'collectDay', public._limit(tier, 'collect_day'), 'collectUsed', c,
    'payoutDay', public._limit(tier, 'payout_day'), 'payoutUsed', o, 'approvalThreshold', (public._setting('payout_approval_threshold', '500000'))::int);
end $$;

create or replace function public.app_state() returns jsonb
language plpgsql stable set search_path = public as $$
declare
  me public.profiles; ops boolean; rid uuid; vid uuid; lim int;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.id is null then return null; end if;
  ops := public.is_ops();
  rid := public.my_rider_id();
  select id into vid from public.vendors where id in (select public.my_vendor_ids()) order by created_at limit 1;
  lim := case when ops then 400 else 250 end;

  return jsonb_build_object(
    'now', now(),
    'me', jsonb_build_object('id', me.id, 'role', me.role, 'name', me.full_name, 'phone', me.phone, 'email', me.email,
      'status', me.status, 'statusReason', me.status_reason, 'avatarPath', me.avatar_path, 'isDemo', me.is_demo,
      'vendorId', vid, 'riderId', rid, 'phoneVerified', me.phone_verified_at is not null, 'phoneVerifiedAt', me.phone_verified_at,
      'phoneChangedAt', me.phone_changed_at, 'termsAccepted', me.terms_accepted_at is not null, 'signupMethod', me.signup_method,
      'nin', me.national_id_no, 'dob', me.date_of_birth, 'kycTier', public._kyc_tier(me.id)),
    'limits', public.my_limits(),
    'settings', (select coalesce(jsonb_object_agg(key, value), '{}') from public.app_settings),
    'classes', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'label', c.label, 'long', c.long_label, 'maxKg', c.max_kg,
      'speed', c.speed_kmh, 'enabled', c.enabled, 'sort', c.sort) order by c.sort), '[]') from public.vehicle_classes c),
    'sizes', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'label', s.label, 'hint', s.hint, 'maxKg', s.max_kg, 'best', s.best_class,
      'eligible', to_jsonb(s.eligible)) order by s.sort), '[]') from public.package_sizes s),
    'pricing', (select coalesce(jsonb_object_agg(p.class_id, jsonb_build_object('base', p.base, 'perKm', p.per_km, 'min', p.min_fare,
      'fragile', p.fragile, 'express', p.express, 'commission', p.commission_pct)), '{}') from public.pricing_rules p),
    'zones', (select coalesce(jsonb_agg(jsonb_build_object('id', z.id, 'name', z.name, 'enabled', z.enabled, 'note', z.note) order by z.sort), '[]') from public.service_areas z),
    'places', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'area', p.area, 'zone', p.zone_id, 'x', p.x, 'y', p.y,
      'lat', p.lat, 'lng', p.lng) order by p.name), '[]') from public.places p where p.is_active),

    'vendors', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', v.id, 'name', v.name, 'initials', v.initials, 'category', v.category, 'owner', v.contact_name, 'ownerId', v.owner_id,
        'phone', v.phone, 'email', v.email, 'address', v.address, 'registrationNo', v.registration_no, 'tin', v.tin,
        'verification', v.verification_status, 'defaultMethod', v.default_method, 'methods', v.payment_methods,
        'creditEligible', v.credit_eligible, 'creditLimit', v.credit_limit, 'creditDueDay', v.credit_due_day, 'isDemo', v.is_demo, 'createdAt', v.created_at,
        'accountStatus', (select status from public.profiles where id = v.owner_id),
        'locations', (select coalesce(jsonb_agg(jsonb_build_object('placeId', l.place_id, 'label', l.label, 'default', l.is_default) order by l.is_default desc, l.created_at), '[]')
          from public.vendor_locations l where l.vendor_id = v.id),
        'staff', (select coalesce(jsonb_agg(jsonb_build_object('name', s.name, 'role', s.role) order by s.created_at), '[]') from public.vendor_staff s where s.vendor_id = v.id),
        'wallet', (select jsonb_build_object('id', w.id, 'balance', w.balance, 'pending', w.pending_balance) from public.wallets w where w.vendor_id = v.id and w.kind = 'main'),
        'credit', (select jsonb_build_object('id', w.id, 'balance', w.balance, 'pending', w.pending_balance, 'limit', w.credit_limit) from public.wallets w where w.vendor_id = v.id and w.kind = 'credit')
      ) order by v.created_at), '[]') from public.vendors v),

    'riders', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'profileId', r.profile_id, 'name', r.display_name, 'initials', r.initials, 'rating', r.rating, 'trips', r.trips,
        'acceptance', r.acceptance, 'online', r.online, 'status', r.status, 'verification', r.verification_status, 'licenseNo', r.license_no,
        'activeId', r.active_delivery_id, 'createdAt', r.created_at, 'isDemo', r.is_demo,
        'phone', (select phone from public.profiles where id = r.profile_id),
        'email', (select email from public.profiles where id = r.profile_id),
        'accountStatus', (select status from public.profiles where id = r.profile_id),
        'vehicle', (select jsonb_build_object('id', x.id, 'cls', x.class_id, 'make', x.make, 'color', x.color, 'plate', x.plate,
            'registrationNo', x.registration_no, 'hasBox', x.has_box, 'verification', x.verification_status)
          from public.vehicles x where x.rider_id = r.id and x.is_active order by x.created_at desc limit 1),
        'loc', (select jsonb_build_object('lat', l.lat, 'lng', l.lng, 'heading', l.heading, 'accuracy', l.accuracy_m, 'updatedAt', l.updated_at)
          from public.rider_locations l where l.rider_id = r.id),
        'wallet', (select jsonb_build_object('id', w.id, 'balance', w.balance) from public.wallets w where w.rider_id = r.id)
      ) order by r.display_name), '[]') from public.riders r),

    'deliveries', (select coalesce(jsonb_agg(x.j order by x.created_at desc), '[]') from (
      select d.created_at, jsonb_build_object(
        'id', d.id, 'ref', d.ref, 'vendorId', d.vendor_id, 'status', d.status, 'statusAt', d.status_at, 'createdAt', d.created_at,
        'pickup', jsonb_build_object('placeId', d.pickup_place_id, 'name', d.pickup_name, 'area', d.pickup_area, 'x', d.pickup_x, 'y', d.pickup_y, 'lat', d.pickup_lat, 'lng', d.pickup_lng),
        'dropoff', jsonb_build_object('placeId', d.dropoff_place_id, 'name', d.dropoff_name, 'area', d.dropoff_area, 'x', d.dropoff_x, 'y', d.dropoff_y, 'lat', d.dropoff_lat, 'lng', d.dropoff_lng),
        'notes', d.recipient_notes,
        'recipient', (select jsonb_build_object('id', rc.id, 'name', rc.name, 'phone', rc.phone) from public.recipients rc where rc.id = d.recipient_id),
        'pkg', (select jsonb_build_object('type', p.type, 'desc', p.description, 'size', p.size, 'weight', p.weight_kg, 'value', p.declared_value,
            'fragile', p.fragile, 'upright', p.upright, 'photoPath', p.photo_path) from public.packages p where p.id = d.package_id),
        'cls', d.vehicle_class, 'recommended', d.recommended_class, 'urgency', d.urgency, 'widened', d.widened, 'noDriver', d.no_driver,
        'price', jsonb_build_object('total', d.price_total, 'km', d.price_km, 'lines', d.price_lines, 'commission', d.commission_pct),
        'riderId', d.rider_id, 'vehicleId', d.vehicle_id, 'earning', d.rider_earning, 'sigRequired', d.sig_required, 'promisedAt', d.promised_at,
        'flags', to_jsonb(d.flags), 'flagNote', d.flag_note, 'failReason', d.fail_reason, 'cancelReason', d.cancel_reason, 'resolution', d.resolution,
        'handover', d.handover, 'unreachableAt', d.unreachable_at, 'unreachableCalls', d.unreachable_calls, 'rating', d.rating,
        'recipientOpenedAt', d.recipient_opened_at, 'isDemo', d.is_demo,
        'secrets', (select jsonb_build_object('pickupPin', s.pickup_pin, 'token', s.tracking_token) from public.delivery_secrets s where s.delivery_id = d.id),
        'proof', (select jsonb_build_object('pickupPhotoPath', pf.pickup_photo_path, 'pickupAt', pf.pickup_at, 'pickupLat', pf.pickup_lat, 'pickupLng', pf.pickup_lng,
            'pickupPinOk', pf.pickup_pin_ok, 'photoPath', pf.photo_path, 'photoAt', pf.photo_at, 'signaturePath', pf.signature_path,
            'receivedBy', pf.received_by, 'receiverName', pf.receiver_name, 'pinConfirmed', pf.pin_confirmed, 'pinConfirmedBy', pf.pin_confirmed_by,
            'pinConfirmedAt', pf.pin_confirmed_at, 'recipientConfirmed', pf.recipient_confirmed, 'lat', pf.lat, 'lng', pf.lng,
            'distanceM', pf.distance_m, 'locationSource', pf.location_source, 'deliveredAt', pf.delivered_at, 'riderId', pf.rider_id, 'vehicleId', pf.vehicle_id)
          from public.proof_of_delivery pf where pf.delivery_id = d.id),
        'pinAttempts', (select s.pin_attempts from public.delivery_secrets s where s.delivery_id = d.id),
        'payment', (select jsonb_build_object('id', pay.id, 'method', pay.method, 'status', pay.status, 'amount', pay.amount, 'refunded', pay.refunded_amount,
            'receiptNo', pay.receipt_no, 'vat', pay.vat, 'capturedAt', pay.captured_at, 'simulated', pay.simulated, 'provider', pay.provider, 'providerRef', pay.provider_ref,
            'checkoutUrl', pay.checkout_url, 'failureReason', pay.failure_reason, 'expiresAt', pay.expires_at)
          from public.payments pay where pay.id = d.payment_id),
        'events', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'ts', e.created_at, 'type', e.type, 'label', e.label,
            'actor', jsonb_build_object('role', e.actor_role, 'id', e.actor_id, 'name', e.actor_name), 'lat', e.lat, 'lng', e.lng) order by e.id), '[]')
          from public.delivery_events e where e.delivery_id = d.id),
        'chat', (select coalesce(jsonb_agg(jsonb_build_object('from', m.sender_role, 'text', m.body, 'ts', m.created_at) order by m.id), '[]')
          from public.delivery_messages m where m.delivery_id = d.id),
        'declinedByMe', rid is not null and exists (select 1 from public.delivery_offers o where o.delivery_id = d.id and o.rider_id = rid and o.response in ('declined', 'released')),
        'eligibleOnline', case when d.status = 'searching' then public._eligible_online_count(d.id) end,
        'disputeTicketId', (select ds.ticket_id from public.disputes ds where ds.delivery_id = d.id and ds.status = 'open' limit 1)
      ) j
      from public.deliveries d
      where d.status <> 'draft' or d.created_at > now() - interval '2 days'
      order by (d.status in ('draft', 'searching', 'assigned', 'en_route_pickup', 'at_pickup', 'picked_up', 'in_transit', 'approaching', 'arrived', 'awaiting_confirmation')) desc, d.created_at desc
      limit lim) x),

    'payments', (select coalesce(jsonb_agg(x.j order by x.created_at desc), '[]') from (
      select p.created_at, jsonb_build_object('id', p.id, 'purpose', p.purpose, 'direction', p.direction, 'method', p.method, 'amount', p.amount,
        'currency', p.currency, 'status', p.status, 'provider', p.provider, 'providerRef', p.provider_ref, 'simulated', p.simulated,
        'msisdn', public._mask_phone(p.msisdn), 'deliveryId', p.delivery_id, 'vendorId', p.vendor_id, 'riderId', p.rider_id,
        'approval', p.approval_status, 'needsReview', p.needs_review, 'reviewReason', p.review_reason, 'failureReason', p.failure_reason,
        'checkoutUrl', p.checkout_url, 'expiresAt', p.expires_at, 'createdAt', p.created_at, 'updatedAt', p.updated_at, 'receiptNo', p.receipt_no,
        'accountName', case when ops then p.account_name end, 'mine', p.initiated_by = me.id,
        'by', case when ops then (select full_name from public.profiles where id = p.initiated_by) end,
        'events', case when ops then (select coalesce(jsonb_agg(jsonb_build_object('kind', e.kind, 'from', e.status_before, 'to', e.status_after,
            'detail', e.detail, 'ts', e.created_at) order by e.id), '[]') from public.payment_events e where e.payment_id = p.id) end) j
      from public.payments p where p.direction <> 'internal' or ops
      order by p.created_at desc limit case when ops then 300 else 60 end) x),

    'transactions', (select coalesce(jsonb_agg(x.j order by x.created_at desc), '[]') from (
      select t.created_at, jsonb_build_object('id', t.id, 'ref', t.ref, 'ts', t.created_at, 'party', w.owner_type, 'partyId', coalesce(w.vendor_id, w.rider_id),
        'wallet', w.kind, 'type', t.type, 'amount', t.amount, 'balanceAfter', t.balance_after, 'method', t.method, 'label', t.label,
        'deliveryId', t.delivery_id, 'paymentId', t.payment_id, 'status', t.status, 'simulated', t.simulated) j
      from public.wallet_transactions t join public.wallets w on w.id = t.wallet_id
      order by t.created_at desc limit case when ops then 600 else 300 end) x),

    'notifications', (select coalesce(jsonb_agg(x.j order by x.created_at desc), '[]') from (
      select n.created_at, jsonb_build_object('id', n.id, 'ts', n.created_at, 'aud', n.audience, 'vendorId', n.vendor_id, 'riderId', n.rider_id,
        'title', n.title, 'body', n.body, 'deliveryId', n.delivery_id, 'kind', n.kind, 'read', n.read_at is not null, 'channel', n.channel,
        'phone', n.phone, 'smsStatus', n.sms_status) j
      from public.notifications n
      where (n.channel = 'in_app' and (n.vendor_id = vid or (rid is not null and n.rider_id = rid) or (ops and n.audience = 'ops') or n.profile_id = me.id))
         or (ops and n.channel = 'sms')
      order by n.created_at desc limit case when ops then 300 else 150 end) x),

    'tickets', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'ref', t.ref, 'deliveryId', t.delivery_id, 'by', t.opened_by_role, 'category', t.category,
        'title', t.title, 'note', t.description, 'status', t.status, 'assignedTo', t.assigned_to, 'resolution', t.resolution, 'resolutionNote', t.resolution_note,
        'createdAt', t.created_at, 'updatedAt', t.updated_at, 'resolvedAt', t.resolved_at, 'vendorId', t.vendor_id, 'riderId', t.rider_id) order by t.created_at desc), '[]')
      from public.support_tickets t),

    'disputes', (select coalesce(jsonb_agg(jsonb_build_object('id', ds.id, 'deliveryId', ds.delivery_id, 'ticketId', ds.ticket_id, 'by', ds.opened_by_role,
        'reason', ds.reason, 'status', ds.status, 'decision', ds.decision, 'refunded', ds.amount_refunded, 'createdAt', ds.created_at, 'resolvedAt', ds.resolved_at)
        order by ds.created_at desc), '[]') from public.disputes ds),

    'verifications', (select coalesce(jsonb_agg(jsonb_build_object('id', vr.id, 'subject', vr.subject_type, 'vendorId', vr.vendor_id, 'riderId', vr.rider_id,
        'profileId', vr.profile_id, 'status', vr.status, 'infoRequested', vr.info_requested, 'note', vr.reviewer_note, 'submittedAt', vr.submitted_at,
        'reviewedAt', vr.reviewed_at, 'createdAt', vr.created_at, 'updatedAt', vr.updated_at, 'riskFlags', to_jsonb(vr.risk_flags),
        'name', coalesce((select name from public.vendors where id = vr.vendor_id), (select display_name from public.riders where id = vr.rider_id)),
        'person', (select jsonb_build_object('name', pp.full_name, 'nin', pp.national_id_no, 'dob', pp.date_of_birth, 'phone', pp.phone,
            'phoneVerified', pp.phone_verified_at is not null, 'method', pp.signup_method) from public.profiles pp where pp.id = vr.profile_id),
        'documents', (select coalesce(jsonb_agg(jsonb_build_object('id', doc.id, 'kind', doc.kind, 'path', doc.storage_path, 'bucket', doc.bucket,
            'fileName', doc.file_name, 'mime', doc.mime_type, 'size', doc.size_bytes, 'status', doc.status, 'createdAt', doc.created_at) order by doc.created_at), '[]')
          from public.documents doc where doc.verification_request_id = vr.id)
      ) order by vr.updated_at desc), '[]') from public.verification_requests vr),

    'audit', case when ops then (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'type', a.event_type, 'actor', a.actor_name, 'role', a.actor_role,
        'target', a.target_type, 'targetId', a.target_id, 'deliveryId', a.delivery_id, 'meta', a.metadata, 'ts', a.created_at) order by a.id desc), '[]')
      from (select * from public.audit_log order by id desc limit 200) a) else '[]'::jsonb end
  );
end $$;

/* ================================================================== security for the new objects */

alter table public.payment_events enable row level security;
alter table public.payment_sandbox enable row level security;
create policy payment_events_read on public.payment_events for select to authenticated using (public.is_ops());
revoke all on public.payment_events, public.payment_sandbox from anon, authenticated;
grant select on public.payment_events to authenticated;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.plate_available(text), public.recipient_view(text, text), public.recipient_lookup(text, text),
  public.recipient_confirm(text, text, text), public.recipient_send_message(text, text, text), public.recipient_call(text, text),
  public.recipient_open_ticket(text, text, text, text), public.recipient_resend_pin(text, text), public.recipient_rate(text, text, int)
  to anon, authenticated;
grant execute on function
  public.app_state(), public.recipient_my_deliveries(), public.my_limits(), public.available_drivers(),
  public.my_role(), public.is_ops(), public.my_vendor_ids(), public.is_vendor_member(uuid), public.my_rider_id(),
  public._rider_fits(uuid, uuid), public._eligible_online_count(uuid), public._folder_uuid(text), public._kyc_tier(uuid), public._mask_phone(text),
  public.can_see_delivery(uuid), public.can_see_delivery_details(uuid), public.vendor_sees_rider(uuid), public.vendor_sees_rider_location(uuid),
  public.rider_sees_vendor(uuid), public.rider_sees_package(uuid), public.rider_sees_recipient(uuid), public.can_see_wallet(uuid),
  public.storage_can_write_proof(text), public.storage_can_read_package_photo(text),
  public.complete_signup(jsonb), public.save_kyc(jsonb),
  public.update_my_profile(jsonb), public.register_document(text, text, text, text, int), public.submit_verification(),
  public.update_vehicle(jsonb), public.mark_notifications_read(),
  public.create_delivery(jsonb), public.vendor_cancel(uuid, text), public.widen_search(uuid), public.resolve_failed(uuid, text),
  public.wallet_topup(int, text), public.payment_start_topup(int, text, text, text), public.payment_request_initiation(uuid),
  public.request_payout(int, text), public.pay_credit_invoice(), public.set_default_method(text),
  public.open_ticket(uuid, text, text, text[]), public.log_call(uuid, text),
  public.rider_set_online(boolean), public.rider_update_location(double precision, double precision, numeric, numeric, numeric),
  public.accept_delivery(uuid), public.decline_delivery(uuid, text), public.rider_start_trip(uuid), public.rider_arrive_pickup(uuid),
  public.rider_set_photo(uuid, text, text), public.rider_confirm_pickup(uuid, text), public.rider_start_delivery(uuid),
  public.rider_mark_approaching(uuid), public.rider_arrive_dropoff(uuid), public.rider_start_handoff(uuid), public.rider_submit_pin(uuid, text),
  public.rider_set_signature(uuid, text), public.rider_set_receiver(uuid, text, text), public.rider_complete(uuid), public.rider_release(uuid, text),
  public.rider_report_vehicle_issue(uuid), public.rider_report_unreachable(uuid), public.rider_mark_failed(uuid, text),
  public.rider_request_payout(int), public.send_message(uuid, text), public.rider_sos(uuid),
  public.ops_assign(uuid, uuid), public.ops_reassign(uuid, uuid, text), public.ops_cancel(uuid, text), public.ops_fail(uuid, text),
  public.ops_flag(uuid, text), public.ops_resolve_dispute(uuid, text, text), public.ops_update_ticket(uuid, text, text),
  public.ops_review_verification(uuid, text, text), public.ops_set_account_status(uuid, text, text), public.ops_set_rider_online(uuid, boolean),
  public.ops_update_pricing(text, text, numeric), public.ops_update_class(text, boolean, numeric), public.ops_toggle_zone(text),
  public.ops_set_setting(text, jsonb), public.ops_set_credit(uuid, int), public.ops_resend_pin(uuid),
  public.ops_review_payout(uuid, boolean, text), public.ops_clear_payment_review(uuid, text), public.ledger_check()
  to authenticated;
-- Edge Functions only (service role key, never shipped to a browser)
grant execute on function public.recipient_proof_paths(text, text), public.payment_apply_result(jsonb), public.payment_claim(uuid),
  public.payment_mark_initiated(uuid, text, text, jsonb), public.payment_record_name_check(uuid, text, boolean),
  public.payment_lookup_ref(text, text), public.payments_due(int),
  public.sandbox_create(jsonb), public.sandbox_get(text), public.sandbox_decide(text, boolean, text), public.sandbox_account_name(text),
  public.sms_queue(int), public.sms_mark(uuid, boolean, text)
  to service_role;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'payments') then
    alter publication supabase_realtime add table public.payments;
  end if;
end $$;
