import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { HapBridge } from "../sources/hapBridge.js";
import { CompositeSensorPlatform } from "../platform.js";

/**
 * Config shape for a magic-button accessory.
 *
 * Exposes a HomeKit Switch that, on activation, snapshots the target light's
 * current On+Brightness and writes the target's Brightness up to
 * `targetBrightness` (turning it on if needed). On deactivation, the
 * snapshot is restored verbatim — so the light returns to whatever level
 * (or off-state) it was at before the button was pressed.
 *
 * Snapshot is in-memory only. Across a Homebridge restart the snapshot is
 * lost; in that case deactivation becomes a no-op rather than guessing.
 */
export interface MagicButtonConfig {
  name: string;
  service: "magic_button";
  /** Logical name of an entry in `hapBridges[]` where the target light lives. */
  bridge: string;
  /** Accessory identifier on that bridge — display name (serviceName) or numeric AID. */
  accessory: string | number;
  /** Brightness to set on activation (0-100, HomeKit scale). */
  targetBrightness: number;
}

interface Snapshot {
  on: boolean;
  brightness: number;
}

/**
 * "Magic button" — a HomeKit Switch that boosts a target light to a
 * preset brightness while ON and restores the prior state on OFF.
 *
 * Behavior is intentionally non-idempotent across the OFF transition:
 * if the user manually adjusts the light's brightness between ON and OFF
 * of the magic button, the restore on OFF overrides that manual change.
 * That matches the "snapshot-and-restore" mental model (vs e.g. a diff
 * approach that would preserve manual mid-cycle changes).
 *
 * See feedback_homebridge.md §D1 for the short-circuit-no-change rule
 * applied in handleOn().
 */
export class MagicButton {
  private readonly service: Service;
  private readonly bridge: HapBridge;
  private currentOn = false;
  /** Latest known On of the target — populated by the bridge subscribe. */
  private targetOn: boolean | undefined;
  /** Latest known Brightness of the target — populated by the bridge subscribe. */
  private targetBrightness: number | undefined;
  /** In-memory snapshot taken on activation; cleared on deactivation. */
  private snapshot?: Snapshot;
  /** Serializes ON/OFF transitions so rapid toggles don't interleave. */
  private writeInFlight = false;

  constructor(
    private readonly platform: CompositeSensorPlatform,
    accessory: PlatformAccessory,
    private readonly config: MagicButtonConfig,
    bridges: Map<string, HapBridge>,
  ) {
    accessory.getService(platform.Service.AccessoryInformation)
      ?.setCharacteristic(platform.Characteristic.Manufacturer, "homebridge-composite-sensor")
      .setCharacteristic(platform.Characteristic.Model, "magic_button")
      .setCharacteristic(platform.Characteristic.SerialNumber, config.name);

    this.service =
      accessory.getService(platform.Service.Switch)
      ?? accessory.addService(platform.Service.Switch);
    this.service.setCharacteristic(platform.Characteristic.Name, config.name);
    this.service
      .getCharacteristic(platform.Characteristic.On)
      .onGet(() => this.currentOn as CharacteristicValue)
      .onSet((value) => this.handleOn(Boolean(value)));

    const bridge = bridges.get(config.bridge);
    if (!bridge) {
      throw new Error(
        `Magic button "${config.name}" references unknown bridge "${config.bridge}"`,
      );
    }
    this.bridge = bridge;

    if (
      typeof config.targetBrightness !== "number"
      || !Number.isFinite(config.targetBrightness)
      || config.targetBrightness < 0
      || config.targetBrightness > 100
    ) {
      throw new Error(
        `Magic button "${config.name}" requires targetBrightness in [0,100], got ${JSON.stringify(config.targetBrightness)}`,
      );
    }

    // Track the target's current On + Brightness so activation has fresh
    // values to snapshot. Pure read path — no write happens until the
    // HomeKit switch is toggled.
    bridge.subscribe(
      { accessory: config.accessory, characteristic: "On" },
      (v, degraded) => {
        if (degraded) {
          return;
        }
        this.targetOn = Boolean(v);
      },
    );
    bridge.subscribe(
      { accessory: config.accessory, characteristic: "Brightness" },
      (v, degraded) => {
        if (degraded) {
          return;
        }
        const n = Number(v);
        if (Number.isFinite(n)) {
          this.targetBrightness = n;
        }
      },
    );
  }

  private async handleOn(value: boolean): Promise<void> {
    if (value === this.currentOn) {
      return;
    }
    if (this.writeInFlight) {
      this.platform.log.debug(
        `Magic button "${this.config.name}" ignoring transition to ${value ? "ON" : "OFF"} (write in flight)`,
      );
      return;
    }
    this.writeInFlight = true;
    try {
      if (value) {
        await this.activate();
      } else {
        await this.deactivate();
      }
      this.currentOn = value;
    } catch (err) {
      this.platform.log.error(
        `Magic button "${this.config.name}" transition to ${value ? "ON" : "OFF"} failed:`,
        (err as Error).message,
      );
      // Revert HomeKit's view of the switch so the failure is visible to
      // the user rather than the switch silently disagreeing with the light.
      this.service.updateCharacteristic(
        this.platform.Characteristic.On,
        this.currentOn,
      );
    } finally {
      this.writeInFlight = false;
    }
  }

  private async activate(): Promise<void> {
    if (this.targetOn === undefined || this.targetBrightness === undefined) {
      throw new Error(
        `Magic button "${this.config.name}": target On/Brightness not yet known — bridge subscribe still degraded?`,
      );
    }
    this.snapshot = {
      on: this.targetOn,
      brightness: this.targetBrightness,
    };
    this.platform.log.info(
      `Magic button "${this.config.name}" activate: snapshot {on=${this.snapshot.on}, brightness=${this.snapshot.brightness}} → target brightness=${this.config.targetBrightness}`,
    );
    // Set On first, then Brightness. Some bridges (Loxone via
    // homebridge-loxone-control) treat Brightness writes as no-ops when
    // On is false; writing On=true first guarantees the brightness write
    // actually lands.
    await this.bridge.write(
      { accessory: this.config.accessory, characteristic: "On" },
      true,
    );
    await this.bridge.write(
      { accessory: this.config.accessory, characteristic: "Brightness" },
      this.config.targetBrightness,
    );
  }

  private async deactivate(): Promise<void> {
    if (!this.snapshot) {
      this.platform.log.warn(
        `Magic button "${this.config.name}" deactivating with no snapshot — leaving target as-is (was Homebridge restarted while the magic button was ON?)`,
      );
      return;
    }
    const snap = this.snapshot;
    this.snapshot = undefined;
    this.platform.log.info(
      `Magic button "${this.config.name}" deactivate: restore {on=${snap.on}, brightness=${snap.brightness}}`,
    );
    // Restore Brightness before On — so when On goes false the target
    // remembers the snapshot brightness as its "last brightness" rather
    // than the boosted target value.
    await this.bridge.write(
      { accessory: this.config.accessory, characteristic: "Brightness" },
      snap.brightness,
    );
    await this.bridge.write(
      { accessory: this.config.accessory, characteristic: "On" },
      snap.on,
    );
  }

  stop(): void {
    // Subscription lifecycle is owned by the HapBridge; nothing to release here.
  }
}
