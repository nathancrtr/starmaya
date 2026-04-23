# Behmor Web — Claude Code Project Context

This file is read automatically by Claude Code on session startup. It provides project-level context.

## What this project is

A web-native coffee roasting logger for a Behmor 2000AB Plus home roaster with a DIY Arduino + MAX31855 + K-type thermocouple temperature monitoring rig. It replaces the core subset of [Artisan](https://artisan-scope.org) that the author actually uses during a home roast — live temperature curve, rate of rise, phase-marker events (CHARGE, FCs, DROP, etc.), and roast history — with a browser-based UI that works from any device on the LAN (and remotely via Tailscale).

This is a hobby project. It is not a product and is not intended to serve other home roasters at scale.

## Authoritative design documents

Before answering design questions or writing code, read these in order:

1. **`docs/problem-statement.md`** — what the project is trying to accomplish, constraints, existing hardware, what's in and out of scope.
2. **`docs/architecture.md`** — the tech stack, the two-process split (roaster daemon + web server), and decision records for each significant choice.
3. **`docs/daemon-protocol.md`** — the Unix-domain-socket protocol between the daemon and the web server. Message formats, connection lifecycle, ring buffer, configuration.

If a question isn't answered by those documents, prefer asking a clarifying question over guessing. The author would rather have a short back-and-forth than receive code built on the wrong assumptions.

## Tech stack at a glance

- **Language:** TypeScript everywhere (daemon, web server, client)
- **Runtime:** Node.js on the server side, modern evergreen browsers on the client
- **Package manager:** pnpm (if not set up yet, default to it when initializing)
- **Serial:** `serialport` npm package
- **IPC:** Unix domain socket, line-delimited JSON
- **HTTP:** Fastify
- **Server→client streaming:** Server-Sent Events (SSE), not WebSockets
- **Client framework:** React + Vite
- **Charting:** uPlot
- **Persistence:** SQLite via `better-sqlite3`
- **Supervision:** systemd units (one per process)
- **Deployment target:** Raspberry Pi 4B (4GB) running Raspberry Pi OS 64-bit
- **Remote access:** Tailscale; no public-internet exposure, no auth layer in v1

The reasoning behind each of these lives in `docs/architecture.md`. Do not relitigate these decisions without reason — they were chosen deliberately with known trade-offs.

## Project structure (target)

The repo is expected to evolve toward something like this. Subdirectories will be created as they become relevant.

```
behmor-web/
├── CLAUDE.md
├── README.md
├── docs/
│   ├── problem-statement.md
│   ├── architecture.md
│   └── daemon-protocol.md
├── packages/
│   ├── shared/         # TS types shared between daemon, server, and client
│   ├── daemon/         # The roaster daemon (owns the serial port)
│   ├── server/         # The Fastify web server
│   └── client/         # The React app
├── deploy/
│   ├── systemd/        # Unit files
│   └── udev/           # udev rules for stable device naming
└── package.json        # pnpm workspace root
```

A pnpm monorepo is expected so shared TypeScript types don't have to be published or duplicated. Don't be dogmatic about this — if a single-package structure turns out to work fine, that's fine.

## Coding conventions

- **TypeScript strict mode.** `"strict": true` in every `tsconfig.json`.
- **ES modules**, not CommonJS. `"type": "module"` in each package.json.
- **Prefer standard library and small focused deps** over frameworks. No Express (use Fastify). No moment (use native Date / Temporal polyfill when needed). No lodash (modern JS standard library is enough).
- **No unnecessary abstraction.** This is a small single-user app. Favor directness; resist building frameworks-within-the-framework. If a function is called from exactly one place, it can usually be inlined.
- **Error handling is not optional on the daemon side.** Serial ports, sockets, and filesystems all fail in weird ways. Every `await` on an IO-bound call needs a plan for what happens when it throws.
- **Log enough to debug a failed roast.** The author will not be watching stdout during a live roast. When something goes wrong, the logs are the only evidence. Prefer structured logging (one JSON object per line) over printf.

## Reliability is a first-class concern

A live roast is a 10–15 minute window where losing data means losing ~$3–5 of green coffee and a batch that can't be redone. When there's a trade-off between "simple" and "reliable during a live roast," pick reliable. Specifically:

- The daemon's job is to keep reading the serial port, no matter what the web server is doing.
- Event markers (CHARGE, FCs, DROP, etc.) from the browser must be recorded with millisecond precision and must not be lost to a network blip. They use client-generated UUIDs and idempotent POSTs.
- A web-server restart mid-roast should be survivable: the daemon keeps a ring buffer of recent readings that the web server replays on reconnect.

## What is NOT in scope for v1

See `docs/problem-statement.md` for the full list. Highlights:

- PID control of the roaster (read-only for now)
- Support for any roaster other than the Behmor or any thermocouple setup other than the existing TC4-compatible Arduino rig
- Multi-user auth or sharing
- Artisan `.alog` export compatibility
- Native mobile apps (PWA is acceptable if needed; otherwise responsive web)
- Public-internet exposure (Tailscale handles remote access; no reverse proxy, no TLS termination, no auth layer in v1)

If the author asks for something that sounds like it's drifting into these areas, flag it and ask whether scope has changed before implementing.

## Status

The project is at the **pre-code design** stage. The problem statement, architecture, and daemon protocol are decided. The next design chunk is the daemon's internal serial-polling loop (timing, read timeouts, ring buffer feeding, device-status state machine). After that, the walking skeleton implementation begins.

The walking skeleton is defined in `docs/architecture.md` — read that section before starting to write code.
