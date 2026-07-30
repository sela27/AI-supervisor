import { afterEach, expect, test } from "vitest";

import { instanceWith } from "./helpers/config-file.js";
import { createTestProject, type TestProject } from "./helpers/project.js";
import { readAttempts, startRun, stateOf, ticketOf, waitForQueue } from "./helpers/queue.js";
import {
  BROKEN_OUTPUT,
  commitsWork,
  fakeRunner,
  leavesBrokenWork,
  stoppedByTheLimit,
  succeedsOnly,
  type FakeRunnerBehaviour,
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

/**
 * A Run that gets the ticket wrong its first `failures` times and does it properly
 * after that — a second chance being taken, as far as the Supervisor can see.
 */
function failsThenWorks(project: TestProject, failures: number): FakeRunnerBehaviour {
  const breaks = leavesBrokenWork(project);
  const works = commitsWork(project);
  const spent = new Map<string, number>();

  return (request) => {
    const soFar = (spent.get(request.ticket.id) ?? 0) + 1;
    spent.set(request.ticket.id, soFar);
    return soFar <= failures ? breaks(request) : works(request);
  };
}

test("a failed attempt is given another go, and a ticket that works this time succeeds", async () => {
  const project = await oneTicketProject();
  const runner = fakeRunner(failsThenWorks(project, 1));
  supervisor = await startTestSupervisor({ runner });

  await startRun(supervisor, project);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(runner.order).toEqual(["01-boot-the-app", "01-boot-the-app"]);
  // A ticket that came good on its second Attempt is a ticket that succeeded:
  // nothing about the first one is held against it afterwards.
  const ticket = ticketOf(finished, "01-boot-the-app");
  expect(ticket?.state).toBe("succeeded");
  expect(ticket?.failure).toBeNull();
  expect(await project.head()).toBe(ticket?.checkpoint);
  expect(await project.commitSubjects()).toContain("Checkpoint: Boot the app");
  expect(await project.commitSubjects()).not.toContain("Broken work for 01-boot-the-app");
  expect(await project.read("tickets/01-boot-the-app.md")).toContain("**Status:** done");
});

test("the second attempt is told why the first one was refused", async () => {
  const project = await oneTicketProject();
  const runner = fakeRunner(failsThenWorks(project, 1));
  supervisor = await startTestSupervisor({ runner });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // The Runs share no context, so the failure the Supervisor hands over is all the
  // second one can know of the first.
  expect(runner.requests[0]?.previousFailure).toBeUndefined();
  expect(runner.requests[1]?.previousFailure).toContain("the tests never passed");
});

test("a retry is told what refused the attempt, down to what the check printed", async () => {
  const project = await oneTicketProject();
  const runner = fakeRunner(commitsWork(project));
  supervisor = await startTestSupervisor({ runner });

  // The Run does the work and commits it; the project's own command is what
  // refuses it, and its output is the only thing that says why.
  await startRun(supervisor, project, { verify: ["echo tests-are-red&& exit 7"] });
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(runner.requests[1]?.previousFailure).toContain("exited 7");
  expect(runner.requests[1]?.previousFailure).toContain("tests-are-red");
});

test("the second attempt starts from a tree the first one's mess was thrown out of", async () => {
  const project = await oneTicketProject();
  const base = await project.head();
  const work = failsThenWorks(project, 1);
  const startedOn: { head: string; dirty: string }[] = [];
  supervisor = await startTestSupervisor({
    runner: fakeRunner(async (request) => {
      startedOn.push({
        head: await project.head(),
        dirty: await project.git("status", "--porcelain"),
      });
      return work(request);
    }),
  });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // A fresh context is no use on top of the last Attempt's half-work: both Runs
  // began exactly where the run did, with nothing of the refused one in sight.
  expect(startedOn).toEqual([
    { head: base, dirty: "" },
    { head: base, dirty: "" },
  ]);
});

test("a ticket that fails every attempt it is given fails finally", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
    "02-add-search.md": ticketFile({ title: "02 — Add search", blockedBy: "01" }),
    "03-write-docs.md": ticketFile({ title: "03 — Write docs" }),
  });
  // 01 is doomed and 02 waits on it; 03 is the one that gets anywhere.
  const runner = fakeRunner(succeedsOnly(project, "03-write-docs"));
  supervisor = await startTestSupervisor({ runner });

  await startRun(supervisor, project);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // Two goes at the doomed ticket, and none at all at the one waiting on it.
  expect(runner.order).toEqual(["01-boot-the-app", "01-boot-the-app", "03-write-docs"]);
  expect(finished.tickets.map((ticket) => [ticket.id, ticket.state])).toEqual([
    ["01-boot-the-app", "failed"],
    ["02-add-search", "skipped"],
    ["03-write-docs", "succeeded"],
  ]);

  // A final failure is exactly the failure it always was: written back, recorded
  // on the branch, and nothing of either Attempt left behind.
  const written = await project.read("tickets/01-boot-the-app.md");
  expect(written).toContain("**Status:** failed");
  expect(written).toContain("the tests never passed");
  expect(await project.commitSubjects()).toContain("Failed: Boot the app");
  expect(await project.commitSubjects()).not.toContain("Broken work for 01-boot-the-app");
  expect(await project.git("status", "--porcelain")).toBe("");
});

test("an instance can buy a ticket more attempts than the two it gets by default", async () => {
  const project = await oneTicketProject();
  const runner = fakeRunner(failsThenWorks(project, 2));
  supervisor = await startTestSupervisor({
    runner,
    configDirectory: await instanceWith({ attemptBudget: 3 }),
  });

  await startRun(supervisor, project);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(runner.order).toHaveLength(3);
  expect(stateOf(finished, "01-boot-the-app")).toBe("succeeded");
});

test("a budget of one attempt is a Supervisor that never retries", async () => {
  const project = await oneTicketProject();
  // The very Runner that comes good on its second go under the default budget.
  const runner = fakeRunner(failsThenWorks(project, 1));
  supervisor = await startTestSupervisor({
    runner,
    configDirectory: await instanceWith({ attemptBudget: 1 }),
  });

  await startRun(supervisor, project);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(runner.order).toEqual(["01-boot-the-app"]);
  expect(stateOf(finished, "01-boot-the-app")).toBe("failed");
  expect(await project.read("tickets/01-boot-the-app.md")).toContain("**Status:** failed");
});

test("every attempt is recorded on its own, oldest first, log and all", async () => {
  const project = await oneTicketProject();
  supervisor = await startTestSupervisor({ runner: fakeRunner(failsThenWorks(project, 1)) });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // A ticket's history is every Attempt it took, not just the one that settled it.
  const attempts = await readAttempts(supervisor, "01-boot-the-app");
  expect(attempts.map((attempt) => attempt.outcome)).toEqual(["failed", "succeeded"]);
  expect(attempts[0]?.failure).toContain("the tests never passed");
  expect(attempts[0]?.output).toBe(BROKEN_OUTPUT);
  expect(attempts[1]?.failure).toBeNull();
});

test("a usage limit during a retry is not the ticket's last chance spent", async () => {
  const project = await oneTicketProject();
  const breaks = leavesBrokenWork(project);
  const cutOff = stoppedByTheLimit(project, null);
  let attempts = 0;
  supervisor = await startTestSupervisor({
    runner: fakeRunner((request) => {
      attempts += 1;
      return attempts === 1 ? breaks(request) : cutOff(request);
    }),
  });

  await startRun(supervisor, project);
  const stopped = await waitForQueue(supervisor, (queue) => queue.state === "paused-on-limit");

  // The budget had a go left when the quota ran out, and the quota running out is
  // not a go: the ticket goes back on the Frontier with nothing held against it.
  expect(stateOf(stopped, "01-boot-the-app")).toBe("pending");
  expect(ticketOf(stopped, "01-boot-the-app")?.failure).toBeNull();
  expect(await project.read("tickets/01-boot-the-app.md")).toContain("**Status:** ready-for-agent");
});
