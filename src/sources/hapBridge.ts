import { Logger } from "homebridge";
import { HapClient } from "@oznu/hap-client";
import type { HapMonitor } from "@oznu/hap-client/dist/monitor.js";
import { EventEmitter } from "events";

export interface HapBridgeConfig {
  /** Logical name used by sources via the `bridge` field. */
  name: string;
  /** Host of the target Homebridge — typically 127.0.0.1 when running in the same container. */
  host: string;
  /** HAP port of the target Homebridge instance. */
  port: number;
  /** Pairing PIN — format `xxx-xx-xxx`. */
  pin: string;
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
 * Connection is **direct via `host:port`** — we don't rely on the library's
 * built-in mDNS discovery because on multi-interface hosts (QNAP with
 * macvlan-shim + qvs0 + lxcbr0 + docker0 + multiple bridges all advertising
 * the same services) the library picks the first IPv4 from each device's
 * address list and gives up if that IP isn't reachable, producing a
 * non-deterministic pass/fail on every container restart. Instead we seed
 * `client.instances` manually after construction and let the client's own
 * HTTP machinery handle the rest.
 *
 * On first successful fetch we log a snapshot of all accessories with their
 * AID/IID so users can switch from name- to ID-based targeting after
 * renaming in the Home app.
 *
 * Characteristic subscriptions are registered eagerly via
 * `subscribe(matcher, listener)` and are resolved once the catalog loads.
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
      `HAP bridge "${this.config.name}" connecting directly to ${this.config.host}:${this.config.port}`,
    );

    // hap-client's debug() method calls `logger.log` — not `logger.debug` —
    // so the adapter must expose `log`. It silently crashes the async
    // discovery callback otherwise (only visible in stderr as a
    // TypeError stack trace).
    const logFn = (...a: unknown[]) => this.log.debug(`[hap:${this.config.name}]`, ...a);
    const client = new HapClient({
      pin: this.config.pin,
      logger: {
        log: logFn,
        info: logFn,
        warn: (...a: unknown[]) => this.log.warn(`[hap:${this.config.name}]`, ...a),
        error: (...a: unknown[]) => this.log.error(`[hap:${this.config.name}]`, ...a),
        debug: logFn,
      },
      config: { debug: false },
    });
    this.client = client;

    // Startup is non-blocking: the initial fetch happens in the background
    // so Homebridge startup is never held up. bootstrap() seeds the client's
    // instance pool on each attempt, bypassing mDNS entirely.
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
    // Retry with exponential backoff on connection failures so a temporarily
    // unreachable child bridge (e.g. still booting) doesn't leave us stuck
    // in degraded state forever.
    let attempt = 0;
    while (!this.stopped) {
      try {
        this.reseedInstance();
        await this.refreshAccessories();
        return;
      } catch (err) {
        this.log.warn(
          `HAP bridge "${this.config.name}" bootstrap attempt ${attempt + 1} failed:`,
          (err as Error).message,
        );
        this.markAllDegraded();
        const delay = Math.min(60_000, 1000 * Math.pow(2, attempt));
        attempt++;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  /**
   * Re-seed the single instance into `client.instances`. hap-client removes
   * instances that fail 5+ times in a row; on retry we need to put ours
   * back so the next HTTP request has a target.
   */
  private reseedInstance(): void {
    const client = this.client;
    if (!client) {
      return;
    }
    const instance = {
      name: this.config.name,
      ipAddress: this.config.host,
      port: this.config.port,
      username: `${this.config.host}:${this.config.port}`,
      services: [],
      connectionFailedCount: 0,
    };
    (client as unknown as { instances: unknown[] }).instances = [instance];
  }

  private async refreshAccessories(): Promise<void> {
    const client = this.client;
    if (!client) {
      return;
    }
    const all = (await client.getAllServices()) as unknown as HapService[];
    // hap-client's getAccessories() swallows axios errors and returns an
    // empty list, so an ECONNREFUSED during a child-bridge startup race
    // looks the same as "no accessories". Treat an empty result as a
    // connection failure so bootstrap() retries with backoff. A real empty
    // bridge is edge-case enough that the retry is harmless.
    const matching = all.filter((svc) => svc.instance?.port === this.config.port);
    if (matching.length === 0) {
      throw new Error(
        `no accessories returned from ${this.config.host}:${this.config.port} (likely ECONNREFUSED / bridge not yet ready)`,
      );
    }
    this.onServices(all);
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
    // `@oznu/hap-client` shares a single HapClient across all HAP instances
    // it paired with the configured PIN. On Homebridge's default "same PIN
    // for all child bridges" setup, that means getAllServices() / the
    // monitor return services from every paired bridge. Filter to only our
    // target bridge's port so matching, snapshot, and fan-out are scoped.
    const filtered = services.filter((svc) => svc.instance?.port === this.config.port);
    this.services = filtered;
    this.discovered = true;

    if (!this.snapshotLogged) {
      this.logSnapshot(filtered);
      this.snapshotLogged = true;
    }

    // Resolve any pending subscribers that couldn't bind before discovery.
    const pending = [...this.pendingSubscribers];
    this.pendingSubscribers.length = 0;
    for (const p of pending) {
      this.resolveAndBind(p);
    }

    // Fan out current values to all resolved listeners.
    for (const svc of filtered) {
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
