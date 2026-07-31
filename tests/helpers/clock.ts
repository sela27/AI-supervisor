import type { Clock } from "../../src/clock.js";

export interface TestClock extends Clock {
  /**
   * Moves time on, waking whatever was waiting for a moment that has now passed.
   * A week of a weekly limit costs a test one call.
   */
  advance(ms: number): void;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * Time a test moves by hand. A wait for a moment that has already gone by is over
 * the instant it starts, so a test that moved the clock on while the run was
 * still on its way to waiting does not leave it waiting for ever.
 */
export function testClock(start: Date): TestClock {
  let now = start.getTime();
  let waiting: { moment: number; wake: () => void }[] = [];

  function wakeWhatIsDue(): void {
    const due = waiting.filter((sleeper) => sleeper.moment <= now);
    waiting = waiting.filter((sleeper) => sleeper.moment > now);
    for (const sleeper of due) sleeper.wake();
  }

  return {
    now: () => new Date(now),

    sleepUntil: (moment, until) =>
      new Promise<void>((resolve) => {
        if (until.aborted) return resolve();

        const sleeper = { moment: moment.getTime(), wake: calledOff };
        function calledOff(): void {
          waiting = waiting.filter((candidate) => candidate !== sleeper);
          until.removeEventListener("abort", calledOff);
          resolve();
        }

        until.addEventListener("abort", calledOff, { once: true });
        waiting.push(sleeper);
        wakeWhatIsDue();
      }),

    advance: (ms) => {
      now += ms;
      wakeWhatIsDue();
    },
  };
}
