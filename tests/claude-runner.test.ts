import { expect, test } from "vitest";

import { claudeCodeRunner } from "../src/runner/claude-code.js";
import type { ReviewRequest, RunRequest } from "../src/runner/runner.js";
import type { Ticket } from "../src/tickets/ticket.js";
import {
  assistantSaying,
  assistantUsing,
  failingRun,
  quotaSaid,
  recordedRun,
  reviewSaid,
  runErrored,
  runSucceeded,
} from "./helpers/recorded-run.js";

/**
 * The production Runner is the one seam below the HTTP API that the suite cannot
 * drive end to end — exercising it for real would launch Claude Code. It is
 * covered the way the spec covers the other external adapters: against recorded
 * Runs, asserting only the outcome the Supervisor is handed back.
 */

const TICKET: Ticket = {
  id: "01-boot-the-app",
  title: "Boot the app",
  status: "ready-for-agent",
  blockedBy: [],
  acceptanceCriteria: [
    { text: "It boots", done: false },
    { text: "It answers /api/health", done: false },
  ],
};

const PROJECT = "/projects/under-supervision";

function request(overrides: Partial<RunRequest> = {}): RunRequest {
  return { ticket: TICKET, projectDirectory: PROJECT, ...overrides };
}

const DIFF = ["diff --git a/src/main.ts b/src/main.ts", "+app.listen(4317);"].join("\n");

function toReview(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return { ticket: TICKET, projectDirectory: PROJECT, diff: DIFF, ...overrides };
}

/** A Run that did the work and said so — three lines of transcript. */
function workingRun() {
  return recordedRun(
    assistantSaying("Reading the ticket."),
    assistantUsing("Edit", { file_path: "src/main.ts" }),
    assistantSaying("Committed."),
    runSucceeded(),
  );
}

const WORKING_TRANSCRIPT = ["Reading the ticket.", "· Edit: src/main.ts", "Committed."].join("\n");

test("a Run that finishes cleanly is reported as succeeded, with the whole transcript", async () => {
  const outcome = await claudeCodeRunner({ launch: workingRun().launch }).run(request());

  expect(outcome).toEqual({ status: "succeeded", output: WORKING_TRANSCRIPT });
});

test("the Run is asked for the ticket, in the project's own directory", async () => {
  const recorded = workingRun();

  await claudeCodeRunner({ launch: recorded.launch }).run(request());

  const prompt = recorded.prompts[0] ?? "";
  expect(prompt).toContain("Boot the app");
  expect(prompt).toContain("It boots");
  expect(prompt).toContain("It answers /api/health");
  // Verification only counts an Attempt that committed, so the Run must be told to.
  expect(prompt).toContain("Commit your work");
  expect(recorded.options[0]?.cwd).toBe(PROJECT);
});

test("a retry is told what refused the last attempt, and that its work is already gone", async () => {
  const firstTime = workingRun();
  await claudeCodeRunner({ launch: firstTime.launch }).run(request());
  expect(firstTime.prompts[0]).not.toContain("earlier attempt");

  const again = workingRun();
  await claudeCodeRunner({ launch: again.launch }).run(
    request({ previousFailure: 'verification command "npm test" exited 1\n  expected 2 to be 3' }),
  );

  const prompt = again.prompts[0] ?? "";
  expect(prompt).toContain('verification command "npm test" exited 1');
  expect(prompt).toContain("expected 2 to be 3");
  // Runs share no context, so a fresh one would otherwise set about undoing damage
  // that the reset has already undone.
  expect(prompt).toContain("thrown away");
  // And it is still a Run being asked to do the ticket, not to explain the failure.
  expect(prompt).toContain("Boot the app");
  expect(prompt).toContain("Commit your work");
});

test("full autonomy is the default, and the model and permission mode are configurable", async () => {
  const byDefault = workingRun();
  await claudeCodeRunner({ launch: byDefault.launch }).run(request());

  // The Supervisor exists to run unattended; a Run that stops to ask is no use.
  expect(byDefault.options[0]?.permissionMode).toBe("bypassPermissions");
  expect(byDefault.options[0]?.model).toBeUndefined();

  const configured = workingRun();
  await claudeCodeRunner({
    launch: configured.launch,
    model: "claude-opus-5",
    permissionMode: "acceptEdits",
  }).run(request());

  expect(configured.options[0]?.model).toBe("claude-opus-5");
  expect(configured.options[0]?.permissionMode).toBe("acceptEdits");
});

test("a usage limit ends the Run as limit-hit, carrying the reset time it reported", async () => {
  const resetAt = new Date(Date.now() + 90 * 60 * 1000);
  const recorded = recordedRun(
    assistantSaying("Working."),
    quotaSaid("rejected", resetAt.getTime() / 1000),
    runErrored("error_during_execution", { terminal_reason: "blocking_limit" }),
  );

  const outcome = await claudeCodeRunner({ launch: recorded.launch }).run(request());

  // Never `failed`: a limit says nothing about the ticket, only about the quota.
  expect(outcome).toEqual({ status: "limit-hit", resetAt, output: "Working." });
});

test("a reset time reported in milliseconds is read as the same moment, not the year 56000", async () => {
  const resetAt = new Date(Date.now() + 90 * 60 * 1000);
  const recorded = recordedRun(
    quotaSaid("rejected", resetAt.getTime()),
    runErrored("error_during_execution", { terminal_reason: "blocking_limit" }),
  );

  const outcome = await claudeCodeRunner({ launch: recorded.launch }).run(request());

  expect(outcome).toEqual({ status: "limit-hit", resetAt, output: "" });
});

test("a usage limit with no reset time is still a limit, just an unscheduled one", async () => {
  const recorded = recordedRun(
    quotaSaid("rejected"),
    runErrored("error_during_execution", { errors: ["stopped"] }),
  );

  const outcome = await claudeCodeRunner({ launch: recorded.launch }).run(request());

  expect(outcome).toEqual({ status: "limit-hit", resetAt: null, output: "" });
});

test("a limit Claude only mentions in words is recognised as one", async () => {
  // No rate-limit event at all — just the message the CLI prints when it stops.
  const recorded = recordedRun(
    runErrored("error_during_execution", {
      errors: ["You've hit your 5-hour limit. Your limit will reset at 6:30am."],
    }),
  );

  const outcome = await claudeCodeRunner({ launch: recorded.launch }).run(request());

  expect(outcome).toMatchObject({ status: "limit-hit", resetAt: null });
});

test("a Run let through after being refused fails for its own reason, not the quota's", async () => {
  // The quota refused it, then relented; whatever went wrong afterwards is the
  // ticket's problem, and must not be mistaken for a limit that has lifted.
  const recorded = recordedRun(
    quotaSaid("rejected", Date.now() / 1000 + 3600),
    quotaSaid("allowed"),
    runErrored("error_during_execution", { errors: ["Edit tool: file not found"] }),
  );

  const outcome = await claudeCodeRunner({ launch: recorded.launch }).run(request());

  expect(outcome).toMatchObject({
    status: "failed",
    reason: expect.stringContaining("Edit tool: file not found") as unknown,
  });
});

test("an error result becomes a failed Attempt naming what went wrong", async () => {
  const recorded = recordedRun(assistantSaying("Trying again."), runErrored("error_max_turns"));

  const outcome = await claudeCodeRunner({ launch: recorded.launch }).run(request());

  expect(outcome.status).toBe("failed");
  expect(outcome).toMatchObject({ reason: expect.stringContaining("turns") as unknown });
  // The transcript survives the failure: it is all the morning has to go on.
  expect(outcome.output).toBe("Trying again.");
});

test("a Run that calls itself successful while flagging an error still explains itself", async () => {
  const recorded = recordedRun(
    runErrored("success", { result: "I could not find the test suite to run." }),
  );

  const outcome = await claudeCodeRunner({ launch: recorded.launch }).run(request());

  expect(outcome).toMatchObject({
    status: "failed",
    reason: "I could not find the test suite to run.",
  });
});

test("a Run that breaks down is a failed Attempt, not a lost one", async () => {
  const recorded = failingRun(new Error("spawn claude ENOENT"), assistantSaying("Starting work."));

  const outcome = await claudeCodeRunner({ launch: recorded.launch }).run(request());

  expect(outcome).toMatchObject({
    status: "failed",
    reason: expect.stringContaining("spawn claude ENOENT") as unknown,
    // Whatever it printed before it broke is still worth reading.
    output: "Starting work.",
  });
});

test("a usage limit thrown rather than reported is still a limit", async () => {
  const recorded = failingRun(new Error("You've hit your 5-hour limit"));

  const outcome = await claudeCodeRunner({ launch: recorded.launch }).run(request());

  expect(outcome).toEqual({ status: "limit-hit", resetAt: null, output: "" });
});

test("a Run that stops without reporting a result never counts as success", async () => {
  const recorded = recordedRun(assistantSaying("Halfway through."));

  const outcome = await claudeCodeRunner({ launch: recorded.launch }).run(request());

  expect(outcome.status).toBe("failed");
  expect(outcome.output).toBe("Halfway through.");
});

test("a tool call is logged by what it was pointed at, not by whatever it listed first", async () => {
  const recorded = recordedRun(
    assistantUsing("Bash", { description: "Run the tests", command: "npm test" }),
    runSucceeded(),
  );

  const outcome = await claudeCodeRunner({ launch: recorded.launch }).run(request());

  expect(outcome.output).toBe("· Bash: npm test");
});

test("output is handed over as it arrives, so a Run can be watched live", async () => {
  const seen: string[] = [];

  const outcome = await claudeCodeRunner({ launch: workingRun().launch }).run(
    request({ onOutput: (chunk) => seen.push(chunk) }),
  );

  expect(seen).toEqual(["Reading the ticket.", "· Edit: src/main.ts", "Committed."]);
  // The same output, whole, for whoever was not watching.
  expect(outcome.output).toBe(WORKING_TRANSCRIPT);
});

test("a review that reached a verdict is handed back as one, reasoning and all", async () => {
  const recorded = recordedRun(
    assistantSaying("Reading the diff."),
    reviewSaid("rejected", "Nothing about the health endpoint is tested.", ["It boots"]),
  );

  const outcome = await claudeCodeRunner({ launch: recorded.launch }).review(toReview());

  expect(outcome).toEqual({
    status: "reviewed",
    verdict: "rejected",
    reasoning: "Nothing about the health endpoint is tested.",
    criteriaMet: ["It boots"],
    output: "Reading the diff.",
  });
});

test("a review is asked which criteria it judged met, and answers unusably at worst", async () => {
  const recorded = recordedRun(reviewSaid("approved", "Both hold.", ["It boots", 7, "  "]));

  const outcome = await claudeCodeRunner({ launch: recorded.launch }).review(toReview());

  const prompt = recorded.prompts[0] ?? "";
  expect(prompt).toContain("criteriaMet");
  // A criterion named as something other than words ticks nothing, and the
  // verdict itself is none the worse for it.
  expect(outcome).toMatchObject({ verdict: "approved", criteriaMet: ["It boots"] });
});

test("the reviewer is shown the ticket, its criteria and the whole of the work", async () => {
  const recorded = recordedRun(reviewSaid("approved", "It meets the ticket."));

  await claudeCodeRunner({ launch: recorded.launch }).review(toReview());

  const prompt = recorded.prompts[0] ?? "";
  expect(prompt).toContain("Boot the app");
  expect(prompt).toContain("It answers /api/health");
  expect(prompt).toContain(DIFF);
  // It is judging the work, not carrying on with it.
  expect(prompt).toContain("change nothing");
  expect(recorded.options[0]?.cwd).toBe(PROJECT);
});

test("a reviewer is given nothing it could write to the project with", async () => {
  const recorded = recordedRun(reviewSaid("approved", "It meets the ticket."));

  await claudeCodeRunner({ launch: recorded.launch }).review(toReview());

  // An approval is followed by a Checkpoint that commits whatever is lying about,
  // so a reviewer able to leave something behind would have it committed as if
  // the Run had written it.
  expect(recorded.options[0]?.tools).toEqual(["Read", "Grep", "Glob"]);
  // And the verdict is asked for as an answer rather than picked out of prose.
  expect(recorded.options[0]?.outputFormat).toMatchObject({ type: "json_schema" });
});

test("a diff too long to send is cut short, and the reviewer told to read the rest itself", async () => {
  const recorded = recordedRun(reviewSaid("approved", "It meets the ticket."));
  const enormous = `${DIFF}\n${"+a line of a generated file\n".repeat(20_000)}`;

  await claudeCodeRunner({ launch: recorded.launch }).review(toReview({ diff: enormous }));

  const prompt = recorded.prompts[0] ?? "";
  expect(prompt.length).toBeLessThan(enormous.length);
  expect(prompt).toContain(DIFF);
  expect(prompt).toContain("read the files themselves");
});

test("a usage limit during a review is a limit, not a verdict on the work", async () => {
  const resetAt = new Date(Date.now() + 90 * 60 * 1000);
  const recorded = recordedRun(
    quotaSaid("rejected", resetAt.getTime()),
    runErrored("error_during_execution", { terminal_reason: "blocking_limit" }),
  );

  const outcome = await claudeCodeRunner({ launch: recorded.launch }).review(toReview());

  // Never a rejection: the quota said nothing about the work, and reading it as a
  // refusal would fail a ticket for something the next Attempt cannot fix.
  expect(outcome).toEqual({ status: "limit-hit", resetAt, output: "" });
});

test("a review that reached no verdict refuses the attempt rather than waving it through", async () => {
  const broke = failingRun(new Error("spawn claude ENOENT"));
  expect(await claudeCodeRunner({ launch: broke.launch }).review(toReview())).toMatchObject({
    status: "reviewed",
    verdict: "rejected",
    reasoning: expect.stringContaining("spawn claude ENOENT") as unknown,
  });

  // A Run that ended without the answer it was asked for has judged nothing, and
  // an Attempt nobody managed to read is not one to let through unread.
  const silent = recordedRun(runSucceeded("I had a look."));
  expect(await claudeCodeRunner({ launch: silent.launch }).review(toReview())).toMatchObject({
    status: "reviewed",
    verdict: "rejected",
    reasoning: expect.stringContaining("no verdict") as unknown,
  });

  const nothing = recordedRun(assistantSaying("Halfway through."));
  expect(await claudeCodeRunner({ launch: nothing.launch }).review(toReview())).toMatchObject({
    status: "reviewed",
    verdict: "rejected",
    reasoning: expect.stringContaining("without reporting a result") as unknown,
  });
});

test("a review is watched as it happens, like the Run it is judging", async () => {
  const seen: string[] = [];
  const recorded = recordedRun(
    assistantSaying("Reading the diff."),
    assistantUsing("Read", { file_path: "src/main.ts" }),
    reviewSaid("approved", "It meets the ticket."),
  );

  await claudeCodeRunner({ launch: recorded.launch }).review(
    toReview({ onOutput: (chunk) => seen.push(chunk) }),
  );

  expect(seen).toEqual(["Reading the diff.", "· Read: src/main.ts"]);
});
