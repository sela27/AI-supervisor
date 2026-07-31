/**
 * How long the Supervisor sits out a usage limit, and when the sitting is long
 * enough to be worth telling somebody about. Policy only: the queue's own module
 * owns what a run does with these answers, and this owns what the answers are —
 * they are tuned for reasons of their own, which are about quotas rather than
 * about queues.
 */

/**
 * How long past a limit's stated reset the run waits before trying again. A quota
 * that lifts on the minute is one a run arriving on the minute is refused by, and
 * being refused costs another half-hour of waiting.
 */
const RESET_MARGIN_MS = 60_000;

/**
 * How long a limit that named no reset time waits before looking again. There is
 * nothing to project from, so the only way to find out whether the quota is back
 * is to go and ask — and asking is a Run, which is not free.
 */
const PROBE_EVERY_MS = 30 * 60_000;

/**
 * A spell of limits longer than this is one somebody wants telling about. Below
 * it, the run will be back at work before a person could reasonably wonder why it
 * has gone quiet.
 */
const LONG_WAIT_MS = 2 * 60 * 60_000;

/**
 * When to try the ticket again. The reset the Run named is what to go by, plus a
 * margin so the run is not refused a second time by seconds. A limit that named no
 * reset — or named one that has already gone by and refused the Run anyway —
 * leaves nothing to project from, so the run goes back to looking every so often.
 */
export function nextLookAt(resetAt: Date | null, now: Date): Date {
  if (resetAt !== null) {
    const lifts = resetAt.getTime() + RESET_MARGIN_MS;
    if (lifts > now.getTime()) return new Date(lifts);
  }

  return new Date(now.getTime() + PROBE_EVERY_MS);
}

/**
 * Whether the limit has held the run up long enough to be worth somebody's
 * attention. Measured from where the spell of limits began rather than from the
 * wait about to start, so a weekly cap that named no reset time — and is therefore
 * waited out in half-hour looks, none of them long — is not silently sat through
 * for days.
 */
export function isLongWait(since: Date, until: Date): boolean {
  return until.getTime() - since.getTime() >= LONG_WAIT_MS;
}
