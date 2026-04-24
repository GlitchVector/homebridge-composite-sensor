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

function shortOrLong(uuid: string | undefined, fallback: string): string {
  if (!uuid) {
    return fallback;
  }
  try {
    const long = HapCharacteristic_.ensureCharacteristicUuid(uuid);
    const name = HapCharacteristic_.characteristicFromUuid(long);
    return name || fallback;
  } catch {
    return fallback;
  }
}

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
      stored = { deviceId: svc.id, pairingData };
      await this.savePairing(stored);
      this.currentPort = svc.port;
      this.log.info(
        `HAP bridge "${this.config.name}" paired device ${svc.id}; keys saved to ${this.pairingFilePath()}`,
      );
    }

    this.deviceId = stored.deviceId;

    // Reconnect path: use configured port first, fall back to mDNS lookup if
    // the accessory rotated its port since last time.
    let port = this.currentPort ?? this.config.port;
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
      const svc = await this.resolveFromMdns();
      port = svc.port;
      this.currentPort = port;
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

    void this.ensureSubscriptionsCurrent();
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
        const svcName = HapService_.serviceFromUuid(
          HapService_.ensureServiceUuid(svc.type),
        );
        if (svcName === "AccessoryInformation") {
          for (const ch of svc.characteristics) {
            if (shortOrLong(ch.type, "") === "Name" && typeof ch.value === "string") {
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
          const chName = shortOrLong(ch.type, "");
          if ((chName === "Name" || chName === "ConfiguredName") && typeof ch.value === "string" && ch.value) {
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
