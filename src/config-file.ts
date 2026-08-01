import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { messageOf } from "./errors.js";
import { EVENT_TYPES } from "./events.js";
import { asRecord } from "./json.js";
import type { NotificationSettings } from "./notifications/settings.js";
import { isWebhookUrl } from "./notifications/webhook.js";
import type { SafetyStops } from "./queue/safety.js";
import { PERMISSION_MODES, type ClaudeCodeRunnerOptions } from "./runner/claude-code.js";
import { isRepositoryName, type SourceSelection } from "./tickets/source.js";
import type { ReviewSettings } from "./verification/review.js";
import { isVerification } from "./verification/verifier.js";

/** What an instance's config file is called, unless it is pointed at another one. */
export const CONFIG_FILENAME = "supervisor.config.json";

/**
 * What a start request falls back to when it does not say for itself. Each field
 * stands alone: settling a project's directory in the file and its verification
 * in the request is a perfectly good way to run.
 */
export interface QueueRunDefaults {
  /** The Ticket Source this instance minds, when the file settles which it is. */
  source?: SourceSelection;
  projectDirectory?: string;
  verify?: string[];
  pushCheckpoints?: boolean;
}

/** The file's say on each setting — everything it did not mention is left out. */
export interface FileSettings {
  dataDir?: string;
  port?: number;
  host?: string;
  logLevel?: string;
  model?: string;
  permissionMode?: ClaudeCodeRunnerOptions["permissionMode"];
  attemptBudget?: number;
  /** Whatever the file said about being told things; the rest is defaulted after. */
  notifications?: Partial<NotificationSettings>;
  /** Whatever the file said about reviewing Attempts; the rest is defaulted after. */
  review?: Partial<ReviewSettings>;
  /** Whatever the file said about how far a run may go; the rest is defaulted after. */
  safety?: Partial<SafetyStops>;
  defaults: QueueRunDefaults;
}

const FILE_SETTINGS = [
  "dataDir",
  "port",
  "host",
  "logLevel",
  "attemptBudget",
  "runner",
  "source",
  "notifications",
  "review",
  "safety",
  "project",
];
const RUNNER_SETTINGS = ["model", "permissionMode"];
const SOURCE_SETTINGS = ["type", "directory", "repository"];
const NOTIFICATION_SETTINGS = ["enabled", "webhook", "on"];
const REVIEW_SETTINGS = ["enabled"];
const SAFETY_SETTINGS = ["maxTickets", "maxRuntimeMinutes", "consecutiveFailures"];
const PROJECT_SETTINGS = ["directory", "verify", "pushCheckpoints"];

export const HIGHEST_PORT = 65_535;

/**
 * Reads the settings an instance was configured with. The file nobody named may
 * simply not exist — then every setting is a default or an environment variable —
 * but an instance pointed at a file explicitly has to find the file it was sent to.
 */
export function readConfigFile(named: string | undefined, cwd: string): FileSettings {
  const path = resolve(cwd, named ?? CONFIG_FILENAME);
  const contents = readContents(path, named !== undefined);

  return contents === undefined ? { defaults: {} } : parseSettings(path, parseJson(path, contents));
}

function readContents(path: string, required: boolean): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read the config file at ${path}: ${messageOf(error)}`);
  }
}

function parseJson(path: string, contents: string): unknown {
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${messageOf(error)}`);
  }
}

function parseSettings(path: string, raw: unknown): FileSettings {
  const settings = asRecord(raw);
  if (settings === undefined) {
    throw new Error(`${path} must hold a JSON object of settings`);
  }
  refuseUnknown(path, settings, FILE_SETTINGS, "");

  const runner = section(path, settings.runner, RUNNER_SETTINGS, "runner");
  const source = section(path, settings.source, SOURCE_SETTINGS, "source");
  const notifications = section(path, settings.notifications, NOTIFICATION_SETTINGS, "notifications");
  const reviewing = section(path, settings.review, REVIEW_SETTINGS, "review");
  const safety = section(path, settings.safety, SAFETY_SETTINGS, "safety");
  const project = section(path, settings.project, PROJECT_SETTINGS, "project");

  const dataDir = directory(path, settings.dataDir, "dataDir");
  const port = wholePort(path, settings.port);
  const host = text(path, settings.host, "host");
  const logLevel = text(path, settings.logLevel, "logLevel");
  const attemptBudget = budget(path, settings.attemptBudget);
  const model = text(path, runner.model, "runner.model");
  const permissionMode = mode(path, runner.permissionMode);
  const ticketSource = sourceSelection(path, source);
  const told = notificationSettings(path, notifications);
  const reviewsAttempts = flag(path, reviewing.enabled, "review.enabled");
  const stops = safetyStops(path, safety);
  const projectDirectory = directory(path, project.directory, "project.directory");
  const verify = commands(path, project.verify);
  const pushCheckpoints = flag(path, project.pushCheckpoints, "project.pushCheckpoints");

  return {
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(port === undefined ? {} : { port }),
    ...(host === undefined ? {} : { host }),
    ...(logLevel === undefined ? {} : { logLevel }),
    ...(model === undefined ? {} : { model }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(attemptBudget === undefined ? {} : { attemptBudget }),
    ...(told === undefined ? {} : { notifications: told }),
    ...(reviewsAttempts === undefined ? {} : { review: { enabled: reviewsAttempts } }),
    ...(stops === undefined ? {} : { safety: stops }),
    defaults: {
      ...(ticketSource === undefined ? {} : { source: ticketSource }),
      ...(projectDirectory === undefined ? {} : { projectDirectory }),
      ...(verify === undefined ? {} : { verify }),
      ...(pushCheckpoints === undefined ? {} : { pushCheckpoints }),
    },
  };
}

function section(
  path: string,
  value: unknown,
  known: string[],
  name: string,
): Record<string, unknown> {
  if (value === undefined) return {};

  const record = asRecord(value);
  if (record === undefined) {
    throw new Error(`${setting(path, name)} must be a JSON object`);
  }
  refuseUnknown(path, record, known, name);
  return record;
}

/**
 * A setting nobody recognises is nearly always a misspelling of one that matters,
 * and a misspelled setting that is quietly ignored is a setting that never
 * applied — worth stopping the Supervisor for, rather than finding out at 3am.
 */
function refuseUnknown(
  path: string,
  record: Record<string, unknown>,
  known: string[],
  within: string,
): void {
  const strange = Object.keys(record).filter((key) => !known.includes(key));
  if (strange.length === 0) return;

  const where = within === "" ? path : setting(path, within);
  throw new Error(
    `${where} has no setting called ${strange.map(quote).join(" or ")} — ` +
      `it understands ${known.join(", ")}`,
  );
}

function text(path: string, value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${setting(path, name)} must be a non-empty string, got ${quote(value)}`);
  }
  return value.trim();
}

/**
 * A path in the file is read against the file's own directory, not against
 * wherever the Supervisor happened to be started from — the settings travel with
 * the deployment, so what they point at should travel with it too.
 */
function directory(path: string, value: unknown, name: string): string | undefined {
  const written = text(path, value, name);
  return written === undefined ? undefined : resolve(dirname(path), written);
}

/**
 * A setting that is only ever on or off. `"false"` in quotes is a string, and a
 * string is not a switch — a project that meant to stop pushing would go on
 * pushing all night.
 */
function flag(path: string, value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${setting(path, name)} must be true or false, got ${quote(value)}`);
  }
  return value;
}

/**
 * How many Attempts one ticket may spend. Zero would be a Supervisor that runs
 * nothing at all, and a fraction of an Attempt is not a thing — either is a
 * number that meant something else, and neither is worth finding out at 3am.
 */
function budget(path: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(
      `${setting(path, "attemptBudget")} must be a whole number of attempts, at least 1, ` +
        `got ${quote(value)}`,
    );
  }
  return value as number;
}

function commands(path: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!isVerification(value)) {
    throw new Error(
      `${setting(path, "project.verify")} must list at least one shell command, ` +
        `and every Attempt must pass all of them`,
    );
  }
  return value;
}

/**
 * Which Ticket Source this instance minds. The type decides what else the section
 * has to say — a local source is a directory, a GitHub one an `owner/name` — so a
 * setting belonging to the other kind is a source that was never going to work.
 * A source that names its kind and nothing else settles nothing, and the start
 * request has to say where its tickets are.
 */
function sourceSelection(
  path: string,
  source: Record<string, unknown>,
): SourceSelection | undefined {
  if (sourceType(path, source.type) === "github") {
    refuseMisplaced(path, source, "directory", "github", "repository");

    const repository = text(path, source.repository, "source.repository");
    if (repository !== undefined && !isRepositoryName(repository)) {
      throw new Error(
        `${setting(path, "source.repository")} must be the "owner/name" of a repository, ` +
          `got ${quote(repository)}`,
      );
    }
    return repository === undefined ? undefined : { type: "github", repository };
  }

  refuseMisplaced(path, source, "repository", "local", "directory");
  const where = directory(path, source.directory, "source.directory");
  return where === undefined ? undefined : { type: "local", directory: where };
}

/**
 * A source pointed the way the other kind of source is pointed was never going to
 * read anything, and saying so beats the setting simply not applying.
 */
function refuseMisplaced(
  path: string,
  source: Record<string, unknown>,
  strange: string,
  type: string,
  instead: string,
): void {
  if (source[strange] === undefined) return;

  throw new Error(
    `${setting(path, `source.${strange}`)} belongs to the other kind of ticket source — ` +
      `a ${type} source is pointed at a "${instead}"`,
  );
}

/** One Ticket Source per queue, and there are two kinds of them. */
function sourceType(path: string, value: unknown): SourceSelection["type"] {
  if (value === undefined || value === "local") return "local";
  if (value === "github") return "github";

  throw new Error(
    `${setting(path, "source.type")} must be "local" or "github", got ${quote(value)}`,
  );
}

/**
 * What this instance tells somebody about, and where it tells them. Nothing said
 * about notifications at all is left undefined rather than defaulted here, so the
 * defaults stay in the one place every other default lives.
 */
function notificationSettings(
  path: string,
  told: Record<string, unknown>,
): Partial<NotificationSettings> | undefined {
  const enabled = flag(path, told.enabled, "notifications.enabled");
  const webhook = text(path, told.webhook, "notifications.webhook");
  if (webhook !== undefined && !isWebhookUrl(webhook)) {
    throw new Error(
      `${setting(path, "notifications.webhook")} must be an http or https URL to post to ` +
        `— https://ntfy.sh/your-topic is one — got ${quote(webhook)}`,
    );
  }
  const on = eventSwitches(path, told.on);

  if (enabled === undefined && webhook === undefined && on === undefined) return undefined;
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(webhook === undefined ? {} : { webhook }),
    ...(on === undefined ? {} : { on }),
  };
}

/** Which kinds of Event this instance was told to be silent about, and no more. */
function eventSwitches(path: string, value: unknown): NotificationSettings["on"] | undefined {
  if (value === undefined) return undefined;

  const record = section(path, value, EVENT_TYPES, "notifications.on");
  const on: NotificationSettings["on"] = {};
  for (const type of EVENT_TYPES) {
    const said = flag(path, record[type], `notifications.on.${type}`);
    if (said !== undefined) on[type] = said;
  }
  return on;
}

/**
 * How far a run of this instance may go on its own. Nothing said about the stops
 * at all is left undefined rather than defaulted here, so the defaults stay in
 * the one place every other default lives.
 */
function safetyStops(
  path: string,
  safety: Record<string, unknown>,
): Partial<SafetyStops> | undefined {
  const maxTickets = allowance(path, safety.maxTickets, "safety.maxTickets", "tickets");
  const maxRuntimeMinutes = allowance(
    path,
    safety.maxRuntimeMinutes,
    "safety.maxRuntimeMinutes",
    "minutes",
  );
  const consecutiveFailures = allowance(
    path,
    safety.consecutiveFailures,
    "safety.consecutiveFailures",
    "tickets",
  );

  const said = [maxTickets, maxRuntimeMinutes, consecutiveFailures];
  if (said.every((stop) => stop === undefined)) return undefined;

  return {
    ...(maxTickets === undefined ? {} : { maxTickets }),
    ...(maxRuntimeMinutes === undefined ? {} : { maxRuntimeMinutes }),
    ...(consecutiveFailures === undefined ? {} : { consecutiveFailures }),
  };
}

/**
 * What one Safety stop allows: a whole number of whatever it counts, or `null`
 * for a stop this instance does not want at all. Zero would be a run that stopped
 * before it began, which is nobody's intention — and a stop the file switched off
 * on purpose is not the same as one it never mentioned, which is why it takes a
 * word of its own rather than a number that happens to mean nothing.
 */
function allowance(
  path: string,
  value: unknown,
  name: string,
  counted: string,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;

  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(
      `${setting(path, name)} must be a whole number of ${counted}, at least 1, ` +
        `or null for no such stop — got ${quote(value)}`,
    );
  }
  return value as number;
}

function wholePort(path: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > HIGHEST_PORT) {
    throw new Error(
      `${setting(path, "port")} must be an integer between 0 and ${HIGHEST_PORT}, ` +
        `got ${quote(value)}`,
    );
  }
  return value as number;
}

function mode(path: string, value: unknown): ClaudeCodeRunnerOptions["permissionMode"] | undefined {
  if (value === undefined) return undefined;

  const found = PERMISSION_MODES.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new Error(
      `${setting(path, "runner.permissionMode")} must be one of ${PERMISSION_MODES.join(", ")}, ` +
        `got ${quote(value)}`,
    );
  }
  return found;
}

function setting(path: string, name: string): string {
  return `${path}: "${name}"`;
}

function quote(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}
