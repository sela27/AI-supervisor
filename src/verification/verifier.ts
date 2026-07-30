import { exec } from "node:child_process";

/**
 * The Supervisor's own judgment of an Attempt: the project's configured commands,
 * run after the Attempt, all of which must exit 0. What Claude reported about
 * itself never enters into it.
 */
export type VerificationResult = { ok: true } | { ok: false; failure: string };

export async function verify(
  commands: readonly string[],
  directory: string,
): Promise<VerificationResult> {
  for (const command of commands) {
    const code = await exitCode(command, directory);
    if (code !== 0) {
      return { ok: false, failure: `verification command "${command}" exited ${code}` };
    }
  }
  return { ok: true };
}

function exitCode(command: string, directory: string): Promise<number> {
  return new Promise((resolve) => {
    exec(command, { cwd: directory }, (error) => {
      if (!error) return resolve(0);
      // A command killed by a signal has no exit code of its own; it did not pass.
      resolve(typeof error.code === "number" ? error.code : -1);
    });
  });
}
