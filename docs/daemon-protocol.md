# Daemon Protocol

This document specifies the protocol between the `roaster-daemon` and the `roaster-web` server over the Unix domain socket at `/run/roaster/roaster.sock`. It is the authoritative contract between the two processes.

## Background concepts

These concepts are used throughout the rest of this document. They are captured here in a mildly tutorial register so a future contributor (or a future Claude Code session) can come up to speed without external research.

### Unix domain sockets

A Unix domain socket has the same programming model as a TCP socket — `listen`, `accept`, read and write a bidirectional byte stream — but routes through the filesystem instead of the network stack. The "address" is a path, like `/run/roaster/roaster.sock`. The file at that path is a rendezvous point: one process listens on it, other processes connect to it, each connection is a full-duplex stream.

Properties that matter for this project:

- **No network stack.** Bytes move through kernel memory. Latency is microseconds.
- **Filesystem permissions control access.** The socket file has an owner, group, and mode. `chmod 660` with a shared `roaster` group limits access to processes running as that group.
- **Cannot be exposed to the network.** A Unix socket is unreachable from the LAN or the internet by construction. This is a meaningful safety property for a hardware-adjacent application.
- **No port to pick.** Paths do not collide like ports do.

In Node, the API is the same `net.createServer()` and `net.createConnection()` used for TCP — just pass a path instead of a port.

### Ring buffers

A ring buffer (circular buffer) is a fixed-size array where writes advance a pointer that wraps around when it hits the end, overwriting the oldest entries. It is the right data structure for "keep the most recent N samples, throw away older ones, with no memory allocation per write."

The daemon uses one to retain the most recent readings so a reconnecting web server can replay them and avoid a gap in the live chart. Sizing: `capacity = duration_seconds * sample_rate_hz`. At 1 Hz with a 60-second buffer, that is 60 entries — roughly 5 KB of memory. Trivially small; the choice is driven by "how long a web-server restart can take without visible impact," not by resource constraints.

### Serial ports (brief)

The Arduino appears to Linux as a character device — on a Pi this is typically `/dev/ttyUSB0` or `/dev/ttyACM0`. A udev rule creates a stable symlink (`/dev/behmor-arduino`) based on the USB vendor/product IDs, so the daemon does not care if the enumeration order changes.

The TC4 protocol is a simple request/response scheme over a 115200-baud byte stream. Messages are terminated by `\r\n`. The daemon sends `READ\r\n`, the Arduino responds with a line like `203.4,198.2,0,0\r\n` (ambient, BT, ET, unused). No framing, no checksums, no retries at the transport layer — all of that is the daemon's job.

Relevant gotchas:

- Opening the device can succeed even if the Arduino is unplugged, depending on udev state.
- Bytes can arrive in arbitrary fragments. A line-oriented parser (`ReadlineParser` in `serialport`) is mandatory.
- The protocol is order-sensitive: do not issue a second `READ` before processing the first response.

## Socket location and permissions

- **Path:** `/run/roaster/roaster.sock`
- **Owner:** the `roaster` user
- **Group:** the `roaster` group
- **Mode:** `0660` (owner and group read/write; nothing for others)

Both `roaster-daemon` and `roaster-web` run as users in the `roaster` group. No other local process can connect.

The daemon creates the socket on startup. If a stale socket file exists from a previous run, the daemon unlinks it before binding. The systemd unit for the daemon declares `RuntimeDirectory=roaster` so `/run/roaster` is created with the right ownership on each start and cleaned up on stop.

## Wire format

**Line-delimited JSON (ndjson).** Each message is a single JSON object on a single line, terminated by `\n` (LF, not CRLF). No message spans multiple lines. No trailing bytes between messages.

This choice is driven by debuggability (you can `socat - UNIX-CONNECT:/run/roaster/roaster.sock` and watch messages as plain text), schema evolution (add a field without breaking the parser), and cost (at 1 Hz the bytes are irrelevant).

Both sides use a streaming line parser — something like `readline` in Node's `stream` module, or a small custom buffer-until-newline helper. Neither side should attempt to parse raw chunks.

## Message types: daemon → web server

### `hello`

Sent exactly once, immediately after the web server connects. Announces the protocol version and the current state of the hardware, and indicates how many buffered readings are about to follow.

```json
{
  "type": "hello",
  "protocol": 1,
  "device_status": "connected",
  "buffered_count": 47
}
```

Fields:

- `protocol` (integer) — the protocol version the daemon speaks. Currently `1`.
- `device_status` (string) — one of `"connected"`, `"disconnected"`, `"error"`. The state of the serial link at the moment of connection.
- `buffered_count` (integer) — the number of buffered `reading` messages that will follow this `hello`. Primarily diagnostic; the web server does not need to count them to function correctly.

### `reading`

Sent for every temperature sample. These arrive first as a replay of the ring buffer (oldest first, newest last), then continuously as new readings come in from the serial port. There is no explicit marker separating replay from live — the transition is seamless and the message shape is identical.

```json
{
  "type": "reading",
  "ts": 1729123456789,
  "bt_c": 203.4,
  "et_c": 198.2
}
```

Fields:

- `ts` (integer, Unix milliseconds, UTC) — the wall-clock time at which the daemon received the sample. Absolute, not relative to any roast. The web server converts to roast-relative `t_ms` when persisting to `readings`.
- `bt_c` (number) — Bean Temperature in Celsius. Always present.
- `et_c` (number, optional) — Environment Temperature in Celsius, if a second thermocouple is present. Absent or `null` otherwise.

### `device_status`

Sent whenever the daemon's view of the hardware changes. Not sent at heartbeat frequency; only on transitions.

```json
{"type": "device_status", "status": "disconnected", "reason": "read_timeout_5s"}
{"type": "device_status", "status": "connected"}
{"type": "device_status", "status": "error", "reason": "port_open_failed: ENOENT /dev/behmor-arduino"}
```

Fields:

- `status` (string) — one of `"connected"`, `"disconnected"`, `"error"`.
- `reason` (string, optional) — a short human-readable explanation. Included for `"disconnected"` and `"error"`; omitted for `"connected"`.

The web server uses these to drive the UI's connection-status indicator and to annotate the roast record if the hardware drops mid-roast.

### `sensor_fault`

Sent when the daemon receives a response to `READ` but the thermocouple value indicates a sensor-level fault (open circuit, short, out-of-range). The serial link is healthy — the device responded — but the reading is not usable.

```json
{"type": "sensor_fault", "ts": 1729123456789, "raw": "-1,0,0,0", "reason": "bt_open_circuit"}
```

Fields:

- `ts` (integer, Unix milliseconds, UTC) — timestamp of the failed read.
- `raw` (string) — the raw response line from the Arduino, for diagnostics.
- `reason` (string) — a short classification. Known values: `"bt_open_circuit"`, `"bt_short_gnd"`, `"bt_short_vcc"`, `"bt_out_of_range"`, `"bt_nan"`.

A `sensor_fault` does not trigger a `device_status` transition. The device is responding; the problem is at the thermocouple level.

The web server uses this to show a "check thermocouple" warning in the UI, distinct from the "sensor offline" indicator driven by `device_status`.

See `daemon-internals.md` for detection rules and the full fault classification table.

### `pong`

Response to a `ping`. See "Heartbeat."

```json
{"type": "pong", "id": "a3f2"}
```

Fields:

- `id` (string) — echoes the `id` from the corresponding `ping`.

## Message types: web server → daemon

### `ping`

Sent by the web server every ~5 seconds. The daemon must respond with a `pong` echoing the `id`.

```json
{"type": "ping", "id": "a3f2"}
```

Fields:

- `id` (string) — an opaque identifier chosen by the web server. Only needs to be unique per in-flight ping.

If the web server does not receive a `pong` within ~2 seconds of sending a `ping`, it tears down the socket and reconnects with exponential backoff.

No other web-server → daemon messages exist in v1. Future additions (e.g. `set_sample_rate`, `reset_buffer`) are possible but not needed.

## Connection lifecycle

The canonical flow when the web server starts or reconnects:

1. **Connect.** The web server calls `net.createConnection('/run/roaster/roaster.sock')`. The daemon accepts.
2. **Authentication check.** Filesystem permissions alone. Either the connect succeeded (the process is in the `roaster` group) or it failed with `EACCES`. There is no application-level auth.
3. **`hello` from daemon.** Includes the protocol version, the current `device_status`, and the count of buffered readings about to follow.
4. **Version check on web server.** If the `protocol` number is higher than the web server knows about, the web server logs a fatal error and exits. systemd will restart it, but the operator now knows the versions are mismatched. If equal, proceed. (Lower protocol numbers from the daemon are not expected; upgrades go daemon-first by convention.)
5. **Buffer replay.** The daemon sends its buffered readings, oldest first. The web server treats them identically to live readings.
6. **Live streaming.** No explicit "caught up" marker. The transition is seamless because the messages are indistinguishable by shape. In practice, readings arriving after the replay are simply newer than those that arrived during it.
7. **Heartbeat.** The web server starts a 5-second `ping` timer. The daemon `pong`s each.
8. **Device-status events.** Whenever the daemon's view of the hardware changes, it emits a `device_status`. These can happen at any time and are independent of the heartbeat.

### During replay, new readings keep arriving

The daemon must send the replay and any in-flight readings without duplication or reordering. The clean implementation:

- When a new client connects, the daemon captures the current ring-buffer contents as a snapshot.
- The `hello` and the snapshot readings are queued for that client.
- From that moment on, every new reading is (a) appended to the ring buffer (for the next client that might connect) and (b) appended to the send queue of every connected client.
- The daemon flushes each client's queue in order.

This also handles the multi-client case naturally. A brief period where the web server reconnects before the old connection is cleaned up will have two clients; each gets a consistent stream.

### Reconnection

On the web-server side, losing the socket connection (for any reason: daemon restart, missed heartbeat, EPIPE) triggers a reconnect with exponential backoff (e.g., 200ms, 400ms, 800ms, capped at 5s). The web server keeps trying forever; it does not give up.

While disconnected, the web server continues to serve the UI, but shows a "sensor offline" indicator. Any event POSTs from the browser are still accepted and persisted — the web server owns roast state independently of whether the daemon is currently reachable. When the daemon comes back, readings resume. If this happens during a live roast, there will be a gap in the readings for the disconnected window; the event marks span the gap intact.

## Error conditions

### Web server cannot connect (socket does not exist)

Most likely cause: the daemon is not running, or `/run/roaster/` has not been created yet (startup race with systemd).

Web-server behavior: log at warning level and retry with backoff. systemd dependencies (`After=roaster-daemon.service`, `Wants=roaster-daemon.service`) mitigate the startup race, but do not eliminate it.

### Web server cannot connect (`EACCES`)

Most likely cause: the web server is not running as a user in the `roaster` group, or the socket's mode is wrong.

Web-server behavior: log at error level and exit. systemd will restart; the operator needs to fix the permissions. This is a deployment bug, not a runtime condition.

### Daemon receives malformed JSON

Most likely cause: a bug in the web server.

Daemon behavior: log the offending line at warning level, skip it, continue processing subsequent lines. Do not close the connection — the web server might recover on its own, and closing the connection would make the bug harder to debug.

### Daemon receives an unknown message type

Most likely cause: a newer web server talking to an older daemon.

Daemon behavior: log at info level, ignore. Forward compatibility by default.

### Heartbeat timeout (web-server side)

Tear down the socket, reconnect with backoff as normal.

### Serial read timeout (daemon side)

Emit `device_status: "disconnected"` with `reason: "read_timeout_Xs"`. Close the serial port. Attempt to reopen after a short delay. On successful reopen, emit `device_status: "connected"` and resume streaming readings. This logic is the subject of a separate design discussion — see the project's "daemon internals" work.

## Configuration

All tunable parameters live in a JSON config file. The default location is `/etc/roaster/config.json`; a `config/default.json` in the repo is the committed baseline, and a `config/local.example.json` documents the fields that typically need local overrides.

Environment variables override specific paths that differ between dev and prod:

- `ROASTER_SOCKET_PATH` — overrides the Unix socket path.
- `ROASTER_SERIAL_PATH` — overrides the serial device path.
- `ROASTER_DB_PATH` — overrides the SQLite file path.

### Config fields relevant to the protocol

```jsonc
{
  "socketPath": "/run/roaster/roaster.sock",
  "sampleRateHz": 1,
  "bufferSeconds": 60,
  "maxClients": 2,
  "pingIntervalMs": 5000,
  "pingTimeoutMs": 2000,
  "reconnectBackoffInitialMs": 200,
  "reconnectBackoffMaxMs": 5000
}
```

Starting values:

- **`sampleRateHz`** — `1`. The TC4's one-reading-per-second matches Artisan's default and is adequate for a 15-minute roast.
- **`bufferSeconds`** — `60`. Covers a typical web-server restart without visible data loss. Array size is `bufferSeconds * sampleRateHz` entries; at defaults, 60 entries, roughly 5 KB.
- **`maxClients`** — `2`. Normally one (the web server); two during a brief reconnect overlap. The daemon accepts up to this many simultaneous connections; further connects are rejected. Raising to 4 is safe if a future tool wants to observe the stream without racing the web server.
- **`pingIntervalMs`** / **`pingTimeoutMs`** — 5000 / 2000. App-level heartbeat; robust against half-open sockets that kernel-level TCP-style detection might miss on a Unix socket.

## Examples

### A debugging session

```
$ socat - UNIX-CONNECT:/run/roaster/roaster.sock
{"type":"hello","protocol":1,"device_status":"connected","buffered_count":5}
{"type":"reading","ts":1729123451789,"bt_c":199.8,"et_c":null}
{"type":"reading","ts":1729123452789,"bt_c":200.1,"et_c":null}
{"type":"reading","ts":1729123453789,"bt_c":200.6,"et_c":null}
{"type":"reading","ts":1729123454789,"bt_c":201.2,"et_c":null}
{"type":"reading","ts":1729123455789,"bt_c":201.8,"et_c":null}
{"type":"reading","ts":1729123456789,"bt_c":202.4,"et_c":null}
{"type":"reading","ts":1729123457789,"bt_c":203.1,"et_c":null}
```

Typing `{"type":"ping","id":"manual"}` and hitting Enter yields `{"type":"pong","id":"manual"}`.

### A protocol-version mismatch

The daemon has been upgraded to protocol 2 but the web server only knows about 1:

```
# daemon sends:
{"type":"hello","protocol":2,"device_status":"connected","buffered_count":60}

# web server logs:
[ERROR] Daemon protocol=2, web server supports up to 1. Exiting.
# web server exits with non-zero; systemd restarts it; loop continues
# until the web server is upgraded or the daemon is rolled back.
```

### A mid-roast hardware disconnect

```json
{"type":"reading","ts":1729123500000,"bt_c":215.2}
{"type":"reading","ts":1729123501000,"bt_c":215.5}
{"type":"device_status","status":"disconnected","reason":"read_timeout_5s"}
# ... 8 seconds pass ...
{"type":"device_status","status":"connected"}
{"type":"reading","ts":1729123514000,"bt_c":219.8}
{"type":"reading","ts":1729123515000,"bt_c":220.1}
```

There is an 8-second gap in readings, bracketed by status messages. The web server annotates the active roast's record with the gap, shows a "sensor reconnected" toast when it resumes, and the chart has a corresponding gap in the plotted line.

## Open items for later design discussion

These are acknowledged as not-yet-fully-specified and belong to later design work rather than this document:

- **Daemon internals.** Specified in `daemon-internals.md` — serial-polling loop, timing, read-timeout handling, device-status state machine, response parsing, and `sensor_fault` classification.
- **Multi-client fanout details.** The per-client send queue model is sketched above; the exact backpressure behavior when a client is slow (drop oldest? disconnect?) needs to be pinned down before multi-client is a tested path.
- **Client-side event buffering.** The browser's retry and reconciliation logic for event POSTs during network blips is a separate design from this protocol.
