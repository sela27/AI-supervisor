# AI Supervisor

A service that executes a queue of tickets unattended, driving Claude Code one ticket at a
time, so work progresses while you are away. See [CONTEXT.md](CONTEXT.md) for the domain
vocabulary and the spec issue for the full design.

## Requirements

Node.js 22.13+ (SQLite is used through Node's built-in `node:sqlite`, so there is no native
build step).

A queue whose tickets are GitHub issues also needs the [`gh`](https://cli.github.com) CLI on
the path, authenticated for the repository — `gh auth status` says whether it is, and
`GH_TOKEN` is what a container is given. A queue of ticket files needs neither.

None of it has to be on this machine: the image carries all of it, and a deployment needs
nothing but Docker — see [In a container](#in-a-container).

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
  "notifications": {
    "enabled": true,
    "webhook": "https://ntfy.sh/pick-your-own-topic",
    "on": {}
  },
  "review": {
    "enabled": false
  },
  "safety": {
    "maxTickets": null,
    "maxRuntimeMinutes": null,
    "consecutiveFailures": 3
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

`source.type` is `local` or `github`, and it decides what else the section says: a local
source is pointed at a `directory`, a GitHub one at the `repository` its issues live in.

```json
{
  "source": {
    "type": "github",
    "repository": "owner/name"
  }
}
```

A queue reads from exactly one source. Naming the other kind's setting — a `directory` under
a GitHub source — stops the service from starting rather than reading nothing at 3am.

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

The ticket source, the project, the attempt budget, the notification settings, the review and
the safety stops have no environment variables: they are what an instance _is_, and the file
is where they belong.

## In a container

One image holds everything a night needs: the service and its dashboard, the Claude Code
executable it launches Runs with, and the git, ssh and `gh` those Runs and their Checkpoints
need. The Claude Code executable is the one the Agent SDK ships, put on the path under its
own name — there is no second copy to drift out of step with what the Runs actually use.

One container minds one project. Everything that differs between projects is mounted or
given as environment, so the same image minds any of them.

### First run

```bash
cp .env.example .env && cp supervisor.config.example.json supervisor.config.json && mkdir -p claude
```

Make the credentials directory yourself rather than leaving it to Docker: a bind mount whose
source does not exist is created by Docker as root, and the container is not root.

Fill in `.env` — at minimum `SUPERVISOR_PROJECT_DIR`, the absolute path to the clone the
Supervisor works on — and edit `supervisor.config.json` to say what this instance is: where
its tickets live, and what verifies an Attempt. Paths in that file are container paths, so
the project is `/project` and its ticket files are somewhere under it.

Then log Claude in, once, into the credentials directory the nights will run on:

```bash
docker compose run --rm supervisor claude
```

That opens Claude Code inside the container against the mounted `/claude`; `/login` there,
and the subscription it authorises is what every Run of that instance is made on. It is a
directory of its own on purpose — the Supervisor never touches the one you log in with
yourself, so revoking one leaves the other alone.

```bash
docker compose up -d
```

The dashboard is on `http://localhost:4317`, or whatever `SUPERVISOR_HOST_PORT` says.

### What is mounted, and what is given

| Mount                      | Container path                | What it is                                                    |
| -------------------------- | ----------------------------- | ------------------------------------------------------------- |
| `SUPERVISOR_PROJECT_DIR`   | `/project`                    | The clone it works on — the only part of the machine it sees   |
| `SUPERVISOR_CLAUDE_DIR`    | `/claude`                     | The Claude credentials the nights run on                       |
| `./supervisor.config.json` | `/app/supervisor.config.json` | What this instance is, read once at start                      |
| `supervisor-data` volume   | `/data`                       | The runs, their Attempts, and everything those printed         |

The data directory is a named volume rather than a bind mount, so rebuilding the image
leaves the night's own record where it was.

| Variable                            | Read by        | Meaning                                                     |
| ----------------------------------- | -------------- | ----------------------------------------------------------- |
| `SUPERVISOR_PROJECT_DIR`            | compose        | The project this instance minds. No default — it must be said |
| `SUPERVISOR_CLAUDE_DIR`             | compose        | Where the nights' Claude credentials are kept                |
| `SUPERVISOR_HOST_PORT`              | compose        | Which port on this machine the dashboard answers on          |
| `SUPERVISOR_UID` / `SUPERVISOR_GID` | compose        | Who the container runs as                                    |
| `SUPERVISOR_GIT_NAME`               | the entrypoint | Who Checkpoints are committed under, if the clone has not said |
| `SUPERVISOR_GIT_EMAIL`              | the entrypoint | The address those commits carry                              |
| `GH_TOKEN` or `GITHUB_TOKEN`        | `gh` and git   | The repository token: reading issues, writing them back, pushing |

The two `SUPERVISOR_GIT_*` variables are the container's rather than the service's: `npm run
dev` does not read them, and a clone that already has an identity of its own keeps it — the
container only settles the fallback, so that a night never dies at its first Checkpoint for
want of a name to commit under.

The token needs permission to read and write the repository's issues and to push to it. It
is what `gh` authenticates with, and the container arranges git to push over https with the
same one — `gh` answers to either name, so the container does too. A queue of ticket files
pushing to no remote needs none of it.

### Two things about the host

**The container is not root.** Claude Code refuses to skip permissions for root, and a Run
that stops to ask is a Run that never finishes — so the container runs as uid 1000. On a
Linux host that has to be whoever owns the mounted project and credentials directory: set
`SUPERVISOR_UID` and `SUPERVISOR_GID` to your own `id -u` and `id -g`. On macOS and Windows
the defaults are right, because those mounts are not owned by anybody in particular.

**On a Windows host, clone the project with `core.autocrlf=false`.** Windows git checks
files out with CRLF line endings by default, and the container's git — which is Linux git —
reads every one of them as an uncommitted change. A run refuses to start on a project with
uncommitted changes, which is how that shows up.

The service is `restart: unless-stopped`, so a container that goes down comes back and
picks the night up where the last one left it — see
[When the Supervisor restarts](#when-the-supervisor-restarts).

## Previewing a queue

Point the Supervisor at a Ticket Source to see the Queue it would build — every ticket in
dependency order, plus the Frontier (the tickets that could run right now):

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

## Tickets on GitHub

The other kind of Ticket Source is a repository's own issues, which is where a tracked
project's tickets already live and where the morning's triage already starts:

```bash
curl -X POST localhost:4317/api/queue/preview -H 'content-type: application/json' -d '{"source":{"type":"github","repository":"owner/name"}}'
```

The Queue is the **open issues labelled `ready-for-agent`**, lowest number first — an issue
without that label is not the Supervisor's to pick up, whoever else it is for. The
acceptance criteria are the checkboxes under the issue's `## Acceptance criteria` heading, or
every checkbox it has when it is not written in that shape.

The blocking edges are the repository's **own issue dependencies** — what GitHub shows a
reader, and what `/to-tickets` records. A `Blocked by:` line in an issue body is prose to a
GitHub queue; the edge has to be the real one:

```bash
gh api --method POST repos/owner/name/issues/12/dependencies/blocked_by -F issue_id=$(gh api repos/owner/name/issues/11 --jq .id)
```

A **closed** issue is a finished ticket, so it gates nothing: closing a blocker on GitHub is
all it takes to release everything waiting on it into the next discovery's Frontier. An issue
blocked by one that is open and _not_ labelled `ready-for-agent` — a ticket a human still
owes an answer on — is in the Queue, reported `blocked` by the preview, and `skipped` the
moment a run starts, with the blocker named in its `failure` field. Nothing in the Queue was
ever going to finish it, and quota spent on it would be quota wasted.

Discovery reads at most 200 open `ready-for-agent` issues and refuses a repository with more:
that is not a queue anyone means to run in a night, and quietly taking the first 200 would be
a Queue missing its tail without saying so.

Outcomes go back to the issue. A succeeded ticket is **closed with a comment naming the
Checkpoint** it ended in, so the morning can go and look at the commit from the issue itself.
A ticket the Supervisor could not get past is **left open, commented with what refused it,
and relabelled `ready-for-human`** — it still has to happen, and it is no longer the
Supervisor's. Giving that ticket another go hands it back: `ready-for-agent` returns before
the Attempt does, so an issue that goes on to succeed is never left flagged for a human who
no longer has anything to do.

Nothing else is written. A skipped ticket was never tried, so nothing is said about it, and
an Attempt a usage limit interrupted says nothing either — however many times the run has to
ask whether the quota is back.

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

A run can be armed in the evening for an hour later that night:

```bash
curl -X POST localhost:4317/api/queue/start -H 'content-type: application/json' -d '{"startAt":"2026-07-30T23:00:00Z"}'
```

An armed run is a run: its branch is cut and its Queue is settled the moment it is armed, so
anything that would have refused it — a dirty working tree, an impossible queue edit, a
source that cannot be read — is refused while you are still looking at the terminal rather
than found to be true at eleven. The project is left on the run's branch from then on, so
whatever you commit before bed is what the night starts from. What you _don't_ commit is
checked again at the hour, and an armed run that wakes to a dirty working tree ends as
`failed` rather than sweeping your evening's work into a Checkpoint as if Claude had written
it.

An hour that has already gone by is a run that starts now, and one written as something other
than a time answers `400`. Stopping an armed run ends it; pausing one takes the arming off,
so resuming afterwards begins the run there and then rather than putting the hour back —
resume means "now" on every waiting run in this Supervisor. `startAt` belongs to the one run
that names it: there is no instance setting for it, and nothing here runs on a repeating
timetable.

The reply carries the run's id and branch. `GET /api/queue` reports the queue's state
(`idle`, `armed`, `running`, `paused`, `stopped`, `completed`, `paused-on-limit`, or `failed`
when the run itself broke down) and every
ticket's state (`pending`, `running`, `succeeded`, `failed`, `skipped`, or `done` when the
source already reported it finished), so a run can be watched from the moment it starts.
Tickets run strictly one at a time, and so do runs: starting a second while one is running,
paused, or waiting out a limit answers `409` — those are all runs somebody could still pick
up, and starting over them would strand a night's work on a branch nobody was told about.

An Attempt only counts as succeeded when **every** `verify` command exits 0 **and** the
Attempt left at least one new commit — what Claude says about itself is never enough, which
is why at least one command is required. A verified ticket then ends in a Checkpoint commit,
and the outcome is written back to the Ticket Source. Ticket files kept inside the project
are rewritten before the Checkpoint and committed along with it; kept outside it, the Run's
own last commit ends the ticket. A GitHub issue is closed after the Checkpoint has been made —
and pushed, where the project pushes — because the comment that closes it names that commit.

A Ticket Source that will not take the write-back ends the run, unlike a remote that will not
take a push: done-ness lives in the source, so a Supervisor that cannot record it there would
spend the rest of the night on tickets the next run would have every reason to do again.

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

A run that is waiting is the exception, and there are two kinds: one waiting out a usage
limit, and one armed for an hour that has not come. Both are already between tickets, so a
pause or a stop given during the wait happens at once, and a resume has the waiting one try
the limit now and the armed one begin now, rather than at the hour either was told. A run
waiting out a limit needs none of them — see
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

## How far a run may go on its own

The point of the Supervisor is that nobody is watching, which is also the risk: a project
that is broken in some way every ticket runs into will fail every ticket it is given, and
spend the whole of a week's quota proving it. Three safety stops bound one run, and each is
the instance's own to set:

| Setting                      | Default | What it stops                                           |
| ---------------------------- | ------- | ------------------------------------------------------- |
| `safety.maxTickets`          | none    | A run once it has run that many tickets                   |
| `safety.maxRuntimeMinutes`   | none    | A run once it has been going that long                    |
| `safety.consecutiveFailures` | `3`     | A run once that many tickets have failed one after another |

```json
{ "safety": { "maxTickets": 8, "maxRuntimeMinutes": 480, "consecutiveFailures": 3 } }
```

Each takes a whole number, or `null` for a stop this instance does not want — `null` is how a
stop is switched off, because a stop switched off on purpose is not the same as one the file
never mentioned, and the failure stop is on to begin with.

A run that reaches one is **stopped**, at a ticket boundary like every other ending: the
Attempt under way is never cut off half-way, everything the run finished stands on its
branch, and the reason appears in the queue's `stoppedBy` field and on the dashboard. Nothing
picks it up again — a stop set in advance is still your own stop, so resuming or retrying it
answers `409` exactly as it does for a run you stopped by hand. What it never reached is left
`pending` and unblamed, for a run tomorrow to have.

The failure count starts again at every ticket that works: three refusals in a row is a
project that is broken rather than a ticket that is, and one ticket succeeding is the whole
of the evidence that it is not. A ticket a usage limit interrupted counts for nothing — it
was not run, and it costs neither the ticket's attempt budget nor the run's allowance.

`maxRuntimeMinutes` is wall clock from the moment the run begins working, and it is the one
stop that can end a wait rather than a ticket: a run sitting out a weekly limit that would
outlast its own night stops instead of sleeping until Thursday. Wall clock means exactly
that — a run you paused overnight and resumed in the morning has been going all night, and
stops at its first boundary saying so. The hours a run spent armed are not among them: it was
not working, and waiting for midnight costs the night nothing.

## The dashboard

The Supervisor serves its own dashboard at `/`, on the same port as the API — one address
to open, from the phone by the bed as readily as from a desk:

```bash
open http://localhost:4317
```

It shows the queue's state and its branch, every ticket's state, the output of the Attempt
in flight as it is printed, and — on any ticket you open — that ticket's Attempts, each with
its outcome, its failure summary and its whole log. A queue waiting out a usage limit says
when it will be back, and an armed one says the hour it starts at — the two states where
nothing prints, nothing moves, and nothing is wrong. A run a safety stop ended says which
one, in the colour of a run that is working rather than of one that failed, because that is
what it did.

It drives the run too, with the controls above: Pause, Resume and Stop in the header, and
Retry or Take it out on the ticket they belong to. Resume reads "Try now" on a run waiting
out a limit and "Start now" on an armed one — the same control, and not the same thing three
times. With nothing under way the page offers a Ticket Source, an hour to start at (empty
starts now, and the field is in your own time), and a preview of the queue it would build,
where tickets can be left out or moved before the run starts. Every edit goes back through the preview, so an order the
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

## Being told when something matters

The dashboard is for when you are looking. Five moments are worth reaching you when you are
not, and each posts to one webhook:

| Event                | When                                                     | What it says                                                 |
| -------------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| `queue-finished`     | The queue ran out of tickets to run                        | How many succeeded, failed and were skipped, and the branch    |
| `ticket-failed`      | A ticket's every Attempt was refused                       | Which ticket, and what refused the last go                     |
| `long-wait`          | A usage limit has held the run up for over two hours       | Which ticket is waiting, and when the run means to try again   |
| `run-broke-down`     | The run stopped for something no ticket was to blame for   | What it could not get past                                     |
| `supervisor-crashed` | The service itself is going down, run or no run            | What it went down on                                           |

The last two are different failures. A run that broke down leaves the Supervisor standing —
the API answers, the dashboard is up, and `GET /api/queue` reports `failed` with the reason.
A crash is the service going out from under everything, which is the one notification worth
waiting for: the process holds on until it has been sent, because nothing is left behind to
report it.

```json
{
  "notifications": {
    "enabled": true,
    "webhook": "https://ntfy.sh/pick-your-own-topic",
    "on": { "long-wait": false }
  }
}
```

There is no default webhook — an instance that names none says nothing, which is a perfectly
good way to run. Pointing it at one is the whole of what it takes to start being told:
`enabled` is already on, and every event is on until it is switched off by name. `enabled:
false` silences the lot of them without you having to take the webhook out to do it.

Each notification is a plain-text `POST`, headline first and the rest below it. That is
exactly what [ntfy.sh](https://ntfy.sh) takes as it stands — subscribe to a topic of your own
in the app and point `webhook` at `https://ntfy.sh/<that topic>` — and it is also what any
other receiver can read without knowing anything about the Supervisor. The headline is a line
of the body rather than a header of its own, so a ticket titled with an em dash or a word of
Hebrew arrives intact. A webhook that is not an `http` or `https` URL stops the service from
starting: a notification that cannot be delivered has nowhere to report that it wasn't.

**Nothing ever waits for a notification, and nothing fails because of one.** It is posted and
forgotten: a webhook that refuses, that is unreachable, or that accepts the connection and
then says nothing at all costs the run neither a ticket nor a second — a notification is
given ten seconds to be taken and is then abandoned where it stands. Which also means a
notification that never arrives is not reported anywhere: the thing that would have told you
is the thing that just failed. The one exception is `supervisor-crashed`, where there is no
run left to hold up and nothing else left to say it.

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

## Having the work read before it stands

Verification is the project's own commands, and it can have a second stage. Off unless an
instance asks for it:

```json
{ "review": { "enabled": true } }
```

With it on, an Attempt that has passed every `verify` command is put in front of a reviewer
before it becomes a Checkpoint: a short Run of its own, given the ticket, its acceptance
criteria and everything the Attempt changed as a diff. It answers one of two verdicts.

"Everything" means exactly what the Checkpoint would commit — the Attempt's commits, its
uncommitted edits, and the files it created and never added. A reviewer that approved a
Checkpoint holding work it had not been shown would be the one thing this stage must not do.
Only a diff too large to send is cut short, and there the reviewer is told to read the files
itself.

An approval and the ticket succeeds exactly as it would have. A rejection refuses the Attempt
the way a failing test does — the work goes back to the last Checkpoint, and the reviewer's
own words are what the next Attempt is told it was refused for. A ticket whose every Attempt
a reviewer turned down fails with those words, written back to the Ticket Source like any
other failure. Either way the verdict and the reasoning are kept with the Attempt they
judged, and shown against it on the dashboard.

Nothing the project's own commands already refused is ever shown to a reviewer: work that
does not build is not work a review has anything to say about, and asking would spend quota
to be told what is already known.

The reviewer is handed the work rather than pointed at it, and given `Read`, `Grep` and
`Glob` and nothing else. It cannot write, because an approval is followed by a Checkpoint
that commits whatever is lying about — a reviewer able to leave something behind would have
it committed as if the Run had written it.

A review that reaches no verdict — it broke down, or it ended without answering — refuses the
Attempt rather than waving it through: the whole point of the stage is that nothing reaches a
Checkpoint unread. So a review that is misconfigured fails tickets rather than quietly doing
nothing, and the [consecutive-failure stop](#how-far-a-run-may-go-on-its-own) is what ends
the night rather than spending all of it that way.

A usage limit during a review is a usage limit like any other: the Attempt is discarded, the
ticket is left exactly as it was found, and it costs the ticket none of its budget.

The price is a Run per verified Attempt, against the same subscription the queue runs on. On
a night with a tight quota, that is a night that gets through fewer tickets.

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
days is a wait — unless the run's own `maxRuntimeMinutes` is up before the quota is back, in
which case [the safety stop](#how-far-a-run-may-go-on-its-own) ends the wait and the run with
it. Once a limit has held the run up for more than two hours you are
[told about it](#being-told-when-something-matters) — counted from when the limit first
stopped the run, so a cap that reported no reset time and is being looked at every half hour
still reaches you rather than being sat through in silence. You are told once, however many
times the run goes and looks.

Resuming by hand means "try now" rather than at the hour Claude named — useful when you know
better than it did. Pausing or stopping during a wait takes effect on the spot: there is no
Attempt under way, so there is no ticket boundary left to reach.

## When the Supervisor restarts

A container that is restarted, updated or killed mid-night does not lose the night. On
starting, the Supervisor reads back the run it — or the Supervisor before it — was in the
middle of, and carries on: **a run that was working goes back to work, one that was waiting
out a limit goes back to waiting for the same hour, one armed for later is still armed for
that hour, and one you had paused stays paused.** Nothing is asked of you, and the run keeps
its id, its branch and everything it had already finished.

The Queue is the one you approved, tickets and order both: it is written down with the run,
so a ticket filed since the night began is not swept into it — and a ticket the night has
already closed is not lost from it either, which asking the source for the queue again would
do. What the source is asked is what has finished since: a ticket you closed by hand
overnight is done and is not run again, and one the source has stopped offering at all is
taken out of the queue rather than attempted into thin air.

The Attempt the restart cut off never happened. Whatever it had left in the project — its
commits, its edits, the files it created — is thrown back to the last Checkpoint exactly as a
refused Attempt's would be, the ticket goes back on the Frontier, and **nothing is held
against it**: the interrupted Attempt costs it nothing out of its attempt budget. Every
Attempt from before the restart is still on file, log and all, under
`/api/queue/tickets/<id>/attempts` — and a ticket that failed before the restart can still be
retried after it. A run that had not begun — one armed for later — is a different matter: its
project is still yours until its hour, so nothing in it is reset, and whatever you leave
uncommitted is checked at the hour as it always was.

One thing will stop a run being picked up: **the project standing on some other branch.**
Picking the run up means resetting its branch back to the last Checkpoint, and a branch you
checked out while the Supervisor was down is not the Supervisor's to reset. Nothing in the
project is touched, and you are [told](#being-told-when-something-matters) that the run broke
down, naming the branch it found and the one it wanted.

A run that could not be picked up is **not written off**, though — it did not fail, it was
merely not resumed, and that is usually something you can undo. The API reports it `failed`,
because this Supervisor is certainly not running it; but what is on the disk is left exactly
as the last Supervisor left it. Check the run's branch back out (or give the Ticket Source
its network back) and start the Supervisor again, and the night is where you left it.

The run's own time — `maxRuntimeMinutes` — is measured from when it first began working, not
from the restart, so a night cannot win itself a fresh allowance by being restarted.

## When an attempt is refused

A refused Attempt is thrown all the way back to the last Checkpoint the moment it is
refused — its commits, its edits and the files it created all go, so no broken half-work
reaches the next Run or the branch. Ignored files (`node_modules` and friends) are left
alone. It makes no difference what refused it: the Run reporting failure, a `verify` command,
and a [review](#having-the-work-read-before-it-stands) turning the work down are the same
refusal with different words on it.

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

The failure is then written back to the Ticket Source, so morning triage starts from the
ticket itself: a ticket file is rewritten to `**Status:** failed` with a `## Supervisor
failure` section quoting the summary, and a GitHub issue is commented and relabelled
`ready-for-human`. A file write-back is committed as `Failed: <title>` — the only thing a
failed ticket ever adds to the branch, and the reason the branch is left clean enough for the
next run to start.

Every ticket that was waiting on the failure — directly or through another ticket — is
marked `skipped` and never attempted, with the blocker named in its `failure` field. Nothing
is written back for a skipped ticket: it was never tried. Everything that was not waiting on
the failure keeps running, so one bad ticket never ends the night; the run still finishes as
`completed`, with the mixed statuses reported per ticket. Only the ticket that ran out of
Attempts is [notified](#being-told-when-something-matters) — the tail behind it is a
consequence, not news of its own.

Because the reset destroys the working tree the Attempt ran in, the Attempt's log is kept in
the Supervisor's own SQLite database instead:

```bash
curl localhost:4317/api/queue/tickets/01-boot-the-app/attempts
```

That answers every Attempt the current run made on the ticket, oldest first, each with its
outcome (`succeeded`, `failed`, or `limit-hit`), its failure summary, and the full output —
the Run's own transcript, plus whatever the verification command printed when it was a
`verify` command that refused the Attempt. On an instance that [reviews the
work](#having-the-work-read-before-it-stands), each Attempt a reviewer saw carries its
verdict and reasoning too; `review` is null on every Attempt no reviewer ever saw.

## Checks

```bash
npm run typecheck
```

```bash
npm test
```

Tests boot the real service against a temporary data directory and drive it through the HTTP
API — that is the seam every feature is tested at. Four things are substituted there: the
Runner, so no Claude Code is launched; the clock, so a limit wait of days is proved in
milliseconds; `gh`, so a queue of GitHub issues is run without a live repository; and the
Notifier, so what would have reached a phone is read without a byte of it leaving the
machine. Git, the filesystem, SQLite and the verification commands are all real.

Four things cannot be reached through that seam and are covered directly instead: reading an
instance's settings, which happens before there is a service to ask; the production Runner,
against recorded Runs; the production Notifier, which is what every other test stands in
for — that one posts to a real HTTP server on a port of its own; and the container's
entrypoint, which is not the service at all. That one is run over a global git config of its
own and read back out of it, which is the whole of what it does. The image itself and the
compose file are not covered: proving those would mean building and running the container,
which needs Docker, a network, and a Claude subscription to log in with.

The restart tests boot two Supervisors in turn onto one data directory, which is what a
restart is. The kill is modelled rather than performed: the Supervisor is shut down while the
Run it was driving never answers at all, which is what a process being killed mid-Attempt
leaves behind. Killing the test process itself would take the fake Runner with it, and a real
Claude Code Run is the one thing the suite will not launch.

## Building

```bash
npm run build
```

Then `npm start` runs the compiled service from `dist/`.
