import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { instanceWith, reviewingInstance } from "./helpers/config-file.js";
import { createTestProject, type TestProject } from "./helpers/project.js";
import {
  requestPreview,
  runBranch,
  startRun,
  stateOf,
  ticketOf,
  waitForQueue,
} from "./helpers/queue.js";
import { approves, commitsWork, fakeRunner, leavesBrokenWork } from "./helpers/runner.js";
import { startTestSupervisor, type TestSupervisor } from "./helpers/supervisor.js";
import { removeTempDirectories } from "./helpers/temp-dir.js";
import { createTicketDirectory, ticketFile } from "./helpers/ticket-files.js";

let supervisor: TestSupervisor | undefined;

afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  await removeTempDirectories();
});

const BOOT = "01-boot-the-app";
const BOOT_FILE = `tickets/${BOOT}.md`;
const CRITERIA = ["It boots", "It is tested"];

/** One ticket with two criteria — enough for one to be judged and one not. */
async function oneTicketProject(): Promise<TestProject> {
  return createTestProject({
    [`${BOOT}.md`]: ticketFile({ title: "01 — Boot the app", criteria: CRITERIA }),
  });
}

interface PreviewBody {
  tickets: {
    id: string;
    title: string;
    blockedBy: string[];
    acceptanceCriteria: { text: string; done: boolean }[];
  }[];
}

async function previewOf(running: TestSupervisor, directory: string): Promise<PreviewBody> {
  const response = await requestPreview(running, directory);
  expect(response.status).toBe(200);
  return (await response.json()) as PreviewBody;
}

test("a succeeded ticket's file gives the account of the run that settled it", async () => {
  const project = await oneTicketProject();
  supervisor = await startTestSupervisor({ runner: fakeRunner(commitsWork(project)) });

  const started = await startRun(supervisor, project, { verify: ["exit 0", "echo checked"] });
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  const written = await project.read(BOOT_FILE);
  expect(written).toContain("**Status:** done");
  expect(written).toContain("## Supervisor run");
  // Where the work went, and what was run over it before it was allowed to stand.
  expect(written).toContain(`**Checkpoint:** \`${ticketOf(finished, BOOT)?.checkpoint}\``);
  expect(written).toContain(`**Branch:** \`${runBranch(started)}\``);
  expect(written).toContain("`exit 0`");
  expect(written).toContain("`echo checked`");
});

test("a run nobody asked to review judges no criterion, and the ticket says so", async () => {
  const project = await oneTicketProject();
  supervisor = await startTestSupervisor({ runner: fakeRunner(commitsWork(project)) });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // The project's own checks pass or fail over the whole Attempt, so a ticked
  // criterion would be a claim nothing in the night actually made.
  const written = await project.read(BOOT_FILE);
  expect(written).toContain("- [ ] It boots");
  expect(written).toContain("- [ ] It is tested");
  expect(written).toContain("**Review:** not asked for");
});

test("the criteria a review found met come back ticked, and the rest as they were", async () => {
  const project = await oneTicketProject();
  supervisor = await startTestSupervisor({
    runner: fakeRunner(commitsWork(project), approves("It boots, but nothing covers it.", [
      "It boots",
    ])),
    configDirectory: await reviewingInstance(),
  });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  const written = await project.read(BOOT_FILE);
  expect(written).toContain("- [x] It boots");
  // The reviewer said nothing about this one, and a criterion nobody judged is
  // the user's to tick.
  expect(written).toContain("- [ ] It is tested");
  expect(written).toContain("It boots, but nothing covers it.");
});

test("a criterion the review named but the ticket never had ticks nothing", async () => {
  const project = await oneTicketProject();
  supervisor = await startTestSupervisor({
    runner: fakeRunner(commitsWork(project), approves("Good.", ["It is documented"])),
    configDirectory: await reviewingInstance(),
  });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  const written = await project.read(BOOT_FILE);
  expect(written).toContain("- [ ] It boots");
  expect(written).toContain("- [ ] It is tested");
  expect(written).not.toContain("It is documented");
});

test("a second run over the same ticket replaces the account rather than stacking", async () => {
  const project = await oneTicketProject();
  // Work of its own each go: a second Run writing what the first one already
  // committed would have nothing to commit and no Attempt to speak of.
  let gone = 0;
  supervisor = await startTestSupervisor({
    runner: fakeRunner(async (request) => {
      gone += 1;
      await writeFile(join(project.directory, `${request.ticket.id}-${gone}.txt`), "work", "utf8");
      await project.git("add", "-A");
      await project.git("commit", "-m", `Work ${gone} for ${request.ticket.id}`);
    }),
  });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  // What somebody does in the morning to have a ticket run again.
  const reopened = (await project.read(BOOT_FILE)).replace(
    "**Status:** done",
    "**Status:** ready-for-agent",
  );
  await writeFile(join(project.directory, BOOT_FILE), reopened, "utf8");
  await project.git("commit", "-am", "Have another go at booting the app");

  await startRun(supervisor, project);
  await waitForQueue(
    supervisor,
    (queue) => queue.state === "completed" && stateOf(queue, BOOT) === "succeeded",
  );

  const written = await project.read(BOOT_FILE);
  expect(written.split("## Supervisor run")).toHaveLength(2);
  expect(written.split("**Checkpoint:**")).toHaveLength(2);
});

test("nothing the run writes back is mistaken for the ticket's own words", async () => {
  const project = await createTestProject({
    [`${BOOT}.md`]: ticketFile({ title: "01 — Boot the app", criteria: CRITERIA }),
    "02-add-search.md": ticketFile({ title: "02 — Add search", blockedBy: "01" }),
  });
  // A reviewer writes prose, and prose is where a heading, a blocking edge and a
  // checkbox all look exactly like the ticket's own.
  const said = ["# Not a title", "- [ ] not a criterion", "**Blocked by:** 99"].join("\n");
  supervisor = await startTestSupervisor({
    runner: fakeRunner(commitsWork(project), approves(said, ["It boots"])),
    configDirectory: await reviewingInstance(),
  });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  const preview = await previewOf(supervisor, project.ticketsDirectory);
  expect(preview.tickets.map((ticket) => ticket.title)).toEqual(["Boot the app", "Add search"]);
  expect(preview.tickets[1]?.blockedBy).toEqual([BOOT]);
  expect(preview.tickets[0]?.acceptanceCriteria).toEqual([
    { text: "It boots", done: true },
    { text: "It is tested", done: false },
  ]);
});

test("a failed ticket is written back exactly as it always was", async () => {
  const project = await oneTicketProject();
  supervisor = await startTestSupervisor({
    runner: fakeRunner(leavesBrokenWork(project)),
    configDirectory: await instanceWith({ attemptBudget: 1 }),
  });

  await startRun(supervisor, project);
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  const written = await project.read(BOOT_FILE);
  expect(written).toContain("**Status:** failed");
  expect(written).toContain("## Supervisor failure");
  expect(written).toContain("the tests never passed");
  // Nothing succeeded, so there is no run to give an account of.
  expect(written).not.toContain("## Supervisor run");
  expect(written).toContain("- [ ] It boots");
});

test("tickets kept outside the project get the same write-back as tickets inside it", async () => {
  const project = await oneTicketProject();
  const elsewhere = await createTicketDirectory({
    "09-one-off.md": ticketFile({ title: "09 — One off", criteria: CRITERIA }),
  });
  supervisor = await startTestSupervisor({
    runner: fakeRunner(commitsWork(project), approves("Both are covered.", CRITERIA)),
    configDirectory: await reviewingInstance(),
  });

  const started = await startRun(supervisor, project, { source: elsewhere });
  const finished = await waitForQueue(supervisor, (queue) => queue.state === "completed");

  const written = await readFile(join(elsewhere, "09-one-off.md"), "utf8");
  expect(written).toContain("**Status:** done");
  expect(written).toContain(`**Checkpoint:** \`${ticketOf(finished, "09-one-off")?.checkpoint}\``);
  expect(written).toContain(`**Branch:** \`${runBranch(started)}\``);
  expect(written).toContain("- [x] It boots");
  expect(written).toContain("- [x] It is tested");
});
