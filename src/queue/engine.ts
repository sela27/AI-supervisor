import type { Clock } from "../clock.js";
import { messageOf } from "../errors.js";
import type { EventSink, NightsAccount, SupervisorEvent } from "../events.js";
import { GitError, openRepository, type GitRepository } from "../git/repository.js";
import type { ReviewOutcome, Runner, SettledRun } from "../runner/runner.js";
import { spentAltogether, type Spend } from "../runner/spend.js";
import type { AttemptRecord, Storage } from "../storage.js";
import type { SourceSelection, TicketSource } from "../tickets/source.js";
import { isDone, type Ticket, type TicketReview } from "../tickets/ticket.js";
import type { ReviewSettings } from "../verification/review.js";
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
import { readRunRecord, type RunRecord } from "./record.js";
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
  /**
   * The one Ticket Source this queue is discovered from and written back to —
   * named rather than handed over, so that what a run was reading is something
   * the run can be written down with and opened again by a Supervisor that has
   * restarted since.
   */
  source: SourceSelection;
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
  /**
   * Works out what the Supervisor was in the middle of when it last went down,
   * and picks it up. Called once, before anything else can start a run: a run
   * that was under way carries on, and one that had ended is still the run this
   * instance reports and holds the Attempt logs of.
   */
  recover(): Promise<void>;
  /**
   * The Supervisor going down. The run stops where it stands without being ended:
   * what it was doing is already written down, and the next Supervisor to start on
   * this data directory is the one that picks it up.
   */
  shutDown(): void;
  /** The run in progress, or the last one that finished. */
  current(): QueueRun | undefined;
  /**
   * What that run has spent, every Attempt of it added up — the ones that failed
   * and the ones a usage limit cut short included, because the quota went on
   * those too. Nothing where there is no run, and nothing where no Run of it
   * reported a figure.
   */
  spentSoFar(): Spend | null;
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

interface RunContext {
  run: QueueRun;
  /** Which source the run reads and writes back to, in the form it is written down in. */
  selection: SourceSelection;
  /** That same source, opened. */
  source: TicketSource;
  project: Project;
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
  /**
   * Whether the Supervisor is on its way out. The loop reads it wherever it could
   * otherwise carry on, so a run neither works nor ends after the lights go out.
   */
  goingDown: boolean;
  /** How many Attempts a ticket may spend before the run gives up on it. */
  attemptBudget: number;
  /** Whether a verified Attempt is put in front of a reviewer before it stands. */
  review: ReviewSettings;
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
  /** Opens the Ticket Source a run named — at its start, and again after a restart. */
  openSource: (selection: SourceSelection) => TicketSource;
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
  /**
   * Whether Verification has a second stage. Off is the Supervisor every other
   * ticket described; on is one that spends a Run per verified Attempt having it
   * read.
   */
  review: ReviewSettings;
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
    const source = dependencies.openSource(request.source);
    // The user's edit is carried out before anything is created, so an impossible
    // queue is refused rather than started and then found to be stuck.
    const preview = previewQueue(await source.discover(), request.edit);
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
      run: started,
      selection: request.source,
      source,
      project: request.project,
      repository,
      runner: dependencies.runner,
      storage: dependencies.storage,
      clock: dependencies.clock,
      onEvent: dependencies.onEvent,
      queued,
      live,
      waiting: undefined,
      limit: undefined,
      goingDown: false,
      attemptBudget: dependencies.attemptBudget,
      review: dependencies.review,
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
    // Written down before it is under way, so a Supervisor that goes down during
    // the very first Attempt still knows there was a night to pick up.
    remember(context);
    void execute(context);

    return snapshot(started);
  }

  /**
   * Picks up whatever the last Supervisor on this data directory was in the middle
   * of. Everything it needs is either written down or in the Ticket Source, which
   * is still the one that says what is finished — a ticket somebody closed by hand
   * overnight is done, whatever this run last thought.
   */
  async function pickUpWhereItWasLeft(): Promise<void> {
    const record = readRunRecord(dependencies.storage.lastRun());
    if (!record) return;

    let repository: GitRepository;
    try {
      repository = await openRepository(record.project.directory);
    } catch {
      // No project to pick anything up in. The Attempt logs are still on the disk
      // and the Ticket Source still holds every finished ticket; what is missing
      // is the repository, which is a bigger problem than a night not continued.
      return;
    }

    const resumed: RunContext = {
      run: record.run,
      selection: record.source,
      source: dependencies.openSource(record.source),
      project: record.project,
      repository,
      runner: dependencies.runner,
      storage: dependencies.storage,
      clock: dependencies.clock,
      onEvent: dependencies.onEvent,
      queued: [],
      live,
      waiting: undefined,
      limit: limitSpell(record),
      goingDown: false,
      attemptBudget: dependencies.attemptBudget,
      review: dependencies.review,
      safety: dependencies.safety,
      startAt: record.run.state === "armed" ? asMoment(record.run.resumeAt) : undefined,
      startedAt: asMoment(record.startedAt),
      ticketsRun: record.ticketsRun,
      failuresInARow: record.failuresInARow,
      restorePoint: record.restorePoint,
    };
    context = resumed;
    // A run that has ended is not one to carry on with, but it is still the run
    // this instance reports and holds the Attempt logs of — and a failed ticket of
    // it is still one the user can give another go, which needs its queue back.
    const underWay = isUnderWay(resumed.run.state);
    // An armed run has not begun. The project is the user's until its hour comes,
    // and their evening's work is not the Supervisor's to throw away — it is
    // checked at the hour, as it always was, and refused rather than reset.
    const hasBegun = underWay && resumed.run.state !== "armed";

    try {
      // Before the Ticket Source is asked anything: the dead Attempt may have left
      // a write-back sitting uncommitted in the project, and a source read before
      // the reset would answer out of work that is about to be thrown away.
      if (hasBegun) await returnToTheBranch(resumed);
      resumed.queued = await rebuildQueue(record, resumed.source, resumed.storage);
      // The run reports the very entries the queue works on, as it does from the
      // moment a run is started: two copies would let what the loop does and what
      // the API says drift apart.
      resumed.run.tickets = resumed.queued.map((item) => item.entry);
      // The blocking edges were read again just now, and a ticket may have gained
      // one that nothing in this queue will ever finish.
      skipDependents(resumed);
    } catch (error) {
      // A run that had already ended is not ended again over a source that would
      // not answer: what it says about the night stands, and only what could still
      // be done with it — retrying a ticket — is out of reach until the next start.
      if (!underWay) return;

      // Said, but deliberately not written down. The run did not fail: this
      // Supervisor could not pick it up, which is a different thing and often a
      // thing the user can undo. What is on the disk is left exactly as the last
      // Supervisor left it, so putting right whatever this was — checking the run's
      // branch back out, giving the source its network back — and starting again
      // finds the night where it was.
      resumed.onEvent(brokeDown(resumed, messageOf(error)));
      return;
    }

    // A paused run is where the user left it, and a Supervisor restarting is not
    // them taking that back. Everything else was under way and goes on being.
    if (underWay && resumed.run.state !== "paused") void execute(resumed);
  }

  /** The run a control is about to act on, or the reason there is nothing to act on. */
  function runToControl(): RunContext {
    if (!context) throw new QueueControlError("No queue run has been started yet");
    return context;
  }

  return {
    current: () => (context ? snapshot(context.run) : undefined),

    spentSoFar: () => (context ? context.storage.spentOn(context.run.id) : null),

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

    recover: pickUpWhereItWasLeft,

    shutDown: () => {
      if (!context) return;
      context.goingDown = true;
      // A run asleep in a wait would otherwise hold the process until Thursday.
      context.waiting?.wake();
    },

    pause: () => control(() => instruct(runToControl(), "pause")),
    stop: () => control(() => instruct(runToControl(), "stop")),
    resume: () => control(() => resumeRun(runToControl())),
    retry: (ticketId) => control(() => retryTicket(runToControl(), ticketId)),
    skip: (ticketId) => control(() => skipTicket(runToControl(), ticketId)),
  };

  /**
   * One of the run's controls, carried out and then written down. Every control
   * changes what the run would be picked up as, and one place to say so beats five
   * that have to remember to.
   */
  function control(act: () => QueueRun): QueueRun {
    const run = act();
    if (context) remember(context);
    return snapshot(run);
  }
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
  const ending = await walkTheQueue(context);

  // The Supervisor going down under the run, rather than the run ending: nothing
  // is written and nobody is told. Where the run had got to is already on the
  // disk, and the next Supervisor to start here is the one with something to say.
  if (context.goingDown) return;

  remember(context);
  // Said outside the walk on purpose: the run has ended one way or the other, and
  // telling somebody how must not be able to change which. A run that was paused,
  // stopped or is still sitting out a limit has not ended, and there is nothing to
  // say about a night that is not over.
  if (ending !== undefined) context.onEvent(ending);
}

/** The walk itself, and the one thing worth telling somebody at the end of it. */
async function walkTheQueue(context: RunContext): Promise<SupervisorEvent | undefined> {
  try {
    if (!(await waitForItsHour(context))) return undefined;
    // The night's own clock starts here rather than at the arming: the hours a run
    // spent waiting for the hour it was told are not hours it spent working.
    const startedAt = (context.startedAt ??= context.clock.now());
    if (!(await pickUpTheLimitWait(context, startedAt))) return undefined;

    for (;;) {
      if (context.goingDown) return undefined;
      // Written down at every boundary, so a Supervisor that goes down mid-Attempt
      // is picked up from the end of the last ticket rather than from the start.
      remember(context);

      const next = nextOnFrontier(context.queued);
      // Nothing left to run is a completed queue, whatever was asked of it: there
      // was nothing there to pause or to stop.
      if (!next) break;

      const asked = context.run.instruction;
      if (asked !== null) {
        context.run.instruction = null;
        context.run.state = asked === "pause" ? "paused" : "stopped";
        return undefined;
      }

      // Read at the ticket boundary like everything else that ends a run: the
      // Attempt under way is never cut off half-way, whatever it has run into.
      const reached = safetyStopReached(context.safety, soFar(context, startedAt));
      if (reached !== undefined) return stopForSafety(context, reached);

      try {
        await attemptTicket(next, context);
        // The quota held out, so whatever spell of limits came before it is over.
        context.limit = undefined;
      } catch (error) {
        // A usage limit is not a breakdown: nothing is wrong, there is just no
        // quota left to spend, and the one thing that fixes it is time.
        if (!(error instanceof UsageLimitError)) throw error;
        if (!(await waitOutLimit(error, next, startedAt, context))) return undefined;
      }
    }

    context.run.state = "completed";
    return { type: "queue-finished", runId: context.run.id, ...accountOfTheNight(context) };
  } catch (error) {
    // The repository moving under the run, the source going away: this queue did
    // not complete, and nothing it could do by itself would change that.
    return brokeDown(context, messageOf(error));
  }
}

/**
 * Ends the run on something no ticket was to blame for, and says what. The one
 * ending that is nobody's decision — not the user's, not the queue running out —
 * so it is the one worth reaching a person who is not looking.
 */
function brokeDown(context: RunContext, error: string): SupervisorEvent {
  context.run.error = error;
  context.run.state = "failed";
  return { type: "run-broke-down", runId: context.run.id, error };
}

/**
 * Writes the run down as it stands. Called wherever the run reaches a state a
 * Supervisor could go down in — which is every ticket boundary, every wait, and
 * every control the user gives.
 */
function remember(context: RunContext): void {
  const record: RunRecord = {
    run: context.run,
    queue: context.queued.map(({ ticket, takenOut }) => ({ ticket, takenOut })),
    source: context.selection,
    project: context.project,
    startAt: context.startAt?.toISOString() ?? null,
    startedAt: context.startedAt?.toISOString() ?? null,
    ticketsRun: context.ticketsRun,
    failuresInARow: context.failuresInARow,
    restorePoint: context.restorePoint,
    limit:
      context.limit === undefined
        ? null
        : { since: context.limit.since.toISOString(), announced: context.limit.announced },
  };

  context.storage.saveRun(context.run.id, record);
}

/**
 * Moves the point a failed or dead Attempt is thrown back to, and writes it down
 * on the spot. The one thing here that must never be a moment late: a Supervisor
 * going down between a Checkpoint being made and its being written down would come
 * back and reset away the very commit it had just made.
 */
function moveRestorePoint(context: RunContext, commit: string): void {
  context.restorePoint = commit;
  remember(context);
}

/**
 * The Queue as it stood, with the Ticket Source asked about it again. The tickets
 * are the ones the user approved and in the order they approved them — a queue is
 * a plan, and a ticket filed since is not part of the plan the night was begun on.
 *
 * A ticket the source is still offering is taken fresh: a blocking edge may have
 * been rewritten, and somebody may have finished the ticket by hand overnight. One
 * it is no longer offering is taken as it was written down, because that is what
 * every ticket this run finished looks like — a closed issue is not offered, and
 * asking the source for the Queue again would lose the whole of the night's work.
 */
async function rebuildQueue(
  record: RunRecord,
  source: TicketSource,
  storage: Storage,
): Promise<Queued[]> {
  const offered = new Map((await source.discover()).map((ticket) => [ticket.id, ticket]));
  const entries = new Map(record.run.tickets.map((entry) => [entry.id, entry]));

  return record.queue.flatMap(({ ticket: written, takenOut }) => {
    const entry = entries.get(written.id);
    if (!entry) return [];

    const offering = offered.get(written.id);
    return [
      {
        ticket: offering ?? written,
        takenOut,
        // A ticket that failed had its failure written to the source as it failed,
        // so there is something there to take back off it if it is retried.
        failureRecorded: entry.state === "failed",
        entry: {
          ...entry,
          // Counted from the Attempts themselves rather than from the run's own
          // tally, which was last written down at the previous ticket boundary.
          attempts: storage.attemptsFor(record.run.id, entry.id).length,
          ...afterTheRestart(entry, offering),
        },
      },
    ];
  });
}

/**
 * What one ticket is once the Supervisor has restarted. What this run did to a
 * ticket is this run's own to remember; everything still to happen is the source's
 * to say, including a ticket somebody finished by hand overnight.
 */
function afterTheRestart(
  entry: TicketRun,
  offering: Ticket | undefined,
): Pick<TicketRun, "state" | "failure"> {
  if (entry.state === "succeeded" || entry.state === "failed" || entry.state === "skipped") {
    return { state: entry.state, failure: entry.failure };
  }

  // A ticket the source has stopped offering and this run never settled is one
  // nothing here will finish: somebody closed it, took the label off it, or took
  // it away. Whichever it was, it is not tonight's, and neither is anything that
  // was waiting on it.
  if (offering === undefined) {
    return {
      state: "skipped",
      failure: "the Ticket Source stopped offering it, so it was never attempted",
    };
  }

  if (isDone(offering)) return { state: "done", failure: null };
  // An Attempt the restart cut off never ran its course, so it never happened:
  // the ticket goes back on the Frontier with nothing held against it.
  return { state: "pending", failure: null };
}

/**
 * Makes the project fit to be worked in again: on the run's own branch, and back
 * at the last Checkpoint. A dead Attempt's residue goes the way a refused one's
 * does — it is the same residue, and the same reason for throwing it away.
 *
 * A project standing on some other branch is not one to reset: somebody checked it
 * out while the Supervisor was down, and their work is not the run's to throw away.
 * The run ends there and says so, and checking the branch back out is all it takes
 * to have it picked up on the next start.
 */
async function returnToTheBranch(context: RunContext): Promise<void> {
  const { branch } = context.run;
  const standing = await context.repository.currentBranch();

  if (standing !== branch) {
    throw new GitError(
      `${context.project.directory} is on ${standing} rather than the run's own branch ` +
        `${branch}, so the run was left where it was — check ${branch} out to have it picked up`,
    );
  }

  await context.repository.resetTo(context.restorePoint);
}

/** A moment written down, or nothing where nothing was written. */
function asMoment(written: string | null): Date | undefined {
  if (written === null) return undefined;
  const at = new Date(written);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

function limitSpell(record: RunRecord): LimitSpell | undefined {
  const since = asMoment(record.limit?.since ?? null);
  return since === undefined ? undefined : { since, announced: record.limit?.announced ?? false };
}

/**
 * How each ticket ended and where the work is — the whole of what somebody wants
 * before opening anything, whichever of the two endings is giving the account.
 * Tickets the Ticket Source already reported done are nobody's news: this run did
 * not do them. Nor are the ones a stop never reached, which are nothing yet.
 */
function accountOfTheNight(context: RunContext): NightsAccount {
  const counted = (state: TicketRunState): number =>
    context.queued.filter(({ entry }) => entry.state === state).length;

  return {
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

  if (!(await waitUntilItsHour(context, startAt))) return false;

  // Hours went by between the arming and the hour, and the project was the user's
  // for every one of them. Work left lying about at bedtime would otherwise be
  // swept into the first Checkpoint as if a Run had written it.
  await refuseUncommitted(context.repository, context.project.directory);
  return true;
}

/**
 * Sits out the rest of a usage-limit wait the Supervisor went down in the middle
 * of. The quota is no more back than it was, so the run goes back to waiting
 * rather than back to work: attempting now would spend the ticket's turn finding
 * out what the run already knows.
 */
async function pickUpTheLimitWait(context: RunContext, startedAt: Date): Promise<boolean> {
  const { run } = context;
  if (run.state !== "paused-on-limit" || run.resumeAt === null) return true;

  const until = soonest(new Date(run.resumeAt), runsUntil(context.safety, startedAt));
  return waitUntilItsHour(context, until);
}

/**
 * Waits for a moment to come round with the run's controls still live, and answers
 * whether the run should carry on. Waiting is all this does: what the run was
 * waiting for is the caller's to know, and the two things a run waits for — its
 * own hour, and the quota's — end the same way when they end.
 */
async function waitUntilItsHour(context: RunContext, until: Date): Promise<boolean> {
  const told = await sleepThrough(context, until);
  if (context.goingDown) return false;
  // Whatever the clock says, the user's word is what the run does. A resume is
  // them agreeing with the clock early, so only the other two end the run here.
  if (told === "paused" || told === "stopped") return false;

  context.run.resumeAt = null;
  context.run.state = "running";
  context.run.error = null;
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
  // Written down before the sleep rather than after it: the state a run waits in
  // is precisely the state a Supervisor going down mid-wait has to be picked up in.
  remember(context);

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
 *
 * Told about all the same, and with the night's whole account, since no finished
 * queue is coming to give one. A stop given by hand says nothing, which is the
 * same idea from the other side: that person was there.
 */
function stopForSafety(context: RunContext, reached: string): SupervisorEvent {
  context.run.stoppedBy = reached;
  context.run.state = "stopped";

  return {
    type: "safety-stop-reached",
    runId: context.run.id,
    stoppedBy: reached,
    ...accountOfTheNight(context),
  };
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
  //
  // The spell of limits deliberately survives the wait: if the quota is still
  // gone the next wait is more of the same one, and how long the whole of it has
  // run is the only thing that says it is a long one.
  return waitUntilItsHour(context, soonest(resumeAt, runsUntil(context.safety, startedAt)));
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

  let attempted = await attempt(queued, undefined, context);
  let spent = 1;
  while (attempted.refusal !== undefined && spent < context.attemptBudget) {
    attempted = await attempt(queued, feedbackOn(attempted.refusal), context);
    spent += 1;
  }

  // The run's own tally, kept in the one place both endings are known. A ticket a
  // usage limit interrupted never reaches here: it was not run, and it costs the
  // run's allowance nothing.
  context.ticketsRun += 1;

  if (attempted.refusal !== undefined) {
    context.failuresInARow += 1;
    await failTicket(queued, attempted.refusal.reason, context);
    return;
  }

  // One ticket working is the whole of the evidence that the project is not
  // systematically broken, which is all the failure stop was ever counting.
  context.failuresInARow = 0;
  await checkpoint(queued, attempted.review, context);
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
  moveRestorePoint(context, recorded ?? context.restorePoint);
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
): Promise<Attempted> {
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
    await discardOnLimit(queued, { output: outcome.output, spend: outcome.spend }, context);
    throw usageLimitStopped(queued, outcome.resetAt);
  }

  const refusedByChecks = await verificationRefusal(outcome, before, context);
  // Verification's second stage, for an instance that asked for one. Nothing the
  // checks have already refused is ever put in front of a reviewer.
  const review =
    refusedByChecks === undefined ? await reviewTheWork(queued, before, context) : undefined;

  if (review?.status === "limit-hit") {
    // The Attempt was verified but never judged, and an Attempt nobody finished
    // reading is not one to hold anything against: it goes back the way a Run the
    // quota cut short does, and the ticket keeps every go it had.
    await discardOnLimit(
      queued,
      {
        output: joined(outcome.output, review.output),
        spend: spentAltogether([outcome.spend, review.spend]),
      },
      context,
    );
    throw usageLimitStopped(queued, review.resetAt);
  }

  const refusal = refusedByChecks ?? refusalFromReview(review);
  // The log is written down before anything else, because the reset that follows
  // a failure is the last chance to have it.
  record(queued, context, {
    outcome: refusal === undefined ? "succeeded" : "failed",
    failure: refusal?.reason ?? null,
    output: joined(outcome.output, refusedByChecks?.output, review?.output),
    review: review === undefined ? null : { verdict: review.verdict, reasoning: review.reasoning },
    // The review is a Run of its own, and an instance that turned reviews on is
    // spending that quota on every Attempt that gets as far as one.
    spend: spentAltogether([outcome.spend, review?.spend]) ?? null,
  });

  if (refusal !== undefined) {
    // A refused Attempt is thrown back the moment it is refused, whether the
    // ticket has another go coming or has just run out of them: nothing it left
    // behind may reach the next Run, and nothing may reach the branch either.
    await context.repository.resetTo(context.restorePoint);
    return { refusal, review: undefined };
  }

  return { refusal: undefined, review: approvalOf(review) };
}

/** Ends a verified ticket: the write-back, the Checkpoint, and the push. */
async function checkpoint(
  queued: Queued,
  review: TicketReview | undefined,
  context: RunContext,
): Promise<void> {
  const { entry, ticket } = queued;

  await context.source.markDone(ticket, {
    branch: context.run.branch,
    checks: context.project.verify,
    review,
  });
  // The write-back, and anything the Run left uncommitted, ride along in the
  // Checkpoint. A source that keeps its tickets elsewhere leaves nothing to
  // commit; there the Run's own last commit is what ends the ticket.
  const swept = await context.repository.commitEverything(`Checkpoint: ${ticket.title}`);
  entry.checkpoint = swept ?? (await context.repository.headCommit());
  entry.state = "succeeded";
  moveRestorePoint(context, entry.checkpoint);

  // Once the ticket has finished being a ticket: the Checkpoint goes out before
  // the next ticket is attempted, so the remote is never more than one ticket
  // behind the work.
  await pushCheckpoint(context);
  // And then the source is told where the work went. Unlike the push, a source
  // that will not take this ends the run: done-ness lives in the source, so a
  // Supervisor that cannot record it there would go on to spend the night on
  // tickets the next run would have every reason to do all over again.
  await context.source.recordCheckpoint(ticket, entry.checkpoint);
  await recordOutsideTheCheckpoint(ticket, context);
}

/**
 * Commits the one line of the write-back that could not go into the Checkpoint:
 * the Checkpoint's own name, which nothing could know until it existed. Left
 * lying about, the next refused Attempt's reset would take it straight back off.
 *
 * A source that keeps its tickets anywhere but the project leaves nothing to
 * commit here, and the Checkpoint is the last word on the ticket as it was.
 */
async function recordOutsideTheCheckpoint(ticket: Ticket, context: RunContext): Promise<void> {
  const recorded = await context.repository.commitEverything(`Recorded: ${ticket.title}`);
  if (recorded === undefined) return;

  moveRestorePoint(context, recorded);
  await pushCheckpoint(context);
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
 * one of its Attempts. What the Run spent before the quota refused it is another
 * matter: that is gone whatever became of the ticket, so it is filed like any
 * other Attempt's.
 */
async function discardOnLimit(
  queued: Queued,
  reported: Interrupted,
  context: RunContext,
): Promise<void> {
  record(queued, context, {
    outcome: "limit-hit",
    failure: null,
    output: reported.output,
    review: null,
    spend: reported.spend ?? null,
  });

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

/**
 * What an Attempt the usage limit cut off leaves to be filed. Nothing was
 * learned about the ticket, so this is the whole of what there is to keep: what
 * it printed on its way, and what it spent printing it.
 */
interface Interrupted {
  output: string;
  spend: Spend | undefined;
}

/** Why Verification refused an Attempt, and what the refusing check printed. */
interface Refusal {
  reason: string;
  output: string;
}

/** What one Attempt came to, and — where it stands — what a review made of it. */
interface Attempted {
  /** Why Verification refused it. Nothing at all where the Attempt stands. */
  refusal: Refusal | undefined;
  /**
   * What the review that let it stand said, for the ticket to be written back
   * with. Nothing where no reviewer saw it, and nothing on a refusal: there is
   * no ticket ending to give an account of.
   */
  review: TicketReview | undefined;
}

/**
 * What an approval leaves for the write-back. Nothing where no reviewer saw the
 * Attempt — a review that was never asked for and one that named no criterion
 * must not read alike on the ticket.
 */
function approvalOf(review: ReviewOutcome | undefined): TicketReview | undefined {
  if (review?.status !== "reviewed" || review.verdict !== "approved") return undefined;

  return { reasoning: review.reasoning, criteriaMet: review.criteriaMet };
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
 * Verification's second stage, for an instance that asked for one: a Run of its
 * own that reads what the Attempt left behind and says whether it meets the
 * ticket. Nothing back at all where the instance never asked — and it is never
 * reached for an Attempt the checks already refused, because work that does not
 * build is not work a reviewer has anything to say about.
 *
 * The reviewer is handed the work rather than pointed at it. A reviewer that
 * could reach into the project could leave something behind, and the Checkpoint
 * that follows an approval sweeps up whatever it finds — a Checkpoint has to be
 * the Run's work and nobody else's.
 */
async function reviewTheWork(
  queued: Queued,
  before: string,
  context: RunContext,
): Promise<ReviewOutcome | undefined> {
  if (!context.review.enabled) return undefined;

  return context.runner.review({
    ticket: queued.ticket,
    projectDirectory: context.project.directory,
    diff: await context.repository.diffSince(before),
    // The ticket is still being attempted, so what the reviewer says goes where
    // the Run's own narration went: to whoever is watching this ticket.
    onOutput: (chunk) => context.live.lines.push(chunk),
  });
}

/**
 * A review that turned the work down, as the refusal it is. The reviewer's own
 * words are the whole of it: they are what the ticket fails with and what the
 * next Attempt is given to be smarter about, so nothing else would help either.
 */
function refusalFromReview(review: ReviewOutcome | undefined): Refusal | undefined {
  if (review?.status !== "reviewed" || review.verdict === "approved") return undefined;

  // A reviewer that turned the work down and said nothing about why has still
  // turned it down. Saying so plainly beats a reason that trails off into
  // nothing, which is what the morning would otherwise read on the ticket.
  const said = review.reasoning.trim();
  const reason =
    said === ""
      ? "the review refused the attempt without saying why"
      : `the review refused the attempt: ${said}`;

  return { reason, output: "" };
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
  moveRestorePoint(context, recorded ?? context.restorePoint);

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
