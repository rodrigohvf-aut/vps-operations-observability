create table if not exists vps_tracking.workflow_execution_hourly (
  id bigserial primary key,
  client_id uuid not null references vps_tracking.clients(id) on delete cascade,
  bucket_hour timestamptz not null,
  workflow_id text not null,
  workflow_name text not null,
  total_executions integer not null default 0,
  successful_executions integer not null default 0,
  failed_executions integer not null default 0,
  running_executions integer not null default 0,
  collected_at timestamptz not null default now(),
  unique (client_id, bucket_hour, workflow_id)
);

create index if not exists workflow_execution_hourly_period_client_idx
  on vps_tracking.workflow_execution_hourly (bucket_hour desc, client_id, workflow_name);
