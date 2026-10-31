-- Drop Off · security: grants, Row Level Security, storage buckets and policies, realtime.
-- Model: clients may only SELECT what RLS allows; every write goes through SECURITY DEFINER functions
-- that check the caller's role from public.profiles. Nothing here trusts a role sent by the client.

/* ------------------------------------------------------------------ helper predicates used by policies */

create or replace function public.can_see_delivery(p_delivery uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.deliveries d where d.id = p_delivery and (
    public.is_ops() or public.is_vendor_member(d.vendor_id) or d.rider_id = public.my_rider_id()
    or (d.status = 'searching' and public._rider_fits(d.id, public.my_rider_id()))))
$$;

-- Details beyond the job card (recipient, chat, proof) are only for the vendor, the assigned rider and ops.
create or replace function public.can_see_delivery_details(p_delivery uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.deliveries d where d.id = p_delivery and (
    public.is_ops() or public.is_vendor_member(d.vendor_id) or d.rider_id = public.my_rider_id()))
$$;

create or replace function public.vendor_sees_rider(p_rider uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.deliveries d where d.rider_id = p_rider and d.vendor_id in (select public.my_vendor_ids()))
$$;

create or replace function public.vendor_sees_rider_location(p_rider uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.deliveries d where d.rider_id = p_rider and d.vendor_id in (select public.my_vendor_ids())
    and d.status in ('assigned', 'en_route_pickup', 'at_pickup', 'picked_up', 'in_transit', 'approaching', 'arrived', 'awaiting_confirmation'))
$$;

create or replace function public.rider_sees_vendor(p_vendor uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.deliveries d where d.vendor_id = p_vendor and public.can_see_delivery(d.id) and public.my_rider_id() is not null)
$$;

create or replace function public.rider_sees_package(p_package uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.deliveries d where d.package_id = p_package and public.my_rider_id() is not null and public.can_see_delivery(d.id))
$$;

create or replace function public.rider_sees_recipient(p_recipient uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.deliveries d where d.recipient_id = p_recipient and d.rider_id = public.my_rider_id())
$$;

create or replace function public.can_see_wallet(p_wallet uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.wallets w where w.id = p_wallet and (
    public.is_ops() or (w.vendor_id is not null and public.is_vendor_member(w.vendor_id)) or (w.rider_id is not null and w.rider_id = public.my_rider_id())))
$$;

-- storage helpers: object names start with a folder that identifies the owner
create or replace function public._folder_uuid(p_name text) returns uuid language plpgsql immutable as $$
begin return split_part(p_name, '/', 1)::uuid; exception when others then return null; end $$;

create or replace function public.storage_can_write_proof(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.deliveries d where d.id = public._folder_uuid(p_name) and d.rider_id = public.my_rider_id()
    and d.status in ('at_pickup', 'arrived', 'awaiting_confirmation'))
$$;

create or replace function public.storage_can_read_package_photo(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_ops() or public.is_vendor_member(public._folder_uuid(p_name)) or exists (
    select 1 from public.packages p join public.deliveries d on d.package_id = p.id
    where p.photo_path = p_name and public.my_rider_id() is not null and public.can_see_delivery(d.id))
$$;

/* ------------------------------------------------------------------ privileges */

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public;

-- reference data is public (the website estimator reads pricing without signing in)
grant select on public.service_areas, public.places, public.vehicle_classes, public.package_sizes, public.pricing_rules,
  public.delivery_transitions to anon, authenticated;
grant select on public.app_settings to authenticated;

grant select on public.profiles, public.vendors, public.vendor_staff, public.vendor_locations, public.riders, public.vehicles,
  public.rider_locations, public.recipients, public.packages, public.deliveries, public.delivery_offers, public.delivery_events,
  public.delivery_messages, public.proof_of_delivery, public.recipient_links, public.payments, public.wallets, public.wallet_transactions,
  public.notifications, public.support_tickets, public.disputes, public.verification_requests, public.documents, public.audit_log,
  public.drivers to authenticated;
-- PINs: vendors may read the pickup PIN and tracking token of their own deliveries; the delivery PIN is never selectable.
grant select (delivery_id, pickup_pin, tracking_token, pin_attempts) on public.delivery_secrets to authenticated;

-- functions: anonymous (website + recipient tracking link)
grant execute on function public.plate_available(text), public.recipient_view(text, text), public.recipient_lookup(text, text),
  public.recipient_confirm(text, text, text), public.recipient_send_message(text, text, text), public.recipient_call(text, text),
  public.recipient_open_ticket(text, text, text, text), public.recipient_resend_pin(text, text), public.recipient_rate(text, text, int)
  to anon, authenticated;

-- functions: signed-in users (each checks the caller's role itself)
grant execute on function
  public.app_state(), public.recipient_my_deliveries(),
  public.my_role(), public.is_ops(), public.my_vendor_ids(), public.is_vendor_member(uuid), public.my_rider_id(),
  public._rider_fits(uuid, uuid), public._eligible_online_count(uuid), public._folder_uuid(text),
  public.can_see_delivery(uuid), public.can_see_delivery_details(uuid), public.vendor_sees_rider(uuid), public.vendor_sees_rider_location(uuid),
  public.rider_sees_vendor(uuid), public.rider_sees_package(uuid), public.rider_sees_recipient(uuid), public.can_see_wallet(uuid),
  public.storage_can_write_proof(text), public.storage_can_read_package_photo(text),
  public.update_my_profile(jsonb), public.register_document(text, text, text, text, int), public.submit_verification(),
  public.update_vehicle(jsonb), public.mark_notifications_read(),
  public.create_delivery(jsonb), public.vendor_cancel(uuid, text), public.widen_search(uuid), public.resolve_failed(uuid, text),
  public.wallet_topup(int, text), public.pay_credit_invoice(), public.set_default_method(text),
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
  public.ops_set_setting(text, jsonb), public.ops_set_credit(uuid, int), public.ops_resend_pin(uuid)
  to authenticated;

-- the recipient-proof Edge Function signs storage URLs with the service role
grant execute on function public.recipient_proof_paths(text, text) to service_role;

/* ------------------------------------------------------------------ row level security */

do $$ declare t text; begin
  foreach t in array array['service_areas', 'places', 'vehicle_classes', 'package_sizes', 'pricing_rules', 'app_settings', 'delivery_transitions',
    'profiles', 'vendors', 'vendor_staff', 'vendor_locations', 'riders', 'vehicles', 'rider_locations', 'recipients', 'packages', 'deliveries',
    'delivery_secrets', 'delivery_offers', 'delivery_events', 'delivery_messages', 'proof_of_delivery', 'recipient_links', 'payments', 'wallets',
    'wallet_transactions', 'notifications', 'support_tickets', 'disputes', 'verification_requests', 'documents', 'audit_log'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

create policy ref_read on public.service_areas for select using (true);
create policy ref_read on public.places for select using (true);
create policy ref_read on public.vehicle_classes for select using (true);
create policy ref_read on public.package_sizes for select using (true);
create policy ref_read on public.pricing_rules for select using (true);
create policy ref_read on public.delivery_transitions for select using (true);
create policy settings_read on public.app_settings for select to authenticated using (true);

create policy profiles_read on public.profiles for select to authenticated using (id = auth.uid() or public.is_ops());

create policy vendors_read on public.vendors for select to authenticated
  using (public.is_vendor_member(id) or public.is_ops() or public.rider_sees_vendor(id));
create policy vendor_staff_read on public.vendor_staff for select to authenticated using (public.is_vendor_member(vendor_id) or public.is_ops());
create policy vendor_locations_read on public.vendor_locations for select to authenticated using (public.is_vendor_member(vendor_id) or public.is_ops());

create policy riders_read on public.riders for select to authenticated
  using (profile_id = auth.uid() or public.is_ops() or public.vendor_sees_rider(id));
create policy vehicles_read on public.vehicles for select to authenticated
  using (rider_id = public.my_rider_id() or public.is_ops() or public.vendor_sees_rider(rider_id));
create policy rider_locations_read on public.rider_locations for select to authenticated
  using (rider_id = public.my_rider_id() or public.is_ops() or public.vendor_sees_rider_location(rider_id));

create policy recipients_read on public.recipients for select to authenticated
  using (public.is_vendor_member(vendor_id) or public.is_ops() or public.rider_sees_recipient(id));
create policy packages_read on public.packages for select to authenticated
  using (public.is_vendor_member(vendor_id) or public.is_ops() or public.rider_sees_package(id));

create policy deliveries_read on public.deliveries for select to authenticated
  using (public.is_vendor_member(vendor_id) or public.is_ops() or rider_id = public.my_rider_id()
    or (status = 'searching' and public._rider_fits(id, public.my_rider_id())));
create policy delivery_secrets_read on public.delivery_secrets for select to authenticated
  using (public.is_ops() or exists (select 1 from public.deliveries d where d.id = delivery_id and public.is_vendor_member(d.vendor_id)));
create policy delivery_offers_read on public.delivery_offers for select to authenticated using (rider_id = public.my_rider_id() or public.is_ops());
create policy delivery_events_read on public.delivery_events for select to authenticated using (public.can_see_delivery(delivery_id));
create policy delivery_messages_read on public.delivery_messages for select to authenticated using (public.can_see_delivery_details(delivery_id));
create policy proof_read on public.proof_of_delivery for select to authenticated using (public.can_see_delivery_details(delivery_id));
create policy recipient_links_read on public.recipient_links for select to authenticated using (profile_id = auth.uid());

create policy payments_read on public.payments for select to authenticated
  using (public.is_ops() or (vendor_id is not null and public.is_vendor_member(vendor_id)) or (rider_id is not null and rider_id = public.my_rider_id()));
create policy wallets_read on public.wallets for select to authenticated using (public.can_see_wallet(id));
create policy wallet_tx_read on public.wallet_transactions for select to authenticated using (public.can_see_wallet(wallet_id));

create policy notifications_read on public.notifications for select to authenticated
  using ((channel = 'in_app' and vendor_id is not null and public.is_vendor_member(vendor_id))
    or (rider_id is not null and rider_id = public.my_rider_id())
    or (public.is_ops() and audience in ('ops', 'recipient'))
    or profile_id = auth.uid());

create policy tickets_read on public.support_tickets for select to authenticated
  using (opened_by = auth.uid() or public.is_ops() or (vendor_id is not null and public.is_vendor_member(vendor_id))
    or (rider_id is not null and rider_id = public.my_rider_id()));
create policy disputes_read on public.disputes for select to authenticated
  using (public.is_ops() or exists (select 1 from public.deliveries d where d.id = delivery_id and public.is_vendor_member(d.vendor_id)));

create policy verification_read on public.verification_requests for select to authenticated
  using (profile_id = auth.uid() or public.is_ops() or (vendor_id is not null and public.is_vendor_member(vendor_id)));
create policy documents_read on public.documents for select to authenticated using (owner_id = auth.uid() or public.is_ops());
create policy audit_read on public.audit_log for select to authenticated using (public.is_ops());

/* ------------------------------------------------------------------ storage (all buckets private; reads use signed URLs) */

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('avatars', 'avatars', false, 5242880, array['image/jpeg', 'image/png', 'image/webp']),
  ('documents', 'documents', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  ('proofs', 'proofs', false, 5242880, array['image/jpeg', 'image/png', 'image/webp']),
  ('package-photos', 'package-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy avatars_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy avatars_read on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_ops()));

create policy documents_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);
create policy documents_read on storage.objects for select to authenticated
  using (bucket_id = 'documents' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_ops()));

create policy proofs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'proofs' and public.storage_can_write_proof(name));
create policy proofs_read on storage.objects for select to authenticated
  using (bucket_id = 'proofs' and public.can_see_delivery_details(public._folder_uuid(name)));

create policy package_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'package-photos' and public.is_vendor_member(public._folder_uuid(name)));
create policy package_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'package-photos' and public.storage_can_read_package_photo(name));

/* ------------------------------------------------------------------ realtime */

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.deliveries, public.delivery_events, public.delivery_messages, public.notifications,
      public.rider_locations, public.riders, public.wallet_transactions, public.support_tickets, public.verification_requests,
      public.proof_of_delivery, public.vendors, public.pricing_rules, public.vehicle_classes, public.service_areas;
  end if;
end $$;
