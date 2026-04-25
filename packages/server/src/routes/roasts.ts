import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { RoastEvent } from "@starmaya/shared";
import type { Db } from "../db.js";
import type { RoastManager } from "../roast-manager.js";

interface Deps {
  db: Db;
  roastManager: RoastManager;
}

const VALID_EVENTS: ReadonlySet<RoastEvent> = new Set([
  "CHARGE",
  "DRY_END",
  "FC_START",
  "FC_END",
  "DROP",
]);

/**
 * Registers the REST endpoints for roasts and events.
 *
 *   GET    /api/roasts             list summaries (newest first)
 *   GET    /api/roasts/:id         full detail (roast + readings + events)
 *   POST   /api/roasts             create a roast (CHARGE pressed)
 *   PATCH  /api/roasts/:id         rename and/or end (DROP pressed)
 *   POST   /api/roasts/:id/events  idempotent event upsert (DRY_END, FC_*, etc.)
 */
export function registerRoastRoutes(fastify: FastifyInstance, deps: Deps): void {
  const { db, roastManager } = deps;

  // ── List ──────────────────────────────────────────────────────────
  fastify.get("/api/roasts", async () => {
    return { roasts: db.listRoasts() };
  });

  // ── Detail ────────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>("/api/roasts/:id", async (req, reply) => {
    const roast = db.getRoast(req.params.id);
    if (!roast) {
      return reply.code(404).send({ error: "roast_not_found" });
    }
    return {
      roast,
      readings: db.getReadings(roast.id),
      events: db.getEvents(roast.id),
    };
  });

  // ── Create (CHARGE) ───────────────────────────────────────────────
  fastify.post<{ Body: { name?: string; chargeTs?: number; clientId?: string } }>(
    "/api/roasts",
    async (req, reply) => {
      const { name, chargeTs, clientId } = req.body ?? {};
      if (typeof name !== "string" || name.length === 0) {
        return reply.code(400).send({ error: "name_required" });
      }
      if (typeof chargeTs !== "number" || !Number.isFinite(chargeTs)) {
        return reply.code(400).send({ error: "charge_ts_required" });
      }
      if (typeof clientId !== "string" || clientId.length === 0) {
        return reply.code(400).send({ error: "client_id_required" });
      }

      // If the same clientId already produced a CHARGE, we're being retried
      // — return the existing roast rather than starting a new one.
      const active = roastManager.getActive();
      if (active) {
        const existing = db.getEvents(active.id).find(
          (e) => e.event === "CHARGE" && e.clientId === clientId,
        );
        if (existing) {
          const roast = db.getRoast(active.id);
          if (roast) return reply.code(200).send({ roast });
        }
        return reply.code(409).send({ error: "roast_already_active", id: active.id });
      }

      const roast = roastManager.startRoast({ name, chargeTs });
      // Record the CHARGE event itself so it appears in the events list.
      roastManager.recordEvent({
        roastId: roast.id,
        event: "CHARGE",
        ts: chargeTs,
        clientId,
      });
      return reply.code(201).send({ roast });
    },
  );

  // ── Patch (rename / end / DROP) ───────────────────────────────────
  fastify.patch<{
    Params: { id: string };
    Body: { name?: string; dropTs?: number; clientId?: string };
  }>("/api/roasts/:id", async (req, reply) => {
    const { id } = req.params;
    const { name, dropTs, clientId } = req.body ?? {};
    const roast = db.getRoast(id);
    if (!roast) {
      return reply.code(404).send({ error: "roast_not_found" });
    }

    if (typeof name === "string" && name.length > 0) {
      // Only the active roast has a live in-memory name to update.
      if (roastManager.getActive()?.id === id) {
        roastManager.renameActive(name);
      } else {
        db.setRoastName(id, name);
      }
    }

    if (typeof dropTs === "number" && Number.isFinite(dropTs)) {
      if (typeof clientId !== "string" || clientId.length === 0) {
        return reply.code(400).send({ error: "client_id_required_for_drop" });
      }
      // Idempotent: if a DROP event with this clientId already exists, just
      // return the current roast state.
      const existingDrop = db.getEvents(id).find(
        (e) => e.event === "DROP" && e.clientId === clientId,
      );
      if (!existingDrop) {
        roastManager.recordEvent({ roastId: id, event: "DROP", ts: dropTs, clientId });
        if (roastManager.getActive()?.id === id) {
          roastManager.endRoast(dropTs);
        } else {
          // Roast is not active in memory (e.g. server restarted mid-roast).
          // Persist the drop_ts directly.
          db.setRoastDrop(id, dropTs);
        }
      }
    }

    return reply.code(200).send({ roast: db.getRoast(id) });
  });

  // ── Event marker (DRY_END, FC_START, FC_END) ──────────────────────
  fastify.post<{
    Params: { id: string };
    Body: { event?: string; ts?: number; clientId?: string };
  }>("/api/roasts/:id/events", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const { event, ts, clientId } = (req.body ?? {}) as {
      event?: string;
      ts?: number;
      clientId?: string;
    };

    if (typeof event !== "string" || !VALID_EVENTS.has(event as RoastEvent)) {
      return reply.code(400).send({ error: "invalid_event" });
    }
    if (typeof ts !== "number" || !Number.isFinite(ts)) {
      return reply.code(400).send({ error: "ts_required" });
    }
    if (typeof clientId !== "string" || clientId.length === 0) {
      return reply.code(400).send({ error: "client_id_required" });
    }

    const roast = db.getRoast(id);
    if (!roast) {
      return reply.code(404).send({ error: "roast_not_found" });
    }

    const record = roastManager.recordEvent({
      roastId: id,
      event: event as RoastEvent,
      ts,
      clientId,
    });
    return reply.code(200).send({ event: record });
  });
}
