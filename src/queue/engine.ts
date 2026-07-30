import { GitError, openRepository, type GitRepository } from "../git/repository.js";
import type { Runner } from "../runner/runner.js";
import { discoverLocalTickets, markLocalTicketDone } from "../tickets/local-source.js";
import type { Ticket } from "../tickets/ticket.js";
import { verify } from "../verification/verifier.js";
import { QueueRunInProgressError } from "./errors.js";
import { previewQueue } from "./preview.js";

/** `failed` is the run itself breaking down — a ticket failing still completes the run. */
export type QueueRunState = "running" | "completed" | "failed";

/**
 * `done` — the Ticket Source already reported it finished, so it is never run.
 * The rest is this run's own doing.
 */
export type TicketRunState = "done" | "pending" | "running" | "succeeded" | "failed";

export interface TicketRun {
  id: string;
  title: string;
  state: TicketRunState;
  /** The Checkpoint commit that ended this ticket, once it has one. */
  checkpoint: string | null;
  failure: string | null;
}

export interface QueueRun {
  id: string;
  branch: string;
  state: QueueRunState;
  tickets: TicketRun[];
  /** Why the run broke down, when it did. A failed ticket is not that. */
  error: string | null;
}

/** The repository a run works in, and what it takes for work in it to count. */
export interface Project {
  directory: string;
  /** Commands that must all exit 0 for an Attempt to count as succeeded. */
  verify: string[];
}

export interface QueueRunRequest {
  /** Directory of local ticket files the Queue is discovered from. */
  sourceDirectory: string;
  project: Project;
}

export interface QueueEngine {
  /** Creates the run's branch and starts executing; returns as soon as it is under way. */
  start(request: QueueRunRequest): Promise<QueueRun>;
  /** The run in progress, or the last one that finished. */
  current(): QueueRun | undefined;
}

/** One queued ticket: what the run says about it, and the ticket it was read from. */
interface Queued {
  entry: TicketRun;
  ticket: Ticket;
}

interface RunContext extends QueueRunRequest {
  repository: GitRepository;
  runner: Runner;
  queued: Queued[];
}

export function createQueueEngine(dependencies: { runner: Runner }): QueueEngine {
  let run: QueueRun | undefined;
  // Starting takes several awaits; this closes the window in which a second
  // start could slip past the check and put two runs on the same repository.
  let starting = false;

  async function begin(request: QueueRunRequest): Promise<QueueRun> {
    const preview = previewQueue(await discoverLocalTickets(request.sourceDirectory));
    const repository = await openRepository(request.project.directory);

    // A run commits everything it finds, so anything already uncommitted would be
    // swept into the first Checkpoint as if the Run had written it.
    if (await repository.isDirty()) {
      throw new GitError(
        `${request.project.directory} has uncommitted changes — commit or stash them before starting a run`,
      );
    }

    const name = await reserveRunName(repository);
    await repository.createBranch(branchOf(name));

    const queued: Queued[] = preview.tickets.map((ticket) => ({
      ticket,
      entry: {
        id: ticket.id,
        title: ticket.title,
        // Done-ness comes from the Ticket Source; the rest is this run's to fill in.
        state: ticket.state === "done" ? "done" : "pending",
        checkpoint: null,
        failure: null,
      },
    }));

    const started: QueueRun = {
      id: name,
      branch: branchOf(name),
      state: "running",
      tickets: queued.map((item) => item.entry),
      error: null,
    };
    run = started;

    void execute(started, {
      ...request,
      repository,
      runner: dependencies.runner,
      queued,
    });

    return snapshot(started);
  }

  return {
    current: () => (run ? snapshot(run) : undefined),

    start: async (request) => {
      if (starting || run?.state === "running") {
        throw new QueueRunInProgressError(
          "A queue run is already under way; stop it before starting another",
        );
      }

      starting = true;
      try {
        return await begin(request);
      } finally {
        starting = false;
      }
    },
  };
}

/**
 * Walks the Frontier one ticket at a time until nothing is left to run. A failed
 * ticket ends the run for now; deciding which dependents to skip and what to carry
 * on with is the failure path's job.
 */
async function execute(run: QueueRun, context: RunContext): Promise<void> {
  try {
    for (;;) {
      const next = nextOnFrontier(run, context.queued);
      if (!next) break;
      if ((await attempt(next, context)) === "failed") break;
    }
    run.state = "completed";
  } catch (error) {
    // The run itself broke down — the repository moved under it, the source went
    // away. Whatever the tickets say, this queue did not complete.
    run.error = error instanceof Error ? error.message : String(error);
    run.state = "failed";
  }
}

/**
 * One Attempt: a single Run of the ticket, then the Supervisor's own Verification
 * of what it left behind. Claude's own report is never enough on its own.
 */
async function attempt(queued: Queued, context: RunContext): Promise<TicketRunState> {
  const { entry, ticket } = queued;
  entry.state = "running";

  const before = await context.repository.headCommit();
  const outcome = await context.runner.run({
    ticket,
    projectDirectory: context.project.directory,
  });
  if (outcome.status === "failed") return fail(entry, outcome.reason);

  if ((await context.repository.headCommit()) === before) {
    return fail(entry, "the attempt finished without making a commit");
  }

  const verification = await verify(context.project.verify, context.project.directory);
  if (!verification.ok) return fail(entry, verification.failure);

  await markLocalTicketDone(context.sourceDirectory, ticket.id);
  // The write-back, and anything the Run left uncommitted, ride along in the
  // Checkpoint. Ticket files kept outside the repository cannot; there the Run's
  // own last commit is what ends the ticket.
  const swept = await context.repository.commitEverything(`Checkpoint: ${ticket.title}`);
  entry.checkpoint = swept ?? (await context.repository.headCommit());
  entry.state = "succeeded";
  return "succeeded";
}

function fail(entry: TicketRun, reason: string): TicketRunState {
  entry.state = "failed";
  entry.failure = reason;
  return "failed";
}

/** The first ticket still waiting whose blockers have all finished. */
function nextOnFrontier(run: QueueRun, queued: Queued[]): Queued | undefined {
  const finished = new Set(run.tickets.filter(hasFinished).map((entry) => entry.id));

  return queued.find(
    (item) =>
      item.entry.state === "pending" && item.ticket.blockedBy.every((id) => finished.has(id)),
  );
}

function hasFinished(entry: TicketRun): boolean {
  return entry.state === "done" || entry.state === "succeeded";
}

/** The run's state as it stands, detached so nothing the run does changes it afterwards. */
function snapshot(run: QueueRun): QueueRun {
  return { ...run, tickets: run.tickets.map((ticket) => ({ ...ticket })) };
}

function branchOf(name: string): string {
  return `supervisor/${name}`;
}

/** A branch of its own per run, so overnight work never lands on the user's branch. */
async function reserveRunName(repository: GitRepository): Promise<string> {
  const base = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");

  for (let suffix = 1; ; suffix += 1) {
    const name = suffix === 1 ? base : `${base}-${suffix}`;
    if (!(await repository.branchExists(branchOf(name)))) return name;
  }
}
