import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { Source } from "../sources/source.js";
import { CompositeSensorPlatform } from "../platform.js";
import { Ast, collectIdentifiers, evaluate, parseExpression } from "../dsl/parser.js";

export interface RouterRoute {
  /** Expression over sources, same DSL as a sensor's `expression`. */
  when: string;
  /** Name of the target switch this route pulses. */
  target: string;
}

export interface RouterConfig {
  name: string;
  service: "router";
  /** Evaluated in order when the trigger switch is turned on; the first true one wins. */
  routes: RouterRoute[];
  /** How long the trigger and the chosen target stay on before resetting. Default 2. */
  pulseSeconds?: number;
}

/**
 * A HomeKit-side "if / else if" that runs in Homebridge instead of on the
 * Home hub. One accessory with a trigger Switch plus one Switch per distinct
 * route target. Turning the trigger on evaluates the routes against the live
 * source values, pulses the first matching target on, then resets both.
 * Simple HomeKit automations ("target turns on → set scene") do the rest.
 *
 * Exists because a Home-hub-executed shortcut that reads accessory state
 * ("Get Office Blinds Current Position") stopped executing on the hub in
 * October 2026 while the same shortcut ran fine on a Mac, and the hub gives
 * no diagnostics at all. Reading state here is observable and logged.
 */
export class Router {
  private readonly trigger: Service;
  private readonly targets = new Map<string, Service>();
  private readonly asts: Array<{ ast: Ast; target: string; when: string }> = [];
  private readonly refs = new Set<string>();
  private readonly pulseMs: number;
  private resetTimer?: NodeJS.Timeout;
  private triggerOn = false;
  private readonly targetOn = new Map<string, boolean>();

  constructor(
    private readonly platform: CompositeSensorPlatform,
    accessory: PlatformAccessory,
    private readonly config: RouterConfig,
    private readonly sources: Map<string, Source>,
  ) {
    if (!Array.isArray(config.routes) || config.routes.length === 0) {
      throw new Error(`Router "${config.name}" needs at least one route`);
    }
    this.pulseMs = Math.max(0.2, config.pulseSeconds ?? 2) * 1000;

    for (const r of config.routes) {
      const ast = parseExpression(r.when);
      for (const id of collectIdentifiers(ast)) {
        if (!sources.has(id)) {
          throw new Error(`Router "${config.name}" route "${r.target}" references unknown source "${id}"`);
        }
        this.refs.add(id);
      }
      this.asts.push({ ast, target: r.target, when: r.when });
    }

    accessory.getService(platform.Service.AccessoryInformation)
      ?.setCharacteristic(platform.Characteristic.Manufacturer, "homebridge-composite-sensor")
      .setCharacteristic(platform.Characteristic.Model, "router")
      .setCharacteristic(platform.Characteristic.SerialNumber, config.name);

    this.trigger = this.switchService(accessory, config.name, "trigger");
    this.trigger
      .getCharacteristic(platform.Characteristic.On)
      .onGet(() => this.triggerOn as CharacteristicValue)
      .onSet((v) => this.handleTrigger(Boolean(v)));

    const wanted = new Set(config.routes.map((r) => r.target));
    for (const target of wanted) {
      const svc = this.switchService(accessory, target, `target:${target}`);
      this.targetOn.set(target, false);
      svc.getCharacteristic(platform.Characteristic.On)
        .onGet(() => (this.targetOn.get(target) ?? false) as CharacteristicValue)
        // Read-mostly: HomeKit may write it (e.g. a scene); just reflect it.
        .onSet((v) => {
          this.targetOn.set(target, Boolean(v));
        });
      this.targets.set(target, svc);
    }
    // Drop switch services left over from removed routes.
    for (const svc of [...accessory.services]) {
      if (svc.UUID === platform.Service.Switch.UUID && svc.subtype?.startsWith("target:")
          && !wanted.has(svc.subtype.slice("target:".length))) {
        accessory.removeService(svc);
      }
    }
  }

  private switchService(accessory: PlatformAccessory, name: string, subtype: string): Service {
    const svc = accessory.getServiceById(this.platform.Service.Switch, subtype)
      ?? accessory.addService(this.platform.Service.Switch, name, subtype);
    svc.setCharacteristic(this.platform.Characteristic.Name, name);
    if (!svc.testCharacteristic(this.platform.Characteristic.ConfiguredName)) {
      svc.addCharacteristic(this.platform.Characteristic.ConfiguredName);
    }
    svc.setCharacteristic(this.platform.Characteristic.ConfiguredName, name);
    return svc;
  }

  private values(): Map<string, boolean | undefined> {
    const values = new Map<string, boolean | undefined>();
    for (const id of this.refs) {
      const src = this.sources.get(id)!;
      values.set(id, src.degraded ? undefined : src.value);
    }
    return values;
  }

  private handleTrigger(on: boolean): void {
    this.triggerOn = on;
    if (!on) {
      return;
    }
    const values = this.values();
    const shown = [...values].map(([k, v]) => `${k}=${v}`).join(" ");
    const hit = this.asts.find((r) => evaluate(r.ast, values) === true);
    if (!hit) {
      this.platform.log.info(`Router "${this.config.name}": no route matched (${shown})`);
    } else {
      this.platform.log.info(`Router "${this.config.name}": -> "${hit.target}" (when ${hit.when}; ${shown})`);
      this.targetOn.set(hit.target, true);
      this.targets.get(hit.target)!.updateCharacteristic(this.platform.Characteristic.On, true);
    }
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
    }
    this.resetTimer = setTimeout(() => this.reset(), this.pulseMs);
  }

  private reset(): void {
    this.resetTimer = undefined;
    this.triggerOn = false;
    this.trigger.updateCharacteristic(this.platform.Characteristic.On, false);
    for (const [target, svc] of this.targets) {
      if (this.targetOn.get(target)) {
        this.targetOn.set(target, false);
        svc.updateCharacteristic(this.platform.Characteristic.On, false);
      }
    }
  }

  stop(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
    }
  }
}
