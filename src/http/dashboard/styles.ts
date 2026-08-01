/**
 * Written for the phone first — one column, thumb-sized targets — and widened to
 * two columns only where there is room for the log to sit beside the queue.
 */
export const DASHBOARD_STYLES = `
:root {
  color-scheme: dark light;
  --page: #14161a;
  --panel: #1c1f25;
  --edge: #2b2f38;
  --ink: #e6e8ec;
  --faint: #9aa1ad;
  --running: #d8a53a;
  --succeeded: #4fa96a;
  --failed: #d1584f;
  --skipped: #6b7280;
}

@media (prefers-color-scheme: light) {
  :root {
    --page: #f5f6f8;
    --panel: #ffffff;
    --edge: #dcdfe5;
    --ink: #1a1d23;
    --faint: #5f6874;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  padding: 0 0 2rem;
  background: var(--page);
  color: var(--ink);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}

header {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.75rem;
  padding: 1rem;
  border-bottom: 1px solid var(--edge);
}

h1 { font-size: 1.1rem; margin: 0; }
h2 { font-size: 0.8rem; margin: 0 0 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--faint); }

.pill {
  padding: 0.15rem 0.6rem;
  border: 1px solid var(--edge);
  border-radius: 999px;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.pill[data-state="running"] { color: var(--running); border-color: var(--running); }
.pill[data-state="completed"] { color: var(--succeeded); border-color: var(--succeeded); }
.pill[data-state="failed"] { color: var(--failed); border-color: var(--failed); }
.pill[data-state="paused-on-limit"] { color: var(--running); border-color: var(--running); }
/* Armed is a run about to work, not one that has stopped: the working colour. */
.pill[data-state="armed"] { color: var(--running); border-color: var(--running); }

.instruction { color: var(--running); border-color: var(--running); text-transform: none; letter-spacing: 0; }
.pill[hidden] { display: none; }

.branch { margin-left: auto; color: var(--faint); font-size: 0.85rem; font-family: ui-monospace, monospace; }

.controls { display: flex; flex-wrap: wrap; gap: 0.5rem; }

/* Thumb-sized whatever it says, because half of these are pressed from a phone. */
.control {
  min-height: 44px;
  padding: 0.4rem 0.9rem;
  border: 1px solid var(--edge);
  border-radius: 8px;
  background: var(--panel);
  color: inherit;
  font: inherit;
  font-size: 0.85rem;
  cursor: pointer;
}
.control:hover:enabled { border-color: var(--faint); }
.control:disabled { opacity: 0.35; cursor: default; }
.control[hidden] { display: none; }
.control.primary { border-color: var(--succeeded); color: var(--succeeded); }

.ticket-control { margin: 0 0.75rem 0.6rem; }

.notice { margin: 0; padding: 0.7rem 1rem; background: rgba(209, 88, 79, 0.14); color: var(--failed); font-size: 0.9rem; }
/* A Safety stop is the instance doing what it was told, so it is not a failure. */
.notice[data-kind="stop"] { background: rgba(216, 165, 58, 0.14); color: var(--running); }
.notice[hidden] { display: none; }

main { display: grid; gap: 1rem; padding: 1rem; }

.panel { background: var(--panel); border: 1px solid var(--edge); border-radius: 10px; padding: 1rem; min-width: 0; }

.tickets { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }

.ticket { border: 1px solid var(--edge); border-radius: 8px; overflow: hidden; }

.ticket-head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  min-height: 44px;
  padding: 0.6rem 0.75rem;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.ticket-head:hover { background: rgba(127, 127, 127, 0.08); }

.dot { flex: none; width: 9px; height: 9px; border-radius: 50%; background: var(--skipped); }
.ticket[data-state="running"] .dot { background: var(--running); }
.ticket[data-state="succeeded"] .dot, .ticket[data-state="done"] .dot { background: var(--succeeded); }
.ticket[data-state="failed"] .dot { background: var(--failed); }
/* Hollow, because a skipped ticket is the one thing here that was never tried. */
.ticket[data-state="skipped"] .dot { background: none; box-shadow: inset 0 0 0 2px var(--skipped); }
.ticket[data-state="skipped"] .ticket-title { color: var(--faint); }

.ticket-title { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.ticket-state { flex: none; color: var(--faint); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; }

.failure { margin: 0; padding: 0 0.75rem 0.6rem; color: var(--failed); font-size: 0.85rem; overflow-wrap: anywhere; }

.attempts { padding: 0 0.75rem 0.75rem; display: grid; gap: 0.75rem; }
.attempt { border-top: 1px solid var(--edge); padding-top: 0.6rem; }
.attempt-head { margin: 0 0 0.4rem; color: var(--faint); font-size: 0.8rem; }
/* What the review made of the attempt, in the colour of the verdict it reached. */
.verdict { margin: 0 0 0.4rem; font-size: 0.85rem; overflow-wrap: anywhere; }
.verdict[data-verdict="approved"] { color: var(--succeeded); }
.verdict[data-verdict="rejected"] { color: var(--failed); }
.hint { margin: 0; color: var(--faint); font-size: 0.85rem; }
.retry { display: block; min-height: 44px; padding: 0; border: 0; background: none; font-family: inherit; text-align: left; text-decoration: underline; cursor: pointer; }

.log {
  margin: 0;
  padding: 0.75rem;
  max-height: 55vh;
  overflow: auto;
  background: var(--page);
  border: 1px solid var(--edge);
  border-radius: 6px;
  font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* The start panel is only for a Supervisor with nothing under way. Which that is
   comes from the live view, which writes the queue's state onto the body — and
   before the first event has arrived nothing is known, so nothing is offered. */
#start-panel { display: none; }
body[data-queue-state="idle"] #start-panel,
body[data-queue-state="completed"] #start-panel,
body[data-queue-state="stopped"] #start-panel,
body[data-queue-state="failed"] #start-panel { display: block; }

.start .field { display: grid; gap: 0.35rem; margin-bottom: 0.75rem; }
.start label { color: var(--faint); font-size: 0.8rem; }
.start input {
  min-height: 44px;
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--edge);
  border-radius: 8px;
  background: var(--page);
  color: inherit;
  font: inherit;
  font-size: 0.9rem;
}
.start .tickets { margin-top: 0.75rem; }

.queue-row { display: flex; align-items: center; gap: 0.6rem; padding: 0.35rem 0.6rem; }
.queue-row .ticket-title { display: flex; align-items: baseline; gap: 0.5rem; cursor: pointer; }
.queue-row[data-state="skipped"] .ticket-title { color: var(--faint); }
.include { flex: none; width: 20px; height: 20px; accent-color: var(--succeeded); }

.moves { flex: none; display: flex; gap: 0.25rem; }
.move { min-width: 44px; padding: 0; font-size: 1rem; }

@media (min-width: 900px) {
  main { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; }
  /* Full width: the queue being edited is wider than either column beside it. */
  #start-panel { grid-column: 1 / -1; }
  .log { max-height: 70vh; }
}
`;
