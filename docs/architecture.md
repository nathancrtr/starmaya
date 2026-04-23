# Architecture

This document describes the tech stack, process topology, and the reasoning behind each significant choice. It is the authoritative source for "why is it built this way." When design decisions need to be revisited, they should be revisited here — not re-derived ad hoc.

## High-level picture

Three tiers run on the Raspberry Pi, plus the Arduino at one end and browsers at the other:

```
┌──────────────────┐                   ┌───────────────────────────────────────┐
│ Arduino Uno +    │   USB (serial,    │ Raspberry Pi 4B                       │
│ MAX31855 +       │   TC4 protocol,   │                                       │
│ K-type TC        │   115200 baud)    │  ┌────────────────────┐               │
│                  ├───────────────────┼─►│ Roaster daemon     │               │
└──────────────────┘                   │  │ (owns serial port) │               │
                                       │  │ ring buffer        │               │
                                       │  └──────────┬─────────┘               │
                                       │             │ Unix socket, ndjson     │
                                       │             │                         │
                                       │  ┌──────────▼─────────┐    ┌───────┐  │
                                       │  │ Fastify web server ├───►│SQLite │  │
                                       │  │ HTTP + SSE + static│    │roasts.│  │
                                       │  │ owns roast state   │    │  db   │  │
                                       │  └──────────┬─────────┘    └───────┘  │
                                       │             │                         │
                                       │       systemd supervises both         │
                                       └─────────────┼─────────────────────────┘
                                                     │
                                                     │ HTTP + SSE (via Tailscale)
                                                     │
                                ┌────────────────────┼─────────────────────┐
                                │                    │                     │
                          ┌─────▼────┐         ┌─────▼────┐          ┌─────▼────┐
                          │ Laptop   │         │ Phone    │          │ iPad     │
                          └──────────┘         └──────────┘          └──────────┘
```

The `roaster daemon` owns the hardware. The `Fastify web server` owns roast state (active roast, event markers, persistence). The client is a React SPA the web server serves as static assets.

## The stack

| Layer | Choice |
| --- | --- |
| Language | TypeScript, end-to-end |
| Runtime (server) | Node.js |
| Package manager | pnpm (workspace monorepo) |
| Serial | `serialport` npm package |
| Daemon ↔ server IPC | Unix domain socket, line-delimited JSON |
| HTTP framework | Fastify |
| Server → client streaming | Server-Sent Events (SSE) |
| Client → server actions | Plain HTTP POSTs with client-generated UUIDs for idempotency |
| Client framework | React + Vite |
| Server-state on client | TanStack Query |
| Charting | uPlot |
| Persistence | SQLite via `better-sqlite3` |
| Process supervision | systemd (one unit per process) |
| Remote access | Tailscale |
| Deployment | `git pull && pnpm install && pnpm build && systemctl restart …` — no Docker |

## Process topology

Two long-lived processes, supervised by systemd:

### `roaster-daemon.service`

- Owns `/dev/behmor-arduino` (a stable symlink created by a udev rule based on the USB vendor/product IDs of the Uno).
- Polls the Arduino at the configured sample rate (1 Hz by default), speaking the TC4 request/response protocol.
- Maintains an in-memory ring buffer of the most recent N seconds of readings.
- Listens on a Unix domain socket (`/run/roaster/roaster.sock`) for connections from the web server.
- On each client connect: sends a `hello`, replays the buffered readings, then streams live readings as they arrive.
- Emits `device_status` messages when the view of the hardware changes (serial port opened, closed, read timeout, recovered).
- Knows nothing about roasts, events, users, or persistence. It is a pure sensor interface.

### `roaster-web.service`

- Connects to the daemon's Unix socket on startup and on reconnection.
- Runs a Fastify HTTP server.
- Owns all roast semantics: starting a roast (when the user hits CHARGE), appending event markers, persisting readings to SQLite.
- Serves the static React client bundle.
- Streams readings and roast state to connected browsers via Server-Sent Events.
- Accepts event-mark POSTs and other mutations via plain HTTP.

### Why two processes

The hardware-owning process and the user-facing process must have independent lifecycles.

- Web-server restarts (deploys, bug fixes, dependency tweaks) must not drop serial connection or lose readings.
- A crash in one must not take down the other.
- The daemon is small and should stay running for weeks at a time with no intervention.
- The web server iterates faster and has a larger surface area for bugs.

This separation is directly driven by the reliability non-negotiable in the problem statement: a roast takes 10–15 minutes and losing it costs real money and green coffee.

## Decision records

Each subsection captures a choice, alternatives considered, and the reasoning. These are not meant to be revisited without good cause, but they can be — the reasoning is written down so a reconsideration can start from the actual trade-offs rather than from scratch.

### DR-1: TypeScript end-to-end, not Python for the daemon

**Choice:** Node.js + TypeScript for daemon, server, and client.

**Alternatives considered:** Python for the daemon (with `pyserial`) and TypeScript for the web/client. A "use the best tool per component" split.

**Reasoning:**

- The serial work at 1 Hz is trivial for any language. Both `pyserial` and `serialport` are mature and handle the needed patterns (line-delimited parsing, reconnection) well.
- The author's preference is TypeScript/Node. For a hobby project where enjoyment matters, this is a real criterion.
- End-to-end TS enables shared types between daemon, server, and client via a `packages/shared` workspace. This is a real reliability win: when the reading payload shape changes, the type checker catches the mismatch at build time, not at roast time.
- A single package manager, single build system, single runtime to reason about, one tsconfig philosophy. Operational simplicity that is worth more than the (marginal) ergonomics gain of Python for serial code.

**When to reconsider:** If future roaster control brings PID loops into scope, the Python controls ecosystem (`simple-pid`, `scipy.signal`, etc.) becomes genuinely hard to beat. At that point, a Python control process alongside the TS daemon is reasonable — not a full rewrite.

### DR-2: Two-process split, not a single process

**Choice:** Separate `roaster-daemon` (owns hardware) and `roaster-web` (owns HTTP and roast state) processes, communicating via a Unix socket.

**Alternatives considered:**
- **Single process** that owns serial, serves HTTP, holds state in memory.
- **Three-or-more-process microservices** (separate time-series writer, etc.).

**Reasoning:**

- Single-process is tempting for simplicity, but couples the serial-reading lifecycle to the HTTP-server lifecycle. Every `systemctl restart roaster-web` during a deploy would drop the serial connection. Every HTTP-layer crash would also drop readings. This directly violates the reliability non-negotiable.
- More than two processes adds operational complexity (more units, more places for bugs) with no clear benefit for a single-user system.
- Two processes is the minimum that cleanly separates "hardware concerns" from "application concerns." The daemon can stay up for weeks; the web server can iterate.

### DR-3: Unix domain socket, not MQTT or TCP-localhost

**Choice:** Unix domain socket (`/run/roaster/roaster.sock`) speaking line-delimited JSON (ndjson).

**Alternatives considered:**
- **MQTT** with a local mosquitto broker.
- **TCP socket** on localhost.
- **Named pipe / FIFO.**
- **Shared memory.**

**Reasoning:**

- **Filesystem permissions control access.** The socket is owned by a `roaster` group; the daemon and web server both run under users in that group; `chmod 660` ensures no other local process can connect. This is the primary security boundary between the hardware-touching process and the HTTP-facing process.
- **Fundamentally cannot be exposed to the network.** A Unix socket cannot be reached from the LAN or the internet, no matter how badly the system is misconfigured. A TCP-localhost socket is one sysctl or firewall mistake away from being exposed. For hardware near a heat source, this is a meaningful safety property.
- **MQTT** would require a third process (the broker), a pub/sub mental model that is overkill for exactly-one-publisher-exactly-one-subscriber, and an opaque wire format that is harder to debug than `socat - UNIX-CONNECT:/run/roaster/roaster.sock`.
- **ndjson** (one JSON object per line) is human-readable, self-describing, trivial to parse, and easy to evolve (just add fields). The bandwidth cost vs. a binary format is negligible at 1 Hz.

**When to reconsider:** If a future version gains multiple independent consumers (a logging service, a PID controller, a metrics exporter), MQTT starts to pay for itself.

### DR-4: SSE for server→client streaming, not WebSockets

**Choice:** Server-Sent Events for pushing readings and roast-state updates to the browser.

**Alternatives considered:** WebSockets. Long-polling. HTTP/2 server push.

**Reasoning:**

- The data flow is naturally one-directional at the transport layer: server→client for readings. Client→server actions (event marks, starting/stopping a roast) are well-served by plain HTTP POSTs.
- SSE is plain HTTP. No upgrade handshake, no special reverse-proxy configuration, no extra protocol to reason about. It works through anything that can proxy HTTP.
- `EventSource` in the browser handles reconnection automatically, including the `Last-Event-ID` convention for resumption.
- SSE responses can be inspected with `curl -N`. WebSockets require specialized tools.
- The one thing WebSockets offer that SSE does not — low-latency bidirectional messaging — is not needed. Event-mark POSTs are entirely fast enough for the 100ms latency budget.

### DR-5: Event marks go client → server as HTTP POSTs with client UUIDs

**Choice:** Event markers (CHARGE, DRY_END, FC_START, FC_END, DROP) are sent from the browser to the web server as `POST /api/roasts/:id/events` with a client-generated UUID in the body. The server upserts on `(roast_id, client_id)`.

**Alternatives considered:**
- Routing events through the daemon's socket (treating the daemon as the source of truth for everything).
- Using WebSockets for bidirectional messaging.

**Reasoning:**

- The daemon has no concept of roasts or events and should not acquire one. Keeping it a pure sensor interface is the whole point.
- Client-generated UUIDs make the POST idempotent at the database level. A retried POST does not create a duplicate event.
- The client buffers un-acknowledged events in-memory (and optionally IndexedDB for crash recovery) and retries until each one is confirmed. This addresses the "network blip during FCs" scenario from the problem statement directly.
- POSTs are the right HTTP verb for recording an event; no need to invent a protocol.

### DR-6: SQLite, not TimescaleDB or flat files

**Choice:** A single SQLite database file (`roasts.db`), accessed via `better-sqlite3`.

**Alternatives considered:** TimescaleDB (or other time-series DB). PostgreSQL. Flat JSON files per roast. An append-only log.

**Reasoning:**

- The data volumes are tiny. At 1 Hz for a ~15-minute roast, that is ~900 readings. Even 100 roasts is under 100,000 rows. SQLite on a Pi handles this without noticing.
- `better-sqlite3` is synchronous and fast. No connection pool, no async ceremony, no query planner surprises. Writes are committed in microseconds.
- Queries for the "background profile" overlay are indexed SELECTs returning a single roast's data. Millisecond latency.
- Backups are `cp roasts.db backup.db`. Restores are the reverse. No dump/restore tooling.
- A full database stack (PostgreSQL, Timescale) would be an operational burden with no corresponding benefit at this scale.
- Flat files with no index make "list all roasts" O(N) on every page load and make background-profile selection awkward.

### DR-7: uPlot for charting

**Choice:** uPlot for the live temperature and RoR charts.

**Alternatives considered:** Chart.js, Recharts, D3, Plotly, canvas directly.

**Reasoning:**

- uPlot is purpose-built for time series and is the fastest option for real-time updates.
- It is tiny (~40 KB) and has no dependency sprawl.
- It handles the specific things this project needs well: dual axes (BT and RoR), overlay of a static "background profile" series, responsive resizing.
- Chart.js is fine but noticeably slower for streaming updates.
- Recharts is pleasant for static React charts but not tuned for 1 Hz streaming.
- D3 is too low-level — would end up writing a chart library on top of it.
- Plotly is ~3 MB; overkill.

### DR-8: No Docker

**Choice:** Deploy directly to the Pi via git pull + pnpm install + systemctl restart.

**Alternatives considered:** Docker Compose with containers per service.

**Reasoning:**

- The Pi is single-purpose. Nothing else runs on it.
- Two systemd services with small dependency graphs are genuinely simpler to reason about than containers.
- Docker on arm64 has historically been enough of a hassle (image builds, cross-arch concerns, volume mounts for the serial device) that it adds more friction than it removes here.
- The serial device mount is particularly annoying in Docker: `/dev/behmor-arduino` needs to be passed into the container with the right permissions, and udev rules interacting with container lifecycles get weird.

### DR-9: Tailscale-only remote access, no public exposure in v1

**Choice:** The Pi is on a tailnet. Remote access is via the tailnet IP or MagicDNS name. No reverse proxy, no TLS termination, no public URL, no auth layer inside the app in v1.

**Alternatives considered:** Cloudflare Tunnel with auth. A reverse-proxy VPS with HTTP basic auth. Port forwarding. Full OIDC integration.

**Reasoning:**

- Tailscale gives LAN-like connectivity from anywhere with no code. The app itself does not need to know the internet exists.
- Zero attack surface on the public internet is a meaningful safety property for a device-adjacent application. This directly reflects the constraint in the problem statement that it should not be easy to accidentally expose dangerous control surfaces.
- An app-level auth layer adds real complexity (sessions, password storage, rate limiting, CSRF) for no benefit when the only users are the author and possibly a spouse/partner, both of whom are on the tailnet.
- If a future version needs to share roasts with others, a dedicated read-only export endpoint gated behind proper auth can be added then. It is a separable concern.

## Walking-skeleton scope

The walking skeleton is the smallest version that actually logs a real roast end-to-end. It proves out the vertical slice from serial all the way through to the browser. Everything else on the must-have list is layered on top.

### What it does

1. The daemon reads the TC4, parses BT, broadcasts each reading to connected socket clients.
2. The web server connects to the daemon.
3. A single page in the browser shows:
   - The current BT in large text.
   - A live uPlot chart of BT vs. time.
   - Five buttons: CHARGE, DRY END, FC START, FC END, DROP.
   - A text field for the roast name (coffee + date).
4. Hitting CHARGE starts a roast: a row is written to `roasts`, and subsequent readings are persisted to `readings` with `t_ms` relative to the CHARGE timestamp.
5. Hitting the other event buttons stamps event markers into `events`.
6. Hitting DROP ends the roast.
7. A separate `/roasts` page lists past roasts. Clicking one shows its completed chart.

### What is explicitly deferred

- RoR computation and display (iteration 2; it is a smoothed derivative — straightforward).
- Background profile overlay.
- Multi-client live sharing (two browsers viewing the same in-flight roast).
- Tailscale setup (works on LAN first; Tailscale is a separate 15-minute add-on).
- Responsive / mobile styling.
- Client-side event buffering for connection blips (iteration 2; the idempotent POST is v1).
- Any auth.

### Success criterion

An end-to-end live roast, from CHARGE to DROP, is logged and viewable afterward on the history page, on a laptop on the same LAN as the Pi. The roast survives a `systemctl restart roaster-web` during the roast without losing the event marks or the readings.

## Time-sink realism

Parts expected to be easy and fun:

- Getting the daemon reading the TC4. An evening.
- The chart rendering. uPlot is a joy.
- The basic event-marking UI.

Parts that often take longer than they look:

- Getting the deploy and supervision story right: systemd units, socket ownership and permissions, udev rules for stable device naming, log rotation, handling the USB device reattaching after a disconnect. Budget a weekend.
- Making event-marking truly robust under bad network conditions. The 90% case is easy; getting it right end-to-end is real work.
- Mobile responsive charts. uPlot helps, but touch interactions on a time-series chart are never free.
- The historical-roast overlay UX (selecting a past roast, aligning on CHARGE, toggling visibility, styling the background series distinctly).

Rabbit holes to consciously stay out of in v1:

- Profile comparison and analysis tools beyond a single overlay. Artisan spent years on this.
- Anything involving Artisan file-format compatibility.
- Fancy RoR smoothing algorithms. A centered moving average of the last N samples is enough; Artisan's filter options exist because it supports 200 device types with different noise characteristics.

## Project layout (target)

Once the implementation begins, the repo is expected to evolve toward:

```
behmor-web/
├── CLAUDE.md
├── README.md
├── pnpm-workspace.yaml
├── package.json
├── docs/
│   ├── problem-statement.md
│   ├── architecture.md
│   └── daemon-protocol.md
├── packages/
│   ├── shared/               # TS types shared between daemon, server, client
│   ├── daemon/               # Roaster daemon
│   ├── server/               # Fastify web server
│   └── client/               # React + Vite app
├── deploy/
│   ├── systemd/
│   │   ├── roaster-daemon.service
│   │   └── roaster-web.service
│   └── udev/
│       └── 99-behmor-arduino.rules
└── config/
    ├── default.json          # checked in
    └── local.example.json    # documented overrides
```
