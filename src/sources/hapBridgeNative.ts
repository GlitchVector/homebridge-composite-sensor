import { Logger } from "homebridge";
import { EventEmitter } from "events";
import {
  HttpClient,
  IPDiscovery,
  HapServiceIp,
  PairingData,
  Service as HapService_,
  Characteristic as HapCharacteristic_,
} from "hap-controller";
import type { AccessoryObject } from "hap-controller/lib/model/accessory.js";
import type { CharacteristicObject } from "hap-controller/lib/model/characteristic.js";
import * as fs from "fs/promises";
import * as net from "net";
import * as path from "path";
import type { HapBridgeConfig, HapService } from "./hapBridge.js";

type CharacteristicMatcher = {
  /** Accessory identifier — human name (matched against `serviceName`) or explicit AID. */
  accessory: string | number;
  /** Characteristic identifier — HAP type name (e.g. `On`, `MotionDetected`), or explicit IID. */
  characteristic: string | number;
};

type Listener = (value: unknown, degraded: boolean) => void;

interface StoredPairing {
  deviceId: string;
  pairingData: PairingData;
  /**
   * Last successfully-validated HAP port for this accessory. HAP TCP ports
   * are ephemeral (re-assigned on every accessory reboot), so the configured
   * `port` in the platform yaml goes stale fast. Persisting the most-recent
   * good port lets us reconnect across our OWN restarts without having to
   * re-discover via mDNS or TCP-scan every cold boot.
   */
  lastKnownPort?: number;
}

/**
 * HAP characteristic types are usually UUIDs (e.g. "25" or "00000025-0000-1000-8000-0026BB765291");
 * we match either by raw type string or by well-known short names like "On", "MotionDetected".
 */
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
 * hap-controller's `serviceFromUuid` / `characteristicFromUuid` return the
 * **dotted** IANA-ish form (e.g. `"public.hap.service.accessory-information"`,
 * `"public.hap.characteristic.name"`), NOT the short PascalCase form. These
 * helpers normalize to that dotted form for stable string comparisons.
 */
function serviceTypeName(type: string | undefined): string {
  if (!type) {
    return "";
  }
  try {
    return HapService_.serviceFromUuid(HapService_.ensureServiceUuid(type)) || "";
  } catch {
    return "";
  }
}

function charTypeName(type: string | undefined): string {
  if (!type) {
    return "";
  }
  try {
    return (
      HapCharacteristic_.characteristicFromUuid(
        HapCharacteristic_.ensureCharacteristicUuid(type),
      ) || ""
    );
  } catch {
    return "";
  }
}

const SERVICE_ACCESSORY_INFORMATION = "public.hap.service.accessory-information";
const CHAR_NAME = "public.hap.characteristic.name";
const CHAR_CONFIGURED_NAME = "public.hap.characteristic.configured-name";

/**
 * Wraps one HAP accessory connection via `hap-controller`.
 *
 * Does real HAP pair-setup (SRP over TLV) on first connect, persists the
 * long-term keys in `<homebridge>/composite-sensor-pairings/<name>.json`,
 * and reconnects with the stored keys on subsequent starts. This is the
 * critical difference from `@oznu/hap-client`, which only does the
 * Homebridge-specific `Authorization: <pin>` HTTP header shortcut and can
 * therefore only talk to other Homebridge instances — not native HAP
 * accessories like Aqara FP2.
 *
 * Host/port are taken from config (pin the IP with a static DHCP lease).
 * The HAP TCP port is ephemeral per accessory reboot; if the configured
 * port no longer matches the live mDNS advertisement, we resolve the
 * current port via mDNS before reconnecting. DeviceId is resolved from
 * mDNS on first pair and then persisted alongside the pairing data.
 *
 * On first successful fetch we log a snapshot of all accessories and their
 * characteristics with AID/IID so users can switch from name- to ID-based
 * targeting after renaming in the Home app.
 */
export class NativeHapBridge extends EventEmitter {
  private client?: HttpClient;
  private services: HapService[] = [];
  private deviceId?: string;
  private currentPort?: number;
  private discovered = false;
  private snapshotLogged = false;
  private stopped = false;
  private subscribedKeys = new Set<string>();
  /** Long-lived mDNS watcher for c# (config number) bumps. */
  private watchDiscovery?: IPDiscovery;
  /** Highest c# we've seen from mDNS; drives auto-reconcile. */
  private lastConfigNumber?: number;
  private reconcileInFlight = false;

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
    void this.bootstrap();
  }

  stop(): void {
    this.stopped = true;
    try {
      this.watchDiscovery?.stop();
    } catch {
      /* best-effort */
    }
    this.watchDiscovery = undefined;
    this.client?.close().catch(() => {
      /* best-effort */
    });
    this.client = undefined;
  }

  subscribe(matcher: CharacteristicMatcher, listener: Listener): void {
    this.pendingSubscribers.push({ matcher, listener });
    if (this.discovered) {
      this.resolveAndBind({ matcher, listener });
      void this.ensureSubscriptionsCurrent();
    }
  }

  private pairingFilePath(): string {
    // Homebridge user dir is the plugin's working "persist" area. Docker
    // image bind-mounts it at /homebridge; standalone installs put it at
    // ~/.homebridge. Fall back defensively.
    const dir =
      process.env.UIX_STORAGE_PATH ||
      process.env.HOMEBRIDGE_STORAGE_PATH ||
      (process.cwd() === "/" ? "/homebridge" : process.cwd());
    return path.join(dir, "composite-sensor-pairings", `${this.config.name}.json`);
  }

  private async loadPairing(): Promise<StoredPairing | null> {
    try {
      const raw = await fs.readFile(this.pairingFilePath(), "utf-8");
      return JSON.parse(raw) as StoredPairing;
    } catch {
      return null;
    }
  }

  private async savePairing(data: StoredPairing): Promise<void> {
    const file = this.pairingFilePath();
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  /**
   * Last-resort fallback when both the configured port and mDNS rediscovery
   * fail. TCP-probes the accessory's IP across the IANA ephemeral range
   * (49152–65535) in parallel batches, then validates each open candidate
   * by attempting an authenticated `getAccessories()` with the stored
   * pairing — only an accessory that actually speaks HAP and accepts our
   * long-term keys returns success.
   *
   * Why this exists: in some network setups (Docker bridge networks, VLAN
   * splits, qvs0 + macvlan-shim coexistence on QTS, anything that breaks
   * mDNS multicast forwarding) the FP2 broadcasts its new HAP port but
   * nothing reaches the homebridge container's avahi/bonjour listener. Pre-
   * patch, the plugin would loop "mDNS discovery timeout" forever after any
   * accessory reboot — sensors silently freeze on `onDegraded: lastKnown`,
   * which is exactly the bug we hit on 2026-04-30 (fp2-livingroom rotated
   * 62137 → 62350, neither configured nor cached worked, mDNS saw nothing,
   * Somebody-Home stuck ON for 7+ hours).
   *
   * Cost: scanning 16384 ports with concurrency 256 takes ~5–10s on a quiet
   * LAN. We pay this once per accessory port rotation; after success the
   * resolved port is persisted in the pairing file so subsequent restarts
   * skip straight to the cached port.
   */
  private async resolveByPortScan(
    stored: StoredPairing,
    {
      lo = 49152,
      hi = 65535,
      concurrency = 256,
      tcpTimeoutMs = 1500,
    }: { lo?: number; hi?: number; concurrency?: number; tcpTimeoutMs?: number } = {},
  ): Promise<number | null> {
    const probePort = (port: number): Promise<boolean> =>
      new Promise((resolve) => {
        const socket = new net.Socket();
        const finish = (ok: boolean) => {
          try {
            socket.destroy();
          } catch {
            /* best-effort */
          }
          resolve(ok);
        };
        socket.setTimeout(tcpTimeoutMs);
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
        socket.once("timeout", () => finish(false));
        socket.connect(port, this.config.host);
      });

    const candidates: number[] = [];
    for (let start = lo; start <= hi; start += concurrency) {
      const end = Math.min(start + concurrency, hi + 1);
      const batch: Promise<{ port: number; open: boolean }>[] = [];
      for (let p = start; p < end; p++) {
        batch.push(probePort(p).then((open) => ({ port: p, open })));
      }
      const results = await Promise.all(batch);
      for (const r of results) {
        if (r.open) {
          candidates.push(r.port);
        }
      }
    }

    if (candidates.length === 0) {
      this.log.warn(
        `HAP bridge "${this.config.name}" port-scan found NO open ports on ${this.config.host} in [${lo}-${hi}] — accessory likely offline or firewalled`,
      );
      return null;
    }
    const sample = candidates.slice(0, 10).join(", ");
    const ellipsis = candidates.length > 10 ? "…" : "";
    this.log.info(
      `HAP bridge "${this.config.name}" port-scan found ${candidates.length} ` +
        `open port(s): ${sample}${ellipsis}`,
    );

    // Phase 2: validate each candidate as a real HAP listener that accepts
    // our long-term keys. The first match wins.
    for (const port of candidates) {
      const client = new HttpClient(
        stored.deviceId,
        this.config.host,
        port,
        stored.pairingData,
        { usePersistentConnections: true },
      );
      try {
        await client.getAccessories();
        await client.close().catch(() => undefined);
        this.log.info(
          `HAP bridge "${this.config.name}" port-scan validated HAP on ${this.config.host}:${port}`,
        );
        return port;
      } catch {
        await client.close().catch(() => undefined);
      }
    }
    this.log.warn(
      `HAP bridge "${this.config.name}" port-scan: ${candidates.length} open port(s) but none accepted our pairing — possible re-pair needed`,
    );
    return null;
  }

  /**
   * Resolve the accessory's HAP deviceId + current port via mDNS. Needed on
   * first pair (we don't know the deviceId until we see the TXT record) and
   * on reconnect if the advertised port drifted.
   */
  private async resolveFromMdns(timeoutMs = 10_000): Promise<HapServiceIp> {
    return new Promise((resolve, reject) => {
      const disc = new IPDiscovery();
      const timer = setTimeout(() => {
        disc.stop();
        reject(
          new Error(
            `mDNS discovery timeout — no HAP advertisement matching ${this.config.host} within ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      const handler = (svc: HapServiceIp) => {
        // Match either by IP (primary) or port alone (fallback if port is stable).
        const addressMatches =
          svc.address === this.config.host ||
          (Array.isArray(svc.allAddresses) && svc.allAddresses.includes(this.config.host));
        if (addressMatches) {
          clearTimeout(timer);
          disc.off("serviceUp", handler);
          disc.stop();
          resolve(svc);
        }
      };
      disc.on("serviceUp", handler);
      disc.start();
    });
  }

  private async bootstrap(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      try {
        await this.connectAndFetch();
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

  private async connectAndFetch(): Promise<void> {
    let stored = await this.loadPairing();

    if (!stored) {
      // First-time pair — need the deviceId from mDNS and the method flag.
      this.log.info(`HAP bridge "${this.config.name}" no stored pairing — running pair-setup`);
      const svc = await this.resolveFromMdns();
      if (svc.sf === 0) {
        throw new Error(
          `accessory ${svc.id} is already paired (sf=0) — factory reset it first or remove the stale pairing`,
        );
      }
      const pairMethod = await new IPDiscovery().getPairMethod(svc);
      const setupClient = new HttpClient(svc.id, this.config.host, svc.port);
      let pairingData: PairingData | null;
      try {
        await setupClient.pairSetup(this.config.pin, pairMethod);
        pairingData = setupClient.getLongTermData();
      } finally {
        await setupClient.close().catch(() => undefined);
      }
      if (!pairingData) {
        throw new Error("pairSetup returned no long-term data");
      }
      stored = { deviceId: svc.id, pairingData, lastKnownPort: svc.port };
      await this.savePairing(stored);
      this.currentPort = svc.port;
      this.log.info(
        `HAP bridge "${this.config.name}" paired device ${svc.id}; keys saved to ${this.pairingFilePath()}`,
      );
    }

    this.deviceId = stored.deviceId;

    // Reconnect path: try ports in this order:
    //   1. in-memory `currentPort` (last successful in this process lifetime)
    //   2. persisted `lastKnownPort` from the pairing file (survives our restarts)
    //   3. configured `port` from the platform yaml
    //   4. mDNS rediscovery
    //   5. TCP port-scan + HAP-pairing-validation (resolveByPortScan)
    // Steps 4–5 only fire if 1–3 all return ECONNREFUSED.
    let port = this.currentPort ?? stored.lastKnownPort ?? this.config.port;
    const client = new HttpClient(
      stored.deviceId,
      this.config.host,
      port,
      stored.pairingData,
      { usePersistentConnections: true },
    );

    try {
      await client.getAccessories();
    } catch (err) {
      this.log.warn(
        `HAP bridge "${this.config.name}" initial getAccessories failed on port ${port}, re-resolving via mDNS: ${(err as Error).message}`,
      );
      await client.close().catch(() => undefined);
      let resolvedPort: number | undefined;
      try {
        const svc = await this.resolveFromMdns();
        resolvedPort = svc.port;
      } catch (mdnsErr) {
        this.log.warn(
          `HAP bridge "${this.config.name}" mDNS rediscovery failed (${(mdnsErr as Error).message}), falling back to TCP port-scan`,
        );
        const scanned = await this.resolveByPortScan(stored);
        if (scanned !== null) {
          resolvedPort = scanned;
        }
      }
      if (resolvedPort === undefined) {
        throw new Error(
          `HAP bridge "${this.config.name}" — both mDNS and TCP port-scan failed; no HAP listener found on ${this.config.host}`,
        );
      }
      port = resolvedPort;
      this.currentPort = port;
      // Persist the rediscovered port so future restarts skip the slow
      // discovery path. Best-effort — a save failure isn't fatal here.
      await this.savePairing({ ...stored, lastKnownPort: port }).catch((e) =>
        this.log.warn(
          `HAP bridge "${this.config.name}" failed to persist lastKnownPort=${port}: ${(e as Error).message}`,
        ),
      );
      this.client = new HttpClient(
        stored.deviceId,
        this.config.host,
        port,
        stored.pairingData,
        { usePersistentConnections: true },
      );
      const data = await this.client.getAccessories();
      this.finishConnectAndSubscribe(data.accessories);
      return;
    }

    this.client = client;
    this.currentPort = port;
    // First-try success: persist the port if the pairing file didn't already
    // record it. Avoids re-write on every connect once stable.
    if (stored.lastKnownPort !== port) {
      await this.savePairing({ ...stored, lastKnownPort: port }).catch((e) =>
        this.log.warn(
          `HAP bridge "${this.config.name}" failed to persist lastKnownPort=${port}: ${(e as Error).message}`,
        ),
      );
    }
    const data = await client.getAccessories();
    this.finishConnectAndSubscribe(data.accessories);
  }

  private finishConnectAndSubscribe(accessories: AccessoryObject[]): void {
    const services = this.transformAccessories(accessories);
    this.onServices(services);

    const client = this.client;
    if (!client) {
      return;
    }

    client.on("event", (evt: { characteristics: Array<{ aid: number; iid: number; value: unknown }> }) => {
      for (const ch of evt.characteristics) {
        this.dispatch(ch.aid, ch.iid, ch.value, false);
      }
    });
    client.on("event-disconnect", () => {
      this.log.warn(
        `HAP bridge "${this.config.name}" event stream disconnected — reconnecting…`,
      );
      this.client = undefined;
      this.discovered = false;
      this.subscribedKeys.clear();
      this.markAllDegraded();
      void this.bootstrap();
    });

    this.startConfigWatcher();
    void this.ensureSubscriptionsCurrent();
  }

  /**
   * Watch mDNS for this accessory's `c#` (config number). It bumps whenever
   * the accessory's database changes — e.g. zones added/removed in Aqara
   * Home after initial pair. Without this watcher we'd serve stale AID/IID
   * references until Homebridge is manually restarted.
   */
  private startConfigWatcher(): void {
    if (this.watchDiscovery) {
      return;
    }
    const disc = new IPDiscovery();
    this.watchDiscovery = disc;

    const onServiceRecord = (svc: HapServiceIp): void => {
      if (svc.id !== this.deviceId) {
        return;
      }
      const cnum = svc["c#"];
      if (typeof cnum !== "number") {
        return;
      }
      if (this.lastConfigNumber === undefined) {
        this.lastConfigNumber = cnum;
        return;
      }
      if (cnum <= this.lastConfigNumber) {
        return;
      }
      this.log.info(
        `HAP bridge "${this.config.name}" config number bumped ${this.lastConfigNumber} → ${cnum} — refreshing accessory catalog`,
      );
      this.lastConfigNumber = cnum;
      // Track the new port too in case it rotated while we weren't looking.
      this.currentPort = svc.port;
      void this.reconcileCatalog();
    };

    disc.on("serviceUp", onServiceRecord);
    disc.on("serviceChanged", onServiceRecord);
    disc.start();
  }

  /**
   * Re-fetch the accessory catalog and re-subscribe. Called when `c#` bumps.
   * Drops old subscriptions first so iid shifts don't leave dangling watches.
   */
  private async reconcileCatalog(): Promise<void> {
    if (this.reconcileInFlight || !this.client) {
      return;
    }
    this.reconcileInFlight = true;
    try {
      // Drop prior subscriptions so we don't leave stale iid watches around.
      try {
        await this.client.unsubscribeCharacteristics();
      } catch (err) {
        this.log.debug(
          `HAP bridge "${this.config.name}" unsubscribe-all during reconcile failed: ${(err as Error).message}`,
        );
      }
      this.subscribedKeys.clear();

      const data = await this.client.getAccessories();
      const services = this.transformAccessories(data.accessories);

      // Re-seed catalog + fan out current values to still-bound listeners.
      // Preserve resolved bindings where the (aid, iid) pair still exists;
      // drop ones whose iid was removed; leave new iids to be bound via
      // future subscribe() calls (expression-referenced sources re-resolve
      // on next platform restart anyway).
      const stillPresent = new Set<string>();
      for (const svc of services) {
        for (const ch of svc.serviceCharacteristics) {
          stillPresent.add(`${svc.aid}:${ch.iid}`);
        }
      }
      for (const key of [...this.resolved.keys()]) {
        if (!stillPresent.has(key)) {
          const listeners = this.resolved.get(key) ?? [];
          for (const l of listeners) {
            l(undefined, true);
          }
          this.resolved.delete(key);
        }
      }
      this.services = services;
      // Force fresh fan-out of current values.
      for (const svc of services) {
        for (const ch of svc.serviceCharacteristics) {
          this.dispatch(svc.aid, ch.iid, ch.value, false);
        }
      }
      await this.ensureSubscriptionsCurrent();
    } catch (err) {
      this.log.warn(
        `HAP bridge "${this.config.name}" reconcile failed: ${(err as Error).message}`,
      );
    } finally {
      this.reconcileInFlight = false;
    }
  }

  /**
   * Make sure all resolved (aid, iid) pairs are HAP-subscribed. Called on
   * every connect and whenever a new subscriber binds after discovery.
   */
  private async ensureSubscriptionsCurrent(): Promise<void> {
    const client = this.client;
    if (!client) {
      return;
    }
    const toSubscribe: string[] = [];
    for (const key of this.resolved.keys()) {
      if (!this.subscribedKeys.has(key)) {
        toSubscribe.push(key.replace(":", "."));
        this.subscribedKeys.add(key);
      }
    }
    if (toSubscribe.length === 0) {
      return;
    }
    try {
      await client.subscribeCharacteristics(toSubscribe);
      this.log.debug(
        `HAP bridge "${this.config.name}" subscribed to ${toSubscribe.length} characteristic(s)`,
      );
    } catch (err) {
      this.log.warn(
        `HAP bridge "${this.config.name}" subscribe failed for ${toSubscribe.join(",")}: ${(err as Error).message}`,
      );
      // Roll back so a retry can try again next cycle.
      for (const k of toSubscribe) {
        this.subscribedKeys.delete(k.replace(".", ":"));
      }
    }
  }

  private transformAccessories(accessories: AccessoryObject[]): HapService[] {
    const result: HapService[] = [];
    for (const acc of accessories) {
      // Best-effort accessory-wide name from AccessoryInformation → Name.
      let accName: string | undefined;
      for (const svc of acc.services) {
        if (serviceTypeName(svc.type) === SERVICE_ACCESSORY_INFORMATION) {
          for (const ch of svc.characteristics) {
            if (charTypeName(ch.type) === CHAR_NAME && typeof ch.value === "string") {
              accName = ch.value;
            }
          }
        }
      }
      for (const svc of acc.services) {
        // Per-service name: look for a Name / ConfiguredName characteristic
        // on this service; fall back to the accessory-wide name.
        let serviceName = accName;
        for (const ch of svc.characteristics) {
          const chName = charTypeName(ch.type);
          if (
            (chName === CHAR_NAME || chName === CHAR_CONFIGURED_NAME) &&
            typeof ch.value === "string" &&
            ch.value
          ) {
            serviceName = ch.value;
          }
        }
        const longType = HapService_.ensureServiceUuid(svc.type);
        result.push({
          aid: acc.aid,
          iid: svc.iid,
          type: longType,
          humanType: HapService_.serviceFromUuid(longType),
          serviceName,
          serviceCharacteristics: svc.characteristics.map((c: CharacteristicObject) => {
            const longCh = c.type ? HapCharacteristic_.ensureCharacteristicUuid(c.type) : "";
            return {
              aid: acc.aid,
              iid: c.iid ?? 0,
              type: longCh,
              value: c.value,
              description: c.description ?? HapCharacteristic_.characteristicFromUuid(longCh),
            };
          }),
        });
      }
    }
    return result;
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
        const svcLabel = svc.humanType ?? svc.type;
        this.log.info(`    service iid=${svc.iid} ${svcLabel}${svc.serviceName ? ` "${svc.serviceName}"` : ""}`);
        for (const ch of svc.serviceCharacteristics) {
          this.log.info(
            `      iid=${ch.iid} ${ch.description ?? ch.type} = ${JSON.stringify(ch.value)}`,
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
      return svc.serviceName === accIdent;
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
