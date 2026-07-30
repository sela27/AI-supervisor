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
 * A control the run cannot obey as it stands — pausing what is not running,
 * retrying what did not fail. The run is untouched: a control that cannot be
 * carried out does nothing rather than something else.
 */
export class QueueControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueControlError";
  }
}

/** A control naming a ticket that is not in the run — nothing to do it to. */
export class TicketNotInQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketNotInQueueError";
  }
}

/**
 * The user's Queue edit cannot be carried out — it names a ticket the Ticket
 * Source never had, or asks for an order the blocking edges forbid. Refused
 * before anything starts, so an impossible queue is never half-run.
 */
export class QueueEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueEditError";
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
