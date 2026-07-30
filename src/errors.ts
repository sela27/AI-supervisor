/** What an unknown thrown thing has to say for itself, whatever it turned out to be. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
