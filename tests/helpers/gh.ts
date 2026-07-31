import type { GhCommand } from "../../src/tickets/gh.js";

/** One issue of the repository a test stands up, before its defaults are filled in. */
export interface FakeIssue {
  number: number;
  title: string;
  body?: string;
  labels?: string[];
  state?: "open" | "closed";
  /** What blocks it, as the repository's own issue dependencies record it. */
  blockedBy?: number[];
}

type Issue = Required<FakeIssue>;

/**
 * A repository of GitHub issues, and a `gh` that answers about it — with the
 * output shapes the real CLI prints, trimmed to the fields the Ticket Source
 * reads. The Supervisor writes back through the same `gh`, so what a run did to
 * the issues is read here afterwards and no test goes near a live repository.
 */
export interface FakeGitHub {
  gh: GhCommand;
  /** Every invocation the Supervisor made, in the order it made them. */
  calls: string[][];
  state(issue: number): string;
  labels(issue: number): string[];
  /** What was said on an issue, oldest first. */
  comments(issue: number): string[];
  /** Closes an issue the way a person would, between one discovery and the next. */
  close(issue: number): void;
}

export function fakeGitHub(repository: string, issues: FakeIssue[]): FakeGitHub {
  const kept = new Map<number, Issue>(
    issues.map((issue) => [
      issue.number,
      {
        body: "",
        labels: ["ready-for-agent"],
        state: "open",
        blockedBy: [],
        ...issue,
      },
    ]),
  );
  const said = new Map<number, string[]>();
  const calls: string[][] = [];

  const find = (number: number): Issue => {
    const issue = kept.get(number);
    if (!issue) throw new Error(`This fake repository has no issue #${number}`);
    return issue;
  };

  const gh: GhCommand = async (args) => {
    calls.push(args);

    if (is(args, "issue", "list")) return listing(repository, kept, args);
    if (is(args, "issue", "close")) return closing(repository, find, said, args);
    if (is(args, "issue", "comment")) return commenting(repository, find, said, args);
    if (is(args, "issue", "edit")) return editing(repository, find, args);
    if (args[0] === "api") return blockers(repository, kept, args);

    throw new Error(`The fake gh was asked something it does not answer: gh ${args.join(" ")}`);
  };

  return {
    gh,
    calls,
    state: (issue) => find(issue).state,
    labels: (issue) => [...find(issue).labels],
    comments: (issue) => [...(said.get(issue) ?? [])],
    close: (issue) => {
      find(issue).state = "closed";
    },
  };
}

function is(args: string[], command: string, subcommand: string): boolean {
  return args[0] === command && args[1] === subcommand;
}

/** `gh issue list --repo … --state open --label … --json number,title,body` */
function listing(repository: string, kept: Map<number, Issue>, args: string[]): string {
  sameRepository(repository, args);
  const label = flag(args, "--label");

  const listed = [...kept.values()]
    .filter((issue) => issue.state === "open")
    .filter((issue) => label === undefined || issue.labels.includes(label))
    // The real CLI answers newest first; the Ticket Source is the one that has to
    // put the queue in the order the tickets were written.
    .sort((one, other) => other.number - one.number)
    .map((issue) => ({ number: issue.number, title: issue.title, body: issue.body }));

  return JSON.stringify(listed);
}

/** `gh api repos/<owner>/<name>/issues/<n>/dependencies/blocked_by` */
function blockers(repository: string, kept: Map<number, Issue>, args: string[]): string {
  const path = args[1] ?? "";
  const asked = /^repos\/(.+)\/issues\/(\d+)\/dependencies\/blocked_by$/.exec(path);
  if (!asked || asked[1] !== repository) {
    throw new Error(`The fake gh was sent to an endpoint it does not serve: ${path}`);
  }

  const issue = kept.get(Number(asked[2]));
  const blocking = (issue?.blockedBy ?? []).map((number) => ({
    number,
    // A blocker outside this repository's queue is one the fake was never told
    // about — an issue nobody labelled for the Supervisor, still open.
    state: kept.get(number)?.state ?? "open",
  }));

  return JSON.stringify(blocking);
}

function closing(
  repository: string,
  find: (number: number) => Issue,
  said: Map<number, string[]>,
  args: string[],
): string {
  sameRepository(repository, args);
  const issue = find(Number(args[2]));
  const comment = flag(args, "--comment");
  if (comment !== undefined) remember(said, issue.number, comment);
  issue.state = "closed";
  return "";
}

function commenting(
  repository: string,
  find: (number: number) => Issue,
  said: Map<number, string[]>,
  args: string[],
): string {
  sameRepository(repository, args);
  const issue = find(Number(args[2]));
  remember(said, issue.number, flag(args, "--body") ?? "");
  return "";
}

function editing(repository: string, find: (number: number) => Issue, args: string[]): string {
  sameRepository(repository, args);
  const issue = find(Number(args[2]));

  const removed = flag(args, "--remove-label");
  if (removed !== undefined) issue.labels = issue.labels.filter((label) => label !== removed);

  const added = flag(args, "--add-label");
  if (added !== undefined && !issue.labels.includes(added)) issue.labels.push(added);

  return "";
}

function remember(said: Map<number, string[]>, issue: number, comment: string): void {
  said.set(issue, [...(said.get(issue) ?? []), comment]);
}

/**
 * Every write says which repository it is for. An instance minds one project, and
 * a `gh` that quietly worked on whatever repository it was standing in would be
 * the Supervisor closing somebody else's issues.
 */
function sameRepository(repository: string, args: string[]): void {
  const named = flag(args, "--repo");
  if (named !== repository) {
    throw new Error(`The fake gh was pointed at ${String(named)} rather than ${repository}`);
  }
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}
