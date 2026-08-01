import { asRecord } from "../json.js";
import { asSourceSelection, type SourceSelection } from "../tickets/source.js";
import type { AcceptanceCriterion, Ticket } from "../tickets/ticket.js";
import type { Project, QueueRun, QueueRunState, TicketRun, TicketRunState } from "./engine.js";

/** One queued ticket as the run was given it, and what the user did with it. */
export interface QueuedRecord {
  ticket: Ticket;
  /**
   * Whether the user took this ticket out of the queue themselves. A ticket left
   * out on purpose reads exactly like one a failed blocker doomed, and the two are
   * owed different things when that blocker is retried — so which is which is
   * written down rather than guessed at afterwards.
   */
  takenOut: boolean;
}

/**
 * A run written down, so that a Supervisor started afresh can pick the night up
 * where the last one left it. Deliberately not a second account of the run: what
 * is done is still the Ticket Source's to say, and what each Attempt printed is
 * still its own table. This is only what nothing else remembers — which run was
 * under way, what it was in the middle of, and where to throw a dead Attempt back
 * to.
 *
 * The Queue is here because it has to be: a Ticket Source is asked for the tickets
 * it is offering tonight, and a ticket this run has already closed or handed back
 * is not among them. Asking again would lose the very tickets the night finished.
 */
export interface RunRecord {
  run: QueueRun;
  /** The Queue as the run was given it, in the order it runs. */
  queue: QueuedRecord[];
  /** The Ticket Source the run reads and writes back to, to be opened again. */
  source: SourceSelection;
  project: Project;
  /** The hour an armed run has still to wait for. Nothing once it has begun. */
  startAt: string | null;
  /** When the run began working — what its allowed time is measured from. */
  startedAt: string | null;
  ticketsRun: number;
  failuresInARow: number;
  /** The commit a dead Attempt is thrown back to: the run's last Checkpoint. */
  restorePoint: string;
  /**
   * The spell of usage limits the run is sitting through, while it is. Kept so a
   * restart does not start the spell over — and so the phone is not told about the
   * same long wait twice.
   */
  limit: { since: string; announced: boolean } | null;
}

const RUN_STATES: readonly QueueRunState[] = [
  "armed",
  "running",
  "paused",
  "stopped",
  "completed",
  "failed",
  "paused-on-limit",
];

const TICKET_STATES: readonly TicketRunState[] = [
  "done",
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
];

/**
 * Reads back a run this Supervisor — or a different build of it — wrote down.
 * Anything that does not read as a whole run is treated as no run at all: half a
 * run picked up is a night spent doing the wrong thing, where none picked up is
 * only a night not continued, and the Ticket Source still holds every finished
 * ticket either way.
 */
export function readRunRecord(value: unknown): RunRecord | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const run = readRun(record.run);
  const queue = readQueue(record.queue);
  const source = asSourceSelection(record.source);
  const project = readProject(record.project);
  const restorePoint = text(record.restorePoint);
  const ticketsRun = count(record.ticketsRun);
  const failuresInARow = count(record.failuresInARow);

  if (!run || !queue || !source || !project) return undefined;
  if (restorePoint === undefined || ticketsRun === undefined || failuresInARow === undefined) {
    return undefined;
  }

  return {
    run,
    queue,
    source,
    project,
    startAt: text(record.startAt) ?? null,
    startedAt: text(record.startedAt) ?? null,
    ticketsRun,
    failuresInARow,
    restorePoint,
    limit: readLimit(record.limit),
  };
}

function readRun(value: unknown): QueueRun | undefined {
  const run = asRecord(value);
  if (!run) return undefined;

  const id = text(run.id);
  const branch = text(run.branch);
  const state = RUN_STATES.find((known) => known === run.state);
  const tickets = readAll(run.tickets, readEntry);

  if (id === undefined || branch === undefined || state === undefined || !tickets) return undefined;

  return {
    id,
    branch,
    state,
    tickets,
    instruction: run.instruction === "pause" || run.instruction === "stop" ? run.instruction : null,
    resumeAt: text(run.resumeAt) ?? null,
    error: text(run.error) ?? null,
    stoppedBy: text(run.stoppedBy) ?? null,
    pushFailure: text(run.pushFailure) ?? null,
  };
}

function readEntry(value: unknown): TicketRun | undefined {
  const entry = asRecord(value);
  if (!entry) return undefined;

  const id = text(entry.id);
  const title = text(entry.title);
  const state = TICKET_STATES.find((known) => known === entry.state);
  const attempts = count(entry.attempts);

  if (id === undefined || title === undefined || state === undefined) return undefined;
  if (attempts === undefined) return undefined;

  return {
    id,
    title,
    state,
    checkpoint: text(entry.checkpoint) ?? null,
    failure: text(entry.failure) ?? null,
    attempts,
  };
}

function readQueue(value: unknown): QueuedRecord[] | undefined {
  return readAll(value, (queued) => {
    const item = asRecord(queued);
    const ticket = readTicket(item?.ticket);
    return ticket === undefined ? undefined : { ticket, takenOut: item?.takenOut === true };
  });
}

function readTicket(value: unknown): Ticket | undefined {
  const ticket = asRecord(value);
  if (!ticket) return undefined;

  const id = text(ticket.id);
  const title = text(ticket.title);
  const blockedBy = readAll(ticket.blockedBy, text);
  const acceptanceCriteria = readAll(ticket.acceptanceCriteria, readCriterion);

  if (id === undefined || title === undefined) return undefined;
  if (typeof ticket.status !== "string" || !blockedBy || !acceptanceCriteria) return undefined;

  return { id, title, status: ticket.status, blockedBy, acceptanceCriteria };
}

function readCriterion(value: unknown): AcceptanceCriterion | undefined {
  const criterion = asRecord(value);
  return typeof criterion?.text === "string"
    ? { text: criterion.text, done: criterion.done === true }
    : undefined;
}

function readProject(value: unknown): Project | undefined {
  const project = asRecord(value);
  const directory = text(project?.directory);
  const verify = readAll(project?.verify, text);

  if (directory === undefined || !verify || typeof project?.pushCheckpoints !== "boolean") {
    return undefined;
  }

  return { directory, verify, pushCheckpoints: project.pushCheckpoints };
}

function readLimit(value: unknown): RunRecord["limit"] {
  const limit = asRecord(value);
  const since = text(limit?.since);
  return since === undefined ? null : { since, announced: limit?.announced === true };
}

/**
 * A list every one of whose entries reads, or nothing at all. One unreadable
 * ticket in a Queue is not a Queue with one ticket missing — it is a record this
 * build does not understand, and understanding it in part is the one thing worse
 * than not understanding it.
 */
function readAll<T>(value: unknown, read: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const all = value.map(read);
  return all.every((item): item is T => item !== undefined) ? all : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}
