begin;

alter table vps_tracking.disk_usage_samples
  add column if not exists item_name text,
  add column if not exists item_count integer,
  add column if not exists details text;

update vps_tracking.disk_usage_samples
set item_name = path
where item_name is null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'disk_usage_samples_item_count_check'
      and conrelid = 'vps_tracking.disk_usage_samples'::regclass
  ) then
    alter table vps_tracking.disk_usage_samples
      add constraint disk_usage_samples_item_count_check
      check (item_count is null or item_count >= 0) not valid;
  end if;
end
$$;

alter table vps_tracking.disk_usage_samples
  validate constraint disk_usage_samples_item_count_check;

commit;
