import { PlatformAccessory, Service, CharacteristicValue, WithUUID, Characteristic } from "homebridge";
import * as fs from "node:fs";
import * as path from "node:path";
import { Ast, evaluate, evaluateAbstain, parseExpression, collectIdentifiers } from "../dsl/parser.js";
import { Source } from "../sources/source.js";
import { CompositeSensorPlatform } from "../platform.js";

interface PersistedSensorState {
  lastKnown: boolean;
  hasSeenAnyValue: boolean;
  currentValue: boolean;
  savedAt: string;
  /**
   * ISO 8601 deadline for a door-anchor pending check. Non-undefined only
   * when `mode === "door-anchor"` AND a door event has been seen but its
   * `+checkAfterMinutes` timeout hasn't fired yet. Restoring a value in
   * the past triggers an immediate check; in the future triggers a check
   * at the remaining delta. Without this, a homebridge restart between
   * door-event and check-firing silently drops the scheduled flip.
   */
  pendingDoorCheckAt?: string;
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
  /**
   * State machine mode. Default `"reactive"` matches every prior version
   * of this plugin: re-evaluate the expression on every source change,
   * apply onDegraded + holdSeconds + (optional) latchUntilEdgeOf, push
   * result through `updateCharacteristic`.
   *
   * `"door-anchor"` flips the model — state is sticky between explicit
   * door events. A `doorSource` change (any edge) schedules a single
   * check at `+checkAfterMinutes`; when that check fires, the expression
   * is evaluated once and the result is published. No holds, no decay,
   * no latch. Between door events, expression-source falls are ignored
   * by construction. mmWave silence during sleep / bathroom / motionless
   * reading is NOT proof of absence; we only ask the question "anyone
   * in any radar zone?" five minutes after a door crossing happened.
   *
   * `latchUntilEdgeOf`, `holdSeconds` are ignored in door-anchor mode.
   */
  mode?: "reactive" | "door-anchor";
  /** Required when mode === "door-anchor". Source name for the door contact. */
  doorSource?: string;
  /** Default 5. Only meaningful when mode === "door-anchor". */
  checkAfterMinutes?: number;
  /**
   * Default true. Only meaningful when mode === "door-anchor".
   * When true, expression-source rising edges flip false→true even
   * between door events ("auto-correct on presence" — rule 4 of the
   * design). Belt-and-suspenders for the case where one occupant
   * leaves while the remaining one is motionless: the +N check
   * correctly flipped to false, then the remaining occupant moves
   * and we re-detect them without needing another door crossing.
   */
  autoCorrectOnPresence?: boolean;
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
  private readonly mode: "reactive" | "door-anchor";
  private readonly doorSource?: Source;
  private readonly checkAfterMs: number;
  private readonly autoCorrectOnPresence: boolean;
  private pendingDoorCheckTimer?: NodeJS.Timeout;
  /** Epoch ms when the pending door-anchor check should fire. Persisted. */
  private pendingDoorCheckAt?: number;
  /** Separate listener for door source so we can detach independently. */
  private readonly doorChangeListener?: () => void;

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
    this.mode = config.mode ?? "reactive";
    this.checkAfterMs = Math.max(0, (config.checkAfterMinutes ?? 5) * 60_000);
    this.autoCorrectOnPresence = config.autoCorrectOnPresence ?? true;

    for (const ref of this.referencedSources) {
      if (!sources.has(ref)) {
        throw new Error(
          `Sensor "${config.name}" references unknown source "${ref}" in expression "${config.expression}"`,
        );
      }
    }

    if (config.latchUntilEdgeOf) {
      if (this.mode === "door-anchor") {
        throw new Error(
          `Sensor "${config.name}": latchUntilEdgeOf is incompatible with mode "door-anchor" — door-anchor IS the anchoring strategy, no latch overlay needed`,
        );
      }
      const src = sources.get(config.latchUntilEdgeOf);
      if (!src) {
        throw new Error(
          `Sensor "${config.name}" latchUntilEdgeOf references unknown source "${config.latchUntilEdgeOf}"`,
        );
      }
      this.latchSource = src;
    }

    if (this.mode === "door-anchor") {
      if (!config.doorSource) {
        throw new Error(`Sensor "${config.name}" mode "door-anchor" requires doorSource`);
      }
      const door = sources.get(config.doorSource);
      if (!door) {
        throw new Error(
          `Sensor "${config.name}" doorSource references unknown source "${config.doorSource}"`,
        );
      }
      this.doorSource = door;
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

    // Door-anchor cold-start default: home (true). Per the design doc:
    // "State defaults to `home`. Sticky between events. Persisted to disk."
    // On a fresh install with no persisted state, the user is presumed home
    // (otherwise they wouldn't be installing the plugin). Without this,
    // currentValue inherits the universal default of `false`, and the first
    // door-event check would have to flip the published value, firing a
    // spurious `away → home` transition that lands as a HomeKit rising-edge
    // event for any "home arrival" automation.
    if (this.mode === "door-anchor" && !this.hasSeenAnyValue) {
      this.currentValue = true;
      this.lastKnown = true;
      this.hasSeenAnyValue = true;
      this.service.updateCharacteristic(this.primaryCharacteristic, true);
      this.persistState();
    }

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

    // Door source: separate listener so its semantics (schedule a check)
    // stay distinct from expression-source semantics (recompute / auto-
    // correct). The door source is intentionally NOT in subscribeNames
    // because the expression must not reference it — door state itself
    // is not a presence signal in this design.
    if (this.doorSource) {
      this.doorChangeListener = () => this.onDoorChange();
      this.doorSource.on("change", this.doorChangeListener);
      this.subscribedSources.push(this.doorSource);
    }

    // Restore a pending door-anchor check left over from a previous run.
    // restorePersistedState() above set this.pendingDoorCheckAt from disk
    // if it was set; we only honor it when we're actually in door-anchor
    // mode (a config swap from door-anchor → reactive should drop stale
    // pending state silently rather than fire an obsolete check).
    if (this.mode === "door-anchor" && this.pendingDoorCheckAt !== undefined) {
      const remaining = this.pendingDoorCheckAt - Date.now();
      if (remaining <= 0) {
        // Past deadline — run immediately. Single-shot, then cleared.
        this.pendingDoorCheckAt = undefined;
        this.runDoorAnchorCheck();
      } else {
        this.pendingDoorCheckTimer = setTimeout(() => {
          this.pendingDoorCheckTimer = undefined;
          this.pendingDoorCheckAt = undefined;
          this.runDoorAnchorCheck();
        }, remaining);
      }
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
    if (typeof data.pendingDoorCheckAt === "string") {
      const t = Date.parse(data.pendingDoorCheckAt);
      if (!Number.isNaN(t)) {
        this.pendingDoorCheckAt = t;
      }
    }
    // Seed HAP cache so HomeKit's initial read returns the right value.
    // updateCharacteristic on a service whose accessory hasn't been
    // announced yet just sets the cached value — no notifications fire.
    this.service.updateCharacteristic(this.primaryCharacteristic, data.currentValue);
    const pendingMsg = this.pendingDoorCheckAt
      ? `, pendingDoorCheckAt=${new Date(this.pendingDoorCheckAt).toISOString()}`
      : "";
    this.platform.log.info(
      `Sensor "${this.config.name}" restored persisted state: lastKnown=${data.lastKnown}, currentValue=${data.currentValue}${pendingMsg} (saved ${data.savedAt})`,
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
      ...(this.pendingDoorCheckAt !== undefined
        ? { pendingDoorCheckAt: new Date(this.pendingDoorCheckAt).toISOString() }
        : {}),
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
      // Door source had a separate listener attached; detach it too.
      if (this.doorChangeListener && src === this.doorSource) {
        src.off("change", this.doorChangeListener);
      }
    }
    this.subscribedSources.length = 0;
    if (this.pendingFalseTimer) {
      clearTimeout(this.pendingFalseTimer);
      this.pendingFalseTimer = undefined;
    }
    if (this.pendingDoorCheckTimer) {
      clearTimeout(this.pendingDoorCheckTimer);
      this.pendingDoorCheckTimer = undefined;
    }
  }

  private recompute(): void {
    if (this.mode === "door-anchor") {
      this.recomputeDoorAnchor();
      return;
    }
    const result = this.evaluateOnce();
    this.applyWithHold(result);
  }

  /**
   * Evaluate the expression once with current source values, applying
   * onDegraded policy when any referenced source is unresolved.
   * Updates `lastKnown` + persists when the resolved value changed.
   * Used by both reactive and door-anchor modes.
   */
  private evaluateOnce(): boolean {
    const evaluated = this.evaluateExpressionThreeValued();
    if (evaluated === undefined) {
      return this.applyDegradedPolicy();
    }
    const lastKnownChanged = this.lastKnown !== evaluated || !this.hasSeenAnyValue;
    this.lastKnown = evaluated;
    this.hasSeenAnyValue = true;
    if (lastKnownChanged) {
      this.persistState();
    }
    return evaluated;
  }

  // A degraded source contributes `undefined`, not its stale last value.
  // Door-anchor mode uses `evaluateAbstain` so a determinate working branch
  // decides the result (degraded sibling abstains rather than poisons).
  // Reactive mode keeps strict Kleene logic — its onDegraded policy runs the
  // moment any operand is unknown, which is what historical configs expect.
  // Either way, applyDegradedPolicy() only fires when the result is genuinely
  // indeterminate (no working branch can decide).
  private evaluateExpressionThreeValued(): boolean | undefined {
    const values = new Map<string, boolean | undefined>();
    for (const ref of this.referencedSources) {
      const src = this.sources.get(ref)!;
      values.set(ref, src.degraded ? undefined : src.value);
    }
    return this.mode === "door-anchor"
      ? evaluateAbstain(this.ast, values)
      : evaluate(this.ast, values);
  }

  /**
   * Door-anchor mode recompute: called on every expression-source change.
   * The ONLY state transition allowed here is rule 4 (auto-correct on
   * presence): if state is currently false and an expression source
   * just made the result true, flip to true. All other transitions are
   * gated by `runDoorAnchorCheck()` which only fires after a door event.
   *
   * We still call evaluateOnce() so that lastKnown + persistence stay
   * up to date (used for the onDegraded:lastKnown policy across restarts).
   */
  private recomputeDoorAnchor(): void {
    const evaluated = this.evaluateOnce();
    if (this.autoCorrectOnPresence && !this.currentValue && evaluated === true) {
      this.setValue(true);
    }
  }

  /**
   * Door-anchor mode: door source emitted a change (open or close edge).
   * Cancel any pending check, schedule a fresh one at +checkAfterMs.
   * Persist the deadline so a homebridge restart in the gap re-honors it.
   */
  private onDoorChange(): void {
    if (this.mode !== "door-anchor") {
      return;
    }
    if (this.pendingDoorCheckTimer) {
      clearTimeout(this.pendingDoorCheckTimer);
      this.pendingDoorCheckTimer = undefined;
    }
    if (this.checkAfterMs === 0) {
      // Pathological config but treated as "check immediately".
      this.pendingDoorCheckAt = undefined;
      this.runDoorAnchorCheck();
      return;
    }
    this.pendingDoorCheckAt = Date.now() + this.checkAfterMs;
    this.persistState();
    this.platform.log.info(
      `Sensor "${this.config.name}" door event — scheduled check in ${this.checkAfterMs / 60_000}min`,
    );
    this.pendingDoorCheckTimer = setTimeout(() => {
      this.pendingDoorCheckTimer = undefined;
      this.pendingDoorCheckAt = undefined;
      this.runDoorAnchorCheck();
    }, this.checkAfterMs);
  }

  /**
   * Door-anchor scheduled check fires: evaluate the expression once and
   * publish the result directly. No applyWithHold (door-anchor doesn't
   * use holdSeconds — the door event IS the trigger, not a continuous
   * signal that needs deferring).
   */
  private runDoorAnchorCheck(): void {
    const evaluated = this.evaluateOnce();
    this.platform.log.info(
      `Sensor "${this.config.name}" door-anchor check fired — expression=${evaluated}`,
    );
    this.setValue(evaluated);
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
   * Hold + latch semantics: false→true fires instantly; true→false is
   * deferred by `max(holdSeconds, latchEdgeWindowSeconds)` ms and only fires
   * if the expression is still false at the end. A new `true` during the
   * defer (from ANY source change, including `latchUntilEdgeOf`) cancels
   * the pending false via the change-driven recompute path; a subsequent
   * fall back to false re-schedules a fresh defer, so motion edges
   * naturally extend the hold without any explicit latch-veto logic.
   *
   * Why this is simpler than the previous "latchPermitsFlip" gate: the old
   * design required `latchUntilEdgeOf` to have had a *recent* falling edge
   * before allowing any true→false flip. That's correct only if every exit
   * path passes the latch source — but if the user genuinely leaves quietly
   * (or the latch source's falling edge was ages ago), the sensor stays
   * `true` forever. Diagnosed 2026-04-30: Somebody-Home stuck `true` 7+
   * hours after the user left, because the Hue Livingroom motion sensor
   * (latchUntilEdgeOf) hadn't fallen within latchEdgeWindowSeconds=900,
   * so flips were permanently denied. Replaced with the simpler
   * deferred-flip-with-source-cancels approach above.
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

    // next === false: defer flip for max(hold, latch). Either yields the
    // same baseline behaviour (instant flip, no defer) when both are zero.
    const deferMs = Math.max(this.holdMs, this.latchSource ? this.latchWindowMs : 0);
    if (deferMs === 0) {
      this.setValue(false);
      return;
    }
    if (this.pendingFalseTimer) {
      return;
    }
    this.pendingFalseTimer = setTimeout(() => {
      this.pendingFalseTimer = undefined;
      const evaluated = this.evaluateExpressionThreeValued();
      const finalValue = evaluated === undefined ? this.applyDegradedPolicy() : evaluated;
      if (!finalValue) {
        this.setValue(false);
      }
    }, deferMs);
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
