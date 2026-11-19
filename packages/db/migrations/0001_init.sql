-- M1: tenancy, users, properties, connections (spec §4.1–4.2, 4.6 audit_log)
-- NOTE: gen_random_uuid() (v4) used until uuidv7 is available in Postgres/Supabase; see docs/DECISIONS.md.
create extension if not exists pgcrypto;
create schema if not exists app;

create type org_type as enum ('agency','manager','host');
create type member_role as enum ('owner','admin','editor','client_viewer','client_editor');
create type property_status as enum ('active','archived');
create type provider as enum ('hostaway','guesty','google_gbp','ownerrez','hospitable');
create type connection_status as enum ('active','error','revoked');
create type mapping_method as enum ('auto_exact','auto_fuzzy','manual');

create table orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  type org_type not null,
  branding jsonb not null default '{}',
  stripe_customer_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  slug text not null,
  website_url text,
  timezone text not null default 'UTC',
  default_locale text not null default 'en',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (org_id, slug),
  unique (id, org_id)
);

create table users (
  id uuid primary key,            -- = auth.users.id (Supabase auth uid)
  email text not null,
  name text,
  created_at timestamptz not null default now()
);

create table memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  workspace_id uuid,
  role member_role not null,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, org_id) references workspaces(id, org_id) on delete cascade,
  -- client roles must be scoped to a workspace
  check (workspace_id is not null or role not in ('client_viewer','client_editor'))
);
create unique index memberships_uniq on memberships (user_id, org_id, coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'));
create index memberships_user_idx on memberships (user_id);

create table invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  workspace_id uuid,
  email text not null,
  role member_role not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, org_id) references workspaces(id, org_id) on delete cascade,
  check (workspace_id is not null or role not in ('client_viewer','client_editor'))
);

create table properties (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  workspace_id uuid not null,
  name text not null,
  slug text not null,
  address jsonb,
  lat double precision, lng double precision,
  bedrooms int,
  external_url text,
  status property_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (workspace_id, org_id) references workspaces(id, org_id) on delete cascade,
  unique (workspace_id, slug),
  unique (id, org_id)
);

create table connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  workspace_id uuid not null,
  provider provider not null,
  display_name text not null,
  credentials_enc bytea,
  credentials_meta jsonb not null default '{}',
  token_cache_enc bytea,
  token_expires_at timestamptz,
  status connection_status not null default 'active',
  last_error text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, org_id) references workspaces(id, org_id) on delete cascade,
  unique (id, org_id)
);

create table external_listings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  workspace_id uuid not null,
  connection_id uuid,
  provider text not null,
  external_id text not null,
  name text,
  address jsonb,
  lat double precision, lng double precision,
  raw jsonb,
  last_seen_at timestamptz,
  foreign key (workspace_id, org_id) references workspaces(id, org_id) on delete cascade,
  foreign key (connection_id, org_id) references connections(id, org_id) on delete cascade,
  unique (connection_id, external_id),
  unique (id, org_id)
);

create table listing_mappings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  external_listing_id uuid not null unique,
  property_id uuid not null,
  method mapping_method not null,
  confidence numeric(4,3),
  confirmed_by uuid references users(id),
  confirmed_at timestamptz,
  foreign key (external_listing_id, org_id) references external_listings(id, org_id) on delete cascade,
  foreign key (property_id, org_id) references properties(id, org_id) on delete cascade
);

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  actor_user_id uuid,
  action text not null,
  entity text not null,
  entity_id text,
  diff jsonb,
  created_at timestamptz not null default now()
);
create index audit_org_idx on audit_log (org_id, created_at desc);
