import { readAcceptanceCriteria } from "./criteria.js";
import { TicketSourceError } from "./errors.js";
import type { GhCommand } from "./gh.js";
import type { TicketSource } from "./source.js";
import type { AcceptanceCriterion, Ticket } from "./ticket.js";

/** The label that says an issue is the Supervisor's to pick up. */
const AGENT_LABEL = "ready-for-agent";

/** Where a ticket the Supervisor could not get past is handed back to. */
const HUMAN_LABEL = "ready-for-human";

/**
 * More issues than a night could work through, so reaching it means something is
 * wrong rather than that a queue is long. A page boundary crossed quietly would
 * be a Queue silently missing its last tickets.
 */
const MOST_ISSUES = 200;

/** Where the acceptance criteria are, in the shape `/to-tickets` writes an issue. */
const CRITERIA_HEADING = /^#+\s*acceptance criteria\s*$/i;
const HEADING_LINE = /^#+\s+/;

/**
 * GitHub Issues as the tickets of one Queue. The Queue is the open issues
 * labelled `ready-for-agent`, ordered by the repository's own issue
 * dependencies; outcomes go back to the issue, which is where the morning's
 * triage starts and where done-ness lives between runs.
 */
export function githubTicketSource(repository: string, gh: GhCommand): TicketSource {
  // Every write says which repository it is for. An instance minds one project,
  // and a `gh` left to infer it from wherever it was run would be the Supervisor
  // closing somebody else's issues.
  const forRepository = (...args: string[]): string[] => [...args, "--repo", repository];

  return {
    discover: () => discover(repository, gh),

    // GitHub is told once, when the Checkpoint the telling names exists. Closing
    // an issue that cannot yet say where its work went would be the one comment
    // the morning needs, missing the one thing it is for.
    markDone: async () => {},

    recordCheckpoint: async (ticket, checkpoint) => {
      await gh(forRepository("issue", "close", ticket.id, "--comment", doneComment(checkpoint)));
    },

    markFailed: async (ticket, summary) => {
      await gh(forRepository("issue", "comment", ticket.id, "--body", failureComment(summary)));
      // The issue stays open, and stops being the Supervisor's: what it needs now
      // is a person, and the labels are how the morning finds out which those are.
      await gh(forRepository("issue", "edit", ticket.id, "--add-label", HUMAN_LABEL, "--remove-label", AGENT_LABEL));
    },

    clearFailure: async (ticket) => {
      await gh(forRepository("issue", "edit", ticket.id, "--add-label", AGENT_LABEL, "--remove-label", HUMAN_LABEL));
    },
  };
}

/** One issue, carrying only what a ticket is made of. */
interface ListedIssue {
  number: number;
  title: string;
  body: string;
}

/** One issue as a blocking edge names it: which it is, and whether it still gates. */
interface BlockingIssue {
  number: number;
  state: string;
}

async function discover(repository: string, gh: GhCommand): Promise<Ticket[]> {
  const listed = await listReadyIssues(repository, gh);
  const tickets: Ticket[] = [];

  // What blocks each issue is one `gh` of its own, and they are asked one at a
  // time: a queue's worth of them at once is a queue's worth of processes, and
  // GitHub answers a burst like that by refusing the tail of it.
  for (const issue of listed) {
    tickets.push({
      // The issue number is the ticket's identity in its repository, the way a
      // file name is one ticket's in its directory.
      id: String(issue.number),
      title: issue.title,
      // Only open issues are listed, so nothing discovered here is ever done: a
      // closed issue is a finished ticket, and finished tickets are not for tonight.
      status: "open",
      blockedBy: await openBlockersOf(repository, issue.number, gh),
      acceptanceCriteria: criteriaOf(issue.body),
    });
  }

  return tickets;
}

async function listReadyIssues(repository: string, gh: GhCommand): Promise<ListedIssue[]> {
  const printed = await gh([
    "issue",
    "list",
    "--repo",
    repository,
    "--state",
    "open",
    "--label",
    AGENT_LABEL,
    "--limit",
    String(MOST_ISSUES),
    "--json",
    "number,title,body",
  ]);

  const listed = parsed(printed, `the ${AGENT_LABEL} issues of ${repository}`).map(asListedIssue);
  if (listed.length >= MOST_ISSUES) {
    throw new TicketSourceError(
      `${repository} has ${MOST_ISSUES} or more open ${AGENT_LABEL} issues, which is more than one ` +
        `queue can be — narrow it down before running, so that no ticket is left out unsaid`,
    );
  }

  // Where the blocking edges leave a choice, the order the tickets were written
  // in decides — which on GitHub is the order they were numbered in.
  return listed.sort((one, other) => one.number - other.number);
}

/**
 * The repository's own issue dependencies, which are what GitHub shows a reader
 * and what the `/to-tickets` skill writes. Only the blockers still open are
 * edges: a closed issue is a finished ticket, so closing one is what releases
 * everything that was waiting on it.
 */
async function openBlockersOf(
  repository: string,
  issue: number,
  gh: GhCommand,
): Promise<string[]> {
  const printed = await gh(["api", `repos/${repository}/issues/${issue}/dependencies/blocked_by`]);

  return parsed(printed, `what blocks ${repository}#${issue}`)
    .map(asBlockingIssue)
    .filter((blocker) => blocker.state !== "closed")
    .map((blocker) => String(blocker.number));
}

/**
 * The issue's acceptance criteria: the checkboxes under the heading that says
 * they are, or — for an issue not written in that shape — every checkbox it has.
 */
function criteriaOf(body: string): AcceptanceCriterion[] {
  const lines = body.split(/\r?\n/);
  const heading = lines.findIndex((line) => CRITERIA_HEADING.test(line.trim()));
  if (heading === -1) return readAcceptanceCriteria(lines);

  const next = lines.findIndex((line, index) => index > heading && HEADING_LINE.test(line.trim()));
  const section = next === -1 ? lines.slice(heading + 1) : lines.slice(heading + 1, next);
  return readAcceptanceCriteria(section);
}

function doneComment(checkpoint: string): string {
  return [
    "The AI Supervisor ran this ticket and the project's own verification passed.",
    "",
    `Checkpoint: \`${checkpoint}\``,
  ].join("\n");
}

/**
 * The summary is whatever the Attempt was refused for, so it goes in fenced: a
 * `#12` in a stack trace would otherwise cross-reference itself onto issue 12,
 * and a `- [ ]` would render as a checkbox nobody wrote.
 */
function failureComment(summary: string): string {
  return [
    `The AI Supervisor could not get this ticket past its verification, and has handed it back.`,
    "",
    "````",
    summary,
    "````",
  ].join("\n");
}

function parsed(printed: string, what: string): unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(printed);
  } catch {
    throw new TicketSourceError(`gh did not answer with JSON when asked for ${what}`);
  }

  if (!Array.isArray(value)) {
    throw new TicketSourceError(`gh did not answer with a list of issues when asked for ${what}`);
  }
  return value;
}

function asListedIssue(value: unknown): ListedIssue {
  const issue = value as Partial<ListedIssue>;
  if (typeof issue?.number !== "number" || typeof issue.title !== "string") {
    throw new TicketSourceError(
      `gh listed something that is not an issue: ${JSON.stringify(value)}`,
    );
  }
  // An issue written as a title and nothing else is a ticket with no criteria,
  // not an unreadable one.
  return { number: issue.number, title: issue.title, body: issue.body ?? "" };
}

function asBlockingIssue(value: unknown): BlockingIssue {
  const issue = value as Partial<BlockingIssue>;
  if (typeof issue?.number !== "number" || typeof issue.state !== "string") {
    throw new TicketSourceError(
      `gh named a blocking issue it said nothing usable about: ${JSON.stringify(value)}`,
    );
  }
  return { number: issue.number, state: issue.state };
}
