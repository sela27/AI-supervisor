import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The name a project's remote goes by, short of a reason to think otherwise. */
const REMOTE = "origin";

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
  /** The branch the project is standing on, which a run's own must not be left off. */
  currentBranch(): Promise<string>;
  /** True when the working tree holds anything not yet committed. */
  isDirty(): Promise<boolean>;
  /**
   * Everything that has changed since `commit` — what has been committed on top
   * of it, what is still sitting in the working tree, and the files that were
   * created and never added. A Checkpoint sweeps up all three, so all three have
   * to be in anything that is shown a Checkpoint's worth of work.
   *
   * Reaching the third means marking those files as intended for the next commit,
   * which is the only way git will diff a file it has never seen. Nothing is
   * committed by it, and it is undone by the very next thing to happen either
   * way: a Checkpoint adds them properly, and a reset drops the marking with the
   * files themselves.
   */
  diffSince(commit: string): Promise<string>;
  /** Whether the name is taken — here or, as far as this clone knows, on the remote. */
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
  /**
   * Sends the branch to the remote and tracks it from then on. Throws when the
   * remote will not take it — what that means for the run is the run's to decide.
   */
  push(branch: string): Promise<void>;
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
    currentBranch: () => git("rev-parse", "--abbrev-ref", "HEAD"),
    isDirty,
    diffSince: async (commit) => {
      await git("add", "--intent-to-add", "--all");
      return git("diff", commit);
    },
    branchExists: async (name) => {
      // A name already taken on the remote is taken: the branch would be created
      // here without complaint and its very first push refused as out of date.
      // Only what this clone has already seen of the remote counts — a fetch per
      // run would put the network in front of every start.
      const taken = await git(
        "for-each-ref",
        "--format=%(refname)",
        `refs/heads/${name}`,
        `refs/remotes/${REMOTE}/${name}`,
      );
      return taken !== "";
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
    push: async (branch) => {
      // A plain fast-forward push, every time: the run only ever pushes at a
      // Checkpoint and never resets behind one, so the remote is never ahead and
      // there is nothing to force over.
      await git("push", "--set-upstream", REMOTE, branch);
    },
  };
}

/**
 * How much git may print before it is cut off. A night's diff is the largest
 * thing anything here reads, and the default megabyte would refuse one on a
 * ticket that touched a lockfile.
 */
const MOST_GIT_MAY_PRINT = 64 * 1024 * 1024;

async function runGit(directory: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: directory,
      maxBuffer: MOST_GIT_MAY_PRINT,
    });
    return stdout.trim();
  } catch (error) {
    throw new GitError(`git ${args.join(" ")} failed: ${describe(error)}`);
  }
}

function describe(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr?.trim();
  return stderr !== undefined && stderr !== "" ? stderr : String(error);
}
