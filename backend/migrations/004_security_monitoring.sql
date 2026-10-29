create table if not exists vps_tracking.security_samples (
  id bigint generated always as identity primary key,
  captured_at timestamptz not null default now(),
  targets jsonb not null default '[]'::jsonb,
  firewall jsonb not null default '{}'::jsonb,
  ssh jsonb not null default '{}'::jsonb,
  fail2ban jsonb not null default '{}'::jsonb,
  docker jsonb not null default '{}'::jsonb,
  traefik jsonb not null default '{}'::jsonb
);

create index if not exists security_samples_captured_at_idx
  on vps_tracking.security_samples (captured_at desc);
