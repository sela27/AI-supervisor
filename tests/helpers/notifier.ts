import type { SupervisorEventType } from "../../src/events.js";
import type { Notification, Notifier } from "../../src/notifications/notifier.js";

/**
 * The Notifier seam, standing in for whatever reaches the phone. Everything the
 * Supervisor said is here to be read, and nothing left the machine to get there.
 */
export interface FakeNotifier {
  notifier: Notifier;
  /** Everything said so far, oldest first. */
  sent: Notification[];
  /**
   * What was said about one kind of Event, in the order it was said. Matched on
   * the kind rather than on the wording, so a test about when the Supervisor
   * speaks is not also a test of how it puts things.
   */
  about(type: SupervisorEventType): Notification[];
}

/**
 * `deliver` is how the webhook behaves — refusing, or never answering at all —
 * for the tests about a notification that cannot be delivered. Left out, every
 * notification is taken.
 */
export function fakeNotifier(deliver: Notifier = async () => {}): FakeNotifier {
  const sent: Notification[] = [];

  return {
    sent,
    notifier: async (notification) => {
      sent.push(notification);
      await deliver(notification);
    },
    about: (type) => sent.filter((notification) => notification.type === type),
  };
}
