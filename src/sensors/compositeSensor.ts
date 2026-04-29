import { PlatformAccessory, Service, CharacteristicValue, WithUUID, Characteristic } from "homebridge";
import * as fs from "node:fs";
import * as path from "node:path";
import { Ast, evaluate, parseExpression, collectIdentifiers } from "../dsl/parser.js";
import { Source } from "../sources/source.js";
import { CompositeSensorPlatform } from "../platform.js";

interface PersistedSensorState {
  lastKnown: boolean;
  hasSeenAnyValue: boolean;
  currentValue: boolean;
  savedAt: string;
}

type CharacteristicCtor = WithUUID<new () => Characteristic>;

export type SensorServiceKind = "motion" | "occupancy" | "contact";

export type OnDegradedPolicy = "false" | "true" | "lastKnown";

export interface CompositeSensorConfig {
  name: string;
  service: SensorServiceKind;
  expression: string;
  /** Seconds to wait on true→false before emitting false. Default 0 (no hold). */
  holdSeconds?: number;
  /** What to emit when any referenced source is degraded. Default "false". */
  onDegraded?: OnDegradedPolicy;
  /**
   * Latch-until-exit semantics.
   *
   * When set, the sensor will NOT flip from true to false unless the named
   * source has had a true→false transition (a "falling edge") within the
   * last `latchEdgeWindowSeconds` seconds. Useful for "somebody home"
   * sensors where presence is OR'd across multiple detectors (FP2 zones,
   * etc.) plus a door PIR — you want the sensor to stay `true` during
   * periods of stillness (e.g. sleeping in a blind spot) and only release
   * when the occupant has walked past the door PIR *and* all presence then
   * clears.
   *
   * If the window has expired or the edge has never fired, the sensor
   * stays latched `true` (no matter how long the expression has been
   * `false`) until any presence signal returns — at which point the
   * cycle resets.
   *
   * Combines with `holdSeconds`: after the edge requirement is satisfied,
   * the normal hold-then-flip flow applies.
   */
  latchUntilEdgeOf?: string;
  /** Default 300 (5 min). Only meaningful when `latchUntilEdgeOf` is set. */
  latchEdgeWindowSeconds?: number;
}

/**
 * One composite sensor = one Homebridge accessory exposing one of the
 * supported sensor services (motion/occupancy/contact).
 *
 * Re-evaluates its expression whenever any referenced source fires `change`,
 * applies onDegraded + holdSeconds, and pushes the final value through
 * `updateCharacteristic` on the Home app.
 */
export class CompositeSensor {
  private readonly ast: Ast;
  private readonly referencedSources: string[];
  private readonly service: Service;
  private readonly primaryCharacteristic: CharacteristicCtor;
  private readonly holdMs: number;
  private readonly onDegraded: OnDegradedPolicy;
  private readonly latchSource?: Source;
  private readonly latchWindowMs: number;

  /** The value currently reported to HomeKit. */
  private currentValue: boolean = false;
  /** Last known value when sources were not degraded — used by `lastKnown` policy. */
  private lastKnown: boolean = false;
  private hasSeenAnyValue = false;
  private pendingFalseTimer?: NodeJS.Timeout;
  private readonly changeListener: () => void;
  /** Sources we subscribed to change events on (expression refs + optional latch source). */
  private readonly subscribedSources: Source[] = [];

  /**
   * Absolute path to the JSON file holding this sensor's persisted state, or
   * undefined if persistence is unavailable (no homebridge api in tests, or
   * persistPath() not writable). When defined, lastKnown / hasSeenAnyValue /
   * currentValue survive container restarts — without this, every restart
   * makes the sensor publish `false` first and then jump to `true` once
   * sources resolve, firing automations on rising-edge triggers ("welcome
   * scene fires every time homebridge restarts" bug).
   */
  private readonly persistFilePath?: string;

  constructor(
    private readonly platform: CompositeSensorPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly config: CompositeSensorConfig,
    private readonly sources: Map<string, Source>,
  ) {
    this.ast = parseExpression(config.expression);
    this.referencedSources = collectIdentifiers(this.ast);
    this.holdMs = Math.max(0, (config.holdSeconds ?? 0) * 1000);
    this.onDegraded = config.onDegraded ?? "false";
    this.latchWindowMs = Math.max(0, (config.latchEdgeWindowSeconds ?? 300) * 1000);

    for (const ref of this.referencedSources) {
      if (!sources.has(ref)) {
        throw new Error(
          `Sensor "${config.name}" references unknown source "${ref}" in expression "${config.expression}"`,
        );
      }
    }

    if (config.latchUntilEdgeOf) {
      const src = sources.get(config.latchUntilEdgeOf);
      if (!src) {
        throw new Error(
          `Sensor "${config.name}" latchUntilEdgeOf references unknown source "${config.latchUntilEdgeOf}"`,
        );
      }
      this.latchSource = src;
    }

    const info = accessory.getService(platform.Service.AccessoryInformation);
    info
      ?.setCharacteristic(platform.Characteristic.Manufacturer, "homebridge-composite-sensor")
      .setCharacteristic(platform.Characteristic.Model, config.service)
      .setCharacteristic(platform.Characteristic.SerialNumber, config.name);

    const { service, characteristic } = this.createService();
    this.service = service;
    this.primaryCharacteristic = characteristic;
    this.service.setCharacteristic(platform.Characteristic.Name, config.name);
    this.service
      .getCharacteristic(characteristic)
      .onGet(() => this.currentValue as CharacteristicValue);

    // Resolve the persistence path. Skipped in unit tests where `platform.api`
    // is not a real homebridge API (the test harness stubs platform with just
    // log + Service + Characteristic).
    this.persistFilePath = this.resolvePersistFilePath();
    this.restorePersistedState();

    // Subscribe to source changes. Keep references so we can detach on stop().
    // Includes the latch source even if it's not in the expression — the
    // sensor must re-evaluate when its falling edge happens so a stuck
    // latch can release at the right moment.
    this.changeListener = () => this.recompute();
    const subscribeNames = new Set<string>(this.referencedSources);
    if (config.latchUntilEdgeOf) {
      subscribeNames.add(config.latchUntilEdgeOf);
    }
    for (const name of subscribeNames) {
      const src = sources.get(name)!;
      src.on("change", this.changeListener);
      this.subscribedSources.push(src);
    }

    this.recompute();
  }

  /**
   * Build `<homebridge-persist>/composite-sensor-<slug>.json`. Returns
   * undefined if the homebridge `api.user.persistPath()` accessor isn't
   * available (e.g. unit tests with a stub platform).
   */
  private resolvePersistFilePath(): string | undefined {
    const api: unknown = (this.platform as unknown as { api?: unknown }).api;
    const persistPath = (api as { user?: { persistPath?: () => string } } | undefined)
      ?.user?.persistPath?.();
    if (typeof persistPath !== "string" || persistPath.length === 0) {
      return undefined;
    }
    const slug = this.config.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      || "unnamed";
    return path.join(persistPath, `composite-sensor-${slug}.json`);
  }

  /**
   * Restore lastKnown / hasSeenAnyValue / currentValue from disk if a
   * previous run left a state file. Crucially also seeds the HAP
   * characteristic cache via updateCharacteristic so HomeKit's first read
   * after the accessory is announced returns the persisted value, NOT the
   * default `false`. Without this seeding, the very first source-resolved
   * recompute() emits a false→true transition that fires every "welcome
   * scene" automation each time the homebridge container restarts.
   */
  private restorePersistedState(): void {
    if (!this.persistFilePath) {
      return;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(this.persistFilePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.platform.log.warn(
          `Sensor "${this.config.name}" failed to read persisted state from ${this.persistFilePath}: ${(err as Error).message}`,
        );
      }
      return;
    }
    let data: PersistedSensorState;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      this.platform.log.warn(
        `Sensor "${this.config.name}" persisted state at ${this.persistFilePath} is not valid JSON; ignoring: ${(err as Error).message}`,
      );
      return;
    }
    if (
      typeof data.lastKnown !== "boolean"
      || typeof data.hasSeenAnyValue !== "boolean"
      || typeof data.currentValue !== "boolean"
    ) {
      this.platform.log.warn(
        `Sensor "${this.config.name}" persisted state at ${this.persistFilePath} is missing required fields; ignoring`,
      );
      return;
    }
    this.lastKnown = data.lastKnown;
    this.hasSeenAnyValue = data.hasSeenAnyValue;
    this.currentValue = data.currentValue;
    // Seed HAP cache so HomeKit's initial read returns the right value.
    // updateCharacteristic on a service whose accessory hasn't been
    // announced yet just sets the cached value — no notifications fire.
    this.service.updateCharacteristic(this.primaryCharacteristic, data.currentValue);
    this.platform.log.info(
      `Sensor "${this.config.name}" restored persisted state: lastKnown=${data.lastKnown}, currentValue=${data.currentValue} (saved ${data.savedAt})`,
    );
  }

  /**
   * Atomically write current state to disk. Caller must only invoke this when
   * something *changed* — we don't dedupe writes here. Best-effort: errors
   * are logged but never thrown, so a flaky filesystem can't break the
   * sensor's runtime evaluation.
   */
  private persistState(): void {
    if (!this.persistFilePath) {
      return;
    }
    const tmpPath = `${this.persistFilePath}.tmp`;
    const payload: PersistedSensorState = {
      lastKnown: this.lastKnown,
      hasSeenAnyValue: this.hasSeenAnyValue,
      currentValue: this.currentValue,
      savedAt: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(payload));
      fs.renameSync(tmpPath, this.persistFilePath);
    } catch (err) {
      this.platform.log.warn(
        `Sensor "${this.config.name}" failed to persist state to ${this.persistFilePath}: ${(err as Error).message}`,
      );
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Ignore — tmp may not exist.
      }
    }
  }

  /**
   * Instantiate the right service type and return it along with its primary
   * boolean characteristic.
   */
  private createService(): { service: Service; characteristic: CharacteristicCtor } {
    const kind = this.config.service;
    const { Service, Characteristic } = this.platform;
    if (kind === "motion") {
      const svc = this.accessory.getService(Service.MotionSensor)
        ?? this.accessory.addService(Service.MotionSensor);
      return { service: svc, characteristic: Characteristic.MotionDetected };
    }
    if (kind === "occupancy") {
      const svc = this.accessory.getService(Service.OccupancySensor)
        ?? this.accessory.addService(Service.OccupancySensor);
      // OccupancyDetected uses 0/1 values but exposes as boolean through updateCharacteristic.
      return { service: svc, characteristic: Characteristic.OccupancyDetected };
    }
    if (kind === "contact") {
      const svc = this.accessory.getService(Service.ContactSensor)
        ?? this.accessory.addService(Service.ContactSensor);
      return { service: svc, characteristic: Characteristic.ContactSensorState };
    }
    throw new Error(`Unsupported sensor service kind "${kind}" for sensor "${this.config.name}"`);
  }

  stop(): void {
    for (const src of this.subscribedSources) {
      src.off("change", this.changeListener);
    }
    this.subscribedSources.length = 0;
    if (this.pendingFalseTimer) {
      clearTimeout(this.pendingFalseTimer);
      this.pendingFalseTimer = undefined;
    }
  }

  private recompute(): void {
    const values = new Map<string, boolean | undefined>();
    let anyDegraded = false;
    for (const ref of this.referencedSources) {
      const src = this.sources.get(ref)!;
      if (src.degraded) {
        anyDegraded = true;
      }
      values.set(ref, src.value);
    }

    let result: boolean;
    const evaluated = evaluate(this.ast, values);
    if (anyDegraded || evaluated === undefined) {
      result = this.applyDegradedPolicy();
    } else {
      result = evaluated;
      const lastKnownChanged = this.lastKnown !== evaluated || !this.hasSeenAnyValue;
      this.lastKnown = evaluated;
      this.hasSeenAnyValue = true;
      if (lastKnownChanged) {
        this.persistState();
      }
    }

    this.applyWithHold(result);
  }

  private applyDegradedPolicy(): boolean {
    switch (this.onDegraded) {
      case "true": return true;
      case "lastKnown": return this.hasSeenAnyValue ? this.lastKnown : false;
      case "false":
      default: return false;
    }
  }

  /**
   * Return true if the latch condition permits a true→false flip right now.
   * Semantics: a flip is only allowed if the latch source has had a falling
   * edge within the configured window. If no latch source is configured,
   * always permits. Called twice — at the moment applyWithHold receives a
   * false and again at the end of the holdSeconds timer — so a latch-expiry
   * during the hold window correctly stops the flip.
   */
  private latchPermitsFlip(): boolean {
    if (!this.latchSource) {
      return true;
    }
    const edge = this.latchSource.lastFallingEdgeAt;
    if (edge === undefined) {
      return false;
    }
    return Date.now() - edge <= this.latchWindowMs;
  }

  /**
   * Hold semantics: false→true fires instantly; true→false is deferred for
   * `holdSeconds` and only fires if the expression is still false at the end.
   * A new `true` during the hold cancels the pending false.
   *
   * Latch semantics (when `latchUntilEdgeOf` is configured): a true→false
   * flip is additionally gated on the latch source having had a recent
   * falling edge. Without that, the sensor stays `true` indefinitely —
   * suitable for "somebody home" where absence of presence ≠ absence
   * from home (bedroom stillness, etc.).
   */
  private applyWithHold(next: boolean): void {
    if (next === this.currentValue) {
      // Already in the target state; cancel any pending transition that would flip away.
      if (next && this.pendingFalseTimer) {
        clearTimeout(this.pendingFalseTimer);
        this.pendingFalseTimer = undefined;
      }
      return;
    }

    if (next === true) {
      if (this.pendingFalseTimer) {
        clearTimeout(this.pendingFalseTimer);
        this.pendingFalseTimer = undefined;
      }
      this.setValue(true);
      return;
    }

    // next === false: latch veto takes priority over hold defer.
    if (!this.latchPermitsFlip()) {
      if (this.pendingFalseTimer) {
        clearTimeout(this.pendingFalseTimer);
        this.pendingFalseTimer = undefined;
      }
      return;
    }

    // defer if configured.
    if (this.holdMs === 0) {
      this.setValue(false);
      return;
    }
    if (this.pendingFalseTimer) {
      return;
    }
    this.pendingFalseTimer = setTimeout(() => {
      this.pendingFalseTimer = undefined;
      // Re-check in case sources flipped back to true during the hold.
      const values = new Map<string, boolean | undefined>();
      let anyDegraded = false;
      for (const ref of this.referencedSources) {
        const src = this.sources.get(ref)!;
        if (src.degraded) {
          anyDegraded = true;
        }
        values.set(ref, src.value);
      }
      const evaluated = evaluate(this.ast, values);
      const finalValue = (anyDegraded || evaluated === undefined)
        ? this.applyDegradedPolicy()
        : evaluated;
      if (!finalValue && this.latchPermitsFlip()) {
        this.setValue(false);
      }
    }, this.holdMs);
  }

  private setValue(v: boolean): void {
    this.currentValue = v;
    this.service.updateCharacteristic(this.primaryCharacteristic, v);
    this.platform.log.info(`Sensor "${this.config.name}" -> ${v}`);
    // Persist on every published edge so a restart between (a) the source
    // flipping and (b) the sensor's stable post-hold value is captured.
    this.persistState();
  }
}
