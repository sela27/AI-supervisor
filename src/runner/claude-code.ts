import {
  query,
  USAGE_LIMIT_ERROR_PREFIXES,
  type Options,
  type PermissionMode,
  type SDKMessage,
  type SDKRateLimitInfo,
} from "@anthropic-ai/claude-agent-sdk";

import type { RunOutcome, RunRequest, Runner } from "./runner.js";
import type { Ticket } from "../tickets/ticket.js";

/**
 * How a Run is launched. The real one is the Agent SDK's `query`; tests pass a
 * recorded Run instead, so the suite never launches Claude Code.
 */
export type RunLauncher = (parameters: {
  prompt: string;
  options: Options;
}) => AsyncIterable<SDKMessage>;

/** Every permission mode the SDK understands, for validating configuration. */
export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
] as const satisfies readonly PermissionMode[];

export interface ClaudeCodeRunnerOptions {
  /** Which model every Run uses. Left out, the CLI picks its own. */
  model?: string;
  /**
   * How much a Run may do without being asked. The Supervisor runs unattended,
   * so anything that stops to ask is a Run that never finishes.
   */
  permissionMode?: PermissionMode;
  launch?: RunLauncher;
}

type ResultMessage = Extract<SDKMessage, { type: "result" }>;

/**
 * The production Runner: one ticket, one fresh headless Claude Code Run, and
 * whatever the Run said about itself mapped onto the Supervisor's three
 * outcomes. It judges nothing about the work — that is Verification's to do.
 */
export function claudeCodeRunner(options: ClaudeCodeRunnerOptions = {}): Runner {
  const launch = options.launch ?? ((parameters) => query(parameters));

  return {
    run: async (request) => {
      const printed: string[] = [];
      const record = (...lines: string[]): void => {
        for (const line of lines) {
          printed.push(line);
          request.onOutput?.(line);
        }
      };

      // The quota as the Run last reported it. Only its final word counts: a Run
      // refused and then let through went on to finish, and its own failure —
      // not the refusal it survived — is what stopped it.
      let quota: SDKRateLimitInfo | undefined;
      let result: ResultMessage | undefined;

      try {
        for await (const message of launch({
          prompt: promptFor(request.ticket),
          options: optionsFor(request, options),
        })) {
          if (message.type === "assistant") record(...linesOf(message));
          if (message.type === "rate_limit_event") quota = message.rate_limit_info;
          if (message.type === "result") result = message;
        }
      } catch (error) {
        return brokeDown(error, printed.join("\n"));
      }

      return settle(result, quota, printed.join("\n"));
    },
  };
}

function optionsFor(request: RunRequest, options: ClaudeCodeRunnerOptions): Options {
  return {
    cwd: request.projectDirectory,
    permissionMode: options.permissionMode ?? "bypassPermissions",
    ...(options.model === undefined ? {} : { model: options.model }),
  };
}

/**
 * What the Run is sent off to do. The ticket's own words, and the two things the
 * Supervisor needs of every Run: a commit to verify, and the ticket file left
 * alone so the Supervisor's own write-back is the only account of the outcome.
 */
function promptFor(ticket: Ticket): string {
  const criteria = ticket.acceptanceCriteria.map((criterion) => `- ${criterion.text}`);

  return [
    `Implement this ticket in the repository you are running in.`,
    ``,
    `# ${ticket.title}`,
    ``,
    ...(criteria.length === 0 ? [] : [`Acceptance criteria:`, ...criteria, ``]),
    `Commit your work when it is done — an uncommitted attempt does not count.`,
    `Do not push, and do not edit the ticket's own file: the Supervisor records the outcome itself.`,
  ].join("\n");
}

/** Decides what the finished Run amounts to. */
function settle(
  result: ResultMessage | undefined,
  quota: SDKRateLimitInfo | undefined,
  output: string,
): RunOutcome {
  if (result === undefined) {
    return { status: "failed", reason: "the Run ended without reporting a result", output };
  }
  if (result.subtype === "success" && !result.is_error) {
    return { status: "succeeded", output };
  }
  // A limit is not the ticket's fault, so it must never be read as one.
  if (stoppedByLimit(result, quota)) {
    return { status: "limit-hit", resetAt: resetTime(quota?.resetsAt), output };
  }
  return { status: "failed", reason: reasonFor(result), output };
}

/**
 * The three ways a Run says the quota is what stopped it: it names the limit as
 * what ended it, it prints one of the messages Claude Code prints for a limit,
 * or the quota was still refusing it when it gave up.
 */
function stoppedByLimit(result: ResultMessage, quota: SDKRateLimitInfo | undefined): boolean {
  return (
    result.terminal_reason === "blocking_limit" ||
    errorsOf(result).some(saysLimit) ||
    quota?.status === "rejected"
  );
}

function saysLimit(message: string): boolean {
  const text = message.trim();
  return USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/** The SDK's own failures — a missing CLI, a dropped connection — arrive as throws. */
function brokeDown(error: unknown, output: string): RunOutcome {
  const message = error instanceof Error ? error.message : String(error);
  if (saysLimit(message) || /usage limit|rate limit|limit reached/i.test(message)) {
    return { status: "limit-hit", resetAt: null, output };
  }
  return { status: "failed", reason: `the Run broke down: ${message}`, output };
}

const RESULT_FAILURES: Record<string, string> = {
  error_during_execution: "the Run ended in an error",
  error_max_turns: "the Run ran out of turns before finishing the ticket",
  error_max_budget_usd: "the Run ran out of the cost budget it was given",
  error_max_structured_output_retries: "the Run could not produce a usable result",
};

function reasonFor(result: ResultMessage): string {
  // A result that calls itself a success and flags an error explains itself in
  // its own text; the error subtypes carry theirs in `errors`.
  if (result.subtype === "success") {
    const said = result.result.trim();
    return said === "" ? "the Run reported an error it did not explain" : said;
  }

  const headline = RESULT_FAILURES[result.subtype] ?? `the Run ended as ${result.subtype}`;
  const errors = errorsOf(result);
  return errors.length === 0 ? headline : `${headline}: ${errors.join("; ")}`;
}

function errorsOf(result: ResultMessage): string[] {
  return "errors" in result ? result.errors : [];
}

/** No seconds-since-epoch reaches this; a number this large is milliseconds. */
const MILLISECONDS_BEGIN = 1e12;

/** A year of waiting is not a limit reset; it is a number that meant something else. */
const LONGEST_PLAUSIBLE_WAIT_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Reads the reset the SDK reported. It is undocumented whether it comes in
 * seconds or milliseconds, and taking milliseconds for seconds would put the
 * Supervisor to sleep for fifty thousand years.
 */
function resetTime(resetsAt: number | undefined): Date | null {
  if (resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;

  const reset = new Date(resetsAt >= MILLISECONDS_BEGIN ? resetsAt : resetsAt * 1000);
  // A reset already past is kept — the limit has lifted, and saying so is useful.
  return reset.getTime() - Date.now() > LONGEST_PLAUSIBLE_WAIT_MS ? null : reset;
}

/** What one assistant turn contributes to the log: what it said, and what it did. */
function linesOf(message: Extract<SDKMessage, { type: "assistant" }>): string[] {
  const lines: string[] = [];

  for (const block of message.message.content) {
    if (block.type === "text") {
      if (block.text.trim() !== "") lines.push(block.text);
    } else if (block.type === "tool_use") {
      lines.push(toolLine(block.name, block.input));
    }
  }

  return lines;
}

/**
 * The input keys worth showing in a log — what a tool was pointed at. Anything
 * else is guesswork: a tool's first string argument is as likely to be a
 * description as a path.
 */
const TOOL_TARGETS = ["file_path", "notebook_path", "path", "command", "pattern", "url", "query"];

/** A tool call as the log shows it: what was used, and what it was pointed at. */
function toolLine(name: string, input: unknown): string {
  if (input === null || typeof input !== "object") return `· ${name}`;

  const values: Record<string, unknown> = { ...input };
  const target = TOOL_TARGETS.map((key) => values[key]).find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );

  return target === undefined ? `· ${name}` : `· ${name}: ${firstLine(target)}`;
}

function firstLine(value: string): string {
  const line = value.split("\n")[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}
