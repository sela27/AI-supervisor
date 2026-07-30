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

## Configuring an instance

One Supervisor minds one project, so everything about that project is settled once in
`supervisor.config.json` next to where the service is started. Every setting is optional; the
file itself is optional too, and an instance with no config file at all keeps the defaults
below.

```json
{
  "dataDir": "./data",
  "port": 4317,
  "host": "0.0.0.0",
  "logLevel": "info",
  "runner": {
    "model": "claude-opus-5",
    "permissionMode": "bypassPermissions"
  },
  "source": {
    "type": "local",
    "directory": "./.scratch/my-feature/issues"
  },
  "project": {
    "directory": "/path/to/project",
    "verify": ["npm run typecheck", "npm test"],
    "pushCheckpoints": true
  }
}
```

`source` and `project` are what a run would otherwise have to be told every time — with them
in the file, starting a run needs nothing but the instruction to start. A start request that
names one of them anyway wins, for that run only.

Every directory in the file — `dataDir`, `source.directory`, `project.directory` — is read
against the file's own directory rather than against wherever the service happened to be
started from: the settings travel with the deployment, so what they point at travels with
them.

Point an instance at a different file with `SUPERVISOR_CONFIG`. A file named that way must
exist; the unnamed `supervisor.config.json` may simply be absent. A setting the Supervisor
does not recognise, a value of the wrong shape, and a file that is not JSON each stop the
service from starting rather than waiting to spoil a run at 3am — a misspelled setting that
is quietly ignored is a setting that never applied.

Each of these environment variables overrides the file, so one container can differ from the
image it was built from:

| Variable                     | Setting              | Default             | Meaning                                   |
| ---------------------------- | -------------------- | ------------------- | ----------------------------------------- |
| `SUPERVISOR_CONFIG`          | —                    | `./supervisor.config.json` | Which config file to read          |
| `SUPERVISOR_DATA_DIR`        | `dataDir`            | `./data`            | Where the SQLite database lives           |
| `SUPERVISOR_PORT`            | `port`               | `4317`              | HTTP port (`0` picks a free one)          |
| `SUPERVISOR_HOST`            | `host`               | `0.0.0.0`           | Bind address                              |
| `SUPERVISOR_LOG_LEVEL`       | `logLevel`           | `info`              | Fastify/pino log level                    |
| `SUPERVISOR_MODEL`           | `runner.model`       | the CLI's own       | Model each Run uses                       |
| `SUPERVISOR_PERMISSION_MODE` | `runner.permissionMode` | `bypassPermissions` | How much a Run may do without being asked |

The ticket source and the project have no environment variables: they are what an instance
_is_, and the file is where they belong.

## Previewing a queue

Point the Supervisor at a directory of local ticket files to see the Queue it would build —
every ticket in dependency order, plus the Frontier (the tickets that could run right now):

```bash
curl -X POST localhost:4317/api/queue/preview -H 'content-type: application/json' -d '{"source":{"type":"local","directory":"./.scratch/my-feature/issues"}}'
```

An instance whose config file already names its source needs none of that — `-d '{}'` previews
the queue it was configured with.

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

With a configured instance that is just `-d '{}'`. Anything the request does name is used
instead of the file for that run — a single run can be verified harder, or read its tickets
from somewhere else, without the instance's own settings changing.

The project must be a git repository with nothing uncommitted — a run commits everything it
finds, so work left lying about would land in a Checkpoint as if Claude had written it. The
Supervisor creates the run's branch with `git checkout -b` and leaves the project on it when
the run ends, so the branch is there to review.

The reply carries the run's id and branch. `GET /api/queue` reports the queue's state
(`idle`, `running`, `completed`, `paused-on-limit`, or `failed` when the run itself broke
down) and every
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

## Following a run from elsewhere

Every Checkpoint is pushed to `origin` as soon as the ticket that earned it succeeds, so
the branch on the remote is never more than one ticket behind the work and the night can be
followed from a phone. The first push creates the branch there and sets its upstream, so
picking it up by hand afterwards needs no arguments. A run never takes a branch name this
clone has already seen on the remote, so a redeployed Supervisor cannot start a night's work
on a branch whose first push would be refused.

Pushing is no part of Verification. A ticket that passed its `verify` commands has succeeded,
and a remote that will not take the commit — none configured, unreachable, rejecting — does
not undo that: the ticket stays succeeded, the reason appears in the run's `pushFailure`
field, and the run carries on. The next Checkpoint that does get through clears the field and
carries everything before it along. Only Checkpoints are pushed, so a discarded Attempt's
work never reaches the remote at all.

A project with nowhere to push says so once, and no push is attempted:

```json
{ "project": { "directory": "/path/to/project", "pushCheckpoints": false } }
```

Like the rest of the project, a start request can name `pushCheckpoints` for one run only.

## How a ticket is run

Each ticket is one fresh headless Claude Code Run, launched through the Claude Agent SDK in
the project directory. Nothing carries over between tickets — a fresh context per Run is the
design, not an accident. The Run is given the ticket's title and acceptance criteria and told
three things: commit the work, do not push, and leave the ticket's own file alone (the
Supervisor writes the outcome back itself).

Runs need Claude Code's own credentials to be present wherever the Supervisor is running.
Because it runs unattended, permissions default to `bypassPermissions` — a Run that stops to
ask a question is a Run that never finishes. Narrow that with `SUPERVISOR_PERMISSION_MODE`
if the Supervisor is not confined to a container that can only see the project.

An Attempt's log is only complete once the Attempt has ended, and by then the Run may have
been going an hour. What it has printed so far is readable throughout:

```bash
curl localhost:4317/api/queue/tickets/01-boot-the-app/output
```

That answers the ticket being attempted right now; any other ticket answers nothing, and the
finished Attempt's whole log is filed under `/attempts` below.

## When a usage limit is hit

A usage limit is not a ticket failure and is never recorded as one. The interrupted Attempt
is discarded back to the last Checkpoint, the ticket is left exactly as it was found — no
write-back, no skipped dependents, nothing held against it — and the queue enters
`paused-on-limit`, naming the limit and the time it lifts (when Claude reported one) in its
`error` field.

Waiting the limit out and picking the run up automatically is not built yet, so for now the
wait is yours: start the run again once the limit has lifted and it carries on from the
Checkpoints already on the branch.

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
outcome (`succeeded`, `failed`, or `limit-hit`), its failure summary, and the full output —
the Run's own transcript, plus whatever the verification command printed when it was a
`verify` command that refused the Attempt.

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
