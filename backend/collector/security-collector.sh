#!/usr/bin/env bash
set -Eeuo pipefail

API_URL="${API_URL:-http://127.0.0.1:3333/api/v1/ingest/security}"
ENV_FILE="${ENV_FILE:-/etc/observability/api.env}"
SECURITY_TARGETS="${SECURITY_TARGETS:-controle.example.invalid,tenant_example.example.invalid,example.invalid}"
EXPECTED_PORTS="${EXPECTED_PORTS:-22,80,443}"

fail(){ printf 'security collector error: %s\n' "$*" >&2; exit 1; }
for cmd in jq curl openssl ss docker systemctl sha256sum;do command -v "$cmd" >/dev/null||fail "$cmd is required";done
[[ -r "$ENV_FILE" ]]||fail "cannot read $ENV_FILE"
COLLECTOR_TOKEN="$(sed -n 's/^COLLECTOR_TOKEN=//p' "$ENV_FILE"|tail -n1)"
[[ ${#COLLECTOR_TOKEN} -ge 32 ]]||fail "COLLECTOR_TOKEN is missing or too short"

captured_at="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
targets='[]'
IFS=',' read -ra target_list <<<"$SECURITY_TARGETS"
for raw_host in "${target_list[@]}";do
  host="$(xargs <<<"$raw_host")"; [[ -n "$host" ]]||continue
  ip="$(getent ahostsv4 "$host" 2>/dev/null|awk 'NR==1{print $1}')"
  [[ -n "$ip" ]]&&dns_ok=true||dns_ok=false
  curl_result="$(curl -o /dev/null -sS --max-time 15 -w '%{http_code} %{time_total}' "https://$host" 2>/dev/null||printf '000 0')"
  read -r http_status latency_s <<<"$curl_result"; [[ "$http_status" =~ ^[23] ]]&&https_ok=true||https_ok=false
  http_status_num="$(awk -v x="${http_status:-0}" 'BEGIN{print x+0}')"
  latency_ms="$(awk -v x="${latency_s:-0}" 'BEGIN{printf "%.0f",x*1000}')"
  ssl_end="$(timeout 12 openssl s_client -servername "$host" -connect "$host:443" </dev/null 2>/dev/null|openssl x509 -noout -enddate 2>/dev/null|cut -d= -f2-||true)"
  ssl_iso=null; ssl_days=null
  if [[ -n "$ssl_end" ]];then ssl_epoch="$(date -d "$ssl_end" +%s 2>/dev/null||printf 0)"; now_epoch="$(date +%s)"; ssl_days="$(( (ssl_epoch-now_epoch)/86400 ))"; ssl_iso="$(date -u -d "$ssl_end" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null||printf null)";fi
  targets="$(jq -c --arg host "$host" --arg ip "${ip:-}" --argjson dns "$dns_ok" --argjson https "$https_ok" --argjson status "$http_status_num" --argjson latency "$latency_ms" --arg ssl "$ssl_iso" --argjson days "$ssl_days" '.+[{host:$host,resolved_ip:$ip,dns_ok:$dns,https_ok:$https,http_status:$status,latency_ms:$latency,ssl_expires_at:(if $ssl=="null" then null else $ssl end),ssl_days_remaining:$days}]' <<<"$targets")"
done

listening_ports="$(ss -H -lntup 2>/dev/null|awk '{a=$5;if(a~/^127\./||a~/^\[::1\]:/)next;n=a;sub(/^.*:/,"",n);if(n~/^[0-9]+$/)print n}'|sort -nu|jq -Rsc 'split("\n")|map(select(length>0)|tonumber)')"
expected_json="$(tr ',' '\n' <<<"$EXPECTED_PORTS"|jq -Rsc 'split("\n")|map(select(length>0)|tonumber)')"
unexpected_ports="$(jq -cn --argjson open "$listening_ports" --argjson expected "$expected_json" '$open-$expected')"
if command -v ufw >/dev/null&&ufw status 2>/dev/null|head -n1|grep -qi active;then firewall_active=true;else firewall_active=false;fi
firewall="$(jq -cn --argjson active "$firewall_active" --argjson ports "$listening_ports" --argjson unexpected "$unexpected_ports" '{active:$active,listening_ports:$ports,unexpected_ports:$unexpected}')"

ssh_active=false; systemctl is-active --quiet ssh&&ssh_active=true
sshd_cfg="$(sshd -T 2>/dev/null||true)"; root_login="$(awk '$1=="permitrootlogin"{print $2}' <<<"$sshd_cfg")"; password_auth="$(awk '$1=="passwordauthentication"{print $2}' <<<"$sshd_cfg")"

ssh_events='[]'
while IFS= read -r journal_row;do
  [[ -n "$journal_row" ]]||continue
  message="$(jq -r '.MESSAGE // empty' <<<"$journal_row")"
  if [[ "$message" =~ ^(Failed|Accepted)[[:space:]]+(password|publickey)[[:space:]]+for[[:space:]]+(invalid[[:space:]]+user[[:space:]]+)?([^[:space:]]+)[[:space:]]+from[[:space:]]+([^[:space:]]+)[[:space:]]+port[[:space:]]+([0-9]+) ]];then
    action="${BASH_REMATCH[1],,}"
    method="${BASH_REMATCH[2],,}"
    username="${BASH_REMATCH[4]}"
    source_ip="${BASH_REMATCH[5]}"
    source_port="${BASH_REMATCH[6]}"
    [[ "$action" == "accepted" ]]&&outcome=accepted||outcome=failed
    event_type="${action}_${method}"
    realtime_us="$(jq -r '.__REALTIME_TIMESTAMP // empty' <<<"$journal_row")"
    [[ "$realtime_us" =~ ^[0-9]+$ ]]||continue
    occurred_at="$(date -u -d "@$((realtime_us/1000000))" +%Y-%m-%dT%H:%M:%SZ)"
    cursor="$(jq -r '.__CURSOR // empty' <<<"$journal_row")"
    event_key="$(printf '%s' "${cursor:-$realtime_us|$message}"|sha256sum|awk '{print $1}')"
    ssh_events="$(jq -c --arg key "$event_key" --arg occurred "$occurred_at" --arg ip "$source_ip" --argjson port "$source_port" --arg user "$username" --arg method "$method" --arg outcome "$outcome" --arg type "$event_type" '.+[{event_key:$key,occurred_at:$occurred,source_ip:$ip,source_port:$port,username:$user,auth_method:$method,outcome:$outcome,event_type:$type}]' <<<"$ssh_events")"
  fi
done < <(journalctl -u ssh --since '25 hours ago' --no-pager -o json 2>/dev/null||true)

interval_start="$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)"
failed_interval="$(jq --arg start "$interval_start" '[.[]|select(.outcome=="failed" and .occurred_at>=$start)]|length' <<<"$ssh_events")"
accepted_interval="$(jq --arg start "$interval_start" '[.[]|select(.outcome=="accepted" and .occurred_at>=$start)]|length' <<<"$ssh_events")"
ssh_json="$(jq -cn --argjson active "$ssh_active" --arg root "${root_login:-unknown}" --arg password "${password_auth:-unknown}" --arg start "$interval_start" --arg end "$captured_at" --argjson failed "$failed_interval" --argjson accepted "$accepted_interval" '{service_active:$active,permit_root_login:$root,password_authentication:$password,interval_start:$start,interval_end:$end,failed_logins_interval:$failed,accepted_logins_interval:$accepted}')"

f2b_active=false; systemctl is-active --quiet fail2ban&&f2b_active=true
jails='[]'; banned=0; banned_ips='[]'
if $f2b_active&&command -v fail2ban-client >/dev/null;then
  jail_text="$(fail2ban-client status 2>/dev/null|sed -n 's/.*Jail list:[[:space:]]*//p')"; jails="$(tr ',' '\n' <<<"$jail_text"|sed 's/^[[:space:]]*//;s/[[:space:]]*$//'|jq -Rsc 'split("\n")|map(select(length>0))')"
  while IFS= read -r jail;do
    jail_status="$(fail2ban-client status "$jail" 2>/dev/null||true)"
    count="$(awk -F: '/Currently banned/{gsub(/ /,"",$2);print $2}' <<<"$jail_status")"
    banned="$((banned+${count:-0}))"
    jail_ips="$(awk -F: '/Banned IP list/{sub(/^[^:]*:[[:space:]]*/,"");print}' <<<"$jail_status"|tr ' ' '\n'|jq -Rsc 'split("\n")|map(select(length>0))')"
    banned_ips="$(jq -cn --argjson current "$banned_ips" --argjson found "$jail_ips" '$current+$found|unique')"
  done < <(jq -r '.[]' <<<"$jails")
fi
fail2ban_json="$(jq -cn --argjson active "$f2b_active" --argjson banned "$banned" --argjson jails "$jails" --argjson ips "$banned_ips" '{service_active:$active,currently_banned:$banned,jails:$jails,banned_ips:$ips}')"


pending_total=0; security_updates=0
apt_check="$(/usr/lib/update-notifier/apt-check 2>&1 || true)"
if [[ "$apt_check" =~ ^([0-9]+)\;([0-9]+)$ ]];then
  pending_total="${BASH_REMATCH[1]}"
  security_updates="${BASH_REMATCH[2]}"
fi
reboot_required=false; reboot_packages='[]'
if [[ -f /var/run/reboot-required ]];then
  reboot_required=true
  if [[ -r /var/run/reboot-required.pkgs ]];then
    reboot_packages="$(sort -u /var/run/reboot-required.pkgs|jq -Rsc 'split("\n")|map(select(length>0))')"
  fi
fi
apt_lists_updated_at=null
if [[ -e /var/lib/apt/lists ]];then
  apt_lists_updated_at="$(date -u -d "@$(stat -c %Y /var/lib/apt/lists)" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null||printf null)"
fi
system_updates_json="$(jq -cn --arg checked "$captured_at" --arg apt "$apt_lists_updated_at" --argjson total "$pending_total" --argjson security "$security_updates" --argjson reboot "$reboot_required" --argjson packages "$reboot_packages" '{checked_at:$checked,pending_total:$total,security_updates:$security,reboot_required:$reboot,reboot_packages:$packages,apt_lists_updated_at:(if $apt=="null" then null else $apt end)}')"

docker_active=false; systemctl is-active --quiet docker&&docker_active=true
container_rows="$(docker ps -a --format '{{json .}}' 2>/dev/null||true)"; total="$(grep -c . <<<"$container_rows"||true)"; running="$(grep -c '"State":"running"' <<<"$container_rows"||true)"; unhealthy="$(grep -c '(unhealthy)' <<<"$container_rows"||true)"; restart_total=0
while IFS= read -r cid;do [[ -n "$cid" ]]||continue; r="$(docker inspect "$cid" --format '{{.RestartCount}}' 2>/dev/null||printf 0)";restart_total="$((restart_total+r))";done < <(docker ps -aq 2>/dev/null)
docker_json="$(jq -cn --argjson active "$docker_active" --argjson total "${total:-0}" --argjson running "${running:-0}" --argjson unhealthy "${unhealthy:-0}" --argjson restarts "$restart_total" '{engine_active:$active,total:$total,running:$running,unhealthy:$unhealthy,restarts_total:$restarts}')"
traefik_running=false; docker ps --format '{{.Names}}'|grep -qi traefik&&traefik_running=true
https_ok_count="$(jq '[.[]|select(.https_ok==true)]|length' <<<"$targets")"; target_count="$(jq 'length' <<<"$targets")"
traefik_json="$(jq -cn --argjson running "$traefik_running" --argjson ok "$https_ok_count" --argjson total "$target_count" '{container_running:$running,https_targets_ok:$ok,https_targets_total:$total}')"
payload="$(jq -cn --arg captured "$captured_at" --argjson targets "$targets" --argjson firewall "$firewall" --argjson ssh "$ssh_json" --argjson ssh_events "$ssh_events" --argjson fail2ban "$fail2ban_json" --argjson system_updates "$system_updates_json" --argjson docker "$docker_json" --argjson traefik "$traefik_json" '{captured_at:$captured,targets:$targets,firewall:$firewall,ssh:$ssh,ssh_events:$ssh_events,fail2ban:$fail2ban,system_updates:$system_updates,docker:$docker,traefik:$traefik}')"
curl --fail-with-body --silent --show-error -X POST "$API_URL" -H "Authorization: Bearer $COLLECTOR_TOKEN" -H 'Content-Type: application/json' --data-binary "$payload"
printf '\n'




