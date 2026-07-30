import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import type { Storage } from "../storage.js";

export interface AppDependencies {
  storage: Storage;
  logger?: FastifyServerOptions["logger"];
}

export function buildApp({ storage, logger = false }: AppDependencies): FastifyInstance {
  const app = Fastify({ logger });

  app.get("/api/health", async () => ({
    status: "ok",
    schemaVersion: storage.schemaVersion(),
  }));

  return app;
}
