import type { FastifyReply } from "fastify";

import { GitError } from "../git/repository.js";
import { QueueRunInProgressError } from "../queue/errors.js";
import { TicketSourceError, type TicketProblem } from "../tickets/errors.js";

export interface ErrorBody {
  error: string;
  /** The individual faults behind the error, when it has more than one. */
  problems: TicketProblem[];
}

export interface ErrorResponse {
  status: number;
  body: ErrorBody;
}

export function badRequest(message: string): ErrorResponse {
  return { status: 400, body: { error: message, problems: [] } };
}

export function sendError(reply: FastifyReply, response: ErrorResponse): FastifyReply {
  return reply.status(response.status).send(response.body);
}

/**
 * Turns the failures a caller can do something about into a response. Anything
 * else is rethrown: it is a bug in the Supervisor, not a bad request, and Fastify
 * answers it with a 500.
 */
export function toErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof TicketSourceError) {
    return { status: 400, body: { error: error.message, problems: [...error.problems] } };
  }
  if (error instanceof GitError) return badRequest(error.message);
  if (error instanceof QueueRunInProgressError) {
    return { status: 409, body: { error: error.message, problems: [] } };
  }
  throw error;
}
