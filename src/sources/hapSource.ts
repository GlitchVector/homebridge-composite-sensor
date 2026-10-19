import { compileMap, MapFn } from "./mapEvaluator.js";
import { Logger } from "homebridge";
import { Source } from "./source.js";
import { HapBridge } from "./hapBridge.js";

function coerce(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    return value.length > 0 && value !== "0" && value.toLowerCase() !== "false";
  }
  return !!value;
}

export interface HapSourceConfig {
  name: string;
  type: "hap";
  /** Logical bridge name, matching an entry in `hapBridges[]`. */
  bridge: string;
  /** Human name (matched against serviceName / instance name) or AID. */
  accessory: string | number;
  /** Characteristic short name (e.g. "On", "MotionDetected") or IID. */
  characteristic: string | number;
  /**
   * Optional JS expression turning the raw characteristic value into a
   * boolean, with the value available as `payload` (same mini-language as
   * the MQTT source's `map`), e.g. `payload === 0 || payload === 100` for a
   * window covering at either limit. Without it, values are coerced
   * (0/""/"false" → false, anything else → true).
   */
  map?: string;
}

export class HapSource extends Source {
  private readonly mapFn?: MapFn;

  constructor(
    private readonly sourceConfig: HapSourceConfig,
    private readonly bridge: HapBridge,
    log: Logger,
  ) {
    super(sourceConfig.name, log);
    if (sourceConfig.map) {
      this.mapFn = compileMap(sourceConfig.map);
    }
  }

  start(): void {
    this.bridge.subscribe(
      {
        accessory: this.sourceConfig.accessory,
        characteristic: this.sourceConfig.characteristic,
      },
      (value, degraded) => {
        const bool = degraded ? undefined : this.mapFn ? this.mapFn(value, String(value)) : coerce(value);
        this.update(bool, degraded);
        this.log.debug(
          `Source "${this.name}" <- ${JSON.stringify(value)} (degraded=${degraded}) => ${bool}`,
        );
      },
    );
    this.bridge.start();
  }

  stop(): void {
    // Bridge lifecycle is owned by the platform; nothing to clean up here.
  }
}
