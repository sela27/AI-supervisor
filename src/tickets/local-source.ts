import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { TicketSourceError, type TicketProblem } from "./errors.js";
import { parseTicketFile, stripTicketNumberPrefix, type ParsedTicket } from "./ticket-file.js";
import type { Ticket } from "./ticket.js";

/**
 * Reads a directory of local ticket files as the tickets of one Queue. Every
 * problem in the directory is reported together — a half-readable Ticket Source
 * is never turned into a half-Queue.
 */
export async function discoverLocalTickets(directory: string): Promise<Ticket[]> {
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
