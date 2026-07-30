import { CONFIG_FILENAME } from "../config-file.js";
import { asRecord } from "../json.js";
import { unedited, type QueueEdit } from "../queue/edit.js";

const SOURCE_SHAPE =
  'A ticket source looks like { "source": { "type": "local", "directory": "/path/to/tickets" } }';

const QUEUE_SHAPE =
  'An edited queue looks like { "queue": { "exclude": ["03-search-ui"], "order": ["02-add-search"] } }';

export type Read<T> = { ok: true; value: T } | { ok: false; message: string };

/** Says both ways a request could have been given what it turned out to need. */
export function notSupplied(what: string, shape: string): string {
  return `${what}. ${shape}, or settle it once in ${CONFIG_FILENAME}`;
}

/**
 * Which Ticket Source the request picked, and where it lives. A request that says
 * nothing about the source is content with the one the instance was configured
 * with; a request that names one at all has to name it properly, since a
 * half-written source is a mistake, not a request to use the configured one.
 */
export function readSourceSelection(body: unknown, configured?: string): Read<string> {
  const named = asRecord(body)?.source;
  if (named === undefined) {
    return configured === undefined
      ? { ok: false, message: notSupplied("No ticket source to read tickets from", SOURCE_SHAPE) }
      : { ok: true, value: configured };
  }

  const source = asRecord(named);
  if (!source) return { ok: false, message: SOURCE_SHAPE };

  if (source.type !== "local") {
    return {
      ok: false,
      message: `Unknown ticket source type ${JSON.stringify(source.type)} — only "local" is supported`,
    };
  }

  const directory = source.directory;
  if (typeof directory !== "string" || directory.trim() === "") {
    return { ok: false, message: `A local ticket source needs a directory. ${SOURCE_SHAPE}` };
  }

  return { ok: true, value: directory };
}

/**
 * What the user did to the Queue before running it. Saying nothing is saying the
 * Queue is fine as the Ticket Source wrote it; saying anything at all has to say
 * it as lists of ticket ids, since a half-read edit is a queue the user thinks
 * they changed and did not.
 */
export function readQueueEdit(body: unknown): Read<QueueEdit> {
  const named = asRecord(body)?.queue;
  if (named === undefined) return { ok: true, value: unedited() };

  const queue = asRecord(named);
  if (!queue) return { ok: false, message: QUEUE_SHAPE };

  const exclude = readTicketIds(queue.exclude, "exclude");
  if (!exclude.ok) return exclude;

  const order = readTicketIds(queue.order, "order");
  if (!order.ok) return order;

  return { ok: true, value: { exclude: exclude.value, order: order.value } };
}

function readTicketIds(value: unknown, field: string): Read<string[]> {
  if (value === undefined) return { ok: true, value: [] };

  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id.trim() === "")) {
    return { ok: false, message: `"${field}" must be a list of ticket ids. ${QUEUE_SHAPE}` };
  }

  return { ok: true, value: value as string[] };
}
