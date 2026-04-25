/** The time-critical events a roaster marks during a roast. */
export type RoastEvent = "CHARGE" | "DRY_END" | "FC_START" | "FC_END" | "DROP";

/** An event marker recorded during a roast. */
export interface RoastEventRecord {
  id: string;
  roastId: string;
  event: RoastEvent;
  /** Absolute timestamp, Unix milliseconds UTC. */
  ts: number;
  /** Client-generated UUID for idempotent upsert. */
  clientId: string;
}

/** A persisted roast. */
export interface RoastRecord {
  id: string;
  name: string;
  /** Absolute timestamp of CHARGE, Unix milliseconds UTC. */
  chargeTs: number;
  /** Absolute timestamp of DROP, or null if the roast is still in progress. */
  dropTs: number | null;
  createdAt: string;
}

/** A single temperature reading within a roast. */
export interface ReadingRecord {
  roastId: string;
  /** Milliseconds since CHARGE. */
  tMs: number;
  btC: number;
  etC: number | null;
}
