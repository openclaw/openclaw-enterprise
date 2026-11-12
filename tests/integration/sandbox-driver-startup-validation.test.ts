import assert from "node:assert/strict";
import test from "node:test";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { ConfigurationValidationError as SharedConfigurationValidationError } from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { makeStructuralRefusal as structuralRefusal } from "./sandbox-driver-installation-fixture.ts";
import { verifySandboxFactoryValidation } from "./sandbox-driver-startup-composition-cases.ts";
import {
  buildSandboxInstallation as sandboxInstallation,
  rejectsAtStartup,
} from "./sandbox-driver-startup-installation-fixture.ts";

type SandboxInstallation = ReturnType<typeof sandboxInstallation>;
type ConfigurationMutation = (configuration: SandboxInstallation) => void;
type RefusalDetail = SharedConfigurationValidationError["error"]["details"][number];

test("startup rejects invalid bundled OpenShell configuration before invoking an injected factory", async (t) => {
  await verifySandboxFactoryValidation({
    t,
    sandboxInstallation,
    structuralRefusal,
    SharedConfigurationValidationError,
  });
});

// Each test below changes settings of a valid installation, and startup refuses each change.
const sandboxOf = (configuration: SandboxInstallation) =>
  configuration.drivers.sandbox.configuration;
const policiesOf = (configuration: SandboxInstallation) =>
  sandboxOf(configuration).policy.networkPolicies;
const endpointOf = (configuration: SandboxInstallation) => {
  const endpoint = policiesOf(configuration)[0]?.endpoints[0];
  assert.ok(endpoint);
  return endpoint;
};
const readinessWait = {
  serviceName: "openshell-gateway",
  podSelector: { "app.kubernetes.io/name": "openshell" },
};

// The gateway refuses these in CreateSandbox, which runs only after a dedicated deploy has
// stopped its predecessors, so startup applies the same rules (findings 2331-2333).
const invalidValue = (path: string, message: string): RefusalDetail[] => [
  { path, code: "INVALID_VALUE", message },
];

// Typos in these objects were ignored, and the Gateway refused Agent resources it cannot
// decode, or the API server their quantities, after a deploy stopped its predecessors
// (findings 2353, 2356).
test("startup refuses unknown OpenShell settings and invalid Agent resource quantities", async (t) => {
  for (const [change, path] of [
    [(c) => Object.assign(sandboxOf(c).kubernetes, { userNamespace: false }), "/kubernetes"],
    [
      (c) => Object.assign(sandboxOf(c).kubernetes.serviceAccount, { name: "sandbox" }),
      "/kubernetes/serviceAccount",
    ],
    [
      (c) => Object.assign(sandboxOf(c).kubernetes.sandboxDataMount, { readonly: true }),
      "/kubernetes/sandboxDataMount",
    ],
    [
      (c) => Object.assign(sandboxOf(c).kubernetes, { agentResources: { request: {} } }),
      "/kubernetes/agentResources",
    ],
    [(c) => Object.assign(sandboxOf(c).policy, { filesytem: { readWrite: ["/data"] } }), "/policy"],
    [
      (c) => Object.assign(sandboxOf(c).policy.process, { runAsUserName: "sandbox" }),
      "/policy/process",
    ],
    [
      (c) =>
        Object.assign(sandboxOf(c).gateway, {
          readiness: { ...readinessWait, timeoutMs: 1, pollInterval: 5 },
        }),
      "/gateway/readiness",
    ],
  ] satisfies [ConfigurationMutation, string][]) {
    await rejectsAtStartup(
      t,
      change,
      structuralRefusal(path, "additionalProperties", "UNKNOWN_FIELD"),
    );
  }
  const quantity =
    "Each value must be a quoted, non-negative Kubernetes quantity, such as 500m or 1Gi.";
  for (const agentResources of [
    { requests: { cpu: "one" } },
    { limits: { memory: 5 } },
    // Quantities are strings: without the type check 512 would parse as a quantity (5 does not).
    { requests: { memory: 512 } },
    { limits: { cpu: "1", "example.com/gpu": "1 Gi" } },
    { requests: { cpu: "-500m" } },
  ]) {
    const [section] = Object.keys(agentResources);
    await rejectsAtStartup(
      t,
      (c) => Object.assign(sandboxOf(c).kubernetes, { agentResources }),
      invalidValue(`/kubernetes/agentResources/${section}`, quantity),
    );
  }
  await rejectsAtStartup(
    t,
    (c) =>
      Object.assign(sandboxOf(c).kubernetes, {
        agentResources: {
          requests: { cpu: "1500m", memory: "1Gi" },
          limits: { cpu: "1", memory: "2Gi" },
        },
      }),
    [
      {
        path: "/kubernetes/agentResources/requests",
        code: "INVALID_RANGE",
        message: "The cpu request (1500m) cannot exceed its limit (1).",
      },
    ],
  );
  // Every resource is compared, not only the first.
  await rejectsAtStartup(
    t,
    (c) =>
      Object.assign(sandboxOf(c).kubernetes, {
        agentResources: {
          requests: { cpu: "1", memory: "3Gi" },
          limits: { cpu: "1", memory: "2Gi" },
        },
      }),
    [
      {
        path: "/kubernetes/agentResources/requests",
        code: "INVALID_RANGE",
        message: "The memory request (3Gi) cannot exceed its limit (2Gi).",
      },
    ],
  );
  // An invalid limit is reported once, without also comparing the request against it.
  await rejectsAtStartup(
    t,
    (c) =>
      Object.assign(sandboxOf(c).kubernetes, {
        agentResources: {
          requests: { cpu: "1" },
          limits: { cpu: "-1" },
        },
      }),
    invalidValue("/kubernetes/agentResources/limits", quantity),
  );
  // Control: every known key, and quantities in each spelling the API server accepts, load.
  const accepted = sandboxInstallation();
  Object.assign(sandboxOf(accepted).kubernetes, {
    // Zero is a valid quantity, and a request needs no limit.
    agentResources: {
      requests: {
        cpu: "500m",
        memory: "1Gi",
        "example.com/gpu": "1",
        "ephemeral-storage": "0",
      },
      limits: { cpu: "0.5", memory: "4e9", "example.com/gpu": "1" },
    },
  });
  Object.assign(sandboxOf(accepted).kubernetes.sandboxDataMount, { claimName: "workspace" });
  Object.assign(sandboxOf(accepted).gateway, {
    readiness: { ...readinessWait, timeoutMs: 1, pollIntervalMs: 5 },
  });
  await loadInstallationFile(t, accepted);
});

test("startup refuses invalid or conflicting exact-Agent resource overrides", async (t) => {
  const override = {
    namespaceId: "ns_00000000-0000-4000-8000-000000000001",
    agentId: "agt_00000000-0000-4000-8000-000000000003",
    requests: { cpu: "88" },
    limits: { cpu: "90" },
  };
  const path = "/kubernetes/agentResourceOverrides";
  for (const [field, value] of [
    ["namespaceId", `${override.namespaceId} `],
    ["agentId", "agent-display-name"],
  ] as const) {
    await t.test(`refuses a malformed ${field}`, async (scopeTest) => {
      await rejectsAtStartup(
        scopeTest,
        (c) => {
          Reflect.set(sandboxOf(c).kubernetes, "agentResourceOverrides", [
            { ...override, [field]: value },
          ]);
        },
        structuralRefusal(`${path}/0/${field}`, "pattern", "INVALID_FORMAT"),
      );
    });
  }
  await rejectsAtStartup(
    t,
    (c) => {
      Reflect.set(sandboxOf(c).kubernetes, "agentResourceOverrides", [override, override]);
    },
    invalidValue(`${path}/1`, "An Agent can have only one resource override."),
  );
  await rejectsAtStartup(
    t,
    (c) => {
      Reflect.set(sandboxOf(c).kubernetes, "agentResourceOverrides", [
        { ...override, requests: { cpu: "-1" } },
      ]);
    },
    invalidValue(
      `${path}/0/requests`,
      "Each value must be a quoted, non-negative Kubernetes quantity, such as 500m or 1Gi.",
    ),
  );
  await rejectsAtStartup(
    t,
    (c) => {
      const kubernetes = sandboxOf(c).kubernetes;
      Object.assign(kubernetes, {
        agentResources: { requests: { cpu: "1" }, limits: { cpu: "4" } },
      });
      Reflect.set(kubernetes, "agentResourceOverrides", [{ ...override, limits: {} }]);
    },
    [
      {
        path: `${path}/0/requests`,
        code: "INVALID_RANGE",
        message: "The cpu request (88) cannot exceed its limit (4).",
      },
    ],
  );
  await rejectsAtStartup(
    t,
    (c) => {
      Reflect.set(sandboxOf(c).kubernetes, "agentResourceOverrides", [
        { ...override, limits: { "ephemeral-storage": "2Gi" } },
      ]);
    },
    structuralRefusal(`${path}/0/limits`, "additionalProperties", "UNKNOWN_FIELD"),
  );
  await rejectsAtStartup(
    t,
    (c) => {
      Reflect.set(sandboxOf(c).kubernetes, "agentResourceOverrides", [
        { ...override, runtimeClassName: "bad/Name" },
      ]);
    },
    invalidValue(`${path}/0/runtimeClassName`, "Use a Kubernetes RuntimeClass resource name."),
  );
});

// The Gateway refuses these protocols at CreateSandbox (finding 2335): unknown names, L7
// protocols without an access preset, access or enforcement on tcp, enforce on sql, and json-rpc
// or mcp, which need rules.
test("startup refuses OpenShell endpoint protocols the gateway refuses", async (t) => {
  const unknown =
    "Use tcp, rest, websocket, graphql or sql, or omit protocol; OpenShell needs rules for json-rpc and mcp, which this setting cannot express.";
  const tcpExtras =
    "Protocol tcp takes neither an access preset nor enforcement; remove them, or use an L7 protocol.";
  for (const [endpoint, message] of [
    [{ protocol: "http" }, unknown],
    [{ protocol: "json-rpc" }, unknown],
    [{ protocol: "mcp", access: "full" }, unknown],
    [{ protocol: "rest" }, "Protocol rest needs an access preset (read_only, read_write or full)."],
    [
      { protocol: "WebSocket" },
      "Protocol websocket needs an access preset (read_only, read_write or full).",
    ],
    [{ protocol: "tcp", access: "full" }, tcpExtras],
    [{ protocol: "TCP", enforcement: "audit" }, tcpExtras],
    [
      { protocol: "sql", access: "read_only", enforcement: "enforce" },
      "Protocol sql supports enforcement audit only, since OpenShell cannot fully parse SQL.",
    ],
  ] as const) {
    await rejectsAtStartup(
      t,
      (c) => Object.assign(endpointOf(c), endpoint),
      invalidValue("/policy/networkPolicies/0/endpoints/0/protocol", message),
    );
  }
  // Every policy and endpoint is checked, and each detail names its own indexes.
  await rejectsAtStartup(
    t,
    (c) => {
      const firstPolicy = policiesOf(c)[0];
      assert.ok(firstPolicy);
      firstPolicy.endpoints.push(
        Object.assign({ host: "tools.example.test", ports: [443] }, { protocol: "http" }),
      );
      policiesOf(c).push({
        name: "database",
        endpoints: [
          Object.assign({ host: "db.example.test", ports: [5432] }, { protocol: "rest" }),
        ],
        binaries: [{ path: "/app/bin/model-client" }],
      });
    },
    [
      ...invalidValue("/policy/networkPolicies/0/endpoints/1/protocol", unknown),
      ...invalidValue(
        "/policy/networkPolicies/1/endpoints/0/protocol",
        "Protocol rest needs an access preset (read_only, read_write or full).",
      ),
    ],
  );
  // Control: the protocols the Gateway accepts without rules.
  for (const endpoint of [
    { protocol: "tcp" },
    { protocol: "TCP" },
    { protocol: "" },
    { protocol: "rest", access: "read_only" },
    { protocol: "sql", access: "full" },
    { protocol: "SQL", access: "full", enforcement: "audit" },
    { protocol: "graphql", access: "read_write", enforcement: "enforce" },
  ]) {
    const configuration = sandboxInstallation();
    Object.assign(endpointOf(configuration), endpoint);
    const loaded = await loadInstallationFile(t, configuration);
    // Some Gateway checks compare lowercase names, so the policy carries the protocol lowercase.
    const driver = loaded?.sandboxDriver;
    assert.ok(driver instanceof OpenShellSandboxDriver);
    const policy = asRecord(driver.admitNetworkPolicy([], 1).defaults["model-egress"]);
    assert.ok(policy);
    const endpoints = policy.endpoints;
    assert.ok(Array.isArray(endpoints));
    const sent = asRecord(endpoints[0]);
    assert.equal(sent?.protocol, endpoint.protocol.toLowerCase());
  }
});

// The schema leaves these open, so the Driver's own checks are the only refusal. Startup
// reports each as the same generic detail, so every case must change one valid field of
// the fixture, and the control below shows the fixture loads otherwise.
test("startup refuses OpenShell settings its schema leaves open", async (t) => {
  const refused = invalidValue("", "Configuration violates the Driver's constraints.");
  const dataMount = (c: SandboxInstallation) => sandboxOf(c).kubernetes.sandboxDataMount;
  for (const change of [
    (c) => Reflect.deleteProperty(sandboxOf(c).gateway, "workspaceMode"),
    // labels() refuses an empty map before the explicit empty check does.
    (c) => Object.assign(sandboxOf(c).gateway, { operatorNamespaceLabels: {} }),
    (c) =>
      Object.assign(sandboxOf(c).gateway, {
        operatorWorkspaceResources: [
          { apiVersion: "v2", kind: "ServiceAccount", metadata: { name: "sandbox" } },
        ],
      }),
    (c) =>
      Object.assign(sandboxOf(c).gateway, {
        readiness: { ...readinessWait, serviceName: "", timeoutMs: 1 },
      }),
    (c) => (dataMount(c).subPath = "."),
    (c) => (dataMount(c).mountPath = "/data"),
    (c) => Reflect.deleteProperty(dataMount(c), "readOnly"),
    // Sandbox names need 17 characters after the prefix (a dash and a 16-character hash),
    // and OpenShell allows 19.
    (c) => Object.assign(sandboxOf(c), { sandboxNamePrefix: "abc" }),
  ] satisfies ConfigurationMutation[]) {
    await rejectsAtStartup(t, change, refused);
  }
  // Control: the same fields load with accepted values.
  const accepted = sandboxInstallation();
  Object.assign(sandboxOf(accepted).gateway, {
    operatorNamespaceLabels: { team: "agents" },
    operatorWorkspaceResources: [
      { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "sandbox" } },
    ],
    readiness: { ...readinessWait, timeoutMs: 1 },
  });
  Object.assign(dataMount(accepted), {
    subPath: "a/b",
    mountPath: "/sandbox/data",
    readOnly: true,
  });
  Object.assign(sandboxOf(accepted), { sandboxNamePrefix: "ab" });
  await loadInstallationFile(t, accepted);
});
