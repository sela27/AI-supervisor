import type { Clock } from "../clock.js";
import { messageOf } from "../errors.js";
import type { EventSink, SupervisorEvent } from "../events.js";
import { GitError, openRepository, type GitRepository } from "../git/repository.js";
import type { RunOutcome, Runner, SettledRun } from "../runner/runner.js";
import type { AttemptRecord, Storage } from "../storage.js";
import type { TicketSource } from "../tickets/source.js";
import type { Ticket } from "../tickets/ticket.js";
import { verify } from "../verification/verifier.js";
import { downstreamOf } from "./dependents.js";
import type { QueueEdit } from "./edit.js";
import {
  QueueControlError,
  QueueRunInProgressError,
  TicketNotInQueueError,
  UsageLimitError,
} from "./errors.js";
import { isLongWait, nextLookAt } from "./limit-wait.js";
import { previewQueue } from "./preview.js";
import { runsUntil, safetyStopReached, type RunSoFar, type SafetyStops } from "./safety.js";

/**
 * `failed` is the run itself breaking down — a ticket failing still completes the
 * run. `paused` and `stopped` are the user's doing, a Safety stop included;
 * `paused-on-limit` is the usage limit's, which is not a failure of anything and
 * which the run picks itself up from. All three leave the run exactly where it
 * stood. `armed` is a run that has not begun at all: it has its branch and its
 * Queue, and it is waiting for the hour it was told to start at.
 */
export type QueueRunState =
  | "armed"
  | "running"
  | "paused"
  | "stopped"
  | "completed"
  | "failed"
  | "paused-on-limit";

/**
 * What the user has told the run to do at the next ticket boundary. An Attempt
 * under way is never interrupted — the Run it is driving cannot be asked to stop
 * half-way — so a control given mid-ticket stands here until the ticket ends.
 */
export type QueueInstruction = "pause" | "stop";

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
  /**
   * How many Attempts the run has recorded for this ticket, the ones a usage limit
   * cut short included. A ticket stays `running` across its every retry, so this is
   * the only thing that says a watcher has a new Attempt to read.
   */
  attempts: number;
}

export interface QueueRun {
  id: string;
  branch: string;
  state: QueueRunState;
  tickets: TicketRun[];
  /** What the run has been told to do and has not yet reached a boundary to do. */
  instruction: QueueInstruction | null;
  /**
   * When a run that is not working means to be — the hour a limit wait ends, or
   * the hour an armed run was told to begin at. An ISO timestamp, so what the API
   * says and what the run is doing cannot drift apart in the telling.
   */
  resumeAt: string | null;
  /** Why the run broke down, when it did. A failed ticket is not that. */
  error: string | null;
  /**
   * Which Safety stop ended the run, when one did. The user's own stop leaves
   * this empty: they were there, and they know why.
   */
  stoppedBy: string | null;
  /** Why Checkpoints are not reaching the remote, while they are not. */
  pushFailure: string | null;
}

/** The repository a run works in, and what it takes for work in it to count. */
export interface Project {
  directory: string;
  /** Commands that must all exit 0 for an Attempt to count as succeeded. */
  verify: string[];
  /** Whether each Checkpoint is published; off for a project with no remote. */
  pushCheckpoints: boolean;
}

export interface QueueRunRequest {
  /** The one Ticket Source this queue is discovered from and written back to. */
  source: TicketSource;
  project: Project;
  /** What the user left out of the Queue, and the order they want it run in. */
  edit: QueueEdit;
  /**
   * The hour to begin at, for a run armed in the evening for the night. Left out,
   * the run begins the moment it is started. An hour already gone by is no wait
   * at all — refusing a request a minute late would be worse than running it.
   */
  startAt?: Date;
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
  /** Asks the run to stop at the next ticket boundary and stay where it is. */
  pause(): QueueRun;
  /**
   * Puts a paused run back to work where it left off. A run that has been asked
   * to pause but has not got there yet is simply told to carry on, and one
   * waiting out a usage limit is told to try now rather than at the stated hour.
   */
  resume(): QueueRun;
  /** Ends the run at the next ticket boundary. Nothing picks it up again. */
  stop(): QueueRun;
  /** Gives a failed ticket another go, and its skipped dependents theirs. */
  retry(ticketId: string): QueueRun;
  /** Takes a ticket that has yet to run out of the run, its dependents with it. */
  skip(ticketId: string): QueueRun;
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
  /**
   * Whether the user took this ticket out themselves. A ticket skipped only
   * because something it was waiting on failed is owed another go when that
   * ticket gets one; a ticket the user took out is not — their decision outlives
   * whatever happened to the queue after it.
   */
  takenOut: boolean;
  /**
   * Whether the Ticket Source is currently carrying this ticket's failure. Only a
   * ticket that has one has anything to take back off it, and a source is written
   * to over the network as readily as into a file beside the code.
   */
  failureRecorded: boolean;
}

/** Why a ticket the user took out of a run in progress is not going to run. */
const SKIPPED_BY_HAND = "the user took it out of the queue, so it was never attempted";

/**
 * The usage limit the run is currently sitting through: when it first stopped the
 * run, and whether anybody has been told it is a long one. Both outlive any single
 * wait, because a limit that named no reset time is waited out in half-hour looks
 * and it is the whole spell that is long, not each look at it.
 */
interface LimitSpell {
  since: Date;
  announced: boolean;
}

/**
 * The three things a user can leave a waiting run in: at work early, held where
 * it stands, or over. Completing and failing are not among them — a run that is
 * waiting is between tickets, with nothing under way to end either way.
 */
type WaitEnding = "running" | "paused" | "stopped";

/** A wait under way — for a limit to lift, or for an armed run's own hour. */
interface Wait {
  wake(): void;
  /**
   * What the user told the run while it was waiting. Nothing means the wait ran
   * its course and the run is free to carry on.
   */
  told: WaitEnding | undefined;
}

interface RunContext extends QueueRunRequest {
  run: QueueRun;
  repository: GitRepository;
  runner: Runner;
  storage: Storage;
  clock: Clock;
  /** Where the moments worth telling somebody about go. */
  onEvent: EventSink;
  queued: Queued[];
  live: LiveOutput;
  /**
   * The wait in flight, while the run is sitting one out. It is also what says a
   * loop is alive without the run being `running`, so nothing starts a second
   * loop over a run that is only waiting.
   */
  waiting: Wait | undefined;
  /** The limit the run is sitting through, while it is sitting through one. */
  limit: LimitSpell | undefined;
  /** How many Attempts a ticket may spend before the run gives up on it. */
  attemptBudget: number;
  /** How far this run may go on its own before it gives up and leaves the rest. */
  safety: SafetyStops;
  /**
   * The hour the run has still to wait for before it begins, while it has one.
   * Taken off as soon as the waiting is over however it ended, so a run picked up
   * again later is never armed a second time.
   */
  startAt: Date | undefined;
  /**
   * When the run began working, which is what its allowed time is measured from.
   * Not the moment it was started: a run armed at six for midnight spent none of
   * its night waiting for midnight. Unset until the waiting, if any, is over.
   */
  startedAt: Date | undefined;
  /** Tickets this run has run. One a usage limit interrupted is not among them. */
  ticketsRun: number;
  /** How many tickets have failed since the last one that did not. */
  failuresInARow: number;
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
  /** Time, which a limit wait is made of. Tests move it by hand. */
  clock: Clock;
  /** Where the moments worth telling somebody about go. */
  onEvent: EventSink;
  /**
   * How many Attempts one ticket gets. One is a Supervisor that never retries;
   * anything more spends the extra goes on tickets that were refused, each told
   * what refused the last one.
   */
  attemptBudget: number;
  /** How far one run may go on its own before it stops and leaves the rest. */
  safety: SafetyStops;
}

export function createQueueEngine(dependencies: QueueEngineDependencies): QueueEngine {
  // The whole run, not just what it reports: the controls act on a run that has
  // stopped executing, so what it takes to pick it up again has to outlive the loop.
  let context: RunContext | undefined;
  // Kept out of the run's own state: it is written line by line as a Run talks,
  // and it must not be copied into every snapshot the API hands out.
  const live: LiveOutput = { ticketId: null, lines: [] };
  // Starting takes several awaits; this closes the window in which a second
  // start could slip past the check and put two runs on the same repository.
  let starting = false;

  async function begin(request: QueueRunRequest): Promise<QueueRun> {
    // The user's edit is carried out before anything is created, so an impossible
    // queue is refused rather than started and then found to be stuck.
    const preview = previewQueue(await request.source.discover(), request.edit);
    const repository = await openRepository(request.project.directory);
    await refuseUncommitted(repository, request.project.directory);

    const name = await reserveRunName(repository);
    await repository.createBranch(branchOf(name));

    const queued: Queued[] = preview.tickets.map((ticket) => ({
      ticket,
      takenOut: false,
      failureRecorded: false,
      entry: {
        id: ticket.id,
        title: ticket.title,
        // Done-ness comes from the Ticket Source; the rest is this run's to fill in.
        state: ticket.state === "done" ? "done" : "pending",
        checkpoint: null,
        failure: null,
        attempts: 0,
      },
    }));

    const started: QueueRun = {
      id: name,
      branch: branchOf(name),
      // Everything a run needs is settled here whether or not it begins here: a
      // run armed for midnight is refused now, while the user is still looking,
      // rather than found to be impossible at midnight.
      state: request.startAt === undefined ? "running" : "armed",
      tickets: queued.map((item) => item.entry),
      instruction: null,
      resumeAt: request.startAt?.toISOString() ?? null,
      error: null,
      stoppedBy: null,
      pushFailure: null,
    };

    context = {
      ...request,
      run: started,
      repository,
      runner: dependencies.runner,
      storage: dependencies.storage,
      clock: dependencies.clock,
      onEvent: dependencies.onEvent,
      queued,
      live,
      waiting: undefined,
      limit: undefined,
      attemptBudget: dependencies.attemptBudget,
      safety: dependencies.safety,
      startAt: request.startAt,
      startedAt: undefined,
      ticketsRun: 0,
      failuresInARow: 0,
      restorePoint: await repository.headCommit(),
    };
    // Said before a single ticket is attempted: a queue holding work nothing in it
    // could ever release should say so while the user is still looking at it.
    skipDependents(context);
    void execute(context);

    return snapshot(started);
  }

  /** The run a control is about to act on, or the reason there is nothing to act on. */
  function runToControl(): RunContext {
    if (!context) throw new QueueControlError("No queue run has been started yet");
    return context;
  }

  return {
    current: () => (context ? snapshot(context.run) : undefined),

    liveOutput: (ticketId) => (live.ticketId === ticketId ? live.lines.join("\n") : ""),

    start: async (request) => {
      // A paused run is still a run: starting over it would strand a night's work
      // on a branch nobody was told about.
      if (starting || (context !== undefined && isUnderWay(context.run.state))) {
        throw new QueueRunInProgressError(
          "A queue run is already under way; resume or stop it before starting another",
        );
      }

      starting = true;
      try {
        return await begin(request);
      } finally {
        starting = false;
      }
    },

    pause: () => snapshot(instruct(runToControl(), "pause")),
    stop: () => snapshot(instruct(runToControl(), "stop")),
    resume: () => snapshot(resumeRun(runToControl())),
    retry: (ticketId) => snapshot(retryTicket(runToControl(), ticketId)),
    skip: (ticketId) => snapshot(skipTicket(runToControl(), ticketId)),
  };
}

/** Whether the run is one the user could still pick up, so not one to start over. */
function isUnderWay(state: QueueRunState): boolean {
  return (
    state === "armed" ||
    state === "running" ||
    state === "paused" ||
    state === "paused-on-limit"
  );
}

/**
 * Refuses a project with work lying about in it. A run commits everything it
 * finds, so anything already uncommitted would be swept into the first Checkpoint
 * as if the Run had written it.
 */
async function refuseUncommitted(repository: GitRepository, directory: string): Promise<void> {
  if (!(await repository.isDirty())) return;

  throw new GitError(
    `${directory} has uncommitted changes — commit or stash them before starting a run`,
  );
}

/**
 * Leaves the user's instruction where the loop will find it, at the end of the
 * ticket under way. A run that is not executing has no boundary left to reach, so
 * the instruction is carried out on the spot.
 */
function instruct(context: RunContext, instruction: QueueInstruction): QueueRun {
  const { run } = context;

  if (run.state === "running") {
    run.instruction = instruction;
    return run;
  }

  // A run that is waiting — for a limit to lift, or for its own hour — is already
  // between tickets: there is no Attempt to reach the end of, so what it is told
  // it does on the spot.
  const { waiting } = context;
  if (waiting) {
    return endWait(context, waiting, instruction === "pause" ? "paused" : "stopped");
  }

  // Pausing what is already stopped, or stopping what has finished, is asking for
  // something that has already happened — and is not a control the user gave by
  // accident, so it is said rather than shrugged off.
  if (instruction === "pause" || !isUnderWay(run.state)) {
    throw new QueueControlError(`This run is ${run.state}, so there is nothing to ${instruction}`);
  }

  run.state = "stopped";
  return run;
}

/**
 * Picks the run up where it left off. Resuming one that has been asked to pause
 * but has not reached a boundary yet is taking the instruction back — the same
 * thing the user means by it, and the only thing left to mean while it is running.
 */
function resumeRun(context: RunContext): QueueRun {
  const { run } = context;

  if (run.state === "running") {
    if (run.instruction !== "pause") {
      throw new QueueControlError("This run is already running");
    }
    run.instruction = null;
    return run;
  }

  // Resuming a run that is waiting a limit out is asking it to try now rather
  // than at the hour it was told to expect quota back — the user knowing better
  // than the Run did, which they often do. Resuming an armed one is the same
  // thing said about a different hour: begin now, rather than at midnight.
  const { waiting } = context;
  if (waiting) return endWait(context, waiting, "running");

  if (run.state !== "paused" && run.state !== "paused-on-limit") {
    throw new QueueControlError(`This run is ${run.state}, so there is nothing to resume`);
  }

  return keepGoing(context);
}

/**
 * Cuts a wait short and leaves the run in the state the control asked for. The
 * loop is still alive inside the wait, so it is the one that carries on from
 * here — nothing here starts anything.
 */
function endWait(context: RunContext, wait: Wait, ending: WaitEnding): QueueRun {
  const { run } = context;

  run.state = ending;
  run.resumeAt = null;
  // Leaving the message up would have the run reporting a wait it is no longer
  // in, whichever way the user ended it.
  run.error = null;
  // And the spell of limits ends with it: a run the user took in hand and that is
  // then refused all over again is at the start of something new, not two hours
  // into something old.
  context.limit = undefined;

  wait.told = ending;
  wait.wake();

  return run;
}

/**
 * Gives a failed ticket another go. Everything that was only skipped because of
 * it is owed one too — it was never tried, and the reason it was not may be about
 * to stop being true.
 */
function retryTicket(context: RunContext, ticketId: string): QueueRun {
  // A stopped run is over, and retrying is asking for something to be run: it
  // would have to be started again, which is not a thing a stopped run does.
  if (context.run.state === "stopped") {
    throw new QueueControlError("This run has been stopped; start a new one to run its tickets");
  }

  const queued = findQueued(context, ticketId);
  if (queued.entry.state !== "failed") {
    throw new QueueControlError(
      `${ticketId} is ${queued.entry.state}, and only a failed ticket can be retried`,
    );
  }

  requeue(queued);
  for (const doomed of dependentsOf(context, ticketId)) {
    if (doomed.entry.state === "skipped" && !doomed.takenOut) requeue(doomed);
  }
  // A ticket the user took out is still out, so anything behind it is still
  // waiting on something that will not run. This puts those back where they were.
  skipDependents(context);

  // A paused run stays paused: the user stopped it on purpose, and one ticket
  // going back on the queue is not them asking for the rest of it to start again.
  if (context.run.state === "paused") return context.run;
  // Otherwise, asking for a ticket to be run again is asking the run to run it,
  // so a run that had already finished goes back to work.
  return keepGoing(context);
}

/**
 * Takes a ticket out of a run in progress, and everything waiting on it with it.
 * Only a ticket that has yet to run can be taken out: the one under way cannot be
 * called back, and one that has already been settled is history.
 */
function skipTicket(context: RunContext, ticketId: string): QueueRun {
  const queued = findQueued(context, ticketId);
  if (queued.entry.state !== "pending") {
    throw new QueueControlError(
      `${ticketId} is ${queued.entry.state}, and only a ticket still waiting can be skipped`,
    );
  }

  queued.takenOut = true;
  queued.entry.state = "skipped";
  queued.entry.failure = SKIPPED_BY_HAND;
  skipDependents(context);

  return context.run;
}

function requeue(queued: Queued): void {
  queued.takenOut = false;
  queued.entry.state = "pending";
  queued.entry.failure = null;
}

/**
 * Puts the run back to work. A run already running — or asleep in a limit wait —
 * has a loop walking its queue and will reach whatever has just changed by
 * itself; starting a second one would put two Attempts on the same repository.
 */
function keepGoing(context: RunContext): QueueRun {
  const { run } = context;
  // A run waiting out a limit has a loop of its own asleep inside the wait; it
  // will reach whatever has just changed when it wakes.
  if (run.state === "running" || context.waiting) return run;

  run.state = "running";
  run.instruction = null;
  // Whatever stopped the run last time is no longer what is happening.
  run.error = null;
  void execute(context);

  return run;
}

function findQueued(context: RunContext, ticketId: string): Queued {
  const queued = context.queued.find((item) => item.entry.id === ticketId);
  if (!queued) throw new TicketNotInQueueError(`This run has no ticket called ${ticketId}`);
  return queued;
}

/** The queued items for everything the given ticket gates, itself excepted. */
function dependentsOf(context: RunContext, ticketId: string): Queued[] {
  const reached = downstreamOf(
    context.queued.map((item) => item.ticket),
    [ticketId],
  );

  return context.queued.filter((item) => item.entry.id !== ticketId && reached.has(item.entry.id));
}

/**
 * Walks the Frontier one ticket at a time until nothing is left to run — or until
 * the run has gone as far as this instance allows one to go on its own. A failed
 * ticket takes its dependents out of the queue with it, and the run carries on
 * with whatever was never waiting on it. A usage limit is not an ending at all:
 * the loop sits the limit out inside itself and then has the ticket again, and
 * an armed run's own hour is sat out the same way before any of this begins.
 */
async function execute(context: RunContext): Promise<void> {
  let brokeDown: string | undefined;

  try {
    if (!(await waitForItsHour(context))) return;
    // The night's own clock starts here rather than at the arming: the hours a run
    // spent waiting for the hour it was told are not hours it spent working.
    const startedAt = (context.startedAt ??= context.clock.now());

    for (;;) {
      const next = nextOnFrontier(context.queued);
      // Nothing left to run is a completed queue, whatever was asked of it: there
      // was nothing there to pause or to stop.
      if (!next) break;

      const asked = context.run.instruction;
      if (asked !== null) {
        context.run.instruction = null;
        context.run.state = asked === "pause" ? "paused" : "stopped";
        return;
      }

      // Read at the ticket boundary like everything else that ends a run: the
      // Attempt under way is never cut off half-way, whatever it has run into.
      const reached = safetyStopReached(context.safety, soFar(context, startedAt));
      if (reached !== undefined) {
        stopForSafety(context, reached);
        return;
      }

      try {
        await attemptTicket(next, context);
        // The quota held out, so whatever spell of limits came before it is over.
        context.limit = undefined;
      } catch (error) {
        // A usage limit is not a breakdown: nothing is wrong, there is just no
        // quota left to spend, and the one thing that fixes it is time.
        if (!(error instanceof UsageLimitError)) throw error;
        if (!(await waitOutLimit(error, next, startedAt, context))) return;
      }
    }
    context.run.state = "completed";
  } catch (error) {
    // The repository moving under the run, the source going away: this queue did
    // not complete, and nothing it could do by itself would change that.
    brokeDown = messageOf(error);
    context.run.error = brokeDown;
    context.run.state = "failed";
  }

  // Outside both, on purpose: the run has ended one way or the other, and telling
  // somebody how must not be able to change which. A run that was paused, stopped
  // or is still sitting out a limit returned long before here — none of those has
  // ended, and there is nothing to say about a night that is not over.
  context.onEvent(
    brokeDown === undefined
      ? theNightsOutcome(context)
      : { type: "run-broke-down", runId: context.run.id, error: brokeDown },
  );
}

/**
 * How each ticket ended and where the work is — the whole of what somebody wants
 * before opening anything. Tickets the Ticket Source already reported done are
 * nobody's news: this run did not do them.
 */
function theNightsOutcome(context: RunContext): SupervisorEvent {
  const counted = (state: TicketRunState): number =>
    context.queued.filter(({ entry }) => entry.state === state).length;

  return {
    type: "queue-finished",
    runId: context.run.id,
    branch: context.run.branch,
    succeeded: counted("succeeded"),
    failed: counted("failed"),
    skipped: counted("skipped"),
  };
}

/**
 * Sits out the hour an armed run was told to begin at, and answers whether it
 * should go on. A run given no hour begins the moment it is started.
 *
 * The user overtakes the clock here as they do in a limit wait: resuming an armed
 * run begins it now, and pausing or stopping one ends it before it has run a
 * thing. There is no Attempt in flight for any of them to wait on.
 */
async function waitForItsHour(context: RunContext): Promise<boolean> {
  const { startAt } = context;
  if (startAt === undefined) return true;
  // Taken off first: however this wait ends, the hour has been dealt with, and a
  // run picked up again afterwards is never armed a second time.
  context.startAt = undefined;

  const told = await sleepThrough(context, startAt);
  if (told === "paused" || told === "stopped") return false;

  context.run.state = "running";
  context.run.resumeAt = null;

  // Hours went by between the arming and the hour, and the project was the user's
  // for every one of them. Work left lying about at bedtime would otherwise be
  // swept into the first Checkpoint as if a Run had written it.
  await refuseUncommitted(context.repository, context.project.directory);
  return true;
}

/**
 * Sleeps until the given moment with the run's controls still live, and answers
 * what the user did with it — nothing at all when the wait ran its own course.
 */
async function sleepThrough(context: RunContext, until: Date): Promise<WaitEnding | undefined> {
  const woken = new AbortController();
  const wait: Wait = { wake: () => woken.abort(), told: undefined };
  context.waiting = wait;

  try {
    await context.clock.sleepUntil(until, woken.signal);
  } finally {
    context.waiting = undefined;
  }

  return wait.told;
}

/** What the run has spent so far, which is what the Safety stops are read against. */
function soFar(context: RunContext, startedAt: Date): RunSoFar {
  return {
    startedAt,
    now: context.clock.now(),
    ticketsRun: context.ticketsRun,
    failuresInARow: context.failuresInARow,
  };
}

/**
 * Ends the run at a Safety stop. Stopped rather than failed, and stopped rather
 * than completed: nothing broke, and the queue was not run out. Everything the
 * run finished stands on its branch, and nothing picks the rest up by itself —
 * a stop the user set in advance is still the user's own stop.
 */
function stopForSafety(context: RunContext, reached: string): void {
  context.run.stoppedBy = reached;
  context.run.state = "stopped";
}

/**
 * Sits out a usage limit and answers whether the run should carry on. Waiting is
 * the whole treatment: the ticket was not attempted, nothing is held against it,
 * and when the wait is over the loop simply has it again. A wait that runs its
 * course is followed by another Attempt, which either works — the quota is back —
 * or is refused again and brings its own fresh wait with it. That is the probing:
 * the Runner is the only thing that knows whether there is quota, so asking it is
 * how the Supervisor finds out, and a refused ask costs the ticket nothing.
 *
 * The user overtakes the clock: a pause or a stop given during a wait ends it
 * there, and a resume means "try now" rather than at the stated hour.
 */
async function waitOutLimit(
  limit: UsageLimitError,
  queued: Queued,
  startedAt: Date,
  context: RunContext,
): Promise<boolean> {
  const { run, clock } = context;

  // A pause or a stop given during the Attempt the limit interrupted has reached
  // its boundary: the ticket is over. Sitting out a week on behalf of a run that
  // has been told to stop would be honouring the instruction a week late.
  const asked = run.instruction;
  if (asked !== null) {
    run.instruction = null;
    run.state = asked === "pause" ? "paused" : "stopped";
    return false;
  }

  const now = clock.now();
  const spell = (context.limit ??= { since: now, announced: false });
  const resumeAt = nextLookAt(limit.resetAt, now);

  run.state = "paused-on-limit";
  run.error = messageOf(limit);
  run.resumeAt = resumeAt.toISOString();

  announceLongWait(spell, resumeAt, queued, context);

  // A run may not sit out a limit past the hour its own time is up, so the wait
  // ends at whichever comes first. Waking early settles nothing by itself: the
  // loop reads the Safety stops again, and stops the run if that is what they
  // say. What the run reports meanwhile is still the limit's own hour, because
  // that is the hour it means to try at.
  const told = await sleepThrough(context, soonest(resumeAt, runsUntil(context.safety, startedAt)));

  // Whatever the clock says, the user's word is what the run does. A resume is
  // them agreeing with the clock early, so only the other two end the run here.
  if (told === "paused" || told === "stopped") return false;

  run.resumeAt = null;
  run.state = "running";
  run.error = null;
  // The spell of limits deliberately survives: this wait is over, but if the
  // quota is still gone the next one is more of the same wait, and how long the
  // whole of it has run is the only thing that says it is a long one.
  return true;
}

/** The earlier of two moments, one of which may not exist at all. */
function soonest(moment: Date, other: Date | undefined): Date {
  return other !== undefined && other.getTime() < moment.getTime() ? other : moment;
}

/**
 * Says so when the limit has held the run up long enough to be worth somebody's
 * attention. Said once — the whole point is a person who is not watching, and a
 * phone buzzing every half hour until Friday is one that gets ignored on the
 * night it matters.
 */
function announceLongWait(
  spell: LimitSpell,
  resumeAt: Date,
  queued: Queued,
  context: RunContext,
): void {
  if (spell.announced) return;
  if (!isLongWait(spell.since, resumeAt)) return;

  spell.announced = true;
  context.onEvent({
    type: "long-wait",
    runId: context.run.id,
    ticketId: queued.ticket.id,
    resumeAt: resumeAt.toISOString(),
  });
}

/**
 * The ticket's whole turn: Attempts until one of them is verified or the budget
 * is spent. Each retry is a fresh Run told what the last one was refused for —
 * the second go is meant to be smarter than the first, not merely another one.
 */
async function attemptTicket(queued: Queued, context: RunContext): Promise<void> {
  await clearEarlierFailure(queued, context);
  queued.entry.state = "running";

  let refusal = await attempt(queued, undefined, context);
  for (let spent = 1; refusal !== undefined && spent < context.attemptBudget; spent += 1) {
    refusal = await attempt(queued, feedbackOn(refusal), context);
  }

  // The run's own tally, kept in the one place both endings are known. A ticket a
  // usage limit interrupted never reaches here: it was not run, and it costs the
  // run's allowance nothing.
  context.ticketsRun += 1;

  if (refusal !== undefined) {
    context.failuresInARow += 1;
    await failTicket(queued, refusal.reason, context);
    return;
  }

  // One ticket working is the whole of the evidence that the project is not
  // systematically broken, which is all the failure stop was ever counting.
  context.failuresInARow = 0;
  await checkpoint(queued, context);
}

/**
 * Takes an earlier go's failure back off the ticket before another one starts. A
 * ticket that goes on to succeed carrying the reason it did not would be a lie the
 * morning's triage reads, and the Checkpoint would commit it.
 *
 * Only a ticket the source is actually carrying a failure for has anything to
 * undo — a ticket a usage limit interrupted was never blamed for anything, and a
 * week of half-hourly probes must not each write to the source to say so. This is
 * also the one moment it can be undone safely: the working tree is back at the
 * restore point, so the commit that records it can pick up nothing else.
 */
async function clearEarlierFailure(queued: Queued, context: RunContext): Promise<void> {
  if (!queued.failureRecorded) return;
  queued.failureRecorded = false;

  await context.source.clearFailure(queued.ticket);
  // Ticket files kept outside the repository leave nothing to commit, and the
  // restore point simply stands.
  const recorded = await context.repository.commitEverything(`Retrying: ${queued.ticket.title}`);
  context.restorePoint = recorded ?? context.restorePoint;
}

/**
 * What a refused Attempt leaves the next one to go on: why it was refused, and —
 * where a check was what refused it — what that check printed. `exited 1` on its
 * own is nothing a second Attempt can be smarter about.
 *
 * The refused Run's own transcript is deliberately not among it. A fresh context
 * per Run is the design, an hour of narration would swamp the ticket it is
 * wrapped around, and where the Run itself reported the failure its reason is
 * already its own account of it. The whole transcript is kept, under `/attempts`.
 */
function feedbackOn(refusal: Refusal): string {
  return joined(refusal.reason, refusal.output);
}

/**
 * One Attempt: a single Run of the ticket, then the Supervisor's own Verification
 * of what it left behind. Claude's own report is never enough on its own. Answers
 * why Verification refused it, or nothing at all when the Attempt stands.
 */
async function attempt(
  queued: Queued,
  previousFailure: string | undefined,
  context: RunContext,
): Promise<Refusal | undefined> {
  const { ticket } = queued;

  const before = await context.repository.headCommit();
  // The Attempt in flight becomes the one being watched; the last one's output
  // stands until then, so a watcher never finds an empty log mid-handover.
  context.live.ticketId = ticket.id;
  context.live.lines = [];

  const outcome = await context.runner.run({
    ticket,
    projectDirectory: context.project.directory,
    ...(previousFailure === undefined ? {} : { previousFailure }),
    onOutput: (chunk) => context.live.lines.push(chunk),
  });

  if (outcome.status === "limit-hit") {
    await discardOnLimit(queued, outcome, context);
    throw usageLimitStopped(queued, outcome.resetAt);
  }

  const refusal = await verificationRefusal(outcome, before, context);
  // The log is written down before anything else, because the reset that follows
  // a failure is the last chance to have it.
  record(queued, context, {
    outcome: refusal === undefined ? "succeeded" : "failed",
    failure: refusal?.reason ?? null,
    output: joined(outcome.output, refusal?.output),
  });

  if (refusal === undefined) return undefined;

  // A refused Attempt is thrown back the moment it is refused, whether the ticket
  // has another go coming or has just run out of them: nothing it left behind may
  // reach the next Run, and nothing may reach the branch either.
  await context.repository.resetTo(context.restorePoint);
  return refusal;
}

/** Ends a verified ticket: the write-back, the Checkpoint, and the push. */
async function checkpoint(queued: Queued, context: RunContext): Promise<void> {
  const { entry, ticket } = queued;

  await context.source.markDone(ticket);
  // The write-back, and anything the Run left uncommitted, ride along in the
  // Checkpoint. A source that keeps its tickets elsewhere leaves nothing to
  // commit; there the Run's own last commit is what ends the ticket.
  const swept = await context.repository.commitEverything(`Checkpoint: ${ticket.title}`);
  entry.checkpoint = swept ?? (await context.repository.headCommit());
  context.restorePoint = entry.checkpoint;
  entry.state = "succeeded";

  // Last, once the ticket has finished being a ticket: the Checkpoint goes out
  // before the next ticket is attempted, so the remote is never more than one
  // ticket behind the work.
  await pushCheckpoint(context);
  // And then the source is told where the work went. Unlike the push, a source
  // that will not take this ends the run: done-ness lives in the source, so a
  // Supervisor that cannot record it there would go on to spend the night on
  // tickets the next run would have every reason to do all over again.
  await context.source.recordCheckpoint(ticket, entry.checkpoint);
}

/**
 * Sends the branch out to where the night's progress can be followed from a phone.
 * Pushing is no part of Verification: the ticket passed its checks and has
 * succeeded, so a remote that will not take the commit is a problem with the
 * remote — said so on the run, and the run goes on.
 */
async function pushCheckpoint(context: RunContext): Promise<void> {
  if (!context.project.pushCheckpoints) return;

  try {
    await context.repository.push(context.run.branch);
    // A push carries everything before it, so whatever an earlier one could not
    // deliver has just arrived: there is nothing left to warn about.
    context.run.pushFailure = null;
  } catch (error) {
    context.run.pushFailure = messageOf(error);
  }
}

/**
 * A usage limit is not the ticket's doing, so nothing is held against it: the
 * half-finished Attempt is thrown back like any other, but the ticket goes back
 * on the Frontier untouched and nothing is written to the Ticket Source.
 *
 * A limit is never allowed to read as a ticket that failed, nor to cost the ticket
 * one of its Attempts.
 */
async function discardOnLimit(
  queued: Queued,
  outcome: Extract<RunOutcome, { status: "limit-hit" }>,
  context: RunContext,
): Promise<void> {
  record(queued, context, { outcome: "limit-hit", failure: null, output: outcome.output });

  await context.repository.resetTo(context.restorePoint);
  queued.entry.state = "pending";
}

/**
 * Files an Attempt: the log goes where the failure path cannot reach it, and the
 * ticket's own count goes up. One place, so what the run says about a ticket and
 * what is filed under it can never disagree.
 */
function record(
  queued: Queued,
  context: RunContext,
  attempt: Omit<AttemptRecord, "runId" | "ticketId">,
): void {
  context.storage.recordAttempt({
    ...attempt,
    runId: context.run.id,
    ticketId: queued.ticket.id,
  });
  queued.entry.attempts += 1;
}

/**
 * What puts the queue into Paused-on-limit. The run waits this out and picks
 * itself up, so what it says is what a reader finding the page quiet needs: why
 * nothing is happening, and that nothing is expected of them.
 */
function usageLimitStopped(queued: Queued, resetAt: Date | null): UsageLimitError {
  return new UsageLimitError(
    `the subscription's usage limit stopped the run${liftsAt(resetAt)}. ` +
      `${queued.ticket.id} was not attempted, and the run will have it again once it has waited.`,
    resetAt,
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
 * Gives up on a ticket once its every Attempt has been refused: the failure is
 * written back to the ticket, and everything that was waiting on this ticket is
 * taken out of the queue. What the Attempts left behind is already gone — each
 * was thrown back the moment it was refused.
 */
async function failTicket(queued: Queued, reason: string, context: RunContext): Promise<void> {
  queued.entry.state = "failed";
  queued.entry.failure = reason;

  // Said as soon as the ticket has run out of Attempts, before anything is
  // written anywhere: the ticket has failed whether or not the Ticket Source
  // turns out to be reachable, and a source that is not is its own bad news.
  context.onEvent({
    type: "ticket-failed",
    runId: context.run.id,
    ticketId: queued.ticket.id,
    title: queued.ticket.title,
    failure: reason,
  });

  await context.source.markFailed(queued.ticket, reason);
  queued.failureRecorded = true;
  // Committing the write-back is what ends the ticket cleanly: the branch is left
  // with nothing uncommitted, so the next ticket's Checkpoint stays its own work
  // and the next reset cannot rewind this record away. A source that keeps its
  // tickets elsewhere leaves nothing to commit, and the restore point stands.
  const recorded = await context.repository.commitEverything(`Failed: ${queued.ticket.title}`);
  context.restorePoint = recorded ?? context.restorePoint;

  skipDependents(context);
}

/** Everything worth keeping about an Attempt, in the order it happened. */
function joined(...parts: (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part !== "").join("\n");
}

/**
 * Marks everything the queue can no longer reach — what a failure has doomed, and
 * what was never reachable to begin with. One pass suffices: the queue is in
 * dependency order, so a ticket is only reached after every blocker it names.
 */
function skipDependents(context: RunContext): void {
  const inQueue = new Set(context.queued.map(({ entry }) => entry.id));
  const stopped = new Set(
    context.queued
      .filter(({ entry }) => entry.state === "failed" || entry.state === "skipped")
      .map(({ entry }) => entry.id),
  );

  for (const { entry, ticket } of context.queued) {
    if (entry.state !== "pending") continue;

    // A blocker the Queue does not hold — on GitHub, an open issue that is not
    // the Supervisor's to run — is one nothing here will ever finish, so the
    // ticket is out of this run for the same reason a doomed one is. Leaving it
    // `pending` in a completed run would be the queue quietly not saying so.
    const blocker = ticket.blockedBy.find((id) => stopped.has(id) || !inQueue.has(id));
    if (blocker === undefined) continue;

    entry.state = "skipped";
    entry.failure = inQueue.has(blocker)
      ? `${blocker} did not succeed, so this ticket was never attempted`
      : `${blocker} is not in this queue, so nothing here would have unblocked it`;
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
