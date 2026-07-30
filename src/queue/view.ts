import type { QueueEngine, QueueRunState, TicketRun } from "./engine.js";

/**
 * The queue as anything outside the engine sees it, including before the first run
 * has ever started — `idle` is not a state a run can be in, it is the absence of one.
 */
export interface QueueView {
  id: string | null;
  branch: string | null;
  state: QueueRunState | "idle";
  tickets: TicketRun[];
  /** Why the run broke down, when it did. A failed ticket is not that. */
  error: string | null;
  /** Why Checkpoints are not reaching the remote, while they are not. */
  pushFailure: string | null;
}

/** The Attempt being watched: whose it is, and what it has printed so far. */
export interface LiveOutputView {
  ticketId: string | null;
  output: string;
}

export function currentQueue(engine: QueueEngine): QueueView {
  return (
    engine.current() ?? {
      id: null,
      branch: null,
      state: "idle",
      tickets: [],
      error: null,
      pushFailure: null,
    }
  );
}

/**
 * What there is to watch right now. Only the ticket being attempted has a log in
 * flight; between tickets, and once the run has ended, there is nothing to watch
 * and the finished Attempts' own logs are what is left to read.
 *
 * Which ticket that is comes from the queue rather than from the engine's own last
 * Attempt: the engine goes on remembering whose log it holds after the run has
 * ended, and a finished run has nothing in flight to show.
 */
export function liveOutput(engine: QueueEngine, queue: QueueView): LiveOutputView {
  const running = queue.tickets.find((ticket) => ticket.state === "running");
  if (!running) return { ticketId: null, output: "" };
  return { ticketId: running.id, output: engine.liveOutput(running.id) };
}
