import pg from "pg";
import { config } from "./config.js";

export const db = new pg.Pool({
  connectionString: config.DATABASE_URL,
  ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});

export async function query<T extends pg.QueryResultRow>(text: string, values: unknown[] = []) {
  return db.query<T>(text, values);
}
