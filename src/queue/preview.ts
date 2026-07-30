import { TicketSourceError } from "../tickets/errors.js";
import type { Ticket } from "../tickets/ticket.js";

/**
 * `done` — already finished, never runnable. `blocked` — at least one blocker is
 * not done yet. `ready` — on the Frontier.
 */
export type TicketState = "done" | "blocked" | "ready";

export interface QueueTicket extends Ticket {
  state: TicketState;
}

export interface QueuePreview {
  /** Every ticket, in an order no ticket precedes one of its blockers. */
  tickets: QueueTicket[];
  /** The ids of the tickets that could run right now. */
  frontier: string[];
}

/** Turns discovered tickets into the Queue the user reviews before starting a run. */
export function previewQueue(tickets: Ticket[]): QueuePreview {
  const done = new Set(tickets.filter(isDone).map((ticket) => ticket.id));

  const ordered = orderByBlockingEdges(tickets).map((ticket) => ({
    ...ticket,
    state: stateOf(ticket, done),
  }));

  return {
    tickets: ordered,
    frontier: ordered.filter((ticket) => ticket.state === "ready").map((ticket) => ticket.id),
  };
}

function isDone(ticket: Ticket): boolean {
  return ticket.status.trim().toLowerCase() === "done";
}

function stateOf(ticket: Ticket, done: ReadonlySet<string>): TicketState {
  if (done.has(ticket.id)) return "done";
  return blockersAllIn(ticket, done) ? "ready" : "blocked";
}

function blockersAllIn(ticket: Ticket, ids: ReadonlySet<string>): boolean {
  return ticket.blockedBy.every((id) => ids.has(id));
}

function orderByBlockingEdges(tickets: Ticket[]): Ticket[] {
  const remaining = [...tickets];
  const ordered: Ticket[] = [];
  const placed = new Set<string>();

  while (remaining.length > 0) {
    const ready = remaining.filter((ticket) => blockersAllIn(ticket, placed));
    if (ready.length === 0) {
      const ids = remaining.map((ticket) => ticket.id).join(", ");
      throw new TicketSourceError(`These tickets block each other, so no order exists: ${ids}`);
    }

    for (const ticket of ready) {
      ordered.push(ticket);
      placed.add(ticket.id);
      remaining.splice(remaining.indexOf(ticket), 1);
    }
  }

  return ordered;
}
