import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  ReadingMessage,
  ReadingRecord,
  RoastEvent,
  RoastEventRecord,
  RoastRecord,
} from "@starmaya/shared";
import type { Db } from "./db.js";

/**
 * Shape of the active-roast summary the manager exposes to consumers
 * (the SSE stream broadcasts this on every change, the HTTP routes
 * include it in roast payloads).
 */
export interface ActiveRoastSummary {
  id: string;
  name: string;
  chargeTs: number;
  /** Latest reading received during this roast, if any. */
  lastReading: ReadingRecord | null;
}

/**
 * Owns the in-memory state for the active roast and persists readings
 * and events to SQLite.
 *
 * Events:
 *   - "roast_started" (summary: ActiveRoastSummary)
 *   - "roast_updated" (summary: ActiveRoastSummary)   // name change
 *   - "roast_ended"   (roast: RoastRecord)
 *   - "reading"       (reading: ReadingRecord)        // only when a roast is active
 *   - "event"         (event: RoastEventRecord)
 */
export class RoastManager extends EventEmitter {
  private active: ActiveRoastSummary | null = null;

  constructor(
    private readonly db: Db,
    private readonly log: (level: string, msg: string, extra?: object) => void,
  ) {
    super();
  }

  // ── Active roast state ────────────────────────────────────────────

  getActive(): ActiveRoastSummary | null {
    return this.active;
  }

  /**
   * Start a roast. The chargeTs comes from the CHARGE event and is the
   * absolute timestamp the roast began. Throws if a roast is already
   * active — callers must DROP first.
   */
  startRoast(input: { name: string; chargeTs: number }): RoastRecord {
    if (this.active) {
      throw new Error(`roast already active: ${this.active.id}`);
    }
    const roast: RoastRecord = {
      id: randomUUID(),
      name: input.name,
      chargeTs: input.chargeTs,
      dropTs: null,
      createdAt: new Date().toISOString(),
    };
    this.db.insertRoast(roast);
    this.active = {
      id: roast.id,
      name: roast.name,
      chargeTs: roast.chargeTs,
      lastReading: null,
    };
    this.log("info", "roast_started", { id: roast.id, name: roast.name });
    this.emit("roast_started", this.active);
    return roast;
  }

  /**
   * End the active roast. The dropTs is the absolute timestamp of DROP.
   * Returns the completed RoastRecord. No-op (returns null) if no roast
   * is active.
   */
  endRoast(dropTs: number): RoastRecord | null {
    if (!this.active) return null;
    const id = this.active.id;
    this.db.setRoastDrop(id, dropTs);
    const roast = this.db.getRoast(id);
    this.active = null;
    if (roast) {
      this.log("info", "roast_ended", { id, drop_ts: dropTs });
      this.emit("roast_ended", roast);
    }
    return roast;
  }

  /** Update the active roast's name. */
  renameActive(name: string): ActiveRoastSummary | null {
    if (!this.active) return null;
    this.db.setRoastName(this.active.id, name);
    this.active = { ...this.active, name };
    this.emit("roast_updated", this.active);
    return this.active;
  }

  // ── Readings ──────────────────────────────────────────────────────

  /**
   * Handle a reading from the daemon. If a roast is active, persist the
   * reading with `t_ms` relative to the CHARGE timestamp and broadcast.
   * Readings before CHARGE or after DROP are ignored at this layer.
   */
  handleReading(msg: ReadingMessage): void {
    if (!this.active) return;
    const tMs = msg.ts - this.active.chargeTs;
    if (tMs < 0) {
      // Daemon reading predates the CHARGE we just recorded. Skip.
      return;
    }
    const record: ReadingRecord = {
      roastId: this.active.id,
      tMs,
      btC: msg.bt_c,
      etC: msg.et_c,
    };
    this.db.insertReading(record);
    this.active = { ...this.active, lastReading: record };
    this.emit("reading", record);
  }

  // ── Events ────────────────────────────────────────────────────────

  /**
   * Idempotent upsert. The CHARGE event's ts becomes the roast's chargeTs;
   * the DROP event's ts ends the roast. Other events (DRY_END, FC_START,
   * FC_END) are recorded but don't affect roast lifecycle.
   *
   * On retry with the same clientId, the original event row is updated;
   * lifecycle effects from the original call are NOT re-applied.
   */
  recordEvent(input: {
    roastId: string;
    event: RoastEvent;
    ts: number;
    clientId: string;
  }): RoastEventRecord {
    const id = randomUUID();
    const record = this.db.upsertEvent({ id, ...input });
    this.log("info", "event_recorded", {
      roast_id: input.roastId,
      event: input.event,
      ts: input.ts,
    });
    this.emit("event", record);
    return record;
  }
}
