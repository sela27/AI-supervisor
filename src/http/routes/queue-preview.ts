import type { FastifyInstance } from "fastify";

import type { QueueRunDefaults } from "../../config.js";
import { previewQueue } from "../../queue/preview.js";
import type { GhCommand } from "../../tickets/gh.js";
import { openTicketSource } from "../../tickets/source.js";
import { badRequest, sendError, toErrorResponse } from "../errors.js";
import { readQueueEdit, readSourceSelection } from "../request-body.js";

export interface QueuePreviewDependencies {
  /** What the instance was configured with, for whatever a request leaves out. */
  defaults: QueueRunDefaults;
  /** How the Supervisor talks to GitHub, for a queue whose tickets live there. */
  gh: GhCommand;
}

/**
 * Shows the Queue a Ticket Source would produce — every ticket in dependency
 * order, plus the Frontier — so the user sees what would run before anything does.
 * An edit is carried out here too, so what the user leaves out or moves is seen
 * before it is committed to rather than discovered once the run is under way.
 */
export function registerQueuePreviewRoute(
  app: FastifyInstance,
  { defaults, gh }: QueuePreviewDependencies,
): void {
  app.post("/api/queue/preview", async (request, reply) => {
    const source = readSourceSelection(request.body, defaults.source);
    if (!source.ok) return sendError(reply, badRequest(source.message));

    const edit = readQueueEdit(request.body);
    if (!edit.ok) return sendError(reply, badRequest(edit.message));

    try {
      return previewQueue(await openTicketSource(source.value, gh).discover(), edit.value);
    } catch (error) {
      return sendError(reply, toErrorResponse(error));
    }
  });
}
