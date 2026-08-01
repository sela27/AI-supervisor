import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { reviewingInstance } from "./helpers/config-file.js";
import { createTestProject, type TestProject } from "./helpers/project.js";
import { readAttempts, readQueue, startRun, stateOf, waitForQueue } from "./helpers/queue.js";
import {
  approves,
  commitsWork,
  fakeRunner,
  leavesBrokenWork,
  reviewSpending,
  spending,
  stoppedByTheLimit,
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

const BOOT = "01-boot-the-app";

async function oneTicketProject(): Promise<TestProject> {
  return createTestProject({ [`${BOOT}.md`]: ticketFile({ title: "01 — Boot the app" }) });
}

/** What one Run of a ticket reported spending — an hour of quota, priced. */
const A_RUN = { costUsd: 0.1, turns: 11, durationMs: 62_000 };
/** What a second Run of the same ticket reported, so the two never add up by accident. */
const ANOTHER_RUN = { costUsd: 0.2, turns: 3, durationMs: 9_000 };
/**
 * The two of them together, written out rather than added up here: `0.1 + 0.2`
 * is `0.30000000000000004` in floating point, and a bill has to read like a bill.
 */
const BOTH = { costUsd: 0.3, turns: 14, durationMs: 71_000 };

test("an Attempt is filed with what its Run spent, and the run adds them up", async () => {
  const project = await oneTicketProject();
  supervisor = await startTestSupervisor({
    runner: fakeRunner(spending(A_RUN, commitsWork(project))),
  });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  const attempts = await readAttempts(supervisor, BOOT);
  expect(attempts.map((attempt) => attempt.spend)).toEqual([A_RUN]);
  // The whole night's bill, which is the question somebody actually asks.
  expect((await readQueue(supervisor)).spent).toEqual(A_RUN);
});

test("a Run that reported no figures is filed without any, rather than as a free one", async () => {
  const project = await oneTicketProject();
  supervisor = await startTestSupervisor({ runner: fakeRunner(commitsWork(project)) });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // A nought here would read as a night that cost nothing, and no night is free.
  expect((await readAttempts(supervisor, BOOT))[0]?.spend).toBeNull();
  expect((await readQueue(supervisor)).spent).toBeNull();
});

test("a refused Attempt is accounted exactly as the one that stood is", async () => {
  const project = await oneTicketProject();
  const broken = leavesBrokenWork(project);
  const work = commitsWork(project);
  let gone = 0;
  const runner: FakeRunnerBehaviour = (request) => {
    gone += 1;
    return gone === 1
      ? spending(A_RUN, broken)(request)
      : spending(ANOTHER_RUN, work)(request);
  };
  supervisor = await startTestSupervisor({ runner: fakeRunner(runner) });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // The quota went on the refused go exactly as it went on the one that worked,
  // so leaving it out would understate the night by however many goes it took.
  const attempts = await readAttempts(supervisor, BOOT);
  expect(attempts.map((attempt) => attempt.spend)).toEqual([A_RUN, ANOTHER_RUN]);
  expect((await readQueue(supervisor)).spent).toEqual(BOTH);
});

test("an Attempt a usage limit cut short is accounted too — quota went either way", async () => {
  const project = await oneTicketProject();
  const resetAt = new Date(Date.now() + 5 * 60 * 60 * 1000);
  supervisor = await startTestSupervisor({
    runner: fakeRunner(spending(A_RUN, stoppedByTheLimit(project, resetAt))),
  });

  await startRun(supervisor, project);
  const stopped = await waitForQueue(supervisor, (queue) => queue.state === "paused-on-limit");

  // Nothing was learned about the ticket, and the ticket is held to nothing —
  // but the hour the Run spent before the quota refused it is still spent.
  expect(stateOf(stopped, BOOT)).toBe("pending");
  const attempts = await readAttempts(supervisor, BOOT);
  expect(attempts.map((attempt) => attempt.outcome)).toEqual(["limit-hit"]);
  expect(attempts[0]?.spend).toEqual(A_RUN);
  expect((await readQueue(supervisor)).spent).toEqual(A_RUN);
});

test("the review's own Run is part of what the Attempt it judged cost", async () => {
  const project = await oneTicketProject();
  supervisor = await startTestSupervisor({
    runner: fakeRunner(
      spending(A_RUN, commitsWork(project)),
      reviewSpending(ANOTHER_RUN, approves()),
    ),
    configDirectory: await reviewingInstance(),
  });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // A review is a Run of its own, and an instance that turned reviews on is
  // spending that quota on every Attempt that reaches one.
  expect((await readAttempts(supervisor, BOOT))[0]?.spend).toEqual(BOTH);
});

test("a night an older build recorded still reads back, nothing invented for it", async () => {
  const project = await oneTicketProject();
  const first = await startTestSupervisor({
    runner: fakeRunner(spending(A_RUN, commitsWork(project))),
  });
  await startRun(first, project);
  await waitForQueue(first, (queue) => queue.state === "completed");
  await first.stop();

  recordItTheOldWay(join(first.dataDir, "supervisor.db"));

  supervisor = await startTestSupervisor({ dataDir: first.dataDir });

  // The night is all still there, and the one thing the old build had nowhere to
  // put is missing rather than made up.
  const attempts = await readAttempts(supervisor, BOOT);
  expect(attempts.map((attempt) => attempt.outcome)).toEqual(["succeeded"]);
  expect(attempts[0]?.spend).toBeNull();
  expect((await readQueue(supervisor)).spent).toBeNull();
});

/**
 * Puts a database back the way the build before this one would have left it: the
 * same night, recorded when there was nowhere to write down what it cost. What
 * the next boot does with it is the migration this is here to try.
 */
function recordItTheOldWay(file: string): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      ALTER TABLE attempts DROP COLUMN cost_usd;
      ALTER TABLE attempts DROP COLUMN turns;
      ALTER TABLE attempts DROP COLUMN duration_ms;
      DELETE FROM schema_migrations WHERE version = 4;
    `);
  } finally {
    db.close();
  }
}
