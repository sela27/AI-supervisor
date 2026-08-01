import type { Runner } from "./runner.js";

const NO_RUNNER =
  "No Runner is available yet — this build of the Supervisor cannot launch Claude Code";

/**
 * Stands in until the Claude Agent SDK Runner is built. It fails every Attempt
 * rather than pretending to work, so a real queue started against it stops at the
 * first ticket with an honest explanation.
 */
export function unavailableRunner(): Runner {
  return {
    run: async () => ({ status: "failed", reason: NO_RUNNER, output: "" }),
    // Unreachable in practice — no Attempt of this Runner's ever gets as far as
    // being verified — but a review that cannot happen is never an approval.
    review: async () => ({
      status: "reviewed",
      verdict: "rejected",
      reasoning: NO_RUNNER,
      criteriaMet: [],
      output: "",
    }),
  };
}
