import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { SandboxHarnessContext } from "../../packages/contracts/src/index.ts";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
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

test("a successor pins its external workspace before activation while its predecessor serves", async (t) => {
  const { caBundle } = await harnessTlsFixture(t);
  const original = "a".repeat(64);
  let generation = original;
  let statusCalls = 0;
  const provider = {
    revisionOverrides: { id: "successor", revision: 2 },
    providerNetwork: {
      namespace: "provider",
      podLabels: { app: "provider" },
      address: "10.43.0.50",
      port: 8443,
    },
    harnessEndpoint: async () => ({
      url: "wss://provider.example.invalid:8443/",
      tls: { caBundle },
      workspaceRoot: "/home/node/workspace",
      ...(generation && { externalWorkspaceOwner: { generationSha256: generation } }),
    }),
  };
  const fixture = providerEndpointFixture(provider);
  Object.assign(fixture.sandbox, {
    implementation: "external",
    harnessTransportCredential: "verifier",
    async harnessStatus() {
      statusCalls++;
      return { state: "serving" };
    },
  });
  assert.equal((await fixture.prepare()).ready, false);
  fixture.setGatewayServing();
  fixture.setSetupAvailable(true);
  const predecessor = fixture.gateway();
  predecessor.metadata.annotations["openclaw.dev/agent-revision-id"] = "predecessor";
  predecessor.metadata.annotations["openclaw.dev/agent-revision"] = "1";
  fixture.save(predecessor);
  fixture.observePods([fixture.pod("successor-ready")]);

  assert.equal((await fixture.prepare()).ready, true);
  assert.deepEqual(fixture.gateway(), predecessor);
  const trustName = `harness-trust-${fixtureDigest(fixture.revision.agentId)}-rev-${fixtureDigest(fixture.revision.id)}`;
  const saved = fixture.read("ConfigMap", trustName, fixture.gatewayNamespace);
  assert.ok(saved, "preparing behind the predecessor must persist the successor binding");
  assert.equal(JSON.parse(saved.data["binding.json"]).generationSha256, original);
  const before = statusCalls;
  for (generation of ["b".repeat(64), ""]) {
    await assert.rejects(
      fixture.prepare(),
      /invalid immutable Kubernetes ConfigMap|lost its pinned TLS binding/,
    );
    await assert.rejects(
      fixture.activate(),
      /invalid immutable Kubernetes ConfigMap|lost its pinned TLS binding/,
    );
    assert.equal(statusCalls, before, "refuse drift before authenticating to the changed Harness");
    assert.deepEqual(fixture.gateway(), predecessor);
    assert.deepEqual(fixture.read("ConfigMap", trustName, fixture.gatewayNamespace), saved);
  }
  generation = original;
  fixture.objects.delete(fixture.key("ConfigMap", trustName, fixture.gatewayNamespace));
  await assert.rejects(fixture.activate(), /prepared immutable Kubernetes ConfigMap is missing/);
  assert.equal(statusCalls, before);
  assert.deepEqual(fixture.gateway(), predecessor);
  assert.equal(fixture.read("ConfigMap", trustName, fixture.gatewayNamespace), undefined);

  fixture.save(saved);
  await fixture.activate();
  assert.ok(statusCalls > before);
  assert.equal(
    fixture.gateway().metadata.annotations["openclaw.dev/agent-revision-id"],
    fixture.revision.id,
  );
  assert.deepEqual(fixture.read("ConfigMap", trustName, fixture.gatewayNamespace), saved);
});
