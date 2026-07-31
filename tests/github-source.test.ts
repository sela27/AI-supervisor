import { afterEach, expect, test } from "vitest";

import { fakeGitHub, type FakeGitHub, type FakeIssue } from "./helpers/gh.js";
import { instanceWith } from "./helpers/config-file.js";
import { createTestProject, type TestProject } from "./helpers/project.js";
import {
  control,
  startRunWith,
  stateOf,
  ticketControl,
  ticketOf,
  waitForQueue,
  type QueueBody,
} from "./helpers/queue.js";
import { commitsWork, fakeRunner, leavesBrokenWork, type FakeRunner } from "./helpers/runner.js";
import { startTestSupervisor, type TestSupervisor } from "./helpers/supervisor.js";
import { removeTempDirectories } from "./helpers/temp-dir.js";
import { ticketFile } from "./helpers/ticket-files.js";

/**
 * A Queue whose tickets are GitHub issues. Everything here is driven through the
 * API, the same as a queue of ticket files; what stands in for GitHub is a `gh`
 * of the test's own, so the outcomes a run writes back are read off the issues
 * afterwards and no live repository is ever touched.
 */

const REPOSITORY = "sela27/AI-supervisor";

let supervisor: TestSupervisor | undefined;

afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  await removeTempDirectories();
});

/** An issue in the shape `/to-tickets` publishes one. */
function issue(number: number, title: string, extras: Partial<FakeIssue> = {}): FakeIssue {
  return {
    number,
    title,
    body: [
      "## What to build",
      "",
      "Something a developer can demo end to end.",
      "",
      "## Acceptance criteria",
      "",
      "- [ ] It works",
      "",
      "## Blocked by",
      "",
      "- None — can start immediately",
    ].join("\n"),
    ...extras,
  };
}

function startBody(project: TestProject): unknown {
  return {
    source: { type: "github", repository: REPOSITORY },
    project: { directory: project.directory, verify: ["exit 0"], pushCheckpoints: false },
  };
}

async function preview(running: TestSupervisor): Promise<{
  tickets: { id: string; title: string; state: string; blockedBy: string[] }[];
  frontier: string[];
}> {
  const response = await running.request("/api/queue/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: { type: "github", repository: REPOSITORY } }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Awaited<ReturnType<typeof preview>>;
}

/** A Supervisor minding a project, with the given issues standing in for GitHub. */
async function superviseIssues(
  issues: FakeIssue[],
  behaviour?: (project: TestProject) => FakeRunner,
): Promise<{ github: FakeGitHub; project: TestProject; running: TestSupervisor }> {
  const github = fakeGitHub(REPOSITORY, issues);
  const project = await createTestProject({});
  const runner = behaviour?.(project) ?? fakeRunner(commitsWork(project));
  const running = await startTestSupervisor({ gh: github.gh, runner });
  supervisor = running;

  return { github, project, running };
}

test("the queue is the repository's ready-for-agent issues, in the order they gate each other", async () => {
  const { running } = await superviseIssues([
    issue(12, "Notifications"),
    issue(11, "GitHub Issues Ticket Source", { blockedBy: [] }),
    issue(20, "Docker image", { labels: ["needs-triage"] }),
  ]);

  const queue = await preview(running);

  // The label is what says a ticket is the Supervisor's to pick up, so the
  // untriaged issue is not in the Queue at all.
  expect(queue.tickets.map((ticket) => ticket.id)).toEqual(["11", "12"]);
  expect(queue.tickets[0]?.title).toBe("GitHub Issues Ticket Source");
  expect(queue.frontier).toEqual(["11", "12"]);
});

test("an issue waits on the issues GitHub says block it, and is off the Frontier until they close", async () => {
  const { running, github } = await superviseIssues([
    issue(11, "GitHub Issues Ticket Source"),
    issue(12, "Notifications", { blockedBy: [11] }),
  ]);

  const blocked = await preview(running);
  expect(blocked.tickets.map((ticket) => ticket.blockedBy)).toEqual([[], ["11"]]);
  expect(blocked.frontier).toEqual(["11"]);

  // Somebody finishes the blocker on GitHub itself, which is where done-ness
  // lives: the next discovery has to agree with them.
  github.close(11);
  const released = await preview(running);

  expect(released.tickets.map((ticket) => ticket.id)).toEqual(["12"]);
  expect(released.tickets[0]?.blockedBy).toEqual([]);
  expect(released.frontier).toEqual(["12"]);
});

test("a blocker succeeding during the run releases what was waiting on it", async () => {
  const { running, project, github } = await superviseIssues([
    issue(11, "Ticket Source"),
    issue(12, "Notifications", { blockedBy: [11] }),
  ]);

  await startRunWith(running, startBody(project));
  const finished = await waitForQueue(running, (queue) => queue.state === "completed");

  // The Frontier of a GitHub queue is the Frontier of any other: the blocked
  // ticket waits, and it waits for exactly as long as its blocker takes.
  expect(finished.tickets.map((ticket) => ticket.state)).toEqual(["succeeded", "succeeded"]);
  expect(github.state(11)).toBe("closed");
  expect(github.state(12)).toBe("closed");
});

test("an issue held up by one the Supervisor may not run is taken out, not left hanging", async () => {
  const { running, project } = await superviseIssues([
    issue(12, "Notifications", { blockedBy: [99] }),
    issue(13, "Timing settings"),
  ]);

  // #99 is open and is not labelled for the Supervisor — a human's to answer. The
  // Queue says so rather than quietly leaving the ticket out, and rather than
  // spending a night's quota on work whose ground has not been laid.
  const queue = await preview(running);
  expect(queue.tickets.map((ticket) => ticket.state)).toEqual(["blocked", "ready"]);
  expect(queue.frontier).toEqual(["13"]);

  const started = await startRunWith(running, startBody(project));
  // Said before a ticket has been attempted: nothing in this queue was ever going
  // to unblock it, so a run that ended saying it was still `pending` would be
  // telling the morning to wait for something that is not coming.
  expect(stateOf(started, "12")).toBe("skipped");

  const finished = await waitForQueue(running, (body) => body.state === "completed");
  expect(stateOf(finished, "13")).toBe("succeeded");
  expect(ticketOf(finished, "12")?.failure).toContain("99");
});

test("the shapes gh really prints are read, whatever else it prints with them", async () => {
  // Trimmed recordings of `gh issue list --json number,title,body` and of
  // `GET /repos/{owner}/{repo}/issues/{n}/dependencies/blocked_by`, keeping the
  // field names verbatim: what this pins is that the Ticket Source reads what the
  // CLI actually answers, and steps over the fields it has no use for.
  const listed = JSON.stringify([
    { body: "## Acceptance criteria\n\n- [ ] It works\n", number: 12, title: "Notifications" },
    { body: "", number: 11, title: "GitHub Issues Ticket Source" },
  ]);
  const blockedBy = JSON.stringify([
    {
      url: "https://api.github.com/repos/sela27/AI-supervisor/issues/11",
      id: 5021947830,
      node_id: "I_kwDOToPdzc8AAAABK1TXtg",
      number: 11,
      title: "GitHub Issues Ticket Source",
      state: "open",
      state_reason: null,
      labels: [{ id: 11677498988, name: "ready-for-agent" }],
      issue_dependencies_summary: { blocked_by: 0, total_blocked_by: 1 },
    },
  ]);

  supervisor = await startTestSupervisor({
    gh: async (args) => {
      if (args[0] === "issue" && args[1] === "list") return listed;
      // Only #12 is blocked; #11 is asked about too, and answers with nothing.
      return args[1]?.includes("/issues/12/") ? blockedBy : "[]";
    },
  });

  const queue = await preview(supervisor);

  expect(queue.tickets.map((ticket) => ticket.id)).toEqual(["11", "12"]);
  expect(queue.tickets[1]?.blockedBy).toEqual(["11"]);
  expect(queue.frontier).toEqual(["11"]);
});

test("a ticket that succeeds is closed on GitHub, with the Checkpoint it ended in", async () => {
  const { running, project, github } = await superviseIssues([issue(11, "Ticket Source")]);

  await startRunWith(running, startBody(project));
  const finished = await waitForQueue(running, (queue) => queue.state === "completed");
  const checkpoint = finished.tickets[0]?.checkpoint;

  expect(stateOf(finished, "11")).toBe("succeeded");
  expect(github.state(11)).toBe("closed");
  // The commit is the whole point of the comment: the morning reads the issue,
  // not the dashboard, and a closed issue that cannot say where its work went is
  // a ticket nobody can check.
  expect(checkpoint).toMatch(/^[0-9a-f]{40}$/);
  expect(github.comments(11).join("\n")).toContain(checkpoint);
});

test("a ticket that runs out of attempts is left open, said so, and handed to a human", async () => {
  const { running, project, github } = await superviseIssues(
    [issue(11, "Ticket Source"), issue(12, "Notifications", { blockedBy: [11] })],
    (project) => fakeRunner(leavesBrokenWork(project)),
  );

  await startRunWith(running, startBody(project));
  const finished = await waitForQueue(running, (queue) => queue.state === "completed");

  expect(stateOf(finished, "11")).toBe("failed");
  // Still open, because it still has to happen; no longer the Supervisor's,
  // because the Supervisor has had its goes at it.
  expect(github.state(11)).toBe("open");
  expect(github.labels(11)).toEqual(["ready-for-human"]);
  expect(github.comments(11).join("\n")).toContain("the tests never passed");

  // And what was waiting on it is skipped, not written back to: nothing was tried.
  expect(stateOf(finished, "12")).toBe("skipped");
  expect(github.labels(12)).toEqual(["ready-for-agent"]);
  expect(github.comments(12)).toEqual([]);
});

test("a ticket given another go is handed back to the Supervisor before it takes it", async () => {
  let spent = 0;
  const { running, project, github } = await superviseIssues([issue(11, "Ticket Source")], (project) => {
    const breaks = leavesBrokenWork(project);
    const works = commitsWork(project);
    return fakeRunner((request) => {
      spent += 1;
      return spent <= 2 ? breaks(request) : works(request);
    });
  });

  await startRunWith(running, startBody(project));
  await waitForQueue(running, (queue) => queue.state === "completed");
  expect(github.labels(11)).toEqual(["ready-for-human"]);

  await control(running, ticketControl("11", "retry"));
  const second = await waitForQueue(running, (queue) => queue.state === "completed");

  // The issue is the Supervisor's again while the Supervisor has it, and an issue
  // that goes on to succeed must not still be flagged for a human to look at.
  expect(stateOf(second, "11")).toBe("succeeded");
  expect(github.labels(11)).toEqual(["ready-for-agent"]);
  expect(github.state(11)).toBe("closed");
});

test("what the issue asks for reaches the Run that has to do it", async () => {
  const github = fakeGitHub(REPOSITORY, [
    {
      number: 11,
      title: "GitHub Issues Ticket Source",
      body: [
        "## Acceptance criteria",
        "",
        "- [ ] Discovery returns open ready-for-agent issues",
        "- [x] A succeeded ticket is closed with a summary comment",
        "",
        "## Blocked by",
        "",
        "- [ ] this is not a criterion, it is a heading down",
      ].join("\n"),
    },
  ]);
  const project = await createTestProject({});
  const runner = fakeRunner(commitsWork(project));
  supervisor = await startTestSupervisor({ gh: github.gh, runner });

  await startRunWith(supervisor, startBody(project));
  await waitForQueue(supervisor, (queue) => queue.state === "completed");

  expect(runner.requests[0]?.ticket.title).toBe("GitHub Issues Ticket Source");
  expect(runner.requests[0]?.ticket.acceptanceCriteria).toEqual([
    { text: "Discovery returns open ready-for-agent issues", done: false },
    { text: "A succeeded ticket is closed with a summary comment", done: true },
  ]);
});

test("which source a run reads is the run's own to say, and is not the next run's", async () => {
  const project = await createTestProject({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
  });
  const github = fakeGitHub(REPOSITORY, [issue(11, "Ticket Source")]);
  const runner = fakeRunner(commitsWork(project));
  supervisor = await startTestSupervisor({
    gh: github.gh,
    runner,
    // The instance minds one project, and that project's tickets are files.
    configDirectory: await instanceWith({
      source: { type: "local", directory: project.ticketsDirectory },
      project: { directory: project.directory, verify: ["exit 0"], pushCheckpoints: false },
    }),
  });

  await startRunWith(supervisor, { source: { type: "github", repository: REPOSITORY } });
  await waitForQueue(supervisor, (queue: QueueBody) => queue.state === "completed");
  expect(runner.order).toEqual(["11"]);

  // Back to the configured source: naming GitHub for one run did not amend the
  // instance, and a run reading files says nothing to GitHub at all.
  const spentSoFar = github.calls.length;
  await startRunWith(supervisor, {});
  await waitForQueue(
    supervisor,
    (queue) => queue.state === "completed" && stateOf(queue, "01-boot-the-app") === "succeeded",
  );

  expect(runner.order).toEqual(["11", "01-boot-the-app"]);
  expect(github.calls.length).toBe(spentSoFar);
});
