import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { HapBridge } from "../sources/hapBridge.js";
import { CompositeSensorPlatform } from "../platform.js";

export interface LightSensorSourceConfig {
  /** Logical bridge name, matching an entry in `hapBridges[]`. */
  bridge: string;
  /** Accessory identifier — human name (matched against `serviceName`) or AID. */
  accessory: string | number;
  /** Characteristic identifier — short name (e.g. `CurrentAmbientLightLevel`) or IID. */
  characteristic: string | number;
}

export interface LightSensorConfig {
  name: string;
  service: "light";
  /**
   * Single-source pass-through (legacy shape). Either set these three OR set
   * `sources` — never both.
   */
  bridge?: string;
  accessory?: string | number;
  characteristic?: string | number;
  /**
   * Multi-source mode. Each entry is subscribed independently and the
   * aggregator picks one number per update.
   */
  sources?: LightSensorSourceConfig[];
  /** How to combine multiple sources. Defaults to `max`. */
  aggregator?: "max" | "min";
}

const HAP_LUX_MIN = 0.0001;
const HAP_LUX_MAX = 100000;

/**
 * Numeric lux sensor. In single-source mode it pass-throughs one HAP
 * characteristic 1:1. In multi-source mode it subscribes to several lux
 * inputs and exposes the aggregate (default: max) as
 * `CurrentAmbientLightLevel`.
 *
 * Bypasses the boolean Source layer (which would coerce values) — subscribes
 * directly to the bridge's existing characteristic stream.
 */
export class LightSensor {
  private readonly service: Service;
  private currentValue: number = HAP_LUX_MIN;
  private readonly perSource: Array<number | undefined>;
  private readonly aggregator: "max" | "min";

  constructor(
    private readonly platform: CompositeSensorPlatform,
    accessory: PlatformAccessory,
    private readonly config: LightSensorConfig,
    bridges: Map<string, HapBridge>,
  ) {
    accessory.getService(platform.Service.AccessoryInformation)
      ?.setCharacteristic(platform.Characteristic.Manufacturer, "homebridge-composite-sensor")
      .setCharacteristic(platform.Characteristic.Model, "light")
      .setCharacteristic(platform.Characteristic.SerialNumber, config.name);

    this.service =
      accessory.getService(platform.Service.LightSensor)
      ?? accessory.addService(platform.Service.LightSensor);
    this.service.setCharacteristic(platform.Characteristic.Name, config.name);
    this.service
      .getCharacteristic(platform.Characteristic.CurrentAmbientLightLevel)
      .onGet(() => this.currentValue as CharacteristicValue);

    const sources = this.resolveSources();
    this.aggregator = config.aggregator ?? "max";
    this.perSource = new Array(sources.length).fill(undefined);

    sources.forEach((src, idx) => {
      const bridge = bridges.get(src.bridge);
      if (!bridge) {
        throw new Error(
          `Light sensor "${config.name}" references unknown bridge "${src.bridge}"`,
        );
      }
      bridge.subscribe(
        { accessory: src.accessory, characteristic: src.characteristic },
        (value, degraded) => this.handleUpdate(idx, value, degraded),
      );
    });
  }

  private resolveSources(): LightSensorSourceConfig[] {
    if (this.config.sources && this.config.sources.length > 0) {
      if (this.config.bridge || this.config.accessory || this.config.characteristic) {
        throw new Error(
          `Light sensor "${this.config.name}": set either single-source fields OR \`sources\`, not both`,
        );
      }
      return this.config.sources;
    }
    if (!this.config.bridge || !this.config.accessory || !this.config.characteristic) {
      throw new Error(
        `Light sensor "${this.config.name}" needs either bridge/accessory/characteristic or a non-empty \`sources\` array`,
      );
    }
    return [{
      bridge: this.config.bridge,
      accessory: this.config.accessory,
      characteristic: this.config.characteristic,
    }];
  }

  private handleUpdate(idx: number, value: unknown, degraded: boolean): void {
    if (degraded) {
      this.perSource[idx] = undefined;
      this.recompute();
      return;
    }
    const num = Number(value);
    if (!Number.isFinite(num)) {
      this.platform.log.warn(
        `Light sensor "${this.config.name}" received non-numeric value: ${JSON.stringify(value)}`,
      );
      return;
    }
    this.perSource[idx] = Math.min(HAP_LUX_MAX, Math.max(HAP_LUX_MIN, num));
    this.recompute();
  }

  private recompute(): void {
    const live = this.perSource.filter((v): v is number => v !== undefined);
    if (live.length === 0) {
      // All sources degraded — leave the last published value in place rather
      // than thrashing back to HAP_LUX_MIN. HomeKit prefers stale-but-stable.
      return;
    }
    const next = this.aggregator === "min"
      ? Math.min(...live)
      : Math.max(...live);
    if (next === this.currentValue) {
      return;
    }
    this.currentValue = next;
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentAmbientLightLevel,
      next,
    );
    this.platform.log.debug(
      `Light sensor "${this.config.name}" -> ${next} (${this.aggregator} of ${live.join(", ")})`,
    );
  }

  stop(): void {
    // Subscription lifecycle is owned by the HapBridge; nothing to release.
  }
}
