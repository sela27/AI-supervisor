import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import type { QueueEngine } from "../queue/engine.js";
import type { Storage } from "../storage.js";
import { registerQueuePreviewRoute } from "./routes/queue-preview.js";
import { registerQueueRunRoutes } from "./routes/queue-run.js";

export interface AppDependencies {
  storage: Storage;
  engine: QueueEngine;
  logger?: FastifyServerOptions["logger"];
}

export function buildApp({ storage, engine, logger = false }: AppDependencies): FastifyInstance {
  const app = Fastify({ logger });

  app.get("/api/health", async () => ({
    status: "ok",
    schemaVersion: storage.schemaVersion(),
  }));

  registerQueuePreviewRoute(app);
  registerQueueRunRoutes(app, { engine, storage });

  return app;
}
