import { realpath, writeFile } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";

import { claudeCodeRunner, type ClaudeCodeRunnerOptions } from "../src/runner/claude-code.js";
import { recordedCli, type CliRecording } from "./helpers/recorded-cli.js";
import {
  assistantSaying,
  assistantUsing,
  quotaSaid,
  reviewSaid,
  runErrored,
  runSucceeded,
} from "./helpers/recorded-run.js";
import { reviewRequest, runRequest } from "./helpers/run-request.js";
import { createTempDirectory, removeTempDirectories } from "./helpers/temp-dir.js";

/**
 * The second way in: the same Runner, driving the Claude Code CLI in stream-json
 * mode instead of the Agent SDK. It is covered the way the SDK Runner is —
 * against a recorded Run — except that here the recording is a real process the
 * Supervisor really spawns, since the spawning is the half of it that is new.
 */

afterEach(async () => {
  await removeTempDirectories();
});

/** A project for the Run to be launched in; the CLI is really run, so it must exist. */
function project(): Promise<string> {
  return createTempDirectory("cli-project-");
}

const WORKING_RUN: CliRecording = {
  prints: [
    assistantSaying("Reading the ticket."),
    assistantUsing("Edit", { file_path: "src/main.ts" }),
    assistantSaying("Committed."),
    runSucceeded("Done.", { total_cost_usd: 0.37, num_turns: 14, duration_ms: 128_000 }),
  ],
};

const WORKING_TRANSCRIPT = ["Reading the ticket.", "· Edit: src/main.ts", "Committed."].join("\n");

/** The Runner as an instance told to use the CLI gets it, pointed at a recording. */
function drivenByCli(command: string[], options: ClaudeCodeRunnerOptions = {}) {
  return claudeCodeRunner({ ...options, driver: "cli", command });
}

test("a Run driven through the CLI is settled by what it printed, transcript and all", async () => {
  const recorded = await recordedCli(WORKING_RUN);

  const outcome = await drivenByCli(recorded.command).run(runRequest(await project()));

  // Exactly what the SDK Runner hands back for the same Run: which way Claude
  // Code was driven is the Runner's own business and nobody else's.
  expect(outcome).toEqual({
    status: "succeeded",
    output: WORKING_TRANSCRIPT,
    spend: { costUsd: 0.37, turns: 14, durationMs: 128_000 },
  });
});

test("the CLI is asked in print and stream-json, with the prompt down its stdin", async () => {
  const recorded = await recordedCli(WORKING_RUN);
  const directory = await project();

  await drivenByCli(recorded.command).run(runRequest(directory));

  const call = await recorded.call();
  expect(call.args).toEqual(
    expect.arrayContaining(["--print", "--output-format", "stream-json", "--verbose"]),
  );
  expect(call.prompt).toContain("Boot the app");
  expect(call.prompt).toContain("It answers /api/health");
  expect(call.prompt).toContain("Commit your work");
  // Down stdin rather than into an argument: a review's prompt carries a whole
  // diff, and an argument that long is one the operating system refuses to spawn.
  expect(call.args.join(" ")).not.toContain("Boot the app");
  expect(await realpath(call.cwd)).toBe(await realpath(directory));
});

test("model and permission mode reach the CLI as flags of its own", async () => {
  const byDefault = await recordedCli(WORKING_RUN);
  await drivenByCli(byDefault.command).run(runRequest(await project()));

  // The Supervisor exists to run unattended; a Run that stops to ask is no use.
  const unconfigured = (await byDefault.call()).args;
  expect(unconfigured).toContain("bypassPermissions");
  expect(unconfigured).not.toContain("--model");

  const configured = await recordedCli(WORKING_RUN);
  await drivenByCli(configured.command, {
    model: "claude-opus-5",
    permissionMode: "acceptEdits",
  }).run(runRequest(await project()));

  const args = (await configured.call()).args.join(" ");
  expect(args).toContain("--model claude-opus-5");
  expect(args).toContain("--permission-mode acceptEdits");
});

test("the one mode the two spell differently reaches the CLI in the CLI's spelling", async () => {
  const recorded = await recordedCli(WORKING_RUN);

  await drivenByCli(recorded.command, { permissionMode: "default" }).run(
    runRequest(await project()),
  );

  // Asking before anything is `default` to the SDK and `manual` to the CLI.
  // Handed over untranslated it is not a mode the CLI has: it would refuse its
  // own arguments and fail every Attempt of the night over a good setting.
  expect((await recorded.call()).args.join(" ")).toContain("--permission-mode manual");
});

test("a usage limit the CLI reported ends the Run as limit-hit, reset time and all", async () => {
  const resetAt = new Date(Date.now() + 90 * 60 * 1000);
  const recorded = await recordedCli({
    prints: [
      assistantSaying("Working."),
      quotaSaid("rejected", resetAt.getTime() / 1000),
      runErrored("error_during_execution", { terminal_reason: "blocking_limit" }),
    ],
    // A CLI stopped by the quota exits badly, and that is not a breakdown: it
    // said what happened before it went, which is all the Supervisor needs.
    exits: 1,
  });

  const outcome = await drivenByCli(recorded.command).run(runRequest(await project()));

  expect(outcome).toEqual({ status: "limit-hit", resetAt, output: "Working." });
});

test("a CLI that is not there fails the Attempt rather than bringing the run down", async () => {
  const outcome = await drivenByCli(["claude-that-was-never-installed"]).run(
    runRequest(await project()),
  );

  // The whole point of the fallback is the environment the SDK could not run in,
  // so the environment the CLI cannot run in has to be survivable in its turn.
  expect(outcome).toMatchObject({
    status: "failed",
    reason: expect.stringContaining("claude-that-was-never-installed") as unknown,
  });
});

test("a CLI that ends without reporting a result says what it exited with", async () => {
  const recorded = await recordedCli({
    prints: [assistantSaying("Starting work.")],
    complains: "error: unknown option '--output-format'",
    exits: 2,
  });

  const outcome = await drivenByCli(recorded.command).run(runRequest(await project()));

  // A morning that finds this has to be able to tell a broken install from a
  // ticket nobody could do, so what the CLI itself said goes in the reason.
  expect(outcome).toMatchObject({
    status: "failed",
    output: "Starting work.",
    reason: expect.stringMatching(/exited 2.*unknown option/s) as unknown,
  });
});

test("output is handed over line by line while the Run is still going", async () => {
  const recorded = await recordedCli({ ...WORKING_RUN, holdsBack: true });
  const seen: string[] = [];

  // The recording will not print its result until this file exists, and nothing
  // creates it but the watching below — so a Runner that kept the transcript to
  // itself until the CLI had finished would never get a result at all.
  const outcome = await drivenByCli(recorded.command).run(
    runRequest(await project(), {
      onOutput: (chunk) => {
        seen.push(chunk);
        if (chunk === "Committed.") void writeFile(recorded.release, "", "utf8");
      },
    }),
  );

  expect(seen).toEqual(["Reading the ticket.", "· Edit: src/main.ts", "Committed."]);
  expect(outcome.status).toBe("succeeded");
});

test("a line that is not one of the CLI's messages is passed over", async () => {
  const recorded = await recordedCli({
    prints: [
      "Warning: this project has no CLAUDE.md",
      "",
      "{ not json at all",
      assistantSaying("Working."),
      runSucceeded(),
    ],
  });

  const outcome = await drivenByCli(recorded.command).run(runRequest(await project()));

  // A Run is not something to fail over a stray line on the way past.
  expect(outcome).toEqual({ status: "succeeded", output: "Working." });
});

test("a review driven through the CLI is asked for a verdict and answers one", async () => {
  const recorded = await recordedCli({
    prints: [
      assistantSaying("Reading the diff."),
      reviewSaid("rejected", "Nothing about the health endpoint is tested.", ["It boots"]),
    ],
  });

  const outcome = await drivenByCli(recorded.command).review(reviewRequest(await project()));

  const args = (await recorded.call()).args.join(" ");
  // A reviewer with nothing that can write, and a verdict asked for as an answer
  // rather than picked back out of prose — the same two demands as through the SDK.
  expect(args).toContain("--tools Read,Grep,Glob");
  expect(args).toContain("--json-schema");
  expect(args).toContain("verdict");
  expect(outcome).toEqual({
    status: "reviewed",
    verdict: "rejected",
    reasoning: "Nothing about the health endpoint is tested.",
    criteriaMet: ["It boots"],
    output: "Reading the diff.",
  });
});
