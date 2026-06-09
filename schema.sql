-- STONHUB — Supabase schema
-- run in Supabase SQL editor

create table if not exists waitlist (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  created_at timestamptz default now()
);

create table if not exists scans (
  id uuid primary key default gen_random_uuid(),
  address text not null,
  archetype text,
  score int,
  receipt text,
  anchored_tx text,
  created_at timestamptz default now()
);
create index if not exists scans_address_idx on scans(address);

create table if not exists scan_usage (
  ip text not null,
  day date not null,
  count int default 0,
  primary key (ip, day)
);

create table if not exists watchlist (
  wallet text not null,
  target text not null,
  label text,
  created_at timestamptz default now(),
  primary key (wallet, target)
);
create index if not exists watchlist_wallet_idx on watchlist(wallet);

-- RLS on, backend uses service-role key (bypasses RLS). No public policies = no anon access.
alter table waitlist   enable row level security;
alter table scans      enable row level security;
alter table scan_usage enable row level security;
alter table watchlist  enable row level security;
