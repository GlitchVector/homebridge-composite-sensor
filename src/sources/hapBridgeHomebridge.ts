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
  Brightness: "8",
  Hue: "13",
  Saturation: "2F",
  ColorTemperature: "CE",
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
  // HAP UUIDs are 8 hex digits before the first dash — pad to that length so
  // single-hex short names (e.g. Brightness=8 → 00000008-…) match correctly.
  return type.toUpperCase() === short
    || type.toUpperCase().startsWith(`${short.padStart(8, "0")}-`);
}

/**
 * Reject if `p` doesn't settle within `ms`. Wraps `@oznu/hap-client` network
 * calls so a half-open TCP socket (the silent-death failure mode) surfaces as
 * an error the watchdog can act on, instead of an `await` that never returns.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
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
   * "homebridge"` bridge going totally quiet for ~24h while polling-based
   * HTTP reads still worked. Tearing down and recreating the SSE *monitor*
   * alone proved insufficient (the underlying client connection pool stays
   * wedged), so the watchdog escalates to a full client rebuild — a fresh
   * `HapClient` + reconnect, the in-process equivalent of restarting the
   * container, which is what historically cleared these hangs.
   *
   * Three escalation triggers, all routed to {@link rebuildClient}:
   *  - `consecutiveFailures` HTTP refreshes in a row (stale port after a
   *    child-bridge restart, ECONNREFUSED, or a hung socket caught by the
   *    I/O timeout).
   *  - No SSE `service-update` for `SSE_STALE_REBUILD_MS` (the silent-death
   *    mode). A genuinely idle bridge reconnects harmlessly on this cadence;
   *    a silently-dead one is resurrected. Widen the window if the target
   *    bridge is legitimately quiet for long stretches and the reconnect
   *    churn matters.
   *  - A failed/timed-out write (magic buttons are write-only, so the
   *    read-path checks above would never notice their transport is dead).
   */
  private watchdogTimer?: NodeJS.Timeout;
  private consecutiveFailures = 0;
  private lastSseEventAt = 0;
  private rebuildInFlight = false;
  private static readonly WATCHDOG_INTERVAL_MS = 60_000;
  private static readonly FAIL_ESCALATE_THRESHOLD = 3;
  private static readonly SSE_STALE_REBUILD_MS = 15 * 60_000;
  private static readonly IO_TIMEOUT_MS = 20_000;

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
    this.lastSseEventAt = Date.now();
    this.client = this.createClient();

    void this.bootstrap();
  }

  private createClient(): HapClient {
    // hap-client's debug() method calls `logger.log` — not `logger.debug` —
    // so the adapter must expose `log`. It silently crashes the async
    // discovery callback otherwise (only visible in stderr as a
    // TypeError stack trace).
    const logFn = (...a: unknown[]) => this.log.debug(`[hap:${this.config.name}]`, ...a);
    return new HapClient({
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

  async write(matcher: CharacteristicMatcher, value: unknown): Promise<void> {
    const client = this.client;
    if (!client) {
      throw new Error(`HAP bridge "${this.config.name}": not connected`);
    }
    if (!this.discovered) {
      throw new Error(
        `HAP bridge "${this.config.name}": services not yet discovered — write of "${matcher.characteristic}" on "${matcher.accessory}" rejected`,
      );
    }
    const located = this.locate(matcher);
    if (!located) {
      throw new Error(
        `HAP bridge "${this.config.name}": could not locate accessory "${matcher.accessory}" / characteristic "${matcher.characteristic}" for write`,
      );
    }
    const { service, iid } = located;
    // The `@oznu/hap-client` setCharacteristic API expects its richer
    // `ServiceType` shape; at runtime the `service` we hold IS that shape
    // (we cast down on read in `getAllServices()`), so the unknown cast is
    // safe. The value type is narrowed by hap-client at the network boundary.
    try {
      await withTimeout(
        client.setCharacteristic(
          service as unknown as Parameters<typeof client.setCharacteristic>[0],
          iid,
          value as number | string | boolean,
        ),
        HomebridgeHapBridge.IO_TIMEOUT_MS,
        `HAP bridge "${this.config.name}" write of "${matcher.characteristic}" on "${matcher.accessory}"`,
      );
    } catch (err) {
      // A failed/timed-out write is the clearest signal this connection is
      // wedged — and magic buttons are write-only, so the read-path watchdog
      // would never notice on its own. Kick a rebuild so the next press
      // lands, then surface the failure to the caller.
      this.log.warn(
        `HAP bridge "${this.config.name}" write failed, scheduling reconnect:`,
        (err as Error).message,
      );
      void this.rebuildClient("write failure");
      throw err;
    }
  }

  /**
   * Resolve a (accessory, characteristic) matcher against the current service
   * snapshot. Returns the owning service + characteristic iid, or undefined if
   * either side can't be found. Used by both subscribe() (read) and write().
   */
  private locate(
    matcher: CharacteristicMatcher,
  ): { service: HapService; iid: number } | undefined {
    const accIdent = matcher.accessory;
    const chIdent = matcher.characteristic;
    const matches = this.services.filter((svc) => {
      if (typeof accIdent === "number") {
        return svc.aid === accIdent;
      }
      return svc.serviceName === accIdent || svc.instance?.name === accIdent;
    });
    for (const svc of matches) {
      for (const ch of svc.serviceCharacteristics) {
        const isMatch =
          typeof chIdent === "number"
            ? ch.iid === chIdent
            : ch.description === chIdent
              || ch.type === chIdent
              || matchesCharacteristicName(ch.type, chIdent);
        if (isMatch) {
          return { service: svc, iid: ch.iid };
        }
      }
    }
    return undefined;
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
   * Watchdog cycle, every WATCHDOG_INTERVAL_MS. Refresh accessories via HTTP
   * (independent of SSE health) — the dispatch surfaces any value drift to
   * listeners, since `Source.update()` only emits "change" on actual
   * transitions. Two failure modes escalate to a full {@link rebuildClient}:
   * repeated HTTP refresh failures, and an SSE stream that's gone silent past
   * `SSE_STALE_REBUILD_MS` (`lastSseEventAt` only advances on real
   * `service-update` events or a reconnect, never on a plain refresh).
   *
   * Transient toggles can still be missed if SSE is dead and both edges fall
   * between polls — this watchdog bounds the silence window, not the
   * per-event guarantee.
   */
  private async runWatchdog(): Promise<void> {
    if (this.stopped || !this.client || this.rebuildInFlight) {
      return;
    }

    try {
      await this.refreshAccessories();
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures++;
      this.log.warn(
        `HAP bridge "${this.config.name}" watchdog refresh failed `
          + `(${this.consecutiveFailures}/${HomebridgeHapBridge.FAIL_ESCALATE_THRESHOLD}):`,
        (err as Error).message,
      );
      if (this.consecutiveFailures >= HomebridgeHapBridge.FAIL_ESCALATE_THRESHOLD) {
        this.consecutiveFailures = 0;
        await this.rebuildClient("repeated refresh failures");
      }
      return;
    }

    // Second line of defense: HTTP reads succeed but the SSE stream has gone
    // silent (the documented silent-death mode). A monitor reset alone has
    // proven insufficient, so escalate to a full client rebuild.
    const sseSilentMs = Date.now() - this.lastSseEventAt;
    if (sseSilentMs >= HomebridgeHapBridge.SSE_STALE_REBUILD_MS) {
      await this.rebuildClient(`no SSE events for ${Math.round(sseSilentMs / 1000)}s`);
    }
  }

  /**
   * Full reconnect: drop the SSE monitor and the entire `HapClient`, build a
   * fresh one, and re-discover. This is the in-process equivalent of a
   * container restart — the only thing observed to reliably clear a silently
   * wedged `@oznu/hap-client` connection. Guarded so overlapping triggers (a
   * failure escalation racing the staleness check, or a write failure firing
   * mid-cycle) don't stack.
   */
  private async rebuildClient(reason: string): Promise<void> {
    if (this.stopped || this.rebuildInFlight) {
      return;
    }
    this.rebuildInFlight = true;
    this.log.warn(`HAP bridge "${this.config.name}" rebuilding connection (${reason})`);
    try {
      try {
        this.monitor?.finish();
      } catch (err) {
        this.log.debug(
          `HAP bridge "${this.config.name}" monitor.finish() during rebuild threw:`,
          (err as Error).message,
        );
      }
      this.monitor = undefined;
      try {
        this.client?.resetInstancePool();
      } catch (err) {
        this.log.debug(
          `HAP bridge "${this.config.name}" resetInstancePool() during rebuild threw:`,
          (err as Error).message,
        );
      }
      this.client = this.createClient();
      this.reseedInstance();
      await this.refreshAccessories();
      this.consecutiveFailures = 0;
      this.lastSseEventAt = Date.now();
      this.log.info(`HAP bridge "${this.config.name}" reconnected after rebuild`);
    } catch (err) {
      this.log.warn(
        `HAP bridge "${this.config.name}" rebuild failed, will retry next watchdog cycle:`,
        (err as Error).message,
      );
      this.markAllDegraded();
    } finally {
      this.rebuildInFlight = false;
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
    const all = (await withTimeout(
      client.getAllServices(),
      HomebridgeHapBridge.IO_TIMEOUT_MS,
      `HAP bridge "${this.config.name}" getAllServices`,
    )) as unknown as HapService[];
    const matching = all.filter((svc) => svc.instance?.port === this.config.port);
    if (matching.length === 0) {
      throw new Error(
        `no accessories returned from ${this.config.host}:${this.config.port} (likely ECONNREFUSED / bridge not yet ready)`,
      );
    }
    this.handleFullSnapshot(all);
    if (!this.monitor) {
      this.monitor = await withTimeout(
        client.monitorCharacteristics(),
        HomebridgeHapBridge.IO_TIMEOUT_MS,
        `HAP bridge "${this.config.name}" monitorCharacteristics`,
      );
      this.monitor.on("service-update", (updated: unknown) => {
        this.lastSseEventAt = Date.now();
        this.handleServiceUpdate(updated as HapService[]);
      });
      // A freshly-established monitor counts as liveness — otherwise a bridge
      // that's quiet right after (re)connect could trip the staleness rebuild
      // before its first real event arrives.
      this.lastSseEventAt = Date.now();
    }
  }

  /**
   * Full topology refresh from {@link HapClient.getAllServices}. Replaces
   * `this.services` with the complete filtered list — this is the only
   * code path that should overwrite our service catalog.
   */
  private handleFullSnapshot(services: HapService[]): void {
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

  /**
   * Handle a partial `service-update` event from {@link HapMonitor}. Per
   * `@oznu/hap-client@1.x` (see `monitor.js`), the emitted array contains
   * ONLY the services whose characteristics changed in this batch — it is a
   * value-change notification, not a topology refresh. Replacing
   * `this.services` with this subset shrinks the catalog to 1-2 entries
   * and breaks write-path resolution against any aid that hadn't just
   * changed. (Read subscribers were unaffected because dispatch is keyed by
   * (aid, iid) in the `resolved` map — they get values directly from this
   * call without needing `this.services`.) Just dispatch the new values;
   * the next watchdog refresh repopulates the full catalog from
   * `getAllServices`.
   */
  private handleServiceUpdate(updated: HapService[]): void {
    const filtered = updated.filter((svc) => svc.instance?.port === this.config.port);
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
