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

**Done**:
A ticket the Ticket Source reports as finished. A done ticket is never run, and it no longer blocks the tickets that depend on it. Done-ness always lives in the Ticket Source, never in the Supervisor's own history.

**Run**:
A single headless Claude Code invocation that executes exactly one ticket, starting from a fresh context.
_Avoid_: session, job

**Runner**:
What carries out a Run — the one place the Supervisor launches Claude Code from. Tests substitute a fake, so a test suite never launches a Run of its own.

**Attempt**:
One Run of a ticket. A ticket gets a bounded number of attempts (default 2); each attempt after the first receives the previous attempt's failure feedback.

**Verification**:
The Supervisor's own judgment of whether an Attempt succeeded — project-configured commands (tests, typecheck, build) run after the Attempt, independent of what Claude reported. An optional review agent can be enabled on top.

**Checkpoint**:
The commit that ends a successful ticket. A failed ticket's changes are discarded back to the last Checkpoint.

**Skipped**:
A ticket the run never attempted because a ticket it was waiting on failed. Skipping is transitive: everything downstream of a failure is skipped too. A skipped ticket is not a failed one — nothing was tried, and nothing is written back to the Ticket Source.

**Paused-on-limit**:
The queue state entered when a usage limit is detected. The Supervisor waits until the limit resets (however long that takes) and resumes automatically; a limit-interrupted Attempt is discarded and does not count against the ticket's attempt budget.
