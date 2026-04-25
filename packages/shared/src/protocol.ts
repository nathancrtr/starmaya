/** Device-level status of the serial link to the Arduino. */
export type DeviceStatus = "connected" | "disconnected" | "error";

// ── Daemon → Server messages ────────────────────────────────────────

export interface HelloMessage {
  type: "hello";
  protocol: number;
  device_status: DeviceStatus;
  buffered_count: number;
}

export interface ReadingMessage {
  type: "reading";
  ts: number;
  bt_c: number;
  et_c: number | null;
}

export interface DeviceStatusMessage {
  type: "device_status";
  status: DeviceStatus;
  reason?: string;
}

export interface SensorFaultMessage {
  type: "sensor_fault";
  ts: number;
  raw: string;
  reason: string;
}

export interface PongMessage {
  type: "pong";
  id: string;
}

/** Union of all messages the daemon sends to the server. */
export type DaemonMessage =
  | HelloMessage
  | ReadingMessage
  | DeviceStatusMessage
  | SensorFaultMessage
  | PongMessage;

// ── Server → Daemon messages ────────────────────────────────────────

export interface PingMessage {
  type: "ping";
  id: string;
}

/** Union of all messages the server sends to the daemon. */
export type ServerMessage = PingMessage;
