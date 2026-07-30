import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { createTestProject } from "./helpers/project.js";
import { readAttempts, startRun, stateOf, ticketOf, waitForQueue } from "./helpers/queue.js";
import { fakeRunner, stoppedByTheLimit } from "./helpers/runner.js";
import { startTestSupervisor, type TestSupervisor } from "./helpers/supervisor.js";
import { removeTempDirectories } from "./helpers/temp-dir.js";
import { ticketFile } from "./helpers/ticket-files.js";

let supervisor: TestSupervisor | undefined;

afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  await removeTempDirectories();
});

const RESET_AT = new Date("2026-07-30T06:30:00.000Z");

test("a usage limit stops the run without holding it against the ticket", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
    "02-add-search.md": ticketFile({ title: "02 — Add search" }),
  });
  const base = await project.head();
  const runner = fakeRunner(stoppedByTheLimit(project, RESET_AT));
  supervisor = await startTestSupervisor({ runner });

  await startRun(supervisor, project);
  const stopped = await waitForQueue(supervisor, (queue) => queue.state !== "running");

  // The queue stops — waiting the limit out is not built yet — but the ticket is
  // left exactly as it was found: not failed, not done, just not yet attempted.
  expect(stopped.state).toBe("paused-on-limit");
  expect(stateOf(stopped, "01-boot-the-app")).toBe("pending");
  expect(ticketOf(stopped, "01-boot-the-app")?.failure).toBeNull();
  // Nothing downstream is skipped either: no ticket failed, so none is doomed.
  expect(stateOf(stopped, "02-add-search")).toBe("pending");
  expect(runner.order).toEqual(["01-boot-the-app"]);

  // Nothing is written back to the Ticket Source for an Attempt that never ran
  // its course.
  expect(await project.read("tickets/01-boot-the-app.md")).toContain("**Status:** ready-for-agent");

  // And the interrupted Attempt's half-work is discarded, as any other is.
  expect(await project.head()).toBe(base);
  expect(existsSync(join(project.directory, "01-boot-the-app-scratch.txt"))).toBe(false);
  expect(await project.git("status", "--porcelain")).toBe("");
});

test("the run says when the limit lifts, so the wait is not a mystery", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
  });
  supervisor = await startTestSupervisor({ runner: fakeRunner(stoppedByTheLimit(project, RESET_AT)) });

  await startRun(supervisor, project);
  const stopped = await waitForQueue(supervisor, (queue) => queue.state !== "running");

  expect(stopped.error).toContain("usage limit");
  expect(stopped.error).toContain(RESET_AT.toISOString());
});

test("a limit with no reset time still stops the run with an honest explanation", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
  });
  supervisor = await startTestSupervisor({ runner: fakeRunner(stoppedByTheLimit(project, null)) });

  await startRun(supervisor, project);
  const stopped = await waitForQueue(supervisor, (queue) => queue.state !== "running");

  expect(stopped.error).toContain("usage limit");
});

test("the interrupted Attempt's log is kept, marked as the limit rather than a failure", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
  });
  supervisor = await startTestSupervisor({ runner: fakeRunner(stoppedByTheLimit(project, RESET_AT)) });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state !== "running");

  const attempts = await readAttempts(supervisor, "01-boot-the-app");
  expect(attempts).toHaveLength(1);
  expect(attempts[0]?.outcome).toBe("limit-hit");
  // The reset threw the working tree away; the log is what is left of the Attempt.
  expect(attempts[0]?.output).toContain("the quota ran out");
});
