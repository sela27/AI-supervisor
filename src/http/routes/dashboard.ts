import type { FastifyInstance } from "fastify";

import type { QueueEngine } from "../../queue/engine.js";
import { watchQueue, type QueueChange } from "../../queue/watch.js";
import { DASHBOARD_PAGE } from "../dashboard/page.js";

/**
 * The dashboard and the stream that keeps it live. The page is served by the
 * Supervisor itself, on the same port as the API, so an instance is one address
 * to open rather than a service and a site to deploy separately.
 */
export function registerDashboardRoutes(app: FastifyInstance, engine: QueueEngine): void {
  app.get("/", async (_request, reply) =>
    reply.type("text/html; charset=utf-8").send(DASHBOARD_PAGE),
  );

  // Every stream still open, so shutting the Supervisor down does not wait on
  // readers who would happily hold their connection until morning.
  const watchers = new Set<() => void>();
  app.addHook("preClose", async () => {
    for (const hangUp of [...watchers]) hangUp();
  });

  app.get("/api/events", (request, reply) => {
    reply.hijack();
    const stream = reply.raw;
    stream.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      // A proxy that buffered this, or a browser that cached it, would be a
      // dashboard that shows the night as it was rather than as it is.
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });

    const stopWatching = watchQueue(engine, (change) => {
      stream.write(frame(change));
    });

    const hangUp = (): void => {
      // Both the reader leaving and the Supervisor stopping end up here; whichever
      // gets there first is the one that ends the stream.
      if (!watchers.delete(hangUp)) return;
      stopWatching();
      stream.end();
    };

    watchers.add(hangUp);
    request.raw.on("close", hangUp);
  });
}

function frame(change: QueueChange): string {
  return `event: ${change.event}\ndata: ${JSON.stringify(change.data)}\n\n`;
}
