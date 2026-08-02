import {
  HIGHEST_PORT,
  modelId,
  oneOf,
  readConfigFile,
  type FileSettings,
  type QueueRunDefaults,
} from "./config-file.js";
import type { NotificationSettings } from "./notifications/settings.js";
import type { SafetyStops } from "./queue/safety.js";
import {
  PERMISSION_MODES,
  RUNNER_DRIVERS,
  type ClaudeCodeRunnerOptions,
} from "./runner/claude-code.js";
import type { ReviewSettings } from "./verification/review.js";

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
  /** What this instance tells somebody about, and where it tells them. */
  notifications: NotificationSettings;
  /** Whether Verification has a second stage on this instance, and it reads the work. */
  review: ReviewSettings;
  /** How far one run of this instance may go on its own before it stops. */
  safety: SafetyStops;
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
  /**
   * The Agent SDK: it is the path the Supervisor is built around, and it needs
   * nothing of the deployment but the executable it brings. The CLI beside it is
   * for the deployment where that turns out not to be true.
   */
  driver: "sdk",
  /** On, so that pointing an instance at a webhook is all it takes to be told. */
  notificationsEnabled: true,
  /**
   * Off: a review is a second Run against the same subscription for every Attempt
   * that already passed the project's own checks, and quota spent on reading is
   * quota not spent on the queue. An instance that wants the assurance asks.
   */
  reviewEnabled: false,
  /** The queue is the queue: how far a run gets is the work's to decide, not a number's. */
  maxTickets: null,
  maxRuntimeMinutes: null,
  /**
   * Three tickets refused one after another is a project that is broken rather
   * than a ticket that is, and there is no sense spending the night proving it.
   */
  consecutiveFailures: 3,
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

  const model = modelId("SUPERVISOR_MODEL", set(env.SUPERVISOR_MODEL)) ?? file.model;

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
        oneOf("SUPERVISOR_PERMISSION_MODE", set(env.SUPERVISOR_PERMISSION_MODE), PERMISSION_MODES) ??
        file.permissionMode ??
        DEFAULTS.permissionMode,
      driver:
        oneOf("SUPERVISOR_RUNNER_DRIVER", set(env.SUPERVISOR_RUNNER_DRIVER), RUNNER_DRIVERS) ??
        file.driver ??
        DEFAULTS.driver,
    },
    notifications: {
      enabled: file.notifications?.enabled ?? DEFAULTS.notificationsEnabled,
      ...(file.notifications?.webhook === undefined
        ? {}
        : { webhook: file.notifications.webhook }),
      on: file.notifications?.on ?? {},
    },
    review: { enabled: file.review?.enabled ?? DEFAULTS.reviewEnabled },
    safety: {
      maxTickets: stopSetTo(file.safety?.maxTickets, DEFAULTS.maxTickets),
      maxRuntimeMinutes: stopSetTo(file.safety?.maxRuntimeMinutes, DEFAULTS.maxRuntimeMinutes),
      consecutiveFailures: stopSetTo(
        file.safety?.consecutiveFailures,
        DEFAULTS.consecutiveFailures,
      ),
    },
    defaults: file.defaults,
  };
}

/**
 * What the file set one Safety stop to, `null` included. A stop switched off on
 * purpose is not a stop nobody mentioned, and `??` cannot tell them apart.
 */
function stopSetTo(said: number | null | undefined, fallback: number | null): number | null {
  return said === undefined ? fallback : said;
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
