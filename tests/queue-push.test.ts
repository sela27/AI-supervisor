import { afterEach, expect, test } from "vitest";

import { instanceWith } from "./helpers/config-file.js";
import { createTestProject, giveRemote, type TestProject } from "./helpers/project.js";
import {
  createGate,
  runBranch,
  startRun,
  startRunWith,
  stateOf,
  ticketOf,
  waitForQueue,
} from "./helpers/queue.js";
import { commitsWork, fakeRunner, stoppedByTheLimit } from "./helpers/runner.js";
import { startTestSupervisor, type TestSupervisor } from "./helpers/supervisor.js";
import { removeTempDirectories } from "./helpers/temp-dir.js";
import { createTicketDirectory, ticketFile } from "./helpers/ticket-files.js";

let supervisor: TestSupervisor | undefined;

afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  await removeTempDirectories();
});

async function twoTicketProject(): Promise<TestProject> {
  return createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
    "02-add-search.md": ticketFile({ title: "02 — Add search", blockedBy: "01" }),
  });
}

test("the run branch is published with the first Checkpoint, tracking the remote", async () => {
  const project = await twoTicketProject();
  const remote = await giveRemote(project);
  supervisor = await startTestSupervisor({ runner: fakeRunner(commitsWork(project)) });

  const branch = runBranch(await startRun(supervisor, project));
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(await remote.branches()).toEqual([branch]);
  expect(await remote.commitSubjects(branch)).toEqual([
    "Checkpoint: Add search",
    "Work for 02-add-search",
    "Checkpoint: Boot the app",
    "Work for 01-boot-the-app",
    "Initial commit",
  ]);
  expect(finished.pushFailure).toBeNull();
  // The branch knows where it was published, so picking it up by hand needs no
  // arguments — and the run's own later pushes have somewhere to go.
  expect(await project.git("rev-parse", "--abbrev-ref", "HEAD@{upstream}")).toBe(
    `origin/${branch}`,
  );
});

test("a Checkpoint is on the remote before the next ticket is attempted", async () => {
  const project = await twoTicketProject();
  const remote = await giveRemote(project);
  const gate = createGate();
  const work = commitsWork(project);
  supervisor = await startTestSupervisor({
    runner: fakeRunner(async (request) => {
      if (request.ticket.id === "02-add-search") await gate.opened;
      await work(request);
    }),
  });

  const branch = runBranch(await startRun(supervisor, project));
  await waitForQueue(supervisor, (queue) => stateOf(queue, "02-add-search") === "running");

  // The second ticket is still being attempted and the first is already readable
  // from anywhere — the remote is never more than one ticket behind the work.
  expect(await remote.commitSubjects(branch)).toContain("Checkpoint: Boot the app");

  gate.open();
  await waitForQueue(supervisor, (queue) => queue.state === "completed");
});

test("a failed Attempt's discarded work never reaches the remote", async () => {
  // Three tickets waiting on nothing, so the failure in the middle takes none of
  // the others with it and there is a Checkpoint after it to push.
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
    "02-add-search.md": ticketFile({ title: "02 — Add search" }),
    "03-write-docs.md": ticketFile({ title: "03 — Write docs" }),
  });
  const remote = await giveRemote(project);
  const work = commitsWork(project);
  supervisor = await startTestSupervisor({
    runner: fakeRunner(async (request) => {
      await work(request);
      if (request.ticket.id !== "02-add-search") return;
      return { status: "failed", reason: "the search box never appeared", output: "" };
    }),
  });

  const branch = runBranch(await startRun(supervisor, project));
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");
  expect(stateOf(finished, "02-add-search")).toBe("failed");

  const published = await remote.commitSubjects(branch);
  expect(published).toContain("Checkpoint: Boot the app");
  expect(published).toContain("Checkpoint: Write docs");
  // The failure's own record travels; the work that was thrown away does not.
  expect(published).toContain("Failed: Add search");
  expect(published).not.toContain("Work for 02-add-search");
});

test("a limit-interrupted Attempt's discarded work never reaches the remote either", async () => {
  const project = await twoTicketProject();
  const remote = await giveRemote(project);
  const work = commitsWork(project);
  const cutOff = stoppedByTheLimit(project, new Date("2026-07-30T06:30:00.000Z"));
  supervisor = await startTestSupervisor({
    runner: fakeRunner(async (request) =>
      request.ticket.id === "01-boot-the-app" ? work(request) : cutOff(request),
    ),
  });

  const branch = runBranch(await startRun(supervisor, project));
  const stopped = await waitForQueue(supervisor, (queue) => queue.state === "paused-on-limit");
  expect(stateOf(stopped, "02-add-search")).toBe("pending");

  // The remote stands at the last Checkpoint, exactly where the branch was thrown
  // back to — the quota running out publishes nothing.
  const published = await remote.commitSubjects(branch);
  expect(published[0]).toBe("Checkpoint: Boot the app");
  expect(published).not.toContain("Half of 02-add-search");
  expect(await project.head()).toBe(await project.head(`origin/${branch}`));
});

test("a run branch name already taken on the remote is not reused", async () => {
  const project = await twoTicketProject();
  const remote = await giveRemote(project);
  supervisor = await startTestSupervisor({ runner: fakeRunner(commitsWork(project)) });

  const first = runBranch(await startRun(supervisor, project));
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // What a redeployed container sees: the branch is out on the remote, and this
  // clone knows of it, but there is no local branch of that name to trip over.
  await project.git("checkout", "main");
  await project.git("branch", "-D", first);

  const later = await createTicketDirectory({
    "09-one-off.md": ticketFile({ title: "09 — One off" }),
  });
  const second = runBranch(await startRun(supervisor, project, { source: later }));
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // Reusing the name would have had the run build all night on a branch whose
  // very first push is refused as out of date.
  expect(second).not.toBe(first);
  expect(finished.pushFailure).toBeNull();
  expect(await project.head(`origin/${second}`)).toBe(finished.tickets[0]?.checkpoint);
});

test("a remote that will not take the push leaves the ticket succeeded and the run going", async () => {
  // A project with no remote at all: every push there is refused.
  const project = await twoTicketProject();
  supervisor = await startTestSupervisor({ runner: fakeRunner(commitsWork(project)) });

  await startRun(supervisor, project);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // Verification passed, so the ticket succeeded: where the commit ended up is the
  // remote's business, and the run is what reports it.
  expect(finished.tickets.map((ticket) => ticket.state)).toEqual(["succeeded", "succeeded"]);
  expect(ticketOf(finished, "01-boot-the-app")?.failure).toBeNull();
  expect(finished.error).toBeNull();
  expect(finished.pushFailure).toContain("origin");
  expect(await project.read("tickets/01-boot-the-app.md")).toContain("**Status:** done");
});

test("an instance minding a project with no remote can be told not to push", async () => {
  const project = await twoTicketProject();
  // A remote is there to be pushed to; the instance's settings are what keep the
  // run off it, so an empty remote afterwards means nothing was even attempted.
  const remote = await giveRemote(project);
  supervisor = await startTestSupervisor({
    runner: fakeRunner(commitsWork(project)),
    configDirectory: await instanceWith({
      source: { type: "local", directory: project.ticketsDirectory },
      project: { directory: project.directory, verify: ["exit 0"], pushCheckpoints: false },
    }),
  });

  await startRunWith(supervisor, {});
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(finished.tickets.map((ticket) => ticket.state)).toEqual(["succeeded", "succeeded"]);
  expect(await remote.branches()).toEqual([]);
  // Nothing was attempted, so nothing failed either.
  expect(finished.pushFailure).toBeNull();
});

test("a single run can be kept off the remote without changing the instance", async () => {
  const project = await twoTicketProject();
  const remote = await giveRemote(project);
  supervisor = await startTestSupervisor({ runner: fakeRunner(commitsWork(project)) });

  // Pushing falls back setting by setting like the rest of the project, so a run
  // that wants to stay local says so — and this instance would otherwise push,
  // exactly as it does in the first test above.
  await startRunWith(supervisor, {
    source: { type: "local", directory: project.ticketsDirectory },
    project: { directory: project.directory, verify: ["exit 0"], pushCheckpoints: false },
  });
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(finished.tickets.map((ticket) => ticket.state)).toEqual(["succeeded", "succeeded"]);
  expect(await remote.branches()).toEqual([]);
});
