import { expect, test } from "vitest";

import { claudeCodeRunner } from "../src/runner/claude-code.js";
import type { RunRequest } from "../src/runner/runner.js";
import type { Ticket } from "../src/tickets/ticket.js";
import {
  assistantSaying,
  assistantUsing,
  failingRun,
  quotaSaid,
  recordedRun,
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
