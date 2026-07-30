import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The project's repository could not be used the way the run needs it. */
export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * The project's git repository, as far as a run needs it: a branch of its own,
 * and a Checkpoint commit at the end of every successful ticket.
 */
export interface GitRepository {
  headCommit(): Promise<string>;
  /** True when the working tree holds anything not yet committed. */
  isDirty(): Promise<boolean>;
  branchExists(name: string): Promise<boolean>;
  /** Creates the branch and switches to it, carrying the working tree along. */
  createBranch(name: string): Promise<void>;
  /**
   * Commits whatever the working tree still holds, and answers the resulting
   * commit — or nothing at all when there was nothing left to commit.
   */
  commitEverything(message: string): Promise<string | undefined>;
  /**
   * Throws the branch and the working tree back to `commit`, taking commits, edits
   * and newly created files with it. Ignored files are left alone: a failed
   * Attempt's residue is what goes, not the project's build output.
   */
  resetTo(commit: string): Promise<void>;
}

export async function openRepository(directory: string): Promise<GitRepository> {
  const git = (...args: string[]): Promise<string> => runGit(directory, args);

  try {
    await git("rev-parse", "--git-dir");
  } catch {
    throw new GitError(
      `No git repository at ${directory} — a run commits a Checkpoint per ticket, so the project must be one`,
    );
  }

  const headCommit = (): Promise<string> => git("rev-parse", "HEAD");
  const isDirty = async (): Promise<boolean> => (await git("status", "--porcelain")) !== "";

  return {
    headCommit,
    isDirty,
    branchExists: async (name) => {
      try {
        await git("rev-parse", "--verify", `refs/heads/${name}`);
        return true;
      } catch {
        return false;
      }
    },
    createBranch: async (name) => {
      await git("checkout", "-b", name);
    },
    commitEverything: async (message) => {
      await git("add", "-A");
      if (!(await isDirty())) return undefined;
      await git("commit", "-m", message);
      return headCommit();
    },
    resetTo: async (commit) => {
      await git("reset", "--hard", commit);
      // Files the Attempt created were never tracked, so the reset alone would
      // leave them sitting in the working tree.
      await git("clean", "-fd");
    },
  };
}

async function runGit(directory: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: directory });
    return stdout.trim();
  } catch (error) {
    throw new GitError(`git ${args.join(" ")} failed: ${describe(error)}`);
  }
}

function describe(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr?.trim();
  return stderr !== undefined && stderr !== "" ? stderr : String(error);
}
