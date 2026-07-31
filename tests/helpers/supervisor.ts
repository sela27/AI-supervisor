import type { Clock } from "../../src/clock.js";
import { loadSupervisorConfig } from "../../src/config.js";
import type { Notifier } from "../../src/notifications/notifier.js";
import type { Runner } from "../../src/runner/runner.js";
import { startSupervisor } from "../../src/supervisor.js";
import type { GhCommand } from "../../src/tickets/gh.js";
import { createTempDirectory } from "./temp-dir.js";

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
  /** The Runner seam; tests substitute a fake so no real Claude Code is launched. */
  runner?: Runner;
  /**
   * An instance directory holding the config file to boot from. Left out, the
   * Supervisor starts the way one with no config file does.
   */
  configDirectory?: string;
  /**
   * Time the test moves by hand, so a limit wait of days is proved in
   * milliseconds. Left out, the Supervisor runs on real time.
   */
  clock?: Clock;
  /**
   * The Notifier seam: what the Supervisor would have sent to a phone, captured
   * instead. Whether anything is sent at all is still the config file's to decide.
   */
  notifier?: Notifier;
  /**
   * A `gh` of the test's own, standing in for the CLI so a queue of GitHub issues
   * is run without a live repository anywhere near it.
   */
  gh?: GhCommand;
}

export async function startTestSupervisor(
  options: TestSupervisorOptions = {},
): Promise<TestSupervisor> {
  const dataDir = options.dataDir ?? (await createTempDirectory("supervisor-test-"));
  // Read the real way, from the real file, so what a test configures reaches the
  // API by the same path a deployed instance's settings do.
  const config = loadSupervisorConfig({ cwd: options.configDirectory ?? dataDir, env: {} });

  const supervisor = await startSupervisor({
    // The two settings a test has to own: its own storage, and a port nobody else
    // is on. Everything else is the config file's to decide.
    config: { ...config, dataDir, port: 0, host: "127.0.0.1" },
    runner: options.runner,
    clock: options.clock,
    notifier: options.notifier,
    gh: options.gh,
  });

  return {
    url: supervisor.url,
    dataDir,
    request: (path, init) => fetch(new URL(path, supervisor.url), init),
    stop: () => supervisor.stop(),
  };
}
