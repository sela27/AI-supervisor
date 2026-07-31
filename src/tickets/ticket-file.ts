import { CHECKBOX_LINE, readAcceptanceCriteria } from "./criteria.js";
import type { AcceptanceCriterion } from "./ticket.js";

/** One ticket file, read but not yet related to the others in its directory. */
export interface ParsedTicket {
  fileName: string;
  /** The file name without its extension — the ticket's identity in its directory. */
  id: string;
  /** The file name's leading number, when it has one: what `Blocked by: 01` points at. */
  number: number | undefined;
  title: string;
  status: string;
  /** Blocking edges exactly as written; resolved against the other tickets later. */
  blockedBy: string[];
  acceptanceCriteria: AcceptanceCriterion[];
}

export type ParsedTicketFile =
  | { ok: true; ticket: ParsedTicket }
  | { ok: false; problems: string[] };

const TITLE_LINE = /^#\s+(.+)$/;
const NUMBER_PREFIX = /^\d+\s*[—–-]\s*/;
const STATUS_LINE = /^\*\*Status:\*\*/i;
const FAILURE_HEADING = "## Supervisor failure";

export function parseTicketFile(fileName: string, contents: string): ParsedTicketFile {
  const lines = contents.split(/\r?\n/);
  const problems: string[] = [];

  const title = readTitle(lines);
  if (title === undefined) {
    problems.push('no title — add a "# <NN> — <title>" heading');
  }

  const status = readField(lines, "Status");
  if (status === undefined) {
    problems.push('no status — add a "**Status:** ready-for-agent" line');
  }

  const blockedBy = readBlockedBy(lines);
  if (blockedBy === undefined) {
    problems.push(
      'no blocking edges — add a "**Blocked by:** None — can start immediately" line, ' +
        "or list the tickets that gate this one",
    );
  }

  if (title === undefined || status === undefined || blockedBy === undefined) {
    return { ok: false, problems };
  }

  const id = stripExtension(fileName);
  return {
    ok: true,
    ticket: {
      fileName,
      id,
      number: leadingNumber(id),
      title,
      status: status.value,
      blockedBy: blockedBy.references,
      // Only checkboxes below the fields count, so a checklist inside the
      // "What to build" prose is never mistaken for an acceptance criterion.
      acceptanceCriteria: readAcceptanceCriteria(
        lines,
        Math.max(status.index, blockedBy.index) + 1,
      ),
    },
  };
}

/**
 * Rewrites the file's `**Status:**` line, leaving every other line exactly as the
 * user wrote it. Nothing comes back when the file has no such line to write into.
 */
export function withStatus(contents: string, status: string): string | undefined {
  const lines = contents.split(/\r?\n/);
  const index = lines.findIndex((line) => STATUS_LINE.test(line.trim()));
  if (index === -1) return undefined;

  lines[index] = `**Status:** ${status}`;
  return lines.join("\n");
}

/**
 * Puts the run's account of the failure at the foot of the ticket, replacing the
 * account left by any earlier failure rather than piling another one on. Neither
 * the heading nor the quoted summary reads as a title or a checkbox, so the file
 * still parses back to the same ticket.
 */
export function withFailure(contents: string, summary: string): string {
  const lines = contents.split(/\r?\n/);
  const existing = lines.findIndex((line) => line.trim() === FAILURE_HEADING);
  const kept = existing === -1 ? [...lines] : lines.slice(0, existing);

  while (kept.at(-1)?.trim() === "") kept.pop();

  return [...kept, "", FAILURE_HEADING, "", ...quoted(summary), ""].join("\n");
}

/**
 * Takes an earlier run's account of a failure back off the ticket, for a ticket
 * that is about to be attempted again. Leaving it there would leave a ticket
 * that went on to succeed still carrying the reason it did not.
 */
export function withoutFailure(contents: string): string {
  const lines = contents.split(/\r?\n/);
  const existing = lines.findIndex((line) => line.trim() === FAILURE_HEADING);
  if (existing === -1) return contents;

  const kept = lines.slice(0, existing);
  while (kept.at(-1)?.trim() === "") kept.pop();
  return [...kept, ""].join("\n");
}

/**
 * The summary is whatever the Run printed, so it goes in as a quotation: a stray
 * `- [ ]` line of Claude's must never come back as one of the ticket's own
 * acceptance criteria.
 */
function quoted(summary: string): string[] {
  return summary.split(/\r?\n/).map((line) => (line.trim() === "" ? ">" : `> ${line}`));
}

/** Strips the `01 — ` a ticket's number puts in front of its title. */
export function stripTicketNumberPrefix(title: string): string {
  return title.replace(NUMBER_PREFIX, "").trim();
}

function readTitle(lines: string[]): string | undefined {
  for (const line of lines) {
    const match = TITLE_LINE.exec(line.trim());
    const heading = match?.[1]?.trim();
    if (heading !== undefined && heading !== "") {
      // "# 01 — Boot the app" and "# Boot the app" name the same ticket.
      return stripTicketNumberPrefix(heading);
    }
  }
  return undefined;
}

/** Reads a `**Name:** value` line. Absent and empty are both "not given". */
function readField(
  lines: string[],
  name: string,
): { index: number; value: string } | undefined {
  const field = findField(lines, name);
  return field?.value === "" ? undefined : field;
}

/** Finds a `**Name:** value` line. The value may be empty — the caller decides. */
function findField(
  lines: string[],
  name: string,
): { index: number; value: string } | undefined {
  const pattern = new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.*)$`, "i");
  for (const [index, line] of lines.entries()) {
    const match = pattern.exec(line.trim());
    if (match) {
      return { index, value: (match[1] ?? "").trim() };
    }
  }
  return undefined;
}

function readBlockedBy(lines: string[]): { index: number; references: string[] } | undefined {
  const field = findField(lines, "Blocked by");
  if (!field) return undefined;

  // The edges sit either on the line itself or in the bullet list beneath it.
  const references =
    field.value !== "" ? splitReferences(field.value) : readBulletList(lines, field.index + 1);

  if (references.length === 0) return undefined;
  if (references.length === 1 && /^none\b/i.test(references[0] ?? "")) {
    return { index: field.index, references: [] };
  }
  return { index: field.index, references };
}

function readBulletList(lines: string[], start: number): string[] {
  const references: string[] = [];
  for (const line of lines.slice(start).map((value) => value.trim())) {
    if (line === "") {
      if (references.length > 0) break;
      continue;
    }
    if (!line.startsWith("- ") || CHECKBOX_LINE.test(line)) break;
    references.push(...splitReferences(line.slice(2)));
  }
  return references;
}

function splitReferences(value: string): string[] {
  return value
    .split(",")
    .map((reference) => reference.trim().replace(/^#/, "").trim())
    .filter((reference) => reference !== "");
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.md$/i, "");
}

function leadingNumber(id: string): number | undefined {
  const match = /^(\d+)/.exec(id);
  return match ? Number(match[1]) : undefined;
}
