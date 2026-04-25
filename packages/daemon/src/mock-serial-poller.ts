import { EventEmitter } from "node:events";
import type {
  DeviceStatus,
  ReadingMessage,
  DeviceStatusMessage,
} from "@starmaya/shared";
import { intervalMs, type DaemonConfig } from "./config.js";

/**
 * Drop-in stand-in for SerialPoller that generates a synthetic bean-temperature
 * curve on a timer. Used during development on machines without the Arduino.
 * Emits the same events as SerialPoller so the socket server cannot tell them
 * apart.
 *
 * The curve loosely follows a real roast: room-temp charge, quick drop into the
 * turning point, steady climb through drying, faster climb through maillard,
 * tapering into first crack, brief plateau, then a gradual hold. After the
 * simulated DROP temperature, it resets and starts over.
 */
export class MockSerialPoller extends EventEmitter {
  private state: DeviceStatus = "error";
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Seconds into the current simulated roast. */
  private t = 0;

  constructor(
    private readonly cfg: DaemonConfig,
    private readonly log: (level: string, msg: string, extra?: object) => void,
  ) {
    super();
  }

  start(): void {
    this.stopped = false;
    this.log("info", "mock_serial_started", {});
    this.setState("connected");
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  getStatus(): DeviceStatus {
    return this.state;
  }

  private setState(next: DeviceStatus): void {
    if (this.state === next) return;
    this.state = next;
    const msg: DeviceStatusMessage = { type: "device_status", status: next };
    this.emit("device_status", msg);
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.tick(), intervalMs(this.cfg));
  }

  private tick(): void {
    if (this.stopped) return;
    const bt = syntheticBT(this.t);
    const msg: ReadingMessage = {
      type: "reading",
      ts: Date.now(),
      bt_c: Math.round(bt * 10) / 10,
      et_c: null,
    };
    this.emit("reading", msg);
    this.t += 1 / this.cfg.sampleRateHz;
    if (this.t > 900) this.t = 0; // loop every 15 simulated minutes
    this.scheduleNext();
  }
}

/**
 * Synthetic bean-temperature curve, in °C, as a function of elapsed seconds
 * since the start of the simulated roast. Rough shape:
 *
 *   0s:    ~200°C (pre-charge drum temp)
 *   30s:   ~90°C  (turning point after charge)
 *   60s:   ~110°C
 *   240s:  ~150°C (dry end-ish)
 *   420s:  ~195°C (first crack)
 *   540s:  ~210°C (drop temp)
 *
 * This is not physically accurate — it's just a plausible-looking curve so
 * the UI has something reasonable to render during development.
 */
function syntheticBT(t: number): number {
  // Phase 1: pre-charge plateau.
  if (t < 1) return 200;
  // Phase 2: sharp drop to turning point over ~30s.
  if (t < 30) {
    const p = t / 30;
    return 200 - (200 - 90) * easeOut(p);
  }
  // Phase 3: drying, roughly linear to 150°C by 240s.
  if (t < 240) {
    const p = (t - 30) / (240 - 30);
    return 90 + (150 - 90) * p;
  }
  // Phase 4: maillard, steeper to 195°C by 420s.
  if (t < 420) {
    const p = (t - 240) / (420 - 240);
    return 150 + (195 - 150) * p;
  }
  // Phase 5: development, tapering to 210°C by 540s.
  if (t < 540) {
    const p = (t - 420) / (540 - 420);
    return 195 + (210 - 195) * easeOut(p);
  }
  // Phase 6: holding near drop temperature with a tiny drift.
  return 210 + Math.sin((t - 540) / 20) * 0.5;
}

function easeOut(p: number): number {
  return 1 - (1 - p) * (1 - p);
}
