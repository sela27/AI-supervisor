import type { FastifyInstance } from "fastify";

import type { QueueRunDefaults } from "../../config.js";
import { asRecord } from "../../json.js";
import type { Project, QueueEngine } from "../../queue/engine.js";
import type { Storage } from "../../storage.js";
import { isVerification } from "../../verification/verifier.js";
import { badRequest, sendError, toErrorResponse } from "../errors.js";
import { notSupplied, readSourceSelection, type Read } from "../request-body.js";

const PROJECT_SHAPE =
  'A project looks like { "project": { "directory": "/path/to/repo", "verify": ["npm test"] } }';

/** Before the first run there is nothing to report but the fact that nothing is running. */
const IDLE_QUEUE = { id: null, branch: null, state: "idle", tickets: [], error: null };

export interface QueueRunDependencies {
  engine: QueueEngine;
  storage: Storage;
  /** What the instance was configured with, for whatever a start request leaves out. */
  defaults: QueueRunDefaults;
}

/**
 * Starting and watching a queue run: the Supervisor executes the whole Queue on a
 * branch of its own, and the queue's state — and every Attempt's log — is readable
 * throughout.
 */
export function registerQueueRunRoutes(
  app: FastifyInstance,
  { engine, storage, defaults }: QueueRunDependencies,
): void {
  app.get("/api/queue", async () => engine.current() ?? IDLE_QUEUE);

  // Attempt logs outlive the working tree they were made in, so a failed ticket
  // can still be read about after its work was reset away.
  app.get<{ Params: { ticketId: string } }>(
    "/api/queue/tickets/:ticketId/attempts",
    async (request) => {
      const run = engine.current();
      return run ? storage.attemptsFor(run.id, request.params.ticketId) : [];
    },
  );

  // The Attempt in flight, as it happens: the log is only complete once the
  // Attempt has ended, and by then the Run may have been going for an hour.
  app.get<{ Params: { ticketId: string } }>(
    "/api/queue/tickets/:ticketId/output",
    async (request) => ({
      ticketId: request.params.ticketId,
      output: engine.liveOutput(request.params.ticketId),
    }),
  );

  app.post("/api/queue/start", async (request, reply) => {
    const source = readSourceSelection(request.body, defaults.sourceDirectory);
    if (!source.ok) return sendError(reply, badRequest(source.message));

    const project = readProject(request.body, defaults);
    if (!project.ok) return sendError(reply, badRequest(project.message));

    try {
      const run = await engine.start({
        sourceDirectory: source.value,
        project: project.value,
      });
      return reply.status(202).send(run);
    } catch (error) {
      return sendError(reply, toErrorResponse(error));
    }
  });
}

/** The request's project, falling back setting by setting to the configured one. */
function readProject(body: unknown, defaults: QueueRunDefaults): Read<Project> {
  const named = asRecord(body)?.project;
  // Nothing said about the project is a request to use the configured one; a
  // project written as something other than a project is a mistake.
  const project = named === undefined ? {} : asRecord(named);
  if (!project) return { ok: false, message: PROJECT_SHAPE };

  const directory = project.directory ?? defaults.projectDirectory;
  if (typeof directory !== "string" || directory.trim() === "") {
    return { ok: false, message: notSupplied("A project needs a directory", PROJECT_SHAPE) };
  }

  const verify = project.verify ?? defaults.verify;
  if (!isVerification(verify)) {
    return {
      ok: false,
      message: notSupplied(
        "Verification needs at least one shell command, and every Attempt must pass all of them",
        PROJECT_SHAPE,
      ),
    };
  }

  // A copy, so one run's commands can never be the same array as the next run's.
  return { ok: true, value: { directory, verify: [...verify] } };
}
