import {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from "homebridge";

import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";
import { patchDnssdReadFQDN } from "./sources/dnssdPatch.js";
import { Source } from "./sources/source.js";
import { MqttBroker, MqttConfig } from "./sources/mqttBroker.js";
import { MqttSource, MqttSourceConfig } from "./sources/mqttSource.js";
import { HapBridge, HapBridgeConfig } from "./sources/hapBridge.js";
import { HapSource, HapSourceConfig } from "./sources/hapSource.js";
import { CompositeSensor, CompositeSensorConfig } from "./sensors/compositeSensor.js";

type SourceConfig = MqttSourceConfig | HapSourceConfig;

interface CompositeSensorPlatformConfig extends PlatformConfig {
  mqtt?: MqttConfig;
  hapBridges?: HapBridgeConfig[];
  sources?: SourceConfig[];
  sensors?: CompositeSensorConfig[];
}

export class CompositeSensorPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: PlatformAccessory[] = [];

  private mqttBroker?: MqttBroker;
  private readonly hapBridges = new Map<string, HapBridge>();
  private readonly sources = new Map<string, Source>();
  private readonly sensors: CompositeSensor[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: CompositeSensorPlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    patchDnssdReadFQDN({
      info: (s) => this.log.info(s),
      debug: (s) => this.log.debug(s),
    });

    this.log.debug("Finished initializing platform:", this.config.name);

    this.api.on("didFinishLaunching", () => {
      try {
        this.bootstrap();
      } catch (err) {
        this.log.error("Failed to bootstrap CompositeSensor platform:", (err as Error).message);
      }
    });

    this.api.on("shutdown", () => this.shutdown());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info("Loading accessory from cache:", accessory.displayName);
    this.accessories.push(accessory);
  }

  private bootstrap(): void {
    const sourceConfigs = this.config.sources ?? [];
    const sensorConfigs = this.config.sensors ?? [];

    // --- MQTT broker (lazy: only constructed if any MQTT source is declared) ---
    const hasMqttSource = sourceConfigs.some((s) => s.type === "mqtt");
    if (hasMqttSource) {
      if (!this.config.mqtt?.url) {
        this.log.error("MQTT sources declared but no `mqtt.url` in config — MQTT sources will be skipped");
      } else {
        this.mqttBroker = new MqttBroker(this.config.mqtt, this.log);
      }
    }

    // --- HAP bridges ---
    for (const bridgeConfig of this.config.hapBridges ?? []) {
      if (!bridgeConfig.name || !bridgeConfig.host || !bridgeConfig.port || !bridgeConfig.pin) {
        this.log.error(
          `hapBridges entry missing required fields (name/host/port/pin): ${JSON.stringify(bridgeConfig)}`,
        );
        continue;
      }
      const bridge = new HapBridge(bridgeConfig, this.log);
      this.hapBridges.set(bridgeConfig.name, bridge);
    }

    // --- Sources ---
    for (const sc of sourceConfigs) {
      if (!sc.name) {
        this.log.error(`source entry missing name: ${JSON.stringify(sc)}`);
        continue;
      }
      if (this.sources.has(sc.name)) {
        this.log.error(`duplicate source name "${sc.name}" — skipping`);
        continue;
      }
      try {
        if (sc.type === "mqtt") {
          if (!this.mqttBroker) {
            this.log.warn(`Source "${sc.name}" skipped: no MQTT broker available`);
            continue;
          }
          this.sources.set(sc.name, new MqttSource(sc, this.mqttBroker, this.log));
        } else if (sc.type === "hap") {
          const bridge = this.hapBridges.get(sc.bridge);
          if (!bridge) {
            this.log.error(`Source "${sc.name}" references unknown bridge "${sc.bridge}"`);
            continue;
          }
          this.sources.set(sc.name, new HapSource(sc, bridge, this.log));
        } else {
          this.log.error(`Source "${(sc as { name: string }).name}" has unknown type`);
        }
      } catch (err) {
        this.log.error(`Failed to create source "${sc.name}":`, (err as Error).message);
      }
    }

    // --- Sensors (accessories) ---
    const desiredUuids = new Set<string>();
    for (const sensorConfig of sensorConfigs) {
      if (!sensorConfig.name || !sensorConfig.expression || !sensorConfig.service) {
        this.log.error(
          `sensor entry missing required fields (name/service/expression): ${JSON.stringify(sensorConfig)}`,
        );
        continue;
      }
      const uuid = this.api.hap.uuid.generate(`composite-sensor:${sensorConfig.name}`);
      desiredUuids.add(uuid);

      let accessory = this.accessories.find((a) => a.UUID === uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(sensorConfig.name, uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Registered new composite sensor: ${sensorConfig.name}`);
      } else {
        accessory.displayName = sensorConfig.name;
        this.log.info(`Restored composite sensor from cache: ${sensorConfig.name}`);
      }
      accessory.context.config = sensorConfig;

      try {
        const sensor = new CompositeSensor(this, accessory, sensorConfig, this.sources);
        this.sensors.push(sensor);
      } catch (err) {
        this.log.error(`Failed to build sensor "${sensorConfig.name}":`, (err as Error).message);
      }
    }

    // Remove accessories that no longer appear in config.
    const stale = this.accessories.filter((a) => !desiredUuids.has(a.UUID));
    if (stale.length > 0) {
      this.log.info(`Removing ${stale.length} stale cached sensor(s)`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }

    // --- Kick off transports last so sensors are ready to receive events ---
    // Start HAP bridges eagerly — even if no source currently references
    // them. This guarantees the AID/IID snapshot is logged on first start
    // (useful for discovering which zones/services an accessory exposes),
    // and allows `subscribe()` calls that arrive later to resolve against
    // an already-populated catalog.
    for (const bridge of this.hapBridges.values()) {
      try {
        bridge.start();
      } catch (err) {
        this.log.error(`Failed to start HAP bridge "${bridge.config.name}":`, (err as Error).message);
      }
    }
    for (const source of this.sources.values()) {
      try {
        source.start();
      } catch (err) {
        this.log.error(`Failed to start source "${source.name}":`, (err as Error).message);
      }
    }
  }

  private shutdown(): void {
    for (const sensor of this.sensors) {
      sensor.stop();
    }
    for (const source of this.sources.values()) {
      source.stop();
    }
    for (const bridge of this.hapBridges.values()) {
      bridge.stop();
    }
    this.mqttBroker?.stop();
  }
}
