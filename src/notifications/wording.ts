import type { NightsAccount, SupervisorEvent } from "../events.js";
import type { Notification } from "./notifier.js";

/**
 * How much of a failure a notification carries. What refused an Attempt is
 * usually a line; a Run that fell over can report a stack trace, and a phone is
 * the wrong place to read one — the whole of it is under `/attempts` either way.
 */
const MOST_CHARACTERS = 1_000;

/**
 * What each Event is worth saying to somebody who is asleep, at work, or
 * otherwise not looking. Every one of them says what happened and what — if
 * anything — is now expected of the reader, because the point of a notification
 * is to be the only thing that has to be read.
 */
export function notificationFor(event: SupervisorEvent): Notification {
  return { type: event.type, ...worded(event) };
}

function worded(event: SupervisorEvent): Omit<Notification, "type"> {
  switch (event.type) {
    case "queue-finished": {
      const counts = howEachTicketEnded(event);
      return {
        title: `Queue finished: ${counts}`,
        body: `${counts}.\nThe night's work is on ${event.branch}.`,
      };
    }

    case "safety-stop-reached":
      return {
        // The stop itself is the headline: it is the whole of why the night is
        // over early, and it reads as a sentence on a lock screen already.
        title: `Run stopped: ${event.stoppedBy}`,
        body:
          `${event.stoppedBy}, so the run ended there.\n\n${howEachTicketEnded(event)}.\n` +
          `The night's work is on ${event.branch}.\n` +
          `Everything it never reached is still waiting, and nothing picks it up by itself.`,
      };

    case "ticket-failed":
      return {
        title: `Ticket failed: ${event.title}`,
        body:
          `${event.ticketId} — ${event.title}\n\n${shortened(event.failure)}\n\n` +
          `Everything waiting on it was skipped; the rest of the queue carries on.`,
      };

    case "long-wait":
      return {
        title: "Waiting out the usage limit",
        body:
          `${event.ticketId} was not attempted, and nothing is held against it. ` +
          `The run means to have it again at ${event.resumeAt}, and picks itself ` +
          `up without being asked.`,
      };

    case "run-broke-down":
      return {
        title: "The run broke down",
        body:
          `Run ${event.runId} could not go on:\n\n${shortened(event.error)}\n\n` +
          `Nothing picks it up by itself.`,
      };

    case "supervisor-crashed":
      return {
        title: "The Supervisor crashed",
        body:
          `The service is going down:\n\n${shortened(event.error)}\n\n` +
          `Whatever was under way stopped where it stood, on the run's own branch.`,
      };
  }
}

/**
 * The three numbers, in the one form both endings say them. A night that ran out
 * of queue and a night a stop ended read alike here on purpose: it is the same
 * night either way, and the morning is looking for the same thing.
 */
function howEachTicketEnded(night: NightsAccount): string {
  return `${night.succeeded} succeeded, ${night.failed} failed, ${night.skipped} skipped`;
}

/** Enough of a failure to know what it was, and no more than a phone will take. */
function shortened(reason: string): string {
  return reason.length <= MOST_CHARACTERS ? reason : `${reason.slice(0, MOST_CHARACTERS)}…`;
}
