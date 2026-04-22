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
  }

  private readonly topic: string;

  start(): void {
    this.broker.subscribe(this.topic, (raw) => this.onMessage(raw));
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
    this.update(bool, false);
    this.log.debug(`Source "${this.name}" <- ${raw} => ${bool}`);
  }
}
