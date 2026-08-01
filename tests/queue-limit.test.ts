import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { DAY, HOUR, MINUTE, testClock, type TestClock } from "./helpers/clock.js";
import { fakeNotifier, type FakeNotifier } from "./helpers/notifier.js";
import { createTestProject, type TestProject } from "./helpers/project.js";
import {
  control,
  createGate,
  readAttempts,
  settle,
  startRun,
  stateOf,
  ticketOf,
  waitForQueue,
  type QueueBody,
} from "./helpers/queue.js";
import {
  fakeRunner,
  limitedFor,
  stoppedByTheLimit,
  type FakeRunner,
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

/** Two in the morning, which is when the quota tends to run out. */
const NOW = new Date("2026-07-30T02:00:00.000Z");
/** A five-hour window lifting four and a half hours from now: a long wait. */
const RESET_AT = new Date("2026-07-30T06:30:00.000Z");
/** What the run waits beyond the stated reset, so it is not refused by seconds. */
const MARGIN = MINUTE;
/** How long a limit that named no reset time goes before the run looks again. */
const PROBE_EVERY = 30 * MINUTE;

function after(moment: Date, ms: number): string {
  return new Date(moment.getTime() + ms).toISOString();
}

interface LimitedRun {
  running: TestSupervisor;
  project: TestProject;
  runner: FakeRunner;
  clock: TestClock;
}

/**
 * One ticket, a Runner scripted around the usage limit, and a clock the test
 * moves by hand. Everything else — git, the ticket files, Verification — is real.
 */
async function startLimitedRun(
  behave: (project: TestProject) => FakeRunnerBehaviour,
  told?: FakeNotifier,
): Promise<LimitedRun> {
  const clock = testClock(NOW);
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
  });
  const runner = fakeRunner(behave(project));

  const running = await startTestSupervisor({
    runner,
    clock,
    ...(told === undefined ? {} : { notifier: told.notifier }),
  });
  supervisor = running;

  await startRun(running, project);
  return { running, project, runner, clock };
}

/** The queue once the run has settled down to wait the limit out. */
function waitingQueue(running: TestSupervisor): Promise<QueueBody> {
  return waitForQueue(running, (queue) => queue.state === "paused-on-limit" && queue.resumeAt !== null);
}

test("a usage limit stops the run without holding it against the ticket", async () => {
  const clock = testClock(NOW);
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
    "02-add-search.md": ticketFile({ title: "02 — Add search" }),
  });
  const base = await project.head();
  const runner = fakeRunner(stoppedByTheLimit(project, RESET_AT));
  supervisor = await startTestSupervisor({ runner, clock });

  await startRun(supervisor, project);
  const stopped = await waitForQueue(supervisor, (queue) => queue.state !== "running");

  // The queue waits rather than fails, and the ticket is left exactly as it was
  // found: not failed, not done, just not yet attempted.
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

test("the run says when it will try again, so a silent queue is never a mystery", async () => {
  const { running } = await startLimitedRun((project) => stoppedByTheLimit(project, RESET_AT));

  const waiting = await waitingQueue(running);

  // The reset the Run named, plus the margin: the moment the run means to be back
  // at work, which is the whole of what a reader needs to stop worrying.
  expect(waiting.resumeAt).toBe(after(RESET_AT, MARGIN));
  expect(waiting.error).toContain("usage limit");
  expect(waiting.error).toContain(RESET_AT.toISOString());
});

test("a limit with no reset time still says when the run will next look", async () => {
  const { running } = await startLimitedRun((project) => stoppedByTheLimit(project, null));

  const waiting = await waitingQueue(running);

  // Nothing to project from is not nothing to say: the run will look again in
  // half an hour, and that is a time.
  expect(waiting.resumeAt).toBe(after(NOW, PROBE_EVERY));
  expect(waiting.error).toContain("usage limit");
});

test("the queue picks itself up at the reset, and the ticket runs from scratch", async () => {
  const { running, project, runner, clock } = await startLimitedRun((made) =>
    limitedFor(made, 1, RESET_AT),
  );
  await waitingQueue(running);

  // Nobody touched anything: the clock reaching the reset is the whole of what
  // put the run back to work.
  clock.advance(5 * HOUR);
  const finished = await waitForQueue(running, (queue) => queue.state === "completed");

  expect(stateOf(finished, "01-boot-the-app")).toBe("succeeded");
  expect(finished.resumeAt).toBeNull();
  expect(finished.error).toBeNull();
  // Twice through the Runner, from scratch each time. The limit cost the ticket
  // nothing out of its own budget, and the second Run is told nothing about the
  // first — there was no failure to learn from.
  expect(runner.order).toEqual(["01-boot-the-app", "01-boot-the-app"]);
  expect(runner.requests[1]?.previousFailure).toBeUndefined();

  expect(await project.read("tickets/01-boot-the-app.md")).toContain("**Status:** done");
  expect(existsSync(join(project.directory, "01-boot-the-app-half.txt"))).toBe(false);
});

test("a limit that named no reset time is probed until the quota is back", async () => {
  const { running, runner, clock } = await startLimitedRun((project) =>
    limitedFor(project, 2, null),
  );

  const first = await waitingQueue(running);
  expect(first.resumeAt).toBe(after(NOW, PROBE_EVERY));

  // The probe finds the quota still gone, so the run settles down to wait again
  // rather than giving up on a ticket nothing is wrong with.
  clock.advance(PROBE_EVERY);
  const second = await waitForQueue(
    running,
    (queue) => queue.resumeAt === after(NOW, 2 * PROBE_EVERY),
  );
  expect(second.state).toBe("paused-on-limit");

  clock.advance(PROBE_EVERY);
  const finished = await waitForQueue(running, (queue) => queue.state === "completed");

  expect(stateOf(finished, "01-boot-the-app")).toBe("succeeded");
  expect(runner.order).toHaveLength(3);
});

test("a wait of hours is something somebody is told about", async () => {
  const told = fakeNotifier();
  const { running } = await startLimitedRun(
    (project) => stoppedByTheLimit(project, RESET_AT),
    told,
  );

  await waitingQueue(running);

  // Four and a half hours of silence is not something to leave a person to work
  // out from a page that has stopped changing.
  const said = told.about("long-wait");
  expect(said).toHaveLength(1);
  expect(said[0]?.body).toContain("01-boot-the-app");
  expect(said[0]?.body).toContain(after(RESET_AT, MARGIN));
});

test("a limit with no reset time is not silently sat through for days", async () => {
  const told = fakeNotifier();
  const { running, clock } = await startLimitedRun((project) => limitedFor(project, 6, null), told);

  await waitingQueue(running);
  // Nothing is ever projected here — there is no reset time to project from — so
  // the only thing that says this wait is a long one is how long it has gone on.
  expect(told.about("long-wait")).toEqual([]);

  // Half an hour at a time, until the looking has itself taken two hours.
  for (let look = 0; look < 5; look += 1) {
    clock.advance(PROBE_EVERY);
    await waitForQueue(running, (queue) => queue.resumeAt === after(NOW, (look + 2) * PROBE_EVERY));
  }

  // Said once, however many more times the run looks: the person being told is
  // not watching, and telling them every half hour until Friday is worse than
  // not telling them at all.
  const said = told.about("long-wait");
  expect(said).toHaveLength(1);
  // The fourth look is the one whose own half-hour carries the spell past two
  // hours; the two after it say nothing.
  expect(said[0]?.body).toContain(after(NOW, 4 * PROBE_EVERY));
});

test("a pause given during the interrupted Attempt is not honoured a week late", async () => {
  const opened = createGate();
  const weekAway = new Date(NOW.getTime() + 7 * DAY);
  const { running, clock } = await startLimitedRun((project) => {
    const refused = stoppedByTheLimit(project, weekAway);
    return async (request) => {
      await opened.opened;
      return refused(request);
    };
  });

  // Paused while the Attempt is still in flight, so the instruction is standing
  // when the limit — not the ticket ending normally — is what ends the Attempt.
  const pausing = await control(running, "/api/queue/pause");
  expect(pausing.instruction).toBe("pause");
  opened.open();

  // The limit stopping the ticket is the boundary the instruction was waiting
  // for. Sitting out the week first would honour it next Thursday.
  const paused = await waitForQueue(running, (queue) => queue.state !== "running");
  expect(paused.state).toBe("paused");
  expect(paused.instruction).toBeNull();
  expect(paused.resumeAt).toBeNull();

  clock.advance(8 * DAY);
  await settle();
  expect((await waitForQueue(running, () => true)).state).toBe("paused");
});

test("a wait of minutes is nobody's business", async () => {
  const told = fakeNotifier();
  const soon = new Date(NOW.getTime() + 20 * MINUTE);
  const { running, clock } = await startLimitedRun((project) => limitedFor(project, 1, soon), told);

  await waitingQueue(running);
  clock.advance(HOUR);
  await waitForQueue(running, (queue) => queue.state === "completed");

  // The run waited, resumed, and never said a word about it: a limit lifting
  // before the next cup of tea is not a notification anyone thanks you for.
  expect(told.about("long-wait")).toEqual([]);
});

test("resuming a waiting run tries now, rather than at the hour it was told", async () => {
  const weekAway = new Date(NOW.getTime() + 7 * DAY);
  const { running } = await startLimitedRun((project) => limitedFor(project, 1, weekAway));
  await waitingQueue(running);

  // A weekly limit the user knows better about than the Run did. The clock is
  // never moved: the control is the whole of what puts the run back to work.
  const resumed = await control(running, "/api/queue/resume");
  expect(resumed.resumeAt).toBeNull();

  const finished = await waitForQueue(running, (queue) => queue.state === "completed");
  expect(stateOf(finished, "01-boot-the-app")).toBe("succeeded");
  expect(finished.error).toBeNull();
});

test("pausing a waiting run ends the wait, and the limit lifting does not undo it", async () => {
  const { running, runner, clock } = await startLimitedRun((project) =>
    limitedFor(project, 1, RESET_AT),
  );
  await waitingQueue(running);

  // Nothing is being attempted, so there is no ticket boundary left to reach:
  // what the user asks for during a wait happens on the spot.
  const paused = await control(running, "/api/queue/pause");
  expect(paused.state).toBe("paused");
  expect(paused.instruction).toBeNull();
  expect(paused.resumeAt).toBeNull();

  clock.advance(7 * DAY);
  await settle();

  const still = await waitForQueue(running, () => true);
  expect(still.state).toBe("paused");
  // The limit lifting is not permission to overrule the user.
  expect(runner.order).toEqual(["01-boot-the-app"]);

  // And the run is still there to be picked up, from the ticket the limit took.
  await control(running, "/api/queue/resume");
  const finished = await waitForQueue(running, (queue) => queue.state === "completed");
  expect(stateOf(finished, "01-boot-the-app")).toBe("succeeded");
});

test("stopping a waiting run ends it, wait and all", async () => {
  const { running, runner, clock } = await startLimitedRun((project) =>
    limitedFor(project, 1, RESET_AT),
  );
  await waitingQueue(running);

  const stopped = await control(running, "/api/queue/stop");
  expect(stopped.state).toBe("stopped");
  expect(stopped.resumeAt).toBeNull();

  clock.advance(7 * DAY);
  await settle();

  expect((await waitForQueue(running, () => true)).state).toBe("stopped");
  expect(runner.order).toEqual(["01-boot-the-app"]);
});

test("the interrupted Attempt's log is kept, marked as the limit rather than a failure", async () => {
  const { running } = await startLimitedRun((project) => stoppedByTheLimit(project, RESET_AT));
  await waitingQueue(running);

  const attempts = await readAttempts(running, "01-boot-the-app");
  expect(attempts).toHaveLength(1);
  expect(attempts[0]?.outcome).toBe("limit-hit");
  // The reset threw the working tree away; the log is what is left of the Attempt.
  expect(attempts[0]?.output).toContain("the quota ran out");
});
