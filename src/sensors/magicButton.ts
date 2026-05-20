import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { HapBridge } from "../sources/hapBridge.js";
import { CompositeSensorPlatform } from "../platform.js";

type CharValue = boolean | number | string;

/**
 * Config shape for a magic-button accessory.
 *
 * Exposes a HomeKit Switch that, on activation, snapshots the target
 * accessory's current values for a set of characteristics and writes the
 * configured target values. On deactivation, the snapshot is restored
 * verbatim.
 *
 * Two equivalent ways to specify what to write:
 *
 *  1. `targetBrightness: N` (legacy shortcut) — equivalent to
 *     `target: { On: true, Brightness: N }`. Kept for backward-compat with
 *     0.10.x configs.
 *
 *  2. `target: { On: true, Brightness: 100, Hue: 0, Saturation: 100 }` —
 *     arbitrary HAP characteristic names → values. All listed characteristics
 *     are snapshotted on activation and restored on deactivation. Use this
 *     for color lamps (Hue, Saturation, ColorTemperature, ...).
 *
 * Exactly one of `targetBrightness` and `target` must be set.
 *
 * If the user (or any other actor) manually changes the target's brightness
 * between activation and deactivation, the magic button interprets that as
 * "the user has taken control" — it auto-OFFs in HomeKit and leaves the
 * manual setting in place rather than restoring the snapshot. Manual-override
 * detection is brightness-only; manual hue/saturation changes mid-cycle
 * don't trigger auto-off (use case: color tuning while a scene is held).
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
  /**
   * Legacy single-characteristic shortcut — sugar for
   * `target: { On: true, Brightness: N }`. 0-100 HomeKit scale.
   */
  targetBrightness?: number;
  /**
   * General target: HAP characteristic name → value, all snapshotted on
   * activation and restored on deactivation. Mutually exclusive with
   * `targetBrightness`.
   */
  target?: Record<string, CharValue>;
  /**
   * When true, the button ignores manual state changes on the target light
   * while ON — it stays active until the user explicitly OFFs the switch,
   * and then restores the snapshot taken at activation. Default false
   * (= auto-OFF on manual brightness change, today's behavior).
   *
   * Use this when you want the magic button to "hold" a scene against
   * incidental brightness drift (Hue scene picker re-emits values, dimmer
   * tap, etc.). The snapshot itself is one-shot regardless of sticky —
   * sticky only controls whether the auto-OFF heuristic runs.
   */
  sticky?: boolean;
}

interface Snapshot {
  values: Record<string, CharValue>;
}

/**
 * "Magic button" — a HomeKit Switch that boosts a target accessory to a
 * preset state while ON and restores the prior state on a normal OFF.
 *
 * Generalized in 0.10.3 from brightness-only to arbitrary characteristic
 * set, so the same machinery handles "boost to 100% brightness" and "set
 * to green at full saturation" with one config form.
 *
 * Manual-override semantics: if Brightness is one of the target keys AND
 * the lamp's brightness changes to anything OTHER than our written value
 * while the magic button is ON, that's treated as a manual intervention →
 * auto-OFF the switch in HomeKit, leave the lamp alone. Other
 * characteristics (Hue, Saturation, ColorTemperature, ...) don't trigger
 * auto-off because color tweaks during a held scene are normal.
 *
 * Pre-echo state: from activation until we observe our own brightness echo
 * (or a 3s fallback timer fires), brightness changes are ignored — prevents
 * a watchdog-refresh-of-stale-value race from immediately auto-OFFing the
 * button we just turned on.
 *
 * See feedback_homebridge.md §D1 for the short-circuit-no-change rule
 * applied in handleOn().
 */
export class MagicButton {
  private readonly service: Service;
  private readonly bridge: HapBridge;
  private readonly target: Record<string, CharValue>;
  private currentOn = false;
  /** Latest known value per target characteristic — populated by bridge subscribes. */
  private readonly lastKnown: Record<string, CharValue | undefined> = {};
  /** In-memory snapshot taken on activation; cleared on deactivation. */
  private snapshot?: Snapshot;
  /** Serializes ON/OFF transitions so rapid toggles don't interleave. */
  private writeInFlight = false;
  /** Gate for treating brightness changes as manual interventions. */
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

    this.target = this.resolveTarget(config);

    // Subscribe to every characteristic we'll snapshot+write, so we always
    // have a current value cached when the user toggles the switch.
    for (const char of Object.keys(this.target)) {
      bridge.subscribe(
        { accessory: config.accessory, characteristic: char },
        (v, degraded) => this.handleSourceUpdate(char, v, degraded),
      );
    }
  }

  /**
   * Normalize the config's `target` / `targetBrightness` fields into the
   * unified `Record<string, CharValue>` form used everywhere downstream.
   * Validates here so config errors surface at platform bootstrap, not later
   * when the user presses the switch.
   */
  private resolveTarget(config: MagicButtonConfig): Record<string, CharValue> {
    const hasTarget = config.target !== undefined && config.target !== null;
    const hasShortcut = config.targetBrightness !== undefined;
    if (hasTarget && hasShortcut) {
      throw new Error(
        `Magic button "${config.name}": set either \`target\` or \`targetBrightness\`, not both`,
      );
    }
    if (hasTarget) {
      const t = config.target as Record<string, CharValue>;
      if (typeof t !== "object" || Array.isArray(t) || Object.keys(t).length === 0) {
        throw new Error(
          `Magic button "${config.name}" \`target\` must be a non-empty object of {Characteristic: value} pairs`,
        );
      }
      return { ...t };
    }
    if (hasShortcut) {
      const n = config.targetBrightness as number;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 100) {
        throw new Error(
          `Magic button "${config.name}" requires targetBrightness in [0,100], got ${JSON.stringify(n)}`,
        );
      }
      return { On: true, Brightness: n };
    }
    throw new Error(
      `Magic button "${config.name}" requires either \`targetBrightness\` or \`target\``,
    );
  }

  private handleSourceUpdate(char: string, v: unknown, degraded: boolean): void {
    if (degraded) {
      return;
    }
    // Cache the latest value so the next activation snapshot has it.
    this.lastKnown[char] = v as CharValue;
    // Brightness specifically drives manual-override detection.
    if (char === "Brightness") {
      this.handleBrightnessUpdate(v);
    }
  }

  private handleBrightnessUpdate(v: unknown): void {
    if (!("Brightness" in this.target)) {
      return;
    }
    // Sticky mode: never auto-OFF on manual brightness change.
    if (this.config.sticky === true) {
      return;
    }
    const n = Number(v);
    if (!Number.isFinite(n)) {
      return;
    }

    if (!this.currentOn) {
      return;
    }

    const targetBrightness = this.target.Brightness as number;

    // Pre-echo state: wait for our own write to settle before treating
    // brightness changes as manual. Receiving exactly our target brightness
    // is the echo signal; the fallback timer covers no-op-write bridges.
    if (!this.manualWatchEnabled) {
      if (n === targetBrightness) {
        this.cancelManualWatchFallback();
        this.manualWatchEnabled = true;
      }
      return;
    }

    // Manual-override detection: any value other than our target brightness
    // while the watch is enabled is interpreted as the user taking control.
    if (n !== targetBrightness) {
      this.platform.log.info(
        `Magic button "${this.config.name}" detected manual brightness change `
          + `(→ ${n}); auto-OFF without restore`,
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
    const missing = Object.keys(this.target).filter(
      (k) => this.lastKnown[k] === undefined,
    );
    if (missing.length > 0) {
      throw new Error(
        `Magic button "${this.config.name}": target characteristic(s) `
          + `${missing.join(", ")} not yet known — bridge subscribe still degraded?`,
      );
    }
    // Snapshot only the keys we'll write, so deactivate's restore is
    // perfectly symmetric.
    const snap: Record<string, CharValue> = {};
    for (const k of Object.keys(this.target)) {
      snap[k] = this.lastKnown[k] as CharValue;
    }
    this.snapshot = { values: snap };
    this.platform.log.info(
      `Magic button "${this.config.name}" activate: `
        + `snapshot=${JSON.stringify(snap)} → target=${JSON.stringify(this.target)}`,
    );
    // Arm the manual-watch fallback before issuing writes — covers the case
    // where the bridge silently swallows our brightness write (already at
    // target) and never emits an echo we could latch onto. Skip entirely
    // in sticky mode: the watch never fires anyway, no point burning a timer.
    this.manualWatchEnabled = false;
    if (this.config.sticky !== true) {
      this.armManualWatchFallback();
    }

    // Write On first (if present) so subsequent characteristic writes are
    // accepted by bridges that no-op when On is false (e.g., Loxone via
    // homebridge-loxone-control treats Brightness on an off lamp as a memory
    // of brightness, not a "turn on at N").
    if ("On" in this.target) {
      await this.bridge.write(
        { accessory: this.config.accessory, characteristic: "On" },
        this.target.On,
      );
    }
    for (const [char, value] of Object.entries(this.target)) {
      if (char === "On") {
        continue;
      }
      await this.bridge.write(
        { accessory: this.config.accessory, characteristic: char },
        value,
      );
    }
  }

  private async deactivate(): Promise<void> {
    this.manualWatchEnabled = false;
    this.cancelManualWatchFallback();
    if (!this.snapshot) {
      this.platform.log.warn(
        `Magic button "${this.config.name}" deactivating with no snapshot `
          + "— leaving target as-is (was Homebridge restarted while the "
          + "magic button was ON, or did a manual override already clear "
          + "the snapshot?)",
      );
      return;
    }
    const snap = this.snapshot.values;
    this.snapshot = undefined;
    this.platform.log.info(
      `Magic button "${this.config.name}" deactivate: restore ${JSON.stringify(snap)}`,
    );

    // Write non-On chars first so when On goes false (last) the target's
    // "remembered" state is the original brightness/hue/etc., not our boost.
    for (const [char, value] of Object.entries(snap)) {
      if (char === "On") {
        continue;
      }
      await this.bridge.write(
        { accessory: this.config.accessory, characteristic: char },
        value,
      );
    }
    if ("On" in snap) {
      await this.bridge.write(
        { accessory: this.config.accessory, characteristic: "On" },
        snap.On,
      );
    }
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
