# homebridge-composite-sensor

Homebridge platform plugin that exposes **composite sensors** whose state is
derived from other accessories' states via **MQTT** and **HAP**.

Useful for building logical sensors like _"somebody home"_ by combining signals
across plugins that don't natively talk to each other.

## How it works

Config has four sections:

- **`mqtt`** — a single broker connection, shared by all MQTT sources.
- **`hapBridges`** — one entry per Homebridge (child bridge) you want to read
  from. Connection is **direct via `host:port`** (not mDNS) so the plugin
  works on multi-interface hosts like QNAP where service advertisements on
  each network bridge confuse discovery libraries. Use `127.0.0.1` when the
  target bridge is in the same Homebridge container as this plugin.
- **`sources`** — first-class named boolean signals. Each source has a `type`
  (`mqtt` or `hap`) and the details needed to resolve a stream of values into
  a boolean.
- **`sensors`** — Home-app accessories. Each sensor has a boolean
  **`expression`** over source names (`AND` / `OR` / `NOT` / parentheses),
  a `service` type (`motion`, `occupancy`, `contact`), a `holdSeconds` debounce
  for true→false transitions, and an `onDegraded` policy.

## Example

```json
{
  "platform": "CompositeSensor",
  "mqtt": { "url": "mqtt://192.168.1.10:1883", "username": "hb", "password": "…" },
  "hapBridges": [
    { "name": "hue", "host": "127.0.0.1", "port": 51827, "pin": "031-45-154" }
  ],
  "sources": [
    { "name": "kitchenMotion", "type": "mqtt", "topic": "zigbee2mqtt/kitchen_motion", "map": "payload.occupancy" },
    { "name": "phoneHome",     "type": "hap",  "bridge": "hue", "accessory": "Remo's iPhone", "characteristic": "On" }
  ],
  "sensors": [
    {
      "name": "Somebody Home",
      "service": "motion",
      "expression": "phoneHome OR kitchenMotion",
      "holdSeconds": 60,
      "onDegraded": "lastKnown"
    }
  ]
}
```

## Debounce semantics

- `false → true` emits **immediately** (no flapping complaints in Home
  automations).
- `true → false` waits `holdSeconds` and only emits `false` if the expression
  is still false at the end of the hold.

## Degraded-state policy

Every source starts in a **degraded** state until its transport delivers a
first value. Per-sensor `onDegraded` decides the emitted value while *any*
referenced source is degraded:

- `"false"` — treat as off (safe default for motion).
- `"true"` — treat as on (useful for inverted "nobody home" logic).
- `"lastKnown"` — reuse the last observed value; fall back to `false` if we've
  never seen one.

## License

Apache-2.0
