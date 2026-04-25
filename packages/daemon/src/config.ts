import { readFileSync } from "node:fs";

/** Resolved daemon configuration. */
export interface DaemonConfig {
  socketPath: string;
  serialPath: string;
  serialBaudRate: number;
  sampleRateHz: number;
  bufferSeconds: number;
  maxClients: number;
  reconnectBackoffInitialMs: number;
  reconnectBackoffMaxMs: number;
  btMinPlausibleC: number;
  btMaxPlausibleC: number;
  /** If true, generate a synthetic temperature curve instead of opening the serial port. */
  mockSerial: boolean;
}

const DEFAULTS: DaemonConfig = {
  socketPath: "/run/roaster/roaster.sock",
  serialPath: "/dev/behmor-arduino",
  serialBaudRate: 115200,
  sampleRateHz: 1,
  bufferSeconds: 60,
  maxClients: 2,
  reconnectBackoffInitialMs: 500,
  reconnectBackoffMaxMs: 10000,
  btMinPlausibleC: -50,
  btMaxPlausibleC: 500,
  mockSerial: false,
};

/**
 * Load config from a JSON file (if `path` is given) and overlay env-var overrides.
 * Missing fields fall through to defaults. Throws on parse errors or invalid values.
 */
export function loadConfig(options: { path?: string; mockSerial?: boolean } = {}): DaemonConfig {
  let fromFile: Partial<DaemonConfig> = {};
  if (options.path) {
    const raw = readFileSync(options.path, "utf-8");
    fromFile = JSON.parse(raw) as Partial<DaemonConfig>;
  }

  const merged: DaemonConfig = {
    ...DEFAULTS,
    ...fromFile,
    socketPath: process.env.ROASTER_SOCKET_PATH ?? fromFile.socketPath ?? DEFAULTS.socketPath,
    serialPath: process.env.ROASTER_SERIAL_PATH ?? fromFile.serialPath ?? DEFAULTS.serialPath,
    mockSerial: options.mockSerial ?? fromFile.mockSerial ?? DEFAULTS.mockSerial,
  };

  validate(merged);
  return merged;
}

function validate(cfg: DaemonConfig): void {
  if (cfg.sampleRateHz <= 0) {
    throw new Error(`sampleRateHz must be > 0, got ${cfg.sampleRateHz}`);
  }
  if (cfg.bufferSeconds <= 0) {
    throw new Error(`bufferSeconds must be > 0, got ${cfg.bufferSeconds}`);
  }
  if (cfg.maxClients < 1) {
    throw new Error(`maxClients must be >= 1, got ${cfg.maxClients}`);
  }
  if (cfg.reconnectBackoffInitialMs <= 0 || cfg.reconnectBackoffMaxMs < cfg.reconnectBackoffInitialMs) {
    throw new Error(
      `Invalid reconnect backoff: initial=${cfg.reconnectBackoffInitialMs}, max=${cfg.reconnectBackoffMaxMs}`,
    );
  }
  if (cfg.btMinPlausibleC >= cfg.btMaxPlausibleC) {
    throw new Error(
      `btMinPlausibleC (${cfg.btMinPlausibleC}) must be < btMaxPlausibleC (${cfg.btMaxPlausibleC})`,
    );
  }
}

/** Sample interval in milliseconds, derived from sampleRateHz. */
export function intervalMs(cfg: DaemonConfig): number {
  return 1000 / cfg.sampleRateHz;
}

/** Read timeout in milliseconds. Per daemon-internals.md, this is 2x the sample interval. */
export function readTimeoutMs(cfg: DaemonConfig): number {
  return intervalMs(cfg) * 2;
}

/** Ring buffer capacity in entries, derived from bufferSeconds and sampleRateHz. */
export function ringBufferCapacity(cfg: DaemonConfig): number {
  return Math.max(1, Math.floor(cfg.bufferSeconds * cfg.sampleRateHz));
}
