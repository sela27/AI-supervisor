import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created = new Set<string>();

/** Makes a throwaway directory for one test; `removeTempDirectories` cleans it up. */
export async function createTempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  created.add(directory);
  return directory;
}

/** Removes every directory created so far. Call from a test teardown. */
export async function removeTempDirectories(): Promise<void> {
  for (const directory of created) {
    await rm(directory, { recursive: true, force: true });
  }
  created.clear();
}
