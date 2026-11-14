import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as sdk from "../../apps/controller/node_modules/@kubernetes/client-node/dist/index.js";
import type { OpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import {
  OpenShellSandboxDriver,
  type OpenShellSandboxDriverOptions,
} from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import {
  ConfigurationValidationError,
  type SandboxNamespaceContext,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { openShellWorkspaceChartResources } from "../fixtures/openshell-workspace-chart.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { callCount } from "./sandbox-driver-gateway-response-fixture.ts";
import { buildOperatorIngressManifests } from "./sandbox-driver-operator-chart-case.ts";
import { backendFor, openShellDriver } from "./sandbox-driver-openshell-fixture.ts";
import {
  buildSandboxInstallation,
  rejectsAtStartup,
} from "./sandbox-driver-startup-installation-fixture.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

type Resource = Record<string, unknown> & { metadata: { name: string; labels?: unknown } };
type Discovery = Record<string, readonly { name: string; kind: string; namespaced: boolean }[]>;
type Gateway = OpenShellGatewayClient & Pick<ReturnType<typeof workspaceGatewayClient>, "calls">;

const namespace = {
  id: "ns_00000000-0000-4000-8000-000000000001",
  name: "oce-123456789012345",
  status: "ready",
  createdAt: "2026-09-23T00:00:00.000Z",
} satisfies SandboxNamespaceContext["namespace"];

const coreDiscovery = {
  "/api/v1": [
    { name: "namespaces", kind: "Namespace", namespaced: false },
    { name: "serviceaccounts", kind: "ServiceAccount", namespaced: true },
  ],
};
const policyDiscovery = {
  "/apis/networking.k8s.io/v1": [
    { name: "networkpolicies", kind: "NetworkPolicy", namespaced: true },
  ],
  "/apis/crd.antrea.io/v1beta1": [
    { name: "networkpolicies", kind: "NetworkPolicy", namespaced: true },
  ],
};
const rbacDiscovery = {
  "/apis/rbac.authorization.k8s.io/v1": [
    { name: "roles", kind: "Role", namespaced: true },
    { name: "rolebindings", kind: "RoleBinding", namespaced: true },
  ],
};

function owned<T extends Resource>(resource: T) {
  return {
    ...resource,
    metadata: {
      ...resource.metadata,
      namespace: namespace.name,
      labels: {
        ...asRecord(resource.metadata.labels),
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": namespace.id,
      },
      annotations: { "openclaw.dev/namespace-id": namespace.id },
    },
  };
}

function objectApi(
  discovery: Discovery,
  read?: (path: string) => Resource,
  afterRead?: (value: sdk.KubernetesObject) => void,
) {
  const writes: { method: string; body: unknown }[] = [];
  const writeAttempts: string[] = [];
  // Use the SDK transport so discovery, request serialization, and response decoding all run.
  const configuration = sdk.createConfiguration({
    baseServer: new sdk.ServerConfiguration("http://127.0.0.1:9", {}),
    httpApi: sdk.wrapHttpLibrary({
      async send(request) {
        const method = request.getHttpMethod();
        const path = new URL(request.getUrl()).pathname;
        let response: unknown;
        if (method === "GET") {
          const resources = discovery[path];
          if (resources !== undefined) {
            response = { resources };
          } else if (path === `/api/v1/namespaces/${namespace.name}`) {
            response = { apiVersion: "v1", kind: "Namespace", metadata: { name: namespace.name } };
          } else {
            assert.ok(read, `Unexpected Kubernetes read at ${path}`);
            response = read(path);
          }
        } else {
          writeAttempts.push(method);
          assert.equal(method, "PATCH", `Unexpected Kubernetes write at ${path}`);
          const data = request.getBody();
          assert.ok(typeof data === "string", "Kubernetes PATCH must carry a JSON body.");
          const body: unknown = JSON.parse(data);
          writes.push({ method, body });
          response = body;
        }
        const json = JSON.stringify(response);
        return new sdk.ResponseContext(
          200,
          { "content-type": "application/json" },
          {
            text: async () => json,
            binary: async () => Buffer.from(json),
            stream: () => null,
          },
        );
      },
    }),
  });

  // An extension field that survived decoding must also fail the Driver comparison.
  class ExtensionObservingApi extends sdk.KubernetesObjectApi {
    protected override async processResponse<T extends sdk.KubernetesObject>(
      response: sdk.ResponseContext,
      type?: string,
    ): Promise<T> {
      const value = await super.processResponse<T>(response, type);
      afterRead?.(value);
      return value;
    }
  }

  const api =
    afterRead === undefined
      ? new sdk.KubernetesObjectApi(configuration)
      : new ExtensionObservingApi(configuration);
  const context = {
    namespace,
    kubernetes: api,
    signal: new AbortController().signal,
  } satisfies SandboxNamespaceContext;
  return { api, context, writes, writeAttempts };
}

function unexpectedGatewayOperation(): never {
  throw new Error("Unexpected OpenShell Gateway operation in a Kubernetes resource case.");
}

function operatorGateway(): Gateway {
  return {
    ...workspaceGatewayClient(),
    getProviderProfile: unexpectedGatewayOperation,
    listProviderProfiles: unexpectedGatewayOperation,
    getServiceUrl: unexpectedGatewayOperation,
    deleteService: unexpectedGatewayOperation,
    execSandbox: unexpectedGatewayOperation,
    getServiceDocument: unexpectedGatewayOperation,
    postServiceDocument: unexpectedGatewayOperation,
    serviceWebSocketHandshake: unexpectedGatewayOperation,
    serviceCodexReadinessStatus: unexpectedGatewayOperation,
    getProviderCredential: unexpectedGatewayOperation,
    detachSandboxProvider: unexpectedGatewayOperation,
    getSandboxProviderStatus: unexpectedGatewayOperation,
    configureProviderRefresh: unexpectedGatewayOperation,
    rotateProviderCredential: unexpectedGatewayOperation,
    getProviderRefreshStatus: unexpectedGatewayOperation,
    deleteProviderRefresh: unexpectedGatewayOperation,
    getSandboxLogs: unexpectedGatewayOperation,
  };
}

function sandboxConfiguration(gateway: Partial<OpenShellSandboxDriverOptions["gateway"]> = {}) {
  const base = buildSandboxInstallation().drivers.sandbox.configuration;
  return { ...base, gateway: { ...base.gateway, ...gateway } };
}

function operatorOwnedDriver(configuration: OpenShellSandboxDriverOptions, gateway: Gateway) {
  return new OpenShellSandboxDriver(configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gateway),
    operatorOwnedKubernetesResources: true,
  });
}

export function registerSandboxDriverOperatorKubernetesCases() {
  test("OpenShell verifies operator NetworkPolicy from actual KubernetesObjectApi deserialization", async () => {
    const policy = {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "operator-ingress" },
      spec: {
        podSelector: { matchLabels: { app: "sandbox" } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [{ podSelector: { matchLabels: { app: "worker" } } }],
            ports: [{ protocol: "TCP", port: 8080 }],
          },
        ],
      },
    };
    const gateway = operatorGateway();
    const configuration = sandboxConfiguration({ networkPolicyResources: [policy] });
    const driver = operatorOwnedDriver(configuration, gateway);
    const denyPolicy = {
      ...policy,
      spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"], ingress: [], egress: [] },
    };
    let wire: Resource = owned(structuredClone(policy));
    const { api, context, writeAttempts } = objectApi(
      { ...coreDiscovery, ...policyDiscovery },
      (path) => {
        assert.equal(
          path,
          `/apis/networking.k8s.io/v1/namespaces/${namespace.name}/networkpolicies/operator-ingress`,
        );
        return wire;
      },
    );
    const observed: unknown = await api.read(owned(policy));
    assert.ok(observed instanceof sdk.V1NetworkPolicy);
    const ingress = observed.spec?.ingress?.[0];
    assert.ok(ingress instanceof sdk.V1NetworkPolicyIngressRule);
    assert.ok(ingress._from);
    assert.equal(Reflect.get(ingress, "from"), undefined);
    await driver.ensureNamespace(context);
    assert.equal(callCount(gateway, "createWorkspace"), 1);

    const callsBeforeRefusals = gateway.calls.length;
    const firstRule = policy.spec.ingress[0];
    assert.ok(firstRule);
    for (const changed of [
      { ...firstRule, from: [{}] },
      { ...firstRule, ports: [{ protocol: "TCP", port: 9090 }] },
    ]) {
      wire = owned({ ...policy, spec: { ...policy.spec, ingress: [changed] } });
      await assert.rejects(
        driver.ensureNamespace(context),
        /Operator workspace resource does not match/,
      );
    }
    assert.equal(gateway.calls.length, callsBeforeRefusals);

    // An SDK-only alias is invalid in a configuration wire manifest.
    const alias = {
      ...policy,
      spec: {
        ...policy.spec,
        ingress: [{ _from: firstRule.from, ports: firstRule.ports }],
      },
    };
    assert.throws(
      () => operatorOwnedDriver(sandboxConfiguration({ networkPolicyResources: [alias] }), gateway),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationValidationError);
        assert.deepEqual(error.error.details, [
          {
            path: "/gateway/networkPolicyResources",
            code: "INVALID_VALUE",
            message: "Name NetworkPolicy ingress sources with the Kubernetes field from.",
          },
        ]);
        return true;
      },
    );

    // The API server can omit empty rule lists without changing which traffic the policy denies.
    const denyDriver = operatorOwnedDriver(
      sandboxConfiguration({ networkPolicyResources: [denyPolicy] }),
      gateway,
    );
    const denySpec = { podSelector: {}, policyTypes: ["Ingress", "Egress"] };
    wire = owned({ ...denyPolicy, spec: denySpec });
    await denyDriver.ensureNamespace(context);
    const callsBeforeDenyRefusals = gateway.calls.length;
    for (const changed of [
      { ingress: [{}] },
      { egress: [{}] },
      { policyTypes: ["Ingress"] },
      { podSelector: { matchLabels: { app: "other" } } },
    ]) {
      wire = owned({ ...denyPolicy, spec: { ...denySpec, ...changed } });
      await assert.rejects(
        denyDriver.ensureNamespace(context),
        /Operator workspace resource does not match/,
      );
    }
    assert.equal(gateway.calls.length, callsBeforeDenyRefusals);
    assert.deepEqual(writeAttempts, []);
  });

  // The core SDK uses _from internally. The server must receive the restricted wire "from".
  test("OpenShell operator mode applies NetworkPolicy ingress sources through the SDK serializer", async () => {
    const { ingress, policy, crdIngress, crdPolicy } = buildOperatorIngressManifests();
    const configuration = sandboxConfiguration({
      operatorWorkspaceResources: [policy("openshell-workspace-sandbox-ssh")],
      networkPolicyResources: [policy("provider-ingress"), crdPolicy],
    });
    const gateway = operatorGateway();
    const driver = openShellDriver(gateway, configuration);
    const { context, writes } = objectApi(policyDiscovery);
    await driver.ensureNamespace(context);

    assert.deepEqual(
      writes.map(({ method, body }) => {
        const record = asRecord(body);
        return [method, asRecord(record?.metadata)?.name, asRecord(record?.spec)?.ingress];
      }),
      [
        ["PATCH", "openshell-workspace-sandbox-ssh", ingress],
        ["PATCH", "provider-ingress", ingress],
        ["PATCH", "provider-crd-ingress", crdIngress],
      ],
    );
    assert.equal(callCount(gateway, "createWorkspace"), 1);
    assert.deepEqual(
      asRecord(configuration.gateway.operatorWorkspaceResources?.[0]?.spec)?.ingress,
      ingress,
    );
  });

  // A field discarded by SDK serialization could widen a rule, such as a typo in a Pod selector.
  test(
    "startup refuses operator Kubernetes fields the client would not send as written",
    refusesUnsentKubernetesFields,
  );

  test("OpenShell startup admits and applies the stock workspace chart exactly as written", async (t) => {
    const { chart, forms, crd, installation } = await prepareStockWorkspaceChart(t);
    const driver = openShellDriver(operatorGateway(), installation.drivers.sandbox.configuration);
    const { context, writes } = objectApi({
      ...coreDiscovery,
      ...rbacDiscovery,
      ...policyDiscovery,
    });
    await driver.ensureNamespace(context);
    // The Driver adds ownership metadata without altering the chart or provider value forms.
    assert.deepEqual(
      writes,
      [...chart, forms, crd].map((resource) => ({ method: "PATCH", body: owned(resource) })),
    );
  });

  for (const kind of ["Role", "RoleBinding"] as const) {
    test(`OpenShell verifies operator ${kind} from actual KubernetesObjectApi deserialization`, async () => {
      const role = {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "Role",
        metadata: { name: "workspace-reader" },
        rules: [{ apiGroups: [""], resources: ["pods"], verbs: ["get"] }],
      };
      const binding = {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "RoleBinding",
        metadata: { name: "workspace-reader" },
        roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: role.metadata.name },
        subjects: [
          { kind: "ServiceAccount", name: "openshell-sandbox", namespace: namespace.name },
        ],
      };
      const resource = kind === "Role" ? role : binding;
      const configuration = sandboxConfiguration({ operatorWorkspaceResources: [resource] });
      const gateway = operatorGateway();
      const driver = operatorOwnedDriver(configuration, gateway);
      let wire = owned(structuredClone(resource));
      let addUnknown = false;
      const plural = kind === "Role" ? "roles" : "rolebindings";
      const { api, context, writeAttempts } = objectApi(
        { ...coreDiscovery, ...rbacDiscovery },
        (path) => {
          assert.equal(
            path,
            `/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace.name}/${plural}/workspace-reader`,
          );
          return wire;
        },
        (observed) => {
          if (!addUnknown) {
            return;
          }
          const field =
            observed instanceof sdk.V1Role
              ? observed.rules?.[0]
              : observed instanceof sdk.V1RoleBinding
                ? observed.subjects?.[0]
                : undefined;
          if (observed instanceof sdk.V1Role || observed instanceof sdk.V1RoleBinding) {
            assert.ok(field);
            Reflect.set(field, "unexpected", true);
          }
        },
      );
      const observed: unknown = await api.read(wire);
      if (kind === "Role") {
        assert.ok(observed instanceof sdk.V1Role);
        assert.ok(observed.rules?.[0] instanceof sdk.V1PolicyRule);
      } else {
        assert.ok(observed instanceof sdk.V1RoleBinding);
        assert.ok(observed.subjects?.[0] instanceof sdk.RbacV1Subject);
      }
      await driver.ensureNamespace(context);
      assert.equal(callCount(gateway, "createWorkspace"), 1);

      // Changes in RBAC authority must fail before any Gateway access or Kubernetes write.
      const rule = role.rules[0];
      const subject = binding.subjects[0];
      assert.ok(rule && subject);
      const changes =
        kind === "Role"
          ? [
              { ...role, rules: [{ ...rule, verbs: ["get", "delete"] }] },
              { ...role, rules: [{ ...rule, resources: ["pods", "secrets"] }] },
              { ...role, rules: [rule, { ...rule, resources: ["secrets"] }] },
            ]
          : [
              { ...binding, subjects: [{ ...subject, name: "different-account" }] },
              { ...binding, subjects: [subject, { ...subject, name: "extra-account" }] },
              { ...binding, roleRef: { ...binding.roleRef, name: "different-role" } },
            ];
      const callsBeforeRefusals = gateway.calls.length;
      for (const changed of changes) {
        wire = owned(changed);
        await assert.rejects(
          driver.ensureNamespace(context),
          /Operator workspace resource does not match/,
        );
      }
      wire = owned(structuredClone(resource));
      addUnknown = true;
      await assert.rejects(
        driver.ensureNamespace(context),
        /Operator workspace resource does not match/,
      );
      assert.equal(gateway.calls.length, callsBeforeRefusals);
      assert.deepEqual(writeAttempts, []);
      assert.deepEqual(configuration.gateway.operatorWorkspaceResources, [resource]);
    });
  }
}

async function prepareStockWorkspaceChart(t: TestContext) {
  const chart = openShellWorkspaceChartResources();
  const forms = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "value-forms" },
    spec: {
      podSelector: {},
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        {
          from: [],
          ports: [
            { protocol: "TCP", port: "ssh" },
            { port: 1000, endPort: 2000 },
          ],
        },
        { from: null },
        {},
        { from: [{ ipBlock: { cidr: "10.0.0.0/8", except: [] } }] },
      ],
      egress: [{ to: [{ namespaceSelector: {}, podSelector: { matchExpressions: [] } }] }],
    },
  };
  const crd = {
    apiVersion: "crd.antrea.io/v1beta1",
    kind: "NetworkPolicy",
    metadata: { name: "provider-crd" },
    spec: { priority: 5, appliedTo: [{ podSelector: {} }], ingress: [{ action: "Allow" }] },
  };
  const installation = buildSandboxInstallation();
  Object.assign(installation.drivers.sandbox.configuration.gateway, {
    operatorWorkspaceResources: chart,
    networkPolicyResources: [forms, crd],
  });
  await loadInstallationFile(t, installation);
  return { chart, forms, crd, installation };
}

async function refusesUnsentKubernetesFields(t: TestContext) {
  const policy = (spec: object) => ({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "provider-policy" },
    spec,
  });
  const [ssh, account, role, binding] = openShellWorkspaceChartResources();
  assert.ok(ssh && account && role && binding);
  const renamed = (
    resource: object,
    path: (string | number)[],
    from: string,
    to: string,
  ): object => {
    const copy = structuredClone(resource);
    const parent = path.reduce<unknown>((value, key) => {
      assert.ok(typeof value === "object" && value !== null);
      const child: unknown = Reflect.get(value, key);
      return child;
    }, copy);
    const record = asRecord(parent);
    assert.ok(record);
    assert.ok(Object.hasOwn(record, from));
    record[to] = record[from];
    delete record[from];
    return copy;
  };
  const unsent = (field: string) =>
    `The Kubernetes client does not send item 1 field ${field} as written. Use the Kubernetes field name and type.`;
  const cases: ["networkPolicyResources" | "operatorWorkspaceResources", object, string[]][] = [
    [
      "networkPolicyResources",
      policy({
        podSelector: {},
        ingress: [{ from: [{ podSelector: { matchLabel: { app: "worker" } } }] }],
      }),
      [unsent("/spec/ingress/0/from/0/podSelector/matchLabel")],
    ],
    [
      // The model names LimitRange `default` `_default`, so the wire field is dropped.
      "networkPolicyResources",
      {
        apiVersion: "v1",
        kind: "LimitRange",
        metadata: { name: "limits" },
        spec: {
          limits: [{ type: "Container", default: { cpu: "1" }, defaultRequests: { cpu: "1" } }],
        },
      },
      [unsent("/spec/limits/0/default"), unsent("/spec/limits/0/defaultRequests")],
    ],
    [
      // A custom resource passes through except its metadata, which the client still models.
      "networkPolicyResources",
      {
        apiVersion: "crd.antrea.io/v1beta1",
        kind: "NetworkPolicy",
        metadata: { name: "provider-crd", label: { app: "worker" } },
        spec: {},
      },
      [unsent("/metadata/label")],
    ],
    [
      // A list written as a string is sent split into characters.
      "networkPolicyResources",
      policy({ podSelector: {}, ingress: [{ ports: "2222" }] }),
      [unsent("/spec/ingress/0/ports")],
    ],
    [
      "networkPolicyResources",
      policy({ podSelector: {}, ingress: { from: [] } }),
      ["The Kubernetes client cannot serialize item 1. Use the Kubernetes field types."],
    ],
    [
      "operatorWorkspaceResources",
      renamed(ssh, ["spec", "podSelector"], "matchLabels", "matchLabel"),
      [unsent("/spec/podSelector/matchLabel")],
    ],
    [
      "operatorWorkspaceResources",
      { ...account, automountServiceAccountTokens: false },
      [unsent("/automountServiceAccountTokens")],
    ],
    [
      "operatorWorkspaceResources",
      renamed(role, ["rules", 0], "verbs", "verb"),
      [unsent("/rules/0/verb")],
    ],
    [
      "operatorWorkspaceResources",
      renamed(binding, [], "subjects", "subject"),
      [unsent("/subject")],
    ],
  ];
  for (const [list, resource, messages] of cases) {
    await rejectsAtStartup(
      t,
      (c) =>
        Object.assign(c.drivers.sandbox.configuration.gateway, {
          [list]: [
            { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "first" } },
            resource,
          ],
        }),
      // Both lists are write-only, so the detail names the list and the message the field.
      messages.map((message) => ({ path: `/gateway/${list}`, code: "INVALID_VALUE", message })),
    );
  }
}
