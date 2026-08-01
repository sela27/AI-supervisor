/**
 * How the night went and where it went. A run ends once and gets exactly one of
 * the two Events that are a last word, so both of them carry this: the account a
 * finished queue gives has to be given wherever the run actually ended.
 */
export interface NightsAccount {
  /** Where the night's work is, which is the whole of what the morning needs. */
  branch: string;
  succeeded: number;
  failed: number;
  skipped: number;
}

/**
 * Something the Supervisor wants somebody told about — not the run's state, which
 * the API and the Dashboard already carry, but a moment worth reaching a person
 * who is not looking at either.
 */
export type SupervisorEvent =
  | {
      type: "long-wait";
      runId: string;
      /** The ticket the usage limit interrupted, which the wait is holding up. */
      ticketId: string;
      /** When the run means to try that ticket again. */
      resumeAt: string;
    }
  | {
      type: "ticket-failed";
      runId: string;
      ticketId: string;
      title: string;
      /** What refused the last Attempt the ticket had left. */
      failure: string;
    }
  /** The queue run out: the ending the other four are all instead of. */
  | ({ type: "queue-finished"; runId: string } & NightsAccount)
  /**
   * A Safety stop ending the run — the one ending the user cannot see coming. A
   * stop they gave by hand raises nothing: that person is holding the phone they
   * would be told on.
   */
  | ({
      type: "safety-stop-reached";
      runId: string;
      /** Which stop it was, in the words the run reports it stopped by. */
      stoppedBy: string;
    } & NightsAccount)
  | {
      type: "run-broke-down";
      runId: string;
      /** What the run could not get past — never a ticket's failure, which is its own event. */
      error: string;
    }
  /**
   * The Supervisor itself going down, rather than a run stopping under it. There
   * is no run id because there may be no run: this is the process on its way out,
   * and everything it knew is about to stop being true.
   */
  | { type: "supervisor-crashed"; error: string };

export type SupervisorEventType = SupervisorEvent["type"];

/**
 * A record keyed by every event type and no others: adding an event to the union
 * without adding it here is a type error, which is what keeps the list below from
 * quietly falling behind the events that actually happen.
 */
const EVERY_TYPE: Record<SupervisorEventType, true> = {
  "queue-finished": true,
  "safety-stop-reached": true,
  "ticket-failed": true,
  "long-wait": true,
  "run-broke-down": true,
  "supervisor-crashed": true,
};

/** Every kind of Event there is, for whatever has to be told about each of them. */
export const EVENT_TYPES = Object.keys(EVERY_TYPE) as SupervisorEventType[];

/**
 * Where Events go. The Supervisor recognises the moments worth telling somebody
 * about where they happen; what becomes of them — a notification, or nothing at
 * all — is settled on the other side of this.
 */
export type EventSink = (event: SupervisorEvent) => void;
