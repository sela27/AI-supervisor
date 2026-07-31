import type { FastifyInstance } from "fastify";

import type { QueueRunDefaults } from "../../config.js";
import { asRecord } from "../../json.js";
import type { Project, QueueEngine, QueueRun } from "../../queue/engine.js";
import { currentQueue, type LiveOutputView } from "../../queue/view.js";
import type { Storage } from "../../storage.js";
import type { GhCommand } from "../../tickets/gh.js";
import { openTicketSource } from "../../tickets/source.js";
import { isVerification } from "../../verification/verifier.js";
import { badRequest, sendError, toErrorResponse } from "../errors.js";
import {
  notSupplied,
  readQueueEdit,
  readSourceSelection,
  readStartAt,
  type Read,
} from "../request-body.js";

const PROJECT_SHAPE =
  'A project looks like { "project": { "directory": "/path/to/repo", "verify": ["npm test"] } }';

export interface QueueRunDependencies {
  engine: QueueEngine;
  storage: Storage;
  /** What the instance was configured with, for whatever a start request leaves out. */
  defaults: QueueRunDefaults;
  /** How the Supervisor talks to GitHub, for a queue whose tickets live there. */
  gh: GhCommand;
}

/**
 * Starting and watching a queue run: the Supervisor executes the whole Queue on a
 * branch of its own, and the queue's state — and every Attempt's log — is readable
 * throughout.
 */
export function registerQueueRunRoutes(
  app: FastifyInstance,
  { engine, storage, defaults, gh }: QueueRunDependencies,
): void {
  app.get("/api/queue", async () => currentQueue(engine));

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
    async (request): Promise<LiveOutputView> => ({
      ticketId: request.params.ticketId,
      output: engine.liveOutput(request.params.ticketId),
    }),
  );

  app.post("/api/queue/start", async (request, reply) => {
    const source = readSourceSelection(request.body, defaults.source);
    if (!source.ok) return sendError(reply, badRequest(source.message));

    const project = readProject(request.body, defaults);
    if (!project.ok) return sendError(reply, badRequest(project.message));

    const edit = readQueueEdit(request.body);
    if (!edit.ok) return sendError(reply, badRequest(edit.message));

    const startAt = readStartAt(request.body);
    if (!startAt.ok) return sendError(reply, badRequest(startAt.message));

    try {
      const run = await engine.start({
        source: openTicketSource(source.value, gh),
        project: project.value,
        edit: edit.value,
        ...(startAt.value === undefined ? {} : { startAt: startAt.value }),
      });
      return reply.status(202).send(run);
    } catch (error) {
      return sendError(reply, toErrorResponse(error));
    }
  });

  registerControl(app, "/api/queue/pause", () => engine.pause());
  registerControl(app, "/api/queue/resume", () => engine.resume());
  registerControl(app, "/api/queue/stop", () => engine.stop());
  registerTicketControl(app, "retry", (ticketId) => engine.retry(ticketId));
  registerTicketControl(app, "skip", (ticketId) => engine.skip(ticketId));
}

/**
 * One of the run's controls. Each answers the queue as the control left it, so
 * whoever gave it sees the result of it without waiting to be told again.
 */
function registerControl(app: FastifyInstance, path: string, act: () => QueueRun): void {
  app.post(path, async (_request, reply) => {
    try {
      return act();
    } catch (error) {
      return sendError(reply, toErrorResponse(error));
    }
  });
}

function registerTicketControl(
  app: FastifyInstance,
  control: string,
  act: (ticketId: string) => QueueRun,
): void {
  app.post<{ Params: { ticketId: string } }>(
    `/api/queue/tickets/:ticketId/${control}`,
    async (request, reply) => {
      try {
        return act(request.params.ticketId);
      } catch (error) {
        return sendError(reply, toErrorResponse(error));
      }
    },
  );
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

  // Publishing is what a run is for; a project that cannot be pushed is the one
  // that has to say so.
  const pushCheckpoints = project.pushCheckpoints ?? defaults.pushCheckpoints ?? true;
  if (typeof pushCheckpoints !== "boolean") {
    return { ok: false, message: `"pushCheckpoints" must be true or false` };
  }

  // A copy, so one run's commands can never be the same array as the next run's.
  return { ok: true, value: { directory, verify: [...verify], pushCheckpoints } };
}
