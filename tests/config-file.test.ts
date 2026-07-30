import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

import { CONFIG_FILENAME } from "../src/config-file.js";
import { loadSupervisorConfig } from "../src/config.js";
import { createTempDirectory, removeTempDirectories } from "./helpers/temp-dir.js";

/**
 * Reading an instance's settings happens before there is a service to ask, so it
 * is the one thing the HTTP seam cannot reach: the whole point of a bad setting
 * is that the Supervisor never starts. It is covered directly instead, against
 * real files in a throwaway directory.
 */

afterEach(async () => {
  await removeTempDirectories();
});

/** An instance's directory, with the config file the test wants in it. */
async function instanceWith(settings: unknown): Promise<string> {
  const directory = await createTempDirectory("supervisor-config-");
  await writeFile(join(directory, CONFIG_FILENAME), JSON.stringify(settings, null, 2), "utf8");
  return directory;
}

async function withoutConfigFile(): Promise<string> {
  return createTempDirectory("supervisor-config-");
}

test("an instance with no config file to read keeps every default", async () => {
  const config = loadSupervisorConfig({ cwd: await withoutConfigFile(), env: {} });

  expect(config).toEqual({
    dataDir: "./data",
    port: 4317,
    host: "0.0.0.0",
    logLevel: "info",
    runner: { permissionMode: "bypassPermissions" },
    // Nothing to fall back on: a start request must say everything itself.
    defaults: {},
  });
});

test("the file carries every setting, so a run needs nothing but a start", async () => {
  const cwd = await instanceWith({
    dataDir: "./storage",
    port: 8080,
    host: "127.0.0.1",
    logLevel: "debug",
    runner: { model: "claude-opus-5", permissionMode: "acceptEdits" },
    source: { type: "local", directory: "./tickets" },
    project: { directory: "./app", verify: ["npm run typecheck", "npm test"] },
  });

  const config = loadSupervisorConfig({ cwd, env: {} });

  expect(config).toEqual({
    dataDir: join(cwd, "storage"),
    port: 8080,
    host: "127.0.0.1",
    logLevel: "debug",
    runner: { model: "claude-opus-5", permissionMode: "acceptEdits" },
    defaults: {
      sourceDirectory: join(cwd, "tickets"),
      projectDirectory: join(cwd, "app"),
      verify: ["npm run typecheck", "npm test"],
    },
  });
});

test("a directory is read against the file, not against wherever the service started", async () => {
  const elsewhere = await instanceWith({ source: { type: "local", directory: "./tickets" } });

  const config = loadSupervisorConfig({
    cwd: await withoutConfigFile(),
    env: { SUPERVISOR_CONFIG: join(elsewhere, CONFIG_FILENAME) },
  });

  // The settings travel with the deployment, so what they point at travels too.
  expect(config.defaults.sourceDirectory).toBe(join(elsewhere, "tickets"));
});

test("the environment overrides the file, so one container can differ from its image", async () => {
  const cwd = await instanceWith({
    port: 4317,
    logLevel: "info",
    runner: { model: "claude-opus-5" },
  });

  const config = loadSupervisorConfig({
    cwd,
    env: { SUPERVISOR_PORT: "5000", SUPERVISOR_MODEL: "claude-sonnet-5" },
  });

  expect(config.port).toBe(5000);
  expect(config.runner.model).toBe("claude-sonnet-5");
  // What the environment says nothing about is still the file's to decide.
  expect(config.logLevel).toBe("info");
});

test("an environment variable set to nothing is not a setting at all", async () => {
  const cwd = await instanceWith({ host: "127.0.0.1", logLevel: "debug", port: 8080 });

  // A compose file with a blank value in it must not beat a real setting.
  const config = loadSupervisorConfig({
    cwd,
    env: { SUPERVISOR_HOST: "", SUPERVISOR_LOG_LEVEL: "   ", SUPERVISOR_PORT: "" },
  });

  expect(config.host).toBe("127.0.0.1");
  expect(config.logLevel).toBe("debug");
  expect(config.port).toBe(8080);
});

test("a config file the instance was pointed at explicitly has to be there", async () => {
  const missing = join(await withoutConfigFile(), "elsewhere.json");

  expect(() => loadSupervisorConfig({ cwd: ".", env: { SUPERVISOR_CONFIG: missing } })).toThrow(
    missing,
  );
});

test("a config file that is not JSON is refused by name", async () => {
  const cwd = await withoutConfigFile();
  await writeFile(join(cwd, CONFIG_FILENAME), "{ port: 4317 }", "utf8");

  expect(() => loadSupervisorConfig({ cwd, env: {} })).toThrow(CONFIG_FILENAME);
});

test("a setting the Supervisor does not know is a typo worth stopping for", async () => {
  const cwd = await instanceWith({ verifiy: ["npm test"] });

  expect(() => loadSupervisorConfig({ cwd, env: {} })).toThrow(/verifiy/);
});

test("a typo nested inside a setting is caught the same way", async () => {
  const cwd = await instanceWith({ project: { directory: "./app", verfy: ["npm test"] } });

  expect(() => loadSupervisorConfig({ cwd, env: {} })).toThrow(/verfy/);
});

test("a setting of the wrong shape is refused at startup, not at the first run", async () => {
  const badPort = await instanceWith({ port: "soon" });
  expect(() => loadSupervisorConfig({ cwd: badPort, env: {} })).toThrow(/port/);

  const badHost = await instanceWith({ host: 8080 });
  expect(() => loadSupervisorConfig({ cwd: badHost, env: {} })).toThrow(/host/);

  const badSection = await instanceWith({ project: "./app" });
  expect(() => loadSupervisorConfig({ cwd: badSection, env: {} })).toThrow(/project/);
});

test("an unknown permission mode says which ones there are", async () => {
  const cwd = await instanceWith({ runner: { permissionMode: "yolo" } });

  expect(() => loadSupervisorConfig({ cwd, env: {} })).toThrow(/bypassPermissions/);
});

test("a ticket source of a type that does not exist yet is refused", async () => {
  const cwd = await instanceWith({ source: { type: "github", directory: "./tickets" } });

  expect(() => loadSupervisorConfig({ cwd, env: {} })).toThrow(/github/);
});

test("verification that could never refuse an Attempt is refused itself", async () => {
  const empty = await instanceWith({ project: { directory: "./app", verify: [] } });
  expect(() => loadSupervisorConfig({ cwd: empty, env: {} })).toThrow(/verify/);

  const blank = await instanceWith({ project: { directory: "./app", verify: ["  "] } });
  expect(() => loadSupervisorConfig({ cwd: blank, env: {} })).toThrow(/verify/);
});

test("a project may name its directory and leave verification to the start request", async () => {
  const cwd = await instanceWith({ project: { directory: "/work/app" } });

  const config = loadSupervisorConfig({ cwd, env: {} });

  expect(config.defaults).toEqual({ projectDirectory: resolve(cwd, "/work/app") });
});
