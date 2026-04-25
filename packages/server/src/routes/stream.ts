import type { FastifyInstance } from "fastify";
import type {
  ReadingMessage,
  DeviceStatusMessage,
  SensorFaultMessage,
  RoastEventRecord,
} from "@starmaya/shared";
import { SseConnection } from "../sse.js";
import type { DaemonClient } from "../daemon-client.js";
import type { RoastManager, ActiveRoastSummary } from "../roast-manager.js";

interface Deps {
  daemonClient: DaemonClient;
  roastManager: RoastManager;
}

/**
 * Registers GET /api/stream — a Server-Sent Events endpoint.
 *
 * On connect, sends a `state` event with the current snapshot, then forwards
 * live updates from DaemonClient and RoastManager. The SSE event vocabulary
 * is documented in docs/server-internals.md; the browser uses it to drive the
 * live BT readout, chart, connection indicator, and roast lifecycle UI.
 */
export function registerStreamRoute(fastify: FastifyInstance, deps: Deps): void {
  const { daemonClient, roastManager } = deps;

  fastify.get("/api/stream", (request, reply) => {
    const sse = new SseConnection(reply.raw);

    // Initial snapshot. Lets the browser render the right state without
    // waiting for the next event.
    sse.send("state", {
      activeRoast: roastManager.getActive(),
      deviceStatus: daemonClient.getDeviceStatus(),
    });

    // ── DaemonClient → SSE ─────────────────────────────────────────
    const onReading = (msg: ReadingMessage) => {
      sse.send("tick", { ts: msg.ts, btC: msg.bt_c, etC: msg.et_c });
    };
    const onDeviceStatus = (msg: DeviceStatusMessage) => {
      sse.send("device_status", { status: msg.status, reason: msg.reason });
    };
    const onSensorFault = (msg: SensorFaultMessage) => {
      sse.send("sensor_fault", { ts: msg.ts, reason: msg.reason });
    };

    daemonClient.on("reading", onReading);
    daemonClient.on("device_status", onDeviceStatus);
    daemonClient.on("sensor_fault", onSensorFault);

    // ── RoastManager → SSE ─────────────────────────────────────────
    const onRoastStarted = (s: ActiveRoastSummary) => {
      sse.send("roast_started", { id: s.id, name: s.name, chargeTs: s.chargeTs });
    };
    const onRoastUpdated = (s: ActiveRoastSummary) => {
      sse.send("roast_updated", { id: s.id, name: s.name });
    };
    const onRoastEnded = (roast: { id: string; dropTs: number | null }) => {
      sse.send("roast_ended", { id: roast.id, dropTs: roast.dropTs });
    };
    const onEvent = (record: RoastEventRecord) => {
      sse.send("event", {
        id: record.id,
        roastId: record.roastId,
        event: record.event,
        ts: record.ts,
      });
    };

    roastManager.on("roast_started", onRoastStarted);
    roastManager.on("roast_updated", onRoastUpdated);
    roastManager.on("roast_ended", onRoastEnded);
    roastManager.on("event", onEvent);

    // ── Cleanup ────────────────────────────────────────────────────
    request.raw.on("close", () => {
      daemonClient.off("reading", onReading);
      daemonClient.off("device_status", onDeviceStatus);
      daemonClient.off("sensor_fault", onSensorFault);
      roastManager.off("roast_started", onRoastStarted);
      roastManager.off("roast_updated", onRoastUpdated);
      roastManager.off("roast_ended", onRoastEnded);
      roastManager.off("event", onEvent);
      sse.close();
    });

    // Tell Fastify we're handling the response manually — it should not try
    // to send headers/body or close the connection itself.
    return reply;
  });
}
