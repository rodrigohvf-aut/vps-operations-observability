alter table vps_tracking.security_samples
  add column if not exists system_updates jsonb not null default '{}'::jsonb;
