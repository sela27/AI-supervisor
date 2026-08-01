import { expect } from "vitest";

import type { Spend } from "../../src/runner/spend.js";
import type { TestProject } from "./project.js";
import type { TestSupervisor } from "./supervisor.js";

/** The queue as the API reports it — the only view a test ever has of a run. */
export interface QueueBody {
  id: string | null;
  branch: string | null;
  state: string;
  /** What the run has been told to do and has not reached a boundary to do it at. */
  instruction: string | null;
  /** When a run that is not working means to be: a limit's hour, or an armed one's. */
  resumeAt: string | null;
  /** Why the run itself stopped, when something other than a ticket stopped it. */
  error: string | null;
  /** Which Safety stop ended the run, when one did. */
  stoppedBy: string | null;
  /** Why Checkpoints are not reaching the remote, when they are not. */
  pushFailure: string | null;
  /** What the run has spent so far, or nothing where no Run reported a figure. */
  spent: Spend | null;
  tickets: {
    id: string;
    title: string;
    state: string;
    checkpoint: string | null;
    failure: string | null;
    /** How many Attempts the run has recorded for this ticket so far. */
    attempts: number;
  }[];
}

/** What the Attempt in flight has printed, as both the API and the stream report it. */
export interface LiveOutputBody {
  ticketId: string | null;
  output: string;
}

/** One Attempt as the API reports it, log and all. */
export interface AttemptBody {
  ticketId: string;
  outcome: string;
  failure: string | null;
  output: string;
  recordedAt: string;
  /** What the review made of it, or nothing where no reviewer ever saw it. */
  review: { verdict: string; reasoning: string } | null;
  /** What it spent, or nothing where its Run reported no figures. */
  spend: Spend | null;
}

/** The user's edit of the queue before it runs, as a request carries it. */
export interface QueueEdit {
  exclude?: unknown;
  order?: unknown;
}

export interface StartOptions {
  /** Where the tickets live; inside the project unless a test says otherwise. */
  source?: string;
  verify?: string[];
  /** What to leave out and in what order; left out, the source's own queue runs. */
  queue?: QueueEdit;
  /** The hour to begin at, for a run armed rather than started; as a request writes it. */
  startAt?: string;
}

export function requestStart(
  running: TestSupervisor,
  project: TestProject,
  options: StartOptions = {},
): Promise<Response> {
  return post(running, startBody(project, options));
}

export function startRun(
  running: TestSupervisor,
  project: TestProject,
  options: StartOptions = {},
): Promise<QueueBody> {
  return startRunWith(running, startBody(project, options));
}

/** Starts a run from exactly the body given, however little it says for itself. */
export async function startRunWith(running: TestSupervisor, body: unknown): Promise<QueueBody> {
  const response = await post(running, body);
  expect(response.status).toBe(202);
  return (await response.json()) as QueueBody;
}

/** Everything a run needs, spelled out — what a test says unless it says otherwise. */
function startBody(project: TestProject, options: StartOptions): unknown {
  return {
    source: { type: "local", directory: options.source ?? project.ticketsDirectory },
    project: { directory: project.directory, verify: options.verify ?? ["exit 0"] },
    ...(options.queue === undefined ? {} : { queue: options.queue }),
    ...(options.startAt === undefined ? {} : { startAt: options.startAt }),
  };
}

/**
 * Sends one of the run's controls, the way the dashboard's own buttons send it.
 * Answers the response itself, since half of what a control has to get right is
 * refusing what the run cannot do.
 */
export function requestControl(running: TestSupervisor, path: string): Promise<Response> {
  return running.request(path, { method: "POST" });
}

/** Sends a control that is expected to be obeyed, and reads the queue it answers. */
export async function control(running: TestSupervisor, path: string): Promise<QueueBody> {
  const response = await requestControl(running, path);
  expect(response.status).toBe(200);
  return (await response.json()) as QueueBody;
}

export function ticketControl(ticketId: string, control: "retry" | "skip"): string {
  return `/api/queue/tickets/${encodeURIComponent(ticketId)}/${control}`;
}

function post(running: TestSupervisor, body: unknown): Promise<Response> {
  return running.request("/api/queue/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Asks what a Ticket Source would produce, under the user's edit when there is
 * one. Half of what an edit has to get right is being refused, so the response
 * itself comes back rather than the queue inside it.
 */
export function requestPreview(
  running: TestSupervisor,
  directory: string,
  queue?: QueueEdit,
): Promise<Response> {
  return running.request("/api/queue/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: { type: "local", directory },
      ...(queue === undefined ? {} : { queue }),
    }),
  });
}

export async function readQueue(running: TestSupervisor): Promise<QueueBody> {
  const response = await running.request("/api/queue");
  expect(response.status).toBe(200);
  return (await response.json()) as QueueBody;
}

/** Everything the run has recorded about one ticket's Attempts. */
export async function readAttempts(
  running: TestSupervisor,
  ticketId: string,
): Promise<AttemptBody[]> {
  const response = await running.request(
    `/api/queue/tickets/${encodeURIComponent(ticketId)}/attempts`,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as AttemptBody[];
}

/** What the Attempt in flight has printed so far, as a watcher would see it. */
export async function readLiveOutput(
  running: TestSupervisor,
  ticketId: string,
): Promise<string> {
  const response = await running.request(
    `/api/queue/tickets/${encodeURIComponent(ticketId)}/output`,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as LiveOutputBody).output;
}

/** Polls the API — the only way a test watches a run — until the queue looks right. */
export function waitForQueue(
  running: TestSupervisor,
  matches: (queue: QueueBody) => boolean,
): Promise<QueueBody> {
  return poll("queue", () => readQueue(running), matches);
}

/** Polls until the Attempt in flight has printed what the test is waiting for. */
export function waitForLiveOutput(
  running: TestSupervisor,
  ticketId: string,
  matches: (output: string) => boolean,
): Promise<string> {
  return poll(`output of ${ticketId}`, () => readLiveOutput(running, ticketId), matches);
}

async function poll<T>(
  what: string,
  read: () => Promise<T>,
  matches: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (matches(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`The ${what} never got there; it last looked like ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Long enough that a run about to do the wrong thing would have done it by now. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

export function ticketOf(queue: QueueBody, id: string): QueueBody["tickets"][number] | undefined {
  return queue.tickets.find((ticket) => ticket.id === id);
}

/** The branch a started run is on — unlike the idle queue, it always has one. */
export function runBranch(queue: QueueBody): string {
  const { branch } = queue;
  if (branch === null) throw new Error(`This queue is on no branch: ${JSON.stringify(queue)}`);
  return branch;
}

export function stateOf(queue: QueueBody, id: string): string | undefined {
  return ticketOf(queue, id)?.state;
}

export interface Gate {
  opened: Promise<void>;
  open(): void;
}

/** Holds a Runner mid-Attempt so a test can look at the queue while it is running. */
export function createGate(): Gate {
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
}
