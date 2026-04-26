import { useEffect, useRef, useState } from "react";
import type { DeviceStatus, RoastEvent } from "@starmaya/shared";

/** Active roast as the SSE stream sees it. */
export interface ActiveRoast {
  id: string;
  name: string;
  chargeTs: number;
}

/** A single live reading. */
export interface Tick {
  ts: number;
  btC: number;
  etC: number | null;
}

/** A roast event marker as broadcast over SSE. */
export interface StreamEvent {
  id: string;
  roastId: string;
  event: RoastEvent;
  ts: number;
}

/** What `useStream` exposes to consumers. */
export interface StreamState {
  /** Most recent reading, or null if none received yet. */
  lastTick: Tick | null;
  /** All ticks received during the *current* active roast, oldest first. Cleared on roast_started/roast_ended. */
  ticks: Tick[];
  /** Active roast, if any. */
  activeRoast: ActiveRoast | null;
  /** All event markers for the active roast (matches `ticks` lifecycle). */
  events: StreamEvent[];
  /** Daemon-reported device status. */
  deviceStatus: DeviceStatus;
  /** Whether the EventSource is currently open. */
  connected: boolean;
}

const INITIAL: StreamState = {
  lastTick: null,
  ticks: [],
  activeRoast: null,
  events: [],
  deviceStatus: "disconnected",
  connected: false,
};

/**
 * Subscribes to /api/stream. Returns a snapshot of current live state that
 * re-renders the consumer when anything changes. EventSource handles
 * reconnection automatically.
 */
export function useStream(): StreamState {
  const [state, setState] = useState<StreamState>(INITIAL);
  // Mirror state in a ref so the SSE handlers can append without depending on
  // the React closure capturing a stale `state`.
  const stateRef = useRef<StreamState>(INITIAL);

  useEffect(() => {
    const update = (next: StreamState) => {
      stateRef.current = next;
      setState(next);
    };

    const source = new EventSource("/api/stream");

    source.addEventListener("open", () => {
      update({ ...stateRef.current, connected: true });
    });

    source.addEventListener("error", () => {
      // EventSource will auto-reconnect; we just reflect the current state.
      update({ ...stateRef.current, connected: false });
    });

    source.addEventListener("state", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        activeRoast: ActiveRoast | null;
        deviceStatus: DeviceStatus;
      };
      update({
        ...stateRef.current,
        activeRoast: data.activeRoast,
        deviceStatus: data.deviceStatus,
        // Reset rolling buffers to match whatever roast (or no roast) is active.
        ticks: [],
        events: [],
      });
    });

    source.addEventListener("tick", (e) => {
      const t = JSON.parse((e as MessageEvent).data) as Tick;
      const cur = stateRef.current;
      const ticks = cur.activeRoast ? [...cur.ticks, t] : cur.ticks;
      update({ ...cur, lastTick: t, ticks });
    });

    source.addEventListener("device_status", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        status: DeviceStatus;
      };
      update({ ...stateRef.current, deviceStatus: data.status });
    });

    source.addEventListener("roast_started", (e) => {
      const r = JSON.parse((e as MessageEvent).data) as ActiveRoast;
      update({ ...stateRef.current, activeRoast: r, ticks: [], events: [] });
    });

    source.addEventListener("roast_updated", (e) => {
      const r = JSON.parse((e as MessageEvent).data) as { id: string; name: string };
      const cur = stateRef.current;
      if (!cur.activeRoast || cur.activeRoast.id !== r.id) return;
      update({ ...cur, activeRoast: { ...cur.activeRoast, name: r.name } });
    });

    source.addEventListener("roast_ended", () => {
      const cur = stateRef.current;
      update({ ...cur, activeRoast: null });
    });

    source.addEventListener("event", (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as StreamEvent;
      const cur = stateRef.current;
      if (!cur.activeRoast || cur.activeRoast.id !== ev.roastId) return;
      update({ ...cur, events: [...cur.events, ev] });
    });

    source.addEventListener("sensor_fault", () => {
      // Walking-skeleton: no UI yet; leave handler so it doesn't fire onto error.
    });

    return () => {
      source.close();
    };
  }, []);

  return state;
}
