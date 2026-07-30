import { CONFIG_FILENAME } from "../config-file.js";
import { asRecord } from "../json.js";

const SOURCE_SHAPE =
  'A ticket source looks like { "source": { "type": "local", "directory": "/path/to/tickets" } }';

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
