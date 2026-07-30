import type { FastifyInstance } from "fastify";

import type { Project, QueueEngine } from "../../queue/engine.js";
import { badRequest, sendError, toErrorResponse } from "../errors.js";
import { asRecord, readSourceSelection, type Read } from "../request-body.js";

const PROJECT_SHAPE =
  'A project looks like { "project": { "directory": "/path/to/repo", "verify": ["npm test"] } }';

/** Before the first run there is nothing to report but the fact that nothing is running. */
const IDLE_QUEUE = { id: null, branch: null, state: "idle", tickets: [], error: null };

/**
 * Starting and watching a queue run: the Supervisor executes the whole Queue on a
 * branch of its own, and the queue's state is readable throughout.
 */
export function registerQueueRunRoutes(app: FastifyInstance, engine: QueueEngine): void {
  app.get("/api/queue", async () => engine.current() ?? IDLE_QUEUE);

  app.post("/api/queue/start", async (request, reply) => {
    const source = readSourceSelection(request.body);
    if (!source.ok) return sendError(reply, badRequest(source.message));

    const project = readProject(request.body);
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

function readProject(body: unknown): Read<Project> {
  const project = asRecord(asRecord(body)?.project);
  if (!project) return { ok: false, message: PROJECT_SHAPE };

  const directory = project.directory;
  if (typeof directory !== "string" || directory.trim() === "") {
    return { ok: false, message: `A project needs a directory. ${PROJECT_SHAPE}` };
  }

  const verify = project.verify;
  // Without a command of its own to run, the Supervisor would be left taking
  // Claude's word for it — which is the one thing Verification exists to refuse.
  if (!Array.isArray(verify) || verify.length === 0 || !verify.every(isCommand)) {
    return {
      ok: false,
      message: `Verification needs at least one shell command, and every Attempt must pass all of them. ${PROJECT_SHAPE}`,
    };
  }

  return { ok: true, value: { directory, verify } };
}

function isCommand(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
