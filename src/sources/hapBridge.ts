import { Logger } from "homebridge";
import { HapClient } from "@oznu/hap-client";
import type { HapMonitor } from "@oznu/hap-client/dist/monitor.js";
import { EventEmitter } from "events";

export interface HapBridgeConfig {
  /** Logical name used by sources via the `bridge` field. */
  name: string;
  /** Expected port of the target Homebridge instance (used to filter mDNS). */
  port: number;
  /** Pairing PIN — format `xxx-xx-xxx`. */
  pin: string;
  /** Optional host — only used as a sanity check against discovered instances. */
  host?: string;
}

/**
 * Minimal shape of the services the hap-client emits on `service-update`
 * and returns from `getAccessories()`. Typed permissively since the upstream
 * types are broad.
 */
export interface HapService {
  aid: number;
  iid: number;
  uuid: string;
  type: string;
  humanType?: string;
  serviceName?: string;
  instance?: { port?: number; host?: string; username?: string; name?: string };
  serviceCharacteristics: Array<{
    aid: number;
    iid: number;
    type: string;
    value: unknown;
    description?: string;
  }>;
}

type CharacteristicMatcher = {
  /** Accessory identifier — human name (matched against `serviceName`) or explicit AID. */
  accessory: string | number;
  /** Characteristic identifier — HAP type name (e.g. `On`, `MotionDetected`), or explicit IID. */
  characteristic: string | number;
};

type Listener = (value: unknown, degraded: boolean) => void;

/**
 * HAP characteristic types are usually UUIDs (e.g. "25" or "00000025-0000-1000-8000-0026BB765291");
 * we match either by raw type string or by well-known short names like "On", "MotionDetected".
 */
const SHORT_NAMES: Record<string, string> = {
  On: "25",
  MotionDetected: "22",
  OccupancyDetected: "71",
  ContactSensorState: "6A",
};

function matchesCharacteristicName(type: string, name: string | number): boolean {
  if (typeof name === "number") {
    return false;
  }
  const short = SHORT_NAMES[name];
  if (!short) {
    return false;
  }
  return type.toUpperCase() === short || type.toUpperCase().startsWith(`000000${short}-`);
}

/**
 * Wraps one `@oznu/hap-client` instance targeted at a single Homebridge
 * bridge / child bridge.
 *
 *  - Discovery is mDNS-based; we filter to the instance that matches the
 *    configured `port` (and optionally warn if `host` disagrees).
 *  - On first successful discovery we log a snapshot of all accessories
 *    with their AID/IID so users can switch from name- to ID-based
 *    targeting after renaming in the Home app.
 *  - Characteristic subscriptions are registered eagerly via
 *    `subscribe(matcher, listener)` and are resolved to concrete
 *    `{aid, iid}` pairs once discovery completes.
 */
export class HapBridge extends EventEmitter {
  private client?: HapClient;
  private monitor?: HapMonitor;
  private services: HapService[] = [];
  private discovered = false;
  private snapshotLogged = false;
  private stopped = false;

  private readonly pendingSubscribers: Array<{
    matcher: CharacteristicMatcher;
    listener: Listener;
  }> = [];

  /** Resolved {aid, iid} → listeners. Populated on discovery. */
  private readonly resolved = new Map<string, Listener[]>();

  constructor(
    public readonly config: HapBridgeConfig,
    private readonly log: Logger,
  ) {
    super();
  }

  start(): void {
    if (this.client || this.stopped) {
      return;
    }
    this.log.info(
      `HAP bridge "${this.config.name}" starting discovery for port ${this.config.port}`,
    );

    const client = new HapClient({
      pin: this.config.pin,
      logger: {
        info: (...a: unknown[]) => this.log.debug(`[hap:${this.config.name}]`, ...a),
        warn: (...a: unknown[]) => this.log.warn(`[hap:${this.config.name}]`, ...a),
        error: (...a: unknown[]) => this.log.error(`[hap:${this.config.name}]`, ...a),
        debug: (...a: unknown[]) => this.log.debug(`[hap:${this.config.name}]`, ...a),
      },
      config: { debug: false },
    });
    this.client = client;

    client.on("instance-discovered", (instance: { port?: number; ipAddress?: string | null; name?: string }) => {
      if (instance.port !== this.config.port) {
        return;
      }
      if (this.config.host && instance.ipAddress && instance.ipAddress !== this.config.host) {
        this.log.warn(
          `HAP bridge "${this.config.name}" discovered at ${instance.ipAddress}:${instance.port} ` +
            `but config.host is ${this.config.host} — using discovered host`,
        );
      }
      this.log.info(
        `HAP bridge "${this.config.name}" discovered at ${instance.ipAddress}:${instance.port}`,
      );
    });

    // Startup is non-blocking: discovery + initial fetch happen in the background
    // so Homebridge startup is never held up.
    void this.bootstrap();
  }

  stop(): void {
    this.stopped = true;
    try {
      this.monitor?.finish();
    } catch (err) {
      this.log.debug(`HAP bridge "${this.config.name}" monitor.finish() threw:`, (err as Error).message);
    }
    this.monitor = undefined;
    this.client?.resetInstancePool();
    this.client = undefined;
  }

  subscribe(matcher: CharacteristicMatcher, listener: Listener): void {
    this.pendingSubscribers.push({ matcher, listener });
    if (this.discovered) {
      this.resolveAndBind({ matcher, listener });
    }
  }

  private async bootstrap(): Promise<void> {
    try {
      // Discovery may take a moment; give it a beat before the first fetch.
      await this.waitForInstance(30_000);
      await this.refreshAccessories();
    } catch (err) {
      this.log.warn(
        `HAP bridge "${this.config.name}" initial bootstrap failed:`,
        (err as Error).message,
      );
      this.markAllDegraded();
    }
  }

  private waitForInstance(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client) {
        reject(new Error("client destroyed"));
        return;
      }
      const client = this.client;
      const expectedPort = this.config.port;
      const state: { done: boolean; timer?: NodeJS.Timeout } = { done: false };
      const onDiscovered = (instance: { port?: number }) => {
        if (state.done || instance.port !== expectedPort) {
          return;
        }
        state.done = true;
        if (state.timer) {
          clearTimeout(state.timer);
        }
        client.removeListener("instance-discovered", onDiscovered);
        resolve();
      };
      client.on("instance-discovered", onDiscovered);
      state.timer = setTimeout(() => {
        if (state.done) {
          return;
        }
        state.done = true;
        client.removeListener("instance-discovered", onDiscovered);
        reject(new Error(`no HAP instance on port ${expectedPort} within ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  private async refreshAccessories(): Promise<void> {
    const client = this.client;
    if (!client) {
      return;
    }
    const services = (await client.getAllServices()) as unknown as HapService[];
    this.onServices(services);
    // Start monitoring after we have the service catalog. `service-update`
    // events are emitted by the monitor — not the client.
    if (!this.monitor) {
      this.monitor = await client.monitorCharacteristics();
      this.monitor.on("service-update", (updated: unknown) => {
        this.onServices(updated as HapService[]);
      });
    }
  }

  private onServices(services: HapService[]): void {
    this.services = services;
    this.discovered = true;

    if (!this.snapshotLogged) {
      this.logSnapshot(services);
      this.snapshotLogged = true;
    }

    // Resolve any pending subscribers that couldn't bind before discovery.
    const pending = [...this.pendingSubscribers];
    this.pendingSubscribers.length = 0;
    for (const p of pending) {
      this.resolveAndBind(p);
    }

    // Fan out current values to all resolved listeners.
    for (const svc of services) {
      for (const ch of svc.serviceCharacteristics) {
        this.dispatch(svc.aid, ch.iid, ch.value, false);
      }
    }
  }

  private logSnapshot(services: HapService[]): void {
    const byAcc = new Map<number, HapService[]>();
    for (const svc of services) {
      const bucket = byAcc.get(svc.aid) ?? [];
      bucket.push(svc);
      byAcc.set(svc.aid, bucket);
    }
    this.log.info(
      `HAP bridge "${this.config.name}" discovered ${services.length} services ` +
        `across ${byAcc.size} accessories:`,
    );
    for (const [aid, svcs] of byAcc) {
      const displayName = svcs[0]?.serviceName ?? "<unknown>";
      this.log.info(`  aid=${aid} "${displayName}"`);
      for (const svc of svcs) {
        for (const ch of svc.serviceCharacteristics) {
          this.log.info(
            `    iid=${ch.iid} ${ch.description ?? ch.type} = ${JSON.stringify(ch.value)}`,
          );
        }
      }
    }
  }

  private resolveAndBind(entry: { matcher: CharacteristicMatcher; listener: Listener }): void {
    const { matcher, listener } = entry;
    const accIdent = matcher.accessory;
    const chIdent = matcher.characteristic;

    const matches = this.services.filter((svc) => {
      if (typeof accIdent === "number") {
        return svc.aid === accIdent;
      }
      return (
        svc.serviceName === accIdent ||
        svc.instance?.name === accIdent
      );
    });

    if (matches.length === 0) {
      this.log.warn(
        `HAP bridge "${this.config.name}": no accessory matches "${accIdent}"`,
      );
      listener(undefined, true);
      return;
    }

    let bound = false;
    for (const svc of matches) {
      for (const ch of svc.serviceCharacteristics) {
        const isMatch =
          typeof chIdent === "number"
            ? ch.iid === chIdent
            : ch.description === chIdent
              || ch.type === chIdent
              || matchesCharacteristicName(ch.type, chIdent);
        if (!isMatch) {
          continue;
        }
        const key = `${svc.aid}:${ch.iid}`;
        const list = this.resolved.get(key) ?? [];
        list.push(listener);
        this.resolved.set(key, list);
        bound = true;
        listener(ch.value, false);
      }
    }

    if (!bound) {
      this.log.warn(
        `HAP bridge "${this.config.name}": accessory "${accIdent}" has no characteristic matching "${chIdent}"`,
      );
      listener(undefined, true);
    }
  }

  private dispatch(aid: number, iid: number, value: unknown, degraded: boolean): void {
    const key = `${aid}:${iid}`;
    const list = this.resolved.get(key);
    if (!list) {
      return;
    }
    for (const l of list) {
      l(value, degraded);
    }
  }

  private markAllDegraded(): void {
    for (const list of this.resolved.values()) {
      for (const l of list) {
        l(undefined, true);
      }
    }
  }
}
