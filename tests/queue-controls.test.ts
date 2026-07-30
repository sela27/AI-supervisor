import { afterEach, expect, test } from "vitest";

import { openEventStream } from "./helpers/events.js";
import { createTestProject, type TestProject } from "./helpers/project.js";
import {
  control,
  createGate,
  requestControl,
  requestStart,
  startRun,
  stateOf,
  ticketControl,
  ticketOf,
  waitForQueue,
  type Gate,
  type QueueBody,
} from "./helpers/queue.js";
import {
  commitsWork,
  fakeRunner,
  leavesBrokenWork,
  stoppedByTheLimit,
  type FakeRunner,
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
const SEARCH = "02-add-search";
const DOCS = "03-write-docs";

/** Two independent tickets, so taking one out never explains the other's fate. */
function twoTickets(): Record<string, string> {
  return {
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
    "03-write-docs.md": ticketFile({ title: "03 — Write docs" }),
  };
}

/**
 * A run held inside its first Attempt: every control worth testing is one given
 * while a ticket is under way, and this is what makes that moment last.
 */
async function runHeldOnTheFirstTicket(
  tickets: Record<string, string> = twoTickets(),
): Promise<{ running: TestSupervisor; project: TestProject; runner: FakeRunner; gate: Gate }> {
  const project = await createTestProject(tickets);
  const gate = createGate();
  const work = commitsWork(project);
  const runner = fakeRunner(async (request) => {
    if (request.ticket.id === BOOT) await gate.opened;
    await work(request);
  });

  const running = await startTestSupervisor({ runner });
  supervisor = running;
  await startRun(running, project);
  await waitForQueue(running, (queue) => stateOf(queue, BOOT) === "running");

  return { running, project, runner, gate };
}

test("a run pauses at the next ticket boundary, and resumes where it left off", async () => {
  const { running, runner, gate } = await runHeldOnTheFirstTicket();

  const asked = await control(running, "/api/queue/pause");
  // The ticket under way is not interrupted, so until it ends the run is still
  // running — and says out loud what it is on its way to doing.
  expect(asked.state).toBe("running");
  expect(asked.instruction).toBe("pause");

  gate.open();
  const paused = await waitForQueue(running, (queue) => queue.state === "paused");

  expect(stateOf(paused, BOOT)).toBe("succeeded");
  expect(stateOf(paused, DOCS)).toBe("pending");
  // The instruction has been carried out, so there is nothing outstanding left.
  expect(paused.instruction).toBeNull();
  expect(runner.order).toEqual([BOOT]);

  await control(running, "/api/queue/resume");
  const finished = await waitForQueue(running, (queue) => queue.state === "completed");

  // Where it left off, not where it started: the finished ticket is not run again.
  expect(stateOf(finished, DOCS)).toBe("succeeded");
  expect(runner.order).toEqual([BOOT, DOCS]);
});

test("changing one's mind about a pause before it lands lets the run carry on", async () => {
  const { running, runner, gate } = await runHeldOnTheFirstTicket();

  await control(running, "/api/queue/pause");
  const carrying = await control(running, "/api/queue/resume");

  // Resuming a run that never got as far as pausing is taking the instruction back.
  expect(carrying.state).toBe("running");
  expect(carrying.instruction).toBeNull();

  gate.open();
  const finished = await waitForQueue(running, (queue) => queue.state === "completed");
  expect(runner.order).toEqual([BOOT, DOCS]);
  expect(stateOf(finished, DOCS)).toBe("succeeded");
});

test("stopping a run ends it, and everything it finished still stands", async () => {
  const { running, project, runner, gate } = await runHeldOnTheFirstTicket();

  const asked = await control(running, "/api/queue/stop");
  expect(asked.instruction).toBe("stop");

  gate.open();
  const stopped = await waitForQueue(running, (queue) => queue.state === "stopped");

  // A stopped run is an accurate one: what succeeded is recorded as succeeded,
  // what was never reached is still waiting, and nothing is a failure.
  expect(stateOf(stopped, BOOT)).toBe("succeeded");
  expect(ticketOf(stopped, BOOT)?.checkpoint).toMatch(/^[0-9a-f]{40}$/);
  expect(stateOf(stopped, DOCS)).toBe("pending");
  expect(stopped.error).toBeNull();
  expect(runner.order).toEqual([BOOT]);

  // And the branch is left in a state a person can pick up: the Checkpoint is on
  // it, with nothing uncommitted around it.
  expect(await project.commitSubjects()).toContain("Checkpoint: Boot the app");
  expect(await project.git("status", "--porcelain")).toBe("");
});

test("retrying a failed ticket runs it again, and the tickets it doomed come back with it", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
    "02-add-search.md": ticketFile({ title: "02 — Add search", blockedBy: "01" }),
  });
  const breaks = leavesBrokenWork(project);
  const work = commitsWork(project);
  // Both of the first ticket's Attempts are refused; whatever comes after the
  // budget is spent is the retry the user asked for.
  let spent = 0;
  const runner = fakeRunner(async (request) => {
    if (request.ticket.id !== BOOT) return work(request);
    spent += 1;
    return spent > 2 ? work(request) : breaks(request);
  });
  supervisor = await startTestSupervisor({ runner });

  await startRun(supervisor, project);
  const failed = await waitForQueue(supervisor, (queue) => queue.state === "completed");
  expect(stateOf(failed, BOOT)).toBe("failed");
  expect(stateOf(failed, SEARCH)).toBe("skipped");

  const retrying = await control(supervisor, ticketControl(BOOT, "retry"));
  // Asking for a ticket to be run again is asking the run to run it, so a run
  // that had finished is back at work.
  expect(retrying.state).toBe("running");
  expect(stateOf(retrying, BOOT)).toBe("pending");
  // Its dependents were only skipped because it failed, so they are owed a go too.
  expect(stateOf(retrying, SEARCH)).toBe("pending");
  expect(ticketOf(retrying, SEARCH)?.failure).toBeNull();

  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");
  expect(stateOf(finished, BOOT)).toBe("succeeded");
  expect(stateOf(finished, SEARCH)).toBe("succeeded");
  expect(runner.order).toEqual([BOOT, BOOT, BOOT, SEARCH]);

  // The failure written back to the ticket was an account of a ticket that has
  // since succeeded; leaving it there would be a lie the morning reads.
  const file = await project.read(`tickets/${BOOT}.md`);
  expect(file).toContain("**Status:** done");
  expect(file).not.toContain("## Supervisor failure");
});

test("skipping a pending ticket takes everything waiting on it out too", async () => {
  const { running, runner, gate } = await runHeldOnTheFirstTicket({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
    "02-add-search.md": ticketFile({ title: "02 — Add search" }),
    "03-write-docs.md": ticketFile({ title: "03 — Write docs", blockedBy: "02" }),
  });

  const skipped = await control(running, ticketControl(SEARCH, "skip"));

  expect(stateOf(skipped, SEARCH)).toBe("skipped");
  expect(ticketOf(skipped, SEARCH)?.failure).toContain("out of the queue");
  // Skipping is transitive whoever does the skipping: nothing waiting on a ticket
  // that will not run can run either.
  expect(stateOf(skipped, DOCS)).toBe("skipped");
  expect(ticketOf(skipped, DOCS)?.failure).toContain(SEARCH);

  gate.open();
  const finished = await waitForQueue(running, (queue) => queue.state === "completed");
  expect(stateOf(finished, BOOT)).toBe("succeeded");
  expect(runner.order).toEqual([BOOT]);
});

test("retrying a ticket does not put back what the user took out by hand", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
    "02-add-search.md": ticketFile({ title: "02 — Add search", blockedBy: "01" }),
    "03-write-docs.md": ticketFile({ title: "03 — Write docs", blockedBy: "02" }),
  });
  const breaks = leavesBrokenWork(project);
  const work = commitsWork(project);
  const gate = createGate();
  let spent = 0;
  const runner = fakeRunner(async (request) => {
    if (request.ticket.id !== BOOT) return work(request);
    spent += 1;
    if (spent > 2) await gate.opened;
    return spent > 2 ? work(request) : breaks(request);
  });
  supervisor = await startTestSupervisor({ runner });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => stateOf(queue, BOOT) === "running");
  // Taken out before the first ticket has settled, so this is the user's own
  // decision rather than anything that happened to the queue.
  await control(supervisor, ticketControl(SEARCH, "skip"));
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  const retrying = await control(supervisor, ticketControl(BOOT, "retry"));

  // The blocker is being tried again, but the user's decision about the ticket
  // behind it stands — and so does everything that decision took with it.
  expect(stateOf(retrying, BOOT)).toBe("pending");
  expect(stateOf(retrying, SEARCH)).toBe("skipped");
  expect(ticketOf(retrying, SEARCH)?.failure).toContain("out of the queue");
  expect(stateOf(retrying, DOCS)).toBe("skipped");

  gate.open();
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");
  expect(stateOf(finished, BOOT)).toBe("succeeded");
  expect(runner.order).toEqual([BOOT, BOOT, BOOT]);
});

test("a run paused by the usage limit is resumed once the limit has lifted", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
  });
  const work = commitsWork(project);
  const limited = stoppedByTheLimit(project, new Date("2026-07-31T06:30:00.000Z"));
  let spent = 0;
  const runner = fakeRunner(async (request) => {
    spent += 1;
    return spent === 1 ? limited(request) : work(request);
  });
  supervisor = await startTestSupervisor({ runner });

  await startRun(supervisor, project);
  const waiting = await waitForQueue(supervisor, (queue) => queue.state === "paused-on-limit");
  expect(waiting.error).toContain("usage limit");

  const picked = await control(supervisor, "/api/queue/resume");
  // The limit has lifted, so what it said about when it would is no longer
  // something the reader should be looking at.
  expect(picked.state).toBe("running");
  expect(picked.error).toBeNull();

  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");
  expect(stateOf(finished, BOOT)).toBe("succeeded");
  expect(runner.order).toEqual([BOOT, BOOT]);
});

test("a stopped run is over, so nothing picks it up again", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
    "02-add-search.md": ticketFile({ title: "02 — Add search" }),
    "03-write-docs.md": ticketFile({ title: "03 — Write docs" }),
  });
  const gate = createGate();
  const breaks = leavesBrokenWork(project);
  const work = commitsWork(project);
  // The first ticket fails, so the stopped run has something to retry; the second
  // is held, so the stop is given while a ticket is under way and the third is
  // still waiting when the run ends.
  const runner = fakeRunner(async (request) => {
    if (request.ticket.id === BOOT) return breaks(request);
    if (request.ticket.id === SEARCH) await gate.opened;
    await work(request);
  });
  supervisor = await startTestSupervisor({ runner });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => stateOf(queue, SEARCH) === "running");
  await control(supervisor, "/api/queue/stop");
  gate.open();
  const stopped = await waitForQueue(supervisor, (queue) => queue.state === "stopped");
  expect(stateOf(stopped, BOOT)).toBe("failed");
  expect(stateOf(stopped, DOCS)).toBe("pending");

  const refused = await Promise.all(
    ["/api/queue/resume", ticketControl(BOOT, "retry")].map(
      async (path) => (await requestControl(supervisor as TestSupervisor, path)).status,
    ),
  );

  // Retrying a ticket would put the run back to work, and a stopped run is one
  // the user ended: picking it up again is starting a new one.
  expect(refused).toEqual([409, 409]);
  expect((await waitForQueue(supervisor, () => true)).state).toBe("stopped");
  expect(runner.order).toEqual([BOOT, BOOT, SEARCH]);
});

test("a paused run is not quietly started over", async () => {
  const { running, project, gate } = await runHeldOnTheFirstTicket();

  await control(running, "/api/queue/pause");
  gate.open();
  await waitForQueue(running, (queue) => queue.state === "paused");

  const response = await requestStart(running, project);

  // A paused run is a run: starting another would abandon a night's work on a
  // branch nobody was told about.
  expect(response.status).toBe(409);
  expect(((await response.json()) as { error: string }).error).toContain("resume");
  expect((await waitForQueue(running, () => true)).state).toBe("paused");
});

test("a control the run cannot obey is refused, and the run is left alone", async () => {
  const project = await createTestProject(twoTickets());
  supervisor = await startTestSupervisor({ runner: fakeRunner(commitsWork(project)) });
  const running = supervisor;

  // Nothing has ever run, so there is nothing to pause.
  expect((await requestControl(running, "/api/queue/pause")).status).toBe(409);

  await startRun(running, project);
  await waitForQueue(running, (queue) => queue.state === "completed");

  const refused = await Promise.all(
    [
      "/api/queue/pause",
      "/api/queue/resume",
      ticketControl(BOOT, "retry"),
      ticketControl(BOOT, "skip"),
    ].map(async (path) => (await requestControl(running, path)).status),
  );

  // A finished run has nothing to pause or resume, and a ticket that succeeded is
  // neither a failure to retry nor a pending ticket to skip.
  expect(refused).toEqual([409, 409, 409, 409]);
  const untouched = await waitForQueue(running, () => true);
  expect(untouched.state).toBe("completed");
  expect(stateOf(untouched, BOOT)).toBe("succeeded");
});

test("a control naming a ticket the run never had says so", async () => {
  const project = await createTestProject(twoTickets());
  supervisor = await startTestSupervisor({ runner: fakeRunner(commitsWork(project)) });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  const response = await requestControl(supervisor, ticketControl("99-never-written", "retry"));

  expect(response.status).toBe(404);
  expect(((await response.json()) as { error: string }).error).toContain("99-never-written");
});

test("a control given on one dashboard shows up on every other one", async () => {
  const { running, gate } = await runHeldOnTheFirstTicket();

  // The dashboard is one page among however many are open. A control given from
  // the phone has to reach the desk without the desk asking for it.
  const watching = await openEventStream(running);
  await watching.waitFor<QueueBody>("queue", (queue) => queue.instruction === null);

  await control(running, "/api/queue/stop");
  const asked = await watching.waitFor<QueueBody>("queue", (queue) => queue.instruction === "stop");
  expect(asked.state).toBe("running");

  gate.open();
  await watching.waitFor<QueueBody>("queue", (queue) => queue.state === "stopped");
  await watching.close();
});
