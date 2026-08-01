import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { asRecord, parsedJson } from "../json.js";
import type { RunLauncher } from "./claude-code.js";

/** What the CLI is called where nobody says otherwise: `claude`, as the container installs it. */
const CLAUDE = "claude";

/**
 * The other way to launch a Run: the Claude Code CLI in stream-json mode, for an
 * environment the Agent SDK cannot run in.
 *
 * It hands back the very same messages, and not by coincidence: the SDK is a
 * wrapper around this executable run this way, and every message it yields is a
 * line of this stream passed through. So everything the Supervisor makes of a
 * Run is decided in the one place whichever way it was driven, and nothing above
 * the Runner can tell which of the two launched anything.
 */
export function claudeCliLauncher(command: readonly string[] = [CLAUDE]): RunLauncher {
  return ({ prompt, options }) => launch(command, prompt, options);
}

/** How much of what the CLI complained about is worth carrying into a failure. */
const LONGEST_COMPLAINT = 2000;

async function* launch(
  command: readonly string[],
  prompt: string,
  options: Options,
): AsyncIterable<SDKMessage> {
  const [executable = CLAUDE, ...leading] = command;
  const claude = spawn(executable, [...leading, ...argumentsFor(options)], {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Waited on at the end but watched for from the start: a CLI that is not there
  // fails before there is a line to read, and `close` has come and gone by the
  // time the reading below runs out. The idle catch is what keeps that failure
  // from counting as an unhandled rejection while the reading is still going.
  const ended = endOf(claude);
  ended.catch(() => {});

  let complained = "";
  claude.stderr.setEncoding("utf8");
  claude.stderr.on("data", (chunk: string) => {
    complained = `${complained}${chunk}`.slice(-LONGEST_COMPLAINT);
  });

  // The prompt goes down stdin rather than into an argument: a review's prompt
  // carries a whole diff behind it, and an argument that long is one the
  // operating system refuses to spawn at all. A CLI that never started is not
  // one that can be written to either, and the broken pipe that follows is not
  // the failure worth reporting — the spawn's own is.
  claude.stdin.on("error", () => {});
  claude.stdin.end(prompt);

  try {
    let reported = false;
    for await (const line of createInterface({ input: claude.stdout })) {
      const message = messageIn(line);
      if (message === undefined) continue;
      if (message.type === "result") reported = true;
      yield message;
    }

    const code = await ended;
    // A CLI stopped by the usage limit exits badly and says so first; that is a
    // Run that reported itself, not one that broke down. Only an ending with
    // nothing to show for it is worth throwing over.
    if (!reported && code !== 0) throw new Error(wentWrong(code, complained));
  } finally {
    // Whoever was reading these messages may give up on them part-way, and a
    // Run left running with nobody reading it would go on spending the night's
    // quota unwatched. Killing one that has already gone costs nothing.
    claude.kill();
  }
}

/** How the launch ended: the code it exited with, or the failure to start at all. */
function endOf(claude: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve, reject) => {
    claude.once("error", reject);
    claude.once("close", (code) => resolve(code));
  });
}

function wentWrong(code: number | null, complained: string): string {
  const ending =
    code === null ? "the Claude Code CLI was killed" : `the Claude Code CLI exited ${code}`;
  return complained.trim() === "" ? ending : `${ending}: ${complained.trim()}`;
}

/**
 * The one permission mode the two spell differently. Asking before anything is
 * `default` to the SDK and `manual` to the CLI, and handed over untranslated it
 * is not a mode the CLI has at all: it would refuse its own arguments and fail
 * every Attempt of the night over a setting that was perfectly good.
 */
const SPELT_ITS_OWN_WAY: Record<string, string> = { default: "manual" };

/**
 * The launch, as the CLI's own arguments. Everything the Supervisor asks of a Run
 * it asks here too, so that an instance driven this way runs the same Runs — and
 * stream-json is the whole point: it is what makes the CLI answer in the messages
 * the SDK would have handed over.
 */
function argumentsFor(options: Options): string[] {
  const args = ["--print", "--output-format", "stream-json", "--verbose"];

  if (options.model !== undefined) args.push("--model", options.model);
  if (options.permissionMode !== undefined) {
    const mode = options.permissionMode;
    args.push("--permission-mode", SPELT_ITS_OWN_WAY[mode] ?? mode);
  }
  // Only ever a review's three, named outright; the Supervisor asks for no preset.
  if (Array.isArray(options.tools)) args.push("--tools", options.tools.join(","));
  if (options.outputFormat?.type === "json_schema") {
    args.push("--json-schema", JSON.stringify(options.outputFormat.schema));
  }

  return args;
}

/**
 * One printed line as a message, where it is one at all. The CLI prints the odd
 * line that is not — a warning on the way up, a stray log — and a Run is not
 * something to throw away over something said beside it.
 */
function messageIn(line: string): SDKMessage | undefined {
  const printed = asRecord(parsedJson(line));
  return typeof printed?.type === "string" ? (printed as SDKMessage) : undefined;
}
