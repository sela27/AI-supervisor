import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  ReviewOutcome,
  ReviewRequest,
  RunOutcome,
  RunRequest,
  Runner,
} from "../../src/runner/runner.js";
import type { TestProject } from "./project.js";

/** The Runner seam, scripted by the test and recording what it was asked to do. */
export interface FakeRunner extends Runner {
  /** Ticket ids in the order the Supervisor asked for them. */
  order: string[];
  requests: RunRequest[];
  /**
   * What was put in front of a reviewer, in order. Empty for an instance that
   * never asked for reviews, which is every instance that was told nothing.
   */
  reviews: ReviewRequest[];
  /** True if an Attempt ever started while another was still in flight. */
  overlapped: boolean;
}

export type FakeRunnerBehaviour = (
  request: RunRequest,
) => Promise<RunOutcome | void> | RunOutcome | void;

export type FakeReviewBehaviour = (
  request: ReviewRequest,
) => Promise<ReviewOutcome | void> | ReviewOutcome | void;

/** Behaviour that returns nothing counts as a successful Attempt with no output. */
export function fakeRunner(
  behaviour: FakeRunnerBehaviour = () => {},
  reviewing: FakeReviewBehaviour = () => {},
): FakeRunner {
  let inFlight = 0;

  const runner: FakeRunner = {
    order: [],
    requests: [],
    reviews: [],
    overlapped: false,
    run: async (request) => {
      if (inFlight > 0) runner.overlapped = true;
      inFlight += 1;
      runner.order.push(request.ticket.id);
      runner.requests.push(request);
      try {
        return (await behaviour(request)) ?? { status: "succeeded", output: "" };
      } finally {
        inFlight -= 1;
      }
    },
    review: async (request) => {
      runner.reviews.push(request);
      return (
        (await reviewing(request)) ?? {
          status: "reviewed",
          verdict: "approved",
          reasoning: "It meets the ticket.",
          criteriaMet: [],
          output: "",
        }
      );
    },
  };

  return runner;
}

/**
 * A reviewer that lets the work stand, having judged the criteria it names met.
 * Naming none is what a review with nothing to say about the criteria answers.
 */
export function approves(
  reasoning = "It does what the ticket asked.",
  criteriaMet: string[] = [],
): FakeReviewBehaviour {
  return () => ({ status: "reviewed", verdict: "approved", reasoning, criteriaMet, output: "" });
}

/** A reviewer that turns the work down, for the reason it gives. */
export function refuses(reasoning: string, criteriaMet: string[] = []): FakeReviewBehaviour {
  return () => ({ status: "reviewed", verdict: "rejected", reasoning, criteriaMet, output: "" });
}

/** A Runner that does the ticket's work and commits it, as a real Run would. */
export function commitsWork(project: TestProject): FakeRunnerBehaviour {
  return async (request) => {
    const file = join(project.directory, `${request.ticket.id}.txt`);
    await writeFile(file, request.ticket.title, "utf8");
    await project.git("add", "-A");
    await project.git("commit", "-m", `Work for ${request.ticket.id}`);
  };
}

/** What a Run prints on its way to being refused by the project's own tests. */
export const BROKEN_OUTPUT = ["> npm test", "1 failing:", "  expected 2 to be 3"].join("\n");

/**
 * The residue a Run leaves when it gets part-way and then stops for any reason: a
 * commit of its own, plus files left lying about. Exactly what a Checkpoint reset
 * exists to throw away, whatever it was that stopped the Run.
 */
async function leaveHalfDoneWork(
  project: TestProject,
  ticketId: string,
  subject: string,
): Promise<void> {
  await writeFile(join(project.directory, `${ticketId}-half.txt`), "half-written", "utf8");
  await project.git("add", "-A");
  await project.git("commit", "-m", subject);
  await writeFile(join(project.directory, `${ticketId}-scratch.txt`), "left behind", "utf8");
}

/** A Run that half-did the ticket and then reported failure. */
export function leavesBrokenWork(project: TestProject): FakeRunnerBehaviour {
  return async (request) => {
    await leaveHalfDoneWork(project, request.ticket.id, `Broken work for ${request.ticket.id}`);
    return { status: "failed", reason: "the tests never passed", output: BROKEN_OUTPUT };
  };
}

/** Works the ticket the id names; leaves broken work on every other one. */
export function succeedsOnly(project: TestProject, succeeding: string): FakeRunnerBehaviour {
  const works = commitsWork(project);
  const breaks = leavesBrokenWork(project);
  return (request) => (request.ticket.id === succeeding ? works(request) : breaks(request));
}

/**
 * A Run cut off by the subscription's usage limit half-way through: it had
 * committed something and left more lying about when the quota refused it.
 */
export function stoppedByTheLimit(
  project: TestProject,
  resetAt: Date | null,
): FakeRunnerBehaviour {
  return async (request) => {
    await leaveHalfDoneWork(project, request.ticket.id, `Half of ${request.ticket.id}`);
    return { status: "limit-hit", resetAt, output: "Working on it, then the quota ran out." };
  };
}

/**
 * A subscription with no quota left for the first few Runs and quota again after
 * that — what a Supervisor that waits a limit out is meant to sit through.
 */
export function limitedFor(
  project: TestProject,
  refusals: number,
  resetAt: Date | null,
): FakeRunnerBehaviour {
  const refused = stoppedByTheLimit(project, resetAt);
  const works = commitsWork(project);
  let spent = 0;

  return (request) => {
    spent += 1;
    return spent <= refusals ? refused(request) : works(request);
  };
}
