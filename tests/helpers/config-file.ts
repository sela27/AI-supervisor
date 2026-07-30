import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_FILENAME } from "../../src/config-file.js";
import { createTempDirectory } from "./temp-dir.js";

/** An instance's own directory, with the config file it will be booted from. */
export async function instanceWith(settings: unknown): Promise<string> {
  const directory = await createTempDirectory("supervisor-config-");
  await writeFile(join(directory, CONFIG_FILENAME), JSON.stringify(settings, null, 2), "utf8");
  return directory;
}

/** An instance that was told nothing, the way one with no config file starts. */
export async function instanceWithoutConfigFile(): Promise<string> {
  return createTempDirectory("supervisor-config-");
}
