create table if not exists vps_tracking.automation_samples (
  id bigint generated always as identity primary key,
  collected_at timestamptz not null default now(),
  platform text not null default 'n8n',
  instance_name text not null,
  total_executions bigint not null default 0 check (total_executions >= 0),
  successful_executions bigint not null default 0 check (successful_executions >= 0),
  failed_executions bigint not null default 0 check (failed_executions >= 0),
  running_executions bigint not null default 0 check (running_executions >= 0),
  execution_data_bytes bigint not null default 0 check (execution_data_bytes >= 0),
  database_bytes bigint not null default 0 check (database_bytes >= 0),
  oldest_execution_at timestamptz,
  newest_execution_at timestamptz
);

create index if not exists automation_samples_instance_collected_idx
  on vps_tracking.automation_samples (instance_name, collected_at desc);
