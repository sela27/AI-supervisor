import type { Spend } from "../runner/spend.js";
import type { QueueEngine, QueueInstruction, QueueRunState, TicketRun } from "./engine.js";

/**
 * The queue as anything outside the engine sees it, including before the first run
 * has ever started — `idle` is not a state a run can be in, it is the absence of one.
 */
export interface QueueView {
  id: string | null;
  branch: string | null;
  state: QueueRunState | "idle";
  tickets: TicketRun[];
  /** What the run has been told to do and has not yet reached a boundary to do. */
  instruction: QueueInstruction | null;
  /** When a run that is not working means to be: a limit's hour, or an armed one's. */
  resumeAt: string | null;
  /** Why the run broke down, when it did. A failed ticket is not that. */
  error: string | null;
  /** Which Safety stop ended the run, when one did. The user's own stop does not. */
  stoppedBy: string | null;
  /** Why Checkpoints are not reaching the remote, while they are not. */
  pushFailure: string | null;
  /**
   * What the run has spent, its every Attempt added up. Nothing at all where no
   * Run of it reported a figure — the price of a night nobody priced is unknown,
   * not nought.
   */
  spent: Spend | null;
}

/** The Attempt being watched: whose it is, and what it has printed so far. */
export interface LiveOutputView {
  ticketId: string | null;
  output: string;
}

export function currentQueue(engine: QueueEngine): QueueView {
  const run = engine.current();
  if (!run) {
    return {
      id: null,
      branch: null,
      state: "idle",
      tickets: [],
      instruction: null,
      resumeAt: null,
      error: null,
      stoppedBy: null,
      pushFailure: null,
      spent: null,
    };
  }

  // Asked for beside the run rather than held on it: what a run has spent is the
  // Attempts filed under it added up, and nothing else is entitled to say.
  return { ...run, spent: engine.spentSoFar() };
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
