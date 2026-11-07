import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { SandboxHarnessContext } from "../../packages/contracts/src/index.ts";
import { providerEndpointFixture } from "../fixtures/kubernetes-provider-endpoint.mjs";
import {
  validateWorkspaceNodeSetupSecret,
  WorkspaceNodeSetupValidationError,
} from "../../packages/utils/src/index.ts";

test("workspace setup validation returns only the frozen canonical envelope", () => {
  const envelope = {
    url: "wss://GATEWAY.example.test:443/node",
    bootstrapToken: "synthetic-bootstrap-token",
    expiresAtMs: Date.now() + 60_000,
    tlsFingerprint: "SHA256:" + "AB:".repeat(31) + "AB",
  };
  const secret = {
    metadata: {
      namespace: "runtime-ns",
      labels: { "openclaw.dev/namespace": "ns-one", "openclaw.dev/agent": "agent-one" },
    },
    data: {
      setup: Buffer.from(
        "oc-pair://" + Buffer.from(JSON.stringify(envelope)).toString("base64url"),
      ).toString("base64"),
      unrelated: "must-not-be-returned",
    },
  };
  const snapshot = structuredClone(secret);
  const result = validateWorkspaceNodeSetupSecret(secret, {
    namespace: "runtime-ns",
    namespaceId: "ns-one",
    agentId: "agent-one",
    key: "setup",
  });
  assert.deepEqual(result, { ...envelope, url: "wss://gateway.example.test/node" });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(secret, snapshot);
});

test("workspace setup validation reports ownership and expiry through its public error type", () => {
  const secret = {
    metadata: {
      namespace: "runtime-ns",
      labels: { "openclaw.dev/namespace": "ns-one", "openclaw.dev/agent": "agent-one" },
    },
    data: {
      setup: Buffer.from(
        Buffer.from(
          JSON.stringify({
            url: "wss://gateway.example.test/node",
            bootstrapToken: "synthetic-bootstrap-token",
            expiresAtMs: 1,
          }),
        ).toString("base64url"),
      ).toString("base64"),
    },
  };
  const expected = {
    namespace: "runtime-ns",
    namespaceId: "ns-one",
    agentId: "agent-one",
    key: "setup",
  };
  for (const field of ["namespace", "namespaceId", "agentId"]) {
    assert.throws(
      () => validateWorkspaceNodeSetupSecret(secret, { ...expected, [field]: "foreign" }),
      {
        constructor: WorkspaceNodeSetupValidationError,
        message: "Refusing a workspace node setup Secret without exact Agent ownership.",
      },
    );
  }
  assert.throws(() => validateWorkspaceNodeSetupSecret(secret, expected), {
    constructor: WorkspaceNodeSetupValidationError,
    message: "The workspace node setup envelope is expired or has no bounded expiry.",
  });
});

function expiredSetupWithSavedDevice() {
  const envelope = {
    url: "wss://gateway.example.test/node",
    bootstrapToken: "synthetic-bootstrap-token",
    expiresAtMs: 1,
  };
  return {
    envelope,
    secret: {
      metadata: {
        namespace: "runtime-ns",
        labels: { "openclaw.dev/namespace": "ns-one", "openclaw.dev/agent": "agent-one" },
      },
      data: {
        setup: Buffer.from(Buffer.from(JSON.stringify(envelope)).toString("base64url")).toString(
          "base64",
        ),
        deviceId: Buffer.from("saved-device").toString("base64"),
      },
    },
    expected: {
      namespace: "runtime-ns",
      namespaceId: "ns-one",
      agentId: "agent-one",
      key: "setup",
    },
  };
}

test("workspace setup and saved-device encodings retain optional trailing padding", () => {
  const { secret, expected, envelope } = expiredSetupWithSavedDevice();
  for (const padding of ["", "=", "==", "=".repeat(65_536)]) {
    const padded = structuredClone(secret);
    for (const key of ["setup", "deviceId"] as const) {
      padded.data[key] = padded.data[key].replaceAll("=", "") + padding;
    }
    assert.deepEqual(validateWorkspaceNodeSetupSecret(padded, expected), envelope);
  }
});

test("workspace setup and saved-device encodings reject nontrailing padding", () => {
  const { secret, expected } = expiredSetupWithSavedDevice();
  for (const key of ["setup", "deviceId"] as const) {
    for (const suffix of ["=suffix", "=".repeat(65_536) + "!", "=\n"]) {
      const malformed = structuredClone(secret);
      malformed.data[key] = malformed.data[key].replaceAll("=", "") + suffix;
      assert.throws(() => validateWorkspaceNodeSetupSecret(malformed, expected), {
        constructor: WorkspaceNodeSetupValidationError,
        message:
          key === "setup"
            ? "The workspace node setup Secret contains invalid material."
            : "The workspace node device ID is invalid.",
      });
    }
  }
});

test("a selected external provider explicitly opts in to the native transport verifier", async () => {
  for (const optedIn of [false, true]) {
    const fixture = providerEndpointFixture();
    Object.assign(fixture.sandbox, {
      implementation: "external",
      ...(optedIn && { harnessTransportCredential: "verifier" }),
    });
    await fixture.prepare();
    fixture.setGatewayServing();
    fixture.setSetupAvailable(true);
    fixture.observePods([fixture.pod("ready")]);
    assert.equal((await fixture.prepare()).ready, true);
    await fixture.activate();

    const selector = "OPENCLAW_CODEX_REMOTE_WORKSPACE_BINDING";
    assert.equal(JSON.stringify(fixture.gateway().spec.template.spec).includes(selector), false);
    const expected = optedIn
      ? [
          {
            name: "APP_TOKEN_SHA",
            value: createHash("sha256").update("test-transport").digest("hex"),
          },
        ]
      : [
          {
            name: "APP_SERVER_TOKEN",
            valueFrom: {
              secretKeyRef: {
                name: `harness-secrets-${fixtureDigest(fixture.revision.agentId)}-${fixtureDigest(fixture.revision.id)}`,
                key: "app-server-token",
              },
            },
          },
        ];
    const observed: readonly (SandboxHarnessContext | undefined)[] = [
      fixture.provisions[0],
      fixture.endpoints.at(-1),
    ];
    for (const observation of observed) {
      assert.ok(observation, "preparation and activation must both read the provider workload");
      const { requirements } = observation;
      assert.equal(
        requirements.environment.some(({ name }) => name === selector),
        false,
      );
      assert.deepEqual(
        requirements.environment.filter(({ name }) =>
          ["APP_TOKEN_SHA", "APP_SERVER_TOKEN"].includes(name),
        ),
        expected,
      );
    }
  }
});

function fixtureDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

test("verifier-only provisioning refuses a missing provider endpoint before giving the workload a credential", async () => {
  const fixture = providerEndpointFixture();
  Object.assign(fixture.sandbox, {
    implementation: "external",
    harnessTransportCredential: "verifier",
    harnessEndpoint: undefined,
  });
  await assert.rejects(fixture.prepare(), /Verifier-only Harness credentials require/);
  assert.equal(fixture.provisions.length, 0);
});
