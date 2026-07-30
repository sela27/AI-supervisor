import { DatabaseSync } from "node:sqlite";

/**
 * How an Attempt ended. `limit-hit` is neither of the others: the usage limit cut
 * the Run short, so the ticket was never settled either way.
 */
export type AttemptOutcome = "succeeded" | "failed" | "limit-hit";

/** One Attempt as Verification left it, with everything the Run printed. */
export interface AttemptRecord {
  runId: string;
  ticketId: string;
  outcome: AttemptOutcome;
  /** Why the Supervisor refused it, when it did. */
  failure: string | null;
  output: string;
}

export interface StoredAttempt extends AttemptRecord {
  recordedAt: string;
}

/**
 * SQLite holds the Supervisor's own history — attempt logs, run records.
 * It is never the source of truth for whether a Ticket is done; the Ticket
 * Source is. That keeps a restart from disagreeing with the tracker.
 */
export interface Storage {
  /** Highest applied migration version, read live from the database. */
  schemaVersion(): number;
  /**
   * Keeps an Attempt's log somewhere the failure path cannot reach: a failed
   * Attempt is reset out of the repository, and this is what survives it.
   */
  recordAttempt(attempt: AttemptRecord): void;
  /** Every Attempt one ticket got in one run, oldest first. */
  attemptsFor(runId: string, ticketId: string): StoredAttempt[];
  close(): void;
}

interface Migration {
  version: number;
  up: string;
}

/**
 * Append a migration here whenever the schema grows; versions apply in order and
 * only once.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE attempts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id      TEXT NOT NULL,
        ticket_id   TEXT NOT NULL,
        outcome     TEXT NOT NULL,
        failure     TEXT,
        output      TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX attempts_by_ticket ON attempts (run_id, ticket_id, id);
    `,
  },
];

interface AttemptRow {
  ticket_id: string;
  outcome: string;
  failure: string | null;
  output: string;
  recorded_at: string;
}

export function openStorage(file: string): Storage {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    schemaVersion: () => readSchemaVersion(db),

    recordAttempt: (attempt) => {
      db.prepare(
        `INSERT INTO attempts (run_id, ticket_id, outcome, failure, output, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        attempt.runId,
        attempt.ticketId,
        attempt.outcome,
        attempt.failure,
        attempt.output,
        new Date().toISOString(),
      );
    },

    attemptsFor: (runId, ticketId) => {
      const rows = db
        .prepare(
          `SELECT ticket_id, outcome, failure, output, recorded_at
           FROM attempts WHERE run_id = ? AND ticket_id = ? ORDER BY id`,
        )
        .all(runId, ticketId) as unknown as AttemptRow[];

      return rows.map((row) => ({
        runId,
        ticketId: row.ticket_id,
        outcome: outcomeOf(row.outcome),
        failure: row.failure,
        output: row.output,
        recordedAt: row.recorded_at,
      }));
    },

    close: () => db.close(),
  };
}

/** Anything the column holds that this build does not recognise did not succeed. */
function outcomeOf(stored: string): AttemptOutcome {
  switch (stored) {
    case "succeeded":
    case "limit-hit":
      return stored;
    default:
      return "failed";
  }
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = readSchemaVersion(db);
  const pending = MIGRATIONS.filter((migration) => migration.version > applied);

  for (const migration of pending) {
    db.exec("BEGIN");
    try {
      db.exec(migration.up);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
    | { version: number | null }
    | undefined;
  return row?.version ?? 0;
}
