#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

OUTPUT = Path(os.environ.get("OBSERVABILITY_LOG_SNAPSHOT", "/run/observability/logs.json"))
WINDOW_HOURS = 12
MAX_EVENTS = 500
UTC = timezone.utc

SECRET_PATTERNS = (
    (re.compile(r"(?i)(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._~+/=-]+"), r"\1[REMOVIDO]"),
    (re.compile(r"(?i)((?:token|password|passwd|secret|api[_-]?key|cookie)\s*[:=]\s*)[^\s,;\"']+"), r"\1[REMOVIDO]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"), "[JWT REMOVIDO]"),
)

SUSPICIOUS_PATHS = ("/wp-login.php", "/xmlrpc.php", "/.env", "/phpmyadmin", "/adminer.php")
ACCESS_LOG_PATTERN = re.compile(r'^\S+\s+(?P<ip>\S+)\s+\S+\s+\S+\s+\[[^\]]+\]\s+"(?P<method>[A-Z]+)\s+(?P<path>\S+)(?:\s+HTTP/\S+)?"\s+(?P<status>\d{3})\b')


def run(command: list[str], timeout: int = 45) -> str:
    try:
        result = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            timeout=timeout,
            check=False,
        )
        return result.stdout
    except (OSError, subprocess.TimeoutExpired) as exc:
        return f"collector command failed: {type(exc).__name__}"


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_time(value: Any) -> datetime | None:
    if value is None:
        return None
    text = str(value).strip()
    if text.isdigit() and len(text) >= 10:
        try:
            return datetime.fromtimestamp(int(text) / 1_000_000, UTC)
        except (ValueError, OSError):
            return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(UTC)
    except ValueError:
        return None


def sanitize(message: Any) -> str:
    text = " ".join(str(message or "").replace("\x00", " ").split())
    for pattern, replacement in SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    return text[:700]


def canonical(message: str) -> str:
    text = message.lower()
    text = re.sub(r"\b[0-9a-f]{8}-[0-9a-f-]{27,}\b", "<id>", text)
    text = re.sub(r"\bpid[=: ]*\d+\b", "pid", text)
    text = re.sub(r"\btid[=: ]*[a-z0-9]+\b", "tid", text)
    text = re.sub(r"\b\d+(?:\.\d+)?\s*(?:ms|seconds?|sec|s)\b", "<tempo>", text)
    return " ".join(text.split())[:400]


def bucket_five_minutes(value: datetime) -> str:
    minute = value.minute - value.minute % 5
    return value.replace(minute=minute, second=0, microsecond=0).isoformat()


def event_key(category: str, source: str, message: str, occurred: datetime) -> str:
    raw = "|".join((category, source, canonical(message), bucket_five_minutes(occurred)))
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


def sample_key(source: str, raw: str) -> str:
    return hashlib.sha256(f"{source}|{raw}".encode()).hexdigest()[:24]


def load_previous(window_start: datetime) -> tuple[list[dict[str, Any]], datetime]:
    if not OUTPUT.exists():
        return [], window_start
    try:
        payload = json.loads(OUTPUT.read_text(encoding="utf-8"))
        generated = parse_time(payload.get("generated_at")) or window_start
        events = []
        for event in payload.get("events", []):
            occurred = parse_time(event.get("last_seen_at") or event.get("occurred_at"))
            if occurred and occurred >= window_start:
                events.append(event)
        return events, max(window_start, generated - timedelta(seconds=2))
    except (OSError, ValueError, TypeError):
        return [], window_start


def add_event(
    grouped: dict[str, dict[str, Any]],
    *,
    occurred: datetime,
    severity: str,
    category: str,
    source: str,
    service: str,
    message: str,
    status: str,
    raw_id: str,
    source_ip: str | None = None,
    http_status: int | None = None,
) -> None:
    message = sanitize(message)
    if not message:
        return
    key_message = f"{message}|ip={source_ip or ''}|http={http_status or ''}"
    key = event_key(category, source, key_message, occurred)
    current = grouped.get(key)
    if current is None:
        grouped[key] = {
            "id": key,
            "occurred_at": iso(occurred),
            "last_seen_at": iso(occurred),
            "severity": severity,
            "category": category,
            "source": source,
            "service": service,
            "message": message,
            "status": status,
            "source_ip": source_ip,
            "http_status": http_status,
            "occurrences": 1,
            "_sample_ids": [raw_id],
        }
        return
    samples = current.setdefault("_sample_ids", [])
    if raw_id in samples:
        return
    samples.append(raw_id)
    if len(samples) > 100:
        del samples[:-100]
    current["occurrences"] = int(current.get("occurrences", 1)) + 1
    current["last_seen_at"] = iso(max(parse_time(current.get("last_seen_at")) or occurred, occurred))
    if current.get("category") == "incident":
        current["status"] = status
    if severity == "critical" or (severity == "error" and current.get("severity") not in ("critical",)):
        current["severity"] = severity


def collect_journal(since: datetime, grouped: dict[str, dict[str, Any]]) -> None:
    output = run([
        "journalctl", "--since", iso(since), "-p", "warning", "--no-pager", "-o", "json"
    ])
    for line in output.splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        occurred = parse_time(row.get("__REALTIME_TIMESTAMP"))
        if not occurred:
            continue
        message = sanitize(row.get("MESSAGE"))
        service = sanitize(row.get("_SYSTEMD_UNIT") or row.get("SYSLOG_IDENTIFIER") or "sistema")
        lowered = message.lower()
        priority = int(row.get("PRIORITY", 4))
        severity, category, status = ("warning", "system", "observed")
        display = message
        if service.startswith("ssh") and "kex_exchange_identification" in lowered:
            severity, category, status = ("info", "security", "blocked")
            display = "Conexão SSH encerrada antes da autenticação"
        elif any(term in lowered for term in ("out of memory", "oom-killer", "killed process")):
            severity, category, status = ("critical", "incident", "active")
        elif priority <= 3 or "failed" in lowered:
            severity, category, status = ("error", "incident", "active")
        raw_id = str(row.get("__CURSOR") or sample_key(service, line))
        add_event(grouped, occurred=occurred, severity=severity, category=category,
                  source="systemd", service=service, message=display, status=status, raw_id=raw_id)


def extract_container_line(line: str) -> tuple[datetime | None, str, str | None]:
    match = re.match(r"^(\S+)\s+(.*)$", line)
    if not match:
        return None, line, None
    occurred = parse_time(match.group(1))
    body = match.group(2)
    level = None
    if body.startswith("{"):
        try:
            payload = json.loads(body)
            level = str(payload.get("lvl") or payload.get("level") or "").upper() or None
            body = str(payload.get("msg") or payload.get("message") or "")
        except ValueError:
            pass
    return occurred, body, level


def collect_containers(since: datetime, grouped: dict[str, dict[str, Any]]) -> tuple[list[dict[str, Any]], bool]:
    names = [name for name in run(["docker", "ps", "--format", "{{.Names}}"]).splitlines() if name]
    redis_recovered = False
    for name in names:
        output = run(["docker", "logs", "--since", iso(since), "--timestamps", name], timeout=60)
        for line in output.splitlines():
            occurred, body, level = extract_container_line(line)
            if not occurred:
                continue
            clean = sanitize(body)
            lowered = clean.lower()
            if re.match(r"^F, \[.*\]\s+FATAL -- : \[[0-9a-f-]+\]$", clean):
                continue
            if "redis is online" in lowered:
                redis_recovered = True
                continue
            if not clean:
                continue
            raw_id = sample_key(name, line)
            if any(path in lowered for path in SUSPICIOUS_PATHS) or "cannot serve directory" in lowered:
                suspicious_path = next((item for item in SUSPICIOUS_PATHS if item in lowered), "diretório protegido")
                access = ACCESS_LOG_PATTERN.match(line)
                source_ip = access.group("ip") if access else None
                http_status = int(access.group("status")) if access else None
                was_blocked = "cannot serve directory" in lowered or http_status in (401, 403, 404, 405, 429)
                result = "bloqueada" if was_blocked else "observada"
                message = f"Tentativa automatizada de acessar {suspicious_path} {result}"
                if http_status is not None:
                    message += f" (HTTP {http_status})"
                add_event(grouped, occurred=occurred, severity="info", category="security",
                          source="docker", service=name, message=message,
                          status="blocked" if was_blocked else "observed", raw_id=raw_id,
                          source_ip=source_ip, http_status=http_status)
                continue
            if "actioncontroller::routingerror" in lowered:
                continue
            if "error fetching job: waited" in lowered:
                add_event(grouped, occurred=occurred, severity="warning", category="incident",
                          source="docker", service=name,
                          message="Chatwoot perdeu contato com o Redis temporariamente",
                          status="active", raw_id=raw_id)
                continue
            if "redisclient::readtimeouterror" in lowered:
                continue
            is_error = level in ("ERROR", "FATAL", "PANIC") or bool(
                re.search(r"(^|[^a-z])(error|fatal|panic|exception|oom)([^a-z]|$)", lowered)
            )
            if is_error:
                add_event(grouped, occurred=occurred, severity="error", category="incident",
                          source="docker", service=name, message=clean,
                          status="active", raw_id=raw_id)
    try:
        containers = json.loads(run(["docker", "inspect", *names])) if names else []
    except ValueError:
        containers = []
    states = []
    for item in containers:
        state = item.get("State", {})
        states.append({
            "name": str(item.get("Name", "")).lstrip("/"),
            "status": state.get("Status", "unknown"),
            "health": (state.get("Health") or {}).get("Status"),
            "restart_count": int(item.get("RestartCount") or 0),
        })
    return states, redis_recovered


def failed_services() -> list[str]:
    output = run(["systemctl", "--failed", "--plain", "--no-legend", "--no-pager"])
    services = []
    for line in output.splitlines():
        fields = line.split()
        if fields and fields[0].endswith((".service", ".mount", ".socket", ".timer")):
            services.append(fields[0])
    return services


def main() -> None:
    now = datetime.now(UTC)
    window_start = now - timedelta(hours=WINDOW_HOURS)
    previous, since = load_previous(window_start)
    grouped = {str(event["id"]): event for event in previous if event.get("id")}

    collect_journal(since, grouped)
    containers, redis_recovered = collect_containers(since, grouped)
    failures = failed_services()

    if redis_recovered:
        for event in grouped.values():
            if "Redis temporariamente" in str(event.get("message")):
                event["status"] = "recovered"

    # Log antigo não é, por si só, uma falha ativa. Exigir ausência de
    # recorrência e container em execução antes de marcar como recuperado.
    recovery_cutoff = now - timedelta(minutes=30)
    container_states = {item.get("name"): item for item in containers}
    for event in grouped.values():
        if (event.get("category") != "incident" or event.get("status") != "active"
                or event.get("source") != "docker" or event.get("severity") == "critical"):
            continue
        last_seen = parse_time(event.get("last_seen_at") or event.get("occurred_at"))
        state = container_states.get(event.get("service"), {})
        if (last_seen and last_seen < recovery_cutoff
                and state.get("status") == "running"
                and state.get("health") not in ("unhealthy", "starting")):
            event["status"] = "recovered"

    events = [
        event for event in grouped.values()
        if (parse_time(event.get("last_seen_at") or event.get("occurred_at")) or window_start) >= window_start
    ]
    events.sort(key=lambda event: event.get("last_seen_at") or event.get("occurred_at") or "", reverse=True)
    events = events[:MAX_EVENTS]

    active = [event for event in events if event.get("category") == "incident" and event.get("status") == "active"]
    incidents = [event for event in events if event.get("category") == "incident"]
    security = [event for event in events if event.get("category") == "security"]
    unhealthy = [item for item in containers if item.get("health") == "unhealthy"]
    restarted = [item for item in containers if int(item.get("restart_count") or 0) > 0]
    if failures or unhealthy or any(event.get("severity") == "critical" for event in active):
        overall = "critical"
    elif active:
        overall = "attention"
    else:
        overall = "healthy"

    payload = {
        "generated_at": iso(now),
        "window_started_at": iso(window_start),
        "window_hours": WINDOW_HOURS,
        "overall_status": overall,
        "summary": {
            "incidents": len(incidents),
            "active_incidents": len(active),
            "security_events": len(security),
            "failed_services": len(failures),
            "restarted_containers": len(restarted),
            "unhealthy_containers": len(unhealthy),
            "total_events": len(events),
        },
        "failed_service_names": failures,
        "containers": containers,
        "events": events,
    }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix="logs.", suffix=".json", dir=OUTPUT.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
        os.chmod(temporary, 0o644)
        os.replace(temporary, OUTPUT)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    main()
