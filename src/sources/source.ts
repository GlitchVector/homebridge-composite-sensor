import { EventEmitter } from "events";
import { Logger } from "homebridge";

/**
 * A Source is a named boolean signal derived from some transport (MQTT, HAP, …).
 *
 * Contract:
 *  - Every source starts in `degraded = true` with `value = undefined` until
 *    its transport delivers the first usable value.
 *  - Sources never throw out of `start()`; transport failures are handled
 *    internally and surfaced as `degraded = true` with exponential-backoff
 *    reconnect. Plugin startup must not block on any source.
 *  - Emits `"change"` whenever `value` or `degraded` transitions.
 */
export abstract class Source extends EventEmitter {
  public value: boolean | undefined = undefined;
  public degraded = true;
  /**
   * Monotonic `Date.now()` when this source last transitioned true→false
   * (a "falling edge"). Undefined until the source has had such a
   * transition. Consumed by composite sensors that latch on presence and
   * only release on a recent exit-trigger edge.
   */
  public lastFallingEdgeAt: number | undefined;

  constructor(
    public readonly name: string,
    protected readonly log: Logger,
  ) {
    super();
  }

  abstract start(): void;
  abstract stop(): void;

  protected update(next: boolean | undefined, degraded: boolean): void {
    const prev = this.value;
    const changed = prev !== next || this.degraded !== degraded;
    if (prev === true && next === false) {
      this.lastFallingEdgeAt = Date.now();
    }
    this.value = next;
    this.degraded = degraded;
    if (changed) {
      this.emit("change");
    }
  }
}

/**
 * Exponential backoff with full jitter. Used for MQTT and HAP reconnect loops.
 *   attempt 0 → baseMs, capped at capMs, randomized in [0, delay).
 */
export function backoffMs(attempt: number, baseMs = 1000, capMs = 60_000): number {
  const exp = Math.min(capMs, baseMs * Math.pow(2, attempt));
  return Math.floor(Math.random() * exp);
}
