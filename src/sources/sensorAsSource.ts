import { Logger } from "homebridge";
import { Source } from "./source.js";
import { CompositeSensor } from "../sensors/compositeSensor.js";

/**
 * Adapter that exposes a CompositeSensor's published value as a Source so
 * other CompositeSensors can reference it by name in their expressions.
 *
 * Composite sensors emit "change" on every setValue() call; this adapter
 * forwards the new value through Source.update() which is itself edge-
 * detected, so an idempotent setValue does not produce a downstream event.
 *
 * Sensor names are user-supplied display strings (e.g. "Bathroom Occupied")
 * and may contain spaces and other characters. The DSL parser only accepts
 * `[A-Za-z_][A-Za-z0-9_]*`, so callers must register the adapter under a
 * slugified name (see `sensorSourceSlug`).
 */
export class SensorAsSource extends Source {
  constructor(
    name: string,
    private readonly sensor: CompositeSensor,
    log: Logger,
  ) {
    super(name, log);
    // Seed value immediately so that downstream sensors evaluating in their
    // own constructor (which runs synchronously after this adapter is
    // registered) see the current sensor value, not undefined.
    this.value = sensor.getCurrentValue();
    this.degraded = false;
    sensor.on("change", (v: boolean) => this.update(v, false));
  }

  start(): void {
    // No-op. The wrapped sensor's lifecycle is owned by the platform.
  }

  stop(): void {
    // No-op. We don't manage subscriptions on the wrapped sensor's side.
  }
}

/**
 * Convert a sensor display name to an identifier accepted by the
 * expression parser. Strategy: strip non-alphanumeric/underscore, then
 * downcase the first character so the result reads as camelCase
 * (matching the convention used for raw sources like `bathroomMotion`).
 *
 * "Bathroom Occupied" → "bathroomOccupied"
 * "Any Hue Motion"    → "anyHueMotion"
 * "1st Floor"         → "stFloor" (leading digit stripped — fine; sensors
 *                        with names starting with digits are uncommon and
 *                        the user can always rename)
 */
export function sensorSourceSlug(name: string): string {
  // Title-case each word, then join, then lowercase the first letter.
  const parts = name.split(/[^A-Za-z0-9_]+/).filter(Boolean);
  if (parts.length === 0) {
    return "";
  }
  const joined = parts
    .map((p, i) =>
      i === 0
        ? p.charAt(0).toLowerCase() + p.slice(1)
        : p.charAt(0).toUpperCase() + p.slice(1),
    )
    .join("");
  // Strip any leading characters that aren't valid identifier-starters.
  return joined.replace(/^[^A-Za-z_]+/, "");
}
