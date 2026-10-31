-- Drop Off · public API (called from the apps with supabase.rpc()).
-- Every function checks who is calling (auth.uid() + profiles.role, never a client-supplied role),
-- validates the request, and changes data only through the internal helpers.
-- Functions that check PINs or codes return {ok:false, error} instead of raising, so the failed
-- attempt is still recorded.

/* ------------------------------------------------------------------ caller helpers */

create or replace function public._me() returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = auth.uid();
  if p.id is null then raise exception 'Please sign in again.' using errcode = '28000'; end if;
  if p.status = 'suspended' then raise exception 'Your account is suspended. Contact Drop Off support.' using errcode = '42501'; end if;
  return p;
end $$;

create or replace function public._my_vendor() returns public.vendors
language plpgsql stable security definer set search_path = public as $$
declare p public.profiles := public._me(); v public.vendors;
begin
  if p.role <> 'vendor' then raise exception 'Sign in with a business account to do this.' using errcode = '42501'; end if;
  select * into v from public.vendors where id in (select public.my_vendor_ids()) order by created_at limit 1;
  if v.id is null then raise exception 'No business is linked to this account.'; end if;
  if v.verification_status in ('suspended', 'rejected') then raise exception 'This business account is %. Contact Drop Off support.', v.verification_status using errcode = '42501'; end if;
  return v;
end $$;

create or replace function public._my_rider() returns public.riders
language plpgsql stable security definer set search_path = public as $$
declare p public.profiles := public._me(); r public.riders;
begin
  if p.role <> 'rider' then raise exception 'Sign in with a rider or driver account to do this.' using errcode = '42501'; end if;
  select * into r from public.riders where profile_id = p.id;
  if r.id is null then raise exception 'No rider profile is linked to this account.'; end if;
  return r;
end $$;

create or replace function public._require_ops() returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare p public.profiles := public._me();
begin
  if p.role <> 'ops' then raise exception 'Only Drop Off operations staff can do this.' using errcode = '42501'; end if;
  return p;
end $$;

create or replace function public._vendor_delivery(p_delivery uuid) returns public.deliveries
language plpgsql security definer set search_path = public as $$
declare v public.vendors := public._my_vendor(); d public.deliveries;
begin
  select * into d from public.deliveries where id = p_delivery and vendor_id = v.id for update;
  if d.id is null then raise exception 'Delivery not found.' using errcode = 'P0002'; end if;
  return d;
end $$;

create or replace function public._rider_delivery(p_delivery uuid) returns public.deliveries
language plpgsql security definer set search_path = public as $$
declare r public.riders := public._my_rider(); d public.deliveries;
begin
  select * into d from public.deliveries where id = p_delivery for update;
  if d.id is null or d.rider_id is distinct from r.id then raise exception 'This job is no longer assigned to you.' using errcode = 'P0002'; end if;
  return d;
end $$;

create or replace function public._rider_actor(p_rider uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('role', 'rider', 'id', id, 'name', display_name) from public.riders where id = p_rider
$$;

create or replace function public._fresh_loc(p_rider uuid) returns public.rider_locations
language sql stable security definer set search_path = public as $$
  select * from public.rider_locations where rider_id = p_rider and updated_at > now() - interval '5 minutes'
$$;

-- Distance check between the rider's last GPS fix and a point. Returns a label for the timeline and
-- raises when ops has switched geofence enforcement on and the rider is too far away.
create or replace function public._geo_check(p_rider uuid, p_lat double precision, p_lng double precision, p_what text) returns text
language plpgsql security definer set search_path = public as $$
declare l public.rider_locations := public._fresh_loc(p_rider); dist numeric; lim numeric;
begin
  if l.rider_id is null then return 'confirmed by driver · no GPS fix'; end if;
  dist := public._dist_m(l.lat, l.lng, p_lat, p_lng);
  lim := (public._setting('geofence_m', '300'))::numeric;
  if (public._setting('enforce_geofence', 'false'))::boolean and dist > lim then
    raise exception 'Your GPS shows you % km from the %. Confirm arrival when you get there.', round(dist / 1000.0, 1), p_what;
  end if;
  return 'GPS ' || dist || ' m from ' || p_what;
end $$;

/* ------------------------------------------------------------------ sign-up: profile + role record */

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}');
  r text := coalesce(m->>'role', 'recipient');
  nm text := trim(coalesce(m->>'full_name', m->>'contact_name', ''));
  ph text := public._norm_phone(m->>'phone');
  vid uuid; rid uuid; pl public.places; bname text; cls text;
begin
  -- Roles are never taken from the client beyond these three. Ops accounts are promoted by an admin.
  if r not in ('vendor', 'rider', 'recipient') then r := 'recipient'; end if;
  insert into public.profiles (id, role, full_name, phone, email)
  values (new.id, r, coalesce(nullif(nm, ''), split_part(new.email, '@', 1)), ph, new.email);

  if r = 'vendor' then
    bname := coalesce(nullif(trim(m->>'business_name'), ''), nm, 'New business');
    insert into public.vendors (owner_id, name, initials, category, contact_name, phone, email, address, registration_no, tin, payment_methods, default_method)
    values (new.id, bname, public._initials(bname), coalesce(nullif(m->>'category', ''), 'Other'), coalesce(nullif(nm, ''), bname),
            coalesce(ph, ''), new.email, nullif(trim(m->>'address'), ''), nullif(trim(m->>'registration_no'), ''), nullif(trim(m->>'tin'), ''),
            jsonb_build_array(
              jsonb_build_object('id', 'wallet', 'label', 'Drop Off Wallet'),
              jsonb_build_object('id', 'momo', 'label', 'MTN Mobile Money', 'detail', public._mask_phone(ph)),
              jsonb_build_object('id', 'airtel', 'label', 'Airtel Money', 'detail', public._mask_phone(ph)),
              jsonb_build_object('id', 'card', 'label', 'Card', 'detail', 'Simulated card'),
              jsonb_build_object('id', 'credit', 'label', 'Business credit account', 'detail', 'Monthly invoice')),
            'momo')
    returning id into vid;
    insert into public.vendor_staff (vendor_id, profile_id, name, role) values (vid, new.id, coalesce(nullif(nm, ''), bname), 'owner');
    select * into pl from public.places where id = m->>'place_id' and is_active;
    if pl.id is not null then
      insert into public.vendor_locations (vendor_id, place_id, label, is_default) values (vid, pl.id, coalesce(nullif(trim(m->>'location_label'), ''), pl.area), true);
    end if;
    perform public._wallet_id('vendor', vid, 'main');
    perform public._wallet_id('vendor', vid, 'credit');
    insert into public.verification_requests (subject_type, vendor_id, profile_id) values ('vendor', vid, new.id);
    perform public._notify('vendor', vid, null, 'Welcome to Drop Off', 'You can book deliveries now. Upload your business documents to unlock credit and invoicing.', null, 'ok');
    perform public._notify('ops', null, null, 'New vendor sign-up', bname || ' · ' || coalesce(m->>'category', 'Other'), null);
  elsif r = 'rider' then
    insert into public.riders (profile_id, display_name, initials, license_no)
    values (new.id, coalesce(nullif(nm, ''), 'New rider'), public._initials(coalesce(nullif(nm, ''), 'New rider')), nullif(trim(m->>'license_no'), ''))
    returning id into rid;
    cls := case when m->>'vehicle_class' in (select id from public.vehicle_classes) then m->>'vehicle_class' else 'boda' end;
    if coalesce(trim(m->>'plate'), '') <> '' then
      insert into public.vehicles (rider_id, class_id, make, color, plate, registration_no, has_box)
      values (rid, cls, coalesce(nullif(trim(m->>'make'), ''), (select label from public.vehicle_classes where id = cls)),
              coalesce(trim(m->>'color'), ''), upper(trim(m->>'plate')), nullif(trim(m->>'vehicle_registration'), ''), coalesce((m->>'has_box')::boolean, false));
    end if;
    perform public._wallet_id('rider', rid);
    insert into public.verification_requests (subject_type, rider_id, profile_id) values ('rider', rid, new.id);
    perform public._notify('rider', null, rid, 'Application received', 'Upload your ID, driving permit and vehicle documents so ops can verify you.', null, 'ok');
    perform public._notify('ops', null, null, 'Rider application · ' || coalesce(nullif(nm, ''), 'New rider'), initcap(cls) || ' · ' || upper(coalesce(m->>'plate', '')), null, 'warn');
  end if;

  insert into public.audit_log (event_type, actor_id, actor_role, actor_name, target_type, target_id, metadata)
  values ('user.registered', new.id, r, nm, 'profile', new.id::text, jsonb_build_object('email', new.email));
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Lets the registration form explain a duplicate plate before the account is created.
create or replace function public.plate_available(p_plate text) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.vehicles where upper(replace(plate, ' ', '')) = upper(replace(coalesce(p_plate, ''), ' ', '')))
$$;

/* ------------------------------------------------------------------ profile, documents, verification */

create or replace function public.update_my_profile(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._me(); ph text;
begin
  if p ? 'phone' then
    ph := public._norm_phone(p->>'phone');
    if ph is null then raise exception 'Enter a Ugandan mobile number, e.g. 0772 418 905.'; end if;
  end if;
  if p ? 'full_name' and length(trim(p->>'full_name')) < 2 then raise exception 'Enter your full name.'; end if;
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

create or replace function public.register_document(p_kind text, p_path text, p_file_name text, p_mime text, p_size int) returns uuid
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._me(); vr public.verification_requests; doc uuid;
begin
  if split_part(coalesce(p_path, ''), '/', 1) <> me.id::text then raise exception 'Upload the document again.'; end if;
  if p_size is not null and p_size > 10 * 1024 * 1024 then raise exception 'Documents must be under 10 MB.'; end if;
  select * into vr from public.verification_requests where profile_id = me.id order by created_at limit 1;
  if vr.id is null then raise exception 'There is no verification to attach this to.'; end if;
  if vr.status in ('under_review', 'verified') and not vr.info_requested then
    raise exception 'Your verification is %. Contact support to change documents.', replace(vr.status, '_', ' ');
  end if;
  insert into public.documents (owner_id, verification_request_id, kind, storage_path, file_name, mime_type, size_bytes)
  values (me.id, vr.id, p_kind, p_path, coalesce(nullif(p_file_name, ''), 'document'), p_mime, p_size) returning id into doc;
  perform public._audit('verification.document_uploaded', 'document', doc::text, null, jsonb_build_object('kind', p_kind));
  return doc;
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
  select coalesce(array_agg(distinct kind), '{}') into kinds from public.documents where verification_request_id = vr.id;
  if vr.subject_type = 'rider' then
    select coalesce(array_agg(k), '{}') into missing from unnest(array['national_id', 'driving_permit', 'vehicle_logbook']) k where not k = any(kinds);
    if not exists (select 1 from public.vehicles v where v.rider_id = vr.rider_id) then raise exception 'Add your vehicle before submitting.'; end if;
  else
    if not (kinds && array['business_registration', 'trading_licence', 'tin_certificate']) then missing := array['business_registration']; end if;
  end if;
  if array_length(missing, 1) > 0 then
    raise exception 'Upload these documents first: %.', array_to_string(array(select replace(x, '_', ' ') from unnest(missing) x), ', ');
  end if;
  update public.verification_requests set status = 'submitted', info_requested = false, submitted_at = now() where id = vr.id;
  if vr.vendor_id is not null then update public.vendors set verification_status = 'submitted' where id = vr.vendor_id; end if;
  if vr.rider_id is not null then update public.riders set verification_status = 'submitted' where id = vr.rider_id; end if;
  perform public._notify('ops', null, null, 'Verification submitted', me.full_name || ' · ' || vr.subject_type, null, 'warn');
  perform public._audit('verification.submitted', 'verification_request', vr.id::text);
end $$;

create or replace function public.update_vehicle(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r public.riders := public._my_rider(); v public.vehicles; cls text := p->>'class_id';
begin
  if r.verification_status in ('verified', 'under_review') then raise exception 'Contact support to change a vehicle that is %.', replace(r.verification_status, '_', ' '); end if;
  if cls is null or not exists (select 1 from public.vehicle_classes where id = cls) then raise exception 'Choose your vehicle type.'; end if;
  if coalesce(trim(p->>'plate'), '') !~* '^U[A-Z]{2} ?\d{3}[A-Z]$' then raise exception 'Enter a plate like UEX 219K.'; end if;
  if length(trim(coalesce(p->>'make', ''))) < 2 then raise exception 'Enter the make and model.'; end if;
  select * into v from public.vehicles where rider_id = r.id and is_active limit 1;
  if exists (select 1 from public.vehicles where upper(replace(plate, ' ', '')) = upper(replace(p->>'plate', ' ', '')) and id is distinct from v.id) then
    raise exception 'That plate is already registered with Drop Off.';
  end if;
  if v.id is null then
    insert into public.vehicles (rider_id, class_id, make, color, plate, registration_no, has_box)
    values (r.id, cls, trim(p->>'make'), coalesce(trim(p->>'color'), ''), upper(trim(p->>'plate')), nullif(trim(p->>'registration_no'), ''), coalesce((p->>'has_box')::boolean, false));
  else
    update public.vehicles set class_id = cls, make = trim(p->>'make'), color = coalesce(trim(p->>'color'), ''), plate = upper(trim(p->>'plate')),
      registration_no = nullif(trim(p->>'registration_no'), ''), has_box = coalesce((p->>'has_box')::boolean, has_box), verification_status = 'pending'
    where id = v.id;
  end if;
  if p ? 'license_no' then update public.riders set license_no = nullif(trim(p->>'license_no'), '') where id = r.id; end if;
  perform public._audit('vehicle.updated', 'rider', r.id::text, null, p);
end $$;

create or replace function public.mark_notifications_read() returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._me();
begin
  update public.notifications set read_at = now()
  where read_at is null and channel = 'in_app' and (
    (me.role = 'vendor' and vendor_id in (select public.my_vendor_ids())) or
    (me.role = 'rider' and rider_id = public.my_rider_id()) or
    (me.role = 'ops' and audience = 'ops') or profile_id = me.id);
end $$;

/* ------------------------------------------------------------------ vendor */

create or replace function public.create_delivery(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.vendors := public._my_vendor();
  me public.profiles := public._me();
  pick public.places; drop_ public.places; dz public.service_areas; pz public.service_areas;
  ph text; nm text := trim(coalesce(p->>'recipient_name', '')); w numeric; val int; sz public.package_sizes;
  el text[]; cls text := p->>'vehicle_class'; q jsonb; total int; method text := coalesce(p->>'method', v.default_method);
  rec uuid; pkg uuid; did uuid; ref_ text; pay uuid; wmain uuid; wcred uuid; avail bigint; used bigint; prov jsonb;
  travel numeric; elig int; rr record;
begin
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

  -- records
  insert into public.recipients (vendor_id, name, phone, default_place_id, notes)
  values (v.id, nm, ph, drop_.id, coalesce(trim(p->>'notes'), ''))
  on conflict (vendor_id, phone) do update set name = excluded.name, default_place_id = excluded.default_place_id, notes = excluded.notes
  returning id into rec;
  insert into public.packages (vendor_id, type, description, size, weight_kg, declared_value, fragile, upright, photo_path)
  values (v.id, p->>'type', trim(p->>'description'), sz.id, w, val, coalesce((p->>'fragile')::boolean, false), coalesce((p->>'upright')::boolean, false), nullif(p->>'photo_path', ''))
  returning id into pkg;
  travel := public._grid_len(pick.x, pick.y, drop_.x, drop_.y) * 0.025 / (select speed_kmh from public.vehicle_classes where id = cls) * 60;
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

  -- payment: reserve the amount now, capture it on delivery
  wmain := public._wallet_id('vendor', v.id, 'main');
  insert into public.payments (delivery_id, vendor_id, purpose, method, amount, status) values (did, v.id, 'delivery', method, total, 'pending') returning id into pay;
  if method = 'wallet' then
    select balance into avail from public.wallets where id = wmain for update;
    if avail < total then
      raise exception 'Your wallet has %, which is not enough for %. Top up or choose another payment method.', public._fmt_ugx(avail), public._fmt_ugx(total);
    end if;
    perform public._wallet_post(wmain, 'charge', -total, 'wallet', 'Delivery ' || ref_, 'held', did, pay, total);
  elsif method = 'credit' then
    if not v.credit_eligible or v.verification_status <> 'verified' then raise exception 'Credit accounts open after business verification.'; end if;
    wcred := public._wallet_id('vendor', v.id, 'credit');
    select -balance, credit_limit into used, avail from public.wallets where id = wcred for update;
    if avail - used < total then raise exception 'Only % of credit remains. Pay your invoice or choose another method.', public._fmt_ugx(avail - used); end if;
    perform public._wallet_post(wcred, 'charge', -total, 'credit', 'Delivery ' || ref_, 'held', did, pay, total);
  else
    prov := public._provider_charge(method, total, ref_);
    if not (prov->>'ok')::boolean then
      update public.payments set status = 'failed', failure_reason = prov->>'error' where id = pay;
      raise exception '% Nothing was charged.', coalesce(prov->>'error', 'The payment was declined.');
    end if;
    update public.payments set provider = prov->>'provider', provider_ref = prov->>'provider_ref' where id = pay;
    perform public._wallet_post(wmain, 'topup', total, method, public._method_label(method) || ' payment · ' || ref_ || ' (simulated)', 'completed', did, pay);
    perform public._wallet_post(wmain, 'charge', -total, method, 'Delivery ' || ref_, 'held', did, pay, total);
  end if;
  update public.payments set status = 'initiated' where id = pay;
  update public.deliveries set payment_id = pay where id = did;

  perform public._set_status(did, 'pending', public._actor());
  perform public._event(did, 'payment', 'Payment ' || case when method in ('wallet', 'credit') then 'reserved' else 'authorised' end || ' · ' ||
    public._method_label(method) || ' · ' || public._fmt_ugx(total) || ' · simulated');
  perform public._notify('vendor', v.id, null, 'Delivery created: ' || ref_, trim(p->>'description') || ' → ' || nm || ' · ' || public._fmt_ugx(total), did, 'ok');
  perform public._sms(did, v.name || ' is sending you a delivery with Drop Off. Track it: ' || public._tracking_link(did) ||
    ' · Your delivery PIN is ' || (select delivery_pin from public.delivery_secrets where delivery_id = did) || '. Only share it with your rider once you have the package.');
  perform public._set_status(did, 'searching', public._sys());
  perform public._notify('ops', null, null, 'New delivery ' || ref_, v.name || ' · ' || initcap(cls) || ' · ' || pick.area || ' → ' || drop_.area, did);

  -- fan the job out to every eligible driver who is online and free
  elig := 0;
  for rr in select r.id from public.riders r where r.online and r.active_delivery_id is null and public._rider_fits(did, r.id) loop
    perform public._notify('rider', null, rr.id, 'New delivery request', pick.name || ' → ' || drop_.area || ' · earn ' ||
      public._fmt_ugx(public._rider_share(total, (q->>'commission')::numeric)), did, 'offer');
    elig := elig + 1;
  end loop;
  if elig = 0 then
    update public.deliveries set no_driver = true where id = did;
    perform public._event(did, 'no_driver', 'No suitable driver online right now · still visible to drivers who come online');
    perform public._notify('vendor', v.id, null, 'No driver available yet', 'No ' || cls || ' drivers are free near ' || pick.area || '. We keep searching.', did, 'bad');
    perform public._notify('ops', null, null, 'No driver for ' || ref_, initcap(cls) || ' needed at ' || pick.area, did, 'bad');
  else
    perform public._event(did, 'broadcast', 'Request shown to ' || elig || ' eligible driver' || case when elig = 1 then '' else 's' end || ' online');
  end if;
  perform public._audit('delivery.created', 'delivery', ref_, did, jsonb_build_object('amount', total, 'method', method, 'class', cls));
  return jsonb_build_object('id', did, 'ref', ref_, 'total', total);
end $$;

create or replace function public.vendor_cancel(p_delivery uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._vendor_delivery(p_delivery);
begin
  if d.status not in ('pending', 'searching', 'assigned', 'en_route_pickup', 'at_pickup') then
    raise exception 'The package is already with the driver. Contact support to stop this delivery.';
  end if;
  perform public._set_status(d.id, 'cancelled', public._actor(), jsonb_build_object('reason', coalesce(nullif(trim(p_reason), ''), 'Cancelled by vendor')));
end $$;

create or replace function public.widen_search(p_delivery uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._vendor_delivery(p_delivery); n int; rr record;
begin
  if d.status <> 'searching' then raise exception 'Matching has already finished for this delivery.'; end if;
  if d.widened then raise exception 'Larger vehicles can already take this job.'; end if;
  update public.deliveries set widened = true where id = d.id;
  perform public._event(d.id, 'widened', 'Vendor allowed larger vehicles at the same price', public._actor());
  n := 0;
  for rr in select r.id from public.riders r where r.online and r.active_delivery_id is null and public._rider_fits(d.id, r.id) loop
    perform public._notify('rider', null, rr.id, 'New delivery request', d.pickup_name || ' → ' || d.dropoff_area, d.id, 'offer');
    n := n + 1;
  end loop;
  update public.deliveries set no_driver = (n = 0) where id = d.id;
end $$;

-- Vendor (or ops) decides what happens after a failed attempt.
create or replace function public.resolve_failed(p_delivery uuid, p_choice text) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._me(); d public.deliveries; r public.riders; actor jsonb := public._actor();
  pay public.payments; w uuid; amt int; avail bigint;
begin
  select * into d from public.deliveries where id = p_delivery for update;
  if d.id is null or not (public.is_ops() or public.is_vendor_member(d.vendor_id)) then raise exception 'Delivery not found.'; end if;
  if d.status <> 'failed' or d.resolution is not null then raise exception 'This delivery already has a resolution.'; end if;
  if p_choice = 'reattempt' then
    select * into r from public.riders where id = d.rider_id;
    if r.id is null or r.active_delivery_id is not null then raise exception 'The original driver is busy. Ops can assign a new driver.'; end if;
    -- the 50% refunded for the failed attempt is reserved again; the full fare is captured on delivery
    select * into pay from public.payments where id = d.payment_id for update;
    amt := pay.refunded_amount;
    if amt > 0 then
      w := public._wallet_id('vendor', d.vendor_id, case when pay.method = 'credit' then 'credit' else 'main' end);
      if pay.method = 'credit' then select credit_limit + balance into avail from public.wallets where id = w for update;
      else select balance into avail from public.wallets where id = w for update; end if;
      if avail < amt then raise exception 'Trying again reserves the % refunded for the failed attempt. Top up first.', public._fmt_ugx(amt); end if;
      perform public._wallet_post(w, 'charge', -amt, case when pay.method = 'credit' then 'credit' else 'wallet' end, 'Reattempt · ' || d.ref, 'held', d.id, pay.id, amt);
      update public.payments set refunded_amount = 0, status = 'initiated', captured_at = null where id = pay.id;
    end if;
    update public.riders set active_delivery_id = d.id, status = 'on_job' where id = r.id;
    update public.proof_of_delivery set pin_confirmed = false, pin_confirmed_by = null, pin_confirmed_at = null where delivery_id = d.id;
    update public.delivery_secrets set pin_attempts = 0, pin_locked_until = null where delivery_id = d.id;
    update public.deliveries set unreachable_at = null, unreachable_calls = 0, resolution = 'reattempt' where id = d.id;
    -- the reattempt is charged at no extra cost; the refund already issued for the failure stands
    perform public._set_status(d.id, 'in_transit', actor);
    update public.deliveries set resolution = null where id = d.id;
    perform public._notify('rider', null, r.id, 'Try again · ' || d.ref, 'The vendor asked you to reattempt the delivery to ' || d.dropoff_name || '.', d.id, 'offer');
  elsif p_choice = 'return' then
    update public.deliveries set resolution = 'returned' where id = d.id;
    perform public._event(d.id, 'returned', 'Package returning to ' || d.pickup_name, actor);
    perform public._notify('vendor', d.vendor_id, null, 'Return arranged for ' || d.ref, 'The package is coming back to ' || d.pickup_name || '.', d.id);
    if d.rider_id is not null then perform public._notify('rider', null, d.rider_id, 'Return ' || d.ref, 'Bring the package back to ' || d.pickup_name || '.', d.id, 'warn'); end if;
  else
    raise exception 'Choose to try again or return the package.';
  end if;
  perform public._audit('delivery.failed_resolution', 'delivery', d.ref, d.id, jsonb_build_object('choice', p_choice));
end $$;

create or replace function public.wallet_topup(p_amount int, p_method text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v public.vendors := public._my_vendor(); pay uuid; prov jsonb;
begin
  if p_amount is null or p_amount < 5000 then raise exception 'Top up at least UGX 5,000.'; end if;
  if p_amount > 20000000 then raise exception 'Top-ups above UGX 20,000,000 need a bank transfer.'; end if;
  if p_method not in ('momo', 'airtel', 'card') then raise exception 'Choose mobile money or card.'; end if;
  insert into public.payments (vendor_id, purpose, method, amount, status) values (v.id, 'topup', p_method, p_amount, 'initiated') returning id into pay;
  prov := public._provider_charge(p_method, p_amount, 'TOPUP');
  if not (prov->>'ok')::boolean then
    update public.payments set status = 'failed', failure_reason = prov->>'error' where id = pay;
    return jsonb_build_object('ok', false, 'error', coalesce(prov->>'error', 'The payment was declined.') || ' Nothing was charged.');
  end if;
  update public.payments set status = 'successful', provider = prov->>'provider', provider_ref = prov->>'provider_ref', captured_at = now() where id = pay;
  perform public._wallet_post(public._wallet_id('vendor', v.id, 'main'), 'topup', p_amount, p_method, 'Top up · ' || public._method_label(p_method) || ' (simulated)', 'completed', null, pay);
  perform public._notify('vendor', v.id, null, 'Wallet topped up', public._fmt_ugx(p_amount) || ' added via ' || public._method_label(p_method) || ' (simulated).', null, 'money');
  perform public._audit('wallet.topup', 'vendor', v.id::text, null, jsonb_build_object('amount', p_amount, 'method', p_method, 'simulated', true));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.pay_credit_invoice() returns void
language plpgsql security definer set search_path = public as $$
declare v public.vendors := public._my_vendor(); wm uuid; wc uuid; due bigint; bal bigint; pay uuid;
begin
  wm := public._wallet_id('vendor', v.id, 'main'); wc := public._wallet_id('vendor', v.id, 'credit');
  select -balance - pending_balance into due from public.wallets where id = wc;
  if due is null or due <= 0 then raise exception 'There is nothing to pay on your credit account yet. Deliveries in progress are billed once completed.'; end if;
  select balance into bal from public.wallets where id = wm for update;
  if bal < due then raise exception 'Your wallet needs % to clear the invoice. Top up first.', public._fmt_ugx(due); end if;
  insert into public.payments (vendor_id, purpose, method, amount, status, captured_at) values (v.id, 'invoice', 'wallet', due, 'successful', now()) returning id into pay;
  perform public._wallet_post(wm, 'invoice', -due, 'wallet', 'Credit invoice paid', 'completed', null, pay);
  perform public._wallet_post(wc, 'credit_repayment', due, 'wallet', 'Invoice payment received', 'completed', null, pay);
  perform public._notify('vendor', v.id, null, 'Invoice paid', public._fmt_ugx(due) || ' credit cleared.', null, 'money');
  perform public._audit('credit.invoice_paid', 'vendor', v.id::text, null, jsonb_build_object('amount', due));
end $$;

create or replace function public.set_default_method(p_method text) returns void
language plpgsql security definer set search_path = public as $$
declare v public.vendors := public._my_vendor();
begin
  if p_method not in ('wallet', 'momo', 'airtel', 'card', 'credit') then raise exception 'Unknown payment method.'; end if;
  if p_method = 'credit' and not v.credit_eligible then raise exception 'Credit accounts open after business verification.'; end if;
  update public.vendors set default_method = p_method where id = v.id;
end $$;

/* ------------------------------------------------------------------ support (vendor & rider) */

create or replace function public._open_ticket(p_delivery uuid, p_role text, p_category text, p_description text, p_attachments text[], p_actor jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.deliveries; t uuid; tref text; title text; disp uuid;
begin
  title := case p_category when 'missing' then 'Delivery has not arrived' when 'damaged' then 'Package damaged or wrong'
    when 'rider' then 'Problem with the rider' when 'pin' then 'Help with the PIN' when 'late' then 'Late or missing delivery'
    when 'payment' then 'Payments & refunds' when 'address' then 'Address problem' when 'other' then 'Other problem' else null end;
  if title is null then raise exception 'Choose what went wrong.'; end if;
  if p_delivery is not null then select * into d from public.deliveries where id = p_delivery; end if;
  insert into public.support_tickets (delivery_id, opened_by, opened_by_role, vendor_id, rider_id, category, title, description, attachments)
  values (p_delivery, case when p_role = 'recipient' then null else auth.uid() end, p_role, d.vendor_id,
          case when p_role = 'rider' then public.my_rider_id() else null end, p_category, title, coalesce(trim(p_description), ''), coalesce(p_attachments, '{}'))
  returning id, ref into t, tref;
  if d.id is not null then
    perform public._event(d.id, 'ticket', 'Support case ' || tref || ' · ' || title, p_actor);
    if p_category = 'damaged' and d.status = 'delivered' then
      insert into public.disputes (delivery_id, ticket_id, opened_by_role, reason) values (d.id, t, p_role, title || coalesce(': ' || nullif(trim(p_description), ''), '')) returning id into disp;
      perform public._set_status(d.id, 'disputed', p_actor, jsonb_build_object('reason', title || coalesce(': ' || nullif(trim(p_description), ''), '')));
    else
      perform public._notify('ops', null, null, 'Support case ' || tref, title || ' · ' || d.ref, d.id, case when p_category = 'missing' then 'bad' else 'warn' end);
    end if;
    if p_role <> 'vendor' then
      perform public._notify('vendor', d.vendor_id, null, 'Problem reported on ' || d.ref, title || ' (reported by the ' || p_role || ').', d.id, 'warn');
    end if;
  else
    perform public._notify('ops', null, null, 'Support case ' || tref, title, null, 'warn');
  end if;
  perform public._audit('ticket.opened', 'ticket', tref, d.id, jsonb_build_object('category', p_category, 'by', p_role, 'dispute', disp is not null));
  return jsonb_build_object('id', t, 'ref', tref, 'dispute', disp is not null);
end $$;

create or replace function public.open_ticket(p_delivery uuid, p_category text, p_description text, p_attachments text[] default '{}') returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._me(); d public.deliveries;
begin
  if me.role not in ('vendor', 'rider') then raise exception 'Use the tracking link to report a problem with a delivery.'; end if;
  if p_delivery is not null then
    select * into d from public.deliveries where id = p_delivery;
    if d.id is null or not ((me.role = 'vendor' and public.is_vendor_member(d.vendor_id)) or (me.role = 'rider' and d.rider_id = public.my_rider_id())) then
      raise exception 'Delivery not found.';
    end if;
  elsif me.role = 'vendor' then
    raise exception 'Choose the delivery this is about.';
  end if;
  return public._open_ticket(p_delivery, me.role, p_category, p_description, p_attachments, public._actor());
end $$;

create or replace function public.log_call(p_delivery uuid, p_to text) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._me(); d public.deliveries;
begin
  select * into d from public.deliveries where id = p_delivery for update;
  if d.id is null or not (public.is_ops() or public.is_vendor_member(d.vendor_id) or d.rider_id = public.my_rider_id()) then raise exception 'Delivery not found.'; end if;
  if p_to not in ('vendor', 'rider', 'recipient') then raise exception 'Unknown contact.'; end if;
  if me.role = 'rider' and p_to = 'recipient' and d.unreachable_at is not null then
    update public.deliveries set unreachable_calls = unreachable_calls + 1 where id = d.id;
  end if;
  perform public._event(d.id, 'call', 'Call · ' || me.role || ' → ' || p_to || ' (masked calling not connected; logged only)', public._actor());
end $$;

/* ------------------------------------------------------------------ rider */

create or replace function public.rider_set_online(p_online boolean) returns void
language plpgsql security definer set search_path = public as $$
declare r public.riders := public._my_rider(); d record; n int := 0;
begin
  if r.verification_status <> 'verified' then raise exception 'Your account is still being verified.'; end if;
  if not exists (select 1 from public.vehicles where rider_id = r.id and is_active) then raise exception 'Add your vehicle first.'; end if;
  if not p_online and r.active_delivery_id is not null then raise exception 'Finish or hand over your current delivery before going offline.'; end if;
  update public.riders set online = p_online, status = case when not p_online then 'offline' when active_delivery_id is not null then 'on_job' else 'idle' end where id = r.id;
  if p_online and r.active_delivery_id is null then
    -- jobs that had nobody to take them become visible to this driver
    for d in select id, ref, vendor_id, no_driver from public.deliveries where status = 'searching' and public._rider_fits(id, r.id) loop
      n := n + 1;
      if d.no_driver then
        update public.deliveries set no_driver = false where id = d.id;
        perform public._event(d.id, 'driver_available', 'A suitable driver came online');
        perform public._notify('vendor', d.vendor_id, null, 'A driver is available for ' || d.ref, 'A matching driver just came online. Your request is in front of them now.', d.id, 'ok');
      end if;
    end loop;
    if n > 0 then
      perform public._notify('rider', null, r.id, n || ' job' || case when n = 1 then '' else 's' end || ' waiting', 'Open requests that fit your vehicle are on the Jobs tab.', null, 'offer');
    end if;
  end if;
  perform public._audit(case when p_online then 'rider.online' else 'rider.offline' end, 'rider', r.id::text);
end $$;

-- Called by the rider app with the device's own geolocation. Never simulated.
create or replace function public.rider_update_location(p_lat double precision, p_lng double precision, p_accuracy numeric default null,
  p_heading numeric default null, p_speed numeric default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.riders := public._my_rider(); d public.deliveries; dist numeric; changed text;
begin
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then raise exception 'Invalid location.'; end if;
  insert into public.rider_locations (rider_id, lat, lng, accuracy_m, heading, speed_mps, source, delivery_id, updated_at)
  values (r.id, p_lat, p_lng, p_accuracy, p_heading, p_speed, 'gps', r.active_delivery_id, now())
  on conflict (rider_id) do update set lat = excluded.lat, lng = excluded.lng, accuracy_m = excluded.accuracy_m, heading = excluded.heading,
    speed_mps = excluded.speed_mps, source = excluded.source, delivery_id = excluded.delivery_id, updated_at = now();
  if r.active_delivery_id is not null then
    select * into d from public.deliveries where id = r.active_delivery_id for update;
    if d.status = 'in_transit' then
      dist := public._dist_m(p_lat, p_lng, d.dropoff_lat, d.dropoff_lng);
      if dist <= (public._setting('approach_radius_m', '800'))::numeric then
        perform public._set_status(d.id, 'approaching', public._sys(), jsonb_build_object('how', 'GPS ' || dist || ' m away'));
        changed := 'approaching';
      end if;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'status', changed);
end $$;

create or replace function public.accept_delivery(p_delivery uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.riders := public._my_rider(); d public.deliveries; veh public.vehicles;
begin
  select * into d from public.deliveries where id = p_delivery for update;
  if d.id is null or d.status <> 'searching' then raise exception 'This request is no longer available. Another driver took it or it was cancelled.'; end if;
  select * into r from public.riders where id = r.id for update;
  if r.verification_status <> 'verified' then raise exception 'Your account is still being verified.'; end if;
  if not r.online then raise exception 'Go online to accept deliveries.'; end if;
  if r.active_delivery_id is not null then raise exception 'Finish your current delivery before taking another one.'; end if;
  if not public._rider_fits(d.id, r.id) then raise exception 'Your vehicle cannot carry this package.'; end if;
  select * into veh from public.vehicles where rider_id = r.id and is_active limit 1;
  update public.deliveries set rider_id = r.id, vehicle_id = veh.id, no_driver = false where id = d.id;
  update public.proof_of_delivery set rider_id = r.id, vehicle_id = veh.id where delivery_id = d.id;
  update public.riders set active_delivery_id = d.id, status = 'on_job' where id = r.id;
  insert into public.delivery_offers (delivery_id, rider_id, response) values (d.id, r.id, 'accepted') on conflict do nothing;
  perform public._set_status(d.id, 'assigned', public._rider_actor(r.id));
  perform public._audit('delivery.accepted', 'delivery', d.ref, d.id, jsonb_build_object('rider', r.id));
end $$;

create or replace function public.decline_delivery(p_delivery uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r public.riders := public._my_rider(); d public.deliveries;
begin
  select * into d from public.deliveries where id = p_delivery for update;
  if d.id is null or d.status <> 'searching' then raise exception 'This request has already moved on.'; end if;
  insert into public.delivery_offers (delivery_id, rider_id, response, reason) values (d.id, r.id, 'declined', p_reason) on conflict do nothing;
  perform public._event(d.id, 'declined', r.display_name || ' declined' || coalesce(' · ' || nullif(p_reason, ''), ''), public._rider_actor(r.id));
  if public._eligible_online_count(d.id) = 0 and not d.no_driver then
    update public.deliveries set no_driver = true where id = d.id;
    perform public._notify('vendor', d.vendor_id, null, 'No driver available yet', 'Drivers nearby passed on ' || d.ref || '. We keep it open; you can allow larger vehicles.', d.id, 'bad');
    perform public._notify('ops', null, null, 'No driver for ' || d.ref, 'All eligible online drivers declined', d.id, 'bad');
  end if;
  perform public._audit('delivery.declined', 'delivery', d.ref, d.id, jsonb_build_object('rider', r.id, 'reason', p_reason));
end $$;

create or replace function public.rider_start_trip(p_delivery uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._rider_delivery(p_delivery);
begin
  if d.status <> 'assigned' then raise exception 'Start the trip once the job is assigned to you.'; end if;
  perform public._set_status(d.id, 'en_route_pickup', public._rider_actor(d.rider_id));
end $$;

create or replace function public.rider_arrive_pickup(p_delivery uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._rider_delivery(p_delivery); g text;
begin
  if d.status <> 'en_route_pickup' then raise exception 'You are not on the way to this pickup.'; end if;
  g := public._geo_check(d.rider_id, d.pickup_lat, d.pickup_lng, 'the pickup');
  perform public._set_status(d.id, 'at_pickup', public._rider_actor(d.rider_id), jsonb_build_object('geo', g));
end $$;

create or replace function public.rider_set_photo(p_delivery uuid, p_stage text, p_path text) returns void
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._rider_delivery(p_delivery); l public.rider_locations;
begin
  if split_part(coalesce(p_path, ''), '/', 1) <> d.id::text then raise exception 'Upload the photo again.'; end if;
  l := public._fresh_loc(d.rider_id);
  if p_stage = 'pickup' then
    if d.status <> 'at_pickup' then raise exception 'Confirm arrival at the pickup first.'; end if;
    update public.proof_of_delivery set pickup_photo_path = p_path, pickup_lat = l.lat, pickup_lng = l.lng where delivery_id = d.id;
    perform public._event(d.id, 'pickup_photo', 'Pickup photo captured', public._rider_actor(d.rider_id), l.lat, l.lng);
  elsif p_stage = 'drop' then
    if d.status not in ('arrived', 'awaiting_confirmation') then raise exception 'Take the handover photo at the drop-off.'; end if;
    update public.proof_of_delivery set photo_path = p_path, photo_at = now(), lat = l.lat, lng = l.lng where delivery_id = d.id;
    perform public._event(d.id, 'drop_photo', 'Delivery photo captured', public._rider_actor(d.rider_id), l.lat, l.lng);
  else
    raise exception 'Unknown photo type.';
  end if;
end $$;

create or replace function public.rider_confirm_pickup(p_delivery uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._rider_delivery(p_delivery); pod public.proof_of_delivery; sec public.delivery_secrets; l public.rider_locations;
begin
  if d.status <> 'at_pickup' then return jsonb_build_object('ok', false, 'error', 'Confirm arrival at the pickup first.'); end if;
  select * into pod from public.proof_of_delivery where delivery_id = d.id;
  if pod.pickup_photo_path is null then return jsonb_build_object('ok', false, 'error', 'Take a photo of the package before confirming pickup.'); end if;
  select * into sec from public.delivery_secrets where delivery_id = d.id;
  if d.handover is null then
    if coalesce(p_pin, '') !~ '^\d{4}$' then return jsonb_build_object('ok', false, 'error', 'Enter the 4-digit pickup PIN from the vendor.'); end if;
    if p_pin <> sec.pickup_pin then
      perform public._event(d.id, 'pickup_pin_wrong', 'Wrong pickup PIN entered', public._rider_actor(d.rider_id));
      return jsonb_build_object('ok', false, 'error', 'That PIN doesn''t match. Ask the vendor to read it from their app.');
    end if;
  end if;
  l := public._fresh_loc(d.rider_id);
  update public.proof_of_delivery set pickup_pin_ok = d.handover is null, pickup_at = now(), pickup_lat = coalesce(l.lat, pickup_lat), pickup_lng = coalesce(l.lng, pickup_lng) where delivery_id = d.id;
  perform public._set_status(d.id, 'picked_up', public._rider_actor(d.rider_id));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.rider_start_delivery(p_delivery uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._rider_delivery(p_delivery);
begin
  if d.status <> 'picked_up' then raise exception 'Pick up the package before starting the delivery.'; end if;
  perform public._set_status(d.id, 'in_transit', public._rider_actor(d.rider_id));
end $$;

create or replace function public.rider_mark_approaching(p_delivery uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._rider_delivery(p_delivery);
begin
  if d.status <> 'in_transit' then raise exception 'You can only do this while delivering.'; end if;
  perform public._set_status(d.id, 'approaching', public._rider_actor(d.rider_id), jsonb_build_object('how', 'reported by driver'));
end $$;

create or replace function public.rider_arrive_dropoff(p_delivery uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._rider_delivery(p_delivery); g text;
begin
  if d.status not in ('in_transit', 'approaching') then raise exception 'You are not on the way to this drop-off.'; end if;
  g := public._geo_check(d.rider_id, d.dropoff_lat, d.dropoff_lng, 'the drop-off');
  perform public._set_status(d.id, 'arrived', public._rider_actor(d.rider_id), jsonb_build_object('geo', g));
end $$;

create or replace function public.rider_start_handoff(p_delivery uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._rider_delivery(p_delivery);
begin
  if d.status <> 'arrived' then raise exception 'Confirm arrival before starting the handover.'; end if;
  perform public._set_status(d.id, 'awaiting_confirmation', public._rider_actor(d.rider_id));
end $$;

-- Shared PIN check for the rider app and the recipient page. Locks after 5 wrong attempts for 10 minutes.
create or replace function public._check_delivery_pin(p_delivery uuid, p_pin text, p_by text, p_actor jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.deliveries; sec public.delivery_secrets; pod public.proof_of_delivery; left_ int;
begin
  select * into d from public.deliveries where id = p_delivery for update;
  select * into sec from public.delivery_secrets where delivery_id = p_delivery for update;
  select * into pod from public.proof_of_delivery where delivery_id = p_delivery;
  if d.status <> 'awaiting_confirmation' then
    return jsonb_build_object('ok', false, 'error', case when d.status = 'arrived' then 'The rider needs to start the handover first.' else 'The PIN can be entered once the rider is at the door.' end);
  end if;
  if pod.pin_confirmed then return jsonb_build_object('ok', true, 'already', true); end if;
  if sec.pin_locked_until is not null and sec.pin_locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong PINs. Try again after ' || public._fmt_time(sec.pin_locked_until) || ' or contact support.');
  end if;
  if coalesce(p_pin, '') !~ '^\d{4}$' then return jsonb_build_object('ok', false, 'error', 'The delivery PIN has 4 digits.'); end if;
  if p_pin <> sec.delivery_pin then
    update public.delivery_secrets set pin_attempts = pin_attempts + 1,
      pin_locked_until = case when pin_attempts + 1 >= 5 then now() + interval '10 minutes' else null end
    where delivery_id = d.id returning pin_attempts into left_;
    perform public._event(d.id, 'pin_wrong', 'Incorrect delivery PIN (attempt ' || left_ || ', entered by ' || p_by || ')', p_actor);
    if left_ >= 3 and not ('pin_mismatch' = any(d.flags)) then
      update public.deliveries set flags = array_append(flags, 'pin_mismatch') where id = d.id;
      perform public._notify('ops', null, null, 'PIN mismatch · ' || d.ref, left_ || ' wrong PIN attempts at the drop-off', d.id, 'bad');
    end if;
    return jsonb_build_object('ok', false, 'attempts', left_, 'error', case when left_ >= 5 then 'PIN locked for 10 minutes after 5 wrong attempts. Ops has been alerted.'
      when left_ >= 3 then 'PIN still incorrect. Ops has been alerted. Check the SMS or resend the PIN.'
      else 'That PIN doesn''t match. ' || (3 - left_) || ' attempt' || case when 3 - left_ = 1 then '' else 's' end || ' left before ops is alerted.' end);
  end if;
  update public.delivery_secrets set pin_attempts = 0, pin_locked_until = null where delivery_id = d.id;
  update public.proof_of_delivery set pin_confirmed = true, pin_confirmed_by = p_by, pin_confirmed_at = now(), recipient_confirmed = (p_by = 'recipient') where delivery_id = d.id;
  perform public._event(d.id, 'pin_ok', 'Recipient PIN confirmed' || case when p_by = 'recipient' then ' by the recipient' else ' by the rider' end, p_actor);
  perform public._notify('vendor', d.vendor_id, null, 'Recipient confirmed with PIN', d.ref || ' · ' || (select name from public.recipients where id = d.recipient_id), d.id);
  if p_by = 'recipient' and d.rider_id is not null then
    perform public._notify('rider', null, d.rider_id, 'Recipient confirmed with PIN', d.ref || ' · finish the handover proof to complete.', d.id, 'ok');
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.rider_submit_pin(p_delivery uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._rider_delivery(p_delivery);
begin
  return public._check_delivery_pin(d.id, p_pin, 'rider', public._rider_actor(d.rider_id));
end $$;

create or replace function public.rider_set_signature(p_delivery uuid, p_path text) returns void
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._rider_delivery(p_delivery);
begin
  if d.status not in ('arrived', 'awaiting_confirmation') then raise exception 'Collect the signature at the drop-off.'; end if;
  if p_path is not null and split_part(p_path, '/', 1) <> d.id::text then raise exception 'Capture the signature again.'; end if;
  update public.proof_of_delivery set signature_path = p_path where delivery_id = d.id;
  if p_path is not null then perform public._event(d.id, 'signature', 'Recipient signature captured', public._rider_actor(d.rider_id)); end if;
end $$;

create or replace function public.rider_set_receiver(p_delivery uuid, p_who text, p_name text default null) returns void
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._rider_delivery(p_delivery);
begin
  if p_who not in ('recipient', 'other') then raise exception 'Choose who received the package.'; end if;
  update public.proof_of_delivery set received_by = p_who, receiver_name = case when p_who = 'other' then nullif(trim(p_name), '') else null end where delivery_id = d.id;
end $$;

create or replace function public.rider_complete(p_delivery uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._rider_delivery(p_delivery); pod public.proof_of_delivery; l public.rider_locations;
begin
  select * into pod from public.proof_of_delivery where delivery_id = d.id;
  if d.status <> 'awaiting_confirmation' then raise exception 'Start the handover first.'; end if;
  if not pod.pin_confirmed then raise exception 'Enter the recipient PIN before completing.'; end if;
  if pod.photo_path is null then raise exception 'Take a handover photo before completing.'; end if;
  if d.sig_required and pod.signature_path is null then raise exception 'This delivery needs the recipient signature.'; end if;
  if pod.received_by = 'other' and length(coalesce(trim(pod.receiver_name), '')) < 2 then raise exception 'Enter the name of the person who received it.'; end if;
  l := public._fresh_loc(d.rider_id);
  update public.proof_of_delivery set lat = coalesce(l.lat, lat), lng = coalesce(l.lng, lng), location_source = case when l.rider_id is null then 'none' else 'gps' end,
    distance_m = case when l.rider_id is null then null else public._dist_m(l.lat, l.lng, d.dropoff_lat, d.dropoff_lng) end
  where delivery_id = d.id;
  if not public._try_complete(d.id, public._rider_actor(d.rider_id)) then raise exception 'The delivery could not be completed. Check the proof steps.'; end if;
end $$;

create or replace function public.rider_release(p_delivery uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._rider_delivery(p_delivery); r public.riders;
begin
  if d.status not in ('assigned', 'en_route_pickup', 'at_pickup') then raise exception 'After pickup you must finish the delivery or report a problem to ops.'; end if;
  select * into r from public.riders where id = d.rider_id;
  insert into public.delivery_offers (delivery_id, rider_id, response, reason) values (d.id, r.id, 'released', p_reason) on conflict do nothing;
  update public.riders set active_delivery_id = null, status = case when online then 'idle' else 'offline' end where id = r.id;
  perform public._event(d.id, 'driver_cancelled', r.display_name || ' released the job · ' || coalesce(nullif(p_reason, ''), 'no reason given'), public._rider_actor(r.id));
  perform public._notify('ops', null, null, 'Driver released ' || d.ref, r.display_name || ': ' || coalesce(p_reason, 'no reason'), d.id, 'warn');
  update public.deliveries set rider_id = null, vehicle_id = null where id = d.id;
  update public.proof_of_delivery set rider_id = null, vehicle_id = null, pickup_photo_path = null where delivery_id = d.id;
  perform public._set_status(d.id, 'searching', public._sys(), jsonb_build_object('why', public._first(r.display_name) || ' released it (' || coalesce(p_reason, 'no reason') || ')'));
end $$;

create or replace function public.rider_report_vehicle_issue(p_delivery uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._rider_delivery(p_delivery); l public.rider_locations := public._fresh_loc(d.rider_id);
begin
  if 'vehicle_issue' = any(d.flags) then raise exception 'Ops already knows about the vehicle problem.'; end if;
  update public.deliveries set flags = array_append(flags, 'vehicle_issue') where id = d.id;
  perform public._event(d.id, 'vehicle_issue', 'Vehicle problem reported', public._rider_actor(d.rider_id), l.lat, l.lng);
  perform public._notify('ops', null, null, 'Vehicle problem · ' || d.ref, (select display_name from public.riders where id = d.rider_id) || ' needs a handover', d.id, 'bad');
  perform public._notify('vendor', d.vendor_id, null, d.ref || ' is delayed', 'The driver reported a vehicle problem. Ops is arranging a handover.', d.id, 'warn');
end $$;

create or replace function public.rider_report_unreachable(p_delivery uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._rider_delivery(p_delivery);
begin
  if d.status not in ('arrived', 'awaiting_confirmation') then raise exception 'You can only report this at the drop-off.'; end if;
  if d.unreachable_at is null then
    update public.deliveries set unreachable_at = now(), unreachable_calls = 0 where id = d.id;
    perform public._event(d.id, 'unreachable', 'Recipient not available · waiting', public._rider_actor(d.rider_id));
    perform public._notify('vendor', d.vendor_id, null, 'Recipient not answering', d.ref || ': the driver is waiting at the drop-off.', d.id, 'warn');
    perform public._notify('ops', null, null, 'Recipient not answering · ' || d.ref, d.dropoff_area, d.id, 'warn');
    perform public._sms(d.id, 'Your rider is waiting at the drop-off with your ' || (select name from public.vendors where id = d.vendor_id) || ' delivery. Please come out or reply.');
  end if;
end $$;

create or replace function public.rider_mark_failed(p_delivery uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._rider_delivery(p_delivery); wait_min int := (public._setting('unreachable_wait_min', '10'))::int;
begin
  if d.status not in ('arrived', 'awaiting_confirmation') then raise exception 'You can only do this at the drop-off.'; end if;
  if d.unreachable_at is null then raise exception 'Report the recipient as unavailable first.'; end if;
  if d.unreachable_calls < 3 then raise exception 'Call the recipient 3 times before marking the delivery failed.'; end if;
  if now() - d.unreachable_at < make_interval(mins => wait_min) then
    raise exception 'Wait the full % minutes before marking it failed (% left).', wait_min,
      ceil(extract(epoch from (make_interval(mins => wait_min) - (now() - d.unreachable_at))) / 60);
  end if;
  perform public._set_status(d.id, 'failed', public._rider_actor(d.rider_id),
    jsonb_build_object('reason', coalesce(nullif(p_reason, ''), 'Recipient unreachable after ' || d.unreachable_calls || ' calls')));
end $$;

create or replace function public.rider_request_payout(p_amount int default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.riders := public._my_rider(); w uuid := public._wallet_id('rider', r.id); bal bigint; amt int; pay uuid; ph text;
begin
  select balance into bal from public.wallets where id = w for update;
  amt := coalesce(p_amount, bal);
  if amt < 1000 then raise exception 'You need at least UGX 1,000 to cash out.'; end if;
  if amt > bal then raise exception 'You can cash out up to %.', public._fmt_ugx(bal); end if;
  select phone into ph from public.profiles where id = r.profile_id;
  insert into public.payments (rider_id, purpose, method, amount, status, provider_ref, captured_at)
  values (r.id, 'payout', 'momo', amt, 'successful', 'SIM-PAYOUT-' || upper(substr(md5(random()::text), 1, 8)), now()) returning id into pay;
  perform public._wallet_post(w, 'payout', -amt, 'momo', 'Cash out to MTN MoMo •••' || right(coalesce(ph, ''), 3) || ' (simulated)', 'completed', null, pay);
  perform public._notify('rider', null, r.id, 'Payout sent', public._fmt_ugx(amt) || ' to MTN MoMo •••' || right(coalesce(ph, ''), 3) || ' (simulated).', null, 'money');
  perform public._audit('rider.payout', 'rider', r.id::text, null, jsonb_build_object('amount', amt, 'simulated', true));
  return jsonb_build_object('ok', true, 'amount', amt);
end $$;

create or replace function public.send_message(p_delivery uuid, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._rider_delivery(p_delivery); b text := trim(coalesce(p_body, ''));
begin
  if b = '' then raise exception 'Type a message first.'; end if;
  insert into public.delivery_messages (delivery_id, sender_role, sender_id, body) values (d.id, 'rider', d.rider_id, left(b, 1000));
  perform public._sms(d.id, public._first((select display_name from public.riders where id = d.rider_id)) || ' (your rider): ' || left(b, 300));
end $$;

create or replace function public.rider_sos(p_delivery uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare r public.riders := public._my_rider(); l public.rider_locations := public._fresh_loc(r.id); d public.deliveries;
begin
  if p_delivery is not null then select * into d from public.deliveries where id = p_delivery and rider_id = r.id; end if;
  perform public._notify('ops', null, null, 'SOS · ' || r.display_name,
    'Emergency alert' || case when l.rider_id is not null then ' at ' || round(l.lat::numeric, 5) || ', ' || round(l.lng::numeric, 5) else ' · no GPS fix' end || coalesce(' · ' || d.ref, ''), d.id, 'bad');
  if d.id is not null then perform public._event(d.id, 'sos', 'SOS raised by ' || r.display_name, public._rider_actor(r.id), l.lat, l.lng); end if;
  perform public._audit('rider.sos', 'rider', r.id::text, d.id, jsonb_build_object('lat', l.lat, 'lng', l.lng));
end $$;

/* ------------------------------------------------------------------ recipient (no account; tracking token + code) */

create or replace function public._recipient_delivery(p_token text, p_code text) returns public.deliveries
language plpgsql security definer set search_path = public as $$
declare sec public.delivery_secrets; d public.deliveries; ph text;
begin
  select * into sec from public.delivery_secrets where tracking_token = p_token;
  if sec.delivery_id is null then raise exception 'This tracking link is not valid.' using errcode = 'P0002'; end if;
  if sec.verify_locked_until is not null and sec.verify_locked_until > now() then
    raise exception 'Too many attempts. Try again after %.', public._fmt_time(sec.verify_locked_until) using errcode = '42501';
  end if;
  select * into d from public.deliveries where id = sec.delivery_id;
  select r.phone into ph from public.recipients r where r.id = d.recipient_id;
  if coalesce(p_code, '') = right(regexp_replace(ph, '\D', '', 'g'), 4) or coalesce(p_code, '') = sec.delivery_pin then
    if sec.verify_attempts > 0 then update public.delivery_secrets set verify_attempts = 0, verify_locked_until = null where delivery_id = d.id; end if;
    return d;
  end if;
  return null;
end $$;

-- Wrong codes are counted here (a separate call so the count survives the error the caller returns).
create or replace function public._recipient_fail(p_token text) returns text
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.delivery_secrets set verify_attempts = verify_attempts + 1,
    verify_locked_until = case when verify_attempts + 1 >= 8 then now() + interval '15 minutes' else null end
  where tracking_token = p_token returning verify_attempts into n;
  return case when n >= 8 then 'Too many attempts. Try again in 15 minutes.'
    else 'Those digits don''t match the number this link was sent to. Try again or use your delivery PIN.' end;
end $$;

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
    'pickup', jsonb_build_object('name', d.pickup_name, 'area', d.pickup_area, 'x', d.pickup_x, 'y', d.pickup_y),
    'dropoff', jsonb_build_object('name', d.dropoff_name, 'area', d.dropoff_area, 'x', d.dropoff_x, 'y', d.dropoff_y, 'lat', d.dropoff_lat, 'lng', d.dropoff_lng),
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
      from public.delivery_events e where e.delivery_id = d.id and e.type not in ('payment', 'settled', 'broadcast', 'declined', 'call', 'ticket')), '[]'),
    'chat', coalesce((select jsonb_agg(jsonb_build_object('from', m.sender_role, 'text', m.body, 'ts', m.created_at) order by m.created_at)
      from public.delivery_messages m where m.delivery_id = d.id), '[]'),
    'sms', coalesce((select jsonb_agg(jsonb_build_object('ts', n.created_at, 'body', n.body) order by n.created_at desc)
      from public.notifications n where n.delivery_id = d.id and n.channel = 'sms'), '[]'));
end $$;

create or replace function public.recipient_view(p_token text, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.deliveries;
begin
  d := public._recipient_delivery(p_token, p_code);
  if d.id is null then return jsonb_build_object('ok', false, 'error', public._recipient_fail(p_token)); end if;
  if d.recipient_opened_at is null then
    update public.deliveries set recipient_opened_at = now() where id = d.id;
    perform public._event(d.id, 'link_opened', 'Recipient opened the tracking link', jsonb_build_object('role', 'recipient', 'name', (select name from public.recipients where id = d.recipient_id)));
  end if;
  if auth.uid() is not null and public.my_role() = 'recipient' then
    insert into public.recipient_links (profile_id, delivery_id) values (auth.uid(), d.id) on conflict do nothing;
  end if;
  return jsonb_build_object('ok', true, 'delivery', public._recipient_json(d));
end $$;

create or replace function public.recipient_lookup(p_ref text, p_last4 text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.deliveries; sec public.delivery_secrets; ok boolean;
begin
  select * into d from public.deliveries where ref = upper(trim(coalesce(p_ref, '')));
  if d.id is null then return jsonb_build_object('ok', false, 'error', 'No delivery with that reference. It looks like DO-48233.'); end if;
  select * into sec from public.delivery_secrets where delivery_id = d.id;
  if sec.verify_locked_until is not null and sec.verify_locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'Too many attempts. Try again after ' || public._fmt_time(sec.verify_locked_until) || '.');
  end if;
  ok := (public._recipient_delivery(sec.tracking_token, p_last4)).id is not null;
  if not ok then return jsonb_build_object('ok', false, 'error', public._recipient_fail(sec.tracking_token)); end if;
  return jsonb_build_object('ok', true, 'token', sec.tracking_token);
end $$;

create or replace function public.recipient_confirm(p_token text, p_code text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.deliveries; res jsonb; actor jsonb;
begin
  d := public._recipient_delivery(p_token, p_code);
  if d.id is null then return jsonb_build_object('ok', false, 'error', public._recipient_fail(p_token)); end if;
  actor := jsonb_build_object('role', 'recipient', 'name', (select name from public.recipients where id = d.recipient_id));
  res := public._check_delivery_pin(d.id, p_pin, 'recipient', actor);
  if (res->>'ok')::boolean then
    update public.proof_of_delivery set recipient_confirmed = true where delivery_id = d.id;
    res := res || jsonb_build_object('delivered', public._try_complete(d.id, actor));
  end if;
  return res;
end $$;

create or replace function public.recipient_send_message(p_token text, p_code text, p_body text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._recipient_delivery(p_token, p_code); b text := trim(coalesce(p_body, ''));
begin
  if d.id is null then return jsonb_build_object('ok', false, 'error', public._recipient_fail(p_token)); end if;
  if b = '' then return jsonb_build_object('ok', false, 'error', 'Type a message first.'); end if;
  if d.rider_id is null then return jsonb_build_object('ok', false, 'error', 'Messages open once a driver is assigned.'); end if;
  insert into public.delivery_messages (delivery_id, sender_role, body) values (d.id, 'recipient', left(b, 1000));
  perform public._notify('rider', null, d.rider_id, split_part((select name from public.recipients where id = d.recipient_id), ' ', 1) || ' (recipient)', left(b, 300), d.id, 'chat');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.recipient_call(p_token text, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._recipient_delivery(p_token, p_code);
begin
  if d.id is null then return jsonb_build_object('ok', false, 'error', public._recipient_fail(p_token)); end if;
  perform public._event(d.id, 'call', 'Call · recipient → rider (masked calling not connected; logged only)', jsonb_build_object('role', 'recipient', 'name', 'Recipient'));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.recipient_open_ticket(p_token text, p_code text, p_category text, p_description text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._recipient_delivery(p_token, p_code); res jsonb;
begin
  if d.id is null then return jsonb_build_object('ok', false, 'error', public._recipient_fail(p_token)); end if;
  res := public._open_ticket(d.id, 'recipient', p_category, p_description, '{}', jsonb_build_object('role', 'recipient', 'name', (select name from public.recipients where id = d.recipient_id)));
  return jsonb_build_object('ok', true) || res;
end $$;

create or replace function public.recipient_resend_pin(p_token text, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._recipient_delivery(p_token, p_code);
begin
  if d.id is null then return jsonb_build_object('ok', false, 'error', public._recipient_fail(p_token)); end if;
  if (select count(*) from public.delivery_events where delivery_id = d.id and type = 'pin_resent' and created_at > now() - interval '1 hour') >= 3 then
    return jsonb_build_object('ok', false, 'error', 'The PIN was already re-sent 3 times this hour. Contact support.');
  end if;
  perform public._sms(d.id, 'Your Drop Off delivery PIN for ' || d.ref || ' is ' || (select delivery_pin from public.delivery_secrets where delivery_id = d.id) || '. Only share it with your rider once you have the package.');
  perform public._event(d.id, 'pin_resent', 'Delivery PIN re-sent by SMS', jsonb_build_object('role', 'recipient', 'name', 'Recipient'));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.recipient_rate(p_token text, p_code text, p_stars int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._recipient_delivery(p_token, p_code); r public.riders;
begin
  if d.id is null then return jsonb_build_object('ok', false, 'error', public._recipient_fail(p_token)); end if;
  if d.status not in ('delivered', 'disputed') then return jsonb_build_object('ok', false, 'error', 'You can rate once the delivery is complete.'); end if;
  if p_stars not between 1 and 5 then return jsonb_build_object('ok', false, 'error', 'Choose 1 to 5 stars.'); end if;
  if d.rating is null and d.rider_id is not null then
    select * into r from public.riders where id = d.rider_id for update;
    update public.riders set rating = round(((rating * greatest(trips, 1)) + p_stars) / (greatest(trips, 1) + 1)::numeric, 2) where id = r.id;
  end if;
  update public.deliveries set rating = p_stars where id = d.id;
  perform public._event(d.id, 'rated', 'Recipient rated the delivery ' || p_stars || '/5', jsonb_build_object('role', 'recipient', 'name', 'Recipient'));
  return jsonb_build_object('ok', true);
end $$;

-- For the recipient-proof Edge Function only (service role): storage paths behind a valid token + code.
create or replace function public.recipient_proof_paths(p_token text, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.deliveries := public._recipient_delivery(p_token, p_code); pod public.proof_of_delivery;
begin
  if d.id is null or d.status not in ('delivered', 'disputed') then return null; end if;
  select * into pod from public.proof_of_delivery where delivery_id = d.id;
  return jsonb_build_object('photo', pod.photo_path, 'signature', pod.signature_path);
end $$;

/* ------------------------------------------------------------------ operations */

create or replace function public.ops_assign(p_delivery uuid, p_rider uuid) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_ops(); d public.deliveries; r public.riders; veh public.vehicles;
begin
  select * into d from public.deliveries where id = p_delivery for update;
  if d.id is null or d.status <> 'searching' then raise exception 'Only deliveries that are looking for a driver can be assigned.'; end if;
  select * into r from public.riders where id = p_rider for update;
  if r.id is null or r.verification_status <> 'verified' then raise exception '% is not verified yet.', coalesce(r.display_name, 'This driver'); end if;
  if r.active_delivery_id is not null then raise exception '% is on another delivery.', r.display_name; end if;
  select * into veh from public.vehicles where rider_id = r.id and is_active limit 1;
  if veh.id is null or not veh.class_id = any(public._eligible_classes((select size from public.packages where id = d.package_id), (select weight_kg from public.packages where id = d.package_id))) then
    raise exception 'A % can''t carry this package.', coalesce(veh.class_id, 'vehicle');
  end if;
  if not r.online then
    perform public._notify('rider', null, r.id, 'Ops put you online', 'You have been assigned ' || d.ref || '.', d.id);
  end if;
  update public.riders set online = true, active_delivery_id = d.id, status = 'on_job' where id = r.id;
  update public.deliveries set rider_id = r.id, vehicle_id = veh.id, no_driver = false where id = d.id;
  update public.proof_of_delivery set rider_id = r.id, vehicle_id = veh.id where delivery_id = d.id;
  perform public._set_status(d.id, 'assigned', public._actor());
  perform public._audit('ops.assign', 'delivery', d.ref, d.id, jsonb_build_object('rider', r.id));
end $$;

create or replace function public.ops_reassign(p_delivery uuid, p_rider uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_ops(); d public.deliveries; r public.riders; prev public.riders; veh public.vehicles;
  after_pickup boolean; l public.rider_locations;
begin
  select * into d from public.deliveries where id = p_delivery for update;
  if d.status not in ('assigned', 'en_route_pickup', 'at_pickup', 'picked_up', 'in_transit', 'approaching') then
    raise exception 'This delivery cannot be reassigned in its current state.';
  end if;
  select * into prev from public.riders where id = d.rider_id for update;
  select * into r from public.riders where id = p_rider for update;
  if r.id is null or prev.id = r.id then raise exception 'Choose a different driver.'; end if;
  if r.verification_status <> 'verified' then raise exception '% is not verified yet.', r.display_name; end if;
  if r.active_delivery_id is not null then raise exception '% is on another delivery.', r.display_name; end if;
  select * into veh from public.vehicles where rider_id = r.id and is_active limit 1;
  if veh.id is null or not veh.class_id = any(public._eligible_classes((select size from public.packages where id = d.package_id), (select weight_kg from public.packages where id = d.package_id))) then
    raise exception 'A % can''t carry this package.', coalesce(veh.class_id, 'vehicle');
  end if;
  after_pickup := d.status in ('picked_up', 'in_transit', 'approaching');
  update public.riders set active_delivery_id = null, status = case when online then 'idle' else 'offline' end where id = prev.id;
  perform public._notify('rider', null, prev.id, 'Removed from ' || d.ref, 'Ops reassigned this job' || coalesce(': ' || nullif(p_reason, ''), '') || '.', d.id, 'warn');
  if after_pickup then
    l := public._fresh_loc(prev.id);
    update public.deliveries set handover = jsonb_build_object('from', prev.id, 'fromName', prev.display_name, 'at', now(), 'lat', l.lat, 'lng', l.lng),
      pickup_name = 'Handover with ' || public._first(prev.display_name), pickup_area = 'handover point',
      pickup_lat = coalesce(l.lat, pickup_lat), pickup_lng = coalesce(l.lng, pickup_lng)
    where id = d.id;
    update public.proof_of_delivery set pickup_photo_path = null, pickup_at = null, pickup_pin_ok = false where delivery_id = d.id;
  end if;
  update public.deliveries set flags = array_remove(flags, 'vehicle_issue'), rider_id = r.id, vehicle_id = veh.id where id = d.id;
  update public.proof_of_delivery set rider_id = r.id, vehicle_id = veh.id where delivery_id = d.id;
  update public.riders set online = true, active_delivery_id = d.id, status = 'on_job' where id = r.id;
  perform public._event(d.id, 'reassigned', 'Ops reassigned from ' || prev.display_name || ' to ' || r.display_name || coalesce(' · ' || nullif(p_reason, ''), '') ||
    case when after_pickup then ' · handover at the previous driver''s location' else '' end, public._actor());
  if d.status = 'assigned' then
    perform public._notify('vendor', d.vendor_id, null, 'New driver: ' || public._first(r.display_name), d.ref || ' · ' || veh.make || ' · ' || veh.plate, d.id);
    perform public._notify('rider', null, r.id, 'Job assigned by ops · ' || d.ref, 'Pickup at ' || d.pickup_name || '.', d.id, 'offer');
  else
    perform public._set_status(d.id, 'assigned', public._actor());
  end if;
  if after_pickup then
    perform public._notify('rider', null, r.id, 'Handover job · ' || d.ref, 'Collect the package from ' || prev.display_name || ' at their current location.', d.id, 'offer');
  end if;
  perform public._audit('ops.reassign', 'delivery', d.ref, d.id, jsonb_build_object('from', prev.id, 'to', r.id, 'reason', p_reason, 'handover', after_pickup));
end $$;

create or replace function public.ops_cancel(p_delivery uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_ops(); d public.deliveries;
begin
  select * into d from public.deliveries where id = p_delivery for update;
  if d.status not in ('pending', 'searching', 'assigned', 'en_route_pickup', 'at_pickup') and not (d.status = 'failed' and d.resolution is null) then
    raise exception 'After pickup, mark the delivery failed instead so the package is returned.';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Give a reason for the cancellation.'; end if;
  perform public._set_status(d.id, 'cancelled', public._actor(), jsonb_build_object('reason', trim(p_reason)));
  perform public._audit('ops.cancel', 'delivery', d.ref, d.id, jsonb_build_object('reason', p_reason));
end $$;

create or replace function public.ops_fail(p_delivery uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_ops(); d public.deliveries;
begin
  select * into d from public.deliveries where id = p_delivery for update;
  if d.status not in ('picked_up', 'in_transit', 'approaching', 'arrived', 'awaiting_confirmation') then raise exception 'Only deliveries already picked up can be marked failed.'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Give a reason.'; end if;
  perform public._set_status(d.id, 'failed', public._actor(), jsonb_build_object('reason', trim(p_reason)));
  perform public._audit('ops.fail', 'delivery', d.ref, d.id, jsonb_build_object('reason', p_reason));
end $$;

create or replace function public.ops_flag(p_delivery uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_ops(); d public.deliveries;
begin
  select * into d from public.deliveries where id = p_delivery for update;
  if d.id is null then raise exception 'Delivery not found.'; end if;
  if 'ops_flag' = any(d.flags) then
    update public.deliveries set flags = array_remove(flags, 'ops_flag'), flag_note = null where id = d.id;
    perform public._event(d.id, 'unflagged', 'Flag cleared by ops', public._actor());
    perform public._audit('ops.unflag', 'delivery', d.ref, d.id);
  else
    update public.deliveries set flags = array_append(flags, 'ops_flag'), flag_note = coalesce(nullif(trim(p_note), ''), 'Needs attention') where id = d.id;
    perform public._event(d.id, 'flagged', 'Flagged by ops · ' || coalesce(nullif(trim(p_note), ''), 'Needs attention'), public._actor());
    perform public._audit('ops.flag', 'delivery', d.ref, d.id, jsonb_build_object('note', p_note));
  end if;
end $$;

create or replace function public.ops_resolve_dispute(p_ticket uuid, p_decision text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_ops(); t public.support_tickets; d public.deliveries; pay public.payments; disp public.disputes;
  amt int := 0; ded int; rw uuid; rbal bigint;
begin
  select * into t from public.support_tickets where id = p_ticket for update;
  if t.id is null or t.status in ('resolved', 'closed') then raise exception 'This case is already closed.'; end if;
  select * into d from public.deliveries where id = t.delivery_id for update;
  if d.status <> 'disputed' then raise exception 'This case is not a dispute. Resolve it as a support case.'; end if;
  if p_decision not in ('refund_full', 'refund_half', 'reject') then raise exception 'Choose a decision.'; end if;
  select * into pay from public.payments where id = d.payment_id;
  amt := case p_decision when 'refund_full' then pay.amount when 'refund_half' then round(pay.amount / 2.0 / 500) * 500 else 0 end;
  if amt > 0 then
    perform public._refund(d.id, amt, 'Dispute refund', true);
    if d.rider_id is not null then
      rw := public._wallet_id('rider', d.rider_id);
      select balance into rbal from public.wallets where id = rw for update;
      ded := least(rbal, round(amt / 2.0))::int;
      if ded > 0 then
        perform public._wallet_post(rw, 'deduction', -ded, 'balance', 'Damage liability · ' || d.ref, 'completed', d.id, pay.id);
        perform public._notify('rider', null, d.rider_id, 'Damage claim upheld', public._fmt_ugx(ded) || ' deducted for ' || d.ref || '.', d.id, 'bad');
      end if;
    end if;
  end if;
  update public.payments set status = case when amt = 0 then 'successful' when amt >= pay.amount then 'refunded' else 'partially_refunded' end where id = pay.id;
  update public.support_tickets set status = 'resolved', resolution = p_decision, resolution_note = p_note, resolved_at = now(), assigned_to = coalesce(assigned_to, me.id) where id = t.id;
  update public.disputes set status = 'resolved', decision = p_decision, amount_refunded = amt, decided_by = me.id, resolved_at = now() where ticket_id = t.id;
  update public.deliveries set resolution = p_decision where id = d.id;
  perform public._set_status(d.id, 'delivered', public._actor());   -- disputed → delivered; payment already settled
  perform public._event(d.id, 'dispute_resolved', 'Dispute resolved · ' || case when amt > 0 then 'refund ' || public._fmt_ugx(amt) else 'claim rejected' end, public._actor());
  perform public._notify('vendor', d.vendor_id, null, 'Dispute resolved · ' || d.ref,
    case when amt > 0 then public._fmt_ugx(amt) || ' refunded to your wallet.' else 'The claim was rejected after reviewing the proof.' end, d.id, case when amt > 0 then 'money' else 'info' end);
  if t.opened_by_role = 'recipient' then perform public._sms(d.id, 'Drop Off support: your case ' || t.ref || ' was resolved. ' || coalesce(p_note, '')); end if;
  perform public._audit('ops.dispute_resolved', 'ticket', t.ref, d.id, jsonb_build_object('decision', p_decision, 'refund', amt));
end $$;

create or replace function public.ops_update_ticket(p_ticket uuid, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_ops(); t public.support_tickets;
begin
  select * into t from public.support_tickets where id = p_ticket for update;
  if t.id is null then raise exception 'Case not found.'; end if;
  if p_status not in ('open', 'in_review', 'waiting_for_user', 'resolved', 'closed') then raise exception 'Unknown status.'; end if;
  if t.status in ('resolved', 'closed') and p_status not in ('closed') then raise exception 'This case is already closed.'; end if;
  if exists (select 1 from public.deliveries where id = t.delivery_id and status = 'disputed') and p_status in ('resolved', 'closed') then
    raise exception 'Decide the dispute (refund or reject) to close this case.';
  end if;
  update public.support_tickets set status = p_status, assigned_to = coalesce(assigned_to, me.id),
    resolution = case when p_status in ('resolved', 'closed') then coalesce(resolution, 'resolved') else resolution end,
    resolution_note = coalesce(nullif(trim(p_note), ''), resolution_note),
    resolved_at = case when p_status in ('resolved', 'closed') then now() else resolved_at end
  where id = t.id;
  if t.delivery_id is not null then
    perform public._event(t.delivery_id, 'ticket_' || p_status, 'Support case ' || t.ref || ' · ' || replace(p_status, '_', ' '), public._actor());
  end if;
  if t.vendor_id is not null and t.opened_by_role = 'vendor' then
    perform public._notify('vendor', t.vendor_id, null, 'Support update · ' || t.ref, replace(initcap(replace(p_status, '_', ' ')), 'For', 'for') || coalesce(': ' || nullif(trim(p_note), ''), ''), t.delivery_id);
  elsif t.rider_id is not null then
    perform public._notify('rider', null, t.rider_id, 'Support update · ' || t.ref, initcap(replace(p_status, '_', ' ')) || coalesce(': ' || nullif(trim(p_note), ''), ''), t.delivery_id);
  elsif t.opened_by_role = 'recipient' and t.delivery_id is not null then
    perform public._sms(t.delivery_id, 'Drop Off support · case ' || t.ref || ': ' || replace(p_status, '_', ' ') || coalesce('. ' || nullif(trim(p_note), ''), ''));
  end if;
  perform public._audit('ops.ticket_' || p_status, 'ticket', t.ref, t.delivery_id, jsonb_build_object('note', p_note));
end $$;

create or replace function public.ops_review_verification(p_request uuid, p_decision text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_ops(); vr public.verification_requests; st text; who text;
begin
  select * into vr from public.verification_requests where id = p_request for update;
  if vr.id is null then raise exception 'Verification request not found.'; end if;
  st := case p_decision when 'approve' then 'verified' when 'reject' then 'rejected' when 'suspend' then 'suspended'
    when 'request_info' then 'pending' when 'start_review' then 'under_review' else null end;
  if st is null then raise exception 'Unknown decision.'; end if;
  if p_decision in ('reject', 'request_info', 'suspend') and length(trim(coalesce(p_note, ''))) < 3 then
    raise exception 'Add a note explaining the decision. The applicant sees it.';
  end if;
  update public.verification_requests set status = st, info_requested = (p_decision = 'request_info'), reviewer_id = me.id,
    reviewer_note = nullif(trim(p_note), ''), reviewed_at = now() where id = vr.id;
  update public.documents set status = case when p_decision = 'approve' then 'accepted' when p_decision = 'reject' then 'rejected' else status end
  where verification_request_id = vr.id;
  if vr.vendor_id is not null then
    update public.vendors set verification_status = st,
      credit_eligible = case when p_decision = 'approve' then true when p_decision in ('reject', 'suspend') then false else credit_eligible end,
      credit_limit = case when p_decision = 'approve' and credit_limit = 0 then 1000000 else credit_limit end
    where id = vr.vendor_id returning name into who;
    update public.wallets set credit_limit = (select credit_limit from public.vendors where id = vr.vendor_id) where vendor_id = vr.vendor_id and kind = 'credit';
    perform public._notify('vendor', vr.vendor_id, null,
      case p_decision when 'approve' then 'You''re verified' when 'reject' then 'Verification not approved' when 'suspend' then 'Account suspended'
        when 'request_info' then 'More information needed' else 'Verification in review' end,
      case p_decision when 'approve' then 'Business credit is open with a UGX 1,000,000 limit.' else coalesce(p_note, 'Ops is reviewing your documents.') end, null,
      case when p_decision = 'approve' then 'ok' when p_decision = 'start_review' then 'info' else 'warn' end);
  else
    update public.riders set verification_status = st,
      online = case when p_decision in ('reject', 'suspend') then false else online end,
      status = case when p_decision in ('reject', 'suspend') then 'offline' else status end
    where id = vr.rider_id returning display_name into who;
    update public.vehicles set verification_status = st where rider_id = vr.rider_id and is_active;
    perform public._notify('rider', null, vr.rider_id,
      case p_decision when 'approve' then 'You''re verified' when 'reject' then 'Application not approved' when 'suspend' then 'Account suspended'
        when 'request_info' then 'More information needed' else 'Application in review' end,
      case p_decision when 'approve' then 'Go online to start receiving deliveries.' else coalesce(p_note, 'Ops is reviewing your documents.') end, null,
      case when p_decision = 'approve' then 'ok' when p_decision = 'start_review' then 'info' else 'warn' end);
  end if;
  perform public._audit('verification.' || p_decision, 'verification_request', vr.id::text, null,
    jsonb_build_object('subject', vr.subject_type, 'name', who, 'note', p_note, 'status', st));
end $$;

create or replace function public.ops_set_account_status(p_profile uuid, p_status text, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_ops(); p public.profiles;
begin
  if p_status not in ('active', 'suspended') then raise exception 'Unknown status.'; end if;
  if p_profile = me.id then raise exception 'You cannot change your own account status.'; end if;
  if p_status = 'suspended' and length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Give a reason for the suspension.'; end if;
  update public.profiles set status = p_status, status_reason = nullif(trim(p_reason), '') where id = p_profile returning * into p;
  if p.id is null then raise exception 'Account not found.'; end if;
  if p_status = 'suspended' then
    update public.riders set online = false, status = 'offline' where profile_id = p.id and active_delivery_id is null;
  end if;
  perform public._audit('ops.account_' || p_status, 'profile', p.id::text, null, jsonb_build_object('reason', p_reason, 'role', p.role, 'name', p.full_name));
end $$;

create or replace function public.ops_set_rider_online(p_rider uuid, p_online boolean) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_ops(); r public.riders;
begin
  select * into r from public.riders where id = p_rider for update;
  if r.id is null then raise exception 'Driver not found.'; end if;
  if r.verification_status <> 'verified' then raise exception '% is not verified.', r.display_name; end if;
  if not p_online and r.active_delivery_id is not null then raise exception '% is on a delivery. Reassign it first.', r.display_name; end if;
  update public.riders set online = p_online, status = case when not p_online then 'offline' when active_delivery_id is not null then 'on_job' else 'idle' end where id = r.id;
  perform public._notify('rider', null, r.id, case when p_online then 'Ops put you online' else 'Ops set you offline' end, 'Contact ops if this is unexpected.', null, 'warn');
  perform public._audit('ops.rider_' || case when p_online then 'online' else 'offline' end, 'rider', r.id::text);
end $$;

create or replace function public.ops_update_pricing(p_class text, p_field text, p_value numeric) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_ops(); old_ numeric;
begin
  if p_value is null or p_value < 0 then raise exception 'Enter a positive number.'; end if;
  if p_field = 'commission_pct' and p_value > 40 then raise exception 'Commission above 40%% needs finance approval.'; end if;
  if p_field not in ('base', 'per_km', 'min_fare', 'fragile', 'express', 'commission_pct') then raise exception 'Unknown pricing field.'; end if;
  execute format('select %I from public.pricing_rules where class_id = $1', p_field) into old_ using p_class;
  if old_ is null then raise exception 'Unknown vehicle class.'; end if;
  execute format('update public.pricing_rules set %I = $1, updated_by = $2, updated_at = now() where class_id = $3', p_field) using round(p_value), me.id, p_class;
  perform public._notify('ops', null, null, 'Pricing updated', initcap(p_class) || ' ' || p_field || ': ' || old_ || ' → ' || round(p_value) || '. Applies to new bookings.', null);
  perform public._audit('ops.pricing_updated', 'pricing_rule', p_class, null, jsonb_build_object('field', p_field, 'from', old_, 'to', round(p_value)));
end $$;

create or replace function public.ops_update_class(p_class text, p_enabled boolean default null, p_max_kg numeric default null) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_ops(); c public.vehicle_classes;
begin
  if p_max_kg is not null and p_max_kg <= 0 then raise exception 'Max load must be above zero.'; end if;
  update public.vehicle_classes set enabled = coalesce(p_enabled, enabled), max_kg = coalesce(p_max_kg, max_kg) where id = p_class returning * into c;
  if c.id is null then raise exception 'Unknown vehicle class.'; end if;
  perform public._notify('ops', null, null, 'Vehicle class updated', c.label || case when p_enabled is not null then case when p_enabled then ' enabled' else ' disabled' end else ' · max ' || c.max_kg || ' kg' end, null);
  perform public._audit('ops.class_updated', 'vehicle_class', p_class, null, jsonb_build_object('enabled', p_enabled, 'max_kg', p_max_kg));
end $$;

create or replace function public.ops_toggle_zone(p_zone text) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_ops(); z public.service_areas;
begin
  update public.service_areas set enabled = not enabled, updated_at = now() where id = p_zone returning * into z;
  if z.id is null then raise exception 'Unknown service area.'; end if;
  perform public._notify('ops', null, null, 'Service area ' || case when z.enabled then 'opened' else 'closed' end, z.name, null, case when z.enabled then 'ok' else 'warn' end);
  perform public._audit('ops.zone_' || case when z.enabled then 'opened' else 'closed' end, 'service_area', z.id);
end $$;

create or replace function public.ops_set_setting(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_ops();
begin
  if p_key not in ('enforce_geofence', 'geofence_m', 'approach_radius_m', 'unreachable_wait_min', 'tracking_base_url') then raise exception 'Unknown setting.'; end if;
  update public.app_settings set value = p_value, updated_at = now() where key = p_key;
  perform public._audit('ops.setting_updated', 'setting', p_key, null, jsonb_build_object('value', p_value));
end $$;

create or replace function public.ops_set_credit(p_vendor uuid, p_limit int) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_ops(); v public.vendors; used bigint;
begin
  select * into v from public.vendors where id = p_vendor for update;
  if v.id is null then raise exception 'Vendor not found.'; end if;
  if v.verification_status <> 'verified' then raise exception 'Verify the business before opening credit.'; end if;
  if p_limit < 0 or p_limit > 50000000 then raise exception 'Credit limits run from 0 to UGX 50,000,000.'; end if;
  select -balance into used from public.wallets where vendor_id = v.id and kind = 'credit';
  if p_limit < coalesce(used, 0) then raise exception 'The vendor already uses %. Set a limit at or above that.', public._fmt_ugx(used); end if;
  update public.vendors set credit_limit = p_limit, credit_eligible = p_limit > 0 where id = v.id;
  update public.wallets set credit_limit = p_limit where vendor_id = v.id and kind = 'credit';
  perform public._notify('vendor', v.id, null, 'Credit limit updated', 'Your business credit limit is now ' || public._fmt_ugx(p_limit) || '.', null, 'money');
  perform public._audit('ops.credit_limit', 'vendor', v.id::text, null, jsonb_build_object('limit', p_limit));
end $$;

-- Ops can re-send the recipient PIN (e.g. after a support call) without seeing it.
create or replace function public.ops_resend_pin(p_delivery uuid) returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles := public._require_ops(); d public.deliveries;
begin
  select * into d from public.deliveries where id = p_delivery;
  if d.id is null then raise exception 'Delivery not found.'; end if;
  perform public._sms(d.id, 'Your Drop Off delivery PIN for ' || d.ref || ' is ' || (select delivery_pin from public.delivery_secrets where delivery_id = d.id) || '.');
  perform public._event(d.id, 'pin_resent', 'Delivery PIN re-sent by ops', public._actor());
end $$;
