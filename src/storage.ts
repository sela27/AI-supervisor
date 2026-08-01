import { DatabaseSync } from "node:sqlite";

import { parsedJson } from "./json.js";
import { spendOf, spentAltogether, type Spend } from "./runner/spend.js";
import type { AttemptReview, ReviewVerdict } from "./verification/review.js";

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
  /**
   * What the review made of it, for an instance that asked for one. Nothing at
   * all where no reviewer ever saw the Attempt — an approval that was never
   * given and a review that was never asked for must not read alike.
   */
  review: AttemptReview | null;
  /**
   * What the Attempt spent, the Run it was and the review it was put through
   * together. Nothing where nothing was reported: an Attempt with no figures
   * against it is one nobody priced, never one that was free.
   */
  spend: Spend | null;
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
  /**
   * What a whole run has spent, every Attempt of it added up. Added up here
   * rather than tallied as the night goes, so what the run reports cannot drift
   * from what is filed under it and a Supervisor that restarted has nothing to
   * remember. Nothing where no Attempt of it reported a figure.
   */
  spentOn(runId: string): Spend | null;
  /**
   * Writes a run down as it stands, over whatever was written of it before. A run
   * is only ever worth its latest state: what came before it is history the
   * Attempt logs already hold.
   *
   * What a run record holds is the queue's own business, here and back again: this
   * stores what it is given and answers with what it stored.
   */
  saveRun(runId: string, record: unknown): void;
  /**
   * The run last written down, for a Supervisor working out what it was in the
   * middle of. What is on the disk was written by some build of the Supervisor,
   * not necessarily this one, so reading it as a run is the queue's to do.
   */
  lastRun(): unknown;
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
  {
    // One column for the whole run rather than a column per field: the record is
    // written at every ticket boundary, read whole by exactly one reader, and its
    // shape is the queue's own. Spelling it out here would buy queries nobody
    // makes, at the price of a migration every time the queue learns a new field.
    version: 2,
    up: `
      CREATE TABLE runs (
        id         TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        record     TEXT NOT NULL
      );
    `,
  },
  {
    // Verification's optional second stage, kept beside the Attempt it judged.
    // Null in both columns for every Attempt no reviewer ever saw, which is
    // every Attempt written before this and every one an instance that never
    // asked for reviews will write after it.
    version: 3,
    up: `
      ALTER TABLE attempts ADD COLUMN review_verdict TEXT;
      ALTER TABLE attempts ADD COLUMN review_reasoning TEXT;
    `,
  },
  {
    // What each Attempt spent. A column apiece rather than the one blob the runs
    // table gets: these are three figures that will not grow into a fourth, and
    // the only interesting question about them — what a whole night cost — is a
    // sum across rows, which a blob could not answer.
    //
    // Null in all three for every Attempt written before this, and for every one
    // whose Run reported no figures. Nought would have been a lie in both cases.
    version: 4,
    up: `
      ALTER TABLE attempts ADD COLUMN cost_usd REAL;
      ALTER TABLE attempts ADD COLUMN turns INTEGER;
      ALTER TABLE attempts ADD COLUMN duration_ms INTEGER;
    `,
  },
];

interface AttemptRow {
  ticket_id: string;
  outcome: string;
  failure: string | null;
  output: string;
  recorded_at: string;
  review_verdict: string | null;
  review_reasoning: string | null;
  cost_usd: number | null;
  turns: number | null;
  duration_ms: number | null;
}

/** What the figures come back as, added up or a row at a time. */
type SpendRow = Pick<AttemptRow, "cost_usd" | "turns" | "duration_ms">;

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
        `INSERT INTO attempts
           (run_id, ticket_id, outcome, failure, output, recorded_at,
            review_verdict, review_reasoning, cost_usd, turns, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        attempt.runId,
        attempt.ticketId,
        attempt.outcome,
        attempt.failure,
        attempt.output,
        new Date().toISOString(),
        attempt.review?.verdict ?? null,
        attempt.review?.reasoning ?? null,
        attempt.spend?.costUsd ?? null,
        attempt.spend?.turns ?? null,
        attempt.spend?.durationMs ?? null,
      );
    },

    attemptsFor: (runId, ticketId) => {
      const rows = db
        .prepare(
          `SELECT ticket_id, outcome, failure, output, recorded_at,
                  review_verdict, review_reasoning, cost_usd, turns, duration_ms
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
        review: reviewOf(row),
        spend: spentIn(row) ?? null,
      }));
    },

    spentOn: (runId) => {
      // Added up here rather than by SQL, so that what a whole night spent and
      // what one Attempt spent are added the same way, in the one place that
      // knows a figure nobody reported is not a nought. It is a night's worth of
      // rows — tens of them — so the live watch can ask as often as it looks.
      const rows = db
        .prepare(`SELECT cost_usd, turns, duration_ms FROM attempts WHERE run_id = ?`)
        .all(runId) as unknown as SpendRow[];

      return spentAltogether(rows.map(spentIn)) ?? null;
    },

    saveRun: (runId, record) => {
      db.prepare(
        `INSERT INTO runs (id, updated_at, record) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, record = excluded.record`,
      ).run(runId, new Date().toISOString(), JSON.stringify(record));
    },

    lastRun: () => {
      const row = db
        .prepare("SELECT record FROM runs ORDER BY updated_at DESC, id DESC LIMIT 1")
        .get() as { record: string } | undefined;
      return row === undefined ? undefined : parsedJson(row.record);
    },

    close: () => db.close(),
  };
}

/**
 * What the review said about the Attempt, or nothing where no reviewer saw it.
 * A verdict this build does not recognise is one it cannot read as an approval,
 * so it is read as the refusal it might have been.
 */
function reviewOf(row: AttemptRow): AttemptReview | null {
  if (row.review_verdict === null) return null;

  const verdict: ReviewVerdict = row.review_verdict === "approved" ? "approved" : "rejected";
  return { verdict, reasoning: row.review_reasoning ?? "" };
}

/** What the columns say was spent, or nothing where they say nothing at all. */
function spentIn(row: SpendRow): Spend | undefined {
  return spendOf({
    costUsd: row.cost_usd,
    turns: row.turns,
    durationMs: row.duration_ms,
  });
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
