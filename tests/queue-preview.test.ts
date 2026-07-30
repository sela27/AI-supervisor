import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { requestPreview } from "./helpers/queue.js";
import { startTestSupervisor, type TestSupervisor } from "./helpers/supervisor.js";
import { removeTempDirectories } from "./helpers/temp-dir.js";
import { createTicketDirectory, ticketFile } from "./helpers/ticket-files.js";

let supervisor: TestSupervisor | undefined;

afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  await removeTempDirectories();
});

test("the queue preview lists every ticket in dependency order", async () => {
  const directory = await createTicketDirectory({
    "03-search-ui.md": ticketFile({ title: "03 — Search UI", blockedBy: "02" }),
    "01-boot-the-app.md": ticketFile({
      title: "01 — Boot the app",
      criteria: ["It boots", "It answers"],
    }),
    "02-add-search.md": ticketFile({ title: "02 — Add search", blockedBy: "01" }),
  });
  supervisor = await startTestSupervisor();

  const response = await requestPreview(supervisor, directory);

  expect(response.status).toBe(200);
  const preview = (await response.json()) as QueuePreviewBody;
  expect(preview.tickets).toEqual([
    {
      id: "01-boot-the-app",
      title: "Boot the app",
      status: "ready-for-agent",
      state: "ready",
      blockedBy: [],
      acceptanceCriteria: [
        { text: "It boots", done: false },
        { text: "It answers", done: false },
      ],
    },
    {
      id: "02-add-search",
      title: "Add search",
      status: "ready-for-agent",
      state: "blocked",
      blockedBy: ["01-boot-the-app"],
      acceptanceCriteria: [{ text: "It works", done: false }],
    },
    {
      id: "03-search-ui",
      title: "Search UI",
      status: "ready-for-agent",
      state: "blocked",
      blockedBy: ["02-add-search"],
      acceptanceCriteria: [{ text: "It works", done: false }],
    },
  ]);
});

test("a ticket whose blocker is still open stays out of the Frontier", async () => {
  const directory = await createTicketDirectory({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
    "02-add-search.md": ticketFile({ title: "02 — Add search", blockedBy: "01" }),
    "03-write-docs.md": ticketFile({ title: "03 — Write docs" }),
  });
  supervisor = await startTestSupervisor();

  const preview = await readPreview(supervisor, directory);

  // Both unblocked tickets are runnable; the blocked one is neither.
  expect(preview.frontier).toEqual(["01-boot-the-app", "03-write-docs"]);
  expect(stateOf(preview, "02-add-search")).toBe("blocked");
});

test("a blocking edge may name its blocker by file name, number, or title", async () => {
  const directory = await createTicketDirectory({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
    "02-by-file-name.md": ticketFile({ title: "02 — By file name", blockedBy: "01-boot-the-app.md" }),
    "03-by-number.md": ticketFile({ title: "03 — By number", blockedBy: "#1" }),
    // Copied straight out of the blocker's own heading, number prefix and all.
    "04-by-title.md": ticketFile({ title: "04 — By title", blockedBy: "01 — Boot the app" }),
  });
  supervisor = await startTestSupervisor();

  const preview = await readPreview(supervisor, directory);

  expect(preview.tickets.map((ticket) => ticket.blockedBy)).toEqual([
    [],
    ["01-boot-the-app"],
    ["01-boot-the-app"],
    ["01-boot-the-app"],
  ]);
  expect(preview.frontier).toEqual(["01-boot-the-app"]);
});

test("a ticket already marked done is reported done and never runnable", async () => {
  const directory = await createTicketDirectory({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app", status: "done" }),
    "02-add-search.md": ticketFile({ title: "02 — Add search", blockedBy: "01" }),
  });
  supervisor = await startTestSupervisor();

  const preview = await readPreview(supervisor, directory);

  expect(stateOf(preview, "01-boot-the-app")).toBe("done");
  // A done blocker no longer gates its dependent, which becomes the Frontier.
  expect(stateOf(preview, "02-add-search")).toBe("ready");
  expect(preview.frontier).toEqual(["02-add-search"]);
});

test("a ticket referring to a blocker that does not exist is reported per file", async () => {
  const directory = await createTicketDirectory({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
    "02-add-search.md": ticketFile({ title: "02 — Add search", blockedBy: "99" }),
  });
  supervisor = await startTestSupervisor();

  const response = await requestPreview(supervisor, directory);

  expect(response.status).toBe(400);
  const body = (await response.json()) as ErrorBody;
  expect(body.problems).toHaveLength(1);
  expect(body.problems[0]?.file).toBe("02-add-search.md");
  expect(body.problems[0]?.message).toContain("99");
});

test("a malformed ticket file explains what the file is missing", async () => {
  const directory = await createTicketDirectory({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app" }),
    "02-add-search.md": "Add search\n\nSome prose, but none of the fields a ticket needs.\n",
  });
  supervisor = await startTestSupervisor();

  const response = await requestPreview(supervisor, directory);

  expect(response.status).toBe(400);
  const body = (await response.json()) as ErrorBody;
  const messages = body.problems
    .filter((problem) => problem.file === "02-add-search.md")
    .map((problem) => problem.message)
    .join("\n");
  expect(messages).toContain("**Status:**");
  expect(messages).toContain("**Blocked by:**");
});

test("tickets that block each other are reported instead of hanging", async () => {
  const directory = await createTicketDirectory({
    "01-boot-the-app.md": ticketFile({ title: "01 — Boot the app", blockedBy: "02" }),
    "02-add-search.md": ticketFile({ title: "02 — Add search", blockedBy: "01" }),
  });
  supervisor = await startTestSupervisor();

  const response = await requestPreview(supervisor, directory);

  expect(response.status).toBe(400);
  const body = (await response.json()) as ErrorBody;
  expect(body.error).toContain("block each other");
  expect(body.error).toContain("01-boot-the-app");
});

test("pointing the preview at a directory that does not exist says so", async () => {
  const directory = join(await createTicketDirectory({}), "nowhere");
  supervisor = await startTestSupervisor();

  const response = await requestPreview(supervisor, directory);

  expect(response.status).toBe(400);
  const body = (await response.json()) as ErrorBody;
  expect(body.error).toContain(directory);
});

interface QueuePreviewBody {
  tickets: {
    id: string;
    title: string;
    status: string;
    state: string;
    blockedBy: string[];
    acceptanceCriteria: { text: string; done: boolean }[];
  }[];
  frontier: string[];
}

interface ErrorBody {
  error: string;
  problems: { file?: string; message: string }[];
}

async function readPreview(
  running: TestSupervisor,
  directory: string,
): Promise<QueuePreviewBody> {
  const response = await requestPreview(running, directory);
  expect(response.status).toBe(200);
  return (await response.json()) as QueuePreviewBody;
}

function stateOf(preview: QueuePreviewBody, id: string): string | undefined {
  return preview.tickets.find((ticket) => ticket.id === id)?.state;
}
