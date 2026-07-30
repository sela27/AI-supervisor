import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { createTempDirectory } from "./temp-dir.js";

const execFileAsync = promisify(execFile);

/**
 * A throwaway git repository standing in for the developer's project: real
 * commits on a real branch, with the queue's ticket files living inside it the
 * way `/to-tickets` writes them.
 */
export interface TestProject {
  directory: string;
  /** Absolute path of the ticket directory the Supervisor is pointed at. */
  ticketsDirectory: string;
  git(...args: string[]): Promise<string>;
  head(ref?: string): Promise<string>;
  currentBranch(): Promise<string>;
  commitSubjects(ref?: string): Promise<string[]>;
  read(relativePath: string): Promise<string>;
}

/**
 * A bare repository standing in for the remote a run publishes its branch to.
 * Local, so a test can read exactly what reached it without a network in sight.
 */
export interface TestRemote {
  directory: string;
  /** The branches that actually arrived — none, until something is pushed. */
  branches(): Promise<string[]>;
  commitSubjects(branch: string): Promise<string[]>;
}

const TICKETS_DIRECTORY = "tickets";

export async function createTestProject(tickets: Record<string, string>): Promise<TestProject> {
  const directory = await createTempDirectory("supervisor-project-");
  const ticketsDirectory = join(directory, TICKETS_DIRECTORY);

  await mkdir(ticketsDirectory, { recursive: true });
  for (const [name, contents] of Object.entries(tickets)) {
    await writeFile(join(ticketsDirectory, name), contents, "utf8");
  }
  await writeFile(join(directory, "README.md"), "# Project under supervision\n", "utf8");

  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync("git", args, { cwd: directory });
    return stdout.trim();
  };

  await git("init", "-b", "main");
  await git("config", "user.email", "supervisor@example.test");
  await git("config", "user.name", "Supervisor Test");
  // The developer's global config may sign commits; a throwaway repo cannot.
  await git("config", "commit.gpgsign", "false");
  await git("add", "-A");
  await git("commit", "-m", "Initial commit");

  return {
    directory,
    ticketsDirectory,
    git,
    head: (ref = "HEAD") => git("rev-parse", ref),
    currentBranch: () => git("rev-parse", "--abbrev-ref", "HEAD"),
    commitSubjects: async (ref = "HEAD") => (await git("log", "--format=%s", ref)).split("\n"),
    read: (relativePath) => readFile(join(directory, relativePath), "utf8"),
  };
}

/** Gives the project an `origin` to push to, and hands back what is on the other end. */
export async function giveRemote(project: TestProject): Promise<TestRemote> {
  const directory = await createTempDirectory("supervisor-remote-");
  const bare = async (...args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync("git", args, { cwd: directory });
    return stdout.trim();
  };

  await bare("init", "--bare");
  await project.git("remote", "add", "origin", directory);

  return {
    directory,
    branches: async () => {
      const refs = await bare("for-each-ref", "--format=%(refname:short)", "refs/heads");
      return refs === "" ? [] : refs.split("\n");
    },
    commitSubjects: async (branch) => (await bare("log", "--format=%s", branch)).split("\n"),
  };
}
