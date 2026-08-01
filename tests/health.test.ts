import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { startTestSupervisor, type TestSupervisor } from "./helpers/supervisor.js";
import { removeTempDirectories } from "./helpers/temp-dir.js";

let supervisor: TestSupervisor | undefined;

afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  await removeTempDirectories();
});

test("a freshly booted Supervisor reports itself healthy over HTTP", async () => {
  supervisor = await startTestSupervisor();

  const response = await supervisor.request("/api/health");

  expect(response.status).toBe(200);
  // The version comes from a live read of the migrations table, so answering at
  // all proves storage was created and migrated.
  expect(await response.json()).toEqual({
    status: "ok",
    schemaVersion: 4,
  });
});

test("the first boot creates the SQLite storage in the data directory", async () => {
  supervisor = await startTestSupervisor();

  expect(existsSync(join(supervisor.dataDir, "supervisor.db"))).toBe(true);
});

test("restarting onto an existing data directory still reports healthy", async () => {
  const first = await startTestSupervisor();
  const { dataDir } = first;
  await first.stop();

  supervisor = await startTestSupervisor({ dataDir });

  const response = await supervisor.request("/api/health");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok", schemaVersion: 4 });
});
