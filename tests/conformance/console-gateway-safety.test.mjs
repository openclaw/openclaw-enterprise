import assert from "node:assert/strict";
import test from "node:test";

import {
  GATEWAY_SAFETY_SETTINGS,
  gatewaySafetyStrict,
  gatewaySafetyValue,
  withGatewaySafetyStrict,
  withGatewaySafetyValue,
} from "../../apps/controller/src/console/agents/gateway-safety.mts";

// The Configuration tab's collaboration and safety toggles edit the native document the JSON
// editor saves, and show what a deployment of it runs with. These cases pin what the toggles
// write, so the JSON round-trips: a toggle never drops a neighbouring setting or leaves an empty
// object behind, and an unset setting shows the value the Gateway actually gets.
const [steering, applyPatch] = GATEWAY_SAFETY_SETTINGS;
const effective = (values) =>
  GATEWAY_SAFETY_SETTINGS.map((setting) => gatewaySafetyValue(values, setting));

test("an unset setting shows the value deployment admission or OpenClaw gives it", () => {
  // Admission restricts apply_patch to the workspace. The Gateway enables steering by default.
  assert.deepEqual(effective({}), [
    { kind: "value", value: true, explicit: false },
    { kind: "value", value: true, explicit: false },
  ]);
  // An explicit value wins and says so.
  assert.deepEqual(
    gatewaySafetyValue({ messages: { queue: { allowCollaborativeSteering: false } } }, steering),
    { kind: "value", value: false, explicit: true },
  );
});

test("the steering help says what the Gateway does with another participant's message when off", () => {
  const queued = "Off: their message runs as a separate turn after it.";
  const refused =
    "Off: the Gateway refuses their message and asks them to resend it with /followup, which runs it as a separate turn after it.";
  const defaults = steering.help({});
  assert.ok(defaults.endsWith(queued));
  for (const [fallback, expected] of [
    ["queue", queued],
    ["reject", refused],
  ]) {
    const help = steering.help({
      messages: { queue: { collaborativeSteeringFallback: fallback } },
    });
    assert.ok(help.endsWith(expected));
  }
});

test("a toggle writes only its own setting and removes it again at the default", () => {
  const values = { messages: { queue: { mode: "collect" } }, gateway: { mode: "local" } };
  const off = withGatewaySafetyValue(values, steering, false);
  assert.deepEqual(off, {
    messages: { queue: { mode: "collect", allowCollaborativeSteering: false } },
    gateway: { mode: "local" },
  });
  assert.deepEqual(withGatewaySafetyValue(off, steering, true), values);
  // Removing a setting removes the objects it leaves empty, never one the reader wrote.
  assert.deepEqual(
    withGatewaySafetyValue(withGatewaySafetyValue({}, steering, false), steering, true),
    {},
  );
  assert.deepEqual(withGatewaySafetyValue({ tools: {} }, applyPatch, false), {
    tools: { exec: { applyPatch: { workspaceOnly: false } } },
  });
  // No change returns the same document, so the editor is not rewritten.
  assert.equal(withGatewaySafetyValue(values, steering, true), values);
  assert.equal(withGatewaySafetyValue(off, steering, false), off);
});

test("Strict mode pins every locked-down value and off returns each setting to its default", () => {
  const values = { messages: { queue: { mode: "collect" } } };
  assert.equal(gatewaySafetyStrict(values), false);
  const strict = withGatewaySafetyStrict(values, true);
  // workspaceOnly is already on by default; Strict mode still writes it, so the Agent stays
  // strict if that default changes.
  assert.deepEqual(strict, {
    messages: { queue: { mode: "collect", allowCollaborativeSteering: false } },
    tools: { exec: { applyPatch: { workspaceOnly: true } } },
  });
  assert.equal(gatewaySafetyStrict(strict), true);
  assert.deepEqual(withGatewaySafetyStrict(strict, false), values);
  // Strict by its explicit values alone, also without Strict mode's own writes.
  assert.equal(
    gatewaySafetyStrict({ messages: { queue: { allowCollaborativeSteering: false } } }),
    true,
  );
});

test("a value the Gateway refuses shows as invalid, and only a reachable one is replaced", () => {
  // A non-boolean value can be replaced in place.
  const wrongType = { tools: { exec: { applyPatch: { workspaceOnly: "no" } } } };
  assert.deepEqual(gatewaySafetyValue(wrongType, applyPatch), { kind: "invalid" });
  assert.deepEqual(withGatewaySafetyValue(wrongType, applyPatch, false), {
    tools: { exec: { applyPatch: { workspaceOnly: false } } },
  });
  // A non-object on the path is the reader's to fix in the JSON: no toggle overwrites it.
  const blocked = { tools: ["read"] };
  assert.deepEqual(gatewaySafetyValue(blocked, applyPatch), { kind: "invalid" });
  assert.equal(withGatewaySafetyValue(blocked, applyPatch, false), blocked);
  assert.equal(withGatewaySafetyStrict(blocked, true).tools, blocked.tools);
  assert.equal(gatewaySafetyStrict(blocked), false);
});
