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

.branch { margin-left: auto; color: var(--faint); font-size: 0.85rem; font-family: ui-monospace, monospace; }

.notice { margin: 0; padding: 0.7rem 1rem; background: rgba(209, 88, 79, 0.14); color: var(--failed); font-size: 0.9rem; }
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

@media (min-width: 900px) {
  main { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; }
  .log { max-height: 70vh; }
}
`;
