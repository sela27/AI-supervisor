import {
  query,
  USAGE_LIMIT_ERROR_PREFIXES,
  type Options,
  type PermissionMode,
  type SDKMessage,
  type SDKRateLimitInfo,
} from "@anthropic-ai/claude-agent-sdk";

import { messageOf } from "../errors.js";
import { asRecord } from "../json.js";
import type { ReviewAnswer } from "../verification/review.js";
import type { ReviewOutcome, ReviewRequest, RunOutcome, RunRequest, Runner } from "./runner.js";
import { spendOf, type Spend } from "./spend.js";

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
 * outcomes. It decides nothing about the work of its own accord — whether an
 * Attempt stands is Verification's, here and in the review it is asked for.
 */
export function claudeCodeRunner(options: ClaudeCodeRunnerOptions = {}): Runner {
  const launch = options.launch ?? ((parameters) => query(parameters));

  return {
    run: async (request) => {
      const transcript = await transcribe(
        () =>
          launch({
            prompt: promptFor(request),
            options: howToLaunch(request.projectDirectory, options),
          }),
        request.onOutput,
      );

      if (transcript.broke !== undefined) return brokeDown(transcript.broke.error, transcript);
      return settle(transcript);
    },

    review: async (request) => {
      const transcript = await transcribe(
        () =>
          launch({
            prompt: reviewPromptFor(request),
            options: {
              ...howToLaunch(request.projectDirectory, options),
              // The work is already in the prompt; these are for reading around
              // it. A reviewer with nothing that can write cannot leave anything
              // behind for the Checkpoint to sweep up as the Run's own work.
              tools: ["Read", "Grep", "Glob"],
              // A verdict has to be read by a machine, so it is asked for as one
              // rather than picked back out of prose the reviewer phrased freely.
              outputFormat: { type: "json_schema", schema: VERDICT_SCHEMA },
            },
          }),
        request.onOutput,
      );

      return settleReview(transcript);
    },
  };
}

/** What everything launched here has in common: where it runs, and how freely. */
function howToLaunch(projectDirectory: string, options: ClaudeCodeRunnerOptions): Options {
  return {
    cwd: projectDirectory,
    permissionMode: options.permissionMode ?? "bypassPermissions",
    ...(options.model === undefined ? {} : { model: options.model }),
  };
}

/** One launch of Claude Code, and everything the Supervisor reads out of it. */
interface Transcript {
  result: ResultMessage | undefined;
  /**
   * The quota as the launch last reported it. Only its final word counts: one
   * refused and then let through went on to finish, and its own failure — not
   * the refusal it survived — is what stopped it.
   */
  quota: SDKRateLimitInfo | undefined;
  /**
   * What the launch reported it cost. A launch that broke down before reporting
   * a result spent quota and left no figure for it — there is nothing to be done
   * about that but leave it missing, which is not the same as free.
   */
  spend: Spend | undefined;
  output: string;
  /**
   * What the SDK threw, when it threw rather than finished. Its own failures — a
   * missing CLI, a dropped connection — arrive this way rather than as a result.
   */
  broke: { error: unknown } | undefined;
}

/**
 * Runs one launch to its end, printing as it goes, whatever it was launched for.
 * The launch is begun inside the attempt rather than handed over already begun,
 * so that everything it takes to start one — the prompt included — fails the way
 * the launch itself does: as an outcome the Supervisor is handed back, never as
 * a throw out of a Runner that is supposed to answer one.
 */
async function transcribe(
  begin: () => AsyncIterable<SDKMessage>,
  onOutput: ((chunk: string) => void) | undefined,
): Promise<Transcript> {
  const printed: string[] = [];
  let quota: SDKRateLimitInfo | undefined;
  let result: ResultMessage | undefined;
  let broke: { error: unknown } | undefined;

  try {
    for await (const message of begin()) {
      if (message.type === "assistant") {
        for (const line of linesOf(message)) {
          printed.push(line);
          onOutput?.(line);
        }
      }
      if (message.type === "rate_limit_event") quota = message.rate_limit_info;
      if (message.type === "result") result = message;
    }
  } catch (error) {
    broke = { error };
  }

  return {
    result,
    quota,
    spend: spendReportedBy(result),
    output: printed.join("\n"),
    broke,
  };
}

/** What the launch said it spent, as far as it said anything about it at all. */
function spendReportedBy(result: ResultMessage | undefined): Spend | undefined {
  return spendOf({
    costUsd: result?.total_cost_usd,
    turns: result?.num_turns,
    durationMs: result?.duration_ms,
  });
}

/**
 * What the Run is sent off to do. The ticket's own words, whatever the last
 * Attempt was refused for, and the two things the Supervisor needs of every Run:
 * a commit to verify, and the ticket file left alone so the Supervisor's own
 * write-back is the only account of the outcome.
 */
function promptFor(request: RunRequest): string {
  const { ticket } = request;
  const criteria = ticket.acceptanceCriteria.map((criterion) => `- ${criterion.text}`);

  return [
    `Implement this ticket in the repository you are running in.`,
    ``,
    `# ${ticket.title}`,
    ``,
    ...(criteria.length === 0 ? [] : [`Acceptance criteria:`, ...criteria, ``]),
    ...(request.previousFailure === undefined ? [] : feedbackBlock(request.previousFailure)),
    `Commit your work when it is done — an uncommitted attempt does not count.`,
    `Do not push, and do not edit the ticket's own file: the Supervisor records the outcome itself.`,
  ].join("\n");
}

/**
 * The one thing that survives a refused Attempt. Its work is already gone, so the
 * Run is told what it is starting from as well as what went wrong — otherwise a
 * fresh context reads the failure as damage still waiting to be undone.
 */
function feedbackBlock(failure: string): string[] {
  return [
    `An earlier attempt at this ticket was refused, and its work was thrown away —`,
    `the repository is back to where it stood before it ran. This is what it was`,
    `refused for:`,
    ``,
    failure,
    ``,
  ];
}

/** The only shape an answer may come back in, asked for of the SDK itself. */
const VERDICT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approved", "rejected"] },
    reasoning: {
      type: "string",
      description: "Why, in a sentence or two the next attempt could act on.",
    },
    criteriaMet: {
      type: "array",
      items: { type: "string" },
      description:
        "The acceptance criteria the work meets, each copied exactly as it is written above. " +
        "Leave out any you could not judge from what you were shown.",
    },
  },
  required: ["verdict", "reasoning", "criteriaMet"],
  additionalProperties: false,
};

/**
 * How much of a diff is worth putting in front of a reviewer. Past this, one
 * ticket's work has stopped being one ticket's work — and a prompt too long to
 * send is a review that never happens at all, which is worse than a partial one
 * the reviewer can read the rest of for itself.
 */
const LONGEST_DIFF = 200_000;

/**
 * What the review is sent off to do: the ticket it judges against, the whole of
 * what the Attempt changed, and the two things that make it a review rather than
 * another Attempt — change nothing, and reach a verdict either way.
 */
function reviewPromptFor(request: ReviewRequest): string {
  const { ticket } = request;
  const criteria = ticket.acceptanceCriteria.map((criterion) => `- ${criterion.text}`);

  return [
    `An unattended attempt at this ticket has just passed the project's own checks.`,
    `Judge what it left behind against the ticket, and say whether it should stand.`,
    ``,
    `# ${ticket.title}`,
    ``,
    ...(criteria.length === 0 ? [] : [`Acceptance criteria:`, ...criteria, ``]),
    `This is everything the attempt changed:`,
    ``,
    "```diff",
    diffToJudge(request.diff),
    "```",
    ``,
    `Read whatever else you need of the project to judge it, and change nothing:`,
    `you are reviewing the work, not finishing it.`,
    `Approve work that meets the acceptance criteria, and reject work that does not.`,
    `Name in criteriaMet the criteria you judged met, copied exactly, and leave out`,
    `any you could not judge from what you were shown — the ones you name are`,
    `ticked on the user's own ticket, and the rest are left for them to tick.`,
  ].join("\n");
}

function diffToJudge(diff: string): string {
  if (diff.trim() === "") return "(the attempt changed nothing a diff can show)";
  if (diff.length <= LONGEST_DIFF) return diff;

  return [
    diff.slice(0, LONGEST_DIFF),
    `...the rest of the diff was too long to include — read the files themselves.`,
  ].join("\n");
}

/** Decides what the finished review amounts to. */
function settleReview(transcript: Transcript): ReviewOutcome {
  const { result, quota, spend, output } = transcript;

  if (transcript.broke !== undefined) {
    const message = messageOf(transcript.broke.error);
    if (threwOverTheLimit(message)) return { status: "limit-hit", resetAt: null, output, spend };
    return unjudged(`the review broke down: ${message}`, transcript);
  }

  if (result === undefined) {
    return unjudged("the review ended without reporting a result", transcript);
  }
  // A limit is not the ticket's fault here any more than it is during a Run.
  if (stoppedByLimit(result, quota)) {
    return { status: "limit-hit", resetAt: resetTime(quota?.resetsAt), output, spend };
  }

  const verdict = verdictOf(result);
  return verdict === undefined
    ? unjudged(`the review reached no verdict: ${reasonFor(result)}`, transcript)
    : { status: "reviewed", ...verdict, output, spend };
}

/**
 * A review that could not judge the work is not one that approved it. The whole
 * point of the stage is that nothing reaches a Checkpoint unread, so an Attempt
 * nobody managed to read is refused — and it says so in the words the morning
 * needs to go and turn the review off or fix it.
 */
function unjudged(reasoning: string, transcript: Transcript): ReviewOutcome {
  return {
    status: "reviewed",
    verdict: "rejected",
    reasoning,
    criteriaMet: [],
    output: transcript.output,
    spend: transcript.spend,
  };
}

/** The answer the review was asked for, when it came back as one. */
function verdictOf(result: ResultMessage): ReviewAnswer | undefined {
  if (result.subtype !== "success" || result.is_error) return undefined;

  const said = asRecord(result.structured_output);
  if (said?.verdict !== "approved" && said?.verdict !== "rejected") return undefined;

  return {
    verdict: said.verdict,
    reasoning: typeof said.reasoning === "string" ? said.reasoning.trim() : "",
    criteriaMet: criteriaOf(said.criteriaMet),
  };
}

/**
 * The criteria the review named, as far as they are words at all. A review that
 * answered the verdict and made a mess of the list has still judged the work;
 * what it named unusably simply ticks nothing.
 */
function criteriaOf(named: unknown): string[] {
  if (!Array.isArray(named)) return [];

  return named.filter((text): text is string => typeof text === "string" && text.trim() !== "");
}

/** Decides what the finished Run amounts to. */
function settle(transcript: Transcript): RunOutcome {
  const { result, quota, spend, output } = transcript;

  if (result === undefined) {
    return { status: "failed", reason: "the Run ended without reporting a result", output, spend };
  }
  if (result.subtype === "success" && !result.is_error) {
    return { status: "succeeded", output, spend };
  }
  // A limit is not the ticket's fault, so it must never be read as one.
  if (stoppedByLimit(result, quota)) {
    return { status: "limit-hit", resetAt: resetTime(quota?.resetsAt), output, spend };
  }
  return { status: "failed", reason: reasonFor(result), output, spend };
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

/** How a limit reads in something that was thrown rather than reported. */
const LIMIT_IN_WORDS = /usage limit|rate limit|limit reached/i;

function threwOverTheLimit(message: string): boolean {
  return saysLimit(message) || LIMIT_IN_WORDS.test(message);
}

/** The SDK's own failures — a missing CLI, a dropped connection — arrive as throws. */
function brokeDown(error: unknown, { output, spend }: Transcript): RunOutcome {
  const message = messageOf(error);
  if (threwOverTheLimit(message)) return { status: "limit-hit", resetAt: null, output, spend };
  return { status: "failed", reason: `the Run broke down: ${message}`, output, spend };
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
