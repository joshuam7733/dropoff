-- Drop Off · internal logic: identity helpers, state machine, ledger, pricing, matching, notifications.
-- Functions prefixed with "_" are internal. They are not callable by clients (execute is revoked in
-- 20261007000400_security.sql) and are used by the public API functions.

/* ------------------------------------------------------------------ identity helpers (used by RLS) */

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and status = 'active'
$$;

create or replace function public.is_ops() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'ops' and status = 'active')
$$;

create or replace function public.my_vendor_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select v.id from public.vendors v join public.profiles p on p.id = auth.uid() and p.status = 'active'
  where v.owner_id = auth.uid()
  union
  select s.vendor_id from public.vendor_staff s join public.profiles p on p.id = auth.uid() and p.status = 'active'
  where s.profile_id = auth.uid()
$$;

create or replace function public.is_vendor_member(p_vendor uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_vendor in (select public.my_vendor_ids())
$$;

create or replace function public.my_rider_id() returns uuid
language sql stable security definer set search_path = public as $$
  select r.id from public.riders r join public.profiles p on p.id = r.profile_id
  where r.profile_id = auth.uid() and p.status = 'active'
$$;

/* ------------------------------------------------------------------ small utilities */

create or replace function public._setting(p_key text, p_default jsonb) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select value from public.app_settings where key = p_key), p_default)
$$;

create or replace function public._fmt_ugx(n numeric) returns text language sql immutable as $$
  select 'UGX ' || to_char(round(coalesce(n, 0)), 'FM999,999,999,990')
$$;

create or replace function public._fmt_time(t timestamptz) returns text language sql stable as $$
  select ltrim(to_char(t at time zone 'Africa/Kampala', 'HH12:MI AM'), '0')
$$;

create or replace function public._first(name text) returns text language sql immutable as $$
  select split_part(coalesce(name, ''), ' ', 1) ||
    case when split_part(coalesce(name, ''), ' ', 2) <> '' then ' ' || left(split_part(name, ' ', 2), 1) || '.' else '' end
$$;

create or replace function public._initials(name text) returns text language sql immutable as $$
  select upper(coalesce(left(split_part(trim(name), ' ', 1), 1), '') || coalesce(left(split_part(trim(name), ' ', 2), 1), ''))
$$;

create or replace function public._norm_phone(p text) returns text language plpgsql immutable as $$
declare d text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
begin
  if d like '256%' then d := substr(d, 4); end if;
  if d like '0%' then d := substr(d, 2); end if;
  if d !~ '^7\d{8}$' then return null; end if;
  return '+256 ' || substr(d, 1, 3) || ' ' || substr(d, 4, 3) || ' ' || substr(d, 7, 3);
end $$;

create or replace function public._mask_phone(p text) returns text language sql immutable as $$
  select regexp_replace(coalesce(p, ''), '(\+256 \d{3}) (\d{3}) (\d{3})', '\1 •••\3')
$$;

create or replace function public._dist_m(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns numeric language sql immutable as $$
  select round((2 * 6371000 * asin(sqrt(power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))))::numeric)
$$;

create or replace function public._random_pin() returns text language sql volatile as $$
  select lpad((1000 + floor(random() * 9000))::int::text, 4, '0')
$$;

create or replace function public._random_token() returns text language sql volatile as $$
  select encode(extensions.gen_random_bytes(12), 'hex')
$$;

/* ------------------------------------------------------------------ city grid routing & pricing
   Mirrors DO.store.geo in the client so the price a vendor sees equals the price the server charges. */

create or replace function public._near(arr int[], v numeric) returns int language plpgsql immutable as $$
declare best int := arr[1]; x int;
begin
  foreach x in array arr loop
    if abs(x - v) < abs(best - v) then best := x; end if;
  end loop;
  return best;
end $$;

create or replace function public._grid_len(ax numeric, ay numeric, bx numeric, by numeric) returns numeric
language plpgsql immutable as $$
declare
  rx int[] := array[60, 200, 340, 480, 620, 760, 900];
  ry int[] := array[70, 190, 310, 430, 550];
  sax numeric; say numeric; sbx numeric; sby numeric;
begin
  if round(ax)::int = any(rx) then sax := round(ax); say := public._near(ry, ay); else sax := public._near(rx, ax); say := round(ay); end if;
  if round(bx)::int = any(rx) then sbx := round(bx); sby := public._near(ry, by); else sbx := public._near(rx, bx); sby := round(by); end if;
  return abs(round(ax) - sax) + abs(round(ay) - say) + abs(sby - say) + abs(sbx - sax) + abs(round(bx) - sbx) + abs(round(by) - sby);
end $$;

-- km with one decimal, computed with integer maths exactly like the client.
create or replace function public._grid_km(ax numeric, ay numeric, bx numeric, by numeric) returns numeric
language sql immutable as $$ select round(public._grid_len(ax, ay, bx, by) / 4.0) / 10.0 $$;

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
  km10 := round(public._grid_len(a.x, a.y, b.x, b.y) / 4.0);
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

create or replace function public._eligible_classes(p_size text, p_weight numeric) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(c.id order by c.sort), '{}')
  from public.package_sizes s join public.vehicle_classes c on c.id = any(s.eligible)
  where s.id = p_size and c.enabled and c.max_kg >= coalesce(p_weight, 0)
$$;

create or replace function public._recommend(p_size text, p_weight numeric) returns text
language plpgsql stable security definer set search_path = public as $$
declare el text[] := public._eligible_classes(p_size, p_weight); best text; best_sort int;
begin
  if array_length(el, 1) is null then return null; end if;
  select best_class into best from public.package_sizes where id = p_size;
  if best = any(el) then return best; end if;
  select sort into best_sort from public.vehicle_classes where id = best;
  return coalesce((select id from public.vehicle_classes where id = any(el) and sort >= best_sort order by sort limit 1), el[1]);
end $$;

create or replace function public._rider_share(p_total int, p_commission numeric) returns int language sql immutable as $$
  select (round(p_total * (1 - p_commission / 100.0) / 100.0) * 100)::int
$$;

-- Classes a delivery may be carried by: the booked class, or larger eligible classes once widened.
create or replace function public._allowed_classes(d public.deliveries) returns text[]
language sql stable security definer set search_path = public as $$
  select case when d.widened then
    (select coalesce(array_agg(c.id), '{}') from public.vehicle_classes c
      where c.id = any(public._eligible_classes(p.size, p.weight_kg))
        and c.sort >= (select sort from public.vehicle_classes where id = d.vehicle_class))
  else array[d.vehicle_class] end
  from public.packages p where p.id = d.package_id
$$;

-- Can this rider take this delivery (ignoring whether they are online right now)?
create or replace function public._rider_fits(p_delivery uuid, p_rider uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.deliveries d
      join public.riders r on r.id = p_rider
      join public.profiles pr on pr.id = r.profile_id and pr.status = 'active'
      join public.vehicles v on v.rider_id = r.id and v.is_active
    where d.id = p_delivery
      and r.verification_status = 'verified'
      and v.class_id = any(public._allowed_classes(d))
      and not exists (select 1 from public.delivery_offers o where o.delivery_id = d.id and o.rider_id = r.id and o.response in ('declined', 'released'))
  )
$$;

create or replace function public._eligible_online_count(p_delivery uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.riders r
  where r.online and r.active_delivery_id is null and public._rider_fits(p_delivery, r.id)
$$;

/* ------------------------------------------------------------------ events, notifications, audit */

create or replace function public._actor() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p public.profiles; nm text;
begin
  select * into p from public.profiles where id = auth.uid();
  if p.id is null then return jsonb_build_object('role', 'system', 'id', null, 'name', 'Drop Off'); end if;
  if p.role = 'vendor' then
    select v.name into nm from public.vendors v where v.id in (select public.my_vendor_ids()) order by v.created_at limit 1;
    return jsonb_build_object('role', 'vendor', 'id', p.id, 'name', coalesce(nm, p.full_name));
  elsif p.role = 'rider' then
    return jsonb_build_object('role', 'rider', 'id', public.my_rider_id(), 'name', p.full_name);
  elsif p.role = 'ops' then
    return jsonb_build_object('role', 'ops', 'id', p.id, 'name', public._first(p.full_name) || ' (Ops)');
  end if;
  return jsonb_build_object('role', 'recipient', 'id', p.id, 'name', p.full_name);
end $$;

create or replace function public._sys() returns jsonb language sql immutable as $$
  select jsonb_build_object('role', 'system', 'id', null, 'name', 'Drop Off')
$$;

create or replace function public._event(p_delivery uuid, p_type text, p_label text, p_actor jsonb default null,
  p_lat double precision default null, p_lng double precision default null, p_meta jsonb default '{}')
returns void language plpgsql security definer set search_path = public as $$
declare a jsonb := coalesce(p_actor, public._sys());
begin
  insert into public.delivery_events (delivery_id, type, label, actor_role, actor_id, actor_name, lat, lng, meta)
  values (p_delivery, p_type, p_label, coalesce(a->>'role', 'system'), nullif(a->>'id', '')::uuid, coalesce(a->>'name', 'Drop Off'), p_lat, p_lng, coalesce(p_meta, '{}'));
end $$;

create or replace function public._notify(p_audience text, p_vendor uuid, p_rider uuid, p_title text, p_body text,
  p_delivery uuid default null, p_kind text default 'info') returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.notifications (audience, vendor_id, rider_id, title, body, delivery_id, kind)
  values (p_audience, p_vendor, p_rider, p_title, p_body, p_delivery, coalesce(p_kind, 'info'));
end $$;

-- Recipient SMS. No SMS provider is connected yet, so messages are stored with sms_status 'simulated'
-- (see supabase/functions/sms-dispatch for the provider hook).
create or replace function public._sms(p_delivery uuid, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare ph text;
begin
  select r.phone into ph from public.deliveries d join public.recipients r on r.id = d.recipient_id where d.id = p_delivery;
  insert into public.notifications (audience, phone, channel, sms_status, title, body, delivery_id, kind)
  values ('recipient', ph, 'sms', 'simulated', 'DROPOFF', p_body, p_delivery, 'sms');
end $$;

create or replace function public._audit(p_type text, p_target_type text default null, p_target_id text default null,
  p_delivery uuid default null, p_meta jsonb default '{}') returns void
language plpgsql security definer set search_path = public as $$
declare a jsonb := public._actor();
begin
  insert into public.audit_log (event_type, actor_id, actor_role, actor_name, target_type, target_id, delivery_id, metadata)
  values (p_type, auth.uid(), a->>'role', a->>'name', p_target_type, p_target_id, p_delivery, coalesce(p_meta, '{}'));
end $$;

create or replace function public._tracking_link(p_delivery uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(public._setting('tracking_base_url', '"https://dropoff.app/t/"')#>>'{}', 'https://dropoff.app/t/') || s.tracking_token
  from public.delivery_secrets s where s.delivery_id = p_delivery
$$;

/* ------------------------------------------------------------------ ledger */

create or replace function public._wallet_id(p_owner text, p_id uuid, p_kind text default 'main') returns uuid
language plpgsql security definer set search_path = public as $$
declare w uuid;
begin
  if p_owner = 'platform' then
    select id into w from public.wallets where owner_type = 'platform';
    if w is null then insert into public.wallets (owner_type, kind) values ('platform', 'platform') returning id into w; end if;
  elsif p_owner = 'vendor' then
    select id into w from public.wallets where vendor_id = p_id and kind = p_kind;
    if w is null then insert into public.wallets (owner_type, kind, vendor_id) values ('vendor', p_kind, p_id) returning id into w; end if;
  else
    select id into w from public.wallets where rider_id = p_id;
    if w is null then insert into public.wallets (owner_type, kind, rider_id) values ('rider', 'main', p_id) returning id into w; end if;
  end if;
  return w;
end $$;

-- The only place balances change. Inserts a ledger row and moves the balance in the same transaction.
create or replace function public._wallet_post(p_wallet uuid, p_type text, p_amount bigint, p_method text, p_label text,
  p_status text default 'completed', p_delivery uuid default null, p_payment uuid default null, p_pending_delta bigint default 0)
returns uuid language plpgsql security definer set search_path = public as $$
declare bal bigint; txid uuid;
begin
  update public.wallets set balance = balance + p_amount, pending_balance = greatest(0, pending_balance + p_pending_delta), updated_at = now()
  where id = p_wallet returning balance into bal;
  insert into public.wallet_transactions (wallet_id, type, amount, balance_after, method, label, status, delivery_id, payment_id, created_by)
  values (p_wallet, p_type, p_amount, bal, p_method, p_label, p_status, p_delivery, p_payment, auth.uid()) returning id into txid;
  return txid;
end $$;

-- Payment provider seam. Every method is simulated in this MVP; a real MoMo/Airtel/card integration
-- replaces this function (or calls out from an Edge Function and confirms through a webhook).
create or replace function public._provider_charge(p_method text, p_amount int, p_reference text) returns jsonb
language plpgsql volatile as $$
begin
  return jsonb_build_object('ok', true, 'provider', 'simulated', 'provider_ref', 'SIM-' || upper(substr(md5(random()::text || p_reference), 1, 10)));
end $$;

create or replace function public._method_label(p_method text) returns text language sql immutable as $$
  select case p_method when 'wallet' then 'Drop Off Wallet' when 'momo' then 'MTN Mobile Money' when 'airtel' then 'Airtel Money'
    when 'card' then 'Card' when 'credit' then 'Business credit account' else p_method end
$$;

/* ------------------------------------------------------------------ state machine */

create or replace function public._guard_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    if not exists (select 1 from public.delivery_transitions where from_status = old.status and to_status = new.status) then
      raise exception 'This delivery can''t move from % to %.', replace(old.status, '_', ' '), replace(new.status, '_', ' ')
        using errcode = 'P0001';
    end if;
    new.status_at := now();
  end if;
  return new;
end $$;
create trigger deliveries_guard_status before update of status on public.deliveries
  for each row execute function public._guard_status();

create or replace function public._settle_delivered(p_delivery uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  d public.deliveries; pay public.payments; r public.riders; v public.vendors; rp public.recipients; pod public.proof_of_delivery;
  earn int; v_vat int; rc text; earned_before bigint; comm_before bigint;
begin
  select * into d from public.deliveries where id = p_delivery for update;
  select * into pay from public.payments where id = d.payment_id for update;
  select * into r from public.riders where id = d.rider_id for update;
  select * into v from public.vendors where id = d.vendor_id;
  select * into rp from public.recipients where id = d.recipient_id;
  select * into pod from public.proof_of_delivery where delivery_id = d.id;

  -- capture the reserved amount
  perform public._release_hold(d.id, 'paid');
  v_vat := round(pay.amount * 18 / 118.0);
  rc := coalesce(pay.receipt_no, 'RC-' || to_char(now() at time zone 'Africa/Kampala', 'YYYYMMDD') || '-' || lpad(nextval('public.receipt_seq')::text, 4, '0'));
  update public.payments set status = 'successful', captured_at = now(), receipt_no = rc, vat = v_vat where id = pay.id;

  -- earnings already paid on this delivery (a failed first attempt) are deducted from the final split
  select coalesce(sum(t.amount), 0) into earned_before from public.wallet_transactions t join public.wallets w on w.id = t.wallet_id
    where t.delivery_id = d.id and t.type = 'earning' and w.owner_type = 'rider';
  select coalesce(sum(t.amount), 0) into comm_before from public.wallet_transactions t where t.delivery_id = d.id and t.type = 'commission';
  earn := greatest(0, public._rider_share(pay.amount, d.commission_pct) - earned_before);
  perform public._wallet_post(public._wallet_id('rider', r.id), 'earning', earn, 'balance', 'Delivery ' || d.ref, 'completed', d.id, pay.id);
  perform public._wallet_post(public._wallet_id('platform', null), 'commission',
    greatest(0, pay.amount - public._rider_share(pay.amount, d.commission_pct) - comm_before), 'internal', 'Commission · ' || d.ref, 'completed', d.id, pay.id);
  earn := earn + earned_before;
  update public.deliveries set rider_earning = earn where id = d.id;
  update public.riders set trips = trips + 1, status = case when online then 'idle' else 'offline' end, active_delivery_id = null where id = r.id;

  perform public._event(d.id, 'delivered', 'Delivered · PIN ✓ · photo' || case when pod.signature_path is not null then ' · signature' else '' end ||
    case when pod.distance_m is not null then ' · GPS ' || pod.distance_m || ' m from pin' else ' · no GPS fix' end,
    jsonb_build_object('role', 'rider', 'id', r.id, 'name', r.display_name), pod.lat, pod.lng);
  perform public._event(d.id, 'settled', 'Payment captured ' || public._fmt_ugx(pay.amount) || ' · receipt ' || rc || ' · driver earned ' || public._fmt_ugx(earn) ||
    case when pay.simulated then ' · simulated' else '' end);
  perform public._notify('vendor', v.id, null, 'Delivered: ' || d.ref,
    'Received by ' || coalesce(nullif(pod.receiver_name, ''), rp.name) || ' at ' || public._fmt_time(now()) || '. Proof and receipt are ready.', d.id, 'ok');
  perform public._notify('vendor', v.id, null, 'Payment successful',
    public._fmt_ugx(pay.amount) || ' for ' || d.ref || ' · ' || public._method_label(pay.method) || case when pay.simulated then ' (simulated)' else '' end || '.', d.id, 'money');
  perform public._notify('rider', null, r.id, 'You earned ' || public._fmt_ugx(earn), 'Delivery ' || d.ref || ' complete. Added to your balance.', d.id, 'money');
  perform public._notify('ops', null, null, d.ref || ' delivered', 'Proof filed · ' || r.display_name, d.id, 'ok');
  perform public._sms(d.id, 'Delivered: your package from ' || v.name || ' was received at ' || public._fmt_time(now()) || '. Proof of delivery: ' || public._tracking_link(d.id));
  perform public._audit('delivery.completed', 'delivery', d.ref, d.id, jsonb_build_object('amount', pay.amount, 'earning', earn, 'receipt', rc));
end $$;

create or replace function public._refund(p_delivery uuid, p_amount int, p_label text, p_to_main boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare d public.deliveries; pay public.payments; w uuid;
begin
  if p_amount <= 0 then return; end if;
  select * into d from public.deliveries where id = p_delivery;
  select * into pay from public.payments where id = d.payment_id;
  w := public._wallet_id('vendor', d.vendor_id, case when pay.method = 'credit' and not p_to_main then 'credit' else 'main' end);
  perform public._wallet_post(w, 'refund', p_amount,
    case when pay.method = 'credit' and not p_to_main then 'credit' else 'wallet' end, p_label || ' · ' || d.ref, 'completed', d.id, pay.id);
  update public.payments set refunded_amount = refunded_amount + p_amount where id = pay.id;
end $$;

-- Marks every reserved charge on the delivery as paid or refunded and releases it from pending.
create or replace function public._release_hold(p_delivery uuid, p_new_status text) returns void
language plpgsql security definer set search_path = public as $$
declare t record;
begin
  for t in select id, wallet_id, amount from public.wallet_transactions where delivery_id = p_delivery and type = 'charge' and status = 'held' for update loop
    update public.wallet_transactions set status = p_new_status where id = t.id;
    update public.wallets set pending_balance = greatest(0, pending_balance + t.amount), updated_at = now() where id = t.wallet_id;
  end loop;
end $$;

create or replace function public._settle_failed(p_delivery uuid, p_reason text, p_actor jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare d public.deliveries; pay public.payments; r public.riders; half int; earn int; held bigint; prior boolean;
begin
  select * into d from public.deliveries where id = p_delivery;
  select * into pay from public.payments where id = d.payment_id;
  select * into r from public.riders where id = d.rider_id;
  half := round(pay.amount / 2.0 / 500) * 500;
  select coalesce(-sum(amount), 0) into held from public.wallet_transactions where delivery_id = d.id and type = 'charge' and status = 'held';
  prior := exists (select 1 from public.wallet_transactions where delivery_id = d.id and type = 'earning');
  if prior then
    -- a failed reattempt: the vendor already paid 50% for the first attempt, so the new reservation is returned
    perform public._release_hold(d.id, 'refunded');
    perform public._refund(d.id, held::int, 'Reattempt refund');
    update public.payments set status = 'partially_refunded' where id = pay.id;
    if r.id is not null then
      update public.riders set status = case when online then 'idle' else 'offline' end, active_delivery_id = null where id = r.id;
      perform public._notify('rider', null, r.id, 'Marked as failed', d.ref || ' · the second attempt also failed.', d.id, 'warn');
    end if;
  else
  perform public._release_hold(d.id, 'paid');
  perform public._refund(d.id, pay.amount - half, 'Failed attempt refund (50%)');
  update public.payments set status = 'partially_refunded', captured_at = now() where id = pay.id;
  end if;
  if r.id is not null and not prior then
    earn := public._rider_share(half, d.commission_pct);
    perform public._wallet_post(public._wallet_id('rider', r.id), 'earning', earn, 'balance', 'Failed attempt · ' || d.ref, 'completed', d.id, pay.id);
    perform public._wallet_post(public._wallet_id('platform', null), 'commission', half - earn, 'internal', 'Commission · failed attempt ' || d.ref, 'completed', d.id, pay.id);
    update public.riders set status = case when online then 'idle' else 'offline' end, active_delivery_id = null where id = r.id;
    update public.deliveries set rider_earning = earn where id = d.id;
    perform public._notify('rider', null, r.id, 'Marked as failed', d.ref || ' · 50% of the fare paid for your trip.', d.id, 'warn');
  end if;
  update public.deliveries set fail_reason = coalesce(nullif(p_reason, ''), 'Delivery could not be completed'), resolution = null where id = d.id;
  perform public._event(d.id, 'failed', 'Delivery failed · ' || coalesce(nullif(p_reason, ''), 'Delivery could not be completed'), p_actor);
  perform public._notify('vendor', d.vendor_id, null, 'Delivery failed: ' || d.ref, coalesce(nullif(p_reason, ''), 'Delivery could not be completed') || '. Choose: try again or return to you.', d.id, 'bad');
  perform public._notify('ops', null, null, 'Failed delivery ' || d.ref, coalesce(p_reason, ''), d.id, 'bad');
  perform public._audit('delivery.failed', 'delivery', d.ref, d.id, jsonb_build_object('reason', p_reason));
end $$;

create or replace function public._settle_cancelled(p_delivery uuid, p_reason text, p_actor jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare d public.deliveries; pay public.payments; refunded boolean := false; held bigint;
begin
  select * into d from public.deliveries where id = p_delivery;
  select * into pay from public.payments where id = d.payment_id;
  select coalesce(-sum(amount), 0) into held from public.wallet_transactions where delivery_id = d.id and type = 'charge' and status = 'held';
  if held > 0 then
    perform public._release_hold(d.id, 'refunded');
    perform public._refund(d.id, held::int, 'Cancellation refund');
    update public.payments set status = case when refunded_amount >= amount then 'refunded' else 'partially_refunded' end where id = pay.id;
    refunded := true;
  end if;
  if d.rider_id is not null then
    update public.riders set status = case when online then 'idle' else 'offline' end, active_delivery_id = null where id = d.rider_id and active_delivery_id = d.id;
    perform public._notify('rider', null, d.rider_id, 'Job cancelled', d.ref || ' was cancelled. You are free for new requests.', d.id, 'warn');
  end if;
  update public.deliveries set cancel_reason = coalesce(nullif(p_reason, ''), 'Cancelled') where id = d.id;
  perform public._event(d.id, 'cancelled', 'Cancelled · ' || coalesce(nullif(p_reason, ''), 'Cancelled'), p_actor);
  perform public._notify('vendor', d.vendor_id, null, d.ref || ' cancelled',
    case when refunded then 'Refund of ' || public._fmt_ugx(held) || ' issued to your ' || case when pay.method = 'credit' then 'credit account' else 'wallet' end || '.'
      else coalesce(p_reason, 'Cancelled') end, d.id, 'warn');
  perform public._notify('ops', null, null, d.ref || ' cancelled', coalesce(p_reason, ''), d.id);
  perform public._sms(d.id, (select name from public.vendors where id = d.vendor_id) || ' cancelled your Drop Off delivery ' || d.ref || '.');
  perform public._audit('delivery.cancelled', 'delivery', d.ref, d.id, jsonb_build_object('reason', p_reason, 'refunded', refunded));
end $$;

-- Moves a delivery to a new status and runs the side effects every role relies on
-- (timeline event, notifications, recipient SMS, settlement). Invalid moves are rejected by the trigger.
create or replace function public._set_status(p_delivery uuid, p_to text, p_actor jsonb, p_meta jsonb default '{}')
returns void language plpgsql security definer set search_path = public as $$
declare
  d public.deliveries; r public.riders; veh public.vehicles; v public.vendors; rp public.recipients; sec public.delivery_secrets;
  rn text; from_status text; loc public.rider_locations; mins numeric;
begin
  select * into d from public.deliveries where id = p_delivery for update;
  from_status := d.status;
  update public.deliveries set status = p_to where id = p_delivery;
  select * into r from public.riders where id = d.rider_id;
  select * into veh from public.vehicles where id = d.vehicle_id;
  select * into v from public.vendors where id = d.vendor_id;
  select * into rp from public.recipients where id = d.recipient_id;
  select * into sec from public.delivery_secrets where delivery_id = d.id;
  select * into loc from public.rider_locations where rider_id = d.rider_id and updated_at > now() - interval '10 minutes';
  rn := public._first(r.display_name);

  if p_to = 'pending' then
    perform public._event(d.id, 'created', 'Delivery requested · ' || (select label from public.vehicle_classes where id = d.vehicle_class) || ' · ' || public._fmt_ugx(d.price_total), p_actor);
  elsif p_to = 'searching' then
    perform public._event(d.id, 'searching', case when from_status = 'pending' then 'Matching started · visible to eligible drivers'
      else 'Back to matching' || coalesce(' · ' || nullif(p_meta->>'why', ''), '') end, p_actor);
    if from_status <> 'pending' then
      perform public._notify('vendor', v.id, null, 'Finding a new driver', d.ref || ': ' || coalesce(nullif(p_meta->>'why', ''), 'the previous driver is no longer on this job') || '. We are matching again.', d.id, 'warn');
    end if;
  elsif p_to = 'assigned' then
    perform public._event(d.id, 'assigned', case when from_status = 'searching' and p_actor->>'role' = 'rider' then 'Driver accepted · ' else 'Driver assigned · ' end || r.display_name || ' · ' || veh.plate, p_actor);
    perform public._notify('vendor', v.id, null, 'Driver found: ' || rn, veh.make || ' · ' || veh.plate || '. ' || d.ref || ' is on its way to you soon.', d.id, 'ok');
    perform public._notify('rider', null, r.id, 'Job confirmed · ' || d.ref, 'Pickup at ' || d.pickup_name || '. Start the trip when you are ready.', d.id, 'ok');
    perform public._notify('ops', null, null, d.ref || ' assigned', r.display_name || ' · ' || veh.plate || case when p_actor->>'role' = 'ops' then ' (assigned by ops)' else ' accepted' end, d.id);
  elsif p_to = 'en_route_pickup' then
    perform public._event(d.id, 'to_pickup', rn || ' is heading to pickup', p_actor, loc.lat, loc.lng);
    perform public._notify('vendor', v.id, null, rn || ' is on the way to pickup', 'Have the package and pickup PIN ready.', d.id);
  elsif p_to = 'at_pickup' then
    perform public._event(d.id, 'at_pickup', 'Arrived at pickup' || coalesce(' · ' || (p_meta->>'geo'), ''), p_actor, loc.lat, loc.lng);
    perform public._notify('vendor', v.id, null, rn || ' has arrived for ' || d.ref, 'Hand over the package and share pickup PIN ' || sec.pickup_pin || '.', d.id, 'warn');
    perform public._notify('ops', null, null, rn || ' at pickup · ' || d.ref, d.pickup_name, d.id);
  elsif p_to = 'picked_up' then
    perform public._event(d.id, 'picked_up', case when d.handover is not null then 'Package handed over · photo' else 'Package picked up · PIN ✓ · photo' end, p_actor, loc.lat, loc.lng);
    perform public._notify('vendor', v.id, null, 'Package picked up', d.ref || ' was collected by ' || rn || ' at ' || public._fmt_time(now()) || '.', d.id, 'ok');
    perform public._notify('ops', null, null, d.ref || ' picked up', r.display_name, d.id);
    perform public._sms(d.id, v.name || ': your delivery has been picked up by ' || rn || ' (' || veh.plate || '). Track it live: ' ||
      public._tracking_link(d.id) || ' · PIN ' || sec.delivery_pin || '. Only share your PIN once you have the package.');
  elsif p_to = 'in_transit' then
    mins := public._grid_len(d.pickup_x, d.pickup_y, d.dropoff_x, d.dropoff_y) * 0.025 /
      (select speed_kmh from public.vehicle_classes where id = coalesce(veh.class_id, d.vehicle_class)) * 60;
    perform public._event(d.id, 'in_transit', case when from_status = 'failed' then 'Delivery reattempt started' else 'On the way to the recipient' end, p_actor, loc.lat, loc.lng);
    perform public._notify('vendor', v.id, null, d.ref || ' is on the way', 'Estimated arrival around ' || public._fmt_time(now() + make_interval(mins => ceil(mins)::int)) || ' at ' || d.dropoff_name || '.', d.id);
    perform public._notify('ops', null, null, d.ref || ' in transit', r.display_name || ' → ' || d.dropoff_area, d.id);
    perform public._sms(d.id, rn || ' is on the way with your ' || v.name || ' delivery. Estimated arrival around ' ||
      public._fmt_time(now() + make_interval(mins => ceil(mins)::int)) || '. Track: ' || public._tracking_link(d.id));
  elsif p_to = 'approaching' then
    perform public._event(d.id, 'approaching', 'Approaching destination' || coalesce(' · ' || (p_meta->>'how'), ''), p_actor, loc.lat, loc.lng);
    perform public._notify('vendor', v.id, null, d.ref || ' is almost there', rn || ' is a few minutes from ' || rp.name || '.', d.id);
    perform public._sms(d.id, rn || ' is a few minutes away with your ' || v.name || ' delivery. Have your PIN ready.');
  elsif p_to = 'arrived' then
    perform public._event(d.id, 'arrived', 'Driver arrived at drop-off' || coalesce(' · ' || (p_meta->>'geo'), ''), p_actor, loc.lat, loc.lng);
    perform public._notify('vendor', v.id, null, rn || ' arrived at the drop-off', d.ref || ' · waiting for ' || rp.name || '.', d.id);
    perform public._sms(d.id, rn || ' has arrived with your delivery from ' || v.name || '. Check the package, then share your PIN.');
  elsif p_to = 'awaiting_confirmation' then
    perform public._event(d.id, 'handoff', 'Handover started · waiting for the recipient PIN', p_actor);
  elsif p_to = 'delivered' then
    -- disputed → delivered closes a dispute; the money was settled when it was first delivered
    if from_status <> 'disputed' then perform public._settle_delivered(d.id); end if;
  elsif p_to = 'failed' then
    perform public._settle_failed(d.id, p_meta->>'reason', p_actor);
  elsif p_to = 'cancelled' then
    perform public._settle_cancelled(d.id, p_meta->>'reason', p_actor);
  elsif p_to = 'disputed' then
    update public.payments set status = 'disputed' where id = d.payment_id;
    perform public._event(d.id, 'disputed', 'Dispute opened · ' || coalesce(p_meta->>'reason', 'problem reported'), p_actor);
    perform public._notify('ops', null, null, 'Dispute on ' || d.ref, coalesce(p_meta->>'reason', 'Problem reported'), d.id, 'bad');
    perform public._notify('vendor', v.id, null, 'Dispute opened on ' || d.ref, 'Ops will review the proof of delivery within 24 hours.', d.id, 'warn');
  end if;
end $$;

-- Completes the delivery once the PIN is confirmed and the required proof is captured.
create or replace function public._try_complete(p_delivery uuid, p_actor jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare d public.deliveries; pod public.proof_of_delivery;
begin
  select * into d from public.deliveries where id = p_delivery for update;
  select * into pod from public.proof_of_delivery where delivery_id = p_delivery;
  if d.status <> 'awaiting_confirmation' or not pod.pin_confirmed or pod.photo_path is null
     or (d.sig_required and pod.signature_path is null) then
    return false;
  end if;
  update public.proof_of_delivery set delivered_at = now(),
    receiver_name = case when received_by = 'recipient' then (select name from public.recipients where id = d.recipient_id) else receiver_name end
  where id = pod.id;
  perform public._set_status(p_delivery, 'delivered', p_actor);
  return true;
end $$;
