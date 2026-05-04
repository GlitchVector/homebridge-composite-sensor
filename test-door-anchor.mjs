// Standalone tests for the door-anchor mode added in v0.7.0.
// Run with: node test-door-anchor.mjs (after npm run build).
//
// Validates the design from docs/smarthome/somebody-home-design.md:
//   1. Door event → schedule check at +N (cancels prior pending).
//   2. Check fires: any FP2 active → home; all silent → away.
//   3. Sticky between events: expression-source falls don't change state.
//   4. Optional auto-correct: expression-source rising edge while away → home.
// Plus persistence of pendingDoorCheckAt across restarts.

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

function makePlatform(persistDir) {
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
  const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), "composite-sensor-door-anchor-"));
  const platform = makePlatform(persistDir);

  // --- D1: cold-start defaults to home; door check with FP2 active stays home ---
  {
    const fp2 = new FakeSource("fp2", fakeLog);
    const door = new FakeSource("door", fakeLog);
    const sources = new Map([["fp2", fp2], ["door", door]]);
    const sensor = new CompositeSensor(platform, fakeAccessory, {
      name: "Test D1",
      service: "occupancy",
      mode: "door-anchor",
      doorSource: "door",
      expression: "fp2",
      checkAfterMinutes: 0.05 / 60,
      autoCorrectOnPresence: false, // isolate rule 2+3, no rule-4 interference
      onDegraded: "lastKnown",
    }, sources);
    expect("D1a: cold-start defaults to home (per design)", sensor["currentValue"], true);
    fp2.push(true);
    door.push(true);
    await sleep(80);
    expect("D1b: check fires with FP2 active → state remains home", sensor["currentValue"], true);
    sensor.stop();
  }

  // --- D1b: cold-start defaults to home, then rule 2+3 confirms ---
  {
    const fp2 = new FakeSource("fp2", fakeLog);
    const door = new FakeSource("door", fakeLog);
    const sources = new Map([["fp2", fp2], ["door", door]]);
    const sensor = new CompositeSensor(platform, fakeAccessory, {
      name: "Test D1b",
      service: "occupancy",
      mode: "door-anchor",
      doorSource: "door",
      expression: "fp2",
      checkAfterMinutes: 0.05 / 60,
      autoCorrectOnPresence: false,
    }, sources);
    sensor["currentValue"] = false; // simulate prior away state, force the path under test
    fp2.push(true);
    door.push(true);
    expect("D1b-a: state still false before check fires", sensor["currentValue"], false);
    await sleep(80);
    expect("D1b-b: check fires with FP2 active → home", sensor["currentValue"], true);
    sensor.stop();
  }

  // --- D2: rule 3, door event with FP2 silent → away ---
  {
    const fp2 = new FakeSource("fp2", fakeLog);
    const door = new FakeSource("door", fakeLog);
    const sources = new Map([["fp2", fp2], ["door", door]]);
    const sensor = new CompositeSensor(platform, fakeAccessory, {
      name: "Test D2",
      service: "occupancy",
      mode: "door-anchor",
      doorSource: "door",
      expression: "fp2",
      checkAfterMinutes: 0.05 / 60,
    }, sources);
    fp2.push(true);
    sensor["currentValue"] = true; // pretend we were home
    fp2.push(false);
    door.push(true);
    await sleep(80);
    expect("D2: door check with FP2 silent → away", sensor["currentValue"], false);
    sensor.stop();
  }

  // --- D3: rule 1 stickiness, FP2 fall between door events does nothing ---
  {
    const fp2 = new FakeSource("fp2", fakeLog);
    const door = new FakeSource("door", fakeLog);
    const sources = new Map([["fp2", fp2], ["door", door]]);
    const sensor = new CompositeSensor(platform, fakeAccessory, {
      name: "Test D3",
      service: "occupancy",
      mode: "door-anchor",
      doorSource: "door",
      expression: "fp2",
      checkAfterMinutes: 1, // long enough that no check fires during this test
    }, sources);
    sensor["currentValue"] = true; // pretend home
    fp2.push(true);
    fp2.push(false);  // bathroom / sleep — FP2 silence
    expect("D3a: FP2 fall WITHOUT door event leaves state untouched", sensor["currentValue"], true);
    fp2.push(true);
    expect("D3b: FP2 rise WITHOUT door event leaves state untouched (already true)", sensor["currentValue"], true);
    sensor.stop();
  }

  // --- D4: rule 4 auto-correct: state=false, FP2 rises → home ---
  {
    const fp2 = new FakeSource("fp2", fakeLog);
    const door = new FakeSource("door", fakeLog);
    const sources = new Map([["fp2", fp2], ["door", door]]);
    const sensor = new CompositeSensor(platform, fakeAccessory, {
      name: "Test D4",
      service: "occupancy",
      mode: "door-anchor",
      doorSource: "door",
      expression: "fp2",
      checkAfterMinutes: 0.05 / 60,
      autoCorrectOnPresence: true,
    }, sources);
    fp2.push(false);
    door.push(true);
    await sleep(80);
    expect("D4a: away after door+silent", sensor["currentValue"], false);
    fp2.push(true);   // remaining occupant moves
    expect("D4b: auto-correct kicks state back to home", sensor["currentValue"], true);
    sensor.stop();
  }

  // --- D5: autoCorrectOnPresence=false respects user preference ---
  {
    const fp2 = new FakeSource("fp2", fakeLog);
    const door = new FakeSource("door", fakeLog);
    const sources = new Map([["fp2", fp2], ["door", door]]);
    const sensor = new CompositeSensor(platform, fakeAccessory, {
      name: "Test D5",
      service: "occupancy",
      mode: "door-anchor",
      doorSource: "door",
      expression: "fp2",
      checkAfterMinutes: 0.05 / 60,
      autoCorrectOnPresence: false,
    }, sources);
    fp2.push(false);
    door.push(true);
    await sleep(80);
    expect("D5a: away after door+silent", sensor["currentValue"], false);
    fp2.push(true);
    expect("D5b: NO auto-correct, stays away until next door event", sensor["currentValue"], false);
    sensor.stop();
  }

  // --- D6: rule 2, second door event cancels first pending check ---
  {
    const fp2 = new FakeSource("fp2", fakeLog);
    const door = new FakeSource("door", fakeLog);
    const sources = new Map([["fp2", fp2], ["door", door]]);
    const sensor = new CompositeSensor(platform, fakeAccessory, {
      name: "Test D6",
      service: "occupancy",
      mode: "door-anchor",
      doorSource: "door",
      expression: "fp2",
      checkAfterMinutes: 0.05 / 60,
    }, sources);
    sensor["currentValue"] = true;
    fp2.push(false);
    door.push(true);          // schedules check #1 in 50ms
    await sleep(20);
    fp2.push(true);           // FP2 came back ahead of check #1
    door.push(false);         // door close — schedules check #2 (cancels #1)
    await sleep(80);
    expect("D6: re-schedule used latest FP2 value (true) → home", sensor["currentValue"], true);
    sensor.stop();
  }

  // --- D7: persistence — pendingDoorCheckAt survives a restart ---
  {
    const fp2_1 = new FakeSource("fp2", fakeLog);
    const door_1 = new FakeSource("door", fakeLog);
    const sources_1 = new Map([["fp2", fp2_1], ["door", door_1]]);
    const sensor_1 = new CompositeSensor(platform, fakeAccessory, {
      name: "Test D7",
      service: "occupancy",
      mode: "door-anchor",
      doorSource: "door",
      expression: "fp2",
      checkAfterMinutes: 1, // long deadline so we can verify persistence
    }, sources_1);
    sensor_1["currentValue"] = true;
    fp2_1.push(true);
    door_1.push(true);  // schedules check ~60s out — persisted
    sensor_1.stop();
    const file = path.join(persistDir, "composite-sensor-test-d7.json");
    const onDisk = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect("D7a: pendingDoorCheckAt written to disk", typeof onDisk.pendingDoorCheckAt, "string");

    // Now simulate restart with deadline already past (rewrite file)
    onDisk.pendingDoorCheckAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(onDisk));

    const fp2_2 = new FakeSource("fp2", fakeLog);
    fp2_2.push(false);  // assume FP2 silent at "restart"
    const door_2 = new FakeSource("door", fakeLog);
    const sources_2 = new Map([["fp2", fp2_2], ["door", door_2]]);
    const sensor_2 = new CompositeSensor(platform, fakeAccessory, {
      name: "Test D7",
      service: "occupancy",
      mode: "door-anchor",
      doorSource: "door",
      expression: "fp2",
      checkAfterMinutes: 1,
    }, sources_2);
    // Past deadline → check fires immediately during construction.
    expect("D7b: stale pendingDoorCheckAt fires check at restart → away", sensor_2["currentValue"], false);
    sensor_2.stop();
  }

  // --- D8: doorSource missing in config rejects loudly ---
  {
    const fp2 = new FakeSource("fp2", fakeLog);
    const sources = new Map([["fp2", fp2]]);
    let threw = false;
    try {
      new CompositeSensor(platform, fakeAccessory, {
        name: "Test D8",
        service: "occupancy",
        mode: "door-anchor",
        expression: "fp2",
        // no doorSource
      }, sources);
    } catch {
      threw = true;
    }
    expect("D8: missing doorSource throws", threw, true);
  }

  // --- D10: degraded source on one OR-branch must NOT poison fresh false on the other ---
  // Regression: pre-0.7.1 short-circuited the entire evaluation to lastKnown
  // policy as soon as ANY source was degraded, regardless of whether other
  // (working) sources had already decided the result. Real-world scenario:
  // FP2-livingroom HAP TCP drops, FP2-office reports silent (user is away),
  // expression `office OR couch` yielded lastKnown=true → stuck home.
  {
    const office = new FakeSource("office", fakeLog);
    const couch = new FakeSource("couch", fakeLog);  // simulates fp2-livingroom branch
    const door = new FakeSource("door", fakeLog);
    const sources = new Map([["office", office], ["couch", couch], ["door", door]]);
    const sensor = new CompositeSensor(platform, fakeAccessory, {
      name: "Test D10",
      service: "occupancy",
      mode: "door-anchor",
      doorSource: "door",
      expression: "office OR couch",
      checkAfterMinutes: 0.05 / 60,
      onDegraded: "false",
    }, sources);
    sensor["currentValue"] = true;     // pretend we were home
    sensor["lastKnown"] = true;
    sensor["hasSeenAnyValue"] = true;
    office.push(false);                // office working, reports silent
    couch.push(undefined, true);       // livingroom branch degraded
    door.push(true);
    await sleep(80);
    expect("D10: degraded branch does NOT poison fresh false → away", sensor["currentValue"], false);
    sensor.stop();
  }

  // --- D11: working branch reporting true wins over a degraded sibling ---
  // Symmetric: even with one sibling degraded, a single fresh `true` should
  // pass through OR untouched (Kleene short-circuit).
  {
    const office = new FakeSource("office", fakeLog);
    const couch = new FakeSource("couch", fakeLog);
    const door = new FakeSource("door", fakeLog);
    const sources = new Map([["office", office], ["couch", couch], ["door", door]]);
    const sensor = new CompositeSensor(platform, fakeAccessory, {
      name: "Test D11",
      service: "occupancy",
      mode: "door-anchor",
      doorSource: "door",
      expression: "office OR couch",
      checkAfterMinutes: 0.05 / 60,
      onDegraded: "false",
    }, sources);
    sensor["currentValue"] = false;
    office.push(true);                 // someone in office
    couch.push(undefined, true);       // livingroom branch degraded
    door.push(true);
    await sleep(80);
    expect("D11: degraded branch does NOT mask working true → home", sensor["currentValue"], true);
    sensor.stop();
  }

  // --- D9: doorSource pointing at unknown source rejects ---
  {
    const fp2 = new FakeSource("fp2", fakeLog);
    const sources = new Map([["fp2", fp2]]);
    let threw = false;
    try {
      new CompositeSensor(platform, fakeAccessory, {
        name: "Test D9",
        service: "occupancy",
        mode: "door-anchor",
        doorSource: "nonexistent",
        expression: "fp2",
      }, sources);
    } catch {
      threw = true;
    }
    expect("D9: unknown doorSource throws", threw, true);
  }

  console.log(failed === 0 ? "\nALL DOOR-ANCHOR TESTS PASSED" : `\n${failed} TESTS FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
