# 1. A ticket file cannot name its own Checkpoint

Date: 2026-08-01

## Status

Accepted.

## Context

A settled ticket is written back to its Ticket Source, and the ticket file is meant to tell
the whole story of the run that settled it — its status, the criteria something judged met,
what the verification said, and **which Checkpoint it ended in**.

Where the tickets live among the project's own files, the write-back rides into the Checkpoint
itself: the file is rewritten, and the commit that ends the ticket sweeps it up along with the
work. That is what makes the record and the work one thing, and it is why a local write-back
survives everything a failed Attempt's `git reset --hard` throws away.

It also makes naming the Checkpoint impossible. A commit's name is a hash of its tree, and the
tree holds the file: a file inside a commit cannot name the commit it is inside. Writing the
name in afterwards and amending changes the hash, so the file would name a commit that no
longer exists.

Tickets kept outside the project have no such problem — nothing there is inside any commit —
but a write-back that differs by where the file happens to live is two behaviours, not one.

## Decision

The Checkpoint is named in a commit of its own, `Recorded: <title>`, immediately behind the
Checkpoint it names.

The rest of the write-back is written before the Checkpoint, as it always was, and rides into
it. Once the Checkpoint exists, the Ticket Source is told its name; a source that keeps its
tickets in the project writes that one line into the file, and the run commits it and moves
its restore point past it. A source that keeps its tickets anywhere else leaves nothing to
commit, and the Checkpoint is the last word on the ticket as it was.

So a succeeded ticket in a project whose tickets live inside it ends in two commits, and a
branch of _n_ such tickets carries 2_n_ of the Supervisor's own.

## Consequences

**The Checkpoint means the commit the ticket's work ended in**, everywhere it is said: in the
ticket file, in the comment that closes a GitHub issue, and on the Dashboard. It is no longer
always the branch's tip — the record of it is.

**Reverting one ticket is reverting two commits** where the tickets live in the project. They
are adjacent and named after the same ticket, so finding them is not the hard part; but a
`git revert <checkpoint>` alone now leaves the record behind, saying a ticket succeeded whose
work is gone.

**A restart in the window between the two commits loses the name.** The ticket is already
`done` and is never run again, so the file keeps its account of the run and its branch but
never gains its `**Checkpoint:**` line. Nothing is lost but that line, and the alternative —
holding the restore point back until both commits exist — would have a restart throw away the
whole of a succeeded ticket's work, which is very much worse.

## Alternatives considered

**Name no commit, and let `git log` on the file answer.** True for a file inside the
repository and useless for one outside it, where nothing else points at the work at all. It
would have made the write-back depend on where the user keeps their tickets.

**Name the Checkpoint's parent — the Attempt's own last commit.** Nameable, and honest, but it
is not what the acceptance criterion asked for and not what somebody reading the ticket in the
morning wants to `git show`.

**Amend the Checkpoint after writing the name in.** The amend changes the hash, so the file
would name a commit that does not exist. Worse than no name.
