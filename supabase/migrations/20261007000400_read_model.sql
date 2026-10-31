-- Drop Off · read model.
-- app_state() is SECURITY INVOKER: every sub-select runs under the caller's RLS policies, so a vendor
-- only receives its own business, a rider only their jobs (plus open jobs their vehicle can carry),
-- and ops receive the network. The apps load this once, then refresh it when realtime reports a change.

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
      'vendorId', vid, 'riderId', rid),
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
            'receiptNo', pay.receipt_no, 'vat', pay.vat, 'capturedAt', pay.captured_at, 'simulated', pay.simulated, 'provider', pay.provider, 'providerRef', pay.provider_ref)
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
      where d.status <> 'draft'
      order by (d.status in ('searching', 'assigned', 'en_route_pickup', 'at_pickup', 'picked_up', 'in_transit', 'approaching', 'arrived', 'awaiting_confirmation')) desc, d.created_at desc
      limit lim) x),

    'transactions', (select coalesce(jsonb_agg(x.j order by x.created_at desc), '[]') from (
      select t.created_at, jsonb_build_object('id', t.id, 'ref', t.ref, 'ts', t.created_at, 'party', w.owner_type, 'partyId', coalesce(w.vendor_id, w.rider_id),
        'wallet', w.kind, 'type', t.type, 'amount', t.amount, 'balanceAfter', t.balance_after, 'method', t.method, 'label', t.label,
        'deliveryId', t.delivery_id, 'status', t.status, 'simulated', t.simulated) j
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
        'reviewedAt', vr.reviewed_at, 'createdAt', vr.created_at, 'updatedAt', vr.updated_at,
        'name', coalesce((select name from public.vendors where id = vr.vendor_id), (select display_name from public.riders where id = vr.rider_id)),
        'documents', (select coalesce(jsonb_agg(jsonb_build_object('id', doc.id, 'kind', doc.kind, 'path', doc.storage_path, 'bucket', doc.bucket,
            'fileName', doc.file_name, 'mime', doc.mime_type, 'size', doc.size_bytes, 'status', doc.status, 'createdAt', doc.created_at) order by doc.created_at), '[]')
          from public.documents doc where doc.verification_request_id = vr.id)
      ) order by vr.updated_at desc), '[]') from public.verification_requests vr),

    'audit', case when ops then (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'type', a.event_type, 'actor', a.actor_name, 'role', a.actor_role,
        'target', a.target_type, 'targetId', a.target_id, 'deliveryId', a.delivery_id, 'meta', a.metadata, 'ts', a.created_at) order by a.id desc), '[]')
      from (select * from public.audit_log order by id desc limit 200) a) else '[]'::jsonb end
  );
end $$;

-- Deliveries a signed-in recipient has opened before (so they can find them again).
create or replace function public.recipient_my_deliveries() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me public.profiles := public._me();
begin
  return (select coalesce(jsonb_agg(jsonb_build_object('ref', d.ref, 'token', s.tracking_token, 'status', d.status, 'createdAt', d.created_at,
      'vendor', v.name, 'initials', v.initials, 'desc', p.description, 'cls', d.vehicle_class) order by d.created_at desc), '[]')
    from public.recipient_links l join public.deliveries d on d.id = l.delivery_id join public.delivery_secrets s on s.delivery_id = d.id
      join public.vendors v on v.id = d.vendor_id join public.packages p on p.id = d.package_id
    where l.profile_id = me.id);
end $$;
