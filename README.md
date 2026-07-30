# AI Supervisor

A service that executes a queue of tickets unattended, driving Claude Code one ticket at a
time, so work progresses while you are away. See [CONTEXT.md](CONTEXT.md) for the domain
vocabulary and the spec issue for the full design.

## Requirements

Node.js 22.13+ (SQLite is used through Node's built-in `node:sqlite`, so there is no native
build step).

## Running it

```bash
npm install
```

```bash
npm run dev
```

The service listens on `http://localhost:4317` by default and answers `GET /api/health`.

| Variable               | Default   | Meaning                          |
| ---------------------- | --------- | -------------------------------- |
| `SUPERVISOR_DATA_DIR`  | `./data`  | Where the SQLite database lives  |
| `SUPERVISOR_PORT`      | `4317`    | HTTP port (`0` picks a free one) |
| `SUPERVISOR_HOST`      | `0.0.0.0` | Bind address                     |
| `SUPERVISOR_LOG_LEVEL` | `info`    | Fastify/pino log level           |

## Previewing a queue

Point the Supervisor at a directory of local ticket files to see the Queue it would build —
every ticket in dependency order, plus the Frontier (the tickets that could run right now):

```bash
curl -X POST localhost:4317/api/queue/preview -H 'content-type: application/json' -d '{"source":{"type":"local","directory":"./.scratch/my-feature/issues"}}'
```

Each ticket file is Markdown named `<NN>-<slug>.md`, in the shape `/to-tickets` writes:

```markdown
# 01 — Boot the app

**What to build:** Something a developer can demo end to end.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] It boots
```

The title, `**Blocked by:**` and `**Status:**` lines are required; a file missing one is
reported by name rather than skipped. The checkbox lines below those fields are the
acceptance criteria. A blocking edge may name another ticket by its file name, its number,
or its title — `01-boot-the-app.md`, `#1` and `01 — Boot the app` all point at the same
ticket, and several may be listed comma-separated or as bullets under the field.
`**Status:** done` marks a ticket finished — it is never runnable, and it no longer blocks
its dependents.

## Running a queue

Starting a run executes the whole Queue unattended — one ticket at a time, in dependency
order, each on a branch the Supervisor creates for the run:

```bash
curl -X POST localhost:4317/api/queue/start -H 'content-type: application/json' -d '{"source":{"type":"local","directory":"./.scratch/my-feature/issues"},"project":{"directory":"/path/to/project","verify":["npm run typecheck","npm test"]}}'
```

The project must be a git repository with nothing uncommitted — a run commits everything it
finds, so work left lying about would land in a Checkpoint as if Claude had written it. The
Supervisor creates the run's branch with `git checkout -b` and leaves the project on it when
the run ends, so the branch is there to review.

The reply carries the run's id and branch. `GET /api/queue` reports the queue's state
(`idle`, `running`, `completed`, or `failed` when the run itself broke down) and every
ticket's state (`pending`, `running`, `succeeded`, `failed`, `skipped`, or `done` when the
source already reported it finished), so a run can be watched from the moment it starts.
Tickets run strictly one at a time, and so do runs: starting a second while one is under way
answers `409`.

An Attempt only counts as succeeded when **every** `verify` command exits 0 **and** the
Attempt left at least one new commit — what Claude says about itself is never enough, which
is why at least one command is required. A verified ticket then ends in a Checkpoint commit,
and `done` is written back to its ticket file. Ticket files kept inside the project are
committed along with the Checkpoint; kept outside it, the Run's own last commit ends the
ticket.

The `verify` commands run in the project directory through a shell, so `npm test` and
`bash -c '...'` both work.

## When a ticket fails

A failed Attempt is thrown all the way back to the last Checkpoint — its commits, its edits
and the files it created all go, so no broken half-work reaches the next ticket. Ignored
files (`node_modules` and friends) are left alone.

The ticket's own file is then rewritten to `**Status:** failed` with a `## Supervisor
failure` section quoting the summary, so morning triage starts from the ticket itself. That
write-back is committed as `Failed: <title>` — the only thing a failed ticket ever adds to
the branch, and the reason the branch is left clean enough for the next run to start.

Every ticket that was waiting on the failure — directly or through another ticket — is
marked `skipped` and never attempted, with the blocker named in its `failure` field. Nothing
is written back for a skipped ticket: it was never tried. Everything that was not waiting on
the failure keeps running, so one bad ticket never ends the night; the run still finishes as
`completed`, with the mixed statuses reported per ticket.

Because the reset destroys the working tree the Attempt ran in, the Attempt's log is kept in
the Supervisor's own SQLite database instead:

```bash
curl localhost:4317/api/queue/tickets/01-boot-the-app/attempts
```

That answers every Attempt the current run made on the ticket, oldest first, each with its
outcome, its failure summary, and the full output — the Run's own, plus whatever the
verification command printed when it was a `verify` command that refused the Attempt.

## Checks

```bash
npm run typecheck
```

```bash
npm test
```

Tests boot the real service against a temporary data directory and drive it through the HTTP
API — that is the seam every feature is tested at.

## Building

```bash
npm run build
```

Then `npm start` runs the compiled service from `dist/`.
