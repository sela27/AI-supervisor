import type { SupervisorEventType } from "../events.js";

/**
 * What carries an Event to a person who is not looking at the Dashboard. The
 * headline is what a phone shows on a locked screen; the body is what is read
 * after unlocking it, and it repeats whatever the headline said that matters, so
 * a target that only takes one of them still tells the whole story.
 */
export interface Notification {
  /** Which kind of Event this is about, which is what it *is* rather than how it reads. */
  type: SupervisorEventType;
  title: string;
  body: string;
}

/**
 * Delivers one notification, or refuses. Nothing ever waits for one of these:
 * whoever calls it has a run to get on with, and a webhook that is down is not
 * allowed to become the reason the night stopped.
 */
export type Notifier = (notification: Notification) => Promise<void>;

/** A Supervisor with nowhere to tell anybody anything. */
export const silentNotifier: Notifier = async () => {};
