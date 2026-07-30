import { expect } from "vitest";

import type { TestSupervisor } from "./supervisor.js";

/**
 * An open SSE connection to the Supervisor, read the way a browser reads one: the
 * test never asks for the queue again, so anything it sees here was pushed to it.
 */
export interface EventStream {
  /** Every event of this name the stream has sent so far, oldest first. */
  received<T>(name: string): T[];
  /** The first event of this name — already arrived or still to come — that matches. */
  waitFor<T>(name: string, matches: (data: T) => boolean): Promise<T>;
  /** Resolves once the server has ended the stream, however it ended. */
  ended: Promise<void>;
  /** Hangs up, as closing the browser tab would. */
  close(): Promise<void>;
}

interface Waiter {
  name: string;
  matches: (data: never) => boolean;
  deliver: (data: never) => void;
}

export async function openEventStream(
  running: TestSupervisor,
  path = "/api/events",
): Promise<EventStream> {
  const hangUp = new AbortController();
  const response = await running.request(path, { signal: hangUp.signal });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");

  const arrived = new Map<string, unknown[]>();
  const waiting: Waiter[] = [];

  function deliver(frame: string): void {
    const lines = frame.split("\n");
    const name = lines.find((line) => line.startsWith("event:"))?.slice("event:".length).trim();
    const payload = lines.find((line) => line.startsWith("data:"))?.slice("data:".length).trim();
    // SSE allows frames that carry nothing a listener is registered for — comments
    // and bare data among them. Nothing here is waiting on one.
    if (name === undefined || payload === undefined) return;

    const data = JSON.parse(payload) as never;
    arrived.set(name, [...(arrived.get(name) ?? []), data]);

    for (const waiter of [...waiting]) {
      if (waiter.name !== name || !waiter.matches(data)) continue;
      waiting.splice(waiting.indexOf(waiter), 1);
      waiter.deliver(data);
    }
  }

  const ended = readFrames(response, deliver);

  return {
    received: <T>(name: string) => [...(arrived.get(name) ?? [])] as T[],

    waitFor: <T>(name: string, matches: (data: T) => boolean) =>
      new Promise<T>((resolve, reject) => {
        const already = (arrived.get(name) ?? []).find((data) => matches(data as T));
        if (already !== undefined) {
          resolve(already as T);
          return;
        }

        const waiter: Waiter = {
          name,
          matches: matches as (data: never) => boolean,
          deliver: resolve as (data: never) => void,
        };
        waiting.push(waiter);

        setTimeout(() => {
          if (!waiting.includes(waiter)) return;
          waiting.splice(waiting.indexOf(waiter), 1);
          reject(
            new Error(
              `No ${name} event ever matched; the stream sent ` +
                JSON.stringify(arrived.get(name) ?? []),
            ),
          );
        }, 15_000).unref();
      }),

    ended,

    close: async () => {
      hangUp.abort();
      await ended;
    },
  };
}

/** Splits the stream into SSE frames as they arrive, until it ends or is aborted. */
async function readFrames(response: Response, onFrame: (frame: string) => void): Promise<void> {
  const body = response.body;
  if (!body) throw new Error("The event stream answered with no body to read");

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;

      buffered += decoder.decode(value, { stream: true });
      for (let end = buffered.indexOf("\n\n"); end !== -1; end = buffered.indexOf("\n\n")) {
        onFrame(buffered.slice(0, end));
        buffered = buffered.slice(end + 2);
      }
    }
  } catch {
    // Hanging up mid-read is how a test closes the stream, and how the Supervisor
    // shutting down under one ends it. Neither is a failure of the stream.
  }
}
