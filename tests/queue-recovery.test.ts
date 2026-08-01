import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import type { GhCommand } from "../src/tickets/gh.js";
import { HOUR, testClock, type TestClock } from "./helpers/clock.js";
import { fakeGitHub } from "./helpers/gh.js";
import { fakeNotifier, type FakeNotifier } from "./helpers/notifier.js";
import { createTestProject } from "./helpers/project.js";
import {
  control,
  createGate,
  readAttempts,
  settle,
  startRun,
  startRunWith,
  stateOf,
  ticketControl,
  ticketOf,
  waitForQueue,
} from "./helpers/queue.js";
import {
  BROKEN_OUTPUT,
  commitsWork,
  fakeRunner,
  leavesBrokenWork,
  limitedFor,
  succeedsOnly,
  type FakeRunner,
  type FakeRunnerBehaviour,
} from "./helpers/runner.js";
import { startTestSupervisor, type TestSupervisor } from "./helpers/supervisor.js";
import { createTempDirectory, removeTempDirectories } from "./helpers/temp-dir.js";
import { ticketFile } from "./helpers/ticket-files.js";

/** Every Supervisor a test booted and has not killed, newest last. */
let running: TestSupervisor[] = [];

afterEach(async () => {
  for (const supervisor of running) await supervisor.stop();
  running = [];
  await removeTempDirectories();
});

/** One in the morning: the Supervisor going down is nobody's fault and nobody is up. */
const NOW = new Date("2026-07-31T01:00:00.000Z");
/** A five-hour window, lifting well after the restart. */
const RESET_AT = new Date("2026-07-31T05:30:00.000Z");

const TWO_TICKETS = {
  "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
  "02-add-search.md": ticketFile({ title: "02 — Add search" }),
};

interface Booted {
  supervisor: TestSupervisor;
  runner: FakeRunner;
  /** Takes this Supervisor down, and only this one. */
  kill: () => Promise<void>;
}

interface Booting {
  /** Time the test moves by hand, where the night has an hour to wait for. */
  clock?: TestClock;
  /** Where what would have reached a phone is read instead. */
  told?: FakeNotifier;
  /** A `gh` of the test's own, for a queue whose tickets are GitHub issues. */
  gh?: GhCommand;
}

/**
 * Boots a Supervisor onto a data directory, real SQLite and all. A test that
 * restarts calls this twice with the same directory — the second boot is the one
 * that has to work out what the first was in the middle of.
 */
async function boot(
  dataDir: string,
  behave: FakeRunnerBehaviour,
  { clock, told, gh }: Booting = {},
): Promise<Booted> {
  const runner = fakeRunner(behave);
  const supervisor = await startTestSupervisor({
    dataDir,
    runner,
    ...(clock === undefined ? {} : { clock }),
    ...(told === undefined ? {} : { notifier: told.notifier }),
    ...(gh === undefined ? {} : { gh }),
  });
  running.push(supervisor);

  return {
    supervisor,
    runner,
    kill: async () => {
      running = running.filter((booted) => booted !== supervisor);
      await supervisor.stop();
    },
  };
}

/** A data directory of its own, so a restart has somewhere to have been. */
function dataDirectory(): Promise<string> {
  return createTempDirectory("supervisor-restart-");
}

interface Interrupted {
  behave: FakeRunnerBehaviour;
  /** Settles once the Run has done its damage and the Supervisor is ready to be killed. */
  reached: Promise<void>;
}

/**
 * A Runner that does the ticket named and then never answers at all — the
 * Supervisor going down mid-Attempt, with the Run it was driving going with it.
 * The Attempt is never settled either way, which is exactly what a kill leaves
 * behind, and the moment it hangs is the moment the test kills the Supervisor.
 */
function hangsOn(hanging: string, before: FakeRunnerBehaviour): Interrupted {
  const arrived = createGate();
  const held = createGate();

  return {
    reached: arrived.opened,
    behave: async (request) => {
      const outcome = await before(request);
      if (request.ticket.id !== hanging) return outcome;
      arrived.open();
      await held.opened;
      return outcome;
    },
  };
}

test("a restart picks the night up, and does not run a finished ticket twice", async () => {
  const dataDir = await dataDirectory();
  const project = await createTestProject(TWO_TICKETS);

  const cutOff = hangsOn("02-add-search", commitsWork(project));
  const first = await boot(dataDir, cutOff.behave);
  await startRun(first.supervisor, project);
  // The first ticket is finished and its Checkpoint made; the second is the one
  // the Supervisor is in the middle of when it goes down.
  await cutOff.reached;
  const interrupted = await waitForQueue(
    first.supervisor,
    (queue) => stateOf(queue, "02-add-search") === "running",
  );
  expect(stateOf(interrupted, "01-boot-the-app")).toBe("succeeded");
  const checkpoint = ticketOf(interrupted, "01-boot-the-app")?.checkpoint;
  await first.kill();

  const second = await boot(dataDir, commitsWork(project));
  const finished = await waitForQueue(second.supervisor, (queue) => queue.state === "completed");

  // The same run, carried on rather than started over: the branch is the one the
  // night began on and the first ticket's Checkpoint is the one it already had.
  expect(finished.id).toBe(interrupted.id);
  expect(finished.branch).toBe(interrupted.branch);
  expect(ticketOf(finished, "01-boot-the-app")?.checkpoint).toBe(checkpoint);
  expect(stateOf(finished, "02-add-search")).toBe("succeeded");
  // And the ticket that was already done is not asked for again: a night's quota
  // spent doing yesterday's work twice is the whole thing this has to avoid.
  expect(second.runner.order).toEqual(["02-add-search"]);
});

test("an Attempt cut off by a restart is cleaned away and costs nothing", async () => {
  const dataDir = await dataDirectory();
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
  });

  // Half-written work, a commit of its own, and then the lights go out.
  const cutOff = hangsOn("01-boot-the-app", leavesBrokenWork(project));
  const first = await boot(dataDir, cutOff.behave);
  await startRun(first.supervisor, project);
  await cutOff.reached;
  await first.kill();

  const second = await boot(dataDir, commitsWork(project));
  const finished = await waitForQueue(second.supervisor, (queue) => queue.state === "completed");

  expect(stateOf(finished, "01-boot-the-app")).toBe("succeeded");
  // The dead Attempt's residue is gone — the commit it made and the files it left
  // — exactly as a refused Attempt's would be.
  expect(existsSync(join(project.directory, "01-boot-the-app-half.txt"))).toBe(false);
  expect(existsSync(join(project.directory, "01-boot-the-app-scratch.txt"))).toBe(false);
  expect(await project.commitSubjects()).not.toContain("Broken work for 01-boot-the-app");

  // And it is not held against the ticket: the only Attempt on file is the one
  // that ran its course, so the budget was never spent on a Run nobody saw end.
  const attempts = await readAttempts(second.supervisor, "01-boot-the-app");
  expect(attempts).toHaveLength(1);
  expect(attempts[0]?.outcome).toBe("succeeded");
});

test("the Attempts from before the restart are still there to read", async () => {
  const dataDir = await dataDirectory();
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
  });

  const first = await boot(dataDir, leavesBrokenWork(project));
  await startRun(first.supervisor, project);
  const ended = await waitForQueue(first.supervisor, (queue) => queue.state === "completed");
  expect(stateOf(ended, "01-boot-the-app")).toBe("failed");
  await first.kill();

  const second = await boot(dataDir, commitsWork(project));
  await settle();

  // The night is over, and a Supervisor started again says so rather than
  // reporting an idle queue nobody would think to ask about.
  const queue = await waitForQueue(second.supervisor, () => true);
  expect(queue.state).toBe("completed");
  expect(queue.id).toBe(ended.id);
  expect(stateOf(queue, "01-boot-the-app")).toBe("failed");
  // Nothing is picked up: a run that ended is not a run to carry on with.
  expect(second.runner.order).toEqual([]);

  // And the morning can still read what went wrong, log and all.
  const attempts = await readAttempts(second.supervisor, "01-boot-the-app");
  expect(attempts).toHaveLength(2);
  expect(attempts[0]?.output).toContain(BROKEN_OUTPUT);
});

test("a ticket that failed before the restart can still be given another go", async () => {
  const dataDir = await dataDirectory();
  const project = await createTestProject(TWO_TICKETS);

  const first = await boot(dataDir, succeedsOnly(project, "02-add-search"));
  await startRun(first.supervisor, project);
  await waitForQueue(first.supervisor, (queue) => queue.state === "completed");
  await first.kill();

  // The morning finds the failure, fixes whatever it was, and hands the ticket
  // back — which is the same thing it was before the restart, and has to be.
  const second = await boot(dataDir, commitsWork(project));
  await control(second.supervisor, ticketControl("01-boot-the-app", "retry"));

  const finished = await waitForQueue(second.supervisor, (queue) => queue.state === "completed");
  expect(stateOf(finished, "01-boot-the-app")).toBe("succeeded");
  expect(second.runner.order).toEqual(["01-boot-the-app"]);
  expect(await project.read("tickets/01-boot-the-app.md")).toContain("**Status:** done");
});

test("a restart in a usage-limit wait goes back to waiting, not back to work", async () => {
  const dataDir = await dataDirectory();
  const clock = testClock(NOW);
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
  });

  const first = await boot(dataDir, limitedFor(project, 1, RESET_AT), { clock });
  await startRun(first.supervisor, project);
  const waiting = await waitForQueue(
    first.supervisor,
    (queue) => queue.state === "paused-on-limit" && queue.resumeAt !== null,
  );
  await first.kill();

  const second = await boot(dataDir, commitsWork(project), { clock });
  await settle();

  // The quota is no more back than it was a minute ago. Attempting now would
  // spend the ticket's Attempt on a limit that has not lifted, so the run goes
  // back to waiting for the hour it was already waiting for.
  const still = await waitForQueue(second.supervisor, () => true);
  expect(still.state).toBe("paused-on-limit");
  expect(still.resumeAt).toBe(waiting.resumeAt);
  expect(second.runner.order).toEqual([]);

  // And the hour arriving puts it back to work, restart or no restart.
  clock.advance(5 * HOUR);
  const finished = await waitForQueue(second.supervisor, (queue) => queue.state === "completed");
  expect(stateOf(finished, "01-boot-the-app")).toBe("succeeded");
  expect(second.runner.order).toEqual(["01-boot-the-app"]);
});

test("a run paused before the restart is still paused, and still there to resume", async () => {
  const dataDir = await dataDirectory();
  const project = await createTestProject(TWO_TICKETS);

  // Paused while the first ticket is still being attempted, so the run reaches
  // the boundary and holds there — between tickets, which is where a night spends
  // most of its time being interrupted.
  const first = await boot(dataDir, async (request) => {
    const outcome = await commitsWork(project)(request);
    if (request.ticket.id === "01-boot-the-app") {
      await control(first.supervisor, "/api/queue/pause");
    }
    return outcome;
  });
  await startRun(first.supervisor, project);
  const paused = await waitForQueue(first.supervisor, (queue) => queue.state === "paused");
  await first.kill();

  const second = await boot(dataDir, commitsWork(project));
  await settle();

  // A pause is the user's own decision, and the Supervisor restarting is not them
  // taking it back.
  const held = await waitForQueue(second.supervisor, () => true);
  expect(held.state).toBe("paused");
  expect(stateOf(held, "01-boot-the-app")).toBe("succeeded");
  expect(stateOf(held, "02-add-search")).toBe("pending");
  expect(second.runner.order).toEqual([]);

  await control(second.supervisor, "/api/queue/resume");
  const finished = await waitForQueue(second.supervisor, (queue) => queue.state === "completed");
  expect(stateOf(finished, "02-add-search")).toBe("succeeded");
  expect(finished.id).toBe(paused.id);
});

test("a run armed for later is still armed after a restart", async () => {
  const dataDir = await dataDirectory();
  const clock = testClock(NOW);
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
  });
  const midnight = new Date(NOW.getTime() + 5 * HOUR);

  const first = await boot(dataDir, commitsWork(project), { clock });
  await startRun(first.supervisor, project, { startAt: midnight.toISOString() });
  await waitForQueue(first.supervisor, (queue) => queue.state === "armed");
  await first.kill();

  const second = await boot(dataDir, commitsWork(project), { clock });
  await settle();

  // The hour it was armed for is still the hour, and restarting is not the same
  // as being told to start now.
  const armed = await waitForQueue(second.supervisor, () => true);
  expect(armed.state).toBe("armed");
  expect(armed.resumeAt).toBe(midnight.toISOString());
  expect(second.runner.order).toEqual([]);

  clock.advance(5 * HOUR);
  const finished = await waitForQueue(second.supervisor, (queue) => queue.state === "completed");
  expect(stateOf(finished, "01-boot-the-app")).toBe("succeeded");
});

test("an armed run's evening is left alone, uncommitted work and all", async () => {
  const dataDir = await dataDirectory();
  const clock = testClock(NOW);
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
  });

  const first = await boot(dataDir, commitsWork(project), { clock });
  await startRun(first.supervisor, project, {
    startAt: new Date(NOW.getTime() + 5 * HOUR).toISOString(),
  });
  await waitForQueue(first.supervisor, (queue) => queue.state === "armed");
  await first.kill();

  // An armed run has not begun, so the project is still the user's — and what is
  // in it at eleven at night is theirs, written or not.
  await writeFile(join(project.directory, "half-an-idea.txt"), "not committed yet", "utf8");

  const second = await boot(dataDir, commitsWork(project), { clock });
  await settle();

  expect((await waitForQueue(second.supervisor, () => true)).state).toBe("armed");
  expect(await project.read("half-an-idea.txt")).toBe("not committed yet");
});

test("a run that could not be picked up is not written off", async () => {
  const dataDir = await dataDirectory();
  const told = fakeNotifier();
  const project = await createTestProject(TWO_TICKETS);

  const cutOff = hangsOn("02-add-search", commitsWork(project));
  const first = await boot(dataDir, cutOff.behave);
  await startRun(first.supervisor, project);
  await cutOff.reached;
  await first.kill();

  // Somebody went back to their own work while the Supervisor was down. Picking
  // the run up would mean resetting the branch they are standing on.
  await project.git("checkout", "main");
  const mainHead = await project.head();

  const second = await boot(dataDir, commitsWork(project), { told });
  const broken = await waitForQueue(second.supervisor, (queue) => queue.state === "failed");
  expect(broken.error).toContain("main");
  expect(broken.error).toContain(broken.branch ?? "");
  expect(second.runner.order).toEqual([]);
  // Not a thing was touched: the branch the user is on is exactly where it was.
  expect(await project.head()).toBe(mainHead);
  expect(await project.currentBranch()).toBe("main");
  // And it reaches the phone, because a night that stopped at one in the morning
  // is worth knowing about before the morning.
  expect(told.about("run-broke-down")).toHaveLength(1);
  await second.kill();

  // The run did not fail — this Supervisor could not pick it up, which is a
  // different thing and one the user has just undone. So the night is still there.
  await project.git("checkout", broken.branch ?? "");
  const third = await boot(dataDir, commitsWork(project));

  const finished = await waitForQueue(third.supervisor, (queue) => queue.state === "completed");
  expect(finished.id).toBe(broken.id);
  expect(stateOf(finished, "01-boot-the-app")).toBe("succeeded");
  expect(stateOf(finished, "02-add-search")).toBe("succeeded");
  expect(third.runner.order).toEqual(["02-add-search"]);
});

test("a queue of GitHub issues keeps the tickets the night has already finished", async () => {
  const dataDir = await dataDirectory();
  const project = await createTestProject({});
  const repository = "sela27/AI-supervisor";
  const github = fakeGitHub(repository, [
    { number: 1, title: "Boot the app" },
    { number: 2, title: "Add search", blockedBy: [1] },
  ]);

  // A closed issue is not offered to the Supervisor again, so a queue rebuilt by
  // asking GitHub what it has would be missing every ticket the night finished.
  const cutOff = hangsOn("2", commitsWork(project));
  const first = await boot(dataDir, cutOff.behave, { gh: github.gh });
  await startRunWith(first.supervisor, {
    source: { type: "github", repository },
    project: { directory: project.directory, verify: ["exit 0"], pushCheckpoints: false },
  });
  await cutOff.reached;
  await first.kill();

  const second = await boot(dataDir, commitsWork(project), { gh: github.gh });
  const finished = await waitForQueue(second.supervisor, (queue) => queue.state === "completed");

  expect(stateOf(finished, "1")).toBe("succeeded");
  expect(stateOf(finished, "2")).toBe("succeeded");
  expect(second.runner.order).toEqual(["2"]);
  expect(github.state(1)).toBe("closed");
  expect(github.state(2)).toBe("closed");
});
