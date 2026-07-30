import type { FastifyInstance } from "fastify";

import type { QueueRunDefaults } from "../../config.js";
import { previewQueue } from "../../queue/preview.js";
import { discoverLocalTickets } from "../../tickets/local-source.js";
import { badRequest, sendError, toErrorResponse } from "../errors.js";
import { readSourceSelection } from "../request-body.js";

/**
 * Shows the Queue a Ticket Source would produce — every ticket in dependency
 * order, plus the Frontier — so the user sees what would run before anything does.
 */
export function registerQueuePreviewRoute(app: FastifyInstance, defaults: QueueRunDefaults): void {
  app.post("/api/queue/preview", async (request, reply) => {
    const source = readSourceSelection(request.body, defaults.sourceDirectory);
    if (!source.ok) return sendError(reply, badRequest(source.message));

    try {
      return previewQueue(await discoverLocalTickets(source.value));
    } catch (error) {
      return sendError(reply, toErrorResponse(error));
    }
  });
}
