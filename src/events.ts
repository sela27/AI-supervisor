/**
 * Something the Supervisor wants somebody told about — not the run's state, which
 * the API and the Dashboard already carry, but a moment worth reaching a person
 * who is not looking at either.
 */
export type SupervisorEvent = {
  type: "long-wait";
  runId: string;
  /** The ticket the usage limit interrupted, which the wait is holding up. */
  ticketId: string;
  /** When the run means to try that ticket again. */
  resumeAt: string;
};

/**
 * Where Events go. Notifications are not built yet and the Supervisor's own sink
 * drops everything it is given — what matters now is that the moments worth
 * telling somebody about are recognised where they happen, rather than being
 * worked out later by whatever ends up reaching the phone.
 */
export type EventSink = (event: SupervisorEvent) => void;

export const noEvents: EventSink = () => {};
