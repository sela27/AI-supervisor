import { DatabaseSync } from "node:sqlite";

/**
 * SQLite holds the Supervisor's own history — attempt logs, run records.
 * It is never the source of truth for whether a Ticket is done; the Ticket
 * Source is. That keeps a restart from disagreeing with the tracker.
 */
export interface Storage {
  /** Highest applied migration version, read live from the database. */
  schemaVersion(): number;
  close(): void;
}

interface Migration {
  version: number;
  up: string;
}

/**
 * Append a migration here whenever the schema grows; versions apply in order and
 * only once. Empty for now — the skeleton stores nothing yet.
 */
const MIGRATIONS: readonly Migration[] = [];

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
    close: () => db.close(),
  };
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
