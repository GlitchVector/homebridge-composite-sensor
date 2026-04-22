import { Logger } from "homebridge";
import mqtt, { MqttClient } from "mqtt";
import { backoffMs } from "./source.js";

export interface MqttConfig {
  url: string;
  username?: string;
  password?: string;
  clientId?: string;
}

type Handler = (raw: string) => void;

/**
 * Shared MQTT connection. All MqttSource instances subscribe through the
 * same broker so we only hold one TCP connection regardless of how many
 * sources are defined.
 *
 * Manages its own reconnect loop with exponential backoff + jitter; mqtt.js
 * auto-reconnect is disabled so backoff is deterministic.
 */
export class MqttBroker {
  private client?: MqttClient;
  private readonly handlers = new Map<string, Handler[]>();
  private reconnectAttempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;
  private connected = false;

  public readonly listeners = new Set<(connected: boolean) => void>();

  constructor(
    private readonly config: MqttConfig,
    private readonly log: Logger,
  ) {}

  start(): void {
    if (this.client || this.stopped) {
      return;
    }
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.client?.end(true);
    this.client = undefined;
    this.setConnected(false);
  }

  /**
   * Subscribe to a topic. Safe to call before the connection is up — the
   * subscription is re-issued on every successful (re)connect.
   */
  subscribe(topic: string, handler: Handler): void {
    const list = this.handlers.get(topic) ?? [];
    list.push(handler);
    this.handlers.set(topic, list);
    if (this.connected && this.client) {
      this.client.subscribe(topic, (err) => {
        if (err) {
          this.log.warn(`MQTT subscribe "${topic}" failed:`, err.message);
        }
      });
    }
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }
    this.log.info(`MQTT connecting to ${this.config.url}`);
    const client = mqtt.connect(this.config.url, {
      username: this.config.username,
      password: this.config.password,
      clientId: this.config.clientId,
      reconnectPeriod: 0,
      connectTimeout: 15_000,
    });
    this.client = client;

    client.on("connect", () => {
      this.reconnectAttempt = 0;
      this.setConnected(true);
      this.log.info("MQTT connected");
      for (const topic of this.handlers.keys()) {
        client.subscribe(topic, (err) => {
          if (err) {
            this.log.warn(`MQTT subscribe "${topic}" failed:`, err.message);
          }
        });
      }
    });

    client.on("message", (topic, buf) => {
      const raw = buf.toString();
      const handlers = this.handlers.get(topic);
      if (!handlers) {
        return;
      }
      for (const h of handlers) {
        try {
          h(raw);
        } catch (err) {
          this.log.warn(`MQTT handler for "${topic}" threw:`, (err as Error).message);
        }
      }
    });

    const onDisconnect = (reason: string) => {
      if (this.stopped) {
        return;
      }
      this.setConnected(false);
      this.client?.end(true);
      this.client = undefined;
      const delay = backoffMs(this.reconnectAttempt++);
      this.log.warn(`MQTT ${reason}; reconnecting in ${Math.round(delay / 1000)}s`);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };

    client.on("error", (err) => onDisconnect(`error: ${err.message}`));
    client.on("close", () => onDisconnect("closed"));
  }

  private setConnected(v: boolean): void {
    if (this.connected === v) {
      return;
    }
    this.connected = v;
    for (const l of this.listeners) {
      l(v);
    }
  }
}
