// Standalone tests for the set-reset mode added in v0.7.3.
// Run with: node test-set-reset.mjs (after npm run build).

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
function assertEq(label, actual, expected) {
  const pass = actual === expected;
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}  actual=${actual}  expected=${expected}`);
}

function makeSensor(persistDir, opts = {}) {
  const motion = new FakeSource("motion", fakeLog);
  const fp2a = new FakeSource("fp2a", fakeLog);
  const fp2b = new FakeSource("fp2b", fakeLog);
  const sources = new Map([["motion", motion], ["fp2a", fp2a], ["fp2b", fp2b]]);
  const config = {
    name: "Bathroom Occupied",
    service: "occupancy",
    mode: "set-reset",
    setOn: opts.setOn ?? "motion",
    resetOn: opts.resetOn ?? "fp2a OR fp2b",
  };
  const platform = makePlatform(persistDir);
  const sensor = new CompositeSensor(platform, fakeAccessory, config, sources);
  return { sensor, motion, fp2a, fp2b };
}

// S1: cold-start defaults to false
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "set-reset-s1-"));
  const { sensor } = makeSensor(dir);
  assertEq("S1: cold-start currentValue=false", sensor["currentValue"], false);
  fs.rmSync(dir, { recursive: true, force: true });
}

// S2: motion rising-edge while no FP2 active → state=true
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "set-reset-s2-"));
  const { sensor, motion, fp2a, fp2b } = makeSensor(dir);
  // Initialize all sources to known false (not undefined) so rising edges register.
  motion.push(false); fp2a.push(false); fp2b.push(false);
  assertEq("S2a: still false after baseline", sensor["currentValue"], false);
  motion.push(true);
  assertEq("S2b: motion rising → true", sensor["currentValue"], true);
  fs.rmSync(dir, { recursive: true, force: true });
}

// S3: motion stops, state stays sticky true
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "set-reset-s3-"));
  const { sensor, motion, fp2a, fp2b } = makeSensor(dir);
  motion.push(false); fp2a.push(false); fp2b.push(false);
  motion.push(true);
  assertEq("S3a: motion → true", sensor["currentValue"], true);
  motion.push(false);
  assertEq("S3b: motion falling → still true (sticky)", sensor["currentValue"], true);
  fs.rmSync(dir, { recursive: true, force: true });
}

// S4: any FP2 rising → state=false
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "set-reset-s4-"));
  const { sensor, motion, fp2a, fp2b } = makeSensor(dir);
  motion.push(false); fp2a.push(false); fp2b.push(false);
  motion.push(true);
  assertEq("S4a: motion → true", sensor["currentValue"], true);
  fp2b.push(true);
  assertEq("S4b: fp2b rising → false", sensor["currentValue"], false);
  fs.rmSync(dir, { recursive: true, force: true });
}

// S5: motion rises while resetOn currently true → STILL SETS (FP2 lag tolerance)
// FP2 zones have ~2s+ settle lag; when a user walks from a covered zone into a
// Hue-only room, the previous FP2 zone is still ringing at the moment Hue
// motion fires. The set-reset state machine must not block this. False
// positives belong upstream in the setOn expression, not in a guard here.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "set-reset-s5-"));
  const { sensor, motion, fp2a, fp2b } = makeSensor(dir);
  motion.push(false); fp2a.push(true); fp2b.push(false);
  assertEq("S5a: still false at baseline despite fp2a active", sensor["currentValue"], false);
  motion.push(true);
  assertEq("S5b: motion rises while fp2a still true → flips true (no guard)", sensor["currentValue"], true);
  fs.rmSync(dir, { recursive: true, force: true });
}

// S5b: per-source rising edge in resetOn fires even if expression already true.
// Models the real-world FP2 case: user walks living→bathroom→coffee. loggia
// FP2 lingers true while user is in bathroom (state=true). Then coffeeCorner
// FP2 rises; resetOn-aggregate stayed true→true (whole-expression no-edge),
// but a per-source rising edge of coffeeCorner with resetOn currently true
// must fire reset.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "set-reset-s5b-"));
  const { sensor, motion, fp2a, fp2b } = makeSensor(dir);
  motion.push(false); fp2a.push(false); fp2b.push(false);
  // Lingering FP2 zone (fp2a) is true when user enters bathroom.
  fp2a.push(true);
  motion.push(true);
  assertEq("S5b-1: motion rises while fp2a lingering true → state=true", sensor["currentValue"], true);
  // Now another FP2 zone (fp2b) rises; fp2a is still true so resetOn aggregate
  // is true→true (no whole-expression edge). Per-source must catch fp2b's rise.
  fp2b.push(true);
  assertEq("S5b-2: fp2b rises while fp2a still true → state=false (per-source edge)", sensor["currentValue"], false);
  fs.rmSync(dir, { recursive: true, force: true });
}

// S5c: falling-edge (NOT X) trigger — bathroom light turned off → reset.
// Models: setOn = motion, resetOn = anyFp2 OR NOT bathroomLight. User flips
// the light off when leaving — bathroomLight goes true→false, the NOT-leaf
// transitions false→true, which fires the reset even if no FP2 zone is rising.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "set-reset-s5c-"));
  const motion = new FakeSource("motion", fakeLog);
  const fp2 = new FakeSource("fp2", fakeLog);
  const light = new FakeSource("light", fakeLog);
  const sources = new Map([["motion", motion], ["fp2", fp2], ["light", light]]);
  const platform = makePlatform(dir);
  const sensor = new CompositeSensor(platform, fakeAccessory, {
    name: "Bathroom Occupied",
    service: "occupancy",
    mode: "set-reset",
    setOn: "motion",
    resetOn: "fp2 OR NOT light",
  }, sources);
  // Baseline: light is on (user is in bathroom), no FP2.
  motion.push(false); fp2.push(false); light.push(true);
  motion.push(true);
  assertEq("S5c-1: motion rises while light on → state=true", sensor["currentValue"], true);
  // User flips light off when leaving.
  light.push(false);
  assertEq("S5c-2: light goes off (NOT light rises) → state=false", sensor["currentValue"], false);
  fs.rmSync(dir, { recursive: true, force: true });
}

// S6: simultaneous set + reset rise → reset wins
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "set-reset-s6-"));
  const { sensor, motion, fp2a, fp2b } = makeSensor(dir);
  motion.push(false); fp2a.push(false); fp2b.push(false);
  motion.push(true);
  assertEq("S6a: motion → true", sensor["currentValue"], true);
  motion.push(false); fp2a.push(false); fp2b.push(false);
  fp2a.push(true);
  assertEq("S6b: fp2a rising → false", sensor["currentValue"], false);
  // Now: motion is false. Push fp2a back to false, then motion+fp2a rise together.
  fp2a.push(false);
  motion.push(true);
  assertEq("S6c: motion rose alone → true (fp2a false)", sensor["currentValue"], true);
  // Now make resetOn rise; reset wins even if state was just set.
  fp2a.push(true);
  assertEq("S6d: fp2a rises → false", sensor["currentValue"], false);
  fs.rmSync(dir, { recursive: true, force: true });
}

// S7: undefined→true is NOT a rising edge (avoids startup false-positive)
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "set-reset-s7-"));
  const { sensor, motion, fp2a, fp2b } = makeSensor(dir);
  // Sources start undefined. First push of true should NOT count as edge.
  motion.push(true);
  assertEq("S7a: undefined→true on motion → still false (no edge)", sensor["currentValue"], false);
  fp2a.push(true);
  assertEq("S7b: undefined→true on fp2a → still false", sensor["currentValue"], false);
  fs.rmSync(dir, { recursive: true, force: true });
}

// S8: state DOES NOT survive restart — set-reset always cold-starts at false.
// Bathroom occupancy is ephemeral; persisting it across a homebridge restart
// would falsely report "user is in bathroom" for an empty room.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "set-reset-s8-"));
  {
    const { sensor, motion, fp2a, fp2b } = makeSensor(dir);
    motion.push(false); fp2a.push(false); fp2b.push(false);
    motion.push(true);
    assertEq("S8a: pre-restart currentValue=true", sensor["currentValue"], true);
  }
  {
    const { sensor } = makeSensor(dir);
    assertEq("S8b: post-restart currentValue=false (cold-start)", sensor["currentValue"], false);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// S9: missing setOn or resetOn throws
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "set-reset-s9-"));
  let threw = false;
  try {
    const motion = new FakeSource("motion", fakeLog);
    const sources = new Map([["motion", motion]]);
    new CompositeSensor(makePlatform(dir), fakeAccessory, {
      name: "X", service: "occupancy", mode: "set-reset", setOn: "motion",
    }, sources);
  } catch { threw = true; }
  assertEq("S9: missing resetOn throws", threw, true);
  fs.rmSync(dir, { recursive: true, force: true });
}

// S10: latchUntilEdgeOf incompatible with set-reset
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "set-reset-s10-"));
  let threw = false;
  try {
    const motion = new FakeSource("motion", fakeLog);
    const fp2 = new FakeSource("fp2", fakeLog);
    const sources = new Map([["motion", motion], ["fp2", fp2]]);
    new CompositeSensor(makePlatform(dir), fakeAccessory, {
      name: "X", service: "occupancy", mode: "set-reset",
      setOn: "motion", resetOn: "fp2", latchUntilEdgeOf: "motion",
    }, sources);
  } catch { threw = true; }
  assertEq("S10: latchUntilEdgeOf with set-reset throws", threw, true);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nALL SET-RESET TESTS PASSED" : `\n${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
