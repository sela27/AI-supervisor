import { silentNotifier, type Notifier } from "./notifier.js";

/**
 * How long a notification is given to be taken. The run is not waiting for it —
 * nothing ever is — but a webhook that accepts a connection and then says nothing
 * would otherwise hold one open for the rest of the night, once per Event.
 */
const GIVE_UP_AFTER = 10_000;

/**
 * Whether a webhook is somewhere a notification could actually be posted. A
 * mistyped one fails at 3am, where the failure has by definition nowhere to be
 * reported to, so it is worth refusing while somebody is still reading.
 */
export function isWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Posts each notification to one webhook as plain text — the shape
 * [ntfy.sh](https://ntfy.sh) takes as it stands (`POST https://ntfy.sh/<topic>`)
 * and the shape anything else can read without knowing anything about the
 * Supervisor. The headline is the first line of the body rather than a header of
 * its own, so a title with an em dash or a word of Hebrew in it survives the trip.
 *
 * A Supervisor pointed at no webhook says nothing at all, which is what a person
 * who does not want to be told is asking for.
 */
export function webhookNotifier(url: string | undefined): Notifier {
  if (url === undefined) return silentNotifier;

  return async ({ title, body }) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: `${title}\n\n${body}`,
      signal: AbortSignal.timeout(GIVE_UP_AFTER),
    });

    // Read, so the connection is finished with rather than left to the collector.
    await response.text();
    if (!response.ok) {
      throw new Error(`${url} answered ${response.status} ${response.statusText}`);
    }
  };
}
