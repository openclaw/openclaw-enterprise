import assert from "node:assert/strict";
import test from "node:test";
import {
  gatewayExitedBeforeServing,
  invalidGatewayConfiguration,
  invalidGatewayConfigurationLine,
  invalidGatewayConfigurationSecret,
} from "../helpers/openclaw-config-validation.ts";
import { property, record, required, text } from "./plugin-compute-fixtures.ts";
import { readReadyStatusFromHandler } from "./plugin-compute-status.ts";
import { startCodexGatewaySupervisor } from "./plugin-compute-supervisor.ts";

type GatewaySupervisor = Pick<
  Awaited<ReturnType<typeof startCodexGatewaySupervisor>>,
  | "children"
  | "exits"
  | "files"
  | "intervals"
  | "logs"
  | "peerRequests"
  | "peerStatus"
  | "pollPeer"
  | "revisionId"
  | "runtimeStatus"
  | "serving"
  | "signalHandlers"
  | "statusHandler"
  | "validation"
  | "validationCalls"
>;

const expectedValidatorCall = {
  command: "node",
  args: ["/app/openclaw.mjs", "config", "validate", "--json"],
  readOnly: "1",
};

export function registerGatewayConfigurationRefusalCases(): void {
  test("Kubernetes Gateway holds a configuration OpenClaw refuses when its first start exits", async (t) => {
    const gateway: GatewaySupervisor = await startCodexGatewaySupervisor(t, {
      runtimeStatus: true,
      bindingDeviceId: "a".repeat(64),
    });
    gateway.validation = invalidGatewayConfiguration;
    // The kubelet's readiness probe finds OpenClaw unready; it exits at about 3 s, before
    // its /readyz ever answers 200.
    gateway.serving = false;
    assert.equal((await readReadyStatusFromHandler(gateway.statusHandler)).status, 503);
    const validationsBefore = gateway.validationCalls.length;
    // OpenClaw refuses an invalid configuration with status 78 (EX_CONFIG).
    required(gateway.children[0]).exit(78, null);

    // The wrapper holds the failure instead of restarting the container into the same refusal.
    assert.deepEqual(gateway.exits, []);
    assert.deepEqual(gateway.validationCalls.slice(validationsBefore), [expectedValidatorCall]);
    const { checkedAt, ...held } = record(property(gateway.runtimeStatus(), "runtimeFailure"));
    assert.ok(!Number.isNaN(Date.parse(text(checkedAt))));
    assert.deepEqual(held, { component: "gateway", check: "gateway-config", code: "UNAVAILABLE" });
    // One log line names up to five settings. Only JSON Schema messages, which carry no
    // setting value, stay beside their paths: the configuration may hold secrets.
    assert.ok(
      gateway.logs.includes(invalidGatewayConfigurationLine(gatewayExitedBeforeServing("exit-78"))),
      JSON.stringify(gateway.logs),
    );
    assert.equal(JSON.stringify(gateway.logs).includes(invalidGatewayConfigurationSecret), false);

    // A held Gateway is not respawned for a changed Harness peer, nor restarted for another
    // workspace node; stopping the container ends the hold.
    gateway.peerStatus = { ...gateway.peerStatus, startupId: "agent-startup-2" };
    const peerRequestsBefore = gateway.peerRequests;
    await gateway.pollPeer();
    assert.equal(gateway.peerRequests, peerRequestsBefore, "a held Gateway skips the peer poll");
    gateway.files.set(
      "/home/node/workspace-node-binding/workspace-node.json",
      JSON.stringify({ revisionId: gateway.revisionId, deviceId: "b".repeat(64) }),
    );
    await required(gateway.intervals.find(({ delay }) => delay === 1_000)).callback();
    assert.equal(gateway.children.length, 1);
    assert.deepEqual(gateway.exits, []);
    assert.equal(gateway.validationCalls.length - validationsBefore, 1);
    assert.equal(property(gateway.runtimeStatus(), "runtimeFailure", "check"), "gateway-config");
    required(gateway.signalHandlers.SIGTERM)();
    assert.deepEqual(gateway.exits, [0]);
  });

  // Every other exit restarts the container as before; the hold covers only a Gateway that
  // never served, whose configuration OpenClaw's validator reports invalid.
  for (const {
    label,
    runtimeStatus = true,
    validation,
    served = false,
    exitCode = 1,
    validatesConfiguration,
  } of [
    {
      label: "a configuration the validator accepts",
      validation: undefined,
      validatesConfiguration: true,
    },
    {
      label: "a validator that times out",
      validation: { status: null, error: new Error("spawnSync node ETIMEDOUT"), stdout: "" },
      validatesConfiguration: true,
    },
    {
      label: "no Compute status port",
      runtimeStatus: false,
      validation: invalidGatewayConfiguration,
      validatesConfiguration: false,
    },
    {
      label: "a Gateway that served first",
      validation: invalidGatewayConfiguration,
      served: true,
      validatesConfiguration: false,
    },
    {
      label: "status 0",
      validation: invalidGatewayConfiguration,
      exitCode: 0,
      validatesConfiguration: false,
    },
  ]) {
    test(`Kubernetes Gateway restarts after an exit with ${label}`, async (t) => {
      const gateway: GatewaySupervisor = await startCodexGatewaySupervisor(t, { runtimeStatus });
      if (validation !== undefined) {
        gateway.validation = validation;
      }
      if (served) {
        // The kubelet's readiness probe saw OpenClaw serve.
        assert.equal((await readReadyStatusFromHandler(gateway.statusHandler)).status, 200);
      }
      const validationsBefore = gateway.validationCalls.length;
      required(gateway.children[0]).exit(exitCode, null);
      assert.deepEqual(gateway.exits, [exitCode]);
      const validationCalls = gateway.validationCalls.slice(validationsBefore);
      assert.deepEqual(validationCalls, validatesConfiguration ? [expectedValidatorCall] : []);
      if (runtimeStatus) {
        assert.equal(property(gateway.runtimeStatus(), "runtimeFailure"), undefined);
      }
    });
  }
}
