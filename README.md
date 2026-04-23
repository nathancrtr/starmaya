# behmor-web

A web-native coffee roasting logger for a Behmor 2000AB Plus with a DIY Arduino + MAX31855 + K-type thermocouple temperature rig. A small, focused, hobby-scale replacement for the ~20% of [Artisan](https://artisan-scope.org) actually used during a home roast, accessible from any browser on the LAN and remotely via Tailscale.

## Status

Pre-code. Design documents in `docs/` are the current state of the project. Implementation starts with the walking skeleton defined in `docs/architecture.md`.

## Documents

- [`docs/problem-statement.md`](docs/problem-statement.md) — what, why, constraints, scope
- [`docs/architecture.md`](docs/architecture.md) — tech stack, process topology, decision records, walking-skeleton scope
- [`docs/daemon-protocol.md`](docs/daemon-protocol.md) — Unix-socket protocol between the roaster daemon and the web server
- [`CLAUDE.md`](CLAUDE.md) — context for Claude Code sessions

## Hardware

- Behmor 2000AB Plus (electric drum roaster, no heat-control API)
- K-type thermocouple through the chamber wall, positioned in the bean mass
- Adafruit MAX31855 cold-junction-compensated amplifier
- Arduino Uno running a TC4-protocol-compatible sketch at 115200 baud
- Raspberry Pi 4B (4GB) as the always-on host
