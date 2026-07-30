import { afterEach, expect, test } from "vitest";

import { CONFIG_FILENAME } from "../src/config-file.js";
import { instanceWith } from "./helpers/config-file.js";
import { createTestProject, type TestProject } from "./helpers/project.js";
import { readQueue, stateOf, waitForQueue } from "./helpers/queue.js";
import { commitsWork, fakeRunner, type FakeRunner } from "./helpers/runner.js";
import { startTestSupervisor, type TestSupervisor } from "./helpers/supervisor.js";
import { removeTempDirectories } from "./helpers/temp-dir.js";
import { createTicketDirectory, ticketFile } from "./helpers/ticket-files.js";

let supervisor: TestSupervisor | undefined;

afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  await removeTempDirectories();
});

/** The settings an instance minding one project would be given. */
function settingsFor(project: TestProject): unknown {
  return {
    source: { type: "local", directory: project.ticketsDirectory },
    project: { directory: project.directory, verify: ["exit 0"] },
  };
}

function post(running: TestSupervisor, path: string, body: unknown): Promise<Response> {
  return running.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function twoTicketProject(): Promise<TestProject> {
  return createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
    "02-add-search.md": ticketFile({ title: "02 — Add search", blockedBy: "01" }),
  });
}

test("an instance told about its project runs the queue with nothing but a start", async () => {
  const project = await twoTicketProject();
  supervisor = await startTestSupervisor({
    runner: fakeRunner(commitsWork(project)),
    configDirectory: await instanceWith(settingsFor(project)),
  });

  // Everything the run needs was settled once, in the file; starting says nothing.
  const started = await post(supervisor, "/api/queue/start", {});
  expect(started.status).toBe(202);

  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");
  expect(finished.tickets.map((ticket) => ticket.state)).toEqual(["succeeded", "succeeded"]);
  expect(await project.read("tickets/01-boot-the-app.md")).toContain("**Status:** done");
});

test("what a start request names wins over the file, and only for that run", async () => {
  const project = await twoTicketProject();
  const elsewhere = await createTicketDirectory({
    "09-one-off.md": ticketFile({ title: "09 — One off" }),
  });
  const runner: FakeRunner = fakeRunner(commitsWork(project));
  supervisor = await startTestSupervisor({
    runner,
    configDirectory: await instanceWith(settingsFor(project)),
  });

  const overridden = await post(supervisor, "/api/queue/start", {
    source: { type: "local", directory: elsewhere },
  });
  expect(overridden.status).toBe(202);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");
  expect(runner.order).toEqual(["09-one-off"]);

  // The file was overridden for that run, not amended: the next start is back to
  // the source the instance was configured with.
  const second = await post(supervisor, "/api/queue/start", {});
  expect(second.status).toBe(202);
  await waitForQueue(
    supervisor,
    (queue) => queue.state === "completed" && stateOf(queue, "02-add-search") === "succeeded",
  );
  expect(runner.order).toEqual(["09-one-off", "01-boot-the-app", "02-add-search"]);
});

test("verification can be settled in the file and sharpened for one run", async () => {
  const project = await twoTicketProject();
  supervisor = await startTestSupervisor({
    runner: fakeRunner(commitsWork(project)),
    configDirectory: await instanceWith(settingsFor(project)),
  });

  // The file's `exit 0` would have passed; this run demands more and is refused.
  await post(supervisor, "/api/queue/start", { project: { verify: ["exit 3"] } });
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(stateOf(finished, "01-boot-the-app")).toBe("failed");
});

test("the preview shows the configured source when the request does not name one", async () => {
  const project = await twoTicketProject();
  supervisor = await startTestSupervisor({
    configDirectory: await instanceWith(settingsFor(project)),
  });

  const response = await post(supervisor, "/api/queue/preview", {});

  expect(response.status).toBe(200);
  const preview = (await response.json()) as { tickets: { id: string }[] };
  expect(preview.tickets.map((ticket) => ticket.id)).toEqual(["01-boot-the-app", "02-add-search"]);
});

test("an instance that was told nothing says how it could have been", async () => {
  supervisor = await startTestSupervisor();

  const response = await post(supervisor, "/api/queue/start", {});

  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: string };
  expect(body.error).toContain(CONFIG_FILENAME);
  expect((await readQueue(supervisor)).state).toBe("idle");
});

test("a half-written source is a mistake, not a request for the configured one", async () => {
  const project = await twoTicketProject();
  supervisor = await startTestSupervisor({
    runner: fakeRunner(commitsWork(project)),
    configDirectory: await instanceWith(settingsFor(project)),
  });

  // A request that reaches for the source at all has to say which one it means:
  // running the configured tickets here would be running work nobody asked for.
  const nameless = await post(supervisor, "/api/queue/start", { source: { type: "local" } });
  expect(nameless.status).toBe(400);

  const misshapen = await post(supervisor, "/api/queue/start", { project: "npm test" });
  expect(misshapen.status).toBe(400);

  expect((await readQueue(supervisor)).state).toBe("idle");
});

test("a configured source with no project still needs the project from the request", async () => {
  const project = await twoTicketProject();
  supervisor = await startTestSupervisor({
    runner: fakeRunner(commitsWork(project)),
    configDirectory: await instanceWith({
      source: { type: "local", directory: project.ticketsDirectory },
    }),
  });

  const refused = await post(supervisor, "/api/queue/start", {});
  expect(refused.status).toBe(400);

  const started = await post(supervisor, "/api/queue/start", {
    project: { directory: project.directory, verify: ["exit 0"] },
  });
  expect(started.status).toBe(202);
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");
  expect(stateOf(finished, "01-boot-the-app")).toBe("succeeded");
});
