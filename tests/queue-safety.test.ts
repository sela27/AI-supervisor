import { afterEach, expect, test } from "vitest";

import { DAY, HOUR, MINUTE, testClock } from "./helpers/clock.js";
import { instanceWith } from "./helpers/config-file.js";
import { createTestProject } from "./helpers/project.js";
import {
  control,
  requestControl,
  requestStart,
  settle,
  startRun,
  stateOf,
  ticketControl,
  waitForQueue,
  type QueueBody,
} from "./helpers/queue.js";
import { commitsWork, fakeRunner, leavesBrokenWork, limitedFor } from "./helpers/runner.js";
import { startTestSupervisor, type TestSupervisor } from "./helpers/supervisor.js";
import { removeTempDirectories } from "./helpers/temp-dir.js";
import { independentTickets } from "./helpers/ticket-files.js";

/**
 * The Safety stops, and the hour a run can be armed for. Both are about a night
 * nobody is watching: how far the Supervisor is allowed to go on its own, and
 * when it is allowed to start. Everything but the clock and the Runner is real.
 */

let supervisor: TestSupervisor | undefined;

afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  await removeTempDirectories();
});

/** Evening, which is when a run gets armed for the night that follows it. */
const NOW = new Date("2026-07-30T21:00:00.000Z");

function at(fromNow: number): string {
  return new Date(NOW.getTime() + fromNow).toISOString();
}

/** The queue once the run has ended, however it ended. */
function endedQueue(running: TestSupervisor): Promise<QueueBody> {
  return waitForQueue(running, (queue) => queue.state !== "running");
}

test("an instance told nothing runs the queue out, however long it takes", async () => {
  const clock = testClock(NOW);
  const project = await createTestProject(independentTickets(4));
  const works = commitsWork(project);
  // Four hours of work, which no default is going to object to: an unconfigured
  // Supervisor caps neither how many tickets a run has nor how long it may take.
  const runner = fakeRunner(async (request) => {
    const outcome = await works(request);
    clock.advance(HOUR);
    return outcome;
  });
  supervisor = await startTestSupervisor({ runner, clock });

  await startRun(supervisor, project);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(finished.stoppedBy).toBeNull();
  expect(runner.order).toHaveLength(4);
  expect(stateOf(finished, "04-ticket")).toBe("succeeded");
});

test("a run stops once it has run as many tickets as it was allowed", async () => {
  const project = await createTestProject(independentTickets(4));
  const runner = fakeRunner(commitsWork(project));
  supervisor = await startTestSupervisor({
    configDirectory: await instanceWith({ safety: { maxTickets: 2 } }),
    runner,
  });

  await startRun(supervisor, project);
  const stopped = await endedQueue(supervisor);

  expect(stopped.state).toBe("stopped");
  expect(stopped.stoppedBy).toBe("this run was allowed 2 tickets, and it has run them");
  expect(runner.order).toEqual(["01-ticket", "02-ticket"]);
  // Everything it did stands; what it never reached is left waiting and unblamed,
  // for a run tomorrow to have.
  expect(stateOf(stopped, "02-ticket")).toBe("succeeded");
  expect(stateOf(stopped, "03-ticket")).toBe("pending");
  expect(stopped.error).toBeNull();
});

test("three tickets failing one after another is a night nobody should pay for", async () => {
  const project = await createTestProject(independentTickets(4));
  // Nothing configured: the failure stop is the one that is on to begin with.
  supervisor = await startTestSupervisor({ runner: fakeRunner(leavesBrokenWork(project)) });

  await startRun(supervisor, project);
  const stopped = await endedQueue(supervisor);

  expect(stopped.state).toBe("stopped");
  expect(stopped.stoppedBy).toContain("3 tickets failed one after another");
  // A project this broken breaks the fourth ticket too, and the whole of tomorrow's
  // quota after it. The ticket is left pending rather than blamed for the night.
  expect(stateOf(stopped, "03-ticket")).toBe("failed");
  expect(stateOf(stopped, "04-ticket")).toBe("pending");
});

test("the count of failures in a row starts again at every ticket that works", async () => {
  const project = await createTestProject(independentTickets(5));
  const works = commitsWork(project);
  const breaks = leavesBrokenWork(project);
  supervisor = await startTestSupervisor({
    runner: fakeRunner((request) =>
      request.ticket.id === "03-ticket" ? works(request) : breaks(request),
    ),
  });

  await startRun(supervisor, project);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // Two failed, one worked, two failed: five tickets and never three in a row, so
  // the night was never the systematically broken one the stop is there for.
  expect(finished.stoppedBy).toBeNull();
  expect(stateOf(finished, "05-ticket")).toBe("failed");
});

test("an instance that switched the failure stop off runs the queue out anyway", async () => {
  const project = await createTestProject(independentTickets(4));
  supervisor = await startTestSupervisor({
    configDirectory: await instanceWith({ safety: { consecutiveFailures: null } }),
    runner: fakeRunner(leavesBrokenWork(project)),
  });

  await startRun(supervisor, project);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(finished.stoppedBy).toBeNull();
  expect(stateOf(finished, "04-ticket")).toBe("failed");
});

test("a run stops once it has been going for as long as it was allowed", async () => {
  const clock = testClock(NOW);
  const project = await createTestProject(independentTickets(4));
  const works = commitsWork(project);
  // Forty minutes a ticket, as a real one might take.
  const runner = fakeRunner(async (request) => {
    const outcome = await works(request);
    clock.advance(40 * MINUTE);
    return outcome;
  });
  supervisor = await startTestSupervisor({
    configDirectory: await instanceWith({ safety: { maxRuntimeMinutes: 60 } }),
    runner,
    clock,
  });

  await startRun(supervisor, project);
  const stopped = await endedQueue(supervisor);

  expect(stopped.state).toBe("stopped");
  expect(stopped.stoppedBy).toBe("this run was allowed 1 hour, and it is up");
  // The ticket under way when the hour passed is never cut off half-way — the
  // hour is read at the boundary, like everything else that ends a run.
  expect(runner.order).toEqual(["01-ticket", "02-ticket"]);
  expect(stateOf(stopped, "02-ticket")).toBe("succeeded");
});

test("a run's time running out is what ends a limit wait it would never outlast", async () => {
  const clock = testClock(NOW);
  const project = await createTestProject(independentTickets(2));
  const weekAway = new Date(NOW.getTime() + 7 * DAY);
  const runner = fakeRunner(limitedFor(project, 1, weekAway));
  supervisor = await startTestSupervisor({
    configDirectory: await instanceWith({ safety: { maxRuntimeMinutes: 120 } }),
    runner,
    clock,
  });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "paused-on-limit");

  // The quota is a week away and the run was given two hours. Sleeping until
  // Thursday would be the run waiting out a night that was over at eleven.
  clock.advance(3 * HOUR);
  const stopped = await waitForQueue(supervisor, (queue) => queue.state === "stopped");

  expect(stopped.stoppedBy).toBe("this run was allowed 2 hours, and it is up");
  expect(stopped.resumeAt).toBeNull();
  expect(runner.order).toEqual(["01-ticket"]);
});

test("an armed run waits for its hour without touching a thing", async () => {
  const clock = testClock(NOW);
  const project = await createTestProject(independentTickets(1));
  const runner = fakeRunner(commitsWork(project));
  supervisor = await startTestSupervisor({ runner, clock });

  const armed = await startRun(supervisor, project, { startAt: at(2 * HOUR) });

  // Its branch and its Queue are settled already — arming is a run that has been
  // started, not one that has been written down. The hour is all that is left.
  expect(armed.state).toBe("armed");
  expect(armed.resumeAt).toBe(at(2 * HOUR));
  expect(armed.branch).not.toBeNull();
  expect(stateOf(armed, "01-ticket")).toBe("pending");
  await settle();
  expect(runner.order).toEqual([]);

  clock.advance(2 * HOUR);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");
  expect(stateOf(finished, "01-ticket")).toBe("succeeded");
  expect(finished.resumeAt).toBeNull();
});

test("an armed run is a run: nothing else may be started over it", async () => {
  const project = await createTestProject(independentTickets(1));
  supervisor = await startTestSupervisor({
    runner: fakeRunner(commitsWork(project)),
    clock: testClock(NOW),
  });
  await startRun(supervisor, project, { startAt: at(2 * HOUR) });

  const second = await requestStart(supervisor, project);

  // Starting over it would take the branch out from under a night that is about
  // to begin on it.
  expect(second.status).toBe(409);
});

test("an hour that has already gone by is a run that starts now", async () => {
  const project = await createTestProject(independentTickets(1));
  supervisor = await startTestSupervisor({
    runner: fakeRunner(commitsWork(project)),
    clock: testClock(NOW),
  });

  // The clock is never moved: an hour in the past is no wait at all, which beats
  // refusing a request that is only a minute late.
  await startRun(supervisor, project, { startAt: at(-HOUR) });
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(stateOf(finished, "01-ticket")).toBe("succeeded");
});

test("an armed run can be started early, without waiting for its hour", async () => {
  const project = await createTestProject(independentTickets(1));
  supervisor = await startTestSupervisor({
    runner: fakeRunner(commitsWork(project)),
    clock: testClock(NOW),
  });
  await startRun(supervisor, project, { startAt: at(7 * DAY) });

  // Nothing is under way, so there is no ticket boundary to reach: the control
  // is the whole of what puts the run to work, and the clock never moves.
  const started = await control(supervisor, "/api/queue/resume");
  expect(started.resumeAt).toBeNull();

  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");
  expect(stateOf(finished, "01-ticket")).toBe("succeeded");
});

test("an armed run can be called off before it has run a thing", async () => {
  const clock = testClock(NOW);
  const project = await createTestProject(independentTickets(1));
  const runner = fakeRunner(commitsWork(project));
  supervisor = await startTestSupervisor({ runner, clock });
  await startRun(supervisor, project, { startAt: at(2 * HOUR) });

  const stopped = await control(supervisor, "/api/queue/stop");
  expect(stopped.state).toBe("stopped");
  expect(stopped.resumeAt).toBeNull();

  // And the hour arriving is not permission to overrule the user.
  clock.advance(DAY);
  await settle();
  expect((await waitForQueue(supervisor, () => true)).state).toBe("stopped");
  expect(runner.order).toEqual([]);
});

test("the hours a run spent armed are not hours it spent running", async () => {
  const clock = testClock(NOW);
  const project = await createTestProject(independentTickets(2));
  supervisor = await startTestSupervisor({
    configDirectory: await instanceWith({ safety: { maxRuntimeMinutes: 60 } }),
    runner: fakeRunner(commitsWork(project)),
    clock,
  });

  // Armed in the evening for five hours' time — which would spend an hour's
  // allowance four times over if waiting counted as running.
  await startRun(supervisor, project, { startAt: at(5 * HOUR) });
  clock.advance(5 * HOUR);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(finished.stoppedBy).toBeNull();
  expect(stateOf(finished, "02-ticket")).toBe("succeeded");
});

test("an hour written as something other than a time is refused on the spot", async () => {
  const project = await createTestProject(independentTickets(1));
  supervisor = await startTestSupervisor({ runner: fakeRunner() });

  const response = await requestStart(supervisor, project, { startAt: "tonight" });

  // A run armed for an hour nobody can read is a run that never happens, and
  // finding that out in the morning is finding it out too late.
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: string }).error).toContain("startAt");
});

test("a run a stop ended is over, and nothing picks it up again", async () => {
  const project = await createTestProject(independentTickets(3));
  const running = await startTestSupervisor({
    configDirectory: await instanceWith({ safety: { maxTickets: 1 } }),
    // The one ticket it is allowed fails, so there is something to ask for again.
    runner: fakeRunner(leavesBrokenWork(project)),
  });
  supervisor = running;

  await startRun(running, project);
  const stopped = await endedQueue(running);
  expect(stopped.state).toBe("stopped");
  expect(stateOf(stopped, "01-ticket")).toBe("failed");

  // The same as the user's own stop, because it is the user's own stop — given in
  // advance rather than at the moment it lands. Neither picking the run up nor
  // asking one ticket for another go is a thing a stopped run does.
  const resumed = await requestControl(running, "/api/queue/resume");
  expect(resumed.status).toBe(409);

  const again = await requestControl(running, ticketControl("01-ticket", "retry"));
  expect(again.status).toBe(409);
});
