import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import type {
  DaemonMessage,
  HelloMessage,
  ReadingMessage,
  DeviceStatusMessage,
  SensorFaultMessage,
  PongMessage,
  PingMessage,
  DeviceStatus,
} from "@starmaya/shared";
import type { ServerConfig } from "./config.js";

/** Highest daemon protocol version this client knows how to speak. */
const MAX_PROTOCOL_VERSION = 1;

/**
 * Connects to the roaster daemon's Unix domain socket and re-emits parsed
 * messages as typed events. Owns:
 *   - line parsing (ndjson)
 *   - protocol version check on hello
 *   - 5s heartbeat with 2s response window
 *   - exponential reconnect backoff on disconnect
 *
 * Events:
 *   - "hello"         (msg: HelloMessage)
 *   - "reading"       (msg: ReadingMessage)
 *   - "device_status" (msg: DeviceStatusMessage)
 *   - "sensor_fault"  (msg: SensorFaultMessage)
 *   - "connection"    (status: "connected" | "disconnected")
 */
export class DaemonClient extends EventEmitter {
  private socket: Socket | null = null;
  private inbound = "";
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs: number;
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private pendingPingId: string | null = null;
  private deviceStatus: DeviceStatus = "disconnected";
  private connected = false;
  private stopped = false;

  constructor(
    private readonly cfg: ServerConfig,
    private readonly log: (level: string, msg: string, extra?: object) => void,
  ) {
    super();
    this.reconnectDelayMs = cfg.reconnectBackoffInitialMs;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }

  /** Whether the socket is currently connected. */
  isConnected(): boolean {
    return this.connected;
  }

  /** The most recent device_status reported by the daemon. */
  getDeviceStatus(): DeviceStatus {
    return this.deviceStatus;
  }

  // ── Connection ────────────────────────────────────────────────────

  private connect(): void {
    if (this.stopped) return;
    this.log("info", "daemon_connect_attempt", { path: this.cfg.socketPath });

    const socket = createConnection(this.cfg.socketPath);
    this.socket = socket;
    this.inbound = "";

    socket.on("connect", () => {
      this.connected = true;
      this.reconnectDelayMs = this.cfg.reconnectBackoffInitialMs; // reset
      this.log("info", "daemon_connected", {});
      this.emit("connection", "connected");
      this.startHeartbeat();
    });

    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (err) => {
      this.log("warn", "daemon_socket_error", { error: err.message });
    });
    socket.on("close", () => this.onClose());
  }

  private onClose(): void {
    if (this.connected) {
      this.connected = false;
      this.deviceStatus = "disconnected";
      this.log("info", "daemon_disconnected", {});
      this.emit("connection", "disconnected");
    }
    this.clearTimers();
    this.socket?.removeAllListeners();
    this.socket = null;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.log("info", "daemon_reconnect_scheduled", { delay_ms: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelayMs = Math.min(
        this.reconnectDelayMs * 2,
        this.cfg.reconnectBackoffMaxMs,
      );
      this.connect();
    }, delay);
  }

  // ── Inbound parsing ───────────────────────────────────────────────

  private onData(chunk: Buffer): void {
    this.inbound += chunk.toString("utf-8");
    let idx: number;
    while ((idx = this.inbound.indexOf("\n")) !== -1) {
      const line = this.inbound.slice(0, idx);
      this.inbound = this.inbound.slice(idx + 1);
      if (line.length === 0) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: DaemonMessage;
    try {
      msg = JSON.parse(line) as DaemonMessage;
    } catch {
      this.log("warn", "malformed_daemon_message", { line });
      return;
    }
    switch (msg.type) {
      case "hello":
        this.handleHello(msg);
        return;
      case "reading":
        this.emit("reading", msg satisfies ReadingMessage);
        return;
      case "device_status":
        this.deviceStatus = msg.status;
        this.emit("device_status", msg satisfies DeviceStatusMessage);
        return;
      case "sensor_fault":
        this.emit("sensor_fault", msg satisfies SensorFaultMessage);
        return;
      case "pong":
        this.handlePong(msg);
        return;
      default: {
        // Forward compatibility: log unknown types and ignore.
        this.log("info", "unknown_daemon_message", {
          type: (msg as { type: string }).type,
        });
      }
    }
  }

  private handleHello(msg: HelloMessage): void {
    this.log("info", "daemon_hello", {
      protocol: msg.protocol,
      device_status: msg.device_status,
      buffered_count: msg.buffered_count,
    });
    if (msg.protocol > MAX_PROTOCOL_VERSION) {
      this.log("error", "protocol_version_too_new", {
        daemon: msg.protocol,
        supported_max: MAX_PROTOCOL_VERSION,
      });
      // Per docs/daemon-protocol.md: log fatal and exit. systemd will restart.
      process.exit(1);
    }
    this.deviceStatus = msg.device_status;
    this.emit("hello", msg);
  }

  // ── Heartbeat ─────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.clearTimers();
    this.pingTimer = setInterval(() => this.sendPing(), this.cfg.pingIntervalMs);
  }

  private sendPing(): void {
    if (!this.socket || !this.connected) return;
    if (this.pendingPingId) return; // previous ping still outstanding; let timeout handle it
    const id = randomUUID();
    this.pendingPingId = id;
    const ping: PingMessage = { type: "ping", id };
    this.write(ping);
    this.pongTimer = setTimeout(() => {
      this.log("warn", "ping_timeout", { id, timeout_ms: this.cfg.pingTimeoutMs });
      this.pendingPingId = null;
      this.tearDownAndReconnect();
    }, this.cfg.pingTimeoutMs);
  }

  private handlePong(msg: PongMessage): void {
    if (this.pendingPingId !== msg.id) {
      this.log("warn", "unexpected_pong", { id: msg.id, pending: this.pendingPingId });
      return;
    }
    this.pendingPingId = null;
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private tearDownAndReconnect(): void {
    if (this.socket) {
      this.socket.destroy();
    }
  }

  // ── Outbound ──────────────────────────────────────────────────────

  private write(msg: PingMessage): void {
    if (!this.socket || !this.connected) return;
    this.socket.write(JSON.stringify(msg) + "\n", (err) => {
      if (err) this.log("warn", "daemon_write_failed", { error: err.message });
    });
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.pongTimer = null;
    this.pendingPingId = null;
    // reconnectTimer intentionally not cleared here — we don't want stop() and
    // tearDownAndReconnect() flows to interfere. stop() handles its own cleanup.
  }
}
