/**
 * Time, as the one thing that has to be lied to in a test. Waiting out a weekly
 * usage limit is days of real waiting and a few milliseconds of pretend waiting,
 * and every other seam in this codebase is real — so this is the narrowest thing
 * that lets a test prove a wait without taking a week to do it.
 */
export interface Clock {
  now(): Date;
  /**
   * Waits until the given moment, or until the wait is called off, whichever
   * comes first. A moment that has already gone by is no wait at all.
   *
   * The moment rather than a span, so a wait says what it is for: nothing can
   * come between working out when to wake and settling down to wait, and a wait
   * of days does not drift by however long the working out took.
   */
  sleepUntil(moment: Date, until: AbortSignal): Promise<void>;
}

/** Real time, as the Supervisor runs on unless a test says otherwise. */
export function systemClock(): Clock {
  return {
    now: () => new Date(),
    sleepUntil: (moment, until) =>
      new Promise<void>((resolve) => {
        if (until.aborted) return resolve();

        const timer = setTimeout(finish, Math.max(0, moment.getTime() - Date.now()));
        // Waiting out a limit is not on its own a reason for the process to stay
        // up; the service listening on its port is what does that.
        timer.unref();
        until.addEventListener("abort", finish, { once: true });

        function finish(): void {
          clearTimeout(timer);
          until.removeEventListener("abort", finish);
          resolve();
        }
      }),
  };
}
