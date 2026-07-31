import { TicketSourceError } from "../tickets/errors.js";
import { isDone, type Ticket } from "../tickets/ticket.js";
import { applyEdit, unedited, type QueueEdit } from "./edit.js";

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
  /** Every id the user's edit took out, the ones taken along with them included. */
  excluded: string[];
}

/**
 * Turns discovered tickets into the Queue the user reviews before starting a run,
 * carrying out whatever edit the user made of it. The run starts from this same
 * function, so what the preview shows is what the run executes rather than a
 * separate account of it.
 */
export function previewQueue(tickets: Ticket[], edit: QueueEdit = unedited()): QueuePreview {
  const edited = applyEdit(orderByBlockingEdges(tickets), edit);
  const done = new Set(edited.tickets.filter(isDone).map((ticket) => ticket.id));

  const ordered = edited.tickets.map((ticket) => ({
    ...ticket,
    state: stateOf(ticket, done),
  }));

  return {
    tickets: ordered,
    frontier: ordered.filter((ticket) => ticket.state === "ready").map((ticket) => ticket.id),
    excluded: edited.excluded,
  };
}

function stateOf(ticket: Ticket, done: ReadonlySet<string>): TicketState {
  if (done.has(ticket.id)) return "done";
  return blockersAllIn(ticket, done) ? "ready" : "blocked";
}

function blockersAllIn(ticket: Ticket, ids: ReadonlySet<string>): boolean {
  return ticket.blockedBy.every((id) => ids.has(id));
}

/**
 * Takes the earliest ticket whose blockers are already placed, over and over.
 * Where the blocking edges leave a choice the Ticket Source's own order decides,
 * so a queue runs in the order the tickets were written.
 *
 * An edge may name a ticket this Queue does not hold — on GitHub, an open issue
 * that is not the Supervisor's to run. There is no place to put what is not here,
 * so such an edge orders nothing; it still gates, because nothing in the Queue
 * will ever finish it, and what it blocks is reported blocked and never run.
 */
function orderByBlockingEdges(tickets: Ticket[]): Ticket[] {
  const remaining = [...tickets];
  const ordered: Ticket[] = [];
  const inQueue = new Set(tickets.map((ticket) => ticket.id));
  const placed = new Set<string>();

  while (remaining.length > 0) {
    const ticket = remaining.find((candidate) =>
      candidate.blockedBy.every((id) => placed.has(id) || !inQueue.has(id)),
    );
    // Nothing is placeable while tickets remain: what is left is a cycle.
    if (!ticket) {
      const ids = remaining.map((blocked) => blocked.id).join(", ");
      throw new TicketSourceError(`These tickets block each other, so no order exists: ${ids}`);
    }

    remaining.splice(remaining.indexOf(ticket), 1);
    ordered.push(ticket);
    placed.add(ticket.id);
  }

  return ordered;
}
