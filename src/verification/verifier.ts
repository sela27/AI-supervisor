import { exec } from "node:child_process";

/**
 * The Supervisor's own judgment of an Attempt: the project's configured commands,
 * run after the Attempt, all of which must exit 0. What Claude reported about
 * itself never enters into it.
 */
export type VerificationResult =
  | { ok: true }
  /** `output` is what the refusing command printed — the reason behind the reason. */
  | { ok: false; failure: string; output: string };

/**
 * Whether a project's `verify` setting could refuse an Attempt at all. Without a
 * command of its own to run, the Supervisor would be left taking Claude's word
 * for it — which is the one thing Verification exists to refuse.
 */
export function isVerification(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((command) => typeof command === "string" && command.trim() !== "")
  );
}

export async function verify(
  commands: readonly string[],
  directory: string,
): Promise<VerificationResult> {
  for (const command of commands) {
    const result = await run(command, directory);
    if (result.code !== 0) {
      return {
        ok: false,
        failure: `verification command "${command}" exited ${result.code}`,
        output: result.output,
      };
    }
  }
  return { ok: true };
}

interface CommandResult {
  code: number;
  output: string;
}

function run(command: string, directory: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    exec(command, { cwd: directory }, (error, stdout, stderr) => {
      // A command killed by a signal has no exit code of its own; it did not pass.
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
      resolve({ code, output: [stdout, stderr].filter((part) => part !== "").join("\n") });
    });
  });
}
