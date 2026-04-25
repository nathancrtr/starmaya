import { createServer, type Server, type Socket } from "node:net";
import { unlinkSync, existsSync } from "node:fs";
import { chmodSync } from "node:fs";
import type {
  DaemonMessage,
  HelloMessage,
  ReadingMessage,
  DeviceStatusMessage,
  SensorFaultMessage,
  ServerMessage,
  PongMessage,
  DeviceStatus,
} from "@starmaya/shared";
import { RingBuffer } from "./ring-buffer.js";
import type { DaemonConfig } from "./config.js";
import { ringBufferCapacity } from "./config.js";

const PROTOCOL_VERSION = 1;

/** Minimal interface the socket server needs from whatever is producing readings. */
export interface ReadingSource {
  on(event: "reading", listener: (msg: ReadingMessage) => void): this;
  on(event: "device_status", listener: (msg: DeviceStatusMessage) => void): this;
  on(event: "sensor_fault", listener: (msg: SensorFaultMessage) => void): this;
  getStatus(): DeviceStatus;
}

interface Client {
  socket: Socket;
  /** Partial line accumulator for incoming data from the web server. */
  inbound: string;
}

/**
 * Accepts connections from the web server on the Unix domain socket, sends
 * each new client a `hello` + buffered-readings replay, then forwards live
 * messages from the reading source. Handles ping/pong per daemon-protocol.md.
 */
export class SocketServer {
  private readonly buffer: RingBuffer<ReadingMessage>;
  private readonly clients = new Set<Client>();
  private server: Server | null = null;

  constructor(
    private readonly cfg: DaemonConfig,
    private readonly source: ReadingSource,
    private readonly log: (level: string, msg: string, extra?: object) => void,
  ) {
    this.buffer = new RingBuffer<ReadingMessage>(ringBufferCapacity(cfg));
  }

  start(): void {
    // Record readings into the ring buffer and fan out to connected clients.
    this.source.on("reading", (msg) => {
      this.buffer.push(msg);
      this.broadcast(msg);
    });
    this.source.on("device_status", (msg) => this.broadcast(msg));
    this.source.on("sensor_fault", (msg) => this.broadcast(msg));

    if (existsSync(this.cfg.socketPath)) {
      unlinkSync(this.cfg.socketPath);
    }

    this.server = createServer((socket) => this.onConnection(socket));
    this.server.on("error", (err) => {
      this.log("error", "socket_server_error", { error: err.message });
    });
    this.server.listen(this.cfg.socketPath, () => {
      try {
        chmodSync(this.cfg.socketPath, 0o660);
      } catch (err) {
        this.log("warn", "chmod_failed", { error: (err as Error).message });
      }
      this.log("info", "socket_listening", { path: this.cfg.socketPath });
    });
  }

  stop(): void {
    for (const c of this.clients) c.socket.destroy();
    this.clients.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (existsSync(this.cfg.socketPath)) {
      try {
        unlinkSync(this.cfg.socketPath);
      } catch {
        /* best-effort */
      }
    }
  }

  // ── Connection handling ───────────────────────────────────────────

  private onConnection(socket: Socket): void {
    if (this.clients.size >= this.cfg.maxClients) {
      this.log("warn", "client_rejected_max_clients", { count: this.clients.size });
      socket.destroy();
      return;
    }

    const client: Client = { socket, inbound: "" };
    this.clients.add(client);
    this.log("info", "client_connected", { count: this.clients.size });

    socket.on("data", (chunk) => this.onData(client, chunk));
    socket.on("error", (err) => {
      this.log("warn", "client_socket_error", { error: err.message });
    });
    socket.on("close", () => {
      this.clients.delete(client);
      this.log("info", "client_disconnected", { count: this.clients.size });
    });

    // Snapshot the buffer so live readings arriving during this send don't
    // duplicate or reorder. New readings captured after this point are fanned
    // out via broadcast() and land after the replay in the kernel send buffer.
    const snapshot = this.buffer.snapshot();
    const hello: HelloMessage = {
      type: "hello",
      protocol: PROTOCOL_VERSION,
      device_status: this.source.getStatus(),
      buffered_count: snapshot.length,
    };
    this.send(client, hello);
    for (const r of snapshot) this.send(client, r);
  }

  private onData(client: Client, chunk: Buffer): void {
    client.inbound += chunk.toString("utf-8");
    let idx: number;
    while ((idx = client.inbound.indexOf("\n")) !== -1) {
      const line = client.inbound.slice(0, idx);
      client.inbound = client.inbound.slice(idx + 1);
      if (line.length === 0) continue;
      this.handleLine(client, line);
    }
  }

  private handleLine(client: Client, line: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(line) as ServerMessage;
    } catch {
      this.log("warn", "malformed_server_message", { line });
      return;
    }
    switch (msg.type) {
      case "ping": {
        const pong: PongMessage = { type: "pong", id: msg.id };
        this.send(client, pong);
        return;
      }
      default: {
        // Forward compatibility: unknown types are logged and ignored.
        this.log("info", "unknown_server_message", { type: (msg as { type: string }).type });
      }
    }
  }

  // ── Outbound ──────────────────────────────────────────────────────

  private broadcast(msg: DaemonMessage): void {
    for (const c of this.clients) this.send(c, msg);
  }

  private send(client: Client, msg: DaemonMessage): void {
    const line = JSON.stringify(msg) + "\n";
    if (!client.socket.writable) return;
    client.socket.write(line, (err) => {
      if (err) this.log("warn", "write_failed", { error: err.message });
    });
  }
}
