import type { ReviewRequest, RunRequest } from "../../src/runner/runner.js";
import type { Ticket } from "../../src/tickets/ticket.js";

/** The one ticket every Runner test is asked to carry out, whichever way it is driven. */
export const TICKET: Ticket = {
  id: "01-boot-the-app",
  title: "Boot the app",
  status: "ready-for-agent",
  blockedBy: [],
  acceptanceCriteria: [
    { text: "It boots", done: false },
    { text: "It answers /api/health", done: false },
  ],
};

/** And what an Attempt at it left behind, for the reviews that judge one. */
export const DIFF = ["diff --git a/src/main.ts b/src/main.ts", "+app.listen(4317);"].join("\n");

export function runRequest(
  projectDirectory: string,
  overrides: Partial<RunRequest> = {},
): RunRequest {
  return { ticket: TICKET, projectDirectory, ...overrides };
}

export function reviewRequest(
  projectDirectory: string,
  overrides: Partial<ReviewRequest> = {},
): ReviewRequest {
  return { ticket: TICKET, projectDirectory, diff: DIFF, ...overrides };
}
