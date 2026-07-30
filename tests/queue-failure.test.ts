import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { createTestProject, type TestProject } from "./helpers/project.js";
import {
  readAttempts,
  requestStart,
  startRun,
  stateOf,
  ticketOf,
  waitForQueue,
} from "./helpers/queue.js";
import { commitsWork, fakeRunner, type FakeRunnerBehaviour } from "./helpers/runner.js";
import { startTestSupervisor, type TestSupervisor } from "./helpers/supervisor.js";
import { removeTempDirectories } from "./helpers/temp-dir.js";
import { ticketFile } from "./helpers/ticket-files.js";

let supervisor: TestSupervisor | undefined;

afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  await removeTempDirectories();
});

const BROKEN_OUTPUT = ["> npm test", "1 failing:", "  expected 2 to be 3"].join("\n");

/**
 * A Run that half-did the ticket — a commit of its own, plus files left lying
 * about — and then reported failure. Exactly the residue a Checkpoint reset exists
 * to throw away.
 */
function leavesBrokenWork(project: TestProject): FakeRunnerBehaviour {
  return async (request) => {
    const id = request.ticket.id;
    await writeFile(join(project.directory, `${id}-half.txt`), "half-written", "utf8");
    await project.git("add", "-A");
    await project.git("commit", "-m", `Broken work for ${id}`);
    await writeFile(join(project.directory, `${id}-scratch.txt`), "left behind", "utf8");
    return { status: "failed", reason: "the tests never passed", output: BROKEN_OUTPUT };
  };
}

/** Works the ticket the first id names; breaks every other one. */
function succeedsOnly(project: TestProject, succeeding: string): FakeRunnerBehaviour {
  const works = commitsWork(project);
  const breaks = leavesBrokenWork(project);
  return (request) => (request.ticket.id === succeeding ? works(request) : breaks(request));
}

test("a failed attempt leaves the branch exactly at the last Checkpoint, with no residue", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
    "02-add-search.md": ticketFile({ title: "02 — Add search" }),
  });
  supervisor = await startTestSupervisor({
    runner: fakeRunner(succeedsOnly(project, "01-boot-the-app")),
  });

  await startRun(supervisor, project);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  const checkpoint = ticketOf(finished, "01-boot-the-app")?.checkpoint ?? "";
  expect(checkpoint).toMatch(/^[0-9a-f]{40}$/);
  // Nothing of the failed attempt survives it: the only thing the branch has
  // gained since the Checkpoint is the Supervisor's own note on the ticket.
  expect(await project.git("diff", "--name-only", `${checkpoint}..HEAD`)).toBe(
    "tickets/02-add-search.md",
  );
  expect(await project.commitSubjects()).not.toContain("Broken work for 02-add-search");
  expect(existsSync(join(project.directory, "02-add-search-half.txt"))).toBe(false);
  expect(existsSync(join(project.directory, "02-add-search-scratch.txt"))).toBe(false);
  // And the branch is left clean, so the next run is not refused for the mess.
  expect(await project.git("status", "--porcelain")).toBe("");
});

test("an attempt refused by Verification is reset just like one that reported failure", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
  });
  const base = await project.head();
  supervisor = await startTestSupervisor({ runner: fakeRunner(commitsWork(project)) });

  // The Run does its work and commits it; the project's own command refuses it.
  await startRun(supervisor, project, { verify: ["echo not-today&& exit 7"] });
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(stateOf(finished, "01-boot-the-app")).toBe("failed");
  expect(await project.commitSubjects()).not.toContain("Work for 01-boot-the-app");
  expect(await project.git("diff", "--name-only", `${base}..HEAD`)).toBe(
    "tickets/01-boot-the-app.md",
  );
  expect(await project.git("status", "--porcelain")).toBe("");

  // What the refusing command printed is kept too, not just its exit code.
  const attempts = await readAttempts(supervisor, "01-boot-the-app");
  expect(attempts[0]?.failure).toContain("exited 7");
  expect(attempts[0]?.output).toContain("not-today");
});

test("a failure summary is never read back as one of the ticket's acceptance criteria", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app", criteria: ["It boots"] }),
  });
  supervisor = await startTestSupervisor({
    runner: fakeRunner(() => ({
      status: "failed",
      // Whatever a Run prints ends up in the ticket file; markdown of its own included.
      reason: "Claude reported:\n- [x] wrote the code\n- [ ] made the tests pass",
      output: "",
    })),
  });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(await project.read("tickets/01-boot-the-app.md")).toContain("made the tests pass");
  const preview = await previewSource(supervisor, project.ticketsDirectory);
  expect(preview.tickets[0]?.acceptanceCriteria).toEqual([{ text: "It boots", done: false }]);
});

test("a failed ticket is written back to its file as failed, with a failure summary", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
  });
  supervisor = await startTestSupervisor({ runner: fakeRunner(leavesBrokenWork(project)) });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // The write-back outlives the reset that threw the attempt's work away.
  const written = await project.read("tickets/01-boot-the-app.md");
  expect(written).toContain("**Status:** failed");
  expect(written).toContain("the tests never passed");
  // Everything the user wrote is still there.
  expect(written).toContain("# 01 — Boot the app");
  expect(written).toContain("- [ ] It works");
});

test("every ticket that depends on a failure is skipped, transitively, and never run", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
    "02-add-search.md": ticketFile({ title: "02 — Add search", blockedBy: "01" }),
    "03-rank-results.md": ticketFile({ title: "03 — Rank results", blockedBy: "02" }),
  });
  const runner = fakeRunner(leavesBrokenWork(project));
  supervisor = await startTestSupervisor({ runner });

  await startRun(supervisor, project);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(runner.order).toEqual(["01-boot-the-app"]);
  expect(stateOf(finished, "02-add-search")).toBe("skipped");
  expect(stateOf(finished, "03-rank-results")).toBe("skipped");
  // A skipped ticket says which blocker stopped it, not just that it stopped.
  expect(ticketOf(finished, "02-add-search")?.failure).toContain("01-boot-the-app");
  expect(ticketOf(finished, "03-rank-results")?.failure).toContain("02-add-search");
  // Nothing is written back for a ticket that was never attempted.
  expect(await project.read("tickets/02-add-search.md")).toContain("**Status:** ready-for-agent");
});

test("a failure never stops the tickets that do not depend on it", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
    "02-add-search.md": ticketFile({ title: "02 — Add search", blockedBy: "01" }),
    "03-write-docs.md": ticketFile({ title: "03 — Write docs" }),
  });
  const runner = fakeRunner(succeedsOnly(project, "03-write-docs"));
  supervisor = await startTestSupervisor({ runner });

  await startRun(supervisor, project);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(runner.order).toEqual(["01-boot-the-app", "03-write-docs"]);
  expect(finished.tickets.map((ticket) => [ticket.id, ticket.state])).toEqual([
    ["01-boot-the-app", "failed"],
    ["02-add-search", "skipped"],
    ["03-write-docs", "succeeded"],
  ]);
  // The independent ticket got a real Checkpoint of its own, after the failure.
  expect(await project.commitSubjects()).toContain("Checkpoint: Write docs");
  expect(await project.head()).toBe(ticketOf(finished, "03-write-docs")?.checkpoint);
  expect(await project.read("tickets/03-write-docs.md")).toContain("**Status:** done");
});

test("an attempt's full output is retained and retrievable despite the git reset", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
    "02-add-search.md": ticketFile({ title: "02 — Add search" }),
  });
  supervisor = await startTestSupervisor({
    runner: fakeRunner(succeedsOnly(project, "02-add-search")),
  });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  const failed = await readAttempts(supervisor, "01-boot-the-app");
  expect(failed).toHaveLength(1);
  expect(failed[0]?.outcome).toBe("failed");
  expect(failed[0]?.failure).toContain("the tests never passed");
  // The whole log, not a summary of it — the reset destroyed every other trace.
  expect(failed[0]?.output).toBe(BROKEN_OUTPUT);

  // Attempts that succeeded are kept just the same.
  const succeeded = await readAttempts(supervisor, "02-add-search");
  expect(succeeded.map((attempt) => attempt.outcome)).toEqual(["succeeded"]);

  // A ticket that never ran has nothing to show.
  expect(await readAttempts(supervisor, "03-never-heard-of-it")).toEqual([]);
});

test("a run that ended in failure leaves the project ready for the next run", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
  });
  supervisor = await startTestSupervisor({ runner: fakeRunner(leavesBrokenWork(project)) });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // A run refuses to start on a dirty project, so last night's failures must not
  // be what leaves it dirty.
  const second = await requestStart(supervisor, project);
  expect(second.status).toBe(202);
  // Let it finish before the test tears the project down under it.
  await waitForQueue(supervisor, (queue) => queue.state === "completed");
});

/** Re-reads the Ticket Source through the API, to see it as a later run would. */
async function previewSource(
  running: TestSupervisor,
  directory: string,
): Promise<{ tickets: { acceptanceCriteria: { text: string; done: boolean }[] }[] }> {
  const response = await running.request("/api/queue/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: { type: "local", directory } }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { tickets: { acceptanceCriteria: never[] }[] };
}

test("a later failure does not erase an earlier ticket's failure write-back", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
    "02-add-search.md": ticketFile({ title: "02 — Add search" }),
  });
  supervisor = await startTestSupervisor({ runner: fakeRunner(leavesBrokenWork(project)) });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // Both write-backs live in the working tree the second reset rewound.
  expect(await project.read("tickets/01-boot-the-app.md")).toContain("**Status:** failed");
  expect(await project.read("tickets/02-add-search.md")).toContain("**Status:** failed");
});
