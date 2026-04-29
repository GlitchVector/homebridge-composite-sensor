// Standalone state-persistence tests for CompositeSensor lastKnown survival
// across restarts. Run with: node test-persistence.mjs (after npm run build).
//
// Validates the bug fixed in v0.6.0: before the fix, every homebridge restart
// caused the sensor to publish `false` first and then jump to `true` once
// sources resolved, firing rising-edge automations every time the container
// recreated.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

function makePlatformWithPersist(persistDir) {
  return {
    log: fakeLog,
    Service: FakeService,
    Characteristic: ch,
    api: { user: { persistPath: () => persistDir } },
  };
}

let failed = 0;
function expect(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  actual=${actual}  expected=${expected}`);
  if (!ok) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), "composite-sensor-test-"));
  const platform = makePlatformWithPersist(persistDir);

  // --- P1: first construction with no persisted state behaves as old version ---
  {
    const presence = new FakeSource("presence", fakeLog);
    const sources = new Map([["presence", presence]]);
    const sensor = new CompositeSensor(platform, fakeAccessory, {
      name: "Test P1",
      service: "occupancy",
      expression: "presence",
      onDegraded: "false",
    }, sources);
    expect("P1a: cold-start currentValue=false", sensor["currentValue"], false);
    presence.push(true);
    expect("P1b: rising edge → true", sensor["currentValue"], true);
    sensor.stop();
  }

  // --- P2: lastKnown=true survives restart, currentValue restored to true ---
  {
    const presence1 = new FakeSource("presence", fakeLog);
    const sources1 = new Map([["presence", presence1]]);
    const sensor1 = new CompositeSensor(platform, fakeAccessory, {
      name: "Test P2",
      service: "occupancy",
      expression: "presence",
      onDegraded: "lastKnown",
    }, sources1);
    presence1.push(true);
    expect("P2a: pre-restart currentValue=true", sensor1["currentValue"], true);
    sensor1.stop();

    // Verify the file actually got written
    const file = path.join(persistDir, "composite-sensor-test-p2.json");
    const onDisk = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect("P2b: file written with lastKnown=true", onDisk.lastKnown, true);
    expect("P2c: file written with currentValue=true", onDisk.currentValue, true);
    expect("P2d: file written with hasSeenAnyValue=true", onDisk.hasSeenAnyValue, true);

    // "Restart": new sensor instance, source starts degraded
    const presence2 = new FakeSource("presence", fakeLog);
    // do NOT push — leaves source degraded, simulating sources still
    // reconnecting after homebridge restart
    const sources2 = new Map([["presence", presence2]]);
    const sensor2 = new CompositeSensor(platform, fakeAccessory, {
      name: "Test P2",
      service: "occupancy",
      expression: "presence",
      onDegraded: "lastKnown",
    }, sources2);
    expect("P2e: post-restart currentValue=true (no rising edge!)", sensor2["currentValue"], true);
    expect("P2f: post-restart lastKnown=true", sensor2["lastKnown"], true);
    expect("P2g: post-restart hasSeenAnyValue=true", sensor2["hasSeenAnyValue"], true);
    sensor2.stop();
  }

  // --- P3: lastKnown=false also survives — sensor doesn't spuriously go true ---
  {
    const presence1 = new FakeSource("presence", fakeLog);
    const sources1 = new Map([["presence", presence1]]);
    const sensor1 = new CompositeSensor(platform, fakeAccessory, {
      name: "Test P3",
      service: "occupancy",
      expression: "presence",
      onDegraded: "lastKnown",
    }, sources1);
    presence1.push(true);
    presence1.push(false);
    expect("P3a: pre-restart currentValue=false", sensor1["currentValue"], false);
    sensor1.stop();

    const presence2 = new FakeSource("presence", fakeLog);
    const sources2 = new Map([["presence", presence2]]);
    const sensor2 = new CompositeSensor(platform, fakeAccessory, {
      name: "Test P3",
      service: "occupancy",
      expression: "presence",
      onDegraded: "lastKnown",
    }, sources2);
    expect("P3b: post-restart currentValue=false", sensor2["currentValue"], false);
    sensor2.stop();
  }

  // --- P4: corrupt JSON is handled gracefully (warn + cold-start defaults) ---
  {
    const file = path.join(persistDir, "composite-sensor-test-p4.json");
    fs.writeFileSync(file, "{not valid json");
    const presence = new FakeSource("presence", fakeLog);
    const sources = new Map([["presence", presence]]);
    const sensor = new CompositeSensor(platform, fakeAccessory, {
      name: "Test P4",
      service: "occupancy",
      expression: "presence",
      onDegraded: "false",
    }, sources);
    expect("P4: corrupt file → cold-start currentValue=false", sensor["currentValue"], false);
    sensor.stop();
  }

  // --- P5: missing fields in persisted JSON → ignored, cold-start defaults ---
  {
    const file = path.join(persistDir, "composite-sensor-test-p5.json");
    fs.writeFileSync(file, JSON.stringify({ lastKnown: true }));  // missing fields
    const presence = new FakeSource("presence", fakeLog);
    const sources = new Map([["presence", presence]]);
    const sensor = new CompositeSensor(platform, fakeAccessory, {
      name: "Test P5",
      service: "occupancy",
      expression: "presence",
      onDegraded: "false",
    }, sources);
    expect("P5: incomplete file → cold-start currentValue=false", sensor["currentValue"], false);
    sensor.stop();
  }

  // --- P6: no platform.api (legacy test harness) → no persistence, no crash ---
  {
    const platformNoApi = { log: fakeLog, Service: FakeService, Characteristic: ch };
    const presence = new FakeSource("presence", fakeLog);
    const sources = new Map([["presence", presence]]);
    const sensor = new CompositeSensor(platformNoApi, fakeAccessory, {
      name: "Test P6",
      service: "occupancy",
      expression: "presence",
      onDegraded: "false",
    }, sources);
    presence.push(true);
    expect("P6: works without persistence", sensor["currentValue"], true);
    sensor.stop();
  }

  // --- P7: name with special chars gets a clean filename slug ---
  {
    const presence = new FakeSource("presence", fakeLog);
    const sources = new Map([["presence", presence]]);
    const sensor = new CompositeSensor(platform, fakeAccessory, {
      name: "Somebody Home!",
      service: "occupancy",
      expression: "presence",
      onDegraded: "lastKnown",
    }, sources);
    presence.push(true);
    sensor.stop();
    const expected = path.join(persistDir, "composite-sensor-somebody-home.json");
    expect("P7: special-char name slugified to somebody-home", fs.existsSync(expected), true);
  }

  // Cleanup test dir
  fs.rmSync(persistDir, { recursive: true, force: true });

  console.log(`\n${failed === 0 ? "ALL GREEN" : `${failed} FAILURE(S)`}`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
