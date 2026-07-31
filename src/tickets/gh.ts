import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { TicketSourceError } from "./errors.js";

const execFileAsync = promisify(execFile);

/**
 * One `gh` invocation, and what it printed. The whole of the Supervisor's side of
 * GitHub goes through here, so a test hands over a `gh` of its own and the suite
 * never reaches the network.
 */
export type GhCommand = (args: string[]) => Promise<string>;

/**
 * A listing of every ticket of a queue, bodies and all, is a great deal more than
 * a command's usual output.
 */
const OUTPUT_LIMIT = 32 * 1024 * 1024;

/** The real thing: the `gh` CLI, authenticated by the environment it was given. */
export function ghCli(): GhCommand {
  return async (args) => {
    try {
      const { stdout } = await execFileAsync("gh", args, { maxBuffer: OUTPUT_LIMIT });
      return stdout;
    } catch (error) {
      throw new TicketSourceError(`gh ${args.join(" ")} failed: ${describe(error)}`);
    }
  };
}

function describe(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr?.trim();
  return stderr !== undefined && stderr !== "" ? stderr : String(error);
}
