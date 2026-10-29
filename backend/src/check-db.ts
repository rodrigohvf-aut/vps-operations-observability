import { db, query } from "./db.js";

const expectedTables = [
  "backup_runs", "clients", "container_samples", "database_samples",
  "error_events", "restore_tests", "schema_samples", "security_samples", "table_samples", "token_usage", "vps_samples", "workflow_execution_daily", "workflow_execution_hourly"
];

try {
  const [database, tables, privileges] = await Promise.all([
    query<{ database: string; version: string }>("select current_database() database, version() version"),
    query<{ table_name: string }>("select table_name from information_schema.tables where table_schema='vps_tracking' order by table_name"),
    query<{ can_use_schema: boolean }>("select has_schema_privilege(current_user, 'vps_tracking', 'usage') can_use_schema")
  ]);
  const found = tables.rows.map((row) => row.table_name);
  const missing = expectedTables.filter((table) => !found.includes(table));
  console.log(JSON.stringify({
    connected: true,
    database: database.rows[0]?.database,
    postgres: database.rows[0]?.version.split(" ").slice(0, 2).join(" "),
    schema: "vps_tracking",
    schema_access: privileges.rows[0]?.can_use_schema ?? false,
    tables_found: found,
    tables_missing: missing,
    ready: missing.length === 0 && privileges.rows[0]?.can_use_schema === true
  }, null, 2));
} catch (error) {
  const value = error as { code?: string; message?: string };
  console.error(JSON.stringify({ connected: false, code: value.code, error: value.message }, null, 2));
  process.exitCode = 1;
} finally {
  await db.end();
}
