import { parseArgs } from "node:util";
import { loadConfig, type DaemonConfig } from "./config.js";
import { SerialPoller } from "./serial-poller.js";
import { MockSerialPoller } from "./mock-serial-poller.js";
import { SocketServer, type ReadingSource } from "./socket-server.js";
import { TC4ArduinoAdapter } from "./adapters/tc4-arduino.js";

interface CliArgs {
  configPath: string | undefined;
  mockSerial: boolean;
}

function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string" },
      "mock-serial": { type: "boolean" },
    },
    strict: true,
  });
  return {
    configPath: values.config,
    mockSerial: Boolean(values["mock-serial"]),
  };
}

/** Structured JSON logger. One object per line on stdout. */
function makeLogger() {
  return (level: string, msg: string, extra?: object) => {
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(extra ?? {}),
    };
    process.stdout.write(JSON.stringify(entry) + "\n");
  };
}

function makeSource(cfg: DaemonConfig, log: ReturnType<typeof makeLogger>): ReadingSource & {
  start(): void;
  stop(): void;
} {
  if (cfg.mockSerial) {
    log("info", "using_mock_serial", {});
    return new MockSerialPoller(cfg, log);
  }
  const adapter = new TC4ArduinoAdapter(cfg);
  return new SerialPoller(cfg, adapter, log);
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2));
  const cfg = loadConfig({ path: args.configPath, mockSerial: args.mockSerial });
  const log = makeLogger();
  log("info", "daemon_starting", {
    socket: cfg.socketPath,
    serial: cfg.mockSerial ? "(mock)" : cfg.serialPath,
    sample_rate_hz: cfg.sampleRateHz,
  });

  const source = makeSource(cfg, log);
  const server = new SocketServer(cfg, source, log);

  source.start();
  server.start();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", "daemon_shutdown", { signal });
    server.stop();
    source.stop();
    // Give pending writes a chance to flush, then exit.
    setTimeout(() => process.exit(0), 100);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  process.stderr.write(`daemon_fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
