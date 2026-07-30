import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import type { QueueRunDefaults } from "../config.js";
import type { QueueEngine } from "../queue/engine.js";
import type { Storage } from "../storage.js";
import { registerQueuePreviewRoute } from "./routes/queue-preview.js";
import { registerQueueRunRoutes } from "./routes/queue-run.js";

export interface AppDependencies {
  storage: Storage;
  engine: QueueEngine;
  /** What the instance was configured with, for whatever a request leaves out. */
  defaults: QueueRunDefaults;
  logger?: FastifyServerOptions["logger"];
}

export function buildApp({
  storage,
  engine,
  defaults,
  logger = false,
}: AppDependencies): FastifyInstance {
  const app = Fastify({ logger });

  app.get("/api/health", async () => ({
    status: "ok",
    schemaVersion: storage.schemaVersion(),
  }));

  registerQueuePreviewRoute(app, defaults);
  registerQueueRunRoutes(app, { engine, storage, defaults });

  return app;
}
