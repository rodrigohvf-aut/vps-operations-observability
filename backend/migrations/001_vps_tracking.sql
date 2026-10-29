create extension if not exists pgcrypto;
create schema if not exists vps_tracking;

create type vps_tracking.backup_status as enum ('running','success','late','failed');
create type vps_tracking.error_severity as enum ('info','warning','error','critical');

create table vps_tracking.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  schema_name name not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table vps_tracking.vps_samples (
  id bigint generated always as identity primary key,
  captured_at timestamptz not null default now(),
  cpu_percent numeric(6,2) not null,
  ram_used_mb numeric(14,2), ram_total_mb numeric(14,2), ram_percent numeric(6,2) not null,
  disk_used_gb numeric(14,2), disk_total_gb numeric(14,2), disk_percent numeric(6,2) not null,
  ram_free_gb numeric(14,2), disk_free_gb numeric(14,2), swap_percent numeric(6,2),
  load_1m numeric(10,3), load_5m numeric(10,3), load_15m numeric(10,3),
  uptime_seconds bigint,
  check (cpu_percent between 0 and 100 and ram_percent between 0 and 100 and disk_percent between 0 and 100)
);

create table vps_tracking.container_samples (
  id bigint generated always as identity primary key,
  captured_at timestamptz not null default now(),
  container_id text not null,
  container_name text not null,
  cpu_percent numeric(7,2), memory_used_mb numeric(14,2), memory_limit_mb numeric(14,2), memory_percent numeric(7,2),
  network_rx_mb numeric(16,2), network_tx_mb numeric(16,2), block_read_mb numeric(16,2), block_write_mb numeric(16,2)
);

create table vps_tracking.backup_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  scheduled_at timestamptz not null,
  started_at timestamptz, finished_at timestamptz,
  duration_seconds integer generated always as (case when finished_at is not null and started_at is not null then extract(epoch from finished_at-started_at)::integer end) stored,
  size_bytes bigint, retention_days integer,
  destination text,
  status vps_tracking.backup_status not null,
  integrity_verified boolean not null default false,
  restore_tested_at timestamptz,
  error_message text,
  created_at timestamptz not null default now()
);

create table vps_tracking.token_usage (
  id bigint generated always as identity primary key,
  client_id uuid not null references vps_tracking.clients(id),
  occurred_at timestamptz not null default now(),
  provider text not null,
  model text not null,
  request_id text,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cached_tokens bigint not null default 0,
  cost_brl numeric(14,6) not null default 0,
  metadata jsonb not null default '{}'
);

create table vps_tracking.error_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references vps_tracking.clients(id),
  occurred_at timestamptz not null default now(),
  severity vps_tracking.error_severity not null,
  source text not null,
  workflow_name text,
  error_code text,
  message text not null,
  fingerprint text,
  resolved_at timestamptz,
  metadata jsonb not null default '{}'
);

create table vps_tracking.database_samples (
  id bigint generated always as identity primary key,
  collected_at timestamptz not null default now(),
  database_name text not null,
  size_bytes bigint not null,
  limit_bytes bigint,
  used_percent numeric(7,3),
  connection_count integer,
  connection_limit integer,
  schema_count integer not null
);

create table vps_tracking.schema_samples (
  id bigint generated always as identity primary key,
  collected_at timestamptz not null default now(),
  client_id uuid not null references vps_tracking.clients(id),
  schema_name name not null,
  size_bytes bigint not null,
  table_count integer not null,
  connection_count integer,
  unique (collected_at, schema_name)
);

create table vps_tracking.table_samples (
  id bigint generated always as identity primary key,
  collected_at timestamptz not null default now(),
  client_id uuid not null references vps_tracking.clients(id),
  schema_name name not null,
  table_name name not null,
  table_bytes bigint not null,
  index_bytes bigint not null,
  total_bytes bigint generated always as (table_bytes+index_bytes) stored,
  estimated_rows bigint
);

create index on vps_tracking.vps_samples (captured_at desc);
create index on vps_tracking.container_samples (captured_at desc, container_name);
create index on vps_tracking.backup_runs (scheduled_at desc, status);
create index on vps_tracking.token_usage (client_id, occurred_at desc);
create index on vps_tracking.error_events (client_id, occurred_at desc, severity);
create index on vps_tracking.database_samples (collected_at desc);
create index on vps_tracking.schema_samples (client_id, collected_at desc);
create index on vps_tracking.table_samples (client_id, collected_at desc, total_bytes desc);
