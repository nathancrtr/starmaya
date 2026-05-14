import type { ReadingMessage, SensorFaultMessage } from "@starmaya/shared";

/**
 * Contract between the protocol-agnostic serial poller and a hardware-specific
 * device implementation.
 *
 * Ownership boundary:
 *
 *   - The poller owns: serial port lifecycle, reconnect, post-open delay,
 *     timing, event emission.
 *   - The adapter owns: polling commands, response parsing, sensor
 *     interpretation, hardware quirks that need to run after the port opens.
 *
 * Two interaction modes are supported:
 *
 *   - `"request-response"` — the poller periodically calls
 *     `getPollCommand()` and writes the result to the port. Each device
 *     reply arrives as a single line which the poller feeds back to
 *     `parse()`.
 *
 *   - `"streaming"` — the device emits lines on its own cadence. The poller
 *     never writes polling commands; it simply forwards every received line
 *     to `parse()`.
 */
/**
 * Fields common to every adapter regardless of interaction mode.
 */
interface BaseDeviceAdapter {
  /**
   * Called once after the serial port has opened and the poller's
   * `postOpenDelayMs` has elapsed. Use for any device-specific handshake
   * (e.g. configuring sample rate, requesting a banner). Optional; absent
   * means no handshake is required.
   */
  onPortOpened?(): Promise<void>;

  /**
   * Parse a single line of input from the device.
   *
   * Return `null` to silently ignore malformed input — the poller will not
   * emit anything for that line. Throw only on truly unexpected adapter
   * bugs; transport-level failures are the poller's concern.
   *
   * The returned object carries only the device-supplied fields. The poller
   * attaches `type` and `ts` before emission to keep timestamp ownership in
   * one place.
   */
  parse(data: string | Buffer): ParseResult | null;
}

/**
 * Adapter for devices the host has to actively poll. The poller writes
 * `getPollCommand()` on each tick and waits for one line in response.
 */
export interface RequestResponseDeviceAdapter extends BaseDeviceAdapter {
  readonly mode: "request-response";
  /** Bytes (or string) to write to the port on each poll. */
  getPollCommand(): string | Buffer;
}

/**
 * Adapter for devices that emit lines on their own cadence. The poller
 * never writes polling commands; every received line is forwarded to
 * `parse()` directly.
 */
export interface StreamingDeviceAdapter extends BaseDeviceAdapter {
  readonly mode: "streaming";
}

export type DeviceAdapter = RequestResponseDeviceAdapter | StreamingDeviceAdapter;

/** Discriminated union of what an adapter can produce from a single line. */
export type ParseResult = ReadingParse | FaultParse;

export interface ReadingParse {
  kind: "reading";
  bt_c: ReadingMessage["bt_c"];
  et_c: ReadingMessage["et_c"];
}

export interface FaultParse {
  kind: "fault";
  raw: SensorFaultMessage["raw"];
  reason: SensorFaultMessage["reason"];
}
