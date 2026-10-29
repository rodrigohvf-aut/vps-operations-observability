begin;

create table if not exists vps_tracking.ssh_access_events (
  id bigint generated always as identity primary key,
  event_key text not null,
  occurred_at timestamptz not null,
  source_ip inet not null,
  source_port integer,
  username text,
  auth_method text,
  outcome text not null,
  event_type text not null,
  created_at timestamptz not null default now(),
  constraint ssh_access_events_event_key_key unique (event_key),
  constraint ssh_access_events_source_port_check
    check (source_port is null or source_port between 1 and 65535),
  constraint ssh_access_events_outcome_check
    check (outcome in ('failed', 'accepted'))
);

create index if not exists ssh_access_events_occurred_at_idx
  on vps_tracking.ssh_access_events (occurred_at desc);

create index if not exists ssh_access_events_source_ip_occurred_at_idx
  on vps_tracking.ssh_access_events (source_ip, occurred_at desc);

create or replace function vps_tracking.purge_old_monitoring_data(retention_days integer default 60)
returns table (table_name text, deleted_rows bigint)
language plpgsql
security definer
set search_path = vps_tracking, pg_catalog
as $$
declare
  cutoff timestamptz := now() - make_interval(days => greatest(retention_days, 1));
  affected bigint;
begin
  delete from vps_tracking.container_samples where captured_at < cutoff;
  get diagnostics affected = row_count; return query select 'container_samples', affected;
  delete from vps_tracking.vps_samples where captured_at < cutoff;
  get diagnostics affected = row_count; return query select 'vps_samples', affected;
  delete from vps_tracking.security_samples where captured_at < cutoff;
  get diagnostics affected = row_count; return query select 'security_samples', affected;
  delete from vps_tracking.ssh_access_events where occurred_at < cutoff;
  get diagnostics affected = row_count; return query select 'ssh_access_events', affected;
  delete from vps_tracking.automation_samples where collected_at < cutoff;
  get diagnostics affected = row_count; return query select 'automation_samples', affected;
  delete from vps_tracking.workflow_execution_hourly where bucket_hour < cutoff;
  get diagnostics affected = row_count; return query select 'workflow_execution_hourly', affected;
  delete from vps_tracking.workflow_execution_daily where day < cutoff::date;
  get diagnostics affected = row_count; return query select 'workflow_execution_daily', affected;
  delete from vps_tracking.error_events where occurred_at < cutoff;
  get diagnostics affected = row_count; return query select 'error_events', affected;
  delete from vps_tracking.token_usage where occurred_at < cutoff;
  get diagnostics affected = row_count; return query select 'token_usage', affected;
  delete from vps_tracking.table_samples where collected_at < cutoff;
  get diagnostics affected = row_count; return query select 'table_samples', affected;
  delete from vps_tracking.schema_samples where collected_at < cutoff;
  get diagnostics affected = row_count; return query select 'schema_samples', affected;
  delete from vps_tracking.database_samples where collected_at < cutoff;
  get diagnostics affected = row_count; return query select 'database_samples', affected;
  delete from vps_tracking.backup_runs where scheduled_at < cutoff;
  get diagnostics affected = row_count; return query select 'backup_runs', affected;
end;
$$;

revoke all on function vps_tracking.purge_old_monitoring_data(integer) from public;

commit;
