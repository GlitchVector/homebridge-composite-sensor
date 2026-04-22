/**
 * Compile a tiny "map" expression used by the MQTT source to coerce an
 * incoming payload into a boolean.
 *
 * The expression is a JS expression that may reference two inputs:
 *   - `payload`: the JSON-parsed payload, or `undefined` if not valid JSON
 *   - `raw`: the raw string payload
 *
 * Examples: `payload.occupancy`, `raw == "ON"`, `payload.state === "open"`.
 *
 * This runs with `new Function`, so it is NOT a sandbox against hostile
 * code — config comes from the same filesystem as the plugin itself (the
 * user is the only one writing these). The wrapper just pins the input
 * shape and coerces the result to boolean.
 */
export type MapFn = (payload: unknown, raw: string) => boolean;

export function compileMap(expr: string): MapFn {
  let fn: (payload: unknown, raw: string) => unknown;
  try {
    fn = new Function("payload", "raw", `"use strict"; return (${expr});`) as (
      payload: unknown,
      raw: string,
    ) => unknown;
  } catch (err) {
    throw new Error(`Invalid map expression "${expr}": ${(err as Error).message}`);
  }
  return (payload, raw) => {
    try {
      return !!fn(payload, raw);
    } catch {
      return false;
    }
  };
}

/**
 * Try to JSON.parse a raw MQTT payload; return undefined if it isn't JSON.
 * Numbers, booleans, strings, arrays, and objects all parse successfully.
 */
export function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
