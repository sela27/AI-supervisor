/** Something wrong with the Ticket Source, named precisely enough for the user to fix it. */
export interface TicketProblem {
  /** The ticket file at fault, when the problem belongs to one. */
  file?: string;
  message: string;
}

/**
 * The tickets could not be read as a Queue — a file missing a field, an edge that
 * names nothing, tickets that block each other. All of these are faults in what
 * the Ticket Source says, so they are reported the same way: every problem found
 * in one pass, so the user fixes the whole directory at once rather than one file
 * per attempt.
 */
export class TicketSourceError extends Error {
  readonly problems: readonly TicketProblem[];

  constructor(message: string, problems: readonly TicketProblem[] = []) {
    super(message);
    this.name = "TicketSourceError";
    this.problems = problems;
  }
}
