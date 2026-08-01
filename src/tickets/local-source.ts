import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { TicketSourceError, type TicketProblem } from "./errors.js";
import type { TicketSource } from "./source.js";
import {
  parseTicketFile,
  stripTicketNumberPrefix,
  withCheckpoint,
  withFailure,
  withoutSupervisorAccount,
  withRunResult,
  withStatus,
  withTickedCriteria,
  type ParsedTicket,
} from "./ticket-file.js";
import type { Ticket, TicketResult } from "./ticket.js";

/**
 * A directory of ticket files as the tickets of one Queue — the source for a
 * project whose tickets are scratch, or are kept beside the code they are about.
 */
export function localTicketSource(directory: string): TicketSource {
  return {
    discover: () => discoverLocalTickets(directory),

    markDone: (ticket, result) => markLocalTicketDone(directory, ticket.id, result),

    // Everything else is inside the Checkpoint already: the file was rewritten
    // before the commit, and the commit swept it up along with the work. What is
    // left is the name of that commit, which nothing could know until it existed.
    recordCheckpoint: (ticket, checkpoint) => nameCheckpoint(directory, ticket.id, checkpoint),

    markFailed: (ticket, summary) => markLocalTicketFailed(directory, ticket.id, summary),

    clearFailure: (ticket) => clearLocalTicketFailure(directory, ticket.id, ticket.status),
  };
}

/**
 * Reads a directory of local ticket files as the tickets of one Queue. Every
 * problem in the directory is reported together — a half-readable Ticket Source
 * is never turned into a half-Queue.
 */
async function discoverLocalTickets(directory: string): Promise<Ticket[]> {
  const path = resolve(directory);
  const fileNames = await listTicketFiles(path);

  const unreadable: TicketProblem[] = [];
  const parsed: ParsedTicket[] = [];

  for (const fileName of fileNames) {
    const contents = await readFile(join(path, fileName), "utf8");
    const result = parseTicketFile(fileName, contents);
    if (result.ok) {
      parsed.push(result.ticket);
    } else {
      unreadable.push(...result.problems.map((message) => ({ file: fileName, message })));
    }
  }
  // Edges are only resolvable once every file has been read, so a file that did
  // not parse would report as a dangling edge everywhere it is referenced.
  if (unreadable.length > 0) throw unreadableSource(path, unreadable);

  const { tickets, problems } = resolveBlockingEdges(parsed);
  if (problems.length > 0) throw unreadableSource(path, problems);

  return tickets;
}

/**
 * Records a finished ticket where done-ness belongs — in the Ticket Source itself,
 * so a restarted Supervisor still agrees about what is done — along with the whole
 * account of the run that finished it. Opening the file the morning after is meant
 * to be the whole of what it takes to find out what happened to the ticket.
 */
async function markLocalTicketDone(
  directory: string,
  ticketId: string,
  result: TicketResult,
): Promise<void> {
  await rewriteTicketFile(directory, ticketId, (contents) => {
    const updated = withStatus(contents, "done");
    if (updated === undefined) return undefined;

    // The criteria first: the account goes at the foot, and nothing in it is a
    // checkbox for the ticking to reach.
    const ticked = withTickedCriteria(updated, result.review?.criteriaMet ?? []);
    return withRunResult(ticked, result);
  });
}

/** Names the Checkpoint in the account, now that there is a commit to name. */
async function nameCheckpoint(
  directory: string,
  ticketId: string,
  checkpoint: string,
): Promise<void> {
  await rewriteTicketFile(directory, ticketId, (contents) => withCheckpoint(contents, checkpoint));
}

/**
 * Records a ticket the Supervisor could not get past, with the summary of what
 * went wrong, so the morning's triage starts from the ticket itself. Writing it
 * again over an earlier failure replaces that account rather than adding to it.
 */
async function markLocalTicketFailed(
  directory: string,
  ticketId: string,
  summary: string,
): Promise<void> {
  await rewriteTicketFile(directory, ticketId, (contents) => {
    const updated = withStatus(contents, "failed");
    return updated === undefined ? undefined : withFailure(updated, summary);
  });
}

/**
 * Puts a ticket back the way it was found, for one about to be attempted again:
 * the status the Ticket Source gave it, and no account of a failure it is being
 * given the chance to undo.
 */
async function clearLocalTicketFailure(
  directory: string,
  ticketId: string,
  status: string,
): Promise<void> {
  await rewriteTicketFile(directory, ticketId, (contents) =>
    withStatus(withoutSupervisorAccount(contents), status),
  );
}

async function rewriteTicketFile(
  directory: string,
  ticketId: string,
  rewrite: (contents: string) => string | undefined,
): Promise<void> {
  const file = join(resolve(directory), `${ticketId}.md`);
  const updated = rewrite(await readFile(file, "utf8"));
  if (updated === undefined) {
    throw new TicketSourceError(`${file} has no "**Status:**" line to record the outcome in`);
  }
  await writeFile(file, updated, "utf8");
}

function unreadableSource(path: string, problems: TicketProblem[]): TicketSourceError {
  return new TicketSourceError(`${path} does not read as a set of tickets`, problems);
}

async function listTicketFiles(path: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    throw new TicketSourceError(
      `No ticket directory at ${path} — point the queue at a directory of "<NN>-<slug>.md" ticket files`,
    );
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
}

function resolveBlockingEdges(parsed: ParsedTicket[]): {
  tickets: Ticket[];
  problems: TicketProblem[];
} {
  const problems: TicketProblem[] = [];

  const tickets = parsed.map((ticket) => ({
    id: ticket.id,
    title: ticket.title,
    status: ticket.status,
    blockedBy: ticket.blockedBy.flatMap((reference) => {
      const blocker = findTicket(parsed, reference);
      if (!blocker) {
        problems.push({
          file: ticket.fileName,
          message: `blocked by "${reference}", but no ticket file matches it`,
        });
        return [];
      }
      return [blocker.id];
    }),
    acceptanceCriteria: ticket.acceptanceCriteria,
  }));

  return { tickets, problems };
}

/**
 * A blocking edge may name a ticket by file name, by its number, or by its title —
 * `02-add-search.md`, `2`, and `02 — Add search` all point at the same ticket.
 */
function findTicket(tickets: ParsedTicket[], reference: string): ParsedTicket | undefined {
  const needle = reference.trim().replace(/\.md$/i, "").toLowerCase();
  if (needle === "") return undefined;

  const byId = tickets.find((ticket) => ticket.id.toLowerCase() === needle);
  if (byId) return byId;

  const asNumber = Number(needle);
  if (Number.isInteger(asNumber)) {
    const byNumber = tickets.find((ticket) => ticket.number === asNumber);
    if (byNumber) return byNumber;
  }

  // Titles are stored without their `01 — ` prefix, so a reference copied
  // straight out of the blocker's heading has to lose it too.
  const title = stripTicketNumberPrefix(needle);
  return tickets.find((ticket) => ticket.title.toLowerCase() === title);
}
