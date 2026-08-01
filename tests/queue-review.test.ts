import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { reviewingInstance } from "./helpers/config-file.js";
import { createTestProject, type TestProject } from "./helpers/project.js";
import { readAttempts, startRun, stateOf, ticketOf, waitForQueue } from "./helpers/queue.js";
import {
  approves,
  commitsWork,
  fakeRunner,
  leavesBrokenWork,
  refuses,
  type FakeReviewBehaviour,
} from "./helpers/runner.js";
import { startTestSupervisor, type TestSupervisor } from "./helpers/supervisor.js";
import { removeTempDirectories } from "./helpers/temp-dir.js";
import { ticketFile } from "./helpers/ticket-files.js";

let supervisor: TestSupervisor | undefined;

afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  await removeTempDirectories();
});

async function oneTicketProject(): Promise<TestProject> {
  return createTestProject({ "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }) });
}

/** A reviewer that turns the work down once and is satisfied with the next go. */
function refusesOnce(reasoning: string): FakeReviewBehaviour {
  const turnedDown = refuses(reasoning);
  const satisfied = approves();
  let seen = 0;

  return (request) => {
    seen += 1;
    return seen === 1 ? turnedDown(request) : satisfied(request);
  };
}

const NO_TESTS = "the acceptance criteria are met but nothing about it is tested";

test("an instance told nothing about reviews puts nothing in front of a reviewer", async () => {
  const project = await oneTicketProject();
  // A reviewer that would refuse everything, so a ticket that succeeds anyway is
  // one that was never shown to it.
  const runner = fakeRunner(commitsWork(project), refuses(NO_TESTS));
  supervisor = await startTestSupervisor({ runner });

  await startRun(supervisor, project);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(runner.reviews).toEqual([]);
  expect(stateOf(finished, "01-boot-the-app")).toBe("succeeded");
});

test("an approved attempt succeeds like any other, checkpoint and write-back and all", async () => {
  const project = await oneTicketProject();
  const runner = fakeRunner(commitsWork(project), approves());
  supervisor = await startTestSupervisor({ runner, configDirectory: await reviewingInstance() });

  await startRun(supervisor, project);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(runner.reviews).toHaveLength(1);
  const ticket = ticketOf(finished, "01-boot-the-app");
  expect(ticket?.state).toBe("succeeded");
  expect(ticket?.failure).toBeNull();
  expect(await project.head("HEAD~1")).toBe(ticket?.checkpoint);
  expect(await project.commitSubjects()).toContain("Checkpoint: Boot the app");
  expect(await project.read("tickets/01-boot-the-app.md")).toContain("**Status:** done");
});

test("nothing is put in front of a reviewer until the project's own checks have passed", async () => {
  const project = await oneTicketProject();
  const runner = fakeRunner(commitsWork(project), approves());
  supervisor = await startTestSupervisor({
    runner,
    configDirectory: await reviewingInstance({ attemptBudget: 1 }),
  });

  await startRun(supervisor, project, { verify: ["exit 7"] });
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // The checks refused it, so there was nothing worth a reviewer's quota: work
  // that does not build is not work a review has anything to say about.
  expect(runner.reviews).toEqual([]);
  expect(stateOf(finished, "01-boot-the-app")).toBe("failed");
});

test("an attempt that never ran is never reviewed either", async () => {
  const project = await oneTicketProject();
  // The Run itself reported failure, so Verification refused it before its own
  // commands were ever reached.
  const runner = fakeRunner(leavesBrokenWork(project), approves());
  supervisor = await startTestSupervisor({
    runner,
    configDirectory: await reviewingInstance({ attemptBudget: 1 }),
  });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(runner.reviews).toEqual([]);
});

test("the reviewer is shown the ticket and the work the attempt left behind", async () => {
  const project = await oneTicketProject();
  const runner = fakeRunner(commitsWork(project), approves());
  supervisor = await startTestSupervisor({ runner, configDirectory: await reviewingInstance() });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  const review = runner.reviews[0];
  expect(review?.ticket.id).toBe("01-boot-the-app");
  expect(review?.projectDirectory).toBe(project.directory);
  // The whole of what the Attempt did, against where it started — the file the
  // Run wrote, and nothing of the run's own doing before it.
  expect(review?.diff).toContain("01-boot-the-app.txt");
  expect(review?.diff).toContain("Boot the app");
});

test("the reviewer is shown files the attempt created and never added, too", async () => {
  const project = await oneTicketProject();
  const work = commitsWork(project);
  const runner = fakeRunner(async (request) => {
    await work(request);
    // Left lying about rather than committed — which is not the same as left out
    // of the ticket: the Checkpoint sweeps it in as the Run's own work.
    await writeFile(join(project.directory, "notes-nobody-added.txt"), "swept in", "utf8");
  }, approves());
  supervisor = await startTestSupervisor({ runner, configDirectory: await reviewingInstance() });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // Approving a Checkpoint holding a file the reviewer never saw is the one thing
  // a review must not be able to do.
  expect(runner.reviews[0]?.diff).toContain("notes-nobody-added.txt");
  expect(runner.reviews[0]?.diff).toContain("swept in");
});

test("a reviewer that turns the work down without saying why still says so plainly", async () => {
  const project = await oneTicketProject();
  supervisor = await startTestSupervisor({
    runner: fakeRunner(commitsWork(project), refuses("   ")),
    configDirectory: await reviewingInstance({ attemptBudget: 1 }),
  });

  await startRun(supervisor, project);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // A reason that trails off into nothing is what the morning would otherwise
  // read on the ticket, and what the next Attempt would be handed.
  const failure = ticketOf(finished, "01-boot-the-app")?.failure ?? "";
  expect(failure).toBe("the review refused the attempt without saying why");
});

test("a rejected attempt is refused, and the next one is told what the review said", async () => {
  const project = await oneTicketProject();
  const runner = fakeRunner(commitsWork(project), refusesOnce(NO_TESTS));
  supervisor = await startTestSupervisor({ runner, configDirectory: await reviewingInstance() });

  await startRun(supervisor, project);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // Two Attempts: the reviewer turned the first down, and the reason it gave is
  // the whole of what the second one has to go on.
  expect(runner.order).toEqual(["01-boot-the-app", "01-boot-the-app"]);
  expect(runner.requests[0]?.previousFailure).toBeUndefined();
  expect(runner.requests[1]?.previousFailure).toContain(NO_TESTS);
  expect(stateOf(finished, "01-boot-the-app")).toBe("succeeded");
});

test("the work a review refused is thrown back like any other refused attempt", async () => {
  const project = await oneTicketProject();
  const startedOn: string[] = [];
  const work = commitsWork(project);
  supervisor = await startTestSupervisor({
    runner: fakeRunner(async (request) => {
      startedOn.push(await project.head());
      return work(request);
    }, refusesOnce(NO_TESTS)),
    configDirectory: await reviewingInstance(),
  });

  const base = await project.head();
  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // The refused Attempt's commit is gone by the time the second one starts: a
  // review turning work down is the same refusal a failing test is.
  expect(startedOn).toEqual([base, base]);
  // Both Attempts committed under the same subject, and only one of those commits
  // is on the branch: the one the review let stand.
  const subjects = await project.commitSubjects();
  expect(subjects.filter((subject) => subject === "Work for 01-boot-the-app")).toHaveLength(1);
});

test("a ticket every review refuses fails, with the reviewer's own words written back", async () => {
  const project = await oneTicketProject();
  supervisor = await startTestSupervisor({
    runner: fakeRunner(commitsWork(project), refuses(NO_TESTS)),
    configDirectory: await reviewingInstance(),
  });

  await startRun(supervisor, project);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(ticketOf(finished, "01-boot-the-app")?.failure).toContain(NO_TESTS);
  const written = await project.read("tickets/01-boot-the-app.md");
  expect(written).toContain("**Status:** failed");
  expect(written).toContain(NO_TESTS);
});

test("the verdict and the reasoning are kept with the attempt they judged", async () => {
  const project = await oneTicketProject();
  supervisor = await startTestSupervisor({
    runner: fakeRunner(commitsWork(project), refusesOnce(NO_TESTS)),
    configDirectory: await reviewingInstance(),
  });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  const attempts = await readAttempts(supervisor, "01-boot-the-app");
  expect(attempts.map((attempt) => attempt.outcome)).toEqual(["failed", "succeeded"]);
  expect(attempts[0]?.review).toEqual({ verdict: "rejected", reasoning: NO_TESTS });
  // An approval is worth keeping too: it is the whole of the evidence that
  // anybody looked at the work the morning is about to trust.
  expect(attempts[1]?.review).toEqual({
    verdict: "approved",
    reasoning: "It does what the ticket asked.",
  });
});

test("an attempt no reviewer saw carries no verdict at all", async () => {
  const project = await oneTicketProject();
  supervisor = await startTestSupervisor({ runner: fakeRunner(commitsWork(project)) });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  const attempts = await readAttempts(supervisor, "01-boot-the-app");
  expect(attempts[0]?.review).toBeNull();
});

test("a usage limit during the review is not the ticket's chance spent", async () => {
  const project = await oneTicketProject();
  supervisor = await startTestSupervisor({
    runner: fakeRunner(commitsWork(project), () => ({
      status: "limit-hit",
      resetAt: null,
      output: "Reading the diff, then the quota ran out.",
    })),
    configDirectory: await reviewingInstance(),
  });

  await startRun(supervisor, project);
  const stopped = await waitForQueue(supervisor, (queue) => queue.state === "paused-on-limit");

  // The Attempt was never judged, so nothing was learned about the ticket: its
  // work goes back like any limit-interrupted Attempt's, and the ticket is left
  // exactly as it was found.
  expect(stateOf(stopped, "01-boot-the-app")).toBe("pending");
  expect(ticketOf(stopped, "01-boot-the-app")?.failure).toBeNull();
  expect(await project.commitSubjects()).not.toContain("Work for 01-boot-the-app");
  expect(await project.read("tickets/01-boot-the-app.md")).toContain("**Status:** ready-for-agent");

  const attempts = await readAttempts(supervisor, "01-boot-the-app");
  expect(attempts.map((attempt) => attempt.outcome)).toEqual(["limit-hit"]);
});
