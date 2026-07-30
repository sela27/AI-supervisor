import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startSupervisor } from "../../src/supervisor.js";

/**
 * A Supervisor booted for a single test: the real service, real SQLite, a real
 * HTTP port, and a throwaway data directory. Tests drive it only through
 * `request` — the HTTP API is the seam.
 */
export interface TestSupervisor {
  url: string;
  dataDir: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  /** Shuts the service down but leaves the data directory in place. */
  stop: () => Promise<void>;
}

export interface TestSupervisorOptions {
  /** Reuse an existing data directory, e.g. to restart onto the same storage. */
  dataDir?: string;
}

const createdDataDirs = new Set<string>();

export async function startTestSupervisor(
  options: TestSupervisorOptions = {},
): Promise<TestSupervisor> {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), "supervisor-test-")));
  createdDataDirs.add(dataDir);

  const supervisor = await startSupervisor({ dataDir, port: 0, host: "127.0.0.1" });

  return {
    url: supervisor.url,
    dataDir,
    request: (path, init) => fetch(new URL(path, supervisor.url), init),
    stop: () => supervisor.stop(),
  };
}

/** Removes every data directory this helper created. Call from a test teardown. */
export async function removeTestDataDirs(): Promise<void> {
  for (const dir of createdDataDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  createdDataDirs.clear();
}
