import type { Ticket } from "../tickets/ticket.js";

/** Everything a Run has to work from: one ticket, and the project it applies to. */
export interface RunRequest {
  ticket: Ticket;
  projectDirectory: string;
}

/**
 * What the Run reported about itself, and everything it printed getting there.
 * The Supervisor never takes `succeeded` at face value — Verification decides
 * whether the Attempt actually succeeded. The output it keeps either way: a
 * failed Attempt's work is thrown back to the last Checkpoint, so the log is all
 * that is left to read afterwards.
 */
export type RunOutcome =
  | { status: "succeeded"; output: string }
  | { status: "failed"; reason: string; output: string };

/** Executes exactly one Attempt: a single headless Claude Code Run for one ticket. */
export interface Runner {
  run(request: RunRequest): Promise<RunOutcome>;
}
