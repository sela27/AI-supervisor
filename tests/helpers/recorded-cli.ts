import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { createTempDirectory } from "./temp-dir.js";

/** How the recording was called: its arguments, the prompt it was piped, and where. */
export interface CliCall {
  args: string[];
  prompt: string;
  cwd: string;
}

/** What a recorded CLI does when the Supervisor runs it. */
export interface CliRecording {
  /**
   * What it prints on stdout, a line apiece. A message goes out as the JSON the
   * CLI prints in stream-json mode; a string goes out as it is, which is how the
   * lines that are not messages at all are played back.
   */
  prints?: readonly (SDKMessage | string)[];
  /** What it complains about on stderr before it goes. */
  complains?: string;
  /** What it exits with. Nought unless the test is about the other thing. */
  exits?: number;
  /**
   * Whether it holds its last line back until `release` exists. That is how a
   * test proves the lines before it were handed over while the Run was still
   * going: nothing creates that file but whoever was watching the Run.
   */
  holdsBack?: boolean;
}

export interface RecordedCli {
  /** What to run it as, executable first — a Runner's own `command`. */
  command: string[];
  /** The file whose appearance lets a held-back recording print its last line. */
  release: string;
  /** How the CLI was called, once it has been. */
  call(): Promise<CliCall>;
}

/**
 * A stand-in for `claude -p --output-format stream-json`: a script that records
 * how it was called and prints back a Run somebody recorded earlier. It is run
 * for real, so the whole of the Runner is exercised — the spawn, the flags, the
 * prompt down stdin, the parsing — without a byte of it reaching Claude Code.
 */
export async function recordedCli(recording: CliRecording = {}): Promise<RecordedCli> {
  const directory = await createTempDirectory("recorded-cli-");
  const script = join(directory, "claude.cjs");
  const call = join(directory, "call.json");
  const release = join(directory, "released");

  await writeFile(
    script,
    scriptOf({
      call,
      prints: (recording.prints ?? []).map(asLine),
      complains: recording.complains ?? "",
      exits: recording.exits ?? 0,
      release: recording.holdsBack === true ? release : null,
    }),
    "utf8",
  );

  return {
    command: [process.execPath, script],
    release,
    call: async () => JSON.parse(await readFile(call, "utf8")) as CliCall,
  };
}

function asLine(printed: SDKMessage | string): string {
  return typeof printed === "string" ? printed : JSON.stringify(printed);
}

interface Playback {
  call: string;
  prints: string[];
  complains: string;
  exits: number;
  release: string | null;
}

/**
 * The recording itself, as a script Node can run from anywhere. It exits by
 * setting a code rather than by `process.exit`, so that everything it printed
 * down the pipe has left before it goes.
 */
function scriptOf(playback: Playback): string {
  return [
    `const { existsSync, readFileSync, writeFileSync } = require("node:fs");`,
    ``,
    `const playback = ${JSON.stringify(playback)};`,
    `const prompt = readFileSync(0, "utf8");`,
    `writeFileSync(`,
    `  playback.call,`,
    `  JSON.stringify({ args: process.argv.slice(2), prompt, cwd: process.cwd() }),`,
    `);`,
    ``,
    `playback.prints.forEach((line, at) => {`,
    `  const last = at === playback.prints.length - 1;`,
    `  if (playback.release !== null && last && !released()) return;`,
    `  process.stdout.write(line + "\\n");`,
    `});`,
    `if (playback.complains !== "") process.stderr.write(playback.complains + "\\n");`,
    `process.exitCode = playback.exits;`,
    ``,
    `// Waits for whoever is watching to say they saw the lines already printed.`,
    `// It gives up rather than hanging, and the line it was holding back is then`,
    `// never printed at all — so a Run nobody watched fails loudly instead of`,
    `// passing as though it had been.`,
    `function released() {`,
    `  const until = Date.now() + 5000;`,
    `  while (!existsSync(playback.release)) {`,
    `    if (Date.now() > until) return false;`,
    `    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);`,
    `  }`,
    `  return true;`,
    `}`,
  ].join("\n");
}
