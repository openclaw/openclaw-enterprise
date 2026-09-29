import assert from "node:assert/strict";
import test from "node:test";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";

function fixture() {
  const requests = [];
  // Only the external transport is controlled. The real Driver decides whether
  // a request may reach it; no Kubernetes client, service, or provider is started.
  const gatewayClient = {
    async createSandbox(request) {
      requests.push(request);
      return { name: request.name, labels: request.labels, serviceUrls: {} };
    },
  };
  const driver = new OpenShellSandboxDriver(
    {
      gateway: { workspaceMode: "operator" },
      kubernetes: {
        runtimeClassName: "openshell-sandbox",
        serviceAccount: { mode: "gatewayConfigured" },
        sandboxDataMount: {
          subPath: "workspace",
          mountPath: "/sandbox/enterprise",
          readOnly: false,
        },
      },
      policy: {
        process: { runAsUser: "1000", runAsGroup: "1000" },
        networkPolicies: [
          {
            name: "model-egress",
            endpoints: [{ host: "model.example.test", ports: [443] }],
            binaries: [{ path: "/app/bin/model-client" }],
          },
        ],
      },
    },
    {
      id: "openshell-sandbox",
      implementation: "openshell",
      backend: {
        id: "openshell",
        drivers: { sandbox: "openshell-sandbox" },
        client: { clientForNamespace: () => gatewayClient },
      },
    },
  );
  const revision = {
    id: "rev_00000000-0000-4000-8000-000000000001",
    namespaceId: "ns_00000000-0000-4000-8000-000000000001",
    agentId: "agt_00000000-0000-4000-8000-000000000001",
    harness: { id: "openclaw", version: "1.0.0", mode: "dedicated" },
    sandboxDriverId: driver.id,
  };
  const context = {
    namespace: {
      id: revision.namespaceId,
      name: "oce-123456789012345",
      status: "ready",
      createdAt: "2026-09-01T00:00:00.000Z",
    },
    kubernetes: {},
    signal: new AbortController().signal,
    revision,
    requirements: {
      loginMode: "api_key",
      image: "openclaw-runtime@sha256:" + "a".repeat(64),
      command: ["/usr/bin/tini", "-s", "--", "node", "-e", "worker-entrypoint"],
      serviceAccountName: "agent-native-openclaw",
      serviceAccountToken: {
        audience: "openclaw-enterprise",
        expirationSeconds: 900,
        mountPath: "/var/run/secrets/openclaw-enterprise",
        path: "token",
        readOnly: true,
      },
      workspaceMounts: [
        {
          claimName: "harness-workspace-native-openclaw",
          subPath: "workspace",
          mountPath: "/home/node/workspace",
          readOnly: false,
        },
      ],
      credentialAttachments: [],
      environment: [{ name: "APP_SERVER_PORT", value: "18790" }],
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/agent": revision.agentId,
        "openclaw.dev/revision": revision.id,
        "openclaw.dev/workload-role": "agent",
      },
    },
  };
  return { driver, context, requests };
}

test("OpenShell refuses plugin-free Codex before a missing material supplier can create a Sandbox", async () => {
  const { driver, context, requests } = fixture();
  context.revision.harness.id = "codex";
  // Codex consumes runtime.json and config.toml even with no optional plugins.
  // Omitting the environment pointers is not evidence those files were supplied.
  await assert.rejects(driver.provisionHarness(context), /material delivery is unavailable/);
  assert.deepEqual(requests, []);
});

test("OpenShell refuses an admitted plugin snapshot without a material supplier", async () => {
  const { driver, context, requests } = fixture();
  context.revision.plugins = {
    driver: { id: "openclaw-plugin", implementation: "occ/openclaw-plugin" },
    plugins: {},
  };
  await assert.rejects(driver.provisionHarness(context), /material delivery is unavailable/);
  assert.deepEqual(requests, []);
});

test("OpenShell refuses repository-bound revisions before Gateway mutation", async () => {
  const { driver, context, requests } = fixture();
  context.revision.repositoryCredentials = {
    bindings: [{ repositoryRef: "source" }],
    deadlineWallMs: Date.now() + 60_000,
  };
  await assert.rejects(driver.provisionHarness(context), /material delivery is unavailable/);
  assert.deepEqual(requests, []);
});

for (const name of [
  "OPENCLAW_PLUGIN_RUNTIME_MANIFEST",
  "OPENCLAW_PLUGIN_CODEX_CONFIG_TOML",
  "OPENCLAW_PLUGIN_RUNTIME_JSON",
  "OPENCLAW_PLUGIN_READY_MARKER",
]) {
  test("OpenShell does not treat " + name + " as proof of delivered plugin material", async () => {
    const { driver, context, requests } = fixture();
    context.requirements.environment.push({ name, value: "/unverified/material" });
    await assert.rejects(driver.provisionHarness(context), /material delivery is unavailable/);
    assert.deepEqual(requests, []);
  });
}

test("OpenShell does not reuse a material-free admission for a replacement revision", async () => {
  const { driver, context, requests } = fixture();
  const first = await driver.provisionHarness(context);
  assert.equal(first.revisionId, context.revision.id);
  assert.equal(requests.length, 1);
  const replacement = structuredClone({
    revision: context.revision,
    requirements: context.requirements,
  });
  replacement.revision.id = "rev_00000000-0000-4000-8000-000000000002";
  replacement.revision.harness.id = "codex";
  replacement.requirements.labels["openclaw.dev/revision"] = replacement.revision.id;
  await assert.rejects(
    driver.provisionHarness({ ...context, ...replacement }),
    /material delivery is unavailable/,
  );
  assert.equal(requests.length, 1);
});

test("OpenShell retains its native material-free request shape", async () => {
  const { driver, context, requests } = fixture();
  const sandbox = await driver.provisionHarness(context);
  assert.equal(sandbox.revisionId, context.revision.id);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].serviceExposures, []);
  assert.deepEqual(requests[0].spec.command, context.requirements.command);
  assert.deepEqual(requests[0].labels, context.requirements.labels);
});

test("OpenShell preserves Secret-backed environment refusal before material diagnosis", async () => {
  const { driver, context, requests } = fixture();
  context.revision.harness.id = "codex";
  context.requirements.environment.push({
    name: "APP_SERVER_TOKEN",
    valueFrom: { secretKeyRef: { name: "agent-app-server", key: "token" } },
  });
  await assert.rejects(
    driver.provisionHarness(context),
    /cannot receive secretKeyRef environment APP_SERVER_TOKEN/,
  );
  assert.deepEqual(requests, []);
});
