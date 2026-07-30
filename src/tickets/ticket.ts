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
