import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { Source } from "../sources/source.js";
import { CompositeSensorPlatform } from "../platform.js";

export interface DurationSensorConfig {
  name: string;
  service: "duration";
  /** Boolean source names — OR'd. The OR's rising edge starts the timer. */
  sources: string[];
  /** Reporting unit. Default seconds. */
  unit?: "seconds" | "minutes";
  /** How often to push the current duration to HomeKit. Default 30s. */
  updateIntervalSeconds?: number;
}

const HAP_LUX_MIN = 0.0001;
const HAP_LUX_MAX = 100000;
const DEFAULT_INTERVAL_S = 30;

/**
 * Reports how long ANY of the referenced sources has been continuously
 * `true`. Computes the OR of the sources; on its rising edge stamps a
 * start time, on its falling edge clears it. A periodic timer republishes
 * the elapsed value so HomeKit reads stay fresh between source events.
 *
 * Exposed as `LightSensor.CurrentAmbientLightLevel` in the chosen unit
 * (seconds or minutes). Zero (i.e. "no presence right now") shows as
 * `HAP_LUX_MIN` since the lux characteristic rejects 0.
 */
export class DurationSensor {
  private readonly service: Service;
  private currentValue: number = HAP_LUX_MIN;
  private readonly resolvedSources: Source[] = [];
  private readonly listeners: Array<{ src: Source; fn: () => void }> = [];
  private readonly unit: "seconds" | "minutes";
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private presenceStartedAt?: number;

  constructor(
    private readonly platform: CompositeSensorPlatform,
    accessory: PlatformAccessory,
    private readonly config: DurationSensorConfig,
    sources: Map<string, Source>,
  ) {
    if (!Array.isArray(config.sources) || config.sources.length === 0) {
      throw new Error(
        `Duration sensor "${config.name}" needs a non-empty \`sources\` array`,
      );
    }
    for (const name of config.sources) {
      const src = sources.get(name);
      if (!src) {
        throw new Error(
          `Duration sensor "${config.name}" references unknown source "${name}"`,
        );
      }
      this.resolvedSources.push(src);
    }
    this.unit = config.unit ?? "seconds";
    this.intervalMs = Math.max(1, config.updateIntervalSeconds ?? DEFAULT_INTERVAL_S) * 1000;

    accessory.getService(platform.Service.AccessoryInformation)
      ?.setCharacteristic(platform.Characteristic.Manufacturer, "homebridge-composite-sensor")
      .setCharacteristic(platform.Characteristic.Model, "duration")
      .setCharacteristic(platform.Characteristic.SerialNumber, config.name);

    this.service =
      accessory.getService(platform.Service.LightSensor)
      ?? accessory.addService(platform.Service.LightSensor);
    this.service.setCharacteristic(platform.Characteristic.Name, config.name);
    this.service
      .getCharacteristic(platform.Characteristic.CurrentAmbientLightLevel)
      .onGet(() => this.currentValue as CharacteristicValue);

    for (const src of this.resolvedSources) {
      const fn = () => this.onSourceChange();
      src.on("change", fn);
      this.listeners.push({ src, fn });
    }
    // Seed: any source already true at startup → start timer now (we don't
    // know the actual rising-edge wall time, so this is a lower bound).
    this.onSourceChange();
    this.timer = setInterval(() => this.publish(), this.intervalMs);
  }

  private anyActive(): boolean {
    for (const src of this.resolvedSources) {
      if (!src.degraded && src.value === true) {
        return true;
      }
    }
    return false;
  }

  private onSourceChange(): void {
    const active = this.anyActive();
    if (active && this.presenceStartedAt === undefined) {
      this.presenceStartedAt = Date.now();
      this.platform.log.debug(`Duration sensor "${this.config.name}" timer started`);
    } else if (!active && this.presenceStartedAt !== undefined) {
      this.presenceStartedAt = undefined;
      this.platform.log.debug(`Duration sensor "${this.config.name}" timer cleared`);
    }
    this.publish();
  }

  private publish(): void {
    let next: number;
    if (this.presenceStartedAt === undefined) {
      next = HAP_LUX_MIN;
    } else {
      const elapsedMs = Date.now() - this.presenceStartedAt;
      const elapsed = this.unit === "minutes" ? elapsedMs / 60_000 : elapsedMs / 1000;
      next = Math.max(HAP_LUX_MIN, Math.min(HAP_LUX_MAX, elapsed));
    }
    if (next === this.currentValue) {
      return;
    }
    this.currentValue = next;
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentAmbientLightLevel,
      next,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const { src, fn } of this.listeners) {
      src.off("change", fn);
    }
    this.listeners.length = 0;
  }
}
