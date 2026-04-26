import { EventEmitter } from "node:events";
import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import type {
  DeviceStatus,
  ReadingMessage,
  DeviceStatusMessage,
  SensorFaultMessage,
} from "@starmaya/shared";
import { intervalMs, readTimeoutMs, type DaemonConfig } from "./config.js";

/**
 * Owns the serial port and runs the polling loop. Emits typed events that the
 * socket server forwards to connected clients. Implements the state machine
 * documented in docs/daemon-internals.md.
 *
 * Events:
 *   - "reading"       (msg: ReadingMessage)
 *   - "device_status" (msg: DeviceStatusMessage)
 *   - "sensor_fault"  (msg: SensorFaultMessage)
 */
export interface SerialPollerEvents {
  reading: (msg: ReadingMessage) => void;
  device_status: (msg: DeviceStatusMessage) => void;
  sensor_fault: (msg: SensorFaultMessage) => void;
}

type PendingRead = {
  resolve: (line: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export class SerialPoller extends EventEmitter {
  private state: DeviceStatus = "error";
  private port: SerialPort | null = null;
  private parser: ReadlineParser | null = null;
  private pending: PendingRead | null = null;
  private reconnectDelayMs: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private loopTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly cfg: DaemonConfig,
    private readonly log: (level: string, msg: string, extra?: object) => void,
  ) {
    super();
    this.reconnectDelayMs = cfg.reconnectBackoffInitialMs;
  }

  /** Begin polling. Idempotent — calling twice has no additional effect. */
  start(): void {
    if (!this.stopped && this.port) return;
    this.stopped = false;
    this.tryOpen();
  }

  /** Stop polling and close the port. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.loopTimer) clearTimeout(this.loopTimer);
    this.reconnectTimer = null;
    this.loopTimer = null;
    this.failPending(new Error("poller stopped"));
    this.closePort();
  }

  /** Current device status. The socket server reads this when sending `hello`. */
  getStatus(): DeviceStatus {
    return this.state;
  }

  // ── State machine ──────────────────────────────────────────────────

  private setState(next: DeviceStatus, reason?: string): void {
    if (this.state === next) return;
    this.state = next;
    const msg: DeviceStatusMessage = reason
      ? { type: "device_status", status: next, reason }
      : { type: "device_status", status: next };
    this.emit("device_status", msg);
    this.log("info", "device_status", { status: next, reason });
  }

  // ── Port lifecycle ────────────────────────────────────────────────

  private async tryOpen(): Promise<void> {
    if (this.stopped) return;

    try {
      await this.openPort();
    } catch (err) {
      const reason = `port_open_failed: ${(err as Error).message}`;
      // Log every attempt's reason — setState only emits on actual state
      // transitions, so when we're stuck in "error" we'd otherwise lose
      // visibility into why each retry is failing.
      this.log("warn", "port_open_failed", {
        path: this.cfg.serialPath,
        error: (err as Error).message,
      });
      this.setState("error", reason);
      this.scheduleReconnect();
      return;
    }

    // Port opened. Wait for the device to finish booting (Arduino Uno
    // resets on DTR-on-open and takes ~1.5–2s to come back up) before
    // confirming with a test READ.
    if (this.cfg.postOpenDelayMs > 0) {
      this.log("info", "post_open_delay", { delay_ms: this.cfg.postOpenDelayMs });
      await new Promise((resolve) => setTimeout(resolve, this.cfg.postOpenDelayMs));
      if (this.stopped) return;
    }

    // Confirm with a test READ before declaring connected.
    try {
      const reading = await this.pollOnce();
      this.handleReading(reading);
      this.setState("connected");
      this.reconnectDelayMs = this.cfg.reconnectBackoffInitialMs; // reset backoff
      this.scheduleNextPoll(intervalMs(this.cfg));
    } catch (err) {
      this.log("warn", "initial_read_failed", { error: (err as Error).message });
      this.setState("disconnected", `initial_read_failed: ${(err as Error).message}`);
      this.closePort();
      this.scheduleReconnect();
    }
  }

  private openPort(): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = new SerialPort(
        {
          path: this.cfg.serialPath,
          baudRate: this.cfg.serialBaudRate,
          autoOpen: false,
        },
        (err) => {
          // The constructor's callback fires only if autoOpen is true; with
          // autoOpen: false we use port.open() below. Including for safety.
          if (err) reject(err);
        },
      );
      const parser = port.pipe(new ReadlineParser({ delimiter: "\r\n" }));

      port.open((err) => {
        if (err) {
          reject(err);
          return;
        }
        this.port = port;
        this.parser = parser;
        parser.on("data", (line: string) => this.onLine(line));
        port.on("error", (e) => this.onPortError(e));
        port.on("close", () => this.onPortClose());
        resolve();
      });
    });
  }

  private closePort(): void {
    if (this.parser) {
      this.parser.removeAllListeners("data");
      this.parser = null;
    }
    if (this.port) {
      const p = this.port;
      this.port = null;
      p.removeAllListeners();
      if (p.isOpen) {
        p.close(() => {
          /* swallow — we are closing intentionally */
        });
      }
    }
  }

  private onPortError(err: Error): void {
    this.log("warn", "serial_error", { error: err.message });
    if (this.state === "connected") {
      this.setState("disconnected", `serial_error: ${err.message}`);
    }
    this.failPending(err);
    this.closePort();
    this.scheduleReconnect();
  }

  private onPortClose(): void {
    if (this.stopped) return;
    if (this.state === "connected") {
      this.setState("disconnected", "port_closed");
    }
    this.failPending(new Error("port closed"));
    // closePort() may have already nulled these; defensive.
    this.port = null;
    this.parser = null;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.log("info", "reconnect_scheduled", { delay_ms: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelayMs = Math.min(
        this.reconnectDelayMs * 2,
        this.cfg.reconnectBackoffMaxMs,
      );
      this.tryOpen();
    }, delay);
  }

  // ── Polling loop ──────────────────────────────────────────────────

  private scheduleNextPoll(delay: number): void {
    if (this.stopped) return;
    this.loopTimer = setTimeout(() => this.runIteration(), Math.max(0, delay));
  }

  private async runIteration(): Promise<void> {
    if (this.stopped || this.state !== "connected") return;
    const tStart = Date.now();
    try {
      const reading = await this.pollOnce();
      this.handleReading(reading);
    } catch (err) {
      const reason = `read_timeout_${readTimeoutMs(this.cfg)}ms`;
      this.log("warn", "read_failed", { error: (err as Error).message });
      this.setState("disconnected", reason);
      this.closePort();
      this.scheduleReconnect();
      return;
    }
    const elapsed = Date.now() - tStart;
    this.scheduleNextPoll(intervalMs(this.cfg) - elapsed);
  }

  private pollOnce(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.port || !this.parser) {
        reject(new Error("port not open"));
        return;
      }
      if (this.pending) {
        reject(new Error("read already in flight"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`read timeout after ${readTimeoutMs(this.cfg)}ms`));
      }, readTimeoutMs(this.cfg));
      this.pending = { resolve, reject, timer };
      this.port.write("READ\r\n", (err) => {
        if (err) {
          this.failPending(err);
        }
      });
    });
  }

  private onLine(line: string): void {
    if (!this.pending) return; // unsolicited line; ignore
    const p = this.pending;
    this.pending = null;
    clearTimeout(p.timer);
    p.resolve(line);
  }

  private failPending(err: Error): void {
    if (!this.pending) return;
    const p = this.pending;
    this.pending = null;
    clearTimeout(p.timer);
    p.reject(err);
  }

  // ── Response handling ─────────────────────────────────────────────

  /**
   * Parse a line and emit the appropriate message. Returns the parsed
   * reading on success, throws on transport-level failure (which the caller
   * already catches).
   */
  private handleReading(line: string): void {
    const ts = Date.now();
    const fields = line.trim().split(",");
    if (fields.length < 2) {
      this.log("warn", "malformed_response", { line });
      return;
    }

    const btRaw = parseFloat(fields[1]!);
    const fault = classifyBtFault(btRaw, this.cfg);
    if (fault) {
      const msg: SensorFaultMessage = {
        type: "sensor_fault",
        ts,
        raw: line,
        reason: fault,
      };
      this.emit("sensor_fault", msg);
      return;
    }

    const etRaw = fields[2] !== undefined ? parseFloat(fields[2]) : NaN;
    const etC = Number.isFinite(etRaw) ? etRaw : null;

    const msg: ReadingMessage = {
      type: "reading",
      ts,
      bt_c: btRaw,
      et_c: etC,
    };
    this.emit("reading", msg);
  }
}

/**
 * Classify a BT value against MAX31855 error codes and the configured
 * plausibility range. Returns a fault reason or null if the value is OK.
 */
function classifyBtFault(bt: number, cfg: DaemonConfig): string | null {
  if (Number.isNaN(bt)) return "bt_nan";
  if (bt === -1) return "bt_open_circuit";
  if (bt === -2) return "bt_short_gnd";
  if (bt === -3) return "bt_short_vcc";
  if (bt < cfg.btMinPlausibleC || bt > cfg.btMaxPlausibleC) return "bt_out_of_range";
  return null;
}
