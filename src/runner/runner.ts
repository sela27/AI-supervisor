import type { Ticket } from "../tickets/ticket.js";

/** Everything a Run has to work from: one ticket, and the project it applies to. */
export interface RunRequest {
  ticket: Ticket;
  projectDirectory: string;
}

/**
 * What the Run reported about itself. The Supervisor never takes `succeeded` at
 * face value — Verification decides whether the Attempt actually succeeded.
 */
export type RunOutcome = { status: "succeeded" } | { status: "failed"; reason: string };

/** Executes exactly one Attempt: a single headless Claude Code Run for one ticket. */
export interface Runner {
  run(request: RunRequest): Promise<RunOutcome>;
}
