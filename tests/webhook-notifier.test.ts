import { createServer, type Server } from "node:http";
import { afterEach, expect, test } from "vitest";

import { webhookNotifier } from "../src/notifications/webhook.js";

/**
 * What actually goes out over the wire. The Notifier is the seam every other test
 * stands in for, which leaves the production one — the only thing that ever posts
 * anything — with nothing above it to be reached through. It is covered directly
 * instead, against a real HTTP server on a port of its own.
 */

interface Posted {
  method: string;
  contentType: string | undefined;
  body: string;
}

interface Target {
  url: string;
  posted: Posted[];
}

let listening: Server | undefined;

afterEach(async () => {
  const server = listening;
  listening = undefined;
  if (server) await new Promise((resolve) => server.close(resolve));
});

/** A webhook of the test's own, answering with whatever status it is given. */
async function webhookAnswering(status: number): Promise<Target> {
  const posted: Posted[] = [];

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      posted.push({
        method: request.method ?? "",
        contentType: request.headers["content-type"],
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(status).end(status < 400 ? "ok" : "no");
    });
  });
  listening = server;

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The test webhook is not listening on a port");
  }

  return { url: `http://127.0.0.1:${address.port}/my-topic`, posted };
}

test("a notification is posted as plain text, headline first", async () => {
  const target = await webhookAnswering(200);

  await webhookNotifier(target.url)({
    type: "queue-finished",
    title: "Queue finished: 3 succeeded, 0 failed, 0 skipped",
    body: "3 succeeded, 0 failed, 0 skipped.\nThe night's work is on supervisor/2026-07-31.",
  });

  // Exactly what ntfy.sh takes as it stands, and what anything else can read
  // without knowing a thing about the Supervisor.
  expect(target.posted).toHaveLength(1);
  expect(target.posted[0]?.method).toBe("POST");
  expect(target.posted[0]?.contentType).toContain("text/plain");
  expect(target.posted[0]?.body).toBe(
    "Queue finished: 3 succeeded, 0 failed, 0 skipped\n\n" +
      "3 succeeded, 0 failed, 0 skipped.\nThe night's work is on supervisor/2026-07-31.",
  );
});

test("a title nothing but ASCII would survive arrives intact", async () => {
  const target = await webhookAnswering(200);

  await webhookNotifier(target.url)({
    type: "ticket-failed",
    // An em dash and a word of Hebrew: the reason the headline is a line of the
    // body rather than a header, which could carry neither.
    title: "Ticket failed: 02 — הוספת חיפוש",
    body: "the tests never passed",
  });

  expect(target.posted[0]?.body).toContain("02 — הוספת חיפוש");
});

test("a webhook that refuses says which refusal it was", async () => {
  const target = await webhookAnswering(503);

  // Whoever posted this swallows the refusal, so this is the only place it ever
  // says anything — worth its being the status rather than "something happened".
  await expect(
    webhookNotifier(target.url)({ type: "long-wait", title: "Waiting", body: "until six" }),
  ).rejects.toThrow(/503/);
});

test("an instance pointed at no webhook posts nothing and refuses nothing", async () => {
  await expect(
    webhookNotifier(undefined)({ type: "supervisor-crashed", title: "Crashed", body: "gone" }),
  ).resolves.toBeUndefined();
});
