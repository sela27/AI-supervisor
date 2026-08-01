import { asComparableCriterion, CHECKBOX_LINE, readAcceptanceCriteria } from "./criteria.js";
import type { AcceptanceCriterion, TicketResult, TicketReview } from "./ticket.js";

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

/**
 * The two accounts the Supervisor gives of itself at the foot of a ticket, and
 * the only lines of the file that are ever its own to rewrite. A ticket carries
 * one of them or neither: the account of the run that settled it, or the reason
 * it could not be settled at all.
 */
const FAILURE_HEADING = "## Supervisor failure";
const RESULT_HEADING = "## Supervisor run";
const SUPERVISOR_HEADINGS = [FAILURE_HEADING, RESULT_HEADING];

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
      acceptanceCriteria: readAcceptanceCriteria(lines, below(status.index, blockedBy.index)),
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
 * account left by any earlier run rather than piling another one on. Neither the
 * heading nor the quoted summary reads as a title or a checkbox, so the file
 * still parses back to the same ticket.
 */
export function withFailure(contents: string, summary: string): string {
  return withAccount(contents, FAILURE_HEADING, quoted(summary));
}

/**
 * Puts the run's account of the ticket at the foot of the file: where the work
 * went, and what was run over it before it was allowed to stand. Everything the
 * reviewer wrote goes in as a quotation, so a stray `- [ ]` of its own never
 * comes back as one of the ticket's acceptance criteria.
 *
 * The Checkpoint is deliberately not among it — see `withCheckpoint`.
 */
export function withRunResult(contents: string, result: TicketResult): string {
  return withAccount(contents, RESULT_HEADING, [
    `**Branch:** \`${oneLine(result.branch)}\``,
    "",
    `**Verification:** ${verificationSaid(result.checks)}`,
    "",
    `**Review:** ${reviewSaid(result.review)}`,
    ...saidWhy(result.review),
  ]);
}

/**
 * Names the Checkpoint in the account already at the foot of the file — the one
 * thing the write-back could not know when it was written. Where the tickets
 * live among the project's own files the account rides into the very commit it
 * names, and a file inside a commit cannot name the commit it is inside; so the
 * line is added afterwards, once there is a commit to name.
 *
 * A file with no account of a run in it has nothing to name a Checkpoint in, and
 * is left exactly as it stands.
 */
export function withCheckpoint(contents: string, checkpoint: string): string {
  const lines = contents.split(/\r?\n/);
  const heading = lines.findIndex((line) => line.trim() === RESULT_HEADING);
  if (heading === -1) return contents;

  const named = `**Checkpoint:** \`${oneLine(checkpoint)}\``;
  return [...lines.slice(0, heading + 1), "", named, ...lines.slice(heading + 1)].join("\n");
}

/**
 * Ticks the acceptance criteria something actually judged met, and leaves every
 * other line exactly as the user wrote it. A criterion the run cannot match to
 * one of the ticket's own ticks nothing: a reviewer paraphrasing a criterion, or
 * inventing one, must never end up ticking a box beside a different claim.
 */
export function withTickedCriteria(contents: string, met: readonly string[]): string {
  if (met.length === 0) return contents;

  const lines = contents.split(/\r?\n/);
  const from = criteriaBegin(lines);
  if (from === undefined) return contents;

  const judged = new Set(met.map(asComparableCriterion));
  return lines.map((line, index) => (index < from ? line : ticked(line, judged))).join("\n");
}

/**
 * Takes the Supervisor's own account back off a ticket that is about to be
 * attempted again. A ticket that goes on to succeed still carrying the reason it
 * did not is a lie the morning's triage reads.
 */
export function withoutSupervisorAccount(contents: string): string {
  const lines = contents.split(/\r?\n/);
  if (accountBegins(lines) === -1) return contents;
  return [...withoutAccount(lines), ""].join("\n");
}

/** The Supervisor's own account of the ticket, over whatever it left there before. */
function withAccount(contents: string, heading: string, body: string[]): string {
  const kept = withoutAccount(contents.split(/\r?\n/));
  return [...kept, "", heading, "", ...body, ""].join("\n");
}

function withoutAccount(lines: string[]): string[] {
  const begins = accountBegins(lines);
  const kept = begins === -1 ? [...lines] : lines.slice(0, begins);

  while (kept.at(-1)?.trim() === "") kept.pop();
  return kept;
}

function accountBegins(lines: string[]): number {
  return lines.findIndex((line) => SUPERVISOR_HEADINGS.includes(line.trim()));
}

function verificationSaid(checks: readonly string[]): string {
  const named = checks.map((check) => `\`${oneLine(check)}\``).join(", ");
  return `the project's own checks all passed — ${named}`;
}

function reviewSaid(review: TicketReview | undefined): string {
  // Said of the run rather than of the boxes: a tick left over from a run before
  // this one is still a tick, and this line is not the place to contradict it.
  if (review === undefined) {
    return "not asked for, so this run judged no acceptance criterion of its own";
  }

  const met = review.criteriaMet.length;
  return met === 0
    ? "approved, without naming an acceptance criterion it had judged met"
    : `approved, and ticked ${met} of the acceptance criteria`;
}

/** The reviewer's own words, where it gave any. */
function saidWhy(review: TicketReview | undefined): string[] {
  const said = review?.reasoning.trim() ?? "";
  return said === "" ? [] : ["", ...quoted(said)];
}

function ticked(line: string, judged: Set<string>): string {
  const text = CHECKBOX_LINE.exec(line.trim())?.[2];
  if (text === undefined || !judged.has(asComparableCriterion(text))) return line;

  return line.replace(/\[[ xX]\]/, "[x]");
}

/** Where a file's acceptance criteria begin, for a file that has the fields at all. */
function criteriaBegin(lines: string[]): number | undefined {
  const status = findField(lines, "Status");
  const blockedBy = findField(lines, "Blocked by");
  if (status === undefined || blockedBy === undefined) return undefined;

  return below(status.index, blockedBy.index);
}

/** The first line past both fields — where a ticket's own checkboxes start. */
function below(status: number, blockedBy: number): number {
  return Math.max(status, blockedBy) + 1;
}

/**
 * A value written into a field line, kept to the line it was written on. A
 * command or a branch with a newline in it would otherwise put whatever follows
 * it at the start of a line, where the file's own fields live.
 */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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
