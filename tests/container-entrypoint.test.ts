import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

import { createTempDirectory, removeTempDirectories } from "./helpers/temp-dir.js";

const execFileAsync = promisify(execFile);

const ENTRYPOINT = fileURLToPath(new URL("../docker/entrypoint.sh", import.meta.url));

afterEach(async () => {
  await removeTempDirectories();
});

/**
 * Runs the container's entrypoint over a global git config of its own, and
 * answers what the command it was handed printed. The script is the one part of
 * the deployment that is not the service — nothing about it can be reached
 * through the HTTP seam, and everything about it decides whether a night can
 * commit at all.
 */
async function enter(
  environment: Record<string, string>,
  ...command: string[]
): Promise<{ stdout: string; config: string; again: () => Promise<string> }> {
  const home = await createTempDirectory("supervisor-entrypoint-");
  const env = {
    ...process.env,
    HOME: home,
    // Where "global" is, for git and for anything the script asks git to do.
    // Set outright so the test never reads or writes the machine's own config.
    GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    ...environment,
  };

  const { stdout } = await execFileAsync("sh", [ENTRYPOINT, ...command], { env });
  const listing = ["config", "--global", "--list"];
  const settled = async (): Promise<string> => {
    const { stdout: config } = await execFileAsync("git", listing, { env });
    return config;
  };

  return {
    stdout,
    config: await settled(),
    // The same container coming up again, over the config the first one left.
    again: async () => {
      await execFileAsync("sh", [ENTRYPOINT, "true"], { env });
      return settled();
    },
  };
}

test("a container told nothing still has an identity to commit Checkpoints under", async () => {
  const { config } = await enter({}, "true");

  expect(config).toContain("user.name=AI Supervisor");
  expect(config).toContain("user.email=ai-supervisor@localhost");
});

test("the identity the Checkpoints are committed under is the instance's to set", async () => {
  const { config } = await enter({
    SUPERVISOR_GIT_NAME: "Night Shift",
    SUPERVISOR_GIT_EMAIL: "night@example.com",
  });

  expect(config).toContain("user.name=Night Shift");
  expect(config).toContain("user.email=night@example.com");
});

test("the mounted project is trusted, whoever owns it on the host", async () => {
  const { config } = await enter({});

  expect(config).toContain("safe.directory=*");
});

test("settling the same container twice leaves one of each setting, not two", async () => {
  const { again } = await enter({}, "true");

  const config = await again();

  expect(config.split("\n").filter((line) => line.startsWith("safe.directory="))).toEqual([
    "safe.directory=*",
  ]);
});

test("the Supervisor is what the container goes on to run", async () => {
  const { stdout } = await enter({}, "sh", "-c", "echo the-supervisor-started");

  expect(stdout).toContain("the-supervisor-started");
});

test("a container whose Supervisor stops badly stops badly itself", async () => {
  await expect(enter({}, "sh", "-c", "exit 3")).rejects.toMatchObject({ code: 3 });
});
