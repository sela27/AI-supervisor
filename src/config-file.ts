import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { messageOf } from "./errors.js";
import { asRecord } from "./json.js";
import { PERMISSION_MODES, type ClaudeCodeRunnerOptions } from "./runner/claude-code.js";
import { isVerification } from "./verification/verifier.js";

/** What an instance's config file is called, unless it is pointed at another one. */
export const CONFIG_FILENAME = "supervisor.config.json";

/**
 * What a start request falls back to when it does not say for itself. Each field
 * stands alone: settling a project's directory in the file and its verification
 * in the request is a perfectly good way to run.
 */
export interface QueueRunDefaults {
  sourceDirectory?: string;
  projectDirectory?: string;
  verify?: string[];
}

/** The file's say on each setting — everything it did not mention is left out. */
export interface FileSettings {
  dataDir?: string;
  port?: number;
  host?: string;
  logLevel?: string;
  model?: string;
  permissionMode?: ClaudeCodeRunnerOptions["permissionMode"];
  defaults: QueueRunDefaults;
}

const FILE_SETTINGS = ["dataDir", "port", "host", "logLevel", "runner", "source", "project"];
const RUNNER_SETTINGS = ["model", "permissionMode"];
const SOURCE_SETTINGS = ["type", "directory"];
const PROJECT_SETTINGS = ["directory", "verify"];

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
  const project = section(path, settings.project, PROJECT_SETTINGS, "project");
  sourceType(path, source.type);

  const dataDir = directory(path, settings.dataDir, "dataDir");
  const port = wholePort(path, settings.port);
  const host = text(path, settings.host, "host");
  const logLevel = text(path, settings.logLevel, "logLevel");
  const model = text(path, runner.model, "runner.model");
  const permissionMode = mode(path, runner.permissionMode);
  const sourceDirectory = directory(path, source.directory, "source.directory");
  const projectDirectory = directory(path, project.directory, "project.directory");
  const verify = commands(path, project.verify);

  return {
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(port === undefined ? {} : { port }),
    ...(host === undefined ? {} : { host }),
    ...(logLevel === undefined ? {} : { logLevel }),
    ...(model === undefined ? {} : { model }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    defaults: {
      ...(sourceDirectory === undefined ? {} : { sourceDirectory }),
      ...(projectDirectory === undefined ? {} : { projectDirectory }),
      ...(verify === undefined ? {} : { verify }),
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

/** One Ticket Source per queue, and only one kind of source exists so far. */
function sourceType(path: string, value: unknown): void {
  if (value !== undefined && value !== "local") {
    throw new Error(
      `${setting(path, "source.type")} must be "local" — no other ticket source exists yet, ` +
        `got ${quote(value)}`,
    );
  }
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
