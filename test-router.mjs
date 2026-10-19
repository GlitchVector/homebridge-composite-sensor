// Router tests: first matching route pulses its target, nothing matches → nothing pulses, both reset.
import { Router } from "./dist/sensors/router.js";

let failed = 0;
function assertEq(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const pass = a === e;
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}  actual=${a}  expected=${e}`);
}

class Char {}
const C = {
  Name: class Name extends Char {}, ConfiguredName: class ConfiguredName extends Char {}, On: class On extends Char {},
  Manufacturer: Char, Model: Char, SerialNumber: Char,
};
class Svc {
  constructor(name, subtype) { this.name = name; this.subtype = subtype; this.UUID = "switch"; this.chars = new Set(); this.events = []; }
  setCharacteristic() { return this; }
  testCharacteristic(c) { return this.chars.has(c); }
  addCharacteristic(c) { this.chars.add(c); return this; }
  getCharacteristic() { return { onGet: (f) => { this.get = f; return { onSet: (g) => { this.set = g; } }; } }; }
  updateCharacteristic(_c, v) { this.events.push(v); return this; }
}
function accessory() {
  const services = [];
  return {
    services,
    getService: () => ({ setCharacteristic() { return this; } }),
    getServiceById: (_t, sub) => services.find((s) => s.subtype === sub),
    addService: (_t, name, sub) => { const s = new Svc(name, sub); services.push(s); return s; },
    removeService: (s) => services.splice(services.indexOf(s), 1),
  };
}
const logs = [];
const platform = {
  Service: { AccessoryInformation: {}, Switch: { UUID: "switch" } },
  Characteristic: C,
  log: { info: (m) => logs.push(m), warn: () => {}, error: () => {}, debug: () => {} },
};
const src = (value) => ({ value, degraded: false });

function make(vals) {
  const sources = new Map(Object.entries(vals).map(([k, v]) => [k, src(v)]));
  const acc = accessory();
  const r = new Router(platform, acc, {
    name: "Office Double", service: "router", pulseSeconds: 0.2,
    routes: [
      { when: "sunDown AND NOT sleeping AND NOT bedroomPlug", target: "Route Easy Bedroom Light" },
      { when: "sunDown AND NOT sleeping AND bedroomPlug", target: "Route Office Evening Lights" },
      { when: "NOT sunDown AND officeBlindsAtLimit", target: "Route Easy Office Shades" },
      { when: "NOT sunDown AND NOT officeBlindsAtLimit", target: "Route Full Office Shade" },
    ],
  }, sources);
  const by = (sub) => acc.services.find((s) => s.subtype === sub);
  return { r, by };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fire(vals, expectTarget) {
  const { by } = make(vals);
  by("trigger").set(true);
  const targets = ["Route Easy Bedroom Light", "Route Office Evening Lights", "Route Easy Office Shades", "Route Full Office Shade"];
  const on = targets.filter((t) => by(`target:${t}`).events.includes(true));
  await sleep(300);
  const resetOk = by("trigger").events.at(-1) === false && targets.every((t) => by(`target:${t}`).get() === false);
  return { on, resetOk, expect: expectTarget ? [expectTarget] : [] };
}

for (const [label, vals, expect] of [
  ["day, blinds up -> Easy Office Shades", { sunDown: false, sleeping: false, bedroomPlug: false, officeBlindsAtLimit: true }, "Route Easy Office Shades"],
  ["day, blinds half -> Full Office Shade", { sunDown: false, sleeping: false, bedroomPlug: false, officeBlindsAtLimit: false }, "Route Full Office Shade"],
  ["evening, plug off -> Easy Bedroom Light", { sunDown: true, sleeping: false, bedroomPlug: false, officeBlindsAtLimit: true }, "Route Easy Bedroom Light"],
  ["evening, plug on -> Office Evening Lights", { sunDown: true, sleeping: false, bedroomPlug: true, officeBlindsAtLimit: true }, "Route Office Evening Lights"],
  ["night, sleeping (chin double-click) -> nothing", { sunDown: true, sleeping: true, bedroomPlug: false, officeBlindsAtLimit: true }, null],
]) {
  const r = await fire(vals, expect);
  assertEq(label, r.on, r.expect);
  assertEq(`${label}: trigger + targets reset`, r.resetOk, true);
}

let threw = false;
try { make({ sunDown: false }); } catch { threw = true; }
assertEq("unknown source in a route is rejected", threw, true);

if (failed) { console.log(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log("\nALL ROUTER TESTS PASSED");
