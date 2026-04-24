// Standalone state-machine tests for CompositeSensor latchUntilEdgeOf.
// Run with: node test-latch.mjs (after npm run build).

import { CompositeSensor } from "./dist/sensors/compositeSensor.js";
import { Source } from "./dist/sources/source.js";

class FakeSource extends Source {
  start() {}
  stop() {}
  push(val, degraded = false) { this["update"](val, degraded); }
}

class FakeCharacteristic { static UUID = "x"; }
class FakeService {
  static OccupancySensor = FakeService;
  static MotionSensor = FakeService;
  static ContactSensor = FakeService;
  static AccessoryInformation = FakeService;
  constructor() { this.value = undefined; }
  setCharacteristic() { return this; }
  getCharacteristic() { return { onGet: () => {} }; }
  updateCharacteristic(_c, v) { this.value = v; }
}
const fakeAccessory = {
  getService: () => new FakeService(),
  addService: () => new FakeService(),
};
const fakeLog = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
const ch = { OccupancyDetected: FakeCharacteristic, MotionDetected: FakeCharacteristic, ContactSensorState: FakeCharacteristic, Name: FakeCharacteristic, Manufacturer: FakeCharacteristic, Model: FakeCharacteristic, SerialNumber: FakeCharacteristic };
const fakePlatform = { log: fakeLog, Service: FakeService, Characteristic: ch };

let failed = 0;
function expect(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  actual=${actual}  expected=${expected}`);
  if (!ok) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build a ready-to-test sensor: latch source is `doorPir`, expression is `presence OR doorPir`.
// Seeds both sources to false (non-degraded) before returning, so degraded-policy doesn't skew results.
function buildSomebodyHome({ holdMs, latchWindowMs }) {
  const presence = new FakeSource("presence", fakeLog);
  const doorPir = new FakeSource("doorPir", fakeLog);
  const sources = new Map([["presence", presence], ["doorPir", doorPir]]);
  const sensor = new CompositeSensor(
    fakePlatform,
    fakeAccessory,
    {
      name: "SH",
      service: "occupancy",
      expression: "presence OR doorPir",
      holdSeconds: holdMs / 1000,
      latchUntilEdgeOf: "doorPir",
      latchEdgeWindowSeconds: latchWindowMs / 1000,
      onDegraded: "false",
    },
    sources,
  );
  // Seed both to false non-degraded so expression evaluates cleanly.
  presence.push(false);
  doorPir.push(false);
  return { sensor, presence, doorPir };
}

async function run() {
  // --- T1: latch BLOCKS flip when latch source has never had a falling edge ---
  {
    const { sensor, presence } = buildSomebodyHome({ holdMs: 300, latchWindowMs: 5000 });
    presence.push(true);
    expect("T1a: rising edge → true", sensor["currentValue"], true);
    presence.push(false);                       // expression false, but doorPir never fell → latch denies
    await sleep(500);                           // well past holdSeconds
    expect("T1b: STAYS true (latch blocks, no doorPir edge)", sensor["currentValue"], true);
    sensor.stop();
  }

  // --- T2: latch PERMITS flip after a doorPir rising + falling edge ---
  {
    const { sensor, presence, doorPir } = buildSomebodyHome({ holdMs: 300, latchWindowMs: 5000 });
    presence.push(true);
    doorPir.push(true);    // walk past door
    doorPir.push(false);   // PIR clears — falling edge recorded
    presence.push(false);  // all quiet
    await sleep(500);      // past holdSeconds
    expect("T2: flips false after doorPir falling + all quiet + hold", sensor["currentValue"], false);
    sensor.stop();
  }

  // --- T3: latch window expires BEFORE presence clears → STAYS true ---
  {
    const { sensor, presence, doorPir } = buildSomebodyHome({ holdMs: 200, latchWindowMs: 300 });
    presence.push(true);
    doorPir.push(true);
    doorPir.push(false);   // falling edge @ t=0
    await sleep(500);      // latchWindowMs (300) expired
    presence.push(false);  // now try to flip; edge is stale
    await sleep(400);      // past holdSeconds
    expect("T3: STAYS true (edge went stale before presence cleared)", sensor["currentValue"], true);
    sensor.stop();
  }

  // --- T4: latch window expires DURING hold → flip aborted at timer fire ---
  {
    const { sensor, presence, doorPir } = buildSomebodyHome({ holdMs: 600, latchWindowMs: 400 });
    presence.push(true);
    doorPir.push(true);
    doorPir.push(false);    // edge @ t=0
    presence.push(false);   // hold starts @ t=~0 (latch permits now, edge is fresh)
    // at t=600 timer fires; by then edge is 600ms old > 400ms window → permits returns false → no flip
    await sleep(800);
    expect("T4: STAYS true (latch window expired mid-hold)", sensor["currentValue"], true);
    sensor.stop();
  }

  // --- T5: presence returns during hold → flip cancelled, stays true ---
  {
    const { sensor, presence, doorPir } = buildSomebodyHome({ holdMs: 500, latchWindowMs: 5000 });
    presence.push(true);
    doorPir.push(true);
    doorPir.push(false);
    presence.push(false);  // hold starts
    await sleep(100);
    presence.push(true);   // someone came back
    await sleep(700);      // > holdSeconds
    expect("T5: stays true (presence returned mid-hold)", sensor["currentValue"], true);
    sensor.stop();
  }

  // --- T6: without latchUntilEdgeOf, behaves like plain holdSeconds (sanity check) ---
  {
    const presence = new FakeSource("presence", fakeLog);
    const sources = new Map([["presence", presence]]);
    const sensor = new CompositeSensor(
      fakePlatform, fakeAccessory,
      { name: "SH2", service: "occupancy", expression: "presence", holdSeconds: 0.3, onDegraded: "false" },
      sources,
    );
    presence.push(false);
    presence.push(true);
    presence.push(false);
    await sleep(500);
    expect("T6: plain holdSeconds (no latch) flips after hold", sensor["currentValue"], false);
    sensor.stop();
  }

  console.log(`\n${failed === 0 ? "ALL GREEN" : `${failed} FAILURE(S)`}`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
