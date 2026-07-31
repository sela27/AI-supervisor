import type { EventSink, SupervisorEvent } from "../events.js";
import type { Notifier } from "./notifier.js";
import type { NotificationSettings } from "./settings.js";
import { notificationFor } from "./wording.js";

/**
 * Turns the moments the Supervisor recognises into notifications, or into
 * nothing. Everything about *whether* somebody is told lives here, so the
 * Notifier below it has only ever to deliver what it is handed.
 *
 * The sink cannot throw and cannot block. Raising an Event happens in the middle
 * of running a queue — inside the very `try` that decides whether the run broke
 * down — so a sink that could fail would let the telling of the news become the
 * news.
 */
export function notifyOn(settings: NotificationSettings, notifier: Notifier): EventSink {
  return (event) => {
    // Fired and forgotten, deliberately: whoever raised this Event has a run to
    // get on with, and a webhook that is down, slow or simply wrong is never
    // allowed to become the reason the night stopped. There is nowhere to report
    // the refusal to, either — the thing that reaches a person is the thing that
    // has just failed.
    void deliver(settings, notifier, event).catch(() => {});
  };
}

/**
 * One Event, said or not said, waited for. Only one caller waits: the process on
 * its way out, which has no run left to hold up and one last thing to say.
 */
export async function deliver(
  settings: NotificationSettings,
  notifier: Notifier,
  event: SupervisorEvent,
): Promise<void> {
  if (!settings.enabled) return;
  if (settings.on[event.type] === false) return;

  await notifier(notificationFor(event));
}
