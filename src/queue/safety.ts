/**
 * The Safety stops: how far one run may go on its own before it gives up and
 * leaves the rest to a person. Policy only — the queue's own module owns what a
 * run does with these answers, and this owns what the answers are.
 *
 * Not to be read as the usage limit, which they are easy to confuse with. A usage
 * limit is the subscription's, it is nobody's fault, and the run waits it out. A
 * Safety stop is the user's own, set in advance, and reaching one ends the run.
 */

/** How far one run of this instance may go before it stops of its own accord. */
export interface SafetyStops {
  /** How many tickets one run may run, or nothing at all for as many as it has. */
  maxTickets: number | null;
  /** How long one run may go on for, or nothing at all for as long as it takes. */
  maxRuntimeMinutes: number | null;
  /**
   * How many tickets may fail one after another before the night is written off.
   * A project that is systematically broken refuses every ticket it is given, and
   * would spend the whole of the next day's quota finding that out again.
   */
  consecutiveFailures: number | null;
}

/** What the run has spent so far, which is what the stops are read against. */
export interface RunSoFar {
  /** When the run began working — not when it was armed, which costs it nothing. */
  startedAt: Date;
  now: Date;
  /** Tickets this run has run. One a usage limit interrupted is not among them. */
  ticketsRun: number;
  failuresInARow: number;
}

const MS_PER_MINUTE = 60_000;

/**
 * Which Safety stop the run has reached, said the way a person reads it over
 * breakfast, or nothing at all while it has reached none.
 */
export function safetyStopReached(stops: SafetyStops, soFar: RunSoFar): string | undefined {
  const { maxTickets, maxRuntimeMinutes, consecutiveFailures } = stops;

  if (maxTickets !== null && soFar.ticketsRun >= maxTickets) {
    return `this run was allowed ${counted(maxTickets, "ticket")}, and it has run them`;
  }

  if (
    maxRuntimeMinutes !== null &&
    soFar.now.getTime() >= endOf(soFar.startedAt, maxRuntimeMinutes)
  ) {
    return `this run was allowed ${howLong(maxRuntimeMinutes)}, and it is up`;
  }

  if (consecutiveFailures !== null && soFar.failuresInARow >= consecutiveFailures) {
    return (
      `${counted(consecutiveFailures, "ticket")} failed one after another, ` +
      `which is as many as this run was allowed`
    );
  }

  return undefined;
}

/**
 * The moment a run's own time is up, for whatever has to be awake by then — a
 * limit wait that would otherwise sleep clean through it. A run allowed all the
 * time in the world has no such moment.
 */
export function runsUntil(stops: SafetyStops, startedAt: Date): Date | undefined {
  const { maxRuntimeMinutes } = stops;
  return maxRuntimeMinutes === null ? undefined : new Date(endOf(startedAt, maxRuntimeMinutes));
}

function endOf(startedAt: Date, minutes: number): number {
  return startedAt.getTime() + minutes * MS_PER_MINUTE;
}

/** Whole hours read as hours; anything else stays in the minutes it was written in. */
function howLong(minutes: number): string {
  return minutes % 60 === 0 ? counted(minutes / 60, "hour") : counted(minutes, "minute");
}

function counted(howMany: number, thing: string): string {
  return `${howMany} ${thing}${howMany === 1 ? "" : "s"}`;
}
