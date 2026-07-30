/**
 * A second run was asked for while one was still going. Tickets execute strictly
 * one at a time, and so do runs — the Supervisor drives one project.
 */
export class QueueRunInProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueRunInProgressError";
  }
}

/**
 * The subscription's usage limit stopped a Run. Not a breakdown and not a ticket
 * failure — it unwinds the run the same way an error would, but the queue reads
 * it as Paused-on-limit rather than as anything having gone wrong.
 */
export class UsageLimitError extends Error {
  /** When the limit lifts, when the Run could say. */
  readonly resetAt: Date | null;

  constructor(message: string, resetAt: Date | null) {
    super(message);
    this.name = "UsageLimitError";
    this.resetAt = resetAt;
  }
}
