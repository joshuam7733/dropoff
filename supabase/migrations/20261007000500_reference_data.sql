-- Drop Off · reference data needed in every environment (production included):
-- the delivery state machine, vehicle classes, package sizes, pricing, service areas, places and settings.
-- Demo accounts and demo deliveries are NOT here; they live in supabase/seed.sql (development only).

insert into public.delivery_transitions (from_status, to_status) values
  ('draft', 'pending'), ('draft', 'cancelled'),
  ('pending', 'searching'), ('pending', 'cancelled'),
  ('searching', 'assigned'), ('searching', 'cancelled'),
  ('assigned', 'en_route_pickup'), ('assigned', 'searching'), ('assigned', 'cancelled'),
  ('en_route_pickup', 'at_pickup'), ('en_route_pickup', 'searching'), ('en_route_pickup', 'cancelled'), ('en_route_pickup', 'assigned'),
  ('at_pickup', 'picked_up'), ('at_pickup', 'searching'), ('at_pickup', 'cancelled'), ('at_pickup', 'assigned'),
  ('picked_up', 'in_transit'), ('picked_up', 'assigned'), ('picked_up', 'failed'),
  ('in_transit', 'approaching'), ('in_transit', 'arrived'), ('in_transit', 'assigned'), ('in_transit', 'failed'),
  ('approaching', 'arrived'), ('approaching', 'assigned'), ('approaching', 'failed'),
  ('arrived', 'awaiting_confirmation'), ('arrived', 'failed'),
  ('awaiting_confirmation', 'delivered'), ('awaiting_confirmation', 'failed'),
  ('delivered', 'disputed'),
  ('failed', 'in_transit'), ('failed', 'cancelled'),
  ('disputed', 'delivered')
on conflict do nothing;

insert into public.vehicle_classes (id, label, long_label, max_kg, speed_kmh, enabled, sort) values
  ('boda', 'Boda', 'Motorcycle', 15, 30, true, 1),
  ('car', 'Car', 'Car', 60, 32, true, 2),
  ('minivan', 'Minivan', 'Minivan', 400, 30, true, 3),
  ('pickup', 'Pickup', 'Pickup', 1000, 28, true, 4),
  ('truck', 'Truck', 'Truck', 5000, 24, true, 5)
on conflict (id) do nothing;

insert into public.package_sizes (id, label, hint, max_kg, best_class, eligible, sort) values
  ('small', 'Small', 'Fits a delivery box · up to 15 kg', 15, 'boda', array['boda', 'car'], 1),
  ('medium', 'Medium', 'Fits a car boot · up to 60 kg', 60, 'car', array['car', 'minivan', 'pickup'], 2),
  ('large', 'Large', 'Several boxes or catering · up to 400 kg', 400, 'minivan', array['car', 'minivan', 'pickup'], 3),
  ('bulky', 'Bulky', 'Furniture & appliances · up to 1 t', 1000, 'pickup', array['pickup', 'truck'], 4),
  ('freight', 'Freight', 'Commercial stock · up to 5 t', 5000, 'truck', array['truck'], 5)
on conflict (id) do nothing;

insert into public.pricing_rules (class_id, base, per_km, min_fare, fragile, express, commission_pct) values
  ('boda', 2000, 650, 4000, 1000, 1000, 15),
  ('car', 8000, 1125, 12000, 4000, 3000, 15),
  ('minivan', 14000, 1600, 22000, 6000, 3000, 12),
  ('pickup', 30000, 2500, 45000, 10000, 3000, 12),
  ('truck', 90000, 4500, 150000, 20000, 3000, 10)
on conflict (class_id) do nothing;

insert into public.service_areas (id, name, enabled, note, sort) values
  ('central', 'Kampala Central', true, 'All vehicle classes', 1),
  ('suburbs', 'Kampala suburbs', true, 'All vehicle classes', 2),
  ('entebbe', 'Entebbe Rd corridor', true, 'Car and up', 3),
  ('mukono', 'Mukono', false, 'Pilot · not yet live', 4)
on conflict (id) do nothing;

-- x/y place each address on the stylised city map (1 unit = 25 m); lat/lng are derived from the same
-- grid (lng = 32.4702 + x·0.0002247, lat = 0.4196 − y·0.0002248) so GPS distances agree with map distances.
insert into public.places (id, name, area, zone_id, x, y, lat, lng)
select id, name, area, zone, x, y, round((0.4196 - y * 0.0002248)::numeric, 6), round((32.4702 + x * 0.0002247)::numeric, 6) from (values
  ('kisementi', 'Mama Rose Cakes, Kisementi', 'Kololo', 'central', 340, 190),
  ('ntinda_kitchen', 'Mama Rose Cakes, Ntinda kitchen', 'Ntinda', 'suburbs', 760, 190),
  ('kololo_pharm', 'Kololo Pharmacy, Acacia Ave', 'Kololo', 'central', 200, 190),
  ('homestyle', 'HomeStyle Furniture, Industrial Area', 'Industrial Area', 'central', 480, 310),
  ('freshmart', 'FreshMart, Bugolobi', 'Bugolobi', 'central', 620, 430),
  ('speke', 'Speke Resort, Munyonyo', 'Munyonyo', 'suburbs', 620, 550),
  ('kigowa', 'Kigowa Rd, Ntinda', 'Ntinda', 'suburbs', 900, 190),
  ('bukoto', 'Bukoto Street', 'Bukoto', 'central', 480, 70),
  ('kabalagala', 'Kabalagala, Ggaba Rd', 'Kabalagala', 'suburbs', 480, 550),
  ('naguru', 'Naguru Hill', 'Naguru', 'central', 620, 70),
  ('kira', 'Kira Town', 'Kira', 'suburbs', 900, 70),
  ('nakasero', 'Nakasero Market', 'Nakasero', 'central', 200, 310),
  ('wandegeya', 'Wandegeya', 'Wandegeya', 'central', 200, 70),
  ('kyanja', 'Kyanja', 'Kyanja', 'suburbs', 760, 70),
  ('muyenga', 'Muyenga Hill', 'Muyenga', 'suburbs', 340, 550),
  ('acacia', 'Acacia Mall', 'Kisementi', 'central', 340, 70),
  ('nateete', 'Nateete', 'Nateete', 'suburbs', 60, 430),
  ('kajjansi', 'Kajjansi, Entebbe Rd', 'Kajjansi', 'entebbe', 60, 550),
  ('mukono', 'Mukono Town', 'Mukono', 'mukono', 900, 430),
  ('nakawa', 'Nakawa stores', 'Nakawa', 'central', 760, 430),
  ('kansanga', 'Kansanga, Ggaba Rd', 'Kansanga', 'suburbs', 480, 490),
  ('lugogo', 'Lugogo Mall', 'Lugogo', 'central', 620, 190),
  ('wandegeya_mkt', 'Wandegeya Market', 'Wandegeya', 'central', 200, 130),
  ('mengo', 'Mengo Hill', 'Mengo', 'central', 60, 310)
) as t(id, name, area, zone, x, y)
on conflict (id) do nothing;

insert into public.app_settings (key, value, note) values
  ('enforce_geofence', 'false', 'Block "arrived" when the rider''s GPS fix is further than geofence_m from the address'),
  ('geofence_m', '300', 'Arrival radius in metres'),
  ('approach_radius_m', '800', 'GPS distance at which a delivery switches to "approaching"'),
  ('unreachable_wait_min', '10', 'Minutes a rider waits for an unreachable recipient before marking failed'),
  ('tracking_base_url', '"https://dropoff.app/t/"', 'Prefix for recipient tracking links sent by SMS')
on conflict (key) do nothing;

select public._wallet_id('platform', null);
