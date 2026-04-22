import { PlatformAccessory, Service, CharacteristicValue, WithUUID, Characteristic } from "homebridge";
import { Ast, evaluate, parseExpression, collectIdentifiers } from "../dsl/parser.js";
import { Source } from "../sources/source.js";
import { CompositeSensorPlatform } from "../platform.js";

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

  /** The value currently reported to HomeKit. */
  private currentValue: boolean = false;
  /** Last known value when sources were not degraded — used by `lastKnown` policy. */
  private lastKnown: boolean = false;
  private hasSeenAnyValue = false;
  private pendingFalseTimer?: NodeJS.Timeout;
  private readonly changeListener: () => void;

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

    for (const ref of this.referencedSources) {
      if (!sources.has(ref)) {
        throw new Error(
          `Sensor "${config.name}" references unknown source "${ref}" in expression "${config.expression}"`,
        );
      }
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

    // Subscribe to source changes. Keep a reference so we can detach on stop().
    this.changeListener = () => this.recompute();
    for (const ref of this.referencedSources) {
      sources.get(ref)!.on("change", this.changeListener);
    }

    this.recompute();
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
    for (const ref of this.referencedSources) {
      this.sources.get(ref)?.off("change", this.changeListener);
    }
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
      this.lastKnown = evaluated;
      this.hasSeenAnyValue = true;
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
   * Hold semantics: false→true fires instantly; true→false is deferred for
   * `holdSeconds` and only fires if the expression is still false at the end.
   * A new `true` during the hold cancels the pending false.
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

    // next === false: defer if configured.
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
      if (!finalValue) {
        this.setValue(false);
      }
    }, this.holdMs);
  }

  private setValue(v: boolean): void {
    this.currentValue = v;
    this.service.updateCharacteristic(this.primaryCharacteristic, v);
    this.platform.log.debug(`Sensor "${this.config.name}" -> ${v}`);
  }
}
