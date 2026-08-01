import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createTempDirectory } from "./temp-dir.js";

/**
 * Writes a throwaway directory of local ticket files — the Ticket Source a test
 * points the Supervisor at. Keys are file names, values the raw file contents.
 */
export async function createTicketDirectory(files: Record<string, string>): Promise<string> {
  const directory = await createTempDirectory("supervisor-tickets-");

  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(directory, name), contents, "utf8");
  }

  return directory;
}

export interface TicketFileOptions {
  title: string;
  /** Raw value of the `Blocked by:` line; defaults to no blockers. */
  blockedBy?: string;
  status?: string;
  criteria?: string[];
}

/**
 * A queue of tickets that wait on nothing and on each other least of all, so what
 * a run does with them is decided by whatever the test is about rather than by the
 * queue's own shape.
 */
export function independentTickets(count: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let number = 1; number <= count; number += 1) {
    const id = String(number).padStart(2, "0");
    files[`${id}-ticket.md`] = ticketFile({ title: `${id} — Ticket ${number}` });
  }
  return files;
}

/** A well-formed ticket file in the shape `/to-tickets` writes. */
export function ticketFile(options: TicketFileOptions): string {
  const criteria = options.criteria ?? ["It works"];

  return [
    `# ${options.title}`,
    "",
    "**What to build:** Something a developer can demo end to end.",
    "",
    `**Blocked by:** ${options.blockedBy ?? "None — can start immediately"}`,
    "",
    `**Status:** ${options.status ?? "ready-for-agent"}`,
    "",
    ...criteria.map((criterion) => `- [ ] ${criterion}`),
    "",
  ].join("\n");
}
