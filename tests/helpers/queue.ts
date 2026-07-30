import { expect } from "vitest";

import type { TestProject } from "./project.js";
import type { TestSupervisor } from "./supervisor.js";

/** The queue as the API reports it — the only view a test ever has of a run. */
export interface QueueBody {
  id: string | null;
  branch: string | null;
  state: string;
  /** Why the run itself stopped, when something other than a ticket stopped it. */
  error: string | null;
  tickets: {
    id: string;
    title: string;
    state: string;
    checkpoint: string | null;
    failure: string | null;
  }[];
}

/** One Attempt as the API reports it, log and all. */
export interface AttemptBody {
  ticketId: string;
  outcome: string;
  failure: string | null;
  output: string;
  recordedAt: string;
}

export interface StartOptions {
  /** Where the tickets live; inside the project unless a test says otherwise. */
  source?: string;
  verify?: string[];
}

export function requestStart(
  running: TestSupervisor,
  project: TestProject,
  options: StartOptions = {},
): Promise<Response> {
  return running.request("/api/queue/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: { type: "local", directory: options.source ?? project.ticketsDirectory },
      project: { directory: project.directory, verify: options.verify ?? ["exit 0"] },
    }),
  });
}

export async function startRun(
  running: TestSupervisor,
  project: TestProject,
  options?: StartOptions,
): Promise<QueueBody> {
  const response = await requestStart(running, project, options);
  expect(response.status).toBe(202);
  return (await response.json()) as QueueBody;
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
  return ((await response.json()) as { output: string }).output;
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

export function ticketOf(queue: QueueBody, id: string): QueueBody["tickets"][number] | undefined {
  return queue.tickets.find((ticket) => ticket.id === id);
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
