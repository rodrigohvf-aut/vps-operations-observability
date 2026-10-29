create table if not exists vps_tracking.restore_tests (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  backup_file text not null,
  tested_at timestamptz not null default now(),
  status text not null check (status in ('success','failed')),
  duration_seconds integer not null default 0 check (duration_seconds >= 0),
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  checks jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists restore_tests_tested_at_idx
  on vps_tracking.restore_tests (tested_at desc, job_name);

delete from vps_tracking.restore_tests where tested_at < now() - interval '60 days';
