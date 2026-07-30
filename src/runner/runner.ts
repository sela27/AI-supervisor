import type { Ticket } from "../tickets/ticket.js";

/** Everything a Run has to work from: one ticket, and the project it applies to. */
export interface RunRequest {
  ticket: Ticket;
  projectDirectory: string;
  /**
   * Why the last Attempt at this ticket was refused, when there was one. Runs
   * share no context and the refused Attempt's work has already been thrown
   * away, so this is everything this Run can know of what went before it.
   */
  previousFailure?: string;
  /** Handed each line of output as it arrives, for watching a Run as it happens. */
  onOutput?: (chunk: string) => void;
}

/**
 * What the Run reported about itself, and everything it printed getting there.
 * The Supervisor never takes `succeeded` at face value — Verification decides
 * whether the Attempt actually succeeded. The output it keeps either way: a
 * failed Attempt's work is thrown back to the last Checkpoint, so the log is all
 * that is left to read afterwards.
 *
 * `limit-hit` is neither of the other two: the subscription's usage limit stopped
 * the Run before it could settle the ticket, so nothing has been learned about
 * the ticket at all. `resetAt` is when the limit lifts, when the Run could say.
 */
export type RunOutcome =
  | { status: "succeeded"; output: string }
  | { status: "failed"; reason: string; output: string }
  | { status: "limit-hit"; resetAt: Date | null; output: string };

/** A Run that got far enough to say something about the ticket itself. */
export type SettledRun = Exclude<RunOutcome, { status: "limit-hit" }>;

/** Executes exactly one Attempt: a single headless Claude Code Run for one ticket. */
export interface Runner {
  run(request: RunRequest): Promise<RunOutcome>;
}
