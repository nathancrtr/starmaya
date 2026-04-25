import { readFileSync } from "node:fs";

/** Resolved server configuration. */
export interface ServerConfig {
  /** Path to the daemon's Unix domain socket. */
  socketPath: string;
  /** Path to the SQLite database file. Created if missing. */
  dbPath: string;
  /** HTTP port the Fastify server listens on. */
  httpPort: number;
  /** Heartbeat interval to the daemon, in ms. */
  pingIntervalMs: number;
  /** Heartbeat response window. If no pong arrives within this, reconnect. */
  pingTimeoutMs: number;
  /** Initial reconnect backoff delay to the daemon. */
  reconnectBackoffInitialMs: number;
  /** Maximum reconnect backoff delay to the daemon. */
  reconnectBackoffMaxMs: number;
}

const DEFAULTS: ServerConfig = {
  socketPath: "/run/roaster/roaster.sock",
  dbPath: "./roasts.db",
  httpPort: 8080,
  pingIntervalMs: 5000,
  pingTimeoutMs: 2000,
  reconnectBackoffInitialMs: 200,
  reconnectBackoffMaxMs: 5000,
};

/**
 * Load config from a JSON file (if `path` is given) and overlay env-var overrides
 * for paths that typically differ between dev and prod.
 */
export function loadConfig(options: { path?: string } = {}): ServerConfig {
  let fromFile: Partial<ServerConfig> = {};
  if (options.path) {
    const raw = readFileSync(options.path, "utf-8");
    fromFile = JSON.parse(raw) as Partial<ServerConfig>;
  }

  const merged: ServerConfig = {
    ...DEFAULTS,
    ...fromFile,
    socketPath: process.env.ROASTER_SOCKET_PATH ?? fromFile.socketPath ?? DEFAULTS.socketPath,
    dbPath: process.env.ROASTER_DB_PATH ?? fromFile.dbPath ?? DEFAULTS.dbPath,
    httpPort: process.env.ROASTER_HTTP_PORT
      ? Number(process.env.ROASTER_HTTP_PORT)
      : (fromFile.httpPort ?? DEFAULTS.httpPort),
  };

  validate(merged);
  return merged;
}

function validate(cfg: ServerConfig): void {
  if (!Number.isInteger(cfg.httpPort) || cfg.httpPort < 1 || cfg.httpPort > 65535) {
    throw new Error(`httpPort must be a valid port number, got ${cfg.httpPort}`);
  }
  if (cfg.pingIntervalMs <= 0) {
    throw new Error(`pingIntervalMs must be > 0, got ${cfg.pingIntervalMs}`);
  }
  if (cfg.pingTimeoutMs <= 0 || cfg.pingTimeoutMs >= cfg.pingIntervalMs) {
    throw new Error(
      `pingTimeoutMs must be > 0 and < pingIntervalMs, got ${cfg.pingTimeoutMs} (interval ${cfg.pingIntervalMs})`,
    );
  }
  if (cfg.reconnectBackoffInitialMs <= 0 || cfg.reconnectBackoffMaxMs < cfg.reconnectBackoffInitialMs) {
    throw new Error(
      `Invalid reconnect backoff: initial=${cfg.reconnectBackoffInitialMs}, max=${cfg.reconnectBackoffMaxMs}`,
    );
  }
}
