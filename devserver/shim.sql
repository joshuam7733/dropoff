-- Local dev only: the parts of a Supabase database that the migrations expect (roles, auth, storage,
-- realtime publication, default privileges). Not used against a real Supabase project.
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema auth;
create schema storage;
grant usage on schema public, extensions, auth, storage to anon, authenticated, service_role;

create table auth.users (
  instance_id uuid, id uuid primary key, aud text, role text, email text unique, encrypted_password text,
  email_confirmed_at timestamptz, invited_at timestamptz, confirmation_token text, confirmation_sent_at timestamptz,
  recovery_token text, recovery_sent_at timestamptz, email_change_token_new text, email_change text, email_change_sent_at timestamptz,
  last_sign_in_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb, is_super_admin boolean,
  created_at timestamptz default now(), updated_at timestamptz default now(), phone text, phone_confirmed_at timestamptz,
  banned_until timestamptz, deleted_at timestamptz);
create table auth.identities (
  id uuid primary key, provider_id text not null, user_id uuid references auth.users(id) on delete cascade, identity_data jsonb,
  provider text not null, last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz,
  email text generated always as (lower(identity_data->>'email')) stored, unique (provider_id, provider));
create table auth.refresh_tokens (token text primary key, user_id uuid, revoked boolean default false, created_at timestamptz default now());

create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid $$;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')) $$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
grant execute on function auth.uid(), auth.role(), auth.jwt() to anon, authenticated, service_role;

create table storage.buckets (id text primary key, name text unique, owner uuid, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now(), updated_at timestamptz default now());
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text,
  owner uuid, owner_id text, created_at timestamptz default now(), updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(), metadata jsonb, version text, user_metadata jsonb, unique (bucket_id, name));
create function storage.foldername(name text) returns text[] language plpgsql immutable as $$
declare p text[] := string_to_array(name, '/'); begin return p[1:array_length(p, 1) - 1]; end $$;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;
alter table storage.objects enable row level security;
grant all on storage.objects to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated, service_role;

create publication supabase_realtime;

-- Supabase grants new public objects to the API roles by default; mirror that so the migrations' revokes are tested.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
