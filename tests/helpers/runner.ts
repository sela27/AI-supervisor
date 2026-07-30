import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RunOutcome, RunRequest, Runner } from "../../src/runner/runner.js";
import type { TestProject } from "./project.js";

/** The Runner seam, scripted by the test and recording what it was asked to do. */
export interface FakeRunner extends Runner {
  /** Ticket ids in the order the Supervisor asked for them. */
  order: string[];
  requests: RunRequest[];
  /** True if an Attempt ever started while another was still in flight. */
  overlapped: boolean;
}

export type FakeRunnerBehaviour = (
  request: RunRequest,
) => Promise<RunOutcome | void> | RunOutcome | void;

/** Behaviour that returns nothing counts as a successful Attempt. */
export function fakeRunner(behaviour: FakeRunnerBehaviour = () => {}): FakeRunner {
  let inFlight = 0;

  const runner: FakeRunner = {
    order: [],
    requests: [],
    overlapped: false,
    run: async (request) => {
      if (inFlight > 0) runner.overlapped = true;
      inFlight += 1;
      runner.order.push(request.ticket.id);
      runner.requests.push(request);
      try {
        return (await behaviour(request)) ?? { status: "succeeded" };
      } finally {
        inFlight -= 1;
      }
    },
  };

  return runner;
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
