import { afterEach, expect, test } from "vitest";

import { createTestProject } from "./helpers/project.js";
import {
  readQueue,
  requestPreview,
  requestStart,
  startRun,
  stateOf,
  waitForQueue,
  type QueueEdit,
} from "./helpers/queue.js";
import { commitsWork, fakeRunner } from "./helpers/runner.js";
import { startTestSupervisor, type TestSupervisor } from "./helpers/supervisor.js";
import { removeTempDirectories } from "./helpers/temp-dir.js";
import { ticketFile } from "./helpers/ticket-files.js";

let supervisor: TestSupervisor | undefined;

afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  await removeTempDirectories();
});

const BOOT = "01-boot-the-app";
const SEARCH = "02-add-search";
const DOCS = "03-write-docs";

/** A chain and a ticket standing on its own, so an edit's reach is visible. */
const TICKETS = {
  "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
  "02-add-search.md": ticketFile({ title: "02 — Add search", blockedBy: "01" }),
  "03-write-docs.md": ticketFile({ title: "03 — Write docs" }),
};

interface PreviewBody {
  tickets: { id: string }[];
  frontier: string[];
  /** Every id the edit took out, the ones taken along with them included. */
  excluded: string[];
}

interface ErrorBody {
  error: string;
}

async function readPreview(
  running: TestSupervisor,
  directory: string,
  queue?: QueueEdit,
): Promise<PreviewBody> {
  const response = await requestPreview(running, directory, queue);
  expect(response.status).toBe(200);
  return (await response.json()) as PreviewBody;
}

test("the previewed queue is the one the run executes, edit and all", async () => {
  const project = await createTestProject(TICKETS);
  const runner = fakeRunner(commitsWork(project));
  supervisor = await startTestSupervisor({ runner });

  const edit: QueueEdit = { order: [DOCS] };
  const preview = await readPreview(supervisor, project.ticketsDirectory, edit);
  expect(preview.tickets.map((ticket) => ticket.id)).toEqual([DOCS, BOOT, SEARCH]);
  // Reordering does not make a blocked ticket runnable; only its blocker can.
  expect(preview.frontier).toEqual([DOCS, BOOT]);

  await startRun(supervisor, project, { queue: edit });
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // The run does what the preview showed — otherwise the preview is a guess.
  expect(runner.order).toEqual([DOCS, BOOT, SEARCH]);
});

test("excluding a ticket takes everything waiting on it out of the queue", async () => {
  const project = await createTestProject(TICKETS);
  const runner = fakeRunner(commitsWork(project));
  supervisor = await startTestSupervisor({ runner });

  const preview = await readPreview(supervisor, project.ticketsDirectory, { exclude: [BOOT] });

  // A ticket whose blocker will not run cannot run, so it comes out too — and
  // the preview says so, since the user only asked for one of them.
  expect(preview.excluded).toEqual([BOOT, SEARCH]);
  expect(preview.tickets.map((ticket) => ticket.id)).toEqual([DOCS]);

  await startRun(supervisor, project, { queue: { exclude: [BOOT] } });
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // An excluded ticket is not in the Queue at all — not pending, not skipped.
  expect(finished.tickets.map((ticket) => ticket.id)).toEqual([DOCS]);
  expect(runner.order).toEqual([DOCS]);
  // And nothing is written back to a ticket that was never in the run.
  expect(await project.read(`tickets/${BOOT}.md`)).toContain("**Status:** ready-for-agent");
});

test("an unedited queue reports nothing excluded", async () => {
  const project = await createTestProject(TICKETS);
  supervisor = await startTestSupervisor();

  const preview = await readPreview(supervisor, project.ticketsDirectory);

  expect(preview.excluded).toEqual([]);
  expect(preview.tickets.map((ticket) => ticket.id)).toEqual([BOOT, SEARCH, DOCS]);
});

test("an order that puts a ticket before its blocker is refused, and nothing starts", async () => {
  const project = await createTestProject(TICKETS);
  const runner = fakeRunner(commitsWork(project));
  supervisor = await startTestSupervisor({ runner });
  const edit: QueueEdit = { order: [SEARCH, BOOT] };

  const previewed = await requestPreview(supervisor, project.ticketsDirectory, edit);
  expect(previewed.status).toBe(400);
  const complaint = ((await previewed.json()) as ErrorBody).error;
  expect(complaint).toContain(SEARCH);
  expect(complaint).toContain(BOOT);

  const started = await requestStart(supervisor, project, { queue: edit });

  // Refused at the same place for the same reason: an impossible order is not a
  // run that starts and then discovers it cannot go on.
  expect(started.status).toBe(400);
  expect((await readQueue(supervisor)).state).toBe("idle");
  expect(runner.order).toEqual([]);
  expect(await project.currentBranch()).toBe("main");
});

test("an edit naming a ticket the source never had is refused", async () => {
  const project = await createTestProject(TICKETS);
  supervisor = await startTestSupervisor();

  const response = await requestStart(supervisor, project, { queue: { exclude: ["99-nowhere"] } });

  // Silently ignoring it would be a run the user thinks they edited and did not.
  expect(response.status).toBe(400);
  expect(((await response.json()) as ErrorBody).error).toContain("99-nowhere");
  expect((await readQueue(supervisor)).state).toBe("idle");
});

test("an edit written as something other than lists of tickets is refused", async () => {
  const project = await createTestProject(TICKETS);
  supervisor = await startTestSupervisor();

  const response = await requestStart(supervisor, project, { queue: { exclude: BOOT } });

  expect(response.status).toBe(400);
  expect(((await response.json()) as ErrorBody).error).toContain("exclude");
  expect((await readQueue(supervisor)).state).toBe("idle");
});

test("a ticket already done keeps its place, and is neither run nor excluded", async () => {
  const project = await createTestProject({
    ...TICKETS,
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app", status: "done" }),
  });
  const runner = fakeRunner(commitsWork(project));
  supervisor = await startTestSupervisor({ runner });

  await startRun(supervisor, project, { queue: { order: [SEARCH] } });
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // Its blocker is done, so moving it to the front is a legitimate order.
  expect(stateOf(finished, BOOT)).toBe("done");
  expect(runner.order).toEqual([SEARCH, DOCS]);
});
