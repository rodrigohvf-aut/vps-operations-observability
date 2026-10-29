import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { query } from "./db.js";

export async function requireDashboardUser(request: FastifyRequest, reply: FastifyReply) {
  if (!config.SUPABASE_URL || !config.SUPABASE_PUBLISHABLE_KEY) {
    return reply.code(503).send({ error: "dashboard_auth_not_configured" });
  }

  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return reply.code(401).send({ error: "unauthorized" });
  }

  const response = await fetch(`${config.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: config.SUPABASE_PUBLISHABLE_KEY,
      Authorization: authorization
    }
  });
  if (!response.ok) return reply.code(401).send({ error: "unauthorized" });

  const user = await response.json() as { id?: string };
  if (!user.id) return reply.code(401).send({ error: "unauthorized" });

  const access = await query(
    `select 1 from tenant_example.usuarios where id = $1::uuid and ativo is true limit 1`,
    [user.id]
  );
  if (!access.rowCount) return reply.code(403).send({ error: "access_denied" });
}
