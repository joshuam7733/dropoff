-- Drop Off · core schema
-- Users live in auth.users (Supabase Auth). Everything else is in public, keyed by UUIDs.
-- Clients never write tables directly: all writes go through the SECURITY DEFINER functions in
-- 20261007000300_api.sql, and reads are limited by the RLS policies in 20261007000400_security.sql.

create extension if not exists pgcrypto with schema extensions;

/* ------------------------------------------------------------------ reference data */

create table public.service_areas (
  id          text primary key,
  name        text not null,
  enabled     boolean not null default true,
  note        text not null default '',
  sort        int not null default 0,
  updated_at  timestamptz not null default now()
);

create table public.places (
  id          text primary key,
  name        text not null,
  area        text not null,
  zone_id     text not null references public.service_areas(id),
  x           numeric not null,           -- position on the stylised city map (1 unit = 25 m)
  y           numeric not null,
  lat         double precision not null,  -- WGS84, used for GPS distance checks
  lng         double precision not null,
  is_active   boolean not null default true
);
create index places_zone_idx on public.places(zone_id);

create table public.vehicle_classes (
  id          text primary key,           -- boda | car | minivan | pickup | truck
  label       text not null,
  long_label  text not null,
  max_kg      numeric not null check (max_kg > 0),
  speed_kmh   numeric not null default 30,
  enabled     boolean not null default true,
  sort        int not null
);

create table public.package_sizes (
  id          text primary key,           -- small | medium | large | bulky | freight
  label       text not null,
  hint        text not null,
  max_kg      numeric not null,
  best_class  text not null references public.vehicle_classes(id),
  eligible    text[] not null,
  sort        int not null
);

create table public.pricing_rules (
  class_id        text primary key references public.vehicle_classes(id),
  base            int not null check (base >= 0),
  per_km          int not null check (per_km >= 0),
  min_fare        int not null check (min_fare >= 0),
  fragile         int not null check (fragile >= 0),
  express         int not null check (express >= 0),
  commission_pct  numeric not null check (commission_pct between 0 and 40),
  updated_by      uuid,
  updated_at      timestamptz not null default now()
);

-- Operational switches ops can change (geofence enforcement, wait times…).
create table public.app_settings (
  key         text primary key,
  value       jsonb not null,
  note        text not null default '',
  updated_at  timestamptz not null default now()
);

/* ------------------------------------------------------------------ people */

create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  role          text not null check (role in ('vendor', 'rider', 'recipient', 'ops')),
  full_name     text not null default '',
  phone         text,
  email         text,
  avatar_path   text,
  status        text not null default 'active' check (status in ('active', 'suspended')),
  status_reason text,
  is_demo       boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index profiles_role_idx on public.profiles(role);

create table public.vendors (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.profiles(id),
  name               text not null check (length(trim(name)) >= 2),
  initials           text not null,
  category           text not null,
  contact_name       text not null,
  phone              text not null,
  email              text,
  address            text,
  registration_no    text,
  tin                text,
  verification_status text not null default 'pending'
    check (verification_status in ('pending', 'submitted', 'under_review', 'verified', 'rejected', 'suspended')),
  default_method     text not null default 'wallet',
  payment_methods    jsonb not null default '[]',
  credit_eligible    boolean not null default false,
  credit_limit       int not null default 0 check (credit_limit >= 0),
  credit_due_day     int not null default 28,
  is_demo            boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index vendors_owner_idx on public.vendors(owner_id);

create table public.vendor_staff (
  vendor_id   uuid not null references public.vendors(id) on delete cascade,
  profile_id  uuid references public.profiles(id) on delete cascade,
  name        text not null,
  role        text not null default 'owner' check (role in ('owner', 'dispatcher', 'finance')),
  created_at  timestamptz not null default now(),
  id          uuid primary key default gen_random_uuid()
);
create index vendor_staff_profile_idx on public.vendor_staff(profile_id);
create unique index vendor_staff_unique on public.vendor_staff(vendor_id, profile_id) where profile_id is not null;

create table public.vendor_locations (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references public.vendors(id) on delete cascade,
  place_id    text not null references public.places(id),
  label       text not null,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (vendor_id, place_id)
);

-- One row per courier. "Riders" (boda) and "drivers" (car and up) share this table; the
-- public.drivers view below exposes the same rows by vehicle kind.
create table public.riders (
  id                  uuid primary key default gen_random_uuid(),
  profile_id          uuid not null unique references public.profiles(id) on delete cascade,
  display_name        text not null,
  initials            text not null,
  rating              numeric not null default 5.0,
  trips               int not null default 0,
  acceptance          int not null default 100,
  online              boolean not null default false,
  status              text not null default 'offline' check (status in ('offline', 'idle', 'on_job')),
  verification_status text not null default 'pending'
    check (verification_status in ('pending', 'submitted', 'under_review', 'verified', 'rejected', 'suspended')),
  license_no          text,
  active_delivery_id  uuid,
  is_demo             boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table public.vehicles (
  id                  uuid primary key default gen_random_uuid(),
  rider_id            uuid not null references public.riders(id) on delete cascade,
  class_id            text not null references public.vehicle_classes(id),
  make                text not null,
  color               text not null default '',
  plate               text not null,
  registration_no     text,
  has_box             boolean not null default false,
  verification_status text not null default 'pending'
    check (verification_status in ('pending', 'submitted', 'under_review', 'verified', 'rejected', 'suspended')),
  is_active           boolean not null default true,
  created_at          timestamptz not null default now()
);
create unique index vehicles_plate_unique on public.vehicles(upper(replace(plate, ' ', '')));
create index vehicles_rider_idx on public.vehicles(rider_id);

-- Latest known position per rider, written only from the rider's device (browser/OS geolocation).
create table public.rider_locations (
  rider_id     uuid primary key references public.riders(id) on delete cascade,
  lat          double precision not null,
  lng          double precision not null,
  accuracy_m   numeric,
  heading      numeric,
  speed_mps    numeric,
  source       text not null default 'gps' check (source in ('gps', 'network')),
  delivery_id  uuid,
  updated_at   timestamptz not null default now()
);

create view public.drivers with (security_invoker = true) as
  select r.id, r.display_name, v.class_id, case when v.class_id = 'boda' then 'rider' else 'driver' end as kind,
         v.make, v.plate, r.online, r.status, r.verification_status
  from public.riders r left join public.vehicles v on v.rider_id = r.id and v.is_active;

create table public.recipients (
  id               uuid primary key default gen_random_uuid(),
  vendor_id        uuid not null references public.vendors(id) on delete cascade,
  name             text not null,
  phone            text not null,
  default_place_id text references public.places(id),
  notes            text not null default '',
  created_at       timestamptz not null default now(),
  unique (vendor_id, phone)
);

/* ------------------------------------------------------------------ deliveries */

create sequence public.delivery_ref_seq start 48300;
create sequence public.ticket_ref_seq start 2300;
create sequence public.tx_ref_seq start 6000;
create sequence public.receipt_seq start 200;

create table public.packages (
  id              uuid primary key default gen_random_uuid(),
  vendor_id       uuid not null references public.vendors(id),
  type            text not null,
  description     text not null check (length(trim(description)) >= 3),
  size            text not null references public.package_sizes(id),
  weight_kg       numeric not null check (weight_kg > 0 and weight_kg <= 5000),
  declared_value  int not null default 0 check (declared_value >= 0),
  fragile         boolean not null default false,
  upright         boolean not null default false,
  photo_path      text,
  created_at      timestamptz not null default now()
);

create table public.delivery_transitions (
  from_status text not null,
  to_status   text not null,
  primary key (from_status, to_status)
);

create table public.deliveries (
  id                 uuid primary key default gen_random_uuid(),
  ref                text not null unique default ('DO-' || nextval('public.delivery_ref_seq')),
  vendor_id          uuid not null references public.vendors(id),
  created_by         uuid references public.profiles(id),
  recipient_id       uuid not null references public.recipients(id),
  package_id         uuid not null references public.packages(id),
  rider_id           uuid references public.riders(id),
  vehicle_id         uuid references public.vehicles(id),
  payment_id         uuid,
  proof_id           uuid,
  status             text not null default 'draft' check (status in ('draft', 'pending', 'searching', 'assigned',
                       'en_route_pickup', 'at_pickup', 'picked_up', 'in_transit', 'approaching', 'arrived',
                       'awaiting_confirmation', 'delivered', 'failed', 'cancelled', 'disputed')),
  status_at          timestamptz not null default now(),
  -- pickup / drop-off snapshots (a handover after a reassignment moves the pickup point)
  pickup_place_id    text references public.places(id),
  pickup_name        text not null,
  pickup_area        text not null,
  pickup_x           numeric not null,
  pickup_y           numeric not null,
  pickup_lat         double precision not null,
  pickup_lng         double precision not null,
  dropoff_place_id   text not null references public.places(id),
  dropoff_name       text not null,
  dropoff_area       text not null,
  dropoff_x          numeric not null,
  dropoff_y          numeric not null,
  dropoff_lat        double precision not null,
  dropoff_lng        double precision not null,
  recipient_notes    text not null default '',
  vehicle_class      text not null references public.vehicle_classes(id),
  recommended_class  text references public.vehicle_classes(id),
  urgency            text not null default 'standard' check (urgency in ('standard', 'express')),
  widened            boolean not null default false,
  no_driver          boolean not null default false,
  price_total        int not null check (price_total > 0),
  price_km           numeric not null,
  price_lines        jsonb not null,
  commission_pct     numeric not null,
  rider_earning      int,
  sig_required       boolean not null default false,
  promised_at        timestamptz,
  flags              text[] not null default '{}',
  flag_note          text,
  fail_reason        text,
  cancel_reason      text,
  resolution         text,
  handover           jsonb,
  unreachable_at     timestamptz,
  unreachable_calls  int not null default 0,
  rating             int check (rating between 1 and 5),
  recipient_opened_at timestamptz,
  is_demo            boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index deliveries_status_idx on public.deliveries(status);
create index deliveries_vendor_idx on public.deliveries(vendor_id, created_at desc);
create index deliveries_rider_idx on public.deliveries(rider_id, created_at desc);
create index deliveries_recipient_idx on public.deliveries(recipient_id);
create index deliveries_created_idx on public.deliveries(created_at desc);
alter table public.riders add constraint riders_active_delivery_fk foreign key (active_delivery_id) references public.deliveries(id) on delete set null;
alter table public.rider_locations add constraint rider_locations_delivery_fk foreign key (delivery_id) references public.deliveries(id) on delete set null;

-- Secrets are kept out of the deliveries row so column grants can hide them:
-- vendors may read pickup_pin and tracking_token; nobody reads delivery_pin directly.
create table public.delivery_secrets (
  delivery_id        uuid primary key references public.deliveries(id) on delete cascade,
  pickup_pin         text not null,
  delivery_pin       text not null,
  tracking_token     text not null unique,
  pin_attempts       int not null default 0,
  pin_locked_until   timestamptz,
  verify_attempts    int not null default 0,
  verify_locked_until timestamptz
);

create table public.delivery_offers (
  delivery_id  uuid not null references public.deliveries(id) on delete cascade,
  rider_id     uuid not null references public.riders(id) on delete cascade,
  response     text not null check (response in ('declined', 'accepted', 'released')),
  reason       text,
  created_at   timestamptz not null default now(),
  primary key (delivery_id, rider_id, response)
);

create table public.delivery_events (
  id          bigint generated always as identity primary key,
  delivery_id uuid not null references public.deliveries(id) on delete cascade,
  type        text not null,
  label       text not null,
  actor_role  text not null default 'system' check (actor_role in ('system', 'vendor', 'rider', 'recipient', 'ops')),
  actor_id    uuid,
  actor_name  text not null default 'Drop Off',
  lat         double precision,
  lng         double precision,
  meta        jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index delivery_events_delivery_idx on public.delivery_events(delivery_id, created_at);
create index delivery_events_created_idx on public.delivery_events(created_at desc);

create table public.delivery_messages (
  id          bigint generated always as identity primary key,
  delivery_id uuid not null references public.deliveries(id) on delete cascade,
  sender_role text not null check (sender_role in ('rider', 'recipient', 'vendor', 'ops')),
  sender_id   uuid,
  body        text not null check (length(body) between 1 and 1000),
  created_at  timestamptz not null default now()
);
create index delivery_messages_delivery_idx on public.delivery_messages(delivery_id, created_at);

create table public.proof_of_delivery (
  id                 uuid primary key default gen_random_uuid(),
  delivery_id        uuid not null unique references public.deliveries(id) on delete cascade,
  delivery_ref       text not null,
  rider_id           uuid references public.riders(id),
  vehicle_id         uuid references public.vehicles(id),
  pickup_photo_path  text,
  pickup_at          timestamptz,
  pickup_lat         double precision,
  pickup_lng         double precision,
  pickup_pin_ok      boolean not null default false,
  photo_path         text,
  photo_at           timestamptz,
  signature_path     text,
  received_by        text not null default 'recipient' check (received_by in ('recipient', 'other')),
  receiver_name      text,
  pin_confirmed      boolean not null default false,
  pin_confirmed_by   text check (pin_confirmed_by in ('rider', 'recipient')),
  pin_confirmed_at   timestamptz,
  recipient_confirmed boolean not null default false,
  lat                double precision,
  lng                double precision,
  distance_m         numeric,
  location_source    text,
  delivered_at       timestamptz,
  created_at         timestamptz not null default now()
);
alter table public.deliveries add constraint deliveries_proof_fk foreign key (proof_id) references public.proof_of_delivery(id);

-- Saved by recipients who choose to create an account and keep deliveries they opened.
create table public.recipient_links (
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  delivery_id uuid not null references public.deliveries(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (profile_id, delivery_id)
);

/* ------------------------------------------------------------------ money */

create table public.payments (
  id               uuid primary key default gen_random_uuid(),
  delivery_id      uuid references public.deliveries(id),
  vendor_id        uuid references public.vendors(id),
  rider_id         uuid references public.riders(id),
  purpose          text not null check (purpose in ('delivery', 'topup', 'invoice', 'payout')),
  method           text not null check (method in ('wallet', 'momo', 'airtel', 'card', 'credit')),
  amount           int not null check (amount > 0),
  status           text not null default 'pending'
    check (status in ('pending', 'initiated', 'successful', 'failed', 'refunded', 'partially_refunded', 'disputed')),
  provider         text not null default 'simulated',
  provider_ref     text,
  simulated        boolean not null default true,
  refunded_amount  int not null default 0,
  captured_at      timestamptz,
  receipt_no       text unique,
  vat              int,
  failure_reason   text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index payments_status_idx on public.payments(status);
create index payments_delivery_idx on public.payments(delivery_id);
create index payments_vendor_idx on public.payments(vendor_id, created_at desc);
alter table public.deliveries add constraint deliveries_payment_fk foreign key (payment_id) references public.payments(id);

-- kind: main (vendor or rider balance), credit (vendor business credit; balance is minus the amount used),
-- platform (Drop Off commission). Balances change only through public.wallet_post().
create table public.wallets (
  id               uuid primary key default gen_random_uuid(),
  owner_type       text not null check (owner_type in ('vendor', 'rider', 'platform')),
  kind             text not null default 'main' check (kind in ('main', 'credit', 'platform')),
  vendor_id        uuid references public.vendors(id) on delete cascade,
  rider_id         uuid references public.riders(id) on delete cascade,
  balance          bigint not null default 0,
  pending_balance  bigint not null default 0,
  credit_limit     bigint not null default 0,
  currency         text not null default 'UGX',
  updated_at       timestamptz not null default now(),
  constraint wallet_owner check (
    (owner_type = 'vendor' and vendor_id is not null and rider_id is null) or
    (owner_type = 'rider' and rider_id is not null and vendor_id is null) or
    (owner_type = 'platform' and vendor_id is null and rider_id is null)),
  constraint wallet_no_overdraft check (kind <> 'main' or balance >= 0),
  constraint wallet_credit_limit check (kind <> 'credit' or -balance <= credit_limit)
);
create unique index wallets_vendor_kind on public.wallets(vendor_id, kind) where vendor_id is not null;
create unique index wallets_rider on public.wallets(rider_id) where rider_id is not null;
create unique index wallets_platform on public.wallets(owner_type) where owner_type = 'platform';

create table public.wallet_transactions (
  id            uuid primary key default gen_random_uuid(),
  ref           text not null unique default ('TX-' || nextval('public.tx_ref_seq')),
  wallet_id     uuid not null references public.wallets(id),
  type          text not null check (type in ('topup', 'charge', 'refund', 'earning', 'payout', 'commission', 'deduction', 'invoice', 'credit_repayment', 'adjustment')),
  amount        bigint not null,
  balance_after bigint not null,
  method        text,
  label         text not null,
  status        text not null default 'completed' check (status in ('completed', 'held', 'paid', 'refunded', 'pending', 'failed')),
  delivery_id   uuid references public.deliveries(id),
  payment_id    uuid references public.payments(id),
  simulated     boolean not null default true,
  created_by    uuid,
  created_at    timestamptz not null default now()
);
create index wallet_tx_wallet_idx on public.wallet_transactions(wallet_id, created_at desc);
create index wallet_tx_delivery_idx on public.wallet_transactions(delivery_id);

/* ------------------------------------------------------------------ communication & support */

create table public.notifications (
  id           uuid primary key default gen_random_uuid(),
  audience     text not null check (audience in ('vendor', 'rider', 'ops', 'recipient')),
  vendor_id    uuid references public.vendors(id) on delete cascade,
  rider_id     uuid references public.riders(id) on delete cascade,
  profile_id   uuid references public.profiles(id) on delete cascade,
  phone        text,                       -- recipient SMS
  channel      text not null default 'in_app' check (channel in ('in_app', 'sms')),
  sms_status   text check (sms_status in ('queued', 'sent', 'failed', 'simulated')),
  title        text not null,
  body         text not null,
  delivery_id  uuid references public.deliveries(id) on delete cascade,
  kind         text not null default 'info',
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index notifications_vendor_idx on public.notifications(vendor_id, created_at desc);
create index notifications_rider_idx on public.notifications(rider_id, created_at desc);
create index notifications_audience_idx on public.notifications(audience, created_at desc);
create index notifications_delivery_idx on public.notifications(delivery_id);

create table public.support_tickets (
  id              uuid primary key default gen_random_uuid(),
  ref             text not null unique default ('T-' || nextval('public.ticket_ref_seq')),
  delivery_id     uuid references public.deliveries(id),
  opened_by       uuid references public.profiles(id),
  opened_by_role  text not null check (opened_by_role in ('vendor', 'rider', 'recipient', 'ops')),
  vendor_id       uuid references public.vendors(id),
  rider_id        uuid references public.riders(id),
  category        text not null,
  title           text not null,
  description     text not null default '',
  attachments     text[] not null default '{}',
  status          text not null default 'open' check (status in ('open', 'in_review', 'waiting_for_user', 'resolved', 'closed')),
  assigned_to     uuid references public.profiles(id),
  resolution      text,
  resolution_note text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  resolved_at     timestamptz
);
create index tickets_status_idx on public.support_tickets(status, created_at desc);
create index tickets_vendor_idx on public.support_tickets(vendor_id);
create index tickets_delivery_idx on public.support_tickets(delivery_id);

create table public.disputes (
  id              uuid primary key default gen_random_uuid(),
  delivery_id     uuid not null references public.deliveries(id),
  ticket_id       uuid references public.support_tickets(id),
  opened_by_role  text not null,
  reason          text not null,
  status          text not null default 'open' check (status in ('open', 'resolved')),
  decision        text check (decision in ('refund_full', 'refund_half', 'reject')),
  amount_refunded int not null default 0,
  decided_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz
);
create index disputes_delivery_idx on public.disputes(delivery_id);

/* ------------------------------------------------------------------ verification */

create table public.verification_requests (
  id             uuid primary key default gen_random_uuid(),
  subject_type   text not null check (subject_type in ('vendor', 'rider')),
  vendor_id      uuid references public.vendors(id) on delete cascade,
  rider_id       uuid references public.riders(id) on delete cascade,
  profile_id     uuid not null references public.profiles(id) on delete cascade,
  status         text not null default 'pending'
    check (status in ('pending', 'submitted', 'under_review', 'verified', 'rejected', 'suspended')),
  info_requested boolean not null default false,
  reviewer_id    uuid references public.profiles(id),
  reviewer_note  text,
  submitted_at   timestamptz,
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index verification_status_idx on public.verification_requests(status, updated_at desc);
create unique index verification_one_per_vendor on public.verification_requests(vendor_id) where vendor_id is not null;
create unique index verification_one_per_rider on public.verification_requests(rider_id) where rider_id is not null;

create table public.documents (
  id                      uuid primary key default gen_random_uuid(),
  owner_id                uuid not null references public.profiles(id) on delete cascade,
  verification_request_id uuid references public.verification_requests(id) on delete cascade,
  kind                    text not null check (kind in ('national_id', 'driving_permit', 'vehicle_logbook', 'insurance',
                            'profile_photo', 'business_registration', 'tin_certificate', 'trading_licence', 'other')),
  bucket                  text not null default 'documents',
  storage_path            text not null,
  file_name               text not null,
  mime_type               text,
  size_bytes              int,
  status                  text not null default 'submitted' check (status in ('submitted', 'accepted', 'rejected')),
  created_at              timestamptz not null default now()
);
create index documents_owner_idx on public.documents(owner_id);
create index documents_request_idx on public.documents(verification_request_id);

/* ------------------------------------------------------------------ audit */

create table public.audit_log (
  id           bigint generated always as identity primary key,
  event_type   text not null,
  actor_id     uuid,
  actor_role   text,
  actor_name   text,
  target_type  text,
  target_id    text,
  delivery_id  uuid references public.deliveries(id) on delete set null,
  metadata     jsonb not null default '{}',
  created_at   timestamptz not null default now()
);
create index audit_created_idx on public.audit_log(created_at desc);
create index audit_type_idx on public.audit_log(event_type);

/* ------------------------------------------------------------------ housekeeping */

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger vendors_touch before update on public.vendors for each row execute function public.touch_updated_at();
create trigger riders_touch before update on public.riders for each row execute function public.touch_updated_at();
create trigger deliveries_touch before update on public.deliveries for each row execute function public.touch_updated_at();
create trigger payments_touch before update on public.payments for each row execute function public.touch_updated_at();
create trigger tickets_touch before update on public.support_tickets for each row execute function public.touch_updated_at();
create trigger verification_touch before update on public.verification_requests for each row execute function public.touch_updated_at();
