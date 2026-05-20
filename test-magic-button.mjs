// Standalone tests for the MagicButton sensor.
// Run with: node test-magic-button.mjs (after npm run build).

import { MagicButton } from "./dist/sensors/magicButton.js";
import { EventEmitter } from "node:events";

// ──────────────────────────────────────────────────────────────────────────
// Test scaffolding — minimal homebridge-shape fakes
// ──────────────────────────────────────────────────────────────────────────

class FakeCharacteristic { static UUID = "x"; }
class FakeService {
  static Switch = FakeService;
  static AccessoryInformation = FakeService;
  constructor() {
    this.value = undefined;
    this.onGetFn = undefined;
    this.onSetFn = undefined;
  }
  setCharacteristic() { return this; }
  getCharacteristic() {
    const ch = {
      onGet: (fn) => { this.onGetFn = fn; return ch; },
      onSet: (fn) => { this.onSetFn = fn; return ch; },
    };
    return ch;
  }
  updateCharacteristic(_c, v) { this.value = v; }
}
const fakeAccessory = () => {
  const svc = new FakeService();
  return {
    _svc: svc,
    getService: () => svc,
    addService: () => svc,
  };
};
function makeLog() {
  const events = [];
  const push = (level) => (...args) => events.push({ level, args });
  return Object.assign(events, {
    info: push("info"),
    debug: push("debug"),
    warn: push("warn"),
    error: push("error"),
  });
}
const ch = { Name: FakeCharacteristic, Manufacturer: FakeCharacteristic, Model: FakeCharacteristic, SerialNumber: FakeCharacteristic, On: FakeCharacteristic };

// A HapBridge stand-in. Records every write call; exposes a `push(char, value)`
// helper to drive the subscribe listeners as if the underlying light reported
// a new state.
class FakeBridge extends EventEmitter {
  constructor() {
    super();
    this.subscriptions = new Map(); // characteristic name -> listener
    this.writes = []; // {char, value, ts}
    this.writeShouldFail = false;
  }
  subscribe(matcher, listener) {
    this.subscriptions.set(matcher.characteristic, listener);
  }
  async write(matcher, value) {
    if (this.writeShouldFail) {
      throw new Error("simulated write failure");
    }
    this.writes.push({ char: matcher.characteristic, value });
  }
  push(char, value) {
    const l = this.subscriptions.get(char);
    if (!l) throw new Error(`no subscriber for ${char}`);
    l(value, false);
  }
  pushDegraded(char) {
    const l = this.subscriptions.get(char);
    if (!l) throw new Error(`no subscriber for ${char}`);
    l(undefined, true);
  }
  clear() { this.writes.length = 0; }
}

function makePlatform() {
  return {
    log: makeLog(),
    Service: FakeService,
    Characteristic: ch,
  };
}

let failed = 0;
function assertEq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const pass = a === e;
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}  actual=${a}  expected=${e}`);
}

function makeMagicButton(opts = {}) {
  const platform = makePlatform();
  const accessory = fakeAccessory();
  const bridge = new FakeBridge();
  const bridges = new Map([["loxone", bridge]]);
  const config = {
    name: opts.name ?? "Kitchen Boost",
    service: "magic_button",
    bridge: "loxone",
    accessory: opts.accessory ?? "Kitchen Spotlight",
  };
  if (opts.target !== undefined) {
    config.target = opts.target;
  } else {
    config.targetBrightness = opts.targetBrightness ?? 100;
  }
  const mb = new MagicButton(platform, accessory, config, bridges);
  return { mb, bridge, accessory, platform };
}

function getOnHandler(accessory) {
  // The MagicButton wires its onSet via getCharacteristic(...).onSet(fn).
  // Our FakeService stores it on the service stash.
  return accessory._svc.onSetFn;
}

// ──────────────────────────────────────────────────────────────────────────
// Test cases
// ──────────────────────────────────────────────────────────────────────────

async function testActivationSnapshotsAndWrites() {
  const { mb, bridge, accessory } = makeMagicButton({ targetBrightness: 100 });
  // Light reports current state: ON at 50%.
  bridge.push("On", true);
  bridge.push("Brightness", 50);
  await getOnHandler(accessory)(true);
  // Should have written On=true then Brightness=100, in that order.
  assertEq(
    "activate: writes On=true then Brightness=100",
    bridge.writes,
    [{ char: "On", value: true }, { char: "Brightness", value: 100 }],
  );
}

async function testDeactivationRestoresSnapshot() {
  const { mb, bridge, accessory } = makeMagicButton({ targetBrightness: 100 });
  bridge.push("On", true);
  bridge.push("Brightness", 50);
  await getOnHandler(accessory)(true);
  bridge.clear();
  await getOnHandler(accessory)(false);
  // Restore order: Brightness first, then On (per implementation comment).
  assertEq(
    "deactivate: restores Brightness=50 then On=true",
    bridge.writes,
    [{ char: "Brightness", value: 50 }, { char: "On", value: true }],
  );
}

async function testCycleWhenTargetWasOff() {
  // Light was OFF (brightness recorded as 30 from earlier) → magic ON → magic OFF
  // should restore to OFF, not to 100%.
  const { mb, bridge, accessory } = makeMagicButton({ targetBrightness: 100 });
  bridge.push("On", false);
  bridge.push("Brightness", 30);
  await getOnHandler(accessory)(true);
  bridge.clear();
  await getOnHandler(accessory)(false);
  assertEq(
    "deactivate after target-was-off: restores Brightness=30 then On=false",
    bridge.writes,
    [{ char: "Brightness", value: 30 }, { char: "On", value: false }],
  );
}

async function testManualBrightnessChangeAutoOffsNoRestore() {
  // New spec (2026-05-20): manual brightness change while ON auto-OFFs
  // the magic button in HomeKit and leaves the target light untouched.
  const { mb, bridge, accessory } = makeMagicButton({ targetBrightness: 100 });
  bridge.push("On", true);
  bridge.push("Brightness", 50);
  await getOnHandler(accessory)(true);
  // Activation writes (On=true then Brightness=100). Simulate the bridge's
  // echo of our brightness write — this enables manualWatchEnabled.
  bridge.push("Brightness", 100);
  bridge.clear();

  // Manual override: user drags brightness to 75. The magic button should
  // recognize this as not our write and auto-OFF without restoring.
  bridge.push("Brightness", 75);
  assertEq(
    "manual brightness change while ON: no restore writes",
    bridge.writes,
    [],
  );
  assertEq(
    "magic button HomeKit Switch flipped to OFF after manual change",
    accessory._svc.value,
    false,
  );

  // Subsequent explicit OFF press should be a no-op (HomeKit short-circuit
  // because currentOn already false; no snapshot left to restore anyway).
  bridge.clear();
  await getOnHandler(accessory)(false);
  assertEq(
    "explicit OFF after auto-off: no further writes",
    bridge.writes,
    [],
  );
}

async function testPreEchoBrightnessUpdateDoesNotAutoOff() {
  // Race: a stale brightness update arrives between activation and our
  // write's echo. Must not trigger auto-off (manualWatchEnabled is still
  // false in pre-echo state).
  const { mb, bridge, accessory } = makeMagicButton({ targetBrightness: 100 });
  bridge.push("On", true);
  bridge.push("Brightness", 50);
  await getOnHandler(accessory)(true);
  bridge.clear();

  // Pre-echo: bridge delivers the OLD brightness one more time (e.g. a
  // watchdog refresh raced with our write).
  bridge.push("Brightness", 50);
  assertEq(
    "pre-echo stale brightness update: no auto-off, no writes",
    bridge.writes,
    [],
  );
  assertEq(
    "magic button still ON after pre-echo stale update",
    accessory._svc.value,
    undefined,  // FakeService.value only set when updateCharacteristic fires
  );

  // Now the real echo arrives.
  bridge.push("Brightness", 100);
  // And the user normally turns OFF — restore should still happen.
  await getOnHandler(accessory)(false);
  assertEq(
    "deactivate after pre-echo race and clean echo: restores original",
    bridge.writes,
    [{ char: "Brightness", value: 50 }, { char: "On", value: true }],
  );
}

async function testShortCircuitNoChange() {
  // Calling onSet(true) when already ON should be a no-op (no writes).
  const { mb, bridge, accessory } = makeMagicButton({ targetBrightness: 100 });
  bridge.push("On", true);
  bridge.push("Brightness", 50);
  await getOnHandler(accessory)(true);
  bridge.clear();
  await getOnHandler(accessory)(true); // redundant call
  assertEq(
    "redundant onSet(true) short-circuits",
    bridge.writes,
    [],
  );
}

async function testNoSnapshotOnDeactivate() {
  // Magic button starts OFF (no prior activation) → onSet(false) is a no-op.
  // This simulates "Homebridge restarted while ON, then user toggles OFF".
  const { mb, bridge, accessory } = makeMagicButton({ targetBrightness: 100 });
  bridge.push("On", true);
  bridge.push("Brightness", 50);
  // Deactivate without prior activation — currentOn is already false, so
  // handleOn(false) hits the short-circuit. To get the no-snapshot warning
  // path, manipulate currentOn to true without going through activate.
  // (Not strictly testable through the public API; we instead verify that
  // the short-circuit fires and no writes happen.)
  await getOnHandler(accessory)(false);
  assertEq(
    "onSet(false) while already off: no writes",
    bridge.writes,
    [],
  );
}

async function testActivationRejectedWhenTargetUnknown() {
  // Bridge hasn't reported any values yet → activation should reject and
  // revert HomeKit switch state.
  const { mb, bridge, accessory } = makeMagicButton({ targetBrightness: 100 });
  await getOnHandler(accessory)(true);
  assertEq(
    "activation with no target state: no writes",
    bridge.writes,
    [],
  );
}

async function testConfigValidatesTargetBrightnessRange() {
  const platform = makePlatform();
  const accessory = fakeAccessory();
  const bridge = new FakeBridge();
  const bridges = new Map([["loxone", bridge]]);
  let threw = false;
  try {
    new MagicButton(platform, accessory, {
      name: "Bad", service: "magic_button", bridge: "loxone",
      accessory: "X", targetBrightness: 200,
    }, bridges);
  } catch (e) {
    threw = /targetBrightness in \[0,100\]/.test(e.message);
  }
  assertEq("targetBrightness=200 rejected", threw, true);
}

// ──────────────────────────────────────────────────────────────────────────
// Multi-characteristic target tests (added 0.10.3)
// ──────────────────────────────────────────────────────────────────────────

async function testColorTargetActivateWritesAllChars() {
  const { bridge, accessory } = makeMagicButton({
    target: { On: true, Brightness: 100, Hue: 120, Saturation: 100 },
  });
  // Seed current state of all 4 chars
  bridge.push("On", true);
  bridge.push("Brightness", 50);
  bridge.push("Hue", 0);
  bridge.push("Saturation", 0);
  await getOnHandler(accessory)(true);
  // Expected: On first (config order), then the remaining 3 in config order.
  assertEq(
    "color activate: writes On + Brightness + Hue + Saturation",
    bridge.writes,
    [
      { char: "On", value: true },
      { char: "Brightness", value: 100 },
      { char: "Hue", value: 120 },
      { char: "Saturation", value: 100 },
    ],
  );
}

async function testColorTargetDeactivateRestoresAllChars() {
  const { bridge, accessory } = makeMagicButton({
    target: { On: true, Brightness: 100, Hue: 120, Saturation: 100 },
  });
  bridge.push("On", true);
  bridge.push("Brightness", 50);
  bridge.push("Hue", 0);
  bridge.push("Saturation", 0);
  await getOnHandler(accessory)(true);
  bridge.clear();
  await getOnHandler(accessory)(false);
  // Restore non-On chars first (config order), then On last.
  assertEq(
    "color deactivate: restores Brightness + Hue + Saturation, then On",
    bridge.writes,
    [
      { char: "Brightness", value: 50 },
      { char: "Hue", value: 0 },
      { char: "Saturation", value: 0 },
      { char: "On", value: true },
    ],
  );
}

async function testColorTargetManualHueChangeDoesNotAutoOff() {
  const { bridge, accessory } = makeMagicButton({
    target: { On: true, Brightness: 100, Hue: 120, Saturation: 100 },
  });
  bridge.push("On", true);
  bridge.push("Brightness", 50);
  bridge.push("Hue", 0);
  bridge.push("Saturation", 0);
  await getOnHandler(accessory)(true);
  bridge.push("Brightness", 100); // echo of our write — enables manualWatch
  bridge.clear();

  // User manually shifts hue 120 → 200 — magic button should ignore.
  bridge.push("Hue", 200);
  assertEq(
    "manual hue change: no auto-off, no writes",
    bridge.writes,
    [],
  );
  assertEq(
    "magic button still ON after manual hue change",
    accessory._svc.value,
    undefined,
  );
}

async function testColorTargetManualBrightnessChangeStillAutoOffs() {
  const { bridge, accessory } = makeMagicButton({
    target: { On: true, Brightness: 100, Hue: 120, Saturation: 100 },
  });
  bridge.push("On", true);
  bridge.push("Brightness", 50);
  bridge.push("Hue", 0);
  bridge.push("Saturation", 0);
  await getOnHandler(accessory)(true);
  bridge.push("Brightness", 100); // echo enables manualWatch
  bridge.clear();

  bridge.push("Brightness", 75); // manual change
  assertEq(
    "manual brightness change while ON (color target): auto-OFF, no writes",
    bridge.writes,
    [],
  );
  assertEq(
    "HomeKit Switch flipped to OFF",
    accessory._svc.value,
    false,
  );
}

async function testConfigRejectsBothTargetAndShortcut() {
  const platform = makePlatform();
  const accessory = fakeAccessory();
  const bridge = new FakeBridge();
  const bridges = new Map([["loxone", bridge]]);
  let threw = false;
  try {
    new MagicButton(platform, accessory, {
      name: "X", service: "magic_button", bridge: "loxone",
      accessory: "Y", targetBrightness: 100, target: { On: true },
    }, bridges);
  } catch (e) {
    threw = /not both/.test(e.message);
  }
  assertEq("both target+targetBrightness rejected", threw, true);
}

async function testConfigRejectsEmptyTarget() {
  const platform = makePlatform();
  const accessory = fakeAccessory();
  const bridge = new FakeBridge();
  const bridges = new Map([["loxone", bridge]]);
  let threw = false;
  try {
    new MagicButton(platform, accessory, {
      name: "X", service: "magic_button", bridge: "loxone",
      accessory: "Y", target: {},
    }, bridges);
  } catch (e) {
    threw = /non-empty object/.test(e.message);
  }
  assertEq("empty target object rejected", threw, true);
}

async function testConfigRejectsNeither() {
  const platform = makePlatform();
  const accessory = fakeAccessory();
  const bridge = new FakeBridge();
  const bridges = new Map([["loxone", bridge]]);
  let threw = false;
  try {
    new MagicButton(platform, accessory, {
      name: "X", service: "magic_button", bridge: "loxone",
      accessory: "Y",
    }, bridges);
  } catch (e) {
    threw = /requires either/.test(e.message);
  }
  assertEq("neither target nor targetBrightness rejected", threw, true);
}

async function testConfigValidatesBridgeExists() {
  const platform = makePlatform();
  const accessory = fakeAccessory();
  const bridges = new Map();
  let threw = false;
  try {
    new MagicButton(platform, accessory, {
      name: "Orphan", service: "magic_button", bridge: "nonexistent",
      accessory: "X", targetBrightness: 100,
    }, bridges);
  } catch (e) {
    threw = /unknown bridge/.test(e.message);
  }
  assertEq("unknown bridge rejected", threw, true);
}

// ──────────────────────────────────────────────────────────────────────────

(async () => {
  await testActivationSnapshotsAndWrites();
  await testDeactivationRestoresSnapshot();
  await testCycleWhenTargetWasOff();
  await testManualBrightnessChangeAutoOffsNoRestore();
  await testPreEchoBrightnessUpdateDoesNotAutoOff();
  await testShortCircuitNoChange();
  await testNoSnapshotOnDeactivate();
  await testActivationRejectedWhenTargetUnknown();
  await testConfigValidatesTargetBrightnessRange();
  await testColorTargetActivateWritesAllChars();
  await testColorTargetDeactivateRestoresAllChars();
  await testColorTargetManualHueChangeDoesNotAutoOff();
  await testColorTargetManualBrightnessChangeStillAutoOffs();
  await testConfigRejectsBothTargetAndShortcut();
  await testConfigRejectsEmptyTarget();
  await testConfigRejectsNeither();
  await testConfigValidatesBridgeExists();

  if (failed > 0) {
    console.log(`\n${failed} test(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll tests passed.");
})();
