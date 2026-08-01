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
Where the tickets of a given queue live, and where their outcomes are written back, as fully as the source can carry them — a ticket file gets the whole account of the run that settled it, and a GitHub issue the comment that closes it. Either GitHub Issues or local ticket files. A queue reads from exactly one source, never both: a run reading from two would have no single place its outcomes belong, and no single answer to what is done.

**Queue**:
The ordered list of tickets the Supervisor will execute, discovered automatically from the Ticket Source by dependency order, and editable by the user before the run starts.

**Frontier**:
The set of tickets whose blockers are all done — the only tickets eligible to run next. A ticket with an open blocker is never run, and a ticket blocked by something outside the Queue altogether is never run either: nothing in the Queue is going to finish it.

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

**Review**:
Verification's optional second stage: a Run of its own that reads what an Attempt left behind and judges it against the ticket's acceptance criteria, answering one of two verdicts. Off unless the instance asks for it, and never reached for an Attempt the project's own commands already refused — work that does not build is not work a reviewer has anything to say about. A rejection refuses the Attempt exactly as a failing check does, and its reasoning is both what the ticket fails with and what the next Attempt is told; an approval lets the ticket succeed as usual. A review that could not reach a verdict is not an approval: nothing reaches a Checkpoint unread.
_Avoid_: check (that is a verification command), gate, second opinion

**Checkpoint**:
The commit that ends a successful ticket's work, and the one everything else points at: the ticket file names it, the closing issue comment names it, and the Dashboard shows it. Where the tickets live among the project's own files the write-back rides into the Checkpoint, and the one thing it cannot carry is the Checkpoint's own name — a file inside a commit cannot name the commit it is inside — so that follows in a commit of its own, right behind. A failed ticket's changes are discarded back to the last Checkpoint, or to that record of it where there is one: the record is the Supervisor's own account of a ticket that succeeded, and no later failure may take it back off.

**Skipped**:
A ticket the run never attempted — either because a ticket it was waiting on failed, or because the user took it out while the run was under way. Skipping is transitive: everything downstream of a skipped ticket is skipped too. A skipped ticket is not a failed one — nothing was tried, and nothing is written back to the Ticket Source. A ticket skipped by the user stays skipped even when the ticket that gated it is retried; their decision is not something the queue undoes for them.

**Instruction**:
Something the user has told a run to do that it has not reached the moment to do. An Attempt under way is never interrupted, so a pause or a stop given mid-ticket stands as an instruction until the ticket ends. A run says what it has been instructed to do while it is still on its way to doing it.
_Avoid_: command, pending action, request

**Retry**:
Putting a failed ticket back on the Queue so the run gives it another go, along with everything that was skipped only because of it. Distinct from the further Attempts a ticket spends out of its own attempt budget, which nobody asks for: a retry is the user's, and a retried ticket starts a fresh budget.

**Armed**:
A run that has been started and has not begun: its branch is cut and its Queue is settled, and it is waiting for the hour it was told to start at. Everything that could refuse the run was answered when it was armed, while the user was still there to be told. The user overtakes the hour — resuming an armed run begins it now, and pausing or stopping one ends it before it has run a thing.
_Avoid_: scheduled, queued (the Queue is a different thing), pending

**Paused**:
The queue state the user asked for. The run stops at the next ticket boundary and stays exactly where it stood until it is resumed — nothing is discarded, nothing is written back, and no ticket is held responsible. Unlike Paused-on-limit, this one is somebody's decision.
_Avoid_: suspended, halted

**Stopped**:
The run the user ended, whether by saying so or by a Safety stop they set in advance. Like a pause it takes effect at the next ticket boundary, and everything the run finished still stands; unlike a pause, nothing picks it up again — not resuming it, and not retrying one of its tickets.

**Paused-on-limit**:
The queue state entered when a usage limit is detected. A limit-interrupted Attempt is discarded and does not count against the ticket's attempt budget, and the ticket is left exactly as it was found. Unlike Paused and Stopped, nobody asked for this one and nobody has to end it: the run waits the limit out and picks itself up from the ticket the limit interrupted, however long the wait — a five-hour window and a weekly cap are the same thing at different lengths. A run waiting says when it means to try again; resuming it by hand means "try now" rather than at that hour.

**Safety stop**:
A bound the instance was given in advance on how far one run may go on its own: how many tickets it may run, how long it may go on for, and how many tickets may fail one after another. Reaching one leaves the run Stopped, at a ticket boundary like any other ending, with the stop that ended it said in words. Nothing about it is a failure and nothing about it is the subscription's — a usage limit is somebody else's decision that the run waits out, and a Safety stop is the user's own decision that the run obeys.
_Avoid_: limit (that is the usage limit), quota, guard, timeout

**Recovery**:
What a Supervisor does on starting with a night the Supervisor before it was in the middle of: it throws away whatever the interrupted Attempt left, carries on from the last Checkpoint, and asks the Ticket Source what has finished since. Nobody asks for a recovery and nobody is meant to notice one — a run that was working goes back to work, one that was waiting goes back to waiting, and one the user had paused stays paused. The Attempt the restart cut off never happened: it is not held against its ticket, and it costs it nothing out of its attempt budget. A run that has not begun is left alone entirely, project and all: an Armed run's project is still the user's until its hour. A run that cannot be picked up has not failed — it has not been resumed, which is a different thing and usually the user's to undo, so nothing is written off and the next start tries again.
_Avoid_: resume (that is the user's control), restart (that is the Supervisor's, not the run's), replay

**Probe**:
An Attempt made to find out whether the usage limit has lifted. A limit that named no reset time leaves nothing to wait for in particular, so the run goes and asks every so often. There is no cheaper way to ask than to try the ticket — and trying costs the ticket nothing, since a limit-interrupted Attempt is discarded and never held against it.

**Event**:
Something the Supervisor wants somebody told about, as distinct from the run state the Dashboard already shows: it is for reaching a person who is not looking. There are five — a queue finishing, a ticket finally failing, a long limit wait, a run breaking down under the Supervisor, and the Supervisor itself going down.
_Avoid_: notification (that is what carries an event, not the event itself), message

**Notification**:
What carries an Event to a person who is not looking. A notification is never waited for and never answered: whether one is sent at all is the instance's own settings deciding, and one that cannot be delivered changes nothing about the run that raised it.

**Notifier**:
What delivers a Notification — one webhook, posted to and forgotten about. Tests substitute a fake, so a test suite reads everything the Supervisor said without any of it leaving the machine.
