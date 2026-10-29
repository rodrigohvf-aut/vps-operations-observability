import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3333),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z.enum(["true", "false"]).default("false"),
  DATABASE_LIMIT_MB: z.coerce.number().positive().optional(),
  CORS_ORIGIN: z.string().default("http://localhost:8080"),
  COLLECTOR_TOKEN: z.string().min(32).optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(20).optional()
});

const parsed = schema.parse(process.env);
export const config = { ...parsed, DATABASE_SSL: parsed.DATABASE_SSL === "true" };
