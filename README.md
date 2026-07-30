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
