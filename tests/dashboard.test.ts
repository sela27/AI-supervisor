import { afterEach, expect, test } from "vitest";

import { openEventStream, type EventStream } from "./helpers/events.js";
import { createTestProject } from "./helpers/project.js";
import {
  createGate,
  readAttempts,
  startRun,
  stateOf,
  ticketOf,
  waitForQueue,
  type LiveOutputBody,
  type QueueBody,
} from "./helpers/queue.js";
import { commitsWork, fakeRunner, leavesBrokenWork } from "./helpers/runner.js";
import { startTestSupervisor, type TestSupervisor } from "./helpers/supervisor.js";
import { removeTempDirectories } from "./helpers/temp-dir.js";
import { ticketFile } from "./helpers/ticket-files.js";

let supervisor: TestSupervisor | undefined;
let watching: EventStream | undefined;

afterEach(async () => {
  await watching?.close();
  watching = undefined;
  await supervisor?.stop();
  supervisor = undefined;
  await removeTempDirectories();
});

async function readPage(running: TestSupervisor, path = "/"): Promise<string> {
  const response = await running.request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  return response.text();
}

test("the dashboard is served by the Supervisor itself, at the port the API is on", async () => {
  supervisor = await startTestSupervisor();

  const page = await readPage(supervisor);

  expect(page).toContain("<!doctype html>");
  expect(page).toContain("AI Supervisor");
});

test("the page brings everything it needs, so a phone on the network needs nothing else", async () => {
  supervisor = await startTestSupervisor();

  const page = await readPage(supervisor);

  // A dashboard opened from a phone at 3am is on whatever network the Supervisor
  // is on, which may be no network at all: nothing may be fetched from elsewhere.
  expect(page).not.toMatch(/(?:src|href)="https?:/);
  // And it is laid out for the screen it is being read on.
  expect(page).toContain(`name="viewport"`);
  expect(page).toContain("@media");
});

test("the page carries the controls, so the run is driven from where it is watched", async () => {
  supervisor = await startTestSupervisor();

  const page = await readPage(supervisor);

  // Every control the API answers has something on the page to press, and the
  // queue is edited before it starts from the same page it is watched from.
  for (const control of ["pause", "resume", "stop", "start", "look"]) {
    expect(page).toContain(`id="${control}"`);
  }
  expect(page).toContain(`id="source"`);
  expect(page).toContain(`id="edited-queue"`);
  // Retry and Skip belong to a ticket, so they are built per ticket rather than
  // sitting in the markup; what is in the markup is what builds them.
  expect(page).toContain("/api/queue/tickets/");
  expect(page).toContain("Run it again");
  expect(page).toContain("Take it out");
});

test("a watcher who joins an idle Supervisor is told the queue is idle at once", async () => {
  supervisor = await startTestSupervisor();

  watching = await openEventStream(supervisor);
  const queue = await watching.waitFor<QueueBody>("queue", () => true);
  const output = await watching.waitFor<LiveOutputBody>("output", () => true);

  // A page that loads before anything has ever run still knows where it stands.
  expect(queue.state).toBe("idle");
  expect(queue.tickets).toEqual([]);
  expect(output).toEqual({ ticketId: null, output: "" });
});

test("every state the queue passes through reaches a watcher who never asks again", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
  });
  const gate = createGate();
  const work = commitsWork(project);
  supervisor = await startTestSupervisor({
    runner: fakeRunner(async (request) => {
      await gate.opened;
      await work(request);
    }),
  });

  // Opened before the run exists, and never asked anything afterwards: everything
  // below arrived because the Supervisor pushed it.
  watching = await openEventStream(supervisor);
  await startRun(supervisor, project);

  const running = await watching.waitFor<QueueBody>(
    "queue",
    (queue) => stateOf(queue, "01-boot-the-app") === "running",
  );
  expect(running.state).toBe("running");
  expect(running.branch).toMatch(/^supervisor\//);

  gate.open();
  const finished = await watching.waitFor<QueueBody>("queue", (queue) => queue.state === "completed");
  expect(stateOf(finished, "01-boot-the-app")).toBe("succeeded");
  expect(finished.tickets[0]?.checkpoint).toMatch(/^[0-9a-f]{40}$/);
});

test("the attempt in flight streams its output to the watcher as it is printed", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
  });
  const gate = createGate();
  const work = commitsWork(project);
  supervisor = await startTestSupervisor({
    runner: fakeRunner(async (request) => {
      request.onOutput?.("Reading the ticket.");
      request.onOutput?.("· Edit: src/main.ts");
      await gate.opened;
      await work(request);
    }),
  });

  watching = await openEventStream(supervisor);
  await startRun(supervisor, project);

  // The Run is still held at the gate, so this is the log as it stands mid-Attempt.
  const printed = await watching.waitFor<LiveOutputBody>("output", (event) => event.output !== "");
  expect(printed.ticketId).toBe("01-boot-the-app");
  expect(printed.output).toBe("Reading the ticket.\n· Edit: src/main.ts");

  gate.open();
  await watching.waitFor<QueueBody>("queue", (queue) => queue.state === "completed");
});

test("a failure reaches the watcher, and the attempt's whole log is there to read afterwards", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
    "02-add-search.md": ticketFile({ title: "02 — Add search", blockedBy: "01" }),
  });
  supervisor = await startTestSupervisor({ runner: fakeRunner(leavesBrokenWork(project)) });

  watching = await openEventStream(supervisor);
  await startRun(supervisor, project);
  const finished = await watching.waitFor<QueueBody>(
    "queue",
    (queue) => queue.state === "completed",
  );

  // What the dashboard shows per ticket comes from the stream; the logs behind it
  // are fetched per ticket, and outlive the reset that threw the work away.
  expect(stateOf(finished, "01-boot-the-app")).toBe("failed");
  expect(stateOf(finished, "02-add-search")).toBe("skipped");

  const attempts = await readAttempts(supervisor, "01-boot-the-app");
  expect(attempts.map((attempt) => attempt.outcome)).toEqual(["failed", "failed"]);
  expect(attempts[0]?.output).toContain("expected 2 to be 3");
});

test("a ticket having another go is pushed as one, so its history can be reread", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
  });
  const gate = createGate();
  const breaks = leavesBrokenWork(project);
  const work = commitsWork(project);
  let spent = 0;
  supervisor = await startTestSupervisor({
    runner: fakeRunner(async (request) => {
      spent += 1;
      if (spent > 1) await gate.opened;
      return spent === 1 ? breaks(request) : work(request);
    }),
  });

  watching = await openEventStream(supervisor);
  await startRun(supervisor, project);

  // A ticket stays `running` across its every retry, so the state alone never says
  // that the first Attempt has been filed and is there to be read.
  const retrying = await watching.waitFor<QueueBody>(
    "queue",
    (queue) => (ticketOf(queue, "01-boot-the-app")?.attempts ?? 0) > 0,
  );
  expect(stateOf(retrying, "01-boot-the-app")).toBe("running");
  expect(await readAttempts(supervisor, "01-boot-the-app")).toHaveLength(1);

  gate.open();
  const finished = await watching.waitFor<QueueBody>(
    "queue",
    (queue) => queue.state === "completed",
  );
  expect(ticketOf(finished, "01-boot-the-app")?.attempts).toBe(2);
});

test("nothing is pushed while nothing has changed", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
  });
  supervisor = await startTestSupervisor({ runner: fakeRunner(commitsWork(project)) });

  watching = await openEventStream(supervisor);
  await startRun(supervisor, project);
  await watching.waitFor<QueueBody>("queue", (queue) => queue.state === "completed");
  // Long enough that a stream repeating itself would have done so by now.
  await new Promise((resolve) => setTimeout(resolve, 500));

  // A watcher left open all night must not be sent the same queue over and over.
  const pushed = watching.received<QueueBody>("queue").map((queue) => JSON.stringify(queue));
  expect(new Set(pushed).size).toBe(pushed.length);
});

test("the Supervisor shuts down cleanly with a watcher still connected", async () => {
  const running = await startTestSupervisor();
  supervisor = running;
  watching = await openEventStream(running);
  await watching.waitFor<QueueBody>("queue", () => true);

  // A held-open stream must not be what keeps the service from stopping.
  await running.stop();
  supervisor = undefined;

  await watching.ended;
  watching = undefined;
});

test("a watcher hanging up leaves the run to carry on without it", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
  });
  const gate = createGate();
  const work = commitsWork(project);
  supervisor = await startTestSupervisor({
    runner: fakeRunner(async (request) => {
      await gate.opened;
      await work(request);
    }),
  });

  const leaving = await openEventStream(supervisor);
  await startRun(supervisor, project);
  await leaving.waitFor<QueueBody>("queue", (queue) => queue.state === "running");
  await leaving.close();

  gate.open();
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");
  expect(stateOf(finished, "01-boot-the-app")).toBe("succeeded");
});
