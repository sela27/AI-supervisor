import type { Ticket } from "../tickets/ticket.js";

/**
 * The given tickets and everything they gate, directly or through another
 * ticket. What a ticket's fate does to the queue behind it is the same question
 * whether the ticket is being excluded before the run or retried during it, so
 * it is answered in one place.
 */
export function downstreamOf(tickets: Ticket[], roots: Iterable<string>): Set<string> {
  const reached = new Set(roots);

  // Blocking edges are followed until nothing new turns up, rather than trusting
  // the queue's order: an edit is answered before anything has been ordered.
  for (let more = true; more; ) {
    more = false;
    for (const ticket of tickets) {
      if (reached.has(ticket.id)) continue;
      if (!ticket.blockedBy.some((id) => reached.has(id))) continue;
      reached.add(ticket.id);
      more = true;
    }
  }

  return reached;
}
