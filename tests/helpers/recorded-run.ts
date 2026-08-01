import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { RunLauncher } from "../../src/runner/claude-code.js";

/** A recorded Run, plus what the Runner asked for when it launched it. */
export interface RecordedRun {
  launch: RunLauncher;
  /** The prompt of each Run the Runner launched, in order. */
  prompts: string[];
  options: Options[];
}

/** Plays a recorded Run back to the Runner, message by message. */
export function recordedRun(...messages: SDKMessage[]): RecordedRun {
  return record(async function* () {
    yield* messages;
  });
}

/**
 * A Run that breaks down part-way: it plays what it has, then throws. The Agent
 * SDK's own failures — a missing CLI, a dropped connection — arrive this way
 * rather than as a result message.
 */
export function failingRun(error: Error, ...before: SDKMessage[]): RecordedRun {
  return record(async function* () {
    yield* before;
    throw error;
  });
}

function record(script: () => AsyncIterable<SDKMessage>): RecordedRun {
  const recorded: RecordedRun = {
    prompts: [],
    options: [],
    launch: ({ prompt, options }) => {
      recorded.prompts.push(prompt);
      recorded.options.push(options);
      return script();
    },
  };
  return recorded;
}

export function assistantSaying(text: string): SDKMessage {
  return fragment({ type: "assistant", message: { content: [{ type: "text", text }] } });
}

export function assistantUsing(name: string, input: Record<string, unknown>): SDKMessage {
  return fragment({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_1", name, input }] },
  });
}

/** The quota's verdict on the Run, as the SDK reports it whenever it changes. */
export function quotaSaid(status: "allowed" | "rejected", resetsAt?: number): SDKMessage {
  return fragment({
    type: "rate_limit_event",
    rate_limit_info: { status, rateLimitType: "five_hour", resetsAt },
  });
}

export function runSucceeded(result = "Done."): SDKMessage {
  return fragment({ type: "result", subtype: "success", is_error: false, result });
}

/**
 * A review that reached a verdict, as the SDK hands a structured answer back.
 * The reasoning is in the text as well, because that is where the CLI puts it —
 * but the structured answer is the one the Supervisor reads.
 */
export function reviewSaid(verdict: "approved" | "rejected", reasoning: string): SDKMessage {
  return fragment({
    type: "result",
    subtype: "success",
    is_error: false,
    result: reasoning,
    structured_output: { verdict, reasoning },
  });
}

export function runErrored(
  subtype: string,
  extras: { errors?: string[]; terminal_reason?: string; result?: string } = {},
): SDKMessage {
  return fragment({ type: "result", subtype, is_error: true, errors: [], ...extras });
}

/**
 * Recordings of a real Run carrying only the fields the Runner reads. The cast
 * is the point: a whole `SDKMessage` has dozens of fields the Supervisor never
 * looks at, and spelling them out would bury what each recording is about.
 */
function fragment(message: object): SDKMessage {
  return message as SDKMessage;
}
