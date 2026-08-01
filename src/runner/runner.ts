import type { Ticket } from "../tickets/ticket.js";
import type { AttemptReview } from "../verification/review.js";

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

/**
 * Everything a review has to work from: the ticket to judge against, and the
 * work the Attempt left behind. The diff is handed over rather than looked up,
 * so a reviewer needs nothing that could reach back into the project — the
 * Checkpoint that follows an approval must be the Run's work and nobody else's.
 */
export interface ReviewRequest {
  ticket: Ticket;
  projectDirectory: string;
  /** Everything the Attempt changed, as a diff against where it started. */
  diff: string;
  /** Handed each line of output as it arrives, so a review is watched like a Run. */
  onOutput?: (chunk: string) => void;
}

/**
 * What the review made of the Attempt. `limit-hit` is neither verdict: the quota
 * stopped the review before it judged anything, which leaves the Attempt as
 * unjudged as one whose own Run was cut short.
 */
export type ReviewOutcome =
  | ({ status: "reviewed"; output: string } & AttemptReview)
  | { status: "limit-hit"; resetAt: Date | null; output: string };

/** Executes exactly one Attempt: a single headless Claude Code Run for one ticket. */
export interface Runner {
  run(request: RunRequest): Promise<RunOutcome>;
  /**
   * Judges what a verified Attempt left behind against its ticket. Another Run,
   * so it belongs to the one place Claude Code is launched from — and it is only
   * ever asked for by an instance that turned reviews on.
   */
  review(request: ReviewRequest): Promise<ReviewOutcome>;
}
