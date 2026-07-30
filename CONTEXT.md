# AI Supervisor

An orchestration service that executes a queue of tickets unattended, driving Claude Code one ticket at a time, so work progresses while the user is away.

## Language

**Supervisor**:
The orchestration service itself — the thing that picks tickets, launches runs, and handles limits.
_Avoid_: script, runner (the Runner is a different thing), manager

**Ticket**:
A tracer-bullet vertical slice of work with acceptance criteria and blocking edges, produced by `/to-tickets`.
_Avoid_: task, issue (reserve "issue" for the GitHub representation)

**Ticket Source**:
Where the tickets of a given queue live — either GitHub Issues or local ticket files. A queue reads from exactly one source, never both.

**Queue**:
The ordered list of tickets the Supervisor will execute, discovered automatically from the Ticket Source by dependency order, and editable by the user before the run starts.

**Frontier**:
The set of tickets whose blockers are all done — the only tickets eligible to run next. A ticket with an open blocker is never run.

**Queue edit**:
What the user did to the Queue before running it: which tickets to leave out, and the order to run the rest in. An edit is answered against the blocking edges, so one that could never be run is refused rather than started.
_Avoid_: plan, filter, selection

**Excluded**:
A ticket the user took out of the Queue by a Queue edit, before the run started. It is not in the Queue at all — never attempted, never written back to, and reported nowhere in the run. Everything waiting on an excluded ticket is excluded with it.
_Avoid_: disabled, deselected, removed

**Done**:
A ticket the Ticket Source reports as finished. A done ticket is never run, and it no longer blocks the tickets that depend on it. Done-ness always lives in the Ticket Source, never in the Supervisor's own history.

**Run**:
A single headless Claude Code invocation that executes exactly one ticket, starting from a fresh context.
_Avoid_: session, job

**Runner**:
What carries out a Run — the one place the Supervisor launches Claude Code from. Tests substitute a fake, so a test suite never launches a Run of its own.

**Attempt**:
One Run of a ticket. A ticket gets a bounded number of attempts — its **attempt budget**, two by default — and each attempt after the first receives the previous attempt's failure feedback. A budget belongs to a ticket, not to a run: spending one ticket's whole budget costs the next ticket nothing.

**Dashboard**:
The Supervisor's own web page, served by the Supervisor itself — where a run is watched and where it is driven. It shows what is happening and what happened, and it carries the same controls the API does; it decides nothing of its own, and every control it gives is one the API would answer identically.
_Avoid_: UI, front-end, web app

**Verification**:
The Supervisor's own judgment of whether an Attempt succeeded — project-configured commands (tests, typecheck, build) run after the Attempt, independent of what Claude reported. An optional review agent can be enabled on top.

**Checkpoint**:
The commit that ends a successful ticket. A failed ticket's changes are discarded back to the last Checkpoint.

**Skipped**:
A ticket the run never attempted — either because a ticket it was waiting on failed, or because the user took it out while the run was under way. Skipping is transitive: everything downstream of a skipped ticket is skipped too. A skipped ticket is not a failed one — nothing was tried, and nothing is written back to the Ticket Source. A ticket skipped by the user stays skipped even when the ticket that gated it is retried; their decision is not something the queue undoes for them.

**Instruction**:
Something the user has told a run to do that it has not reached the moment to do. An Attempt under way is never interrupted, so a pause or a stop given mid-ticket stands as an instruction until the ticket ends. A run says what it has been instructed to do while it is still on its way to doing it.
_Avoid_: command, pending action, request

**Retry**:
Putting a failed ticket back on the Queue so the run gives it another go, along with everything that was skipped only because of it. Distinct from the further Attempts a ticket spends out of its own attempt budget, which nobody asks for: a retry is the user's, and a retried ticket starts a fresh budget.

**Paused**:
The queue state the user asked for. The run stops at the next ticket boundary and stays exactly where it stood until it is resumed — nothing is discarded, nothing is written back, and no ticket is held responsible. Unlike Paused-on-limit, this one is somebody's decision.
_Avoid_: suspended, halted

**Stopped**:
The run the user ended. Like a pause it takes effect at the next ticket boundary, and everything the run finished still stands; unlike a pause, nothing picks it up again — not resuming it, and not retrying one of its tickets.

**Paused-on-limit**:
The queue state entered when a usage limit is detected. A limit-interrupted Attempt is discarded and does not count against the ticket's attempt budget, and the ticket is left exactly as it was found. Resuming picks the run up from the ticket the limit interrupted.
