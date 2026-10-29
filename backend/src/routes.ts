import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { query } from "./db.js";
import { parsePeriod } from "./period.js";
import { config } from "./config.js";
import { z } from "zod";
import { requireDashboardUser } from "./dashboard-auth.js";

const S = "vps_tracking";
const LOG_SNAPSHOT_PATH = "/run/observability/logs.json";

const metric = z.number().finite().nonnegative();
const percent = metric.max(100);
const ingestVpsSchema = z.object({
  captured_at: z.string().datetime().optional(),
  vps: z.object({
    cpu_percent: percent,
    ram_used_mb: metric,
    ram_total_mb: metric.positive(),
    ram_percent: percent,
    disk_used_gb: metric,
    disk_total_gb: metric.positive(),
    disk_percent: percent,
    ram_free_gb: metric,
    disk_free_gb: metric,
    swap_percent: percent,
    load_1m: metric,
    load_5m: metric,
    load_15m: metric,
    uptime_seconds: z.number().int().nonnegative()
  }),
  containers: z.array(z.object({
    container_id: z.string().min(1).max(128),
    container_name: z.string().min(1).max(255),
    cpu_percent: metric,
    memory_used_mb: metric,
    memory_limit_mb: metric,
    memory_percent: percent,
    network_rx_mb: metric,
    network_tx_mb: metric,
    block_read_mb: metric,
    block_write_mb: metric
  })).max(500),
  disk_usage: z.array(z.object({
    category: z.string().min(1).max(255),
    path: z.string().min(1).max(500),
    item_name: z.string().min(1).max(255).optional(),
    item_count: z.number().int().nonnegative().nullable().optional(),
    details: z.string().max(1000).nullable().optional(),
    size_bytes: z.number().int().nonnegative(),
    percent_of_used: percent
  })).max(250).default([])
});

const backupStatus = z.enum(["running", "success", "late", "failed"]);
const ingestBackupsSchema = z.object({
  backups: z.array(z.object({
    job_name: z.string().min(1).max(255),
    scheduled_at: z.string().datetime(),
    finished_at: z.string().datetime().optional(),
    size_bytes: z.number().int().nonnegative(),
    retention_days: z.number().int().nonnegative(),
    destination: z.string().min(1).max(500),
    status: backupStatus,
    integrity_verified: z.boolean(),
    error_message: z.string().max(2000).optional()
  })).min(1).max(50)
});

const ingestAutomationSchema = z.object({
  collected_at: z.string().datetime().optional(),
  platform: z.string().min(1).max(50).default("n8n"),
  instance_name: z.string().min(1).max(255),
  total_executions: z.number().int().nonnegative(),
  successful_executions: z.number().int().nonnegative(),
  failed_executions: z.number().int().nonnegative(),
  running_executions: z.number().int().nonnegative(),
  execution_data_bytes: z.number().int().nonnegative(),
  database_bytes: z.number().int().nonnegative(),
  oldest_execution_at: z.string().datetime().nullable(),
  newest_execution_at: z.string().datetime().nullable()
});

const ingestWorkflowExecutionsSchema = z.object({
  client_slug: z.string().min(1).max(100),
  workflows: z.array(z.object({
    bucket_hour: z.string().datetime(),
    workflow_id: z.string().min(1).max(255),
    workflow_name: z.string().min(1).max(500),
    total_executions: z.number().int().nonnegative(),
    successful_executions: z.number().int().nonnegative(),
    failed_executions: z.number().int().nonnegative(),
    running_executions: z.number().int().nonnegative()
  })).max(10_000)
});

const securityTargetSchema = z.object({
  host: z.string().min(1).max(255),
  resolved_ip: z.string().max(100),
  dns_ok: z.boolean(),
  https_ok: z.boolean(),
  http_status: z.number().int().nonnegative().max(599),
  latency_ms: z.number().nonnegative(),
  ssl_expires_at: z.string().datetime().nullable(),
  ssl_days_remaining: z.number().int().nullable()
});

const ingestSecuritySchema = z.object({
  captured_at: z.string().datetime().optional(),
  targets: z.array(securityTargetSchema).max(100),
  firewall: z.record(z.unknown()),
  ssh: z.record(z.unknown()),
  ssh_events: z.array(z.object({
    event_key: z.string().min(1).max(128),
    occurred_at: z.string().datetime(),
    source_ip: z.string().min(1).max(100),
    source_port: z.number().int().min(1).max(65535).nullable().optional(),
    username: z.string().max(255).nullable().optional(),
    auth_method: z.string().max(50).nullable().optional(),
    outcome: z.enum(["failed", "accepted"]),
    event_type: z.string().min(1).max(100)
  })).max(10_000).default([]),
  fail2ban: z.record(z.unknown()),
  system_updates: z.record(z.unknown()),
  docker: z.record(z.unknown()),
  traefik: z.record(z.unknown())
});

const ingestRestoreTestsSchema = z.object({
  tests: z.array(z.object({
    job_name: z.string().min(1).max(255),
    backup_file: z.string().min(1).max(500),
    tested_at: z.string().datetime(),
    status: z.enum(["success", "failed"]),
    duration_seconds: z.number().int().nonnegative(),
    size_bytes: z.number().int().nonnegative(),
    checks: z.record(z.unknown()),
    error_message: z.string().max(4000).nullable().optional()
  })).min(1).max(10)
});

function collectorAuthorized(authorization: string | undefined) {
  return Boolean(config.COLLECTOR_TOKEN && authorization === `Bearer ${config.COLLECTOR_TOKEN}`);
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function routes(app: FastifyInstance) {
  app.get("/health", async () => {
    await query("select 1");
    return { status: "ok", service: "observability-control-api", timestamp: new Date().toISOString() };
  });

  app.addHook("preHandler", async (request, reply) => {
    if (request.method !== "GET" || !request.url.startsWith("/api/v1/")) return;
    return requireDashboardUser(request, reply);
  });

  app.get("/api/v1/clients", async () => {
    const result = await query(`select id, name, slug, schema_name from ${S}.clients where active order by name`);
    return { data: result.rows };
  });

  app.post("/api/v1/ingest/vps", async (request, reply) => {
    if (!config.COLLECTOR_TOKEN) return reply.code(503).send({ error: "collector_not_configured" });
    if (!collectorAuthorized(request.headers.authorization)) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const parsed = ingestVpsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", details: parsed.error.flatten() });
    const { vps, containers } = parsed.data;
    const capturedAt = parsed.data.captured_at ?? new Date().toISOString();

    await query(`insert into ${S}.vps_samples
      (captured_at,cpu_percent,ram_used_mb,ram_total_mb,ram_percent,disk_used_gb,disk_total_gb,disk_percent,ram_free_gb,disk_free_gb,swap_percent,load_1m,load_5m,load_15m,uptime_seconds)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [capturedAt,vps.cpu_percent,vps.ram_used_mb,vps.ram_total_mb,vps.ram_percent,vps.disk_used_gb,vps.disk_total_gb,vps.disk_percent,vps.ram_free_gb,vps.disk_free_gb,vps.swap_percent,vps.load_1m,vps.load_5m,vps.load_15m,vps.uptime_seconds]);

    for (const item of containers) {
      await query(`insert into ${S}.container_samples
        (captured_at,container_id,container_name,cpu_percent,memory_used_mb,memory_limit_mb,memory_percent,network_rx_mb,network_tx_mb,block_read_mb,block_write_mb)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [capturedAt,item.container_id,item.container_name,item.cpu_percent,item.memory_used_mb,item.memory_limit_mb,item.memory_percent,item.network_rx_mb,item.network_tx_mb,item.block_read_mb,item.block_write_mb]);
    }

    for (const item of parsed.data.disk_usage) {
      await query(`insert into ${S}.disk_usage_samples
        (captured_at,category,path,item_name,item_count,details,size_bytes,percent_of_used)
        values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [capturedAt,item.category,item.path,item.item_name ?? item.path,item.item_count ?? null,item.details ?? null,item.size_bytes,item.percent_of_used]);
    }

    return reply.code(201).send({
      stored: true,
      captured_at: capturedAt,
      containers: containers.length,
      disk_usage: parsed.data.disk_usage.length
    });
  });

  app.post("/api/v1/ingest/security", async (request, reply) => {
    if (!config.COLLECTOR_TOKEN) return reply.code(503).send({ error: "collector_not_configured" });
    if (!collectorAuthorized(request.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    const parsed = ingestSecuritySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", details: parsed.error.flatten() });
    const capturedAt = parsed.data.captured_at ?? new Date().toISOString();
    await query(`insert into ${S}.security_samples (captured_at,targets,firewall,ssh,fail2ban,system_updates,docker,traefik)
      values ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)`,
      [capturedAt,JSON.stringify(parsed.data.targets),JSON.stringify(parsed.data.firewall),JSON.stringify(parsed.data.ssh),JSON.stringify(parsed.data.fail2ban),JSON.stringify(parsed.data.system_updates),JSON.stringify(parsed.data.docker),JSON.stringify(parsed.data.traefik)]);

    if (parsed.data.ssh_events.length) {
      await query(`insert into ${S}.ssh_access_events
        (event_key,occurred_at,source_ip,source_port,username,auth_method,outcome,event_type)
        select x.event_key,x.occurred_at::timestamptz,x.source_ip::inet,x.source_port,x.username,x.auth_method,x.outcome,x.event_type
        from jsonb_to_recordset($1::jsonb) as x(
          event_key text,occurred_at text,source_ip text,source_port integer,
          username text,auth_method text,outcome text,event_type text
        )
        on conflict (event_key) do nothing`,
        [JSON.stringify(parsed.data.ssh_events)]);
    }

    return reply.code(201).send({
      stored: true,
      captured_at: capturedAt,
      targets: parsed.data.targets.length,
      ssh_events_received: parsed.data.ssh_events.length
    });
  });

  app.post("/api/v1/ingest/restore-tests", async (request, reply) => {
    if (!config.COLLECTOR_TOKEN) return reply.code(503).send({ error: "collector_not_configured" });
    if (!collectorAuthorized(request.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    const parsed = ingestRestoreTestsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", details: parsed.error.flatten() });
    for (const test of parsed.data.tests) {
      await query(`insert into ${S}.restore_tests
        (job_name,backup_file,tested_at,status,duration_seconds,size_bytes,checks,error_message)
        values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [test.job_name,test.backup_file,test.tested_at,test.status,test.duration_seconds,test.size_bytes,JSON.stringify(test.checks),test.error_message ?? null]);
      if (test.status === "success") {
        await query(`update ${S}.backup_runs set restore_tested_at=$1
          where id=(select id from ${S}.backup_runs where job_name=$2 and status='success' order by scheduled_at desc limit 1)`,
          [test.tested_at,test.job_name]);
      }
    }
    await query(`delete from ${S}.restore_tests where tested_at < now() - interval '60 days'`);
    return reply.code(201).send({ stored: true, received: parsed.data.tests.length });
  });

  app.post("/api/v1/ingest/backups", async (request, reply) => {
    if (!config.COLLECTOR_TOKEN) return reply.code(503).send({ error: "collector_not_configured" });
    if (!collectorAuthorized(request.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    const parsed = ingestBackupsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", details: parsed.error.flatten() });

    let stored = 0;
    for (const backup of parsed.data.backups) {
      const updated = await query(`update ${S}.backup_runs set
        finished_at=$3,size_bytes=$4,retention_days=$5,destination=$6,status=$7,integrity_verified=$8,error_message=$9
        where job_name=$1 and scheduled_at=$2 returning id`,
        [backup.job_name,backup.scheduled_at,backup.finished_at ?? null,backup.size_bytes,backup.retention_days,backup.destination,backup.status,backup.integrity_verified,backup.error_message ?? null]);
      if (!updated.rowCount) {
        await query(`insert into ${S}.backup_runs
          (job_name,scheduled_at,finished_at,size_bytes,retention_days,destination,status,integrity_verified,error_message)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [backup.job_name,backup.scheduled_at,backup.finished_at ?? null,backup.size_bytes,backup.retention_days,backup.destination,backup.status,backup.integrity_verified,backup.error_message ?? null]);
      }
      stored += 1;
    }
    return reply.code(201).send({ stored: true, inserted: stored, received: parsed.data.backups.length });
  });

  app.post("/api/v1/ingest/automation", async (request, reply) => {
    if (!config.COLLECTOR_TOKEN) return reply.code(503).send({ error: "collector_not_configured" });
    if (!collectorAuthorized(request.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    const parsed = ingestAutomationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", details: parsed.error.flatten() });
    const item = parsed.data;
    const collectedAt = item.collected_at ?? new Date().toISOString();
    await query(`insert into ${S}.automation_samples
      (collected_at,platform,instance_name,total_executions,successful_executions,failed_executions,running_executions,execution_data_bytes,database_bytes,oldest_execution_at,newest_execution_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [collectedAt,item.platform,item.instance_name,item.total_executions,item.successful_executions,item.failed_executions,item.running_executions,item.execution_data_bytes,item.database_bytes,item.oldest_execution_at,item.newest_execution_at]);
    await query(`select * from ${S}.purge_old_monitoring_data(60)`);
    return reply.code(201).send({ stored: true, collected_at: collectedAt });
  });

  app.post("/api/v1/ingest/workflow-executions", async (request, reply) => {
    if (!config.COLLECTOR_TOKEN) return reply.code(503).send({ error: "collector_not_configured" });
    if (!collectorAuthorized(request.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    const parsed = ingestWorkflowExecutionsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", details: parsed.error.flatten() });

    const client = await query<{ id: string }>(`select id from ${S}.clients where slug=$1 and active limit 1`, [parsed.data.client_slug]);
    const clientId = client.rows[0]?.id;
    if (!clientId) return reply.code(404).send({ error: "client_not_found" });

    let stored = 0;
    for (const workflow of parsed.data.workflows) {
      const result = await query(`insert into ${S}.workflow_execution_hourly
        (client_id,bucket_hour,workflow_id,workflow_name,total_executions,successful_executions,failed_executions,running_executions,collected_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,now())
        on conflict (client_id,bucket_hour,workflow_id) do update set
          workflow_name=excluded.workflow_name,
          total_executions=excluded.total_executions,
          successful_executions=excluded.successful_executions,
          failed_executions=excluded.failed_executions,
          running_executions=excluded.running_executions,
          collected_at=now()
        returning id`, [clientId,workflow.bucket_hour,workflow.workflow_id,workflow.workflow_name,workflow.total_executions,workflow.successful_executions,workflow.failed_executions,workflow.running_executions]);
      stored += result.rowCount ?? 0;
    }
    return reply.code(201).send({ stored: true, workflows: stored, client: parsed.data.client_slug });
  });

  app.post("/api/v1/ingest/database", async (request, reply) => {
    if (!config.COLLECTOR_TOKEN) return reply.code(503).send({ error: "collector_not_configured" });
    if (!collectorAuthorized(request.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    const collectedAt = new Date().toISOString();
    const [clients, database] = await Promise.all([
      query<{ id: string; schema_name: string }>(`select id, schema_name::text from ${S}.clients where active order by name`),
      query<{ database_name: string; size_bytes: string; connection_count: number; connection_limit: number }>(`
        select current_database() database_name,
          pg_database_size(current_database())::text size_bytes,
          (select count(*)::int from pg_stat_activity where datname=current_database()) connection_count,
          current_setting('max_connections')::int connection_limit`)
    ]);
    const db = database.rows[0];
    if (!db) throw new Error("database metrics unavailable");
    const limitBytes = config.DATABASE_LIMIT_MB ? Math.round(config.DATABASE_LIMIT_MB * 1024 * 1024) : null;
    const usedPercent = limitBytes ? Math.round((Number(db.size_bytes) * 100000) / limitBytes) / 1000 : null;
    await query(`insert into ${S}.database_samples
      (collected_at,database_name,size_bytes,limit_bytes,used_percent,connection_count,connection_limit,schema_count)
      values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [collectedAt,db.database_name,db.size_bytes,limitBytes,usedPercent,db.connection_count,db.connection_limit,clients.rows.length]);

    let tablesStored = 0;
    for (const client of clients.rows) {
      const schema = await query<{ size_bytes: string; table_count: number }>(`
        select coalesce(sum(pg_total_relation_size(c.oid)),0)::text size_bytes, count(*)::int table_count
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname=$1 and c.relkind in ('r','p')`, [client.schema_name]);
      const schemaMetrics = schema.rows[0];
      if (!schemaMetrics) throw new Error(`schema metrics unavailable: ${client.schema_name}`);
      await query(`insert into ${S}.schema_samples
        (collected_at,client_id,schema_name,size_bytes,table_count,connection_count)
        values ($1,$2,$3,$4,$5,null)`,
        [collectedAt,client.id,client.schema_name,schemaMetrics.size_bytes,schemaMetrics.table_count]);

      const tables = await query<{ table_name: string; table_bytes: string; index_bytes: string; estimated_rows: string }>(`
        select c.relname table_name, pg_table_size(c.oid)::text table_bytes,
          pg_indexes_size(c.oid)::text index_bytes, greatest(c.reltuples,0)::bigint::text estimated_rows
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname=$1 and c.relkind in ('r','p') order by pg_total_relation_size(c.oid) desc`, [client.schema_name]);
      for (const table of tables.rows) {
        await query(`insert into ${S}.table_samples
          (collected_at,client_id,schema_name,table_name,table_bytes,index_bytes,estimated_rows)
          values ($1,$2,$3,$4,$5,$6,$7)`,
          [collectedAt,client.id,client.schema_name,table.table_name,table.table_bytes,table.index_bytes,table.estimated_rows]);
        tablesStored += 1;
      }
    }
    return reply.code(201).send({ stored: true, collected_at: collectedAt, schemas: clients.rows.length, tables: tablesStored });
  });

  app.post("/api/v1/ingest/errors", async (request, reply) => {
    if (!config.COLLECTOR_TOKEN) return reply.code(503).send({ error: "collector_not_configured" });
    if (!collectorAuthorized(request.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });

    const clients = await query<{ id: string; slug: string; schema_name: string }>(
      `select id, slug, schema_name::text from ${S}.clients where active order by name`
    );
    const results: Array<{ client: string; source_table: boolean; inserted: number }> = [];
    let inserted = 0;

    for (const client of clients.rows) {
      const sourceTable = `${client.schema_name}.erros`;
      const exists = await query<{ exists: boolean }>("select to_regclass($1) is not null as exists", [sourceTable]);
      if (!exists.rows[0]?.exists) {
        results.push({ client: client.slug, source_table: false, inserted: 0 });
        continue;
      }

      const source = `${quoteIdentifier(client.schema_name)}.${quoteIdentifier("erros")}`;
      const result = await query(`insert into ${S}.error_events
        (client_id,occurred_at,severity,source,workflow_name,error_code,message,fingerprint,resolved_at,metadata)
        select $1,
          coalesce(e.ocorrido_em,e.criado_em,now()),
          case
            when lower(coalesce(e.severidade,'')) in ('critical','critico','critica','crítico','crítica','fatal') then 'critical'::${S}.error_severity
            when lower(coalesce(e.severidade,'')) in ('warning','warn','aviso','alerta') then 'warning'::${S}.error_severity
            when lower(coalesce(e.severidade,'')) in ('info','informacao','informação') then 'info'::${S}.error_severity
            else 'error'::${S}.error_severity
          end,
          coalesce(nullif(e.plataforma,''),'n8n'),
          nullif(e.workflow_nome,''),
          nullif(e.ultimo_node,''),
          coalesce(nullif(e.mensagem,''),nullif(e.descricao,''),'Erro sem mensagem'),
          $2 || e.id::text,
          e.resolvido_em,
          jsonb_strip_nulls(jsonb_build_object(
            'source_id',e.id,
            'execution_id',e.execucao_id,
            'execution_url',e.execucao_url,
            'last_node',e.ultimo_node,
            'mode',e.modo,
            'status',e.status,
            'description',e.descricao,
            'stack',e.stack,
            'data',e.dados,
            'resolved_by',e.resolvido_por,
            'note',e.observacao,
            'source_schema',$3::text
          ))
        from ${source} e
        where not exists (
          select 1 from ${S}.error_events target
          where target.client_id=$1 and target.fingerprint=$2 || e.id::text
        )`, [client.id, `${client.schema_name}:erros:`, client.schema_name]);

      const count = result.rowCount ?? 0;
      inserted += count;
      results.push({ client: client.slug, source_table: true, inserted: count });
    }

    return reply.code(201).send({ stored: true, inserted, clients: results });
  });

  app.get("/api/v1/automation", async (request) => {
    const { from, to } = parsePeriod(request.query);
    const [latest, series] = await Promise.all([
      query(`select * from ${S}.automation_samples where collected_at between $1 and $2 order by collected_at desc limit 1`, [from, to]),
      query(`select collected_at,instance_name,total_executions,successful_executions,failed_executions,running_executions,execution_data_bytes,database_bytes from ${S}.automation_samples where collected_at between $1 and $2 order by collected_at`, [from, to])
    ]);
    return { summary: latest.rows[0] ?? null, series: series.rows };
  });

  app.get("/api/v1/vps", async (request) => {
    const { from, to } = parsePeriod(request.query);
    const [summary, series, containers, diskUsage] = await Promise.all([
      query(`select avg(cpu_percent) cpu_avg, avg(ram_percent) ram_avg, avg(disk_percent) disk_avg, avg(load_5m) load_avg, min(captured_at) first_sample, max(captured_at) last_sample from ${S}.vps_samples where captured_at between $1 and $2`, [from, to]),
      query(`select captured_at, cpu_percent, ram_percent, disk_percent, swap_percent, load_5m, ram_free_gb, disk_free_gb from ${S}.vps_samples where captured_at between $1 and $2 order by captured_at`, [from, to]),
      query(`select container_name, cpu_percent, memory_percent, captured_at from ${S}.container_samples where captured_at between $1 and $2 order by captured_at desc, container_name limit 5000`, [from, to]),
      query(`select category,path,item_name,item_count,details,size_bytes,percent_of_used,captured_at
        from ${S}.disk_usage_samples
        where captured_at=(select max(captured_at) from ${S}.disk_usage_samples)
        order by size_bytes desc`)
    ]);
    return { summary: summary.rows[0], series: series.rows, containers: containers.rows, disk_usage: diskUsage.rows };
  });

  app.get("/api/v1/security", async (request) => {
    const { from, to } = parsePeriod(request.query);
    const [latest, series, restore, restoreHistory, sshEvents, sshOffenders] = await Promise.all([
      query(`select captured_at,targets,firewall,ssh,fail2ban,system_updates,docker,traefik from ${S}.security_samples order by captured_at desc limit 1`),
      query(`select ss.captured_at,
        (select count(*) from jsonb_array_elements(ss.targets) x where (x->>'https_ok')::boolean) targets_online,
        jsonb_array_length(ss.targets) targets_total,
        (select count(*) from ${S}.ssh_access_events e
          where e.outcome='failed'
            and e.occurred_at > ss.captured_at - interval '1 hour'
            and e.occurred_at <= ss.captured_at) failed_logins_interval,
        (select count(*) from ${S}.ssh_access_events e
          where e.outcome='accepted'
            and e.occurred_at > ss.captured_at - interval '1 hour'
            and e.occurred_at <= ss.captured_at) accepted_logins_interval,
        coalesce((ss.fail2ban->>'currently_banned')::int,0) currently_banned,
        coalesce((ss.docker->>'unhealthy')::int,0) unhealthy_containers
        from ${S}.security_samples ss where ss.captured_at between $1 and $2 order by ss.captured_at`, [from,to]),
      query(`select (select max(tested_at) from ${S}.restore_tests where status='success') last_restore_tested_at,max(finished_at) filter (where status='success') last_successful_backup_at,(select count(*) from ${S}.restore_tests where status='success') tested_backups from ${S}.backup_runs`),
      query(`select id,job_name,backup_file,tested_at,status,duration_seconds,size_bytes,checks,error_message
        from ${S}.restore_tests where tested_at >= now() - interval '28 days' order by tested_at desc,job_name`),
      query(`select id,occurred_at,source_ip::text source_ip,source_port,username,auth_method,outcome,event_type
        from ${S}.ssh_access_events
        where occurred_at between $1 and $2
        order by occurred_at desc limit 1000`, [from,to]),
      query(`select source_ip::text source_ip,
          count(*) filter (where outcome='failed') failed_attempts,
          count(*) filter (where outcome='accepted') accepted_attempts,
          min(occurred_at) first_seen_at,max(occurred_at) last_seen_at
        from ${S}.ssh_access_events
        where occurred_at between $1 and $2
        group by source_ip
        order by failed_attempts desc,last_seen_at desc limit 100`, [from,to])
    ]);
    return {
      latest: latest.rows[0] ?? null,
      series: series.rows,
      restore: restore.rows[0],
      restore_history: restoreHistory.rows,
      ssh_events: sshEvents.rows,
      ssh_offenders: sshOffenders.rows
    };
  });

  app.get("/api/v1/logs", async (_request, reply) => {
    try {
      const raw = await readFile(LOG_SNAPSHOT_PATH, "utf8");
      const snapshot = JSON.parse(raw) as Record<string, unknown>;

      const events = Array.isArray(snapshot.events)
        ? snapshot.events.map((event) => {
            if (!event || typeof event !== "object") return event;
            const { _sample_ids: _internalSampleIds, ...publicEvent } =
              event as Record<string, unknown>;
            return publicEvent;
          })
        : [];

      return {
        ...snapshot,
        events
      };
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return {
          generated_at: null,
          window_hours: 12,
          overall_status: "unavailable",
          summary: {
            incidents: 0,
            active_incidents: 0,
            security_events: 0,
            failed_services: 0,
            restarted_containers: 0,
            unhealthy_containers: 0,
            total_events: 0
          },
          failed_service_names: [],
          events: []
        };
      }

      _request.log.error({ err: error }, "Falha ao ler o resumo local de logs");
      return reply.code(503).send({ error: "logs_unavailable" });
    }
  });

  app.get("/api/v1/backups", async (request) => {
    const { from, to } = parsePeriod(request.query);
    const [summary, executions, jobs, daily] = await Promise.all([
      query(`select count(*) executions, count(*) filter (where status='success') succeeded, count(*) filter (where status='late') late, count(*) filter (where status='failed') failed, round(100.0 * count(*) filter (where status='success') / nullif(count(*),0), 2) success_rate from ${S}.backup_runs where scheduled_at between $1 and $2`, [from, to]),
      query(`select id, job_name, scheduled_at, started_at, finished_at, duration_seconds, size_bytes, retention_days, status, integrity_verified from ${S}.backup_runs where scheduled_at between $1 and $2 order by scheduled_at`, [from, to]),
      query(`select distinct job_name from ${S}.backup_runs order by job_name`),
      query(`select date_trunc('day',scheduled_at) bucket_day,count(*) expected,count(*) filter (where status='success') succeeded,count(*) filter (where status in ('failed','late')) failed,round(100.0*count(*) filter (where status='success')/nullif(count(*),0),2) success_rate from ${S}.backup_runs where scheduled_at between $1 and $2 group by 1 order by 1`, [from, to])
    ]);
    return { summary: summary.rows[0], executions: executions.rows, jobs: jobs.rows, daily: daily.rows };
  });

  app.get("/api/v1/database", async (request) => {
    const { from, to, client } = parsePeriod(request.query);
    const values: unknown[] = [from, to];
    const filter = client ? "and c.slug = $3" : "";
    if (client) values.push(client);
    const [database, databaseSeries, schemas, tables] = await Promise.all([
      query(`select avg(used_percent) used_percent_avg, max(size_bytes) size_bytes, max(connection_count) connections, max(schema_count) schemas from ${S}.database_samples where collected_at between $1 and $2`, [from, to]),
      query(`select distinct on (date_trunc('day',collected_at)) date_trunc('day',collected_at) bucket_day,collected_at,size_bytes,limit_bytes,coalesce(used_percent,100.0*size_bytes/nullif(limit_bytes,0),100.0*size_bytes/524288000.0) used_percent,connection_count,schema_count from ${S}.database_samples where collected_at between $1 and $2 order by date_trunc('day',collected_at),collected_at desc`, [from, to]),
      query(`select s.collected_at, c.id client_id, c.name client_name, c.slug, s.schema_name, s.size_bytes, s.table_count, s.connection_count from ${S}.schema_samples s join ${S}.clients c on c.id=s.client_id where s.collected_at between $1 and $2 ${filter} order by s.collected_at, c.name`, values),
      query(`select distinct on (c.id,t.table_name) t.collected_at,c.id client_id,c.name client_name,c.slug,t.schema_name,t.table_name,t.table_bytes,t.index_bytes,t.total_bytes,t.estimated_rows from ${S}.table_samples t join ${S}.clients c on c.id=t.client_id where t.collected_at between $1 and $2 ${filter} order by c.id,t.table_name,t.collected_at desc`, values)
    ]);
    return { summary: database.rows[0], series: databaseSeries.rows, schemas: schemas.rows, tables: tables.rows };
  });

  app.get("/api/v1/tokens", async (request) => {
    const { from, to, client } = parsePeriod(request.query);
    const values: unknown[] = [from, to];
    const filter = client ? "and c.slug = $3" : "";
    if (client) values.push(client);
    const result = await query(`select (t.occurred_at at time zone 'UTC')::date as bucket_day, c.id as client_id, c.name as client_name, c.slug,t.provider,t.model, sum(t.input_tokens) as input_tokens, sum(t.output_tokens) as output_tokens, sum(t.cached_tokens) as cached_tokens, sum(t.input_tokens+t.output_tokens) as total_tokens, sum(coalesce((t.metadata->>'requests')::bigint,1)) as requests, sum(t.cost_brl) as cost_brl from ${S}.token_usage t join ${S}.clients c on c.id=t.client_id where (t.occurred_at at time zone 'UTC')::date between ($1::timestamptz at time zone 'America/Sao_Paulo')::date and ($2::timestamptz at time zone 'America/Sao_Paulo')::date ${filter} group by 1,c.id,c.name,c.slug,t.provider,t.model order by 1,c.name,t.model`, values);
    return { data: result.rows };
  });

  app.get("/api/v1/errors", async (request) => {
    const { from, to, client } = parsePeriod(request.query);
    const values: unknown[] = [from, to];
    const filter = client ? "and c.slug = $3" : "";
    if (client) values.push(client);
    const [summary, workflows, executionSeries, hourlyWorkflows, errorSummary, series, events, errorsLast12h, templatesLast12h] = await Promise.all([
      query(`select coalesce(sum(w.total_executions),0) total_executions,
        coalesce(sum(w.successful_executions),0) successful_executions,
        coalesce(sum(w.failed_executions),0) failed_executions,
        coalesce(sum(w.running_executions),0) running_executions,
        round(100.0*coalesce(sum(w.failed_executions),0)/nullif(sum(w.total_executions),0),2) error_rate
        from ${S}.workflow_execution_hourly w join ${S}.clients c on c.id=w.client_id
        where w.bucket_hour between $1 and $2 ${filter}`, values),
      query(`select c.id client_id,c.name client_name,c.slug,w.workflow_id,max(w.workflow_name) workflow_name,
        sum(w.total_executions) total_executions,sum(w.successful_executions) successful_executions,
        sum(w.failed_executions) failed_executions,sum(w.running_executions) running_executions,
        round(100.0*sum(w.failed_executions)/nullif(sum(w.total_executions),0),2) error_rate,
        max(w.bucket_hour) as last_measurement_at
        from ${S}.workflow_execution_hourly w join ${S}.clients c on c.id=w.client_id
        where w.bucket_hour between $1 and $2 ${filter}
        group by c.id,c.name,c.slug,w.workflow_id order by error_rate desc nulls last,total_executions desc`, values),
      query(`select (w.bucket_hour at time zone 'America/Sao_Paulo')::date bucket_hour,c.id client_id,c.name client_name,c.slug,
        sum(w.total_executions) total_executions,sum(w.successful_executions) successful_executions,
        sum(w.failed_executions) failed_executions
        from ${S}.workflow_execution_hourly w join ${S}.clients c on c.id=w.client_id
        where w.bucket_hour between $1 and $2 ${filter}
        group by 1,c.id,c.name,c.slug order by 1,c.name`, values),
      query(`select (w.bucket_hour at time zone 'America/Sao_Paulo')::date bucket_hour,c.id as client_id,c.name as client_name,c.slug,w.workflow_id,max(w.workflow_name) workflow_name,
        sum(w.total_executions) total_executions,sum(w.successful_executions) successful_executions,sum(w.failed_executions) failed_executions,sum(w.running_executions) running_executions,
        round(100.0*sum(w.failed_executions)/nullif(sum(w.total_executions),0),2) as error_rate
        from ${S}.workflow_execution_hourly w join ${S}.clients c on c.id=w.client_id
        where w.bucket_hour between $1 and $2 ${filter}
        group by 1,c.id,c.name,c.slug,w.workflow_id order by 1 desc,c.name,workflow_name limit 5000`, values),
      query(`select count(*) errors,
        count(*) filter (where e.severity='critical') critical,
        count(*) filter (where e.severity='warning') warnings,
        count(*) filter (where e.severity='error') errors_standard,
        count(*) filter (where e.resolved_at is not null) resolved,
        count(*) filter (where e.resolved_at is null) unresolved
        from ${S}.error_events e join ${S}.clients c on c.id=e.client_id
        where e.occurred_at between $1 and $2 ${filter}`, values),
      query(`select (e.occurred_at at time zone 'America/Sao_Paulo')::date as bucket_hour, c.id client_id, c.name client_name, c.slug,
        count(*) errors, count(*) filter (where e.severity='critical') critical,
        count(*) filter (where e.severity='warning') warnings
        from ${S}.error_events e join ${S}.clients c on c.id=e.client_id
        where e.occurred_at between $1 and $2 ${filter}
        group by 1,c.id,c.name,c.slug order by 1,c.name`, values),
      query(`select e.id,e.occurred_at,e.severity,e.source,e.workflow_name,e.error_code,e.message,e.resolved_at,e.metadata,
        c.id client_id,c.name client_name,c.slug
        from ${S}.error_events e join ${S}.clients c on c.id=e.client_id
        where e.occurred_at between $1 and $2 ${filter}
        order by e.occurred_at desc limit 100`, values),
      query(`select date_trunc('hour',e.occurred_at) bucket_hour,count(*) errors
        from ${S}.error_events e join ${S}.clients c on c.id=e.client_id
        where e.occurred_at >= greatest($1::timestamptz,$2::timestamptz-interval '12 hours') and e.occurred_at <= $2 ${filter}
        group by 1 order by 1`, values),
      query(`select coalesce(e.workflow_name,'Sem workflow') workflow_name,count(*) errors,max(e.occurred_at) last_error_at
        from ${S}.error_events e join ${S}.clients c on c.id=e.client_id
        where e.occurred_at >= greatest($1::timestamptz,$2::timestamptz-interval '12 hours') and e.occurred_at <= $2 ${filter}
        group by 1 order by errors desc,workflow_name limit 20`, values)
    ]);
    return { summary: summary.rows[0], workflows: workflows.rows, execution_series: executionSeries.rows, hourly_workflows: hourlyWorkflows.rows, error_summary: errorSummary.rows[0], data: series.rows, events: events.rows, errors_last_12h: errorsLast12h.rows, templates_last_12h: templatesLast12h.rows };
  });
}







