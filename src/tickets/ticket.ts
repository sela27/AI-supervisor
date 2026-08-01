export interface AcceptanceCriterion {
  text: string;
  done: boolean;
}

/**
 * A ticket as any Ticket Source reports it, with its blocking edges resolved to
 * the ids of the tickets they name.
 */
export interface Ticket {
  id: string;
  title: string;
  status: string;
  blockedBy: string[];
  acceptanceCriteria: AcceptanceCriterion[];
}

/**
 * What the run made of a ticket it finished — everything the Ticket Source has
 * to write down beyond the fact that it is done, so that the ticket itself tells
 * the whole story of the night it was settled in.
 */
export interface TicketResult {
  /** The branch the ticket's work is on. */
  branch: string;
  /** The project's own commands, every one of which passed over the work. */
  checks: string[];
  /**
   * What the review made of the work, where the instance asked for one. Nothing
   * at all otherwise: the project's own checks pass or fail over the whole
   * Attempt, so they judge no acceptance criterion one by one.
   */
  review: TicketReview | undefined;
}

/** A review that let the work stand, and what it made of the ticket's criteria. */
export interface TicketReview {
  reasoning: string;
  /** The acceptance criteria it found met — the ones the write-back ticks. */
  criteriaMet: string[];
}

/**
 * Whether the Ticket Source reports the ticket finished. Done-ness lives in the
 * status the source wrote, so this is the one place that reads it as a fact.
 */
export function isDone(ticket: Ticket): boolean {
  return ticket.status.trim().toLowerCase() === "done";
}
