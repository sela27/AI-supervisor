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

The service listens on `http://localhost:4317` by default. Open that address for the
dashboard; `GET /api/health` answers on the same port.

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
  "attemptBudget": 2,
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

The ticket source, the project and the attempt budget have no environment variables: they
are what an instance _is_, and the file is where they belong.

## Previewing a queue

Point the Supervisor at a directory of local ticket files to see the Queue it would build —
every ticket in dependency order, plus the Frontier (the tickets that could run right now):

```bash
curl -X POST localhost:4317/api/queue/preview -H 'content-type: application/json' -d '{"source":{"type":"local","directory":"./.scratch/my-feature/issues"}}'
```

An instance whose config file already names its source needs none of that — `-d '{}'` previews
the queue it was configured with.

The queue is editable before it runs. A `queue` field leaves tickets out and puts them in the
order you want; the preview answers the queue that edit produces, so what you see is what a
run started with the same edit would execute:

```bash
curl -X POST localhost:4317/api/queue/preview -H 'content-type: application/json' -d '{"queue":{"exclude":["05-search-ui"],"order":["03-write-docs"]}}'
```

`order` names the tickets to run first, in that order; everything it does not name keeps its
place behind them. Excluding a ticket excludes everything waiting on it too — the reply's
`excluded` field lists the whole tail that came out, not just the ticket you named. An
excluded ticket is not in the Queue at all: it is never attempted and nothing is written back
to it.

An order that would put a ticket before a blocker that still has to run is refused, naming
both tickets, and so is an edit that names a ticket the source does not have. A blocker
already marked `done` gates nothing, so it never stands in the way of a reorder.

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

A start request takes the same `queue` edit the preview does, so the queue you arranged is
the queue that runs.

The reply carries the run's id and branch. `GET /api/queue` reports the queue's state
(`idle`, `running`, `paused`, `stopped`, `completed`, `paused-on-limit`, or `failed` when the
run itself broke down) and every
ticket's state (`pending`, `running`, `succeeded`, `failed`, `skipped`, or `done` when the
source already reported it finished), so a run can be watched from the moment it starts.
Tickets run strictly one at a time, and so do runs: starting a second while one is running,
paused, or waiting out a limit answers `409` — those are all runs somebody could still pick
up, and starting over them would strand a night's work on a branch nobody was told about.

An Attempt only counts as succeeded when **every** `verify` command exits 0 **and** the
Attempt left at least one new commit — what Claude says about itself is never enough, which
is why at least one command is required. A verified ticket then ends in a Checkpoint commit,
and `done` is written back to its ticket file. Ticket files kept inside the project are
committed along with the Checkpoint; kept outside it, the Run's own last commit ends the
ticket.

The `verify` commands run in the project directory through a shell, so `npm test` and
`bash -c '...'` both work.

## Driving a run

A run under way answers to five controls, each a `POST` with no body:

| Control                                   | What it does                                                        |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `/api/queue/pause`                        | Stops at the next ticket boundary and stays there                     |
| `/api/queue/resume`                       | Picks a paused run up, or has a waiting one try the limit now          |
| `/api/queue/stop`                         | Ends the run at the next ticket boundary                              |
| `/api/queue/tickets/<id>/retry`           | Gives a failed ticket another go                                     |
| `/api/queue/tickets/<id>/skip`            | Takes a ticket that has yet to run out of the run                     |

```bash
curl -X POST localhost:4317/api/queue/pause
```

Each answers the queue as the control left it, so whoever gave it sees the result without
waiting to be told again.

**Pause and stop take effect at the next ticket boundary.** The Attempt under way is not
interrupted — the Run it is driving cannot be asked to stop half-way — so until the ticket
ends the queue is still `running` and its `instruction` field says what it is on its way to
doing. Resuming a run that has been asked to pause but has not got there yet takes the
instruction back. A stopped run leaves everything it finished standing, on a branch with
nothing uncommitted around it; nothing picks it up again.

A run waiting out a usage limit is the exception: it is already between tickets, so a pause
or a stop given during the wait happens at once, and a resume has it try the limit now rather
than at the hour it was told to expect quota back. It needs none of them — see
[When a usage limit is hit](#when-a-usage-limit-is-hit) — the run picks itself up.

**Retry** puts a failed ticket back on the queue along with everything that was only skipped
because of it, and puts the run back to work if it had already finished. The failure written
back to the ticket's own file is taken off again before the next Attempt starts, so a ticket
that goes on to succeed does not still carry the reason it did not. **Skip** takes a ticket
that has yet to run out of the queue, and everything waiting on it goes with it. A ticket the
user took out stays out: retrying the ticket that gated it does not put it back, because that
was a decision rather than a consequence.

A control the run cannot obey — pausing what is not running, retrying what did not fail —
answers `409` and changes nothing. One naming a ticket the run does not have answers `404`.

## The dashboard

The Supervisor serves its own dashboard at `/`, on the same port as the API — one address
to open, from the phone by the bed as readily as from a desk:

```bash
open http://localhost:4317
```

It shows the queue's state and its branch, every ticket's state, the output of the Attempt
in flight as it is printed, and — on any ticket you open — that ticket's Attempts, each with
its outcome, its failure summary and its whole log. A queue waiting out a usage limit says
when it will be back, which is the one state where nothing prints, nothing moves, and nothing
is wrong.

It drives the run too, with the controls above: Pause, Resume and Stop in the header, and
Retry or Take it out on the ticket they belong to. With nothing under way the page offers a
Ticket Source and a preview of the queue it would build, where tickets can be left out or
moved before the run starts. Every edit goes back through the preview, so an order the
blocking edges forbid is refused and explained rather than applied — the list on the page is
always one you could press Start on.

The page's controls are the API's controls and nothing more, so a control given from the
phone shows up on the desk without either of them asking. The project a run works in is not
among them: that is what an instance _is_, and it is settled in the config file.

Everything but the per-ticket history is pushed to the page over one server-sent-event
stream at `/api/events`, so nothing is ever refreshed and a page opened halfway through the
night is right from its first paint. The stream carries a `queue` event and an `output`
event, each sent when — and only when — it has something new to say. A connection that
drops is reopened by the browser itself, and the page says so while it is gone.

The page is one self-contained document — markup, styles and script together, nothing
fetched from anywhere else — so it renders on a network with no way out.

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

**Then it waits, and picks itself up.** Nothing is asked of you. `GET /api/queue` reports
`resumeAt`, the moment the run means to try again, and the dashboard turns that into
"waiting for the limit — resuming at 06:31":

```json
{ "state": "paused-on-limit", "resumeAt": "2026-07-30T06:31:00.000Z" }
```

Where Claude reported a reset time, that is what the run waits for, plus a minute so it is
not refused a second time by seconds. Where it reported none there is nothing to wait for in
particular, so the run tries the ticket again every half hour until the quota is back —
trying is the only way to ask, and a refused try costs the ticket nothing. Either way the
ticket is then run from scratch, with its whole attempt budget intact, and the run carries on
down the queue.

A five-hour window and a weekly cap are the same mechanism at different lengths: a wait of
days is a wait. Once a limit has held the run up for more than two hours it raises an event,
which notifications will carry to your phone once they exist — counted from when the limit
first stopped the run, so a cap that reported no reset time and is being looked at every half
hour still reaches you rather than being sat through in silence. It is raised once.

Resuming by hand means "try now" rather than at the hour Claude named — useful when you know
better than it did. Pausing or stopping during a wait takes effect on the spot: there is no
Attempt under way, so there is no ticket boundary left to reach.

## When an attempt is refused

A refused Attempt is thrown all the way back to the last Checkpoint the moment it is
refused — its commits, its edits and the files it created all go, so no broken half-work
reaches the next Run or the branch. Ignored files (`node_modules` and friends) are left
alone.

The ticket then gets another go. Each ticket has an attempt budget, two by default, and a
retry is a fresh Run like any other — told, on top of the ticket, what refused the last
Attempt and that the repository is already back to where it stood before it ran. Where a
check refused the Attempt, what that check printed goes along with the reason: `exited 1`
on its own is not something a second attempt can be smarter about.

```json
{ "attemptBudget": 3 }
```

A budget of `1` is a Supervisor that never retries. A usage limit never costs a ticket an
Attempt — nothing was learned about the ticket, so nothing is spent.

## When a ticket fails

A ticket whose every Attempt was refused has failed, and the last one's work is already
gone with the rest.

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
