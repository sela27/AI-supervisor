import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import type { QueueRunDefaults } from "../config.js";
import type { QueueEngine } from "../queue/engine.js";
import type { Storage } from "../storage.js";
import type { GhCommand } from "../tickets/gh.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerQueuePreviewRoute } from "./routes/queue-preview.js";
import { registerQueueRunRoutes } from "./routes/queue-run.js";

export interface AppDependencies {
  storage: Storage;
  engine: QueueEngine;
  /** What the instance was configured with, for whatever a request leaves out. */
  defaults: QueueRunDefaults;
  /** How the Supervisor talks to GitHub, for a queue whose tickets live there. */
  gh: GhCommand;
  logger?: FastifyServerOptions["logger"];
}

export function buildApp({
  storage,
  engine,
  defaults,
  gh,
  logger = false,
}: AppDependencies): FastifyInstance {
  const app = Fastify({ logger });

  app.get("/api/health", async () => ({
    status: "ok",
    schemaVersion: storage.schemaVersion(),
  }));

  registerDashboardRoutes(app, engine);
  registerQueuePreviewRoute(app, { defaults, gh });
  registerQueueRunRoutes(app, { engine, storage, defaults });

  return app;
}
