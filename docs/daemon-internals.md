# Daemon Internals

This document specifies the roaster daemon's internal serial-polling loop, device-status state machine, and related behaviors. It is the companion to `daemon-protocol.md`, which covers the Unix socket protocol between the daemon and the web server. This document covers what happens *inside* the daemon.

## Serial-polling loop

The TC4 protocol is request/response: the daemon sends `READ\r\n`, the Arduino replies with a comma-separated line. The protocol is order-sensitive — no second `READ` may be issued before the first response arrives. This makes the loop naturally sequential.

```
┌─────────────────────────────────────────────────┐
│                                                 │
│  ┌──────────┐    ┌──────────┐    ┌───────────┐  │
│  │ send     │───►│ wait for │───►│ parse &   │  │
│  │ READ\r\n │    │ response │    │ broadcast │  │
│  └──────────┘    └──────────┘    └───────────┘  │
│       ▲                               │         │
│       │         sleep remainder       │         │
│       └───────────────────────────────┘         │
└─────────────────────────────────────────────────┘
```

### Timing model

The sample interval is `1000 / sampleRateHz` milliseconds (1000ms at the default 1 Hz). Each iteration of the loop:

1. Record `t_start = Date.now()`.
2. Send `READ\r\n`.
3. Wait for a response line, subject to the read timeout.
4. Parse the response and broadcast to socket clients.
5. Compute `elapsed = Date.now() - t_start`.
6. Sleep for `max(0, intervalMs - elapsed)`.

If the iteration took longer than the interval (e.g., a slow response consumed most of the window), the next `READ` fires immediately with no sleep. This keeps the cadence as close to the configured rate as possible without drift, while never double-sending.

A `setTimeout`-based sleep is used rather than `setInterval`. `setInterval` can queue overlapping iterations if one runs long; the sleep-for-remainder model guarantees the loop is single-threaded and non-overlapping.

### Read timeout

The read timeout is derived from the sample interval: `readTimeoutMs = intervalMs * 2`. At the default 1 Hz, this is 2000ms.

The Arduino normally responds within ~50ms. A response that hasn't arrived after the timeout means something is wrong — the Arduino is hung, the USB cable is disconnected, or the serial buffer is in a bad state.

**Why 2× the interval?** At 1 Hz this gives a 2s timeout: at most one missed sample before detecting the problem. Going shorter (e.g., 500ms) risks false positives on a loaded Pi. Going longer (e.g., 5s) means a multi-second gap before the UI knows something is wrong. Tying it to the interval means the timeout automatically scales if the sample rate changes.

**On read timeout:**

1. Cancel the pending response wait.
2. Emit `device_status: "disconnected"` with `reason: "read_timeout_<X>ms"` to all connected socket clients.
3. Transition the device-status state machine to `disconnected`.
4. Close the serial port.
5. Begin the reconnect/recovery cycle (see state machine below).

## Device-status state machine

Three states, matching the `device_status` values in the daemon protocol:

| State | Meaning | Behavior |
|---|---|---|
| **`connected`** | Serial port is open, last READ got a valid response | Normal polling loop runs |
| **`disconnected`** | Was connected, lost contact (read timeout or serial error) | Close port, attempt reopen with backoff |
| **`error`** | Port cannot be opened at all (device missing, permissions wrong) | Retry open with backoff |

The distinction between `disconnected` and `error` is intentional: `disconnected` is a transient glitch (the UI says "sensor lost, reconnecting..."), while `error` is a configuration or hardware problem (the UI says "check the USB cable" or "device not found").

### Transitions

| From | Event | To | Action |
|---|---|---|---|
| `connected` | Valid READ response | `connected` | Parse, broadcast, append to ring buffer |
| `connected` | Read timeout | `disconnected` | Emit `device_status`, close port, start reopen backoff |
| `connected` | Serial error (ENOENT, EIO, etc.) | `disconnected` | Same as timeout |
| `disconnected` | Port reopen succeeds + first READ succeeds | `connected` | Emit `device_status: "connected"`, resume polling |
| `disconnected` | Port reopen fails | `error` | Emit `device_status: "error"` with reason |
| `error` | Port open succeeds + first READ succeeds | `connected` | Emit `device_status: "connected"` |
| `error` | Port open fails | `error` | Stay, backoff continues |

### Reconnect backoff

When in `disconnected` or `error`, the daemon attempts to reopen the serial port with exponential backoff: starting at `reconnectBackoffInitialMs` (default 500ms), doubling on each failure, capped at `reconnectBackoffMaxMs` (default 10s). The backoff resets to the initial value on a successful reconnect.

Each reopen attempt is a two-step validation:

1. Open the serial port.
2. Send a single `READ` and wait for a response (with the normal read timeout).

Only if both succeed does the daemon transition to `connected`. A USB device can sometimes be "openable" but not functional — the confirming READ catches this.

### Startup

On daemon startup, the initial state is `error` (no port has been opened yet). The daemon immediately attempts to open the serial port. If the device isn't plugged in, it backs off and retries indefinitely. This means the daemon can start before the Arduino is connected and will pick it up when it appears.

On first successful open + READ, the daemon transitions to `connected` and emits `device_status: "connected"` to any socket clients that happen to be connected. (There may be zero clients at this point; the status change is still recorded internally so the next client's `hello` reflects the current state.)

## Serial port management

- Use `serialport`'s `SerialPort` class with `{ autoOpen: false }` so open timing is explicit and controlled by the state machine.
- Use `ReadlineParser` with `delimiter: '\r\n'` for line-oriented parsing.
- On close/reopen: destroy the old `SerialPort` instance and create a new one. Reusing a closed `serialport` instance is fragile and not well-supported.
- Drain the parser's internal buffer on close. Any partial line buffered when the port closed is garbage from the previous session and must not be carried into the next one.

## Response parsing

The TC4 `READ` response format is:

```
ambient,bt,et,unused\r\n
```

Four comma-separated numbers. The daemon uses fields 1 (BT) and 2 (ET). Field 0 (ambient / cold-junction temperature) is useful for diagnostics but is not broadcast to socket clients.

### Parse rules

1. Split on `,`. Expect at least 2 fields.
2. `bt_c = parseFloat(fields[1])`.
3. `et_c = parseFloat(fields[2])` if present; otherwise `null`.
4. If `bt_c` is `NaN`, the response is malformed — log a warning and skip this reading entirely (do not broadcast, do not append to the ring buffer). This does not trigger a device-status transition.

### Bad thermocouple values

The MAX31855 reports specific error codes for sensor faults: `-1` for open circuit (thermocouple disconnected), and other out-of-range values for short-to-GND or short-to-VCC. The Arduino firmware may pass these through as-is in the TC4 response.

The daemon does **not** broadcast bad thermocouple values as `reading` messages. Instead, it emits a `sensor_fault` message:

```json
{"type": "sensor_fault", "ts": 1729123456789, "raw": "-1,0,0,0", "reason": "bt_open_circuit"}
```

Fields:

- `ts` (integer, Unix milliseconds, UTC) — timestamp of the failed read.
- `raw` (string) — the raw response line from the Arduino, for diagnostics.
- `reason` (string) — a short human-readable classification of the fault. Known values:
  - `"bt_open_circuit"` — BT thermocouple is disconnected (value is -1).
  - `"bt_short_gnd"` — BT thermocouple is shorted to ground.
  - `"bt_short_vcc"` — BT thermocouple is shorted to VCC.
  - `"bt_out_of_range"` — BT value is outside the plausible range (e.g., below -50°C or above 500°C for coffee roasting).
  - `"bt_nan"` — BT field could not be parsed as a number. (Distinct from a malformed response — BT is present but not numeric.)

**Detection rules:**

| Condition | Reason |
|---|---|
| `bt_c === -1` | `bt_open_circuit` |
| `bt_c === -2` | `bt_short_gnd` |
| `bt_c === -3` | `bt_short_vcc` |
| `bt_c < -50` or `bt_c > 500` | `bt_out_of_range` |
| `isNaN(bt_c)` but field is present | `bt_nan` |

A `sensor_fault` does not trigger a device-status transition. The serial link is healthy — the device responded to `READ`. The problem is at the sensor level, not the communication level. The polling loop continues normally on the next interval.

The web server uses `sensor_fault` to show a "check thermocouple" warning in the UI, distinct from the "sensor offline" indicator driven by `device_status`.

### Plausible range

The range check (`-50°C` to `500°C`) is deliberately wide. Bean temperature during a coffee roast ranges from ~20°C (room temp charge) to ~240°C (dark roast drop). The bounds are loose to avoid false positives — they exist to catch garbage data, not to validate roast profiles. The specific values are configurable (see Configuration below) but should rarely need adjustment.

## Ring buffer

After parsing a valid reading, the daemon:

1. Creates the `reading` message: `{ type: "reading", ts: Date.now(), bt_c, et_c }`.
2. Appends it to the ring buffer.
3. Writes it to every connected socket client's send queue.

The ring buffer is a fixed-size array with a write pointer that wraps around, overwriting the oldest entry. Capacity is `bufferSeconds * sampleRateHz` (default: 60 entries at 1 Hz). This is ~5 KB of memory.

The implementation is straightforward — a class with `push(reading)`, `snapshot(): Reading[]` (returns contents in oldest-first order), and `length` — roughly 20–30 lines of code. No external library needed.

## Configuration

Config fields specific to the daemon internals. These extend the protocol-level config from `daemon-protocol.md`.

```jsonc
{
  // Serial
  "serialPath": "/dev/behmor-arduino",
  "serialBaudRate": 115200,

  // Polling
  "sampleRateHz": 1,

  // Read timeout is derived: (1000 / sampleRateHz) * 2
  // At 1 Hz → 2000ms. Not independently configurable.

  // Reconnect backoff
  "reconnectBackoffInitialMs": 500,
  "reconnectBackoffMaxMs": 10000,

  // Ring buffer
  "bufferSeconds": 60,

  // Sensor validation
  "btMinPlausibleC": -50,
  "btMaxPlausibleC": 500
}
```

The read timeout is intentionally not a separate config field. It is always `intervalMs * 2`, derived from `sampleRateHz`. This avoids a class of misconfiguration where the timeout is accidentally set shorter than the interval.

## Protocol addition: `sensor_fault`

This message type is an addition to the daemon→web-server protocol defined in `daemon-protocol.md`. It is documented here because it arises directly from the daemon's parsing logic and was designed alongside it.

The `sensor_fault` message should be added to the protocol document's "Message types: daemon → web server" section when that document is next updated.
