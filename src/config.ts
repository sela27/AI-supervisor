import { PERMISSION_MODES, type ClaudeCodeRunnerOptions } from "./runner/claude-code.js";

export interface SupervisorConfig {
  dataDir: string;
  port: number;
  host: string;
  logLevel: string;
  /** How this instance drives Claude Code. One instance, one project, one setting. */
  runner: ClaudeCodeRunnerOptions;
}

const DEFAULTS = {
  dataDir: "./data",
  port: 4317,
  host: "0.0.0.0",
  logLevel: "info",
  /** Nothing may stop to ask: the whole point is that nobody is there to answer. */
  permissionMode: "bypassPermissions",
} as const;

/** Reads the Supervisor's settings from the environment. The only place env vars are read. */
export function loadSupervisorConfig(): SupervisorConfig {
  const env = process.env;
  return {
    dataDir: env.SUPERVISOR_DATA_DIR ?? DEFAULTS.dataDir,
    port: parsePort(env.SUPERVISOR_PORT) ?? DEFAULTS.port,
    host: env.SUPERVISOR_HOST ?? DEFAULTS.host,
    logLevel: env.SUPERVISOR_LOG_LEVEL ?? DEFAULTS.logLevel,
    runner: {
      // Left unset, the Claude Code CLI picks its own model.
      ...(env.SUPERVISOR_MODEL === undefined ? {} : { model: env.SUPERVISOR_MODEL }),
      permissionMode: parsePermissionMode(env.SUPERVISOR_PERMISSION_MODE),
    },
  };
}

function parsePermissionMode(value: string | undefined): ClaudeCodeRunnerOptions["permissionMode"] {
  if (value === undefined || value.trim() === "") return DEFAULTS.permissionMode;

  const mode = PERMISSION_MODES.find((candidate) => candidate === value.trim());
  if (mode === undefined) {
    throw new Error(
      `SUPERVISOR_PERMISSION_MODE must be one of ${PERMISSION_MODES.join(", ")}, got "${value}"`,
    );
  }
  return mode;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`SUPERVISOR_PORT must be an integer between 0 and 65535, got "${value}"`);
  }
  return port;
}
