import type { GhCommand } from "./gh.js";
import { githubTicketSource } from "./github-source.js";
import { localTicketSource } from "./local-source.js";
import type { Ticket, TicketResult } from "./ticket.js";

/**
 * Which Ticket Source a queue reads from, and where it lives. A queue picks
 * exactly one: a run reading from two would have no single place its outcomes
 * belong, and no single answer to what is done.
 */
export type SourceSelection =
  | { type: "local"; directory: string }
  | { type: "github"; repository: string };

/**
 * Where the tickets of one Queue live, and where their outcomes are written back.
 * Done-ness lives here rather than in the Supervisor's own history, so a
 * Supervisor started afresh still agrees with the source about what is finished.
 */
export interface TicketSource {
  /** Every ticket of this Queue, with its blocking edges resolved to ticket ids. */
  discover(): Promise<Ticket[]>;

  /**
   * Records the ticket finished, with the whole account of the run that finished
   * it. Said before the Checkpoint that ends it is made, so that a source keeping
   * its tickets among the project's own files has its write-back committed along
   * with the work it is about.
   */
  markDone(ticket: Ticket, result: TicketResult): Promise<void>;

  /**
   * Names the commit the finished ticket ended in, once there is one to name.
   * Separate from `markDone` because the Checkpoint cannot exist until everything
   * the write-back leaves in the project's files is inside it: a file inside a
   * commit cannot name the commit it is inside, and a source that writes
   * elsewhere has no other way at all to point at the work.
   */
  recordCheckpoint(ticket: Ticket, checkpoint: string): Promise<void>;

  /**
   * Records a ticket the Supervisor could not get past, with the summary of what
   * went wrong, so the morning's triage starts from the ticket itself.
   */
  markFailed(ticket: Ticket, summary: string): Promise<void>;

  /**
   * Takes an earlier failure back off a ticket that is about to be attempted
   * again. A ticket that goes on to succeed still carrying the reason it did not
   * is a lie the morning's triage reads.
   */
  clearFailure(ticket: Ticket): Promise<void>;
}

/**
 * What `gh --repo` understands, and all it understands: `owner/name`. A bare
 * repository name works only from inside a clone of it, and the Supervisor is
 * standing in the project rather than in the repository the issues live in — so
 * a half-written name is refused where it is written, not at the first run.
 */
export function isRepositoryName(value: string): boolean {
  return /^[^/\s]+\/[^/\s]+$/.test(value.trim());
}

/**
 * A selection as it was written down somewhere, read back. Only the shape is
 * answered for: what a half-written source should be said to whoever wrote it is
 * the business of whoever is reading their words, not of this.
 */
export function asSourceSelection(value: unknown): SourceSelection | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const named = value as { type?: unknown; directory?: unknown; repository?: unknown };

  if (named.type === "local" && typeof named.directory === "string" && named.directory !== "") {
    return { type: "local", directory: named.directory };
  }
  if (named.type === "github" && typeof named.repository === "string" && named.repository !== "") {
    return { type: "github", repository: named.repository };
  }
  return undefined;
}

/** Opens the source a queue asked for. One per run, and only for that run. */
export function openTicketSource(selection: SourceSelection, gh: GhCommand): TicketSource {
  return selection.type === "local"
    ? localTicketSource(selection.directory)
    : githubTicketSource(selection.repository, gh);
}
