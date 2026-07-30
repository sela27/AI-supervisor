/**
 * Narrows parsed JSON to something with named fields. Arrays and `null` are
 * objects to `typeof` but never settings or request bodies, so neither counts.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
