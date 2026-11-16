import { Logger } from "homebridge";
import { Source } from "./source.js";
import { MqttBroker } from "./mqttBroker.js";
import { compileMap, MapFn, tryParseJson } from "./mapEvaluator.js";

export interface MqttSourceConfig {
  name: string;
  type: "mqtt";
  topic: string;
  /** JS expression evaluated against `payload` (parsed JSON) and `raw` (string). */
  map: string;
  /**
   * Optional topic that says whether the publisher behind `topic` is alive,
   * e.g. `zigbee2mqtt/bridge/state` (z2m sets it `offline` via its Last
   * Will). Without it, a z2m restart while the broker stays up is invisible:
   * the source keeps its last value and never goes degraded.
   */
  availabilityTopic?: string;
  /**
   * Expression for `availabilityTopic` → online? Default:
   * `payload?.state === "online" || raw === "online"` (z2m JSON and legacy
   * plain-string forms).
   */
  availabilityMap?: string;
}

export class MqttSource extends Source {
  private readonly mapFn: MapFn;
  private connectedListener?: (connected: boolean) => void;

  constructor(
    config: MqttSourceConfig,
    private readonly broker: MqttBroker,
    log: Logger,
  ) {
    super(config.name, log);
    this.mapFn = compileMap(config.map);
    this.topic = config.topic;
    this.availabilityTopic = config.availabilityTopic;
    this.availabilityFn = config.availabilityTopic
      ? compileMap(config.availabilityMap ?? "payload?.state === \"online\" || raw === \"online\"")
      : undefined;
  }

  private readonly topic: string;
  private readonly availabilityTopic?: string;
  private readonly availabilityFn?: MapFn;
  /** Last availability reported on `availabilityTopic`; undefined = not seen yet. */
  private publisherOnline: boolean | undefined = undefined;

  start(): void {
    this.broker.subscribe(this.topic, (raw) => this.onMessage(raw));
    if (this.availabilityTopic) {
      this.broker.subscribe(this.availabilityTopic, (raw) => this.onAvailability(raw));
    }
    this.connectedListener = (connected) => {
      if (!connected && !this.degraded) {
        // Broker lost its connection; values are stale until we reconnect.
        this.update(this.value, true);
      }
    };
    this.broker.listeners.add(this.connectedListener);
    this.broker.start();
  }

  stop(): void {
    if (this.connectedListener) {
      this.broker.listeners.delete(this.connectedListener);
      this.connectedListener = undefined;
    }
  }

  private onMessage(raw: string): void {
    const parsed = tryParseJson(raw);
    const bool = this.mapFn(parsed, raw);
    // While the publisher reports offline, a (retained) value is not live.
    this.update(bool, this.publisherOnline === false);
    this.log.debug(`Source "${this.name}" <- ${raw} => ${bool}`);
  }

  private onAvailability(raw: string): void {
    const online = this.availabilityFn?.(tryParseJson(raw), raw) === true;
    this.publisherOnline = online;
    this.log.debug(`Source "${this.name}" availability <- ${raw} => ${online ? "online" : "offline"}`);
    if (!online) {
      if (!this.degraded) {
        this.log.info(`Source "${this.name}" publisher offline (${this.availabilityTopic})`);
        this.update(this.value, true);
      }
      return;
    }
    // Back online: the last value is current again (the publisher re-sends
    // retained state anyway). Never invent a value we haven't seen.
    if (this.degraded && this.value !== undefined) {
      this.update(this.value, false);
    }
  }
}
