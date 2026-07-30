import { messageOf } from "../errors.js";
import { GitError, openRepository, type GitRepository } from "../git/repository.js";
import type { RunOutcome, Runner, SettledRun } from "../runner/runner.js";
import type { Storage } from "../storage.js";
import {
  discoverLocalTickets,
  markLocalTicketDone,
  markLocalTicketFailed,
} from "../tickets/local-source.js";
import type { Ticket } from "../tickets/ticket.js";
import { verify } from "../verification/verifier.js";
import { QueueRunInProgressError, UsageLimitError } from "./errors.js";
import { previewQueue } from "./preview.js";

/**
 * `failed` is the run itself breaking down — a ticket failing still completes the
 * run. `paused-on-limit` is the usage limit stopping it, which is not a failure
 * of anything; the run is picked up again once the limit has lifted.
 */
export type QueueRunState = "running" | "completed" | "failed" | "paused-on-limit";

/**
 * `done` — the Ticket Source already reported it finished, so it is never run.
 * `skipped` — a ticket it was waiting on failed, so it never will be. The rest is
 * this run's own doing.
 */
export type TicketRunState =
  | "done"
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

export interface TicketRun {
  id: string;
  title: string;
  state: TicketRunState;
  /** The Checkpoint commit that ended this ticket, once it has one. */
  checkpoint: string | null;
  /** Why it did not succeed: the Attempt's failure, or the blocker that stopped it. */
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
  /**
   * What the Attempt in flight has printed so far — the only view of a Run while
   * it is still going. Empty for any ticket but the one being attempted.
   */
  liveOutput(ticketId: string): string;
}

/** The Attempt being watched: whose it is, and what it has printed so far. */
interface LiveOutput {
  ticketId: string | null;
  lines: string[];
}

/** One queued ticket: what the run says about it, and the ticket it was read from. */
interface Queued {
  entry: TicketRun;
  ticket: Ticket;
}

interface RunContext extends QueueRunRequest {
  run: QueueRun;
  repository: GitRepository;
  runner: Runner;
  storage: Storage;
  queued: Queued[];
  live: LiveOutput;
  /**
   * Where a failed Attempt is thrown back to: this run's last Checkpoint, or the
   * commit recording the last failure, whichever came later. Never an Attempt's
   * own work — that is exactly what the reset is for.
   */
  restorePoint: string;
}

export interface QueueEngineDependencies {
  runner: Runner;
  /** Where Attempt logs are kept — out of the repository the failure path resets. */
  storage: Storage;
}

export function createQueueEngine(dependencies: QueueEngineDependencies): QueueEngine {
  let run: QueueRun | undefined;
  // Kept out of the run's own state: it is written line by line as a Run talks,
  // and it must not be copied into every snapshot the API hands out.
  const live: LiveOutput = { ticketId: null, lines: [] };
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

    void execute({
      ...request,
      run: started,
      repository,
      runner: dependencies.runner,
      storage: dependencies.storage,
      queued,
      live,
      restorePoint: await repository.headCommit(),
    });

    return snapshot(started);
  }

  return {
    current: () => (run ? snapshot(run) : undefined),

    liveOutput: (ticketId) => (live.ticketId === ticketId ? live.lines.join("\n") : ""),

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
 * ticket takes its dependents out of the queue with it, and the run carries on
 * with whatever was never waiting on it.
 */
async function execute(context: RunContext): Promise<void> {
  try {
    for (;;) {
      const next = nextOnFrontier(context.queued);
      if (!next) break;
      await attempt(next, context);
    }
    context.run.state = "completed";
  } catch (error) {
    context.run.error = messageOf(error);
    // A usage limit is not a breakdown: nothing is wrong, there is just no quota
    // left to spend. Everything else — the repository moving under the run, the
    // source going away — means this queue did not complete.
    context.run.state = error instanceof UsageLimitError ? "paused-on-limit" : "failed";
  }
}

/**
 * One Attempt: a single Run of the ticket, then the Supervisor's own Verification
 * of what it left behind. Claude's own report is never enough on its own.
 */
async function attempt(queued: Queued, context: RunContext): Promise<void> {
  const { entry, ticket } = queued;
  entry.state = "running";

  const before = await context.repository.headCommit();
  // The Attempt in flight becomes the one being watched; the last one's output
  // stands until then, so a watcher never finds an empty log mid-handover.
  context.live.ticketId = ticket.id;
  context.live.lines = [];

  const outcome = await context.runner.run({
    ticket,
    projectDirectory: context.project.directory,
    onOutput: (chunk) => context.live.lines.push(chunk),
  });

  if (outcome.status === "limit-hit") {
    await discardOnLimit(queued, outcome, context);
    return;
  }

  const refusal = await verificationRefusal(outcome, before, context);
  // The log is written down before anything else, because the reset that follows
  // a failure is the last chance to have it.
  context.storage.recordAttempt({
    runId: context.run.id,
    ticketId: ticket.id,
    outcome: refusal === undefined ? "succeeded" : "failed",
    failure: refusal?.reason ?? null,
    output: joined(outcome.output, refusal?.output),
  });

  if (refusal !== undefined) {
    await failTicket(queued, refusal.reason, context);
    return;
  }

  await markLocalTicketDone(context.sourceDirectory, ticket.id);
  // The write-back, and anything the Run left uncommitted, ride along in the
  // Checkpoint. Ticket files kept outside the repository cannot; there the Run's
  // own last commit is what ends the ticket.
  const swept = await context.repository.commitEverything(`Checkpoint: ${ticket.title}`);
  entry.checkpoint = swept ?? (await context.repository.headCommit());
  context.restorePoint = entry.checkpoint;
  entry.state = "succeeded";
}

/**
 * A usage limit is not the ticket's doing, so nothing is held against it: the
 * half-finished Attempt is thrown back like any other, but the ticket goes back
 * on the Frontier untouched and nothing is written to the Ticket Source.
 *
 * The queue then stops at Paused-on-limit. Waiting the limit out and picking the
 * run up again by itself is not built yet, so for now the wait is the user's —
 * but a limit is never allowed to read as a ticket that failed.
 */
async function discardOnLimit(
  queued: Queued,
  outcome: Extract<RunOutcome, { status: "limit-hit" }>,
  context: RunContext,
): Promise<void> {
  context.storage.recordAttempt({
    runId: context.run.id,
    ticketId: queued.ticket.id,
    outcome: "limit-hit",
    failure: null,
    output: outcome.output,
  });

  await context.repository.resetTo(context.restorePoint);
  queued.entry.state = "pending";

  throw new UsageLimitError(
    `the subscription's usage limit stopped the run${liftsAt(outcome.resetAt)}. ` +
      `${queued.ticket.id} was not attempted; start the run again once the limit has lifted.`,
    outcome.resetAt,
  );
}

function liftsAt(resetAt: Date | null): string {
  return resetAt === null ? "" : `, and lifts at ${resetAt.toISOString()}`;
}

/** Why Verification refused an Attempt, and what the refusing check printed. */
interface Refusal {
  reason: string;
  output: string;
}

/**
 * Verification: the Supervisor's own reading of what the Attempt left behind, owing
 * nothing to what the Run said about itself. Nothing back means the Attempt stands.
 */
async function verificationRefusal(
  outcome: SettledRun,
  before: string,
  context: RunContext,
): Promise<Refusal | undefined> {
  if (outcome.status === "failed") return { reason: outcome.reason, output: "" };

  if ((await context.repository.headCommit()) === before) {
    return { reason: "the attempt finished without making a commit", output: "" };
  }

  const verification = await verify(context.project.verify, context.project.directory);
  if (verification.ok) return undefined;
  return { reason: verification.failure, output: verification.output };
}

/**
 * Gives up on a ticket: the Attempt's half-work goes back to the restore point, the
 * failure is written back to the ticket, and everything that was waiting on this
 * ticket is taken out of the queue.
 */
async function failTicket(queued: Queued, reason: string, context: RunContext): Promise<void> {
  queued.entry.state = "failed";
  queued.entry.failure = reason;

  await context.repository.resetTo(context.restorePoint);
  await markLocalTicketFailed(context.sourceDirectory, queued.ticket.id, reason);
  // Committing the write-back is what ends the ticket cleanly: the branch is left
  // with nothing uncommitted, so the next ticket's Checkpoint stays its own work
  // and the next reset cannot rewind this record away. Ticket files kept outside
  // the repository leave nothing to commit, and the restore point simply stands.
  const recorded = await context.repository.commitEverything(`Failed: ${queued.ticket.title}`);
  context.restorePoint = recorded ?? context.restorePoint;

  skipDependents(context);
}

/** Everything worth keeping about an Attempt, in the order it happened. */
function joined(...parts: (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part !== "").join("\n");
}

/**
 * Marks everything a failure has doomed. One pass suffices: the queue is in
 * dependency order, so a ticket is only reached after every blocker it names.
 */
function skipDependents(context: RunContext): void {
  const stopped = new Set(
    context.queued
      .filter(({ entry }) => entry.state === "failed" || entry.state === "skipped")
      .map(({ entry }) => entry.id),
  );

  for (const { entry, ticket } of context.queued) {
    if (entry.state !== "pending") continue;

    const blocker = ticket.blockedBy.find((id) => stopped.has(id));
    if (blocker === undefined) continue;

    entry.state = "skipped";
    entry.failure = `${blocker} did not succeed, so this ticket was never attempted`;
    stopped.add(entry.id);
  }
}

/** The first ticket still waiting whose blockers have all finished. */
function nextOnFrontier(queued: Queued[]): Queued | undefined {
  const finished = new Set(
    queued.filter(({ entry }) => hasFinished(entry)).map(({ entry }) => entry.id),
  );

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
