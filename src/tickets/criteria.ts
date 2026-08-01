import type { AcceptanceCriterion } from "./ticket.js";

/** A ticket's acceptance criteria are checkboxes, wherever the ticket is written. */
export const CHECKBOX_LINE = /^-\s+\[([ xX])\]\s*(.*)$/;

/**
 * One criterion in the form two of them are compared in. A criterion a reviewer
 * copied back out of the ticket may have picked up a line break or a capital on
 * the way, and neither makes it a different criterion.
 */
export function asComparableCriterion(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Every checkbox from `start` on, as the acceptance criteria they are written as. */
export function readAcceptanceCriteria(lines: string[], start = 0): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = [];

  for (const line of lines.slice(start)) {
    const match = CHECKBOX_LINE.exec(line.trim());
    if (match) {
      criteria.push({ text: (match[2] ?? "").trim(), done: match[1]?.toLowerCase() === "x" });
    }
  }

  return criteria;
}
