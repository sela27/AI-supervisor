import { afterEach, expect, test } from "vitest";

import { DAY, HOUR, testClock } from "./helpers/clock.js";
import { instanceWith } from "./helpers/config-file.js";
import { fakeNotifier, type FakeNotifier } from "./helpers/notifier.js";
import { createTestProject } from "./helpers/project.js";
import {
  control,
  createGate,
  runBranch,
  settle,
  startRun,
  stateOf,
  waitForQueue,
  type QueueBody,
} from "./helpers/queue.js";
import {
  commitsWork,
  fakeRunner,
  leavesBrokenWork,
  limitedFor,
  succeedsOnly,
} from "./helpers/runner.js";
import { startTestSupervisor, type TestSupervisor } from "./helpers/supervisor.js";
import { removeTempDirectories } from "./helpers/temp-dir.js";
import { independentTickets, ticketFile } from "./helpers/ticket-files.js";

/**
 * What reaches the phone. The Notifier is the seam — the fake records exactly
 * what a webhook would have been posted, so nothing leaves the machine — but
 * whether anything is said at all is the instance's own settings deciding, read
 * from a real config file the way a deployed instance reads its own.
 */

let supervisor: TestSupervisor | undefined;

afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  await removeTempDirectories();
});

/** Evening, for the one test whose clock has to be moved by hand. */
const NOW = new Date("2026-07-30T21:00:00.000Z");

/** A queue with a middle ticket that cannot be got past, and a tail behind it. */
function mixedQueue(): Record<string, string> {
  return {
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
    "02-add-search.md": ticketFile({ title: "02 — Add search", blockedBy: "None" }),
    "03-search-ui.md": ticketFile({ title: "03 — Search UI", blockedBy: "02-add-search.md" }),
  };
}

test("the night's outcome: how each ticket ended, and where to look", async () => {
  const told = fakeNotifier();
  const project = await createTestProject(mixedQueue());
  supervisor = await startTestSupervisor({
    runner: fakeRunner(succeedsOnly(project, "01-boot-the-app")),
    notifier: told.notifier,
  });

  await startRun(supervisor, project);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // One succeeded, one was refused every Attempt, and the one behind it was never
  // tried — which is the whole of what somebody wants before opening anything.
  expect(stateOf(finished, "03-search-ui")).toBe("skipped");
  const [said] = told.about("queue-finished");
  expect(said?.title).toBe("Queue finished: 1 succeeded, 1 failed, 1 skipped");
  expect(said?.body).toContain("1 succeeded, 1 failed, 1 skipped");
  expect(said?.body).toContain(runBranch(finished));
});

test("a ticket nothing could get past says so while the rest of the night runs on", async () => {
  const told = fakeNotifier();
  const project = await createTestProject(mixedQueue());
  supervisor = await startTestSupervisor({
    runner: fakeRunner(succeedsOnly(project, "01-boot-the-app")),
    notifier: told.notifier,
  });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  const [said] = told.about("ticket-failed");
  expect(said?.title).toBe("Ticket failed: Add search");
  // The id as well as the title, since the id is what everything else calls it.
  expect(said?.body).toContain("02-add-search");
  // What refused it, so the reader knows whether it is theirs to look at tonight.
  expect(said?.body).toContain("the tests never passed");
  // Only the ticket that ran out of Attempts. The one skipped behind it was never
  // tried, and a phone buzzing for every consequence of one failure is a phone
  // that gets silenced.
  expect(told.about("ticket-failed")).toHaveLength(1);
});

test("a run that broke down says so, since nothing is going to pick it up", async () => {
  const told = fakeNotifier();
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
  });
  supervisor = await startTestSupervisor({
    runner: fakeRunner(() => {
      throw new Error("the Claude Code CLI is not on the path");
    }),
    notifier: told.notifier,
  });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "failed");

  const [said] = told.about("run-broke-down");
  expect(said?.body).toContain("the Claude Code CLI is not on the path");
  expect(said?.body).toContain("Nothing picks it up");
  // A run that never got anywhere did not finish; saying it had would be worse
  // than saying nothing.
  expect(told.about("queue-finished")).toEqual([]);
});

/**
 * The same night with a ticket left over, so that a run can be stopped with work
 * still on the queue — which is the whole difference between a night that ended
 * and a night that was ended.
 */
function queueWithSomethingLeft(): Record<string, string> {
  return {
    ...mixedQueue(),
    "04-ship-it.md": ticketFile({ title: "04 — Ship it", blockedBy: "None" }),
  };
}

/**
 * A night a Safety stop ends two tickets in, with a ticket still on the queue:
 * one succeeded, one was refused every Attempt, one was skipped behind it, and
 * one was never reached at all. `settings` is whatever else the instance is told.
 */
async function nightStoppedForSafety(
  settings: object = {},
): Promise<{ told: FakeNotifier; stopped: QueueBody }> {
  const told = fakeNotifier();
  const project = await createTestProject(queueWithSomethingLeft());
  supervisor = await startTestSupervisor({
    configDirectory: await instanceWith({ safety: { maxTickets: 2 }, ...settings }),
    runner: fakeRunner(succeedsOnly(project, "01-boot-the-app")),
    notifier: told.notifier,
  });

  await startRun(supervisor, project);
  const stopped = await waitForQueue(supervisor, (queue) => queue.state === "stopped");
  return { told, stopped };
}

test("a Safety stop that ended the night says so, since no finished queue will", async () => {
  const { told, stopped } = await nightStoppedForSafety();

  const [said] = told.about("safety-stop-reached");
  expect(said?.title).toContain("this run was allowed 2 tickets, and it has run them");
  // The same tally a finished queue carries, because for this run no finished
  // queue is ever going to: the morning gets its account here or not at all.
  expect(said?.body).toContain("1 succeeded, 1 failed, 1 skipped");
  expect(said?.body).toContain(runBranch(stopped));
  expect(told.about("safety-stop-reached")).toHaveLength(1);
  expect(told.about("queue-finished")).toEqual([]);
  // The ticket the stop never reached is left waiting and unblamed, and nothing
  // about the night is said as though the subscription had refused it.
  expect(stateOf(stopped, "04-ship-it")).toBe("pending");
});

test("a night given up on as systematically broken is told about the same way", async () => {
  const told = fakeNotifier();
  const project = await createTestProject(independentTickets(4));
  // Nothing configured: the failure stop is the one that is on to begin with.
  supervisor = await startTestSupervisor({
    runner: fakeRunner(leavesBrokenWork(project)),
    notifier: told.notifier,
  });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "stopped");

  const [said] = told.about("safety-stop-reached");
  expect(said?.title).toContain("3 tickets failed one after another");
  expect(said?.body).toContain("0 succeeded, 3 failed, 0 skipped");
  // Three tickets said their own piece on the way, and the night saying it is
  // over is a fourth thing, not a summary of them.
  expect(told.about("ticket-failed")).toHaveLength(3);
  expect(told.about("safety-stop-reached")).toHaveLength(1);
});

test("a stop that ends a limit wait reaches somebody as any other stop does", async () => {
  const told = fakeNotifier();
  const clock = testClock(NOW);
  const project = await createTestProject(independentTickets(2));
  supervisor = await startTestSupervisor({
    configDirectory: await instanceWith({ safety: { maxRuntimeMinutes: 120 } }),
    runner: fakeRunner(limitedFor(project, 1, new Date(NOW.getTime() + 7 * DAY))),
    notifier: told.notifier,
    clock,
  });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "paused-on-limit");
  // The other way a run reaches a stop: asleep waiting for quota a week away,
  // woken by its own hour rather than by a ticket ending under it.
  clock.advance(3 * HOUR);
  const stopped = await waitForQueue(supervisor, (queue) => queue.state === "stopped");

  const [said] = told.about("safety-stop-reached");
  expect(said?.title).toContain("this run was allowed 2 hours, and it is up");
  expect(said?.body).toContain("0 succeeded, 0 failed, 0 skipped");
  expect(said?.body).toContain(runBranch(stopped));
  expect(told.about("safety-stop-reached")).toHaveLength(1);
  expect(told.about("queue-finished")).toEqual([]);
});

test("a stop the user gave by hand says nothing: they are holding the phone", async () => {
  const told = fakeNotifier();
  const project = await createTestProject(queueWithSomethingLeft());
  const gate = createGate();
  const works = commitsWork(project);
  supervisor = await startTestSupervisor({
    runner: fakeRunner(async (request) => {
      await gate.opened;
      return works(request);
    }),
    notifier: told.notifier,
  });

  await startRun(supervisor, project);
  // Given mid-ticket, so the stop lands at a real ticket boundary with a night's
  // work already behind it — the very night that would be worth telling about,
  // were the person who ended it not the person who would be told.
  await control(supervisor, "/api/queue/stop");
  gate.open();
  const stopped = await waitForQueue(supervisor, (queue) => queue.state === "stopped");
  await settle();

  expect(stateOf(stopped, "01-boot-the-app")).toBe("succeeded");
  expect(told.sent).toEqual([]);
});

test("a global switch silences the lot of them", async () => {
  const told = fakeNotifier();
  const project = await createTestProject(mixedQueue());
  supervisor = await startTestSupervisor({
    configDirectory: await instanceWith({ notifications: { enabled: false } }),
    runner: fakeRunner(succeedsOnly(project, "01-boot-the-app")),
    notifier: told.notifier,
  });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // A night that failed a ticket, skipped another and then finished: three things
  // worth saying, and an instance that was told to run silently says none of them.
  expect(told.sent).toEqual([]);
});

/** A mixed night run under one silenced Event, and everything it said about it. */
async function nightSilencing(silenced: string): Promise<FakeNotifier> {
  const told = fakeNotifier();
  const project = await createTestProject(mixedQueue());
  supervisor = await startTestSupervisor({
    configDirectory: await instanceWith({ notifications: { on: { [silenced]: false } } }),
    runner: fakeRunner(succeedsOnly(project, "01-boot-the-app")),
    notifier: told.notifier,
  });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");
  return told;
}

test("silencing a failed ticket still leaves the night's outcome to be told", async () => {
  const told = await nightSilencing("ticket-failed");

  // Somebody who reviews the branch in the morning anyway may not want waking for
  // one refused ticket, and still wants to know the night is over.
  expect(told.about("ticket-failed")).toEqual([]);
  expect(told.about("queue-finished")).toHaveLength(1);
});

test("silencing the night's outcome still leaves a failed ticket to be told", async () => {
  const told = await nightSilencing("queue-finished");

  // The switches are per Event and nothing else: silencing one says nothing about
  // any of the others, in either direction.
  expect(told.about("queue-finished")).toEqual([]);
  expect(told.about("ticket-failed")).toHaveLength(1);
});

test("the Safety stop's own Event is silenced by name like every other", async () => {
  const { told } = await nightStoppedForSafety({
    notifications: { on: { "safety-stop-reached": false } },
  });
  await settle();

  // Somebody who set the stop themselves may not want waking to hear it reached,
  // and the ticket that failed on the way is still worth their morning.
  expect(told.about("safety-stop-reached")).toEqual([]);
  expect(told.about("ticket-failed")).toHaveLength(1);
});

test("a webhook that refuses every notification is not what ends the night", async () => {
  const told = fakeNotifier(async () => {
    throw new Error("ntfy.sh: 502 Bad Gateway");
  });
  const project = await createTestProject(mixedQueue());
  supervisor = await startTestSupervisor({
    runner: fakeRunner(succeedsOnly(project, "01-boot-the-app")),
    notifier: told.notifier,
  });

  await startRun(supervisor, project);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // The failed ticket and the finish — the skipped one is nobody's news — refused
  // by the webhook both, and the night ran exactly as it would have in silence.
  expect(told.sent).toHaveLength(2);
  expect(stateOf(finished, "01-boot-the-app")).toBe("succeeded");
  expect(stateOf(finished, "02-add-search")).toBe("failed");
  expect(stateOf(finished, "03-search-ui")).toBe("skipped");
  expect(finished.error).toBeNull();
});

test("a webhook that never answers does not hold the queue up behind it", async () => {
  // The worst kind: a target that takes the connection and then says nothing at
  // all, for as long as the run is prepared to wait — which is not at all.
  const told = fakeNotifier(() => new Promise<void>(() => {}));
  const project = await createTestProject(mixedQueue());
  supervisor = await startTestSupervisor({
    runner: fakeRunner(commitsWork(project)),
    notifier: told.notifier,
  });

  await startRun(supervisor, project);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(stateOf(finished, "01-boot-the-app")).toBe("succeeded");
  expect(stateOf(finished, "03-search-ui")).toBe("succeeded");
});

test("an instance with nowhere to post to runs the same night in silence", async () => {
  const project = await createTestProject(mixedQueue());
  // No Notifier of the test's own, so the instance builds its own from a config
  // file that names no webhook. Anything it tried to post would be a real request.
  supervisor = await startTestSupervisor({
    runner: fakeRunner(succeedsOnly(project, "01-boot-the-app")),
  });

  await startRun(supervisor, project);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(stateOf(finished, "01-boot-the-app")).toBe("succeeded");
  expect(stateOf(finished, "02-add-search")).toBe("failed");
});
