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
 * Whether the Ticket Source reports the ticket finished. Done-ness lives in the
 * status the source wrote, so this is the one place that reads it as a fact.
 */
export function isDone(ticket: Ticket): boolean {
  return ticket.status.trim().toLowerCase() === "done";
}
