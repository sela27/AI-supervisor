const SOURCE_SHAPE =
  'A ticket source looks like { "source": { "type": "local", "directory": "/path/to/tickets" } }';

export type Read<T> = { ok: true; value: T } | { ok: false; message: string };

/** Which Ticket Source the request picked, and where it lives. */
export function readSourceSelection(body: unknown): Read<string> {
  const source = asRecord(asRecord(body)?.source);
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

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
