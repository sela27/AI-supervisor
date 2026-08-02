import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

import { CONFIG_FILENAME } from "../src/config-file.js";
import { loadSupervisorConfig } from "../src/config.js";
import { instanceWith, instanceWithoutConfigFile } from "./helpers/config-file.js";
import { removeTempDirectories } from "./helpers/temp-dir.js";

/**
 * Reading an instance's settings happens before there is a service to ask, so it
 * is the one thing the HTTP seam cannot reach: the whole point of a bad setting
 * is that the Supervisor never starts. It is covered directly instead, against
 * real files in a throwaway directory.
 */

afterEach(async () => {
  await removeTempDirectories();
});

test("an instance with no config file to read keeps every default", async () => {
  const config = loadSupervisorConfig({ cwd: await instanceWithoutConfigFile(), env: {} });

  expect(config).toEqual({
    dataDir: "./data",
    port: 4317,
    host: "0.0.0.0",
    logLevel: "info",
    // One retry per ticket, as the glossary has it.
    attemptBudget: 2,
    // The Agent SDK, which needs nothing of the deployment but what it brings.
    runner: { permissionMode: "bypassPermissions", driver: "sdk" },
    // Willing to say anything, with nowhere to say it: pointing an instance at a
    // webhook is the whole of what it takes to start being told.
    notifications: { enabled: true, on: {} },
    // Verification is the project's own commands and nothing else: a second Run
    // per Attempt is quota nobody asked to spend.
    review: { enabled: false },
    // The queue is the queue and the night is the night; the one thing an
    // unconfigured instance will not sit through is a project that is broken.
    safety: { maxTickets: null, maxRuntimeMinutes: null, consecutiveFailures: 3 },
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
    attemptBudget: 3,
    runner: { model: "claude-opus-5", permissionMode: "acceptEdits", driver: "cli" },
    source: { type: "local", directory: "./tickets" },
    notifications: {
      enabled: true,
      webhook: "https://ntfy.sh/my-topic",
      on: { "long-wait": false },
    },
    review: { enabled: true },
    safety: { maxTickets: 8, maxRuntimeMinutes: 480, consecutiveFailures: 2 },
    project: {
      directory: "./app",
      verify: ["npm run typecheck", "npm test"],
      pushCheckpoints: false,
    },
  });

  const config = loadSupervisorConfig({ cwd, env: {} });

  expect(config).toEqual({
    dataDir: join(cwd, "storage"),
    port: 8080,
    host: "127.0.0.1",
    logLevel: "debug",
    attemptBudget: 3,
    runner: { model: "claude-opus-5", permissionMode: "acceptEdits", driver: "cli" },
    notifications: {
      enabled: true,
      webhook: "https://ntfy.sh/my-topic",
      on: { "long-wait": false },
    },
    review: { enabled: true },
    safety: { maxTickets: 8, maxRuntimeMinutes: 480, consecutiveFailures: 2 },
    defaults: {
      source: { type: "local", directory: join(cwd, "tickets") },
      projectDirectory: join(cwd, "app"),
      verify: ["npm run typecheck", "npm test"],
      pushCheckpoints: false,
    },
  });
});

test("a directory is read against the file, not against wherever the service started", async () => {
  const elsewhere = await instanceWith({ source: { type: "local", directory: "./tickets" } });

  const config = loadSupervisorConfig({
    cwd: await instanceWithoutConfigFile(),
    env: { SUPERVISOR_CONFIG: join(elsewhere, CONFIG_FILENAME) },
  });

  // The settings travel with the deployment, so what they point at travels too.
  expect(config.defaults.source).toEqual({
    type: "local",
    directory: join(elsewhere, "tickets"),
  });
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
  const cwd = await instanceWith({
    host: "127.0.0.1",
    logLevel: "debug",
    port: 8080,
    runner: { model: "claude-opus-5" },
  });

  // A compose file with a blank value in it must not beat a real setting — nor
  // read as a setting of its own, which for the model would refuse to start.
  const config = loadSupervisorConfig({
    cwd,
    env: {
      SUPERVISOR_HOST: "",
      SUPERVISOR_LOG_LEVEL: "   ",
      SUPERVISOR_PORT: "",
      SUPERVISOR_MODEL: "  ",
    },
  });

  expect(config.host).toBe("127.0.0.1");
  expect(config.logLevel).toBe("debug");
  expect(config.port).toBe(8080);
  expect(config.runner.model).toBe("claude-opus-5");
});

test("a config file the instance was pointed at explicitly has to be there", async () => {
  const missing = join(await instanceWithoutConfigFile(), "elsewhere.json");

  expect(() => loadSupervisorConfig({ cwd: ".", env: { SUPERVISOR_CONFIG: missing } })).toThrow(
    missing,
  );
});

test("a config file that is not JSON is refused by name", async () => {
  const cwd = await instanceWithoutConfigFile();
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

test("a model that could never be one is refused while somebody is still looking", async () => {
  // The failure it saves is the expensive one: an instance that boots on a model
  // no API knows fails every Attempt of the night on a 404, and the morning finds
  // a spelling mistake that cost a queue.
  // Named by whichever way it arrived, and both accepted shapes said back: what is
  // being refused is nearly always one of them, written the way a person says it.
  const spoken = await instanceWith({ runner: { model: "Opus 5" } });
  expect(() => loadSupervisorConfig({ cwd: spoken, env: {} })).toThrow(
    /runner\.model.*opus.*claude-opus-5/s,
  );

  const cwd = await instanceWith({});
  expect(() => loadSupervisorConfig({ cwd, env: { SUPERVISOR_MODEL: "Opus 5" } })).toThrow(
    /SUPERVISOR_MODEL.*opus.*claude-opus-5/s,
  );

  // A model called nothing at all is no more a model than a spoken one is.
  const blank = await instanceWith({ runner: { model: "  " } });
  expect(() => loadSupervisorConfig({ cwd: blank, env: {} })).toThrow(/runner\.model/);
});

test("every shape a model is really named by is left alone", async () => {
  const named = async (model: string): Promise<string | undefined> =>
    loadSupervisorConfig({ cwd: await instanceWith({ runner: { model } }), env: {} }).runner.model;

  expect(await named("opus")).toBe("opus");
  expect(await named("claude-opus-5")).toBe("claude-opus-5");
  expect(await named("anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(
    "anthropic.claude-sonnet-4-5-20250929-v1:0",
  );
  expect(await named("claude-sonnet-4-5@20250929")).toBe("claude-sonnet-4-5@20250929");

  // A model that does not exist but could have is not this check's to catch: its
  // first Attempt fails at once, at no cost, in the API's own words.
  expect(await named("claude-opus-9")).toBe("claude-opus-9");
});

test("an unknown permission mode says which ones there are", async () => {
  const cwd = await instanceWith({ runner: { permissionMode: "yolo" } });

  expect(() => loadSupervisorConfig({ cwd, env: {} })).toThrow(/bypassPermissions/);
});

test("an instance can be told to drive its Runs through the CLI instead", async () => {
  // The fallback exists for the deployment the Agent SDK cannot run in, which is
  // exactly the thing one container differs from its image by — so the
  // environment can say it without the image being rebuilt around it.
  const sdk = await instanceWith({ runner: { driver: "sdk" } });
  expect(loadSupervisorConfig({ cwd: sdk, env: {} }).runner.driver).toBe("sdk");
  expect(
    loadSupervisorConfig({ cwd: sdk, env: { SUPERVISOR_RUNNER_DRIVER: "cli" } }).runner.driver,
  ).toBe("cli");

  const nonsense = await instanceWith({ runner: { driver: "telepathy" } });
  expect(() => loadSupervisorConfig({ cwd: nonsense, env: {} })).toThrow(/sdk, cli/);
  expect(() =>
    loadSupervisorConfig({ cwd: sdk, env: { SUPERVISOR_RUNNER_DRIVER: "telepathy" } }),
  ).toThrow(/sdk, cli/);
});

test("a ticket source of a type that does not exist is refused", async () => {
  const cwd = await instanceWith({ source: { type: "jira", directory: "./tickets" } });

  expect(() => loadSupervisorConfig({ cwd, env: {} })).toThrow(/jira/);
});

test("a source settled by a setting the other kind of source uses is refused", async () => {
  // Each kind is pointed somewhere its own way, so a setting from the other kind
  // is a source that was never going to read anything.
  const misplaced = await instanceWith({ source: { type: "github", directory: "./tickets" } });
  expect(() => loadSupervisorConfig({ cwd: misplaced, env: {} })).toThrow(/directory/);

  // A bare repository name only means anything from inside a clone of it, and the
  // Supervisor is standing in the project rather than in the tracker.
  const bare = await instanceWith({ source: { type: "github", repository: "AI-supervisor" } });
  expect(() => loadSupervisorConfig({ cwd: bare, env: {} })).toThrow(/owner\/name/);

  const github = await instanceWith({ source: { type: "github", repository: "sela27/AI-supervisor" } });
  expect(loadSupervisorConfig({ cwd: github, env: {} }).defaults.source).toEqual({
    type: "github",
    repository: "sela27/AI-supervisor",
  });
});

test("a webhook that could never be posted to is refused while somebody is reading", async () => {
  // The one setting whose own failure has nowhere to be reported: a notification
  // that cannot be delivered is a notification nobody hears about.
  const typo = await instanceWith({ notifications: { webhook: "ntfy.sh/my-topic" } });
  expect(() => loadSupervisorConfig({ cwd: typo, env: {} })).toThrow(/webhook/);

  const wrongProtocol = await instanceWith({ notifications: { webhook: "ftp://example.test/x" } });
  expect(() => loadSupervisorConfig({ cwd: wrongProtocol, env: {} })).toThrow(/webhook/);
});

test("a switch for an Event that does not exist says which ones there are", async () => {
  const cwd = await instanceWith({ notifications: { on: { "ticket-skipped": false } } });

  expect(() => loadSupervisorConfig({ cwd, env: {} })).toThrow(/ticket-failed/);
});

test("silence has to be asked for with a switch, not with a word that looks like one", async () => {
  // `"false"` in quotes is a string, and a string is truthy: an instance meant to
  // run silently would spend the night saying everything.
  const written = await instanceWith({ notifications: { enabled: "false" } });
  expect(() => loadSupervisorConfig({ cwd: written, env: {} })).toThrow(/enabled/);

  const perEvent = await instanceWith({ notifications: { on: { "long-wait": "no" } } });
  expect(() => loadSupervisorConfig({ cwd: perEvent, env: {} })).toThrow(/long-wait/);
});

test("a review has to be switched on with a switch, and only a switch it knows", async () => {
  const written = await instanceWith({ review: { enabled: "yes" } });
  expect(() => loadSupervisorConfig({ cwd: written, env: {} })).toThrow(/review.enabled/);

  // Every other spelling of it is a review that would never have happened, and
  // an instance that thought it was reviewing all night is worse than one that
  // never started.
  const typo = await instanceWith({ review: { enable: true } });
  expect(() => loadSupervisorConfig({ cwd: typo, env: {} })).toThrow(/enable/);
});

test("verification that could never refuse an Attempt is refused itself", async () => {
  const empty = await instanceWith({ project: { directory: "./app", verify: [] } });
  expect(() => loadSupervisorConfig({ cwd: empty, env: {} })).toThrow(/verify/);

  const blank = await instanceWith({ project: { directory: "./app", verify: ["  "] } });
  expect(() => loadSupervisorConfig({ cwd: blank, env: {} })).toThrow(/verify/);
});

test("pushing is a switch, so a setting that only looks like one is refused", async () => {
  // `"false"` in quotes would be truthy, and the project would push all night.
  const cwd = await instanceWith({ project: { directory: "./app", pushCheckpoints: "false" } });

  expect(() => loadSupervisorConfig({ cwd, env: {} })).toThrow(/pushCheckpoints/);
});

test("an attempt budget that is not a number of attempts is refused", async () => {
  // Nothing at all would run under a budget of none, and half an Attempt is not a
  // thing — either is a number that was meant to say something else.
  const none = await instanceWith({ attemptBudget: 0 });
  expect(() => loadSupervisorConfig({ cwd: none, env: {} })).toThrow(/attemptBudget/);

  const part = await instanceWith({ attemptBudget: 1.5 });
  expect(() => loadSupervisorConfig({ cwd: part, env: {} })).toThrow(/attemptBudget/);

  const written = await instanceWith({ attemptBudget: "two" });
  expect(() => loadSupervisorConfig({ cwd: written, env: {} })).toThrow(/attemptBudget/);
});

test("a Safety stop switched off on purpose is not one nobody mentioned", async () => {
  const cwd = await instanceWith({ safety: { consecutiveFailures: null } });

  const config = loadSupervisorConfig({ cwd, env: {} });

  // An instance that wants a broken night run out to the end has to be able to
  // say so — and saying so must not read as having said nothing, which is what
  // would quietly hand back the default of three.
  expect(config.safety.consecutiveFailures).toBeNull();
});

test("a Safety stop set to a number that stops nothing is refused", async () => {
  // Zero would be a run that stopped before it began, and half a ticket is not a
  // thing — either is a number that was meant to say something else.
  const none = await instanceWith({ safety: { maxTickets: 0 } });
  expect(() => loadSupervisorConfig({ cwd: none, env: {} })).toThrow(/maxTickets/);

  const part = await instanceWith({ safety: { maxRuntimeMinutes: 12.5 } });
  expect(() => loadSupervisorConfig({ cwd: part, env: {} })).toThrow(/maxRuntimeMinutes/);

  // An hour written the way a person says it is not a number of minutes.
  const written = await instanceWith({ safety: { maxRuntimeMinutes: "8h" } });
  expect(() => loadSupervisorConfig({ cwd: written, env: {} })).toThrow(/maxRuntimeMinutes/);
});

test("a Safety stop that does not exist says which ones there are", async () => {
  const cwd = await instanceWith({ safety: { maxAttempts: 4 } });

  expect(() => loadSupervisorConfig({ cwd, env: {} })).toThrow(/maxTickets/);
});

test("a project may name its directory and leave verification to the start request", async () => {
  const cwd = await instanceWith({ project: { directory: "/work/app" } });

  const config = loadSupervisorConfig({ cwd, env: {} });

  expect(config.defaults).toEqual({ projectDirectory: resolve(cwd, "/work/app") });
});
