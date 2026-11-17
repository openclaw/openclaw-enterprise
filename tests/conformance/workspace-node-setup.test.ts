import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { SandboxHarnessContext } from "../../packages/contracts/src/index.ts";
import { providerEndpointFixture } from "../fixtures/kubernetes-provider-endpoint.mjs";
import { admitRevisionHarness, tenant } from "../helpers/kubernetes-routed-scenarios.mjs";
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
    // Admit against the external provider: an OpenShell admission selects OpenShell's launch.
    admitRevisionHarness(fixture.driver, fixture.revision);
    await fixture.prepare();
    fixture.setGatewayServing();
    fixture.setSetupAvailable(true);
    fixture.observePods([fixture.pod("ready")]);
    assert.equal((await fixture.prepare()).ready, true);
    await fixture.activate();

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
    for (const { requirements } of [
      fixture.provisions[0],
      fixture.endpoints.at(-1),
    ] as SandboxHarnessContext[]) {
      assert.deepEqual(
        requirements.environment.filter(({ name }) =>
          ["APP_TOKEN_SHA", "APP_SERVER_TOKEN"].includes(name),
        ),
        expected,
      );
    }
  }
});

test("an external verifier opt-in decides Codex plugin preparation for both workloads", async () => {
  for (const optedIn of [false, true]) {
    const fixture = providerEndpointFixture({
      revisionOverrides: {
        plugins: {
          driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
          plugins: { "codex-plugin:linear@openai-curated-remote": { enabled: true } },
        },
      },
    });
    Object.assign(fixture.sandbox, {
      implementation: "external",
      ...(optedIn && { harnessTransportCredential: "verifier" }),
    });
    admitRevisionHarness(fixture.driver, fixture.revision);
    await fixture.prepare();
    const gatewayPrepared = fixture
      .gateway()
      .spec.template.spec.containers[0].env.some(
        ({ name, value }: { name: string; value?: string }) =>
          name === "OPENCLAW_CODEX_PLUGINS_PREPARED" && value === "true",
      );
    fixture.setGatewayServing();
    fixture.setSetupAvailable(true);
    await fixture.prepare();
    const names = (fixture.provisions[0] as SandboxHarnessContext).requirements.environment.map(
      ({ name }) => name,
    );
    // A verifier Harness installs its plugins before serving and publishes no plugin
    // status, so the Gateway must not wait for one; a bearer Harness publishes it.
    assert.equal(names.includes("APP_TOKEN_SHA"), optedIn);
    assert.equal(names.includes("OPENCLAW_PLUGIN_STATUS_PORT"), !optedIn);
    assert.equal(gatewayPrepared, optedIn);
  }
});

test("a protected plan on a non-OpenShell Sandbox tells its Gateway the Harness prepares Codex plugins", () => {
  // Protected plans receive the verifier from every Sandbox, so their Harness prepares its
  // own plugins and publishes no plugin status. The Gateway must read the same decision
  // rather than the OpenShell name, or it waits for that status forever.
  const fixture = providerEndpointFixture({
    revisionOverrides: {
      executionAdmission: { version: 3, mode: "protected" },
      egressPlan: {
        id: "protected-plan",
        generation: 1,
        execution: {
          installationId: "installation-routed",
          namespaceId: tenant.id,
          agentId: "agent-routed",
          servicePrincipalId: "service-principal-routed",
          revisionId: "revision-routed-1",
          executionId: "revision-routed-1",
        },
        sandboxDriverId: "sandbox-provider",
        egressDriverId: "sandbox-provider",
        driver: {
          id: "sandbox-provider",
          implementation: "external",
          configurationId: "a".repeat(64),
        },
        policyReductionVersion: 1,
        routes: [],
      },
      plugins: {
        driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
        plugins: { "codex-plugin:linear@openai-curated-remote": { enabled: true } },
      },
    },
  });
  Object.assign(fixture.sandbox, { implementation: "external" });
  // Protected preparation needs the paired protected-execution release, so render the
  // Gateway Deployment directly from the revision's real configuration snapshot.
  const compute = fixture.driver as unknown as {
    gatewayConfiguration(revision: unknown, nodeId: undefined, namespace: unknown): unknown;
    pluginRuntimeSnapshot(revision: unknown): unknown;
    deployment(...args: unknown[]): {
      spec: { template: { spec: { containers: { env: { name: string; value?: string }[] }[] } } };
    };
  };
  const gateway = compute.deployment(
    "gateway-protected",
    { namespaceId: fixture.revision.namespaceId, agentId: fixture.revision.agentId },
    { name: fixture.gatewayNamespace, plane: "control" },
    { runtime: "gateway:local", workspaceSetup: "gateway:local" },
    "gateway-protected",
    "gateway",
    {},
    "info",
    compute.gatewayConfiguration(fixture.revision, undefined, {
      name: fixture.namespace,
      plane: "execution",
    }),
    false,
    undefined,
    undefined,
    [],
    [],
    compute.pluginRuntimeSnapshot(fixture.revision),
  );
  const [container] = gateway.spec.template.spec.containers;
  assert.ok(container);
  const environment = container.env;
  assert.equal(
    environment.find(({ name }) => name === "OPENCLAW_CODEX_PLUGINS_PREPARED")?.value,
    "true",
  );
  assert.equal(
    environment.some(({ name }) => name === "OPENCLAW_PLUGIN_STATUS_PORT"),
    false,
  );
});

test("Compute refuses a verifier declaration it cannot honour instead of sending the bearer", async () => {
  const fixture = providerEndpointFixture();
  Object.assign(fixture.sandbox, {
    implementation: "external",
    harnessTransportCredential: "verifier",
    harnessEndpoint: undefined,
  });
  const refusal = /harnessTransportCredential requires a dedicated Codex or OpenClaw Harness/;
  assert.throws(() => admitRevisionHarness(fixture.driver, fixture.revision), refusal);
  // A revision admitted before the declaration still refuses at its next reconcile.
  Object.assign(fixture.sandbox, { harnessTransportCredential: undefined });
  admitRevisionHarness(fixture.driver, fixture.revision);
  Object.assign(fixture.sandbox, { harnessTransportCredential: "verifier" });
  await assert.rejects(fixture.prepare(), refusal);
  assert.equal(fixture.provisions.length, 0);
  assert.equal(
    fixture.writes.some(
      ({ kind, metadata }) => kind === "Secret" && metadata.name.startsWith("harness-secrets-"),
    ),
    false,
  );
});

function fixtureDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
