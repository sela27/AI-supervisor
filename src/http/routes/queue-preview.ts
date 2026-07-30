import type { FastifyInstance } from "fastify";

import { previewQueue } from "../../queue/preview.js";
import { TicketSourceError } from "../../tickets/errors.js";
import { discoverLocalTickets } from "../../tickets/local-source.js";

const BODY_SHAPE =
  'Request body must be JSON like { "source": { "type": "local", "directory": "/path/to/tickets" } }';

/**
 * Shows the Queue a Ticket Source would produce — every ticket in dependency
 * order, plus the Frontier — so the user sees what would run before anything does.
 */
export function registerQueuePreviewRoute(app: FastifyInstance): void {
  app.post("/api/queue/preview", async (request, reply) => {
    const selection = readSourceSelection(request.body);
    if (!selection.ok) {
      return reply.status(400).send({ error: selection.message, problems: [] });
    }

    try {
      return previewQueue(await discoverLocalTickets(selection.directory));
    } catch (error) {
      if (error instanceof TicketSourceError) {
        return reply.status(400).send({ error: error.message, problems: error.problems });
      }
      throw error;
    }
  });
}

type SourceSelection = { ok: true; directory: string } | { ok: false; message: string };

function readSourceSelection(body: unknown): SourceSelection {
  const source = asRecord(asRecord(body)?.source);
  if (!source) return { ok: false, message: BODY_SHAPE };

  if (source.type !== "local") {
    return {
      ok: false,
      message: `Unknown ticket source type ${JSON.stringify(source.type)} — only "local" is supported`,
    };
  }

  const directory = source.directory;
  if (typeof directory !== "string" || directory.trim() === "") {
    return { ok: false, message: `A local ticket source needs a directory. ${BODY_SHAPE}` };
  }

  return { ok: true, directory };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
