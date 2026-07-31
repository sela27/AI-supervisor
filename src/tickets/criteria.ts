import type { AcceptanceCriterion } from "./ticket.js";

/** A ticket's acceptance criteria are checkboxes, wherever the ticket is written. */
export const CHECKBOX_LINE = /^-\s+\[([ xX])\]\s*(.*)$/;

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
