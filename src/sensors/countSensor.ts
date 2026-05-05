import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { Source } from "../sources/source.js";
import { CompositeSensorPlatform } from "../platform.js";

export interface CountSensorConfig {
  name: string;
  service: "count";
  /** Boolean source names whose `true` values get summed. */
  sources: string[];
  /**
   * Source names that should never contribute to the count, even if they
   * appear in `sources`. Useful for FP2 zones that ghost through windows
   * (e.g. someone sitting in `office` also flips `loggia` on through the
   * loggia window — listing `loggia` in `exclude` keeps it visible to other
   * sensors while preventing double-counting here).
   */
  exclude?: string[];
}

const HAP_LUX_MIN = 0.0001;
const HAP_LUX_MAX = 100000;

/**
 * Numeric headcount sensor. Each tick, sums how many of the referenced
 * sources currently report `true`, and exposes that sum on a HomeKit
 * `LightSensor.CurrentAmbientLightLevel` characteristic (the only standard
 * numeric service that fits arbitrary integers without a unit-of-measure
 * mismatch with HomeKit's UI).
 *
 * Degraded sources count as 0 — same convention as
 * `CompositeSensor.evaluate()` treats undefined boolean values: `false`-ish.
 */
export class CountSensor {
  private readonly service: Service;
  private currentValue: number = HAP_LUX_MIN;
  private readonly resolvedSources: Source[] = [];
  private readonly excluded: Set<string>;
  private readonly listeners: Array<{ src: Source; fn: () => void }> = [];

  constructor(
    private readonly platform: CompositeSensorPlatform,
    accessory: PlatformAccessory,
    private readonly config: CountSensorConfig,
    sources: Map<string, Source>,
  ) {
    if (!Array.isArray(config.sources) || config.sources.length === 0) {
      throw new Error(
        `Count sensor "${config.name}" needs a non-empty \`sources\` array`,
      );
    }
    for (const name of config.sources) {
      const src = sources.get(name);
      if (!src) {
        throw new Error(
          `Count sensor "${config.name}" references unknown source "${name}"`,
        );
      }
      this.resolvedSources.push(src);
    }
    this.excluded = new Set(config.exclude ?? []);
    for (const name of this.excluded) {
      if (!this.resolvedSources.some((s) => s.name === name)) {
        platform.log.warn(
          `Count sensor "${config.name}" excludes "${name}" but it isn't in \`sources\` — listed sources: ${config.sources.join(", ")}`,
        );
      }
    }

    accessory.getService(platform.Service.AccessoryInformation)
      ?.setCharacteristic(platform.Characteristic.Manufacturer, "homebridge-composite-sensor")
      .setCharacteristic(platform.Characteristic.Model, "count")
      .setCharacteristic(platform.Characteristic.SerialNumber, config.name);

    this.service =
      accessory.getService(platform.Service.LightSensor)
      ?? accessory.addService(platform.Service.LightSensor);
    this.service.setCharacteristic(platform.Characteristic.Name, config.name);
    this.service
      .getCharacteristic(platform.Characteristic.CurrentAmbientLightLevel)
      .onGet(() => this.currentValue as CharacteristicValue);

    for (const src of this.resolvedSources) {
      const fn = () => this.recompute();
      src.on("change", fn);
      this.listeners.push({ src, fn });
    }
    this.recompute();
  }

  private recompute(): void {
    let count = 0;
    for (const src of this.resolvedSources) {
      if (this.excluded.has(src.name)) {
        continue;
      }
      if (!src.degraded && src.value === true) {
        count += 1;
      }
    }
    // HAP_LUX_MIN floor — `LightSensor.CurrentAmbientLightLevel` rejects 0.
    // Display-wise "0.0001 lux" reads as ~0 in Apple Home.
    const next = count === 0 ? HAP_LUX_MIN : Math.min(HAP_LUX_MAX, count);
    if (next === this.currentValue) {
      return;
    }
    this.currentValue = next;
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentAmbientLightLevel,
      next,
    );
    this.platform.log.debug(
      `Count sensor "${this.config.name}" -> ${count} (${this.resolvedSources.map((s) => `${s.name}=${s.value}`).join(", ")})`,
    );
  }

  stop(): void {
    for (const { src, fn } of this.listeners) {
      src.off("change", fn);
    }
    this.listeners.length = 0;
  }
}
