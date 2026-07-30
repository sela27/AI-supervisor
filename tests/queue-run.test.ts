import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { createTestProject } from "./helpers/project.js";
import {
  createGate,
  readQueue,
  requestStart,
  startRun,
  stateOf,
  ticketOf,
  waitForQueue,
} from "./helpers/queue.js";
import { commitsWork, fakeRunner } from "./helpers/runner.js";
import { startTestSupervisor, type TestSupervisor } from "./helpers/supervisor.js";
import { removeTempDirectories } from "./helpers/temp-dir.js";
import { createTicketDirectory, ticketFile } from "./helpers/ticket-files.js";

let supervisor: TestSupervisor | undefined;

afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  await removeTempDirectories();
});

function twoTicketChain(): Record<string, string> {
  return {
    "01-boot-the-app.md": ticketFile({
      title: "01 — Boot the app",
      criteria: ["It boots", "It answers"],
    }),
    "02-add-search.md": ticketFile({ title: "02 — Add search", blockedBy: "01" }),
  };
}

test("starting a run executes the whole queue and ends with every ticket succeeded", async () => {
  const project = await createTestProject(twoTicketChain());
  const runner = fakeRunner(commitsWork(project));
  supervisor = await startTestSupervisor({ runner });

  const started = await startRun(supervisor, project);
  expect(started.state).toBe("running");

  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(finished.tickets.map((ticket) => [ticket.id, ticket.state])).toEqual([
    ["01-boot-the-app", "succeeded"],
    ["02-add-search", "succeeded"],
  ]);
  // The Runner is handed the whole ticket, acceptance criteria included, since a
  // real Run has nothing else to work from.
  expect(runner.requests[0]?.ticket.acceptanceCriteria).toEqual([
    { text: "It boots", done: false },
    { text: "It answers", done: false },
  ]);
  expect(runner.requests[0]?.projectDirectory).toBe(project.directory);
});

test("the run happens on its own branch, leaving the branch it started from untouched", async () => {
  const project = await createTestProject(twoTicketChain());
  const base = await project.head("main");
  supervisor = await startTestSupervisor({ runner: fakeRunner(commitsWork(project)) });

  const started = await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(started.branch).toMatch(/^supervisor\//);
  expect(await project.currentBranch()).toBe(started.branch);
  expect(await project.head("main")).toBe(base);
});

test("each succeeded ticket ends in a Checkpoint commit and a done write-back", async () => {
  const project = await createTestProject(twoTicketChain());
  supervisor = await startTestSupervisor({ runner: fakeRunner(commitsWork(project)) });

  await startRun(supervisor, project);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // Every Checkpoint is a real commit on the run branch, and the last one is where
  // the branch now stands.
  const commits = await project.commitSubjects();
  for (const ticket of finished.tickets) {
    expect(ticket.checkpoint).toMatch(/^[0-9a-f]{40}$/);
    expect(await project.head(ticket.checkpoint ?? "")).toBe(ticket.checkpoint);
  }
  expect(finished.tickets.at(-1)?.checkpoint).toBe(await project.head());
  expect(commits).toContain("Checkpoint: Boot the app");
  expect(commits).toContain("Checkpoint: Add search");

  expect(await project.read("tickets/01-boot-the-app.md")).toContain("**Status:** done");
  expect(await project.read("tickets/02-add-search.md")).toContain("**Status:** done");
});

test("tickets run strictly one at a time, in dependency order", async () => {
  const project = await createTestProject({
    ...twoTicketChain(),
    "03-write-docs.md": ticketFile({ title: "03 — Write docs" }),
  });
  const gate = createGate();
  const work = commitsWork(project);
  const runner = fakeRunner(async (request) => {
    if (request.ticket.id === "01-boot-the-app") await gate.opened;
    await work(request);
  });
  supervisor = await startTestSupervisor({ runner });

  await startRun(supervisor, project);
  const midRun = await waitForQueue(
    supervisor,
    (queue) => stateOf(queue, "01-boot-the-app") === "running",
  );

  // While the first ticket holds the Runner, nothing else has been started.
  expect(stateOf(midRun, "02-add-search")).toBe("pending");
  expect(stateOf(midRun, "03-write-docs")).toBe("pending");

  gate.open();
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(runner.overlapped).toBe(false);
  expect(runner.order).toEqual(["01-boot-the-app", "02-add-search", "03-write-docs"]);
});

test("an attempt whose verification command fails does not succeed", async () => {
  const project = await createTestProject(twoTicketChain());
  supervisor = await startTestSupervisor({ runner: fakeRunner(commitsWork(project)) });

  await startRun(supervisor, project, { verify: ["exit 0", "exit 3"] });
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  const ticket = ticketOf(finished, "01-boot-the-app");
  expect(ticket?.state).toBe("failed");
  expect(ticket?.checkpoint).toBeNull();
  expect(ticket?.failure).toContain("exit 3");
  // `done` is never written back for a ticket the Supervisor could not verify.
  expect(await project.read("tickets/01-boot-the-app.md")).toContain("**Status:** failed");
});

test("an attempt that produced no commit does not succeed", async () => {
  const project = await createTestProject(twoTicketChain());
  // A Runner that reports success but leaves the repository exactly as it found it.
  supervisor = await startTestSupervisor({ runner: fakeRunner() });

  await startRun(supervisor, project);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  const ticket = ticketOf(finished, "01-boot-the-app");
  expect(ticket?.state).toBe("failed");
  expect(ticket?.failure).toContain("commit");
});

test("a ticket the source already reports done is never run", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app", status: "done" }),
    "02-add-search.md": ticketFile({ title: "02 — Add search", blockedBy: "01" }),
  });
  const runner = fakeRunner(commitsWork(project));
  supervisor = await startTestSupervisor({ runner });

  await startRun(supervisor, project);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(runner.order).toEqual(["02-add-search"]);
  expect(stateOf(finished, "01-boot-the-app")).toBe("done");
  expect(stateOf(finished, "02-add-search")).toBe("succeeded");
});

test("ticket files kept outside the project still get their done write-back", async () => {
  const project = await createTestProject({});
  const tickets = await createTicketDirectory({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
  });
  supervisor = await startTestSupervisor({ runner: fakeRunner(commitsWork(project)) });

  await startRun(supervisor, project, { source: tickets });
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(stateOf(finished, "01-boot-the-app")).toBe("succeeded");
  expect(await readFile(join(tickets, "01-boot-the-app.md"), "utf8")).toContain(
    "**Status:** done",
  );
  // Nothing outside the repository can be committed, so the Run's own last commit
  // is what ends the ticket.
  expect(finished.tickets[0]?.checkpoint).toBe(await project.head());
  expect((await project.commitSubjects())[0]).toBe("Work for 01-boot-the-app");
});

test("a project with uncommitted changes is refused rather than swept into a Checkpoint", async () => {
  const project = await createTestProject(twoTicketChain());
  await writeFile(join(project.directory, "half-done.txt"), "work in progress", "utf8");
  supervisor = await startTestSupervisor({ runner: fakeRunner(commitsWork(project)) });

  const response = await requestStart(supervisor, project);

  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: string }).error).toContain("uncommitted changes");
  expect((await readQueue(supervisor)).state).toBe("idle");
});

test("the queue is idle until a run is started, and refuses a second run while one is in flight", async () => {
  const project = await createTestProject(twoTicketChain());
  const gate = createGate();
  const work = commitsWork(project);
  supervisor = await startTestSupervisor({
    runner: fakeRunner(async (request) => {
      await gate.opened;
      await work(request);
    }),
  });

  const idle = await readQueue(supervisor);
  expect(idle.state).toBe("idle");
  expect(idle.tickets).toEqual([]);

  await startRun(supervisor, project);
  const second = await requestStart(supervisor, project);
  expect(second.status).toBe(409);

  gate.open();
  await waitForQueue(supervisor, (queue) => queue.state === "completed");
});

