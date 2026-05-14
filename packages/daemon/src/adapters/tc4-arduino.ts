import type { RequestResponseDeviceAdapter, ParseResult } from "./types.js";

/**
 * Configuration knobs the TC4 adapter needs at construction time. The shape
 * is intentionally a strict subset of `DaemonConfig` field names so that the
 * full config can be passed in directly by structural typing.
 */
export interface TC4ArduinoAdapterConfig {
  /** Lower bound (°C) below which BT readings are flagged as `bt_out_of_range`. */
  btMinPlausibleC: number;
  /** Upper bound (°C) above which BT readings are flagged as `bt_out_of_range`. */
  btMaxPlausibleC: number;
}

/**
 * Adapter for the TC4-style Arduino + MAX31855 + K-type-thermocouple rig.
 *
 * Protocol summary:
 *
 *   - Request/response over USB-serial at 115200 baud.
 *   - Host writes `READ\r\n` to request a sample.
 *   - Device replies with a single CRLF-terminated CSV line:
 *
 *       `<ambient_c>,<bt_c>[,<et_c>]`
 *
 *     where the BT field may carry one of the MAX31855 fault sentinels:
 *
 *       -1 → open circuit       (no thermocouple connected)
 *       -2 → short to ground
 *       -3 → short to VCC
 *
 *   - Anything else with fewer than 2 CSV fields is treated as malformed
 *     and silently ignored by the poller.
 */
export class TC4ArduinoAdapter implements RequestResponseDeviceAdapter {
  readonly mode = "request-response" as const;

  constructor(private readonly cfg: TC4ArduinoAdapterConfig) {}

  getPollCommand(): string {
    return "READ\r\n";
  }

  parse(data: string | Buffer): ParseResult | null {
    const line = typeof data === "string" ? data : data.toString("utf-8");
    const fields = line.trim().split(",");
    if (fields.length < 2) return null;

    const btRaw = parseFloat(fields[1]!);
    const fault = classifyBtFault(btRaw, this.cfg);
    if (fault) {
      return { kind: "fault", raw: line, reason: fault };
    }

    const etRaw = fields[2] !== undefined ? parseFloat(fields[2]) : NaN;
    const etC = Number.isFinite(etRaw) ? etRaw : null;
    return { kind: "reading", bt_c: btRaw, et_c: etC };
  }
}

/**
 * Classify a BT value against MAX31855 error codes and the configured
 * plausibility range. Returns a fault reason or null if the value is OK.
 */
function classifyBtFault(bt: number, cfg: TC4ArduinoAdapterConfig): string | null {
  if (Number.isNaN(bt)) return "bt_nan";
  if (bt === -1) return "bt_open_circuit";
  if (bt === -2) return "bt_short_gnd";
  if (bt === -3) return "bt_short_vcc";
  if (bt < cfg.btMinPlausibleC || bt > cfg.btMaxPlausibleC) return "bt_out_of_range";
  return null;
}
