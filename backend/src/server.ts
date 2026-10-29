import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { db } from "./db.js";
import { routes } from "./routes.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: config.CORS_ORIGIN.split(",").map((item) => item.trim()) });
await app.register(routes);

const shutdown = async () => {
  await app.close();
  await db.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host: config.HOST, port: config.PORT });
