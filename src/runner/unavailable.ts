import type { Runner } from "./runner.js";

/**
 * Stands in until the Claude Agent SDK Runner is built. It fails every Attempt
 * rather than pretending to work, so a real queue started against it stops at the
 * first ticket with an honest explanation.
 */
export function unavailableRunner(): Runner {
  return {
    run: async () => ({
      status: "failed",
      reason:
        "No Runner is available yet — this build of the Supervisor cannot launch Claude Code",
    }),
  };
}
