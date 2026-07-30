import { isDone, type Ticket } from "../tickets/ticket.js";
import { downstreamOf } from "./dependents.js";
import { QueueEditError } from "./errors.js";

/**
 * The user's Queue edit. Both halves are optional and an empty edit is the Queue
 * exactly as the Ticket Source wrote it, so editing is something the user did
 * rather than something every request has to say.
 */
export interface QueueEdit {
  /** Tickets to leave out. Everything waiting on one of them comes out with it. */
  exclude: string[];
  /**
   * The order to run in. The tickets it names go first, in that order; everything
   * it does not name keeps its place behind them, as the Ticket Source wrote it.
   * Naming one ticket is therefore how the queue is rearranged, not a promise to
   * account for all of them.
   */
  order: string[];
}

/**
 * No edit at all — what a request that says nothing about the queue means. A
 * fresh one each time, so nobody's edit can ever become everybody's.
 */
export function unedited(): QueueEdit {
  return { exclude: [], order: [] };
}

export interface EditedQueue {
  tickets: Ticket[];
  /** Every id the edit took out, the ones taken along with them included. */
  excluded: string[];
}

/**
 * Carries out the user's edit against tickets already in dependency order, and
 * refuses an edit that could not be run: one naming a ticket that is not there,
 * or asking for a ticket to be attempted before a blocker that has yet to finish.
 * A done blocker gates nothing, so it never stands in the way of a rearrangement.
 */
export function applyEdit(ordered: Ticket[], edit: QueueEdit): EditedQueue {
  refuseUnknown(ordered, [...edit.exclude, ...edit.order]);

  const excluded = downstreamOf(ordered, edit.exclude);
  const kept = ordered.filter((ticket) => !excluded.has(ticket.id));

  const tickets = rearranged(kept, edit.order);
  refuseImpossibleOrder(tickets);

  // Reported in the queue's own order rather than the order the user named them
  // in, so the tail an exclusion took with it reads as the tail it was.
  const taken = ordered.map((ticket) => ticket.id).filter((id) => excluded.has(id));
  return { tickets, excluded: taken };
}

function refuseUnknown(ordered: Ticket[], named: string[]): void {
  const known = new Set(ordered.map((ticket) => ticket.id));
  const strangers = [...new Set(named)].filter((id) => !known.has(id));
  if (strangers.length === 0) return;

  throw new QueueEditError(
    `The queue has no ticket called ${strangers.map((id) => JSON.stringify(id)).join(", ")}`,
  );
}

/** The named tickets first, in the order given; everything else keeps its place. */
function rearranged(kept: Ticket[], order: string[]): Ticket[] {
  const named = [...new Set(order)];
  const moved = new Set(named);

  return [
    ...named
      .map((id) => kept.find((ticket) => ticket.id === id))
      .filter((ticket): ticket is Ticket => ticket !== undefined),
    ...kept.filter((ticket) => !moved.has(ticket.id)),
  ];
}

/**
 * Refuses an order the run could never carry out. A ticket placed before a
 * blocker that still has to run is a ticket the Frontier would never reach, so
 * the queue is turned down rather than started and left stuck.
 */
function refuseImpossibleOrder(tickets: Ticket[]): void {
  const gating = new Set(tickets.filter((ticket) => !isDone(ticket)).map((ticket) => ticket.id));
  const placed = new Set<string>();

  for (const ticket of tickets) {
    const early = ticket.blockedBy.find((id) => gating.has(id) && !placed.has(id));
    if (early !== undefined) {
      throw new QueueEditError(`${ticket.id} is blocked by ${early}, so it cannot run before it`);
    }
    placed.add(ticket.id);
  }
}
