create table if not exists vps_tracking.workflow_execution_daily (
  id bigint generated always as identity primary key,
  client_id uuid not null references vps_tracking.clients(id),
  day date not null,
  workflow_id text not null,
  workflow_name text not null,
  total_executions bigint not null default 0,
  successful_executions bigint not null default 0,
  failed_executions bigint not null default 0,
  running_executions bigint not null default 0,
  collected_at timestamptz not null default now(),
  unique (client_id, day, workflow_id)
);

create index if not exists workflow_execution_daily_period_client_idx
  on vps_tracking.workflow_execution_daily (day desc, client_id, workflow_name);
