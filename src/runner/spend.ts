/**
 * What a Run reported spending on its way to wherever it got to: the
 * subscription's money, the turns it took, and how long it took them.
 *
 * Every figure is the Run's own to report, and one it did not report is missing
 * rather than nought. The difference matters more than it looks: a nought reads
 * as a Run that was free, and no Run is free.
 */
export interface Spend {
  /** What the Run cost, as the Run itself priced it. */
  costUsd?: number;
  /** How many turns it took — the Run talking to itself, counted. */
  turns?: number;
  /** How long the Run took, wall clock. */
  durationMs?: number;
}

const FIGURES = ["costUsd", "turns", "durationMs"] as const satisfies readonly (keyof Spend)[];

/**
 * A Spend of whatever figures were actually reported, or nothing at all where
 * none of them were. Everything the Supervisor reads a figure out of comes from
 * somewhere it does not control — another process's result message, a column
 * some older build left null — so this is the one place that decides what counts
 * as a figure, and it is deliberately strict about it.
 */
export function spendOf(figures: Partial<Record<keyof Spend, unknown>>): Spend | undefined {
  const spend: Spend = {};

  for (const figure of FIGURES) {
    const reported = figures[figure];
    if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0) {
      spend[figure] = reported;
    }
  }

  return reportedAnything(spend) ? spend : undefined;
}

/**
 * How near a millionth a total is kept. Money is a float here, and two figures a
 * Run reported as 0.1 and 0.2 add up to 0.30000000000000004: a bill nobody can
 * read is worse than one rounded a millionth of a dollar short. A single Run's
 * own figure never goes through this — only what is made by adding.
 */
const CLOSE_ENOUGH = 1e6;

/**
 * What several Runs spent between them, figure by figure. A figure none of them
 * reported stays unreported: nothing added to nothing is still nothing, and a
 * Run's silence is not a nought to be added up with the rest.
 */
export function spentAltogether(spends: readonly (Spend | undefined)[]): Spend | undefined {
  const total: Spend = {};

  for (const figure of FIGURES) {
    const reported = spends
      .map((spend) => spend?.[figure])
      .filter((value): value is number => value !== undefined);
    if (reported.length > 0) {
      const added = reported.reduce((running, next) => running + next, 0);
      total[figure] = Math.round(added * CLOSE_ENOUGH) / CLOSE_ENOUGH;
    }
  }

  return reportedAnything(total) ? total : undefined;
}

/** Whether anything at all was reported. A Spend with no figures in it is not free. */
function reportedAnything(spend: Spend): boolean {
  return FIGURES.some((figure) => spend[figure] !== undefined);
}
