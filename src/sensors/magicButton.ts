import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { HapBridge } from "../sources/hapBridge.js";
import { CompositeSensorPlatform } from "../platform.js";

/**
 * Config shape for a magic-button accessory.
 *
 * Exposes a HomeKit Switch that, on activation, snapshots the target light's
 * current On+Brightness and writes the target's Brightness up to
 * `targetBrightness` (turning it on if needed). On deactivation, the
 * snapshot is restored verbatim.
 *
 * If the user (or any other actor) manually changes the target's brightness
 * between activation and deactivation, the magic button interprets that as
 * "the user has taken control" — it auto-OFFs in HomeKit and leaves the
 * manual setting in place rather than restoring the snapshot.
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
 * "Magic button" — a HomeKit Switch that boosts a target light to a preset
 * brightness while ON and restores the prior state on a normal OFF.
 *
 * Manual-override semantics: if the target's brightness changes to anything
 * OTHER than our written `targetBrightness` while the magic button is ON, we
 * treat that as a manual intervention. The magic button auto-OFFs in
 * HomeKit and the manual brightness setting is left in place — no restore.
 *
 * To distinguish our own write's echo from a genuine manual change, the
 * listener stays in a "pre-echo" state after activation until either:
 *   (a) it observes a brightness change equal to `targetBrightness`
 *       (= our write settled), or
 *   (b) a 3-second grace timer expires (some bridges optimize away no-op
 *       writes and never emit an echo — e.g., target was already at target
 *       brightness when activated).
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
  /** Gate for treating brightness changes as manual interventions. See class docstring. */
  private manualWatchEnabled = false;
  /** Fallback timer that enables manualWatchEnabled if the write echo never arrives. */
  private manualWatchTimer?: ReturnType<typeof setTimeout>;
  private static readonly MANUAL_WATCH_FALLBACK_MS = 3000;

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
    // values to snapshot. The brightness path also drives manual-override
    // detection while the magic button is ON.
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
      (v, degraded) => this.handleBrightnessUpdate(v, degraded),
    );
  }

  private handleBrightnessUpdate(v: unknown, degraded: boolean): void {
    if (degraded) {
      return;
    }
    const n = Number(v);
    if (!Number.isFinite(n)) {
      return;
    }
    const prev = this.targetBrightness;
    this.targetBrightness = n;

    if (!this.currentOn) {
      return;
    }

    // Pre-echo state: wait for our own write to settle before treating
    // brightness changes as manual. Receiving exactly our targetBrightness
    // is the echo signal; the fallback timer covers no-op-write bridges.
    if (!this.manualWatchEnabled) {
      if (n === this.config.targetBrightness) {
        this.cancelManualWatchFallback();
        this.manualWatchEnabled = true;
      }
      return;
    }

    // Manual-override detection: any value other than targetBrightness
    // while the watch is enabled is interpreted as the user taking control.
    if (n !== this.config.targetBrightness) {
      this.platform.log.info(
        `Magic button "${this.config.name}" detected manual brightness change (${prev} → ${n}); auto-OFF without restore`,
      );
      this.autoOffNoRestore();
    }
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
    // Arm the manual-watch fallback before issuing writes — covers the case
    // where the bridge silently swallows our write (already at target) and
    // never emits an echo we could latch onto.
    this.manualWatchEnabled = false;
    this.armManualWatchFallback();
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
    this.manualWatchEnabled = false;
    this.cancelManualWatchFallback();
    if (!this.snapshot) {
      this.platform.log.warn(
        `Magic button "${this.config.name}" deactivating with no snapshot — leaving target as-is (was Homebridge restarted while the magic button was ON, or did a manual override already clear the snapshot?)`,
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

  /**
   * Magic button gives up on the cycle: clear snapshot, flip HomeKit's
   * Switch to OFF (visible to the user), but do NOT write anything to the
   * target. The manual brightness setting stays exactly as the user set it.
   */
  private autoOffNoRestore(): void {
    this.snapshot = undefined;
    this.currentOn = false;
    this.manualWatchEnabled = false;
    this.cancelManualWatchFallback();
    this.service.updateCharacteristic(
      this.platform.Characteristic.On,
      false,
    );
  }

  private armManualWatchFallback(): void {
    this.cancelManualWatchFallback();
    this.manualWatchTimer = setTimeout(() => {
      this.manualWatchEnabled = true;
      this.manualWatchTimer = undefined;
    }, MagicButton.MANUAL_WATCH_FALLBACK_MS);
    this.manualWatchTimer.unref?.();
  }

  private cancelManualWatchFallback(): void {
    if (this.manualWatchTimer) {
      clearTimeout(this.manualWatchTimer);
      this.manualWatchTimer = undefined;
    }
  }

  stop(): void {
    this.cancelManualWatchFallback();
    // Subscription lifecycle is owned by the HapBridge; nothing else to release here.
  }
}
