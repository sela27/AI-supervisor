import type { EventSink, SupervisorEvent } from "../../src/events.js";

/**
 * Everything the Supervisor wanted somebody told about, in the order it wanted
 * it. Nothing consumes these yet — notifications are their own ticket — so this
 * stands in for whatever eventually reaches the phone.
 */
export interface EventRecorder {
  onEvent: EventSink;
  /** Everything recorded of one kind, oldest first. */
  of(type: SupervisorEvent["type"]): SupervisorEvent[];
}

export function recordEvents(): EventRecorder {
  const events: SupervisorEvent[] = [];
  return {
    onEvent: (event) => events.push(event),
    of: (type) => events.filter((event) => event.type === type),
  };
}
