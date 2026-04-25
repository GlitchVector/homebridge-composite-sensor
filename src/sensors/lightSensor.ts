import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { HapBridge } from "../sources/hapBridge.js";
import { CompositeSensorPlatform } from "../platform.js";

export interface LightSensorConfig {
  name: string;
  service: "light";
  /** Logical bridge name, matching an entry in `hapBridges[]`. */
  bridge: string;
  /** Accessory identifier — human name (matched against `serviceName`) or AID. */
  accessory: string | number;
  /** Characteristic identifier — short name (e.g. `CurrentAmbientLightLevel`) or IID. */
  characteristic: string | number;
}

const HAP_LUX_MIN = 0.0001;
const HAP_LUX_MAX = 100000;

/**
 * Numeric passthrough sensor. Reads a single HAP characteristic from a
 * configured bridge and exposes it 1:1 as a HomeKit LightSensor's
 * `CurrentAmbientLightLevel`.
 *
 * Unlike CompositeSensor this is a single-source passthrough: no expression,
 * no boolean coercion, no hold/latch semantics. Reuses the bridge's existing
 * subscribe machinery — the boolean Source layer would destroy the lux value
 * on coercion, so we bypass it.
 */
export class LightSensor {
  private readonly service: Service;
  private currentValue: number = HAP_LUX_MIN;

  constructor(
    private readonly platform: CompositeSensorPlatform,
    accessory: PlatformAccessory,
    private readonly config: LightSensorConfig,
    bridges: Map<string, HapBridge>,
  ) {
    const bridge = bridges.get(config.bridge);
    if (!bridge) {
      throw new Error(
        `Light sensor "${config.name}" references unknown bridge "${config.bridge}"`,
      );
    }

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

    bridge.subscribe(
      { accessory: config.accessory, characteristic: config.characteristic },
      (value, degraded) => this.handleUpdate(value, degraded),
    );
  }

  private handleUpdate(value: unknown, degraded: boolean): void {
    if (degraded) {
      return;
    }
    const num = Number(value);
    if (!Number.isFinite(num)) {
      this.platform.log.warn(
        `Light sensor "${this.config.name}" received non-numeric value: ${JSON.stringify(value)}`,
      );
      return;
    }
    const clamped = Math.min(HAP_LUX_MAX, Math.max(HAP_LUX_MIN, num));
    this.currentValue = clamped;
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentAmbientLightLevel,
      clamped,
    );
    this.platform.log.debug(`Light sensor "${this.config.name}" -> ${clamped}`);
  }

  stop(): void {
    // Subscription lifecycle is owned by the HapBridge; nothing to release.
  }
}
