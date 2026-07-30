import {
  HIGHEST_PORT,
  readConfigFile,
  type FileSettings,
  type QueueRunDefaults,
} from "./config-file.js";
import { PERMISSION_MODES, type ClaudeCodeRunnerOptions } from "./runner/claude-code.js";

// Where the defaults come from is the file's business; what they are is every
// caller's, so they are part of the configuration's own surface.
export type { QueueRunDefaults };

export interface SupervisorConfig {
  dataDir: string;
  port: number;
  host: string;
  logLevel: string;
  /** How many Attempts one ticket gets before the run gives up on it. */
  attemptBudget: number;
  /** How this instance drives Claude Code. One instance, one project, one setting. */
  runner: ClaudeCodeRunnerOptions;
  /** What a start request falls back to when it does not say for itself. */
  defaults: QueueRunDefaults;
}

export interface LoadConfigOptions {
  /** Where an unnamed config file is looked for. The process's own by default. */
  cwd?: string;
  env?: Record<string, string | undefined>;
}

const DEFAULTS = {
  dataDir: "./data",
  port: 4317,
  host: "0.0.0.0",
  logLevel: "info",
  /** One retry: enough for a ticket that stumbled, short of burning the night on one. */
  attemptBudget: 2,
  /** Nothing may stop to ask: the whole point is that nobody is there to answer. */
  permissionMode: "bypassPermissions",
} as const;

/**
 * Reads an instance's settings: the config file first, then the environment over
 * the top of it. The environment wins because the file is baked into a
 * deployment while the environment is what one container can differ by.
 */
export function loadSupervisorConfig(options: LoadConfigOptions = {}): SupervisorConfig {
  const env = options.env ?? process.env;
  const file: FileSettings = readConfigFile(
    set(env.SUPERVISOR_CONFIG),
    options.cwd ?? process.cwd(),
  );

  const model = set(env.SUPERVISOR_MODEL) ?? file.model;

  return {
    dataDir: set(env.SUPERVISOR_DATA_DIR) ?? file.dataDir ?? DEFAULTS.dataDir,
    port: envPort(env.SUPERVISOR_PORT) ?? file.port ?? DEFAULTS.port,
    host: set(env.SUPERVISOR_HOST) ?? file.host ?? DEFAULTS.host,
    logLevel: set(env.SUPERVISOR_LOG_LEVEL) ?? file.logLevel ?? DEFAULTS.logLevel,
    attemptBudget: file.attemptBudget ?? DEFAULTS.attemptBudget,
    runner: {
      // Left unset, the Claude Code CLI picks its own model.
      ...(model === undefined ? {} : { model }),
      permissionMode:
        envPermissionMode(env.SUPERVISOR_PERMISSION_MODE) ??
        file.permissionMode ??
        DEFAULTS.permissionMode,
    },
    defaults: file.defaults,
  };
}

/**
 * An empty environment variable is an unset one — a shell has no other way to say
 * it, and an env file with a blank line in it must not beat the config file with
 * an empty string.
 */
function set(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text === undefined || text === "" ? undefined : text;
}

function envPort(value: string | undefined): number | undefined {
  const written = set(value);
  if (written === undefined) return undefined;

  const port = Number(written);
  if (!Number.isInteger(port) || port < 0 || port > HIGHEST_PORT) {
    throw new Error(
      `SUPERVISOR_PORT must be an integer between 0 and ${HIGHEST_PORT}, got "${written}"`,
    );
  }
  return port;
}

function envPermissionMode(
  value: string | undefined,
): ClaudeCodeRunnerOptions["permissionMode"] | undefined {
  const written = set(value);
  if (written === undefined) return undefined;

  const mode = PERMISSION_MODES.find((candidate) => candidate === written);
  if (mode === undefined) {
    throw new Error(
      `SUPERVISOR_PERMISSION_MODE must be one of ${PERMISSION_MODES.join(", ")}, got "${written}"`,
    );
  }
  return mode;
}
