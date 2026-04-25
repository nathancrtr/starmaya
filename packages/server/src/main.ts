import Fastify from "fastify";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { Db } from "./db.js";
import { DaemonClient } from "./daemon-client.js";
import { RoastManager } from "./roast-manager.js";
import { registerStreamRoute } from "./routes/stream.js";
import { registerRoastRoutes } from "./routes/roasts.js";
import type { ReadingMessage } from "@starmaya/shared";

interface CliArgs {
  configPath: string | undefined;
}

function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string" },
    },
    strict: true,
  });
  return { configPath: values.config };
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

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2));
  const cfg = loadConfig({ path: args.configPath });
  const log = makeLogger();
  log("info", "server_starting", {
    socket: cfg.socketPath,
    db: cfg.dbPath,
    http_port: cfg.httpPort,
  });

  const db = new Db(cfg.dbPath);
  const daemonClient = new DaemonClient(cfg, log);
  const roastManager = new RoastManager(db, log);

  // Bridge daemon readings into RoastManager so they get persisted with
  // roast-relative tMs when a roast is active. The SSE handler subscribes
  // to "reading" directly on daemonClient for the always-live BT readout —
  // this is a separate concern and is wired up per browser connection.
  daemonClient.on("reading", (msg: ReadingMessage) => {
    roastManager.handleReading(msg);
  });

  const fastify = Fastify({ logger: false });
  registerStreamRoute(fastify, { daemonClient, roastManager });
  registerRoastRoutes(fastify, { db, roastManager });

  daemonClient.start();
  await fastify.listen({ port: cfg.httpPort, host: "0.0.0.0" });
  log("info", "server_listening", { port: cfg.httpPort });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", "server_shutdown", { signal });
    daemonClient.stop();
    try {
      await fastify.close();
    } catch (err) {
      log("warn", "fastify_close_error", { error: (err as Error).message });
    }
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  process.stderr.write(`server_fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
