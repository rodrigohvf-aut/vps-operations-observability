#!/usr/bin/env bash
set -Eeuo pipefail

API_URL="${API_URL:-http://127.0.0.1:3333/api/v1/ingest/vps}"
ENV_FILE="${ENV_FILE:-/etc/observability/api.env}"

fail() { printf 'collector error: %s\n' "$*" >&2; exit 1; }
command -v jq >/dev/null || fail "jq is required"
command -v docker >/dev/null || fail "docker is required"
command -v curl >/dev/null || fail "curl is required"
command -v du >/dev/null || fail "du is required"
[[ -r "$ENV_FILE" ]] || fail "cannot read $ENV_FILE"

COLLECTOR_TOKEN="$(sed -n 's/^COLLECTOR_TOKEN=//p' "$ENV_FILE" | tail -n 1)"
[[ ${#COLLECTOR_TOKEN} -ge 32 ]] || fail "COLLECTOR_TOKEN is missing or too short"

read_cpu() {
  local _ user nice system idle iowait irq softirq steal rest
  read -r _ user nice system idle iowait irq softirq steal rest < /proc/stat
  printf '%s %s\n' "$((user + nice + system + idle + iowait + irq + softirq + steal))" "$((idle + iowait))"
}

read -r cpu_total_1 cpu_idle_1 < <(read_cpu)
sleep 1
read -r cpu_total_2 cpu_idle_2 < <(read_cpu)
cpu_percent="$(awk -v t1="$cpu_total_1" -v t2="$cpu_total_2" -v i1="$cpu_idle_1" -v i2="$cpu_idle_2" 'BEGIN { d=t2-t1; if (d<=0) print "0.00"; else printf "%.2f", 100*(1-(i2-i1)/d) }')"

mem_total_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
mem_available_kb="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
swap_total_kb="$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)"
swap_free_kb="$(awk '/^SwapFree:/ {print $2}' /proc/meminfo)"
mem_used_kb="$((mem_total_kb - mem_available_kb))"
ram_total_mb="$(awk -v n="$mem_total_kb" 'BEGIN {printf "%.2f", n/1024}')"
ram_used_mb="$(awk -v n="$mem_used_kb" 'BEGIN {printf "%.2f", n/1024}')"
ram_free_gb="$(awk -v n="$mem_available_kb" 'BEGIN {printf "%.2f", n/1048576}')"
ram_percent="$(awk -v u="$mem_used_kb" -v t="$mem_total_kb" 'BEGIN {printf "%.2f", 100*u/t}')"
swap_percent="$(awk -v t="$swap_total_kb" -v f="$swap_free_kb" 'BEGIN {if (t==0) print "0.00"; else printf "%.2f", 100*(t-f)/t}')"

read -r disk_total_b disk_used_b disk_free_b disk_percent_raw < <(df -P -B1 / | awk 'NR==2 {print $2, $3, $4, $5}')
disk_total_gb="$(awk -v n="$disk_total_b" 'BEGIN {printf "%.2f", n/1073741824}')"
disk_used_gb="$(awk -v n="$disk_used_b" 'BEGIN {printf "%.2f", n/1073741824}')"
disk_free_gb="$(awk -v n="$disk_free_b" 'BEGIN {printf "%.2f", n/1073741824}')"
disk_percent="${disk_percent_raw%%%}"

disk_usage='[]'

human_size_to_bytes() {
  awk -v raw="$1" 'BEGIN {
    gsub(/[[:space:]]/, "", raw)
    if (raw == "" || raw == "0B") {print 0; exit}
    match(raw, /^[0-9.]+/); n=substr(raw, RSTART, RLENGTH)+0
    unit=tolower(substr(raw, RLENGTH+1))
    factor=1
    if (unit=="kb" || unit=="kib") factor=1024
    else if (unit=="mb" || unit=="mib") factor=1048576
    else if (unit=="gb" || unit=="gib") factor=1073741824
    else if (unit=="tb" || unit=="tib") factor=1099511627776
    printf "%.0f", n*factor
  }'
}

add_disk_item() {
  local category="$1" item_name="$2" path="$3" item_count="$4" size_bytes="$5" details="$6" percent_of_used
  percent_of_used="$(awk -v size="$size_bytes" -v used="$disk_used_b" 'BEGIN {if (used<=0) print "0.00"; else printf "%.2f", 100*size/used}')"
  disk_usage="$(jq -c \
    --arg category "$category" --arg path "$path" --arg item "$item_name" \
    --argjson count "$item_count" --arg details "$details" \
    --argjson size "$size_bytes" --argjson percent "$percent_of_used" \
    '.+[{category:$category,path:$path,item_name:$item,item_count:$count,details:$details,size_bytes:$size,percent_of_used:$percent}]' \
    <<<"$disk_usage")"
}

docker_root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
docker_root="${docker_root:-/var/lib/docker}"
while IFS= read -r docker_row; do
  [[ -n "$docker_row" ]] || continue
  docker_type="$(jq -r '.Type // empty' <<<"$docker_row")"
  docker_total="$(jq -r '(.TotalCount // 0) | tonumber? // 0' <<<"$docker_row")"
  docker_active="$(jq -r '(.Active // 0) | tonumber? // 0' <<<"$docker_row")"
  docker_size_raw="$(jq -r '.Size // "0B"' <<<"$docker_row")"
  docker_reclaimable="$(jq -r '.Reclaimable // "0B"' <<<"$docker_row")"
  docker_size_bytes="$(human_size_to_bytes "$docker_size_raw")"
  case "$docker_type" in
    Images) docker_item="Imagens" ;;
    Containers) docker_item="Containers" ;;
    "Local Volumes") docker_item="Volumes" ;;
    "Build Cache") docker_item="Cache de build" ;;
    *) docker_item="$docker_type" ;;
  esac
  [[ -n "$docker_item" ]] || continue
  add_disk_item "Docker" "$docker_item" "$docker_root" "$docker_total" "$docker_size_bytes" "Ativos: $docker_active · Recuperável: $docker_reclaimable"
done < <(docker system df --format '{{json .}}' 2>/dev/null || true)

while IFS='|' read -r category item_name path; do
  [[ -e "$path" ]] || continue
  size_bytes="$(du -x -s -B1 "$path" 2>/dev/null | awk 'NR==1 {print $1+0}')"
  size_bytes="${size_bytes:-0}"
  item_count="$(find "$path" -xdev -type f 2>/dev/null | wc -l | awk '{print $1+0}')"
  add_disk_item "$category" "$item_name" "$path" "$item_count" "$size_bytes" "$path"
done <<'DISK_ITEMS'
Backups|Supabase|/opt/tenant_example/backups/supabase
Backups|n8n|/opt/tenant_example/backups/n8n
Aplicações|VPS Operations Repository|/opt/observability/repository
Aplicações|Example Tenant|/opt/tenant_example
Bancos|Dados PostgreSQL|/var/lib/postgresql
Logs|Logs do sistema|/var/log
Logs|Logs da Example Tenant|/opt/tenant_example/logs
Sistema|Bibliotecas e aplicações|/usr
Sistema|Arquivos do root|/root
Sistema|Arquivos temporários|/tmp
DISK_ITEMS

read -r load_1m load_5m load_15m _ < /proc/loadavg
uptime_seconds="$(awk '{printf "%d", $1}' /proc/uptime)"
captured_at="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"

to_mb() {
  awk -v raw="$1" 'BEGIN {
    gsub(/[[:space:]]/, "", raw)
    n=raw; sub(/[A-Za-z]+$/, "", n)
    u=raw; sub(/^[0-9.]+/, "", u)
    if (n !~ /^[0-9.]+$/ || u !~ /^[A-Za-z]+$/) {print "0.00"; exit}
    n=n+0
    if (u=="B") m=n/1000000
    else if (u=="kB" || u=="KB") m=n/1000
    else if (u=="KiB") m=n*1024/1000000
    else if (u=="MB") m=n
    else if (u=="MiB") m=n*1048576/1000000
    else if (u=="GB") m=n*1000
    else if (u=="GiB") m=n*1073.741824
    else if (u=="TB") m=n*1000000
    else if (u=="TiB") m=n*1099511.627776
    else m=0
    printf "%.2f", m
  }'
}

containers='[]'
while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  container_id="$(jq -r '.ID' <<<"$line")"
  container_name="$(jq -r '.Name' <<<"$line")"
  container_cpu="$(jq -r '.CPUPerc | rtrimstr("%")' <<<"$line")"
  container_mem_percent="$(jq -r '.MemPerc | rtrimstr("%")' <<<"$line")"
  mem_usage="$(jq -r '.MemUsage' <<<"$line")"
  net_io="$(jq -r '.NetIO' <<<"$line")"
  block_io="$(jq -r '.BlockIO' <<<"$line")"
  memory_used_mb="$(to_mb "${mem_usage%%/*}")"
  memory_limit_mb="$(to_mb "${mem_usage##*/}")"
  network_rx_mb="$(to_mb "${net_io%%/*}")"
  network_tx_mb="$(to_mb "${net_io##*/}")"
  block_read_mb="$(to_mb "${block_io%%/*}")"
  block_write_mb="$(to_mb "${block_io##*/}")"
  containers="$(jq -c \
    --arg id "$container_id" --arg name "$container_name" \
    --argjson cpu "${container_cpu:-0}" --argjson mu "$memory_used_mb" --argjson ml "$memory_limit_mb" \
    --argjson mp "${container_mem_percent:-0}" --argjson nr "$network_rx_mb" --argjson nt "$network_tx_mb" \
    --argjson br "$block_read_mb" --argjson bw "$block_write_mb" \
    '. + [{container_id:$id,container_name:$name,cpu_percent:$cpu,memory_used_mb:$mu,memory_limit_mb:$ml,memory_percent:$mp,network_rx_mb:$nr,network_tx_mb:$nt,block_read_mb:$br,block_write_mb:$bw}]' <<<"$containers")"
done < <(docker stats --no-stream --format '{{json .}}')

payload="$(jq -cn \
  --arg captured_at "$captured_at" \
  --argjson cpu "$cpu_percent" --argjson ru "$ram_used_mb" --argjson rt "$ram_total_mb" \
  --argjson rp "$ram_percent" --argjson du "$disk_used_gb" --argjson dt "$disk_total_gb" \
  --argjson dp "$disk_percent" --argjson rf "$ram_free_gb" --argjson df "$disk_free_gb" \
  --argjson sp "$swap_percent" --argjson l1 "$load_1m" --argjson l5 "$load_5m" \
  --argjson l15 "$load_15m" --argjson up "$uptime_seconds" --argjson containers "$containers" --argjson disk_usage "$disk_usage" \
  '{captured_at:$captured_at,vps:{cpu_percent:$cpu,ram_used_mb:$ru,ram_total_mb:$rt,ram_percent:$rp,disk_used_gb:$du,disk_total_gb:$dt,disk_percent:$dp,ram_free_gb:$rf,disk_free_gb:$df,swap_percent:$sp,load_1m:$l1,load_5m:$l5,load_15m:$l15,uptime_seconds:$up},containers:$containers,disk_usage:$disk_usage}')"

curl --fail-with-body --silent --show-error \
  -X POST "$API_URL" \
  -H "Authorization: Bearer $COLLECTOR_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary "$payload"
printf '\n'



