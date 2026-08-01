/**
 * Narrows parsed JSON to something with named fields. Arrays and `null` are
 * objects to `typeof` but never settings or request bodies, so neither counts.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * What some text holds, where it holds JSON at all. Everything read this way came
 * from somewhere the Supervisor does not control — a column an older build wrote,
 * a line another process printed — so text that will not parse is text there is
 * nothing to be read out of, rather than a reason to stop.
 */
export function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
