import Database from "better-sqlite3";
import type {
  RoastEvent,
  RoastEventRecord,
  RoastRecord,
  ReadingRecord,
} from "@starmaya/shared";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS roasts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  charge_ts   INTEGER NOT NULL,
  drop_ts     INTEGER,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS readings (
  roast_id    TEXT NOT NULL,
  t_ms        INTEGER NOT NULL,
  bt_c        REAL NOT NULL,
  et_c        REAL,
  PRIMARY KEY (roast_id, t_ms),
  FOREIGN KEY (roast_id) REFERENCES roasts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  roast_id    TEXT NOT NULL,
  event       TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  client_id   TEXT NOT NULL,
  UNIQUE (roast_id, client_id),
  FOREIGN KEY (roast_id) REFERENCES roasts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_roast ON events(roast_id);
`;

/** Persistence layer for roasts, readings, and event markers. */
export class Db {
  private readonly db: Database.Database;

  // Prepared statements. Created once at construction and reused.
  private readonly stmtInsertRoast: Database.Statement;
  private readonly stmtSetRoastDrop: Database.Statement;
  private readonly stmtSetRoastName: Database.Statement;
  private readonly stmtGetRoast: Database.Statement;
  private readonly stmtListRoasts: Database.Statement;
  private readonly stmtInsertReading: Database.Statement;
  private readonly stmtGetReadings: Database.Statement;
  private readonly stmtUpsertEvent: Database.Statement;
  private readonly stmtGetEvent: Database.Statement;
  private readonly stmtGetEvents: Database.Statement;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);

    this.stmtInsertRoast = this.db.prepare(
      `INSERT INTO roasts (id, name, charge_ts, drop_ts, created_at)
       VALUES (@id, @name, @chargeTs, @dropTs, @createdAt)`,
    );
    this.stmtSetRoastDrop = this.db.prepare(
      `UPDATE roasts SET drop_ts = @dropTs WHERE id = @id`,
    );
    this.stmtSetRoastName = this.db.prepare(
      `UPDATE roasts SET name = @name WHERE id = @id`,
    );
    this.stmtGetRoast = this.db.prepare(
      `SELECT id, name, charge_ts AS chargeTs, drop_ts AS dropTs, created_at AS createdAt
       FROM roasts WHERE id = ?`,
    );
    this.stmtListRoasts = this.db.prepare(
      `SELECT id, name, charge_ts AS chargeTs, drop_ts AS dropTs, created_at AS createdAt
       FROM roasts ORDER BY charge_ts DESC`,
    );
    this.stmtInsertReading = this.db.prepare(
      `INSERT OR IGNORE INTO readings (roast_id, t_ms, bt_c, et_c)
       VALUES (@roastId, @tMs, @btC, @etC)`,
    );
    this.stmtGetReadings = this.db.prepare(
      `SELECT roast_id AS roastId, t_ms AS tMs, bt_c AS btC, et_c AS etC
       FROM readings WHERE roast_id = ? ORDER BY t_ms ASC`,
    );
    this.stmtUpsertEvent = this.db.prepare(
      `INSERT INTO events (id, roast_id, event, ts, client_id)
       VALUES (@id, @roastId, @event, @ts, @clientId)
       ON CONFLICT (roast_id, client_id) DO UPDATE SET
         event = excluded.event,
         ts = excluded.ts`,
    );
    this.stmtGetEvent = this.db.prepare(
      `SELECT id, roast_id AS roastId, event, ts, client_id AS clientId
       FROM events WHERE roast_id = ? AND client_id = ?`,
    );
    this.stmtGetEvents = this.db.prepare(
      `SELECT id, roast_id AS roastId, event, ts, client_id AS clientId
       FROM events WHERE roast_id = ? ORDER BY ts ASC`,
    );
  }

  close(): void {
    this.db.close();
  }

  // ── Roasts ────────────────────────────────────────────────────────

  insertRoast(roast: RoastRecord): void {
    this.stmtInsertRoast.run(roast);
  }

  setRoastDrop(id: string, dropTs: number): void {
    this.stmtSetRoastDrop.run({ id, dropTs });
  }

  setRoastName(id: string, name: string): void {
    this.stmtSetRoastName.run({ id, name });
  }

  getRoast(id: string): RoastRecord | null {
    const row = this.stmtGetRoast.get(id) as RoastRecord | undefined;
    return row ?? null;
  }

  listRoasts(): RoastRecord[] {
    return this.stmtListRoasts.all() as RoastRecord[];
  }

  // ── Readings ──────────────────────────────────────────────────────

  insertReading(reading: ReadingRecord): void {
    this.stmtInsertReading.run(reading);
  }

  getReadings(roastId: string): ReadingRecord[] {
    return this.stmtGetReadings.all(roastId) as ReadingRecord[];
  }

  // ── Events ────────────────────────────────────────────────────────

  /**
   * Idempotent upsert keyed on (roastId, clientId). Returns the resulting
   * record. If a row already existed for the same client_id, its event/ts
   * are replaced — the most recent POST wins.
   */
  upsertEvent(input: {
    id: string;
    roastId: string;
    event: RoastEvent;
    ts: number;
    clientId: string;
  }): RoastEventRecord {
    this.stmtUpsertEvent.run(input);
    const row = this.stmtGetEvent.get(input.roastId, input.clientId) as RoastEventRecord;
    return row;
  }

  getEvents(roastId: string): RoastEventRecord[] {
    return this.stmtGetEvents.all(roastId) as RoastEventRecord[];
  }
}
