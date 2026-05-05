import { Logger } from "homebridge";
import { HapClient } from "@oznu/hap-client";
import type { HapMonitor } from "@oznu/hap-client/dist/monitor.js";
import { EventEmitter } from "events";
import type { HapBridgeConfig, HapService } from "./hapBridge.js";

type CharacteristicMatcher = {
  accessory: string | number;
  characteristic: string | number;
};

type Listener = (value: unknown, degraded: boolean) => void;

const SHORT_NAMES: Record<string, string> = {
  On: "25",
  MotionDetected: "22",
  OccupancyDetected: "71",
  ContactSensorState: "6A",
  CurrentAmbientLightLevel: "6B",
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
 * `@oznu/hap-client`-based bridge for other Homebridge instances / child
 * bridges. Uses the Homebridge-specific `Authorization: <pin>` HTTP header
 * shortcut — works against Homebridge HAP servers (which expose an
 * unencrypted path that accepts the PIN as a header) but NOT against
 * native HAP accessories, which require real pair-setup (see
 * `hapBridgeNative.ts`).
 *
 * Connection is **direct via `host:port`** — we don't rely on the library's
 * built-in mDNS discovery because on multi-interface hosts (QNAP with
 * macvlan-shim + qvs0 + lxcbr0 + docker0 + multiple bridges all advertising
 * the same services) the library picks the first IPv4 from each device's
 * address list and gives up if that IP isn't reachable, producing a
 * non-deterministic pass/fail on every container restart. Instead we seed
 * `client.instances` manually after construction and let the client's own
 * HTTP machinery handle the rest.
 */
export class HomebridgeHapBridge extends EventEmitter {
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

  private readonly resolved = new Map<string, Listener[]>();

  /**
   * Watchdog state. `@oznu/hap-client` SSE event streams can die silently
   * (no disconnect event surfaces) — observed in the wild as a `mode:
   * "homebridge"` bridge going totally quiet for 22h while polling-based
   * HTTP reads still worked. The watchdog runs `refreshAccessories()` on a
   * timer to dispatch current values (catches persistent drift) and forces
   * a monitor rebuild every Nth poll (catches dead SSE streams).
   */
  private watchdogTimer?: NodeJS.Timeout;
  private pollCount = 0;
  private static readonly WATCHDOG_INTERVAL_MS = 60_000;
  private static readonly RESET_EVERY_N_POLLS = 5;

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
      `HAP bridge "${this.config.name}" (homebridge) connecting directly to ${this.config.host}:${this.config.port}`,
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

    void this.bootstrap();
  }

  stop(): void {
    this.stopped = true;
    this.stopWatchdog();
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
    let attempt = 0;
    while (!this.stopped) {
      try {
        this.reseedInstance();
        await this.refreshAccessories();
        this.startWatchdog();
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

  private startWatchdog(): void {
    if (this.watchdogTimer || this.stopped) {
      return;
    }
    this.watchdogTimer = setInterval(() => {
      void this.runWatchdog();
    }, HomebridgeHapBridge.WATCHDOG_INTERVAL_MS);
    this.watchdogTimer.unref?.();
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  /**
   * Watchdog cycle. Every WATCHDOG_INTERVAL_MS:
   *  - Refresh accessories via HTTP (independent of SSE health). The
   *    `onServices()` dispatch will surface any drift to listeners, since
   *    `Source.update()` only emits "change" on actual transitions.
   *  - Every Nth cycle, also tear down the SSE monitor first so
   *    `refreshAccessories()` recreates it. Defense against silent
   *    `@oznu/hap-client` event-stream death.
   *
   * Transient toggles (e.g. door open→close within one interval) can still
   * be missed if SSE is dead and both edges fall between polls — this
   * watchdog bounds the silence window, not the per-event guarantee.
   */
  private async runWatchdog(): Promise<void> {
    if (this.stopped || !this.client) {
      return;
    }
    this.pollCount++;
    const forceMonitorReset =
      this.pollCount % HomebridgeHapBridge.RESET_EVERY_N_POLLS === 0;
    if (forceMonitorReset) {
      this.log.debug(
        `HAP bridge "${this.config.name}" watchdog: scheduled monitor reset (poll #${this.pollCount})`,
      );
      try {
        this.monitor?.finish();
      } catch (err) {
        this.log.debug(
          `HAP bridge "${this.config.name}" monitor.finish() during watchdog reset threw:`,
          (err as Error).message,
        );
      }
      this.monitor = undefined;
    }
    try {
      await this.refreshAccessories();
    } catch (err) {
      this.log.warn(
        `HAP bridge "${this.config.name}" watchdog refresh failed:`,
        (err as Error).message,
      );
    }
  }

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
    const matching = all.filter((svc) => svc.instance?.port === this.config.port);
    if (matching.length === 0) {
      throw new Error(
        `no accessories returned from ${this.config.host}:${this.config.port} (likely ECONNREFUSED / bridge not yet ready)`,
      );
    }
    this.onServices(all);
    if (!this.monitor) {
      this.monitor = await client.monitorCharacteristics();
      this.monitor.on("service-update", (updated: unknown) => {
        this.onServices(updated as HapService[]);
      });
    }
  }

  private onServices(services: HapService[]): void {
    const filtered = services.filter((svc) => svc.instance?.port === this.config.port);
    this.services = filtered;
    this.discovered = true;

    if (!this.snapshotLogged) {
      this.logSnapshot(filtered);
      this.snapshotLogged = true;
    }

    const pending = [...this.pendingSubscribers];
    this.pendingSubscribers.length = 0;
    for (const p of pending) {
      this.resolveAndBind(p);
    }

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
