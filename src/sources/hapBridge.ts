import { Logger } from "homebridge";
import { EventEmitter } from "events";
import { HomebridgeHapBridge } from "./hapBridgeHomebridge.js";
import { NativeHapBridge } from "./hapBridgeNative.js";

/**
 * How this bridge talks to the target accessory.
 *
 * - `homebridge` (default): uses `@oznu/hap-client`'s `Authorization: <pin>`
 *   HTTP header shortcut. Only works against other Homebridge / child-bridge
 *   HAP servers that accept the PIN-as-header backdoor. Use this when the
 *   target is another Homebridge instance (e.g. the local `hue` child
 *   bridge).
 * - `native`: uses `hap-controller` to do real HAP pair-setup (SRP over
 *   TLV), persists the long-term keys, and reconnects with them. Use this
 *   when the target is a native HAP accessory (Aqara FP2, Eve, etc.).
 */
export type HapBridgeMode = "homebridge" | "native";

export interface HapBridgeConfig {
  /** Logical name used by sources via the `bridge` field. */
  name: string;
  /** Host of the target — typically 127.0.0.1 when pointing at a local child bridge. */
  host: string;
  /** HAP port of the target instance. */
  port: number;
  /** Pairing PIN — format `xxx-xx-xxx`. */
  pin: string;
  /** Transport mode — see {@link HapBridgeMode}. Defaults to `homebridge`. */
  mode?: HapBridgeMode;
  /**
   * Compatibility alias: older versions of this library used a loosely-typed
   * `instance` field to describe an accessory. Kept as optional so filters
   * that previously referenced it continue to compile.
   */
  instance?: { port?: number; host?: string; username?: string; name?: string };
}

/**
 * Minimal shape of the services the bridges emit on the internal
 * `service-update` path and return from `getAccessories()`. Unified across
 * both backends (homebridge-mode legacy shape + native-mode hap-controller
 * shape). Typed permissively since upstream shapes are broad.
 */
export interface HapService {
  aid: number;
  iid: number;
  uuid?: string;
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
  accessory: string | number;
  characteristic: string | number;
};

type Listener = (value: unknown, degraded: boolean) => void;

/**
 * Public facade. Construction selects the appropriate transport based on
 * `config.mode` (defaulting to the legacy homebridge-to-homebridge path).
 * Downstream code (`HapSource`, platform.ts) only knows about this class.
 */
export class HapBridge extends EventEmitter {
  public readonly config: HapBridgeConfig;
  private readonly impl: HomebridgeHapBridge | NativeHapBridge;

  constructor(config: HapBridgeConfig, log: Logger) {
    super();
    this.config = config;
    const mode: HapBridgeMode = config.mode ?? "homebridge";
    this.impl = mode === "native"
      ? new NativeHapBridge(config, log)
      : new HomebridgeHapBridge(config, log);
  }

  start(): void {
    this.impl.start();
  }

  stop(): void {
    this.impl.stop();
  }

  subscribe(matcher: CharacteristicMatcher, listener: Listener): void {
    this.impl.subscribe(matcher, listener);
  }
}
