# Server Internals

This document describes the server's internal structure: how the long-lived components (daemon client, roast manager, SSE handler) wire together, and how data and events flow between them. It is the companion to `daemon-internals.md`.

For the cross-process picture, see `architecture.md`. For the protocol the server speaks to the daemon, see `daemon-protocol.md`.

## Components

The server has four long-lived components:

- **`DaemonClient`** — the client side of the Unix-socket protocol. Maintains the connection to the daemon, parses ndjson messages, runs the heartbeat, and reconnects with backoff. Re-emits parsed daemon messages as typed events.
- **`Db`** — synchronous SQLite wrapper. Exposes prepared statements as methods (`insertRoast`, `insertReading`, `upsertEvent`, etc.).
- **`RoastManager`** — owns the in-memory state for the active roast (if any). Bridges `DaemonClient` (incoming readings) and `Db` (persistence). Source of truth for "is a roast in progress."
- **SSE handler** — created per browser connection. Subscribes to events from `DaemonClient` and `RoastManager`, forwards them to the browser, cleans up on disconnect.

HTTP routes are stateless and call into `RoastManager` and `Db` directly.

## Event flow

```
DaemonClient                       RoastManager                    SSE handler
─────────────                      ─────────────                   ─────────────
emit "reading"      ──────────►   handleReading()
                                     emit "reading"  ──────────►   forward to browsers
                                     (only if roast active,
                                      with tMs relative to charge)

emit "device_status" ────────────────────────────────────────────► forward to browsers
emit "sensor_fault"  ────────────────────────────────────────────► forward to browsers
emit "hello"         ─── (server uses this for logging only)


HTTP routes                        RoastManager                    SSE handler
───────────                        ─────────────                   ─────────────
POST /api/roasts (CHARGE)  ────►  startRoast()
                                     emit "roast_started"  ─────►  forward to browsers

POST /api/roasts/:id/events ───►  recordEvent()
                                     emit "event"  ───────────►   forward to browsers

PATCH /api/roasts/:id (rename) ►  renameActive()
                                     emit "roast_updated"  ─────► forward to browsers

PATCH /api/roasts/:id (DROP)   ►  endRoast()
                                     emit "roast_ended"  ──────►  forward to browsers
```

## Why a Node EventEmitter for a single listener (the SSE handler)

The SSE handler is created and torn down per browser connection. There can be 0..N concurrent browsers. EventEmitter handles that naturally — the producers (`DaemonClient`, `RoastManager`) don't need to know how many browsers are connected.

It also decouples lifecycle: `RoastManager` keeps persisting readings and tracking roast state regardless of whether any browser is connected.

## Why split listeners across two producers

The SSE handler subscribes to events from both `DaemonClient` and `RoastManager`:

- From `DaemonClient`: `device_status`, `sensor_fault`, and the *raw* `reading` stream (so the live BT readout works even when no roast is active).
- From `RoastManager`: `roast_started`, `roast_updated`, `roast_ended`, `event`, and `reading` records (which are the same data as the daemon's, but with roast-relative `tMs` attached).

An alternative considered was funnelling everything through `RoastManager`. That would let the SSE handler listen to one source, but it forces `RoastManager` to forward unrelated messages (`device_status`, `sensor_fault`) that have nothing to do with roast state. Keeping the split lets each class stay focused.

When the SSE protocol to the browser is finalised, it will need a small disambiguation between "raw reading from daemon" and "reading record persisted to a roast." Probably as distinct SSE event types.

## Data conversions

- **Absolute → roast-relative time.** The daemon emits readings with absolute Unix milliseconds (`ts`). When a roast is active, `RoastManager.handleReading()` computes `tMs = msg.ts - chargeTs` and persists that. Readings before CHARGE (negative `tMs`) are dropped.
- **Idempotent event upsert.** Event POSTs from the browser carry a client-generated UUID. `Db.upsertEvent` keys on `(roast_id, client_id)` and replaces `event` and `ts` on conflict. Lifecycle side-effects of the original call (e.g. `startRoast` triggered by CHARGE) are not re-applied on retry — the route handler's responsibility to detect retries and short-circuit appropriately.
