import assert from "node:assert/strict";
import test from "node:test";

import type { Namespace, NamespaceEnsureResult } from "@openclaw-enterprise/contracts";
import {
  KubernetesComputeDriver,
  PreprovisionedKubernetesNamespace,
  type KubernetesComputeDriverOptions,
  type KubernetesGatewayRoutingOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  kubernetesList,
  kubernetesNotFound,
  persistedKubernetesObject,
  startKubernetesSdkApi,
} from "../helpers/kubernetes-sdk-api.ts";

const tenant: Namespace = {
  id: "ns_00000000-0000-4000-8000-000000000001",
  name: "Sealed policy conformance",
  status: "provisioning",
  createdAt: "2026-01-01T00:00:00.000Z",
};
// The operator provisions this exact name for the bound tenant ID.
const namespace = "oce-89d99db2f971e50";
const uid = "00000000-0000-4000-8000-000000000001";
const routing = {
  gatewayName: "gateway",
  gatewayNamespace: "controller",
  envoyNamespace: "envoy",
} satisfies KubernetesGatewayRoutingOptions;
const owner = {
  labels: {
    "app.kubernetes.io/managed-by": "openclaw-enterprise",
    "openclaw.dev/namespace": tenant.id,
  },
  annotations: { "openclaw.dev/namespace-id": tenant.id },
};
const boundNamespace = {
  apiVersion: "v1",
  kind: "Namespace",
  metadata: {
    ...owner,
    name: namespace,
    uid,
    resourceVersion: "1",
    labels: {
      ...owner.labels,
      "openclaw.dev/gateway-namespace": tenant.id,
      // The installation uses the controller/gateway membership label.
      "openclaw-enterprise.io/gateway": "074084a69130",
      "pod-security.kubernetes.io/enforce": "restricted",
      "pod-security.kubernetes.io/audit": "restricted",
      "pod-security.kubernetes.io/warn": "restricted",
    },
    annotations: { ...owner.annotations, "openclaw.dev/namespace-lifecycle": "preprovisioned" },
  },
  status: { phase: "Active" },
};

interface PolicySpec {
  readonly podSelector: { readonly matchLabels?: Readonly<Record<string, string>> };
  readonly policyTypes: readonly ("Ingress" | "Egress")[];
  readonly ingress?: readonly {
    readonly from?: readonly { readonly podSelector?: PolicySpec["podSelector"] }[];
    readonly ports?: readonly { readonly protocol: "TCP"; readonly port: number }[];
  }[];
  readonly egress?: readonly object[];
}

const policyApiVersion = "networking.k8s.io/v1";
const policyName = "operator-ingress";
function operatorPolicy(spec: PolicySpec, name = policyName) {
  return {
    apiVersion: policyApiVersion,
    kind: "NetworkPolicy",
    metadata: { ...owner, name, namespace },
    spec,
  };
}

const peers = [{ podSelector: { matchLabels: { app: "worker" } } }];
const ports = [{ protocol: "TCP", port: 8080 }] as const;
const wireIngress: PolicySpec = {
  podSelector: { matchLabels: { app: "gateway" } },
  policyTypes: ["Ingress"],
  ingress: [{ from: peers, ports }],
};
const declaredIngress = {
  podSelector: { matchLabels: { app: "gateway" } },
  policyTypes: ["Ingress"],
  ingress: [
    {
      from: [{ podSelector: { matchLabels: { app: "worker" } } }],
      ports: [{ protocol: "TCP", port: 8080 }],
    },
  ],
} satisfies PolicySpec;
const omitted: PolicySpec = { podSelector: {}, policyTypes: ["Ingress", "Egress"] };
const empty = { ...omitted, ingress: [], egress: [] };
const namespacePath = `/api/v1/namespaces/${namespace}`;
const policyPath = `/apis/networking.k8s.io/v1/namespaces/${namespace}/networkpolicies`;
const infrastructure = [
  [`${namespacePath}/resourcequotas/openclaw-quota`, "v1", "ResourceQuota", "openclaw-quota"],
  [`${namespacePath}/limitranges/openclaw-limits`, "v1", "LimitRange", "openclaw-limits"],
  [`${policyPath}/default-deny`, policyApiVersion, "NetworkPolicy", "default-deny"],
  [`${policyPath}/allow-dns`, policyApiVersion, "NetworkPolicy", "allow-dns"],
  [
    `${policyPath}/allow-gateway-ingress`,
    policyApiVersion,
    "NetworkPolicy",
    "allow-gateway-ingress",
  ],
] as const;
const ready: NamespaceEnsureResult = { namespaceId: tenant.id, namespaceReady: true };
const refused: NamespaceEnsureResult = {
  namespaceId: tenant.id,
  namespaceReady: false,
  failure: "permanent",
  reason: "The sealed Namespace contains an undeclared or changed NetworkPolicy.",
};

export function registerSealedNamespacePolicyCase(): void {
  // The fixture supplies Kubernetes wire responses. The public Driver owns verification and apply.
  test("sealed Namespace compares SDK-deserialized ingress exactly", async (t) => {
    let observed: readonly ReturnType<typeof operatorPolicy>[] = [];
    const applied = new Map<string, object>();
    let observedNamespace = boundNamespace;
    const api = await startKubernetesSdkApi(t, {
      name: "sealed-namespace-policy",
      respond(request) {
        if (request.method === "GET" && request.pathname === namespacePath) {
          return { body: observedNamespace };
        }
        if (request.method === "GET" && request.pathname === policyPath) {
          assert.deepEqual([...request.searchParams.keys()], ["timeoutSeconds"]);
          return { body: kubernetesList(policyApiVersion, "NetworkPolicy", observed) };
        }
        const resource = infrastructure.find(([path]) => path === request.pathname);
        if (resource === undefined) {
          return undefined;
        }
        const [, apiVersion, kind, name] = resource;
        if (request.method === "GET") {
          const current = applied.get(request.pathname);
          return current === undefined
            ? kubernetesNotFound(
                request.pathname.split("/").at(-2) ?? kind,
                name,
                kind === "NetworkPolicy" ? "networking.k8s.io" : undefined,
              )
            : { body: current };
        }
        if (request.method === "PATCH") {
          // Server-side apply creates the missing Compute resource during initial preparation.
          assert.equal(request.headers["content-type"], "application/apply-patch+yaml");
          assert.deepEqual(Object.fromEntries(request.searchParams), {
            fieldManager: "openclaw-enterprise-compute",
            force: "false",
          });
          const body = request.body;
          assert.ok(body && typeof body === "object" && "metadata" in body);
          assert.ok("spec" in body && "apiVersion" in body && "kind" in body);
          assert.equal(body.apiVersion, apiVersion);
          assert.equal(body.kind, kind);
          assert.deepEqual(body.metadata, { ...owner, name, namespace });
          const object = persistedKubernetesObject(
            { apiVersion, kind, metadata: { ...owner, name, namespace }, spec: body.spec },
            `00000000-0000-4000-8000-${String(infrastructure.indexOf(resource) + 2).padStart(12, "0")}`,
          );
          applied.set(request.pathname, object);
          return { status: 201, body: object };
        }
        return undefined;
      },
    });
    const resources = {
      requests: { cpu: "100m", memory: "64Mi" },
      limits: { cpu: "250m", memory: "128Mi" },
    };
    const options = {
      authentication: api.authentication,
      gatewayRouting: routing,
      images: { gateway: "gateway:local", agent: "agent:local", requireImmutableDigest: false },
      resources: {
        gateway: resources,
        agent: resources,
        namespace: { quota: { pods: "10" }, containerDefaults: resources },
      },
      network: {
        dns: { namespace: "kube-system", podLabels: { app: "dns" } },
        gatewayPort: 8080,
        gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
      },
      servicePrincipalCredentials: { mode: "disabled" },
    } satisfies KubernetesComputeDriverOptions;

    const policyReads = [`GET ${namespacePath}`, `GET ${namespacePath}`, `GET ${policyPath}`];
    const successfulRequests = [
      ...policyReads,
      ...infrastructure.flatMap(([path]) => [`GET ${path}`, `PATCH ${path}`]),
    ];
    async function ensure(
      label: string,
      configured: Readonly<Record<string, unknown>>,
      response: readonly ReturnType<typeof operatorPolicy>[],
      expected: NamespaceEnsureResult,
      expectedRequests: readonly string[],
    ) {
      // Each input starts a fresh initialization from the operator's resources.
      applied.clear();
      observed = response;
      const binding = new PreprovisionedKubernetesNamespace(
        JSON.stringify({ namespaceId: tenant.id, uid }),
        routing,
        [
          {
            apiVersion: policyApiVersion,
            kind: "NetworkPolicy",
            metadata: { name: policyName },
            spec: configured,
          },
        ],
      );
      const driver = new KubernetesComputeDriver(options, { preprovisionedNamespace: binding });
      const mark = api.requests.length;
      assert.deepEqual(await driver.ensureNamespace(tenant), expected, label);
      assert.deepEqual(
        api.requests.slice(mark).map(({ method, pathname }) => `${method} ${pathname}`),
        expectedRequests,
        label,
      );
    }

    await ensure(
      "stock ingress from and port",
      declaredIngress,
      [operatorPolicy(wireIngress)],
      ready,
      successfulRequests,
    );

    // Unknown wire fields cannot supply the missing Kubernetes `from` selector.
    const aliasRule = { ports, _from: peers };

    // An additive policy or a change to the selected peers or ports blocks all preparation writes.
    for (const [label, response] of [
      [
        "additional allow-all policy",
        [
          operatorPolicy(wireIngress),
          operatorPolicy(
            { podSelector: {}, policyTypes: ["Ingress"], ingress: [{}] },
            "undeclared-allow-all",
          ),
        ],
      ],
      ["unrestricted peer", [operatorPolicy({ ...wireIngress, ingress: [{ from: [{}], ports }] })]],
      [
        "changed port",
        [
          operatorPolicy({
            ...wireIngress,
            ingress: [{ from: peers, ports: [{ protocol: "TCP", port: 9090 }] }],
          }),
        ],
      ],
      ["omitted peer", [operatorPolicy({ ...wireIngress, ingress: [{ ports }] })]],
      ["SDK alias on the wire", [operatorPolicy({ ...wireIngress, ingress: [aliasRule] })]],
    ] satisfies readonly [string, readonly ReturnType<typeof operatorPolicy>[]][]) {
      await ensure(label, declaredIngress, response, refused, policyReads);
    }

    // The SDK drops unknown response fields. Exercise the Compute binding's defensive checks
    // through constructor inputs here. OpenShell startup also rejects unsent manifest fields.
    for (const [label, configured] of [
      ["unknown configured spec field", { ...declaredIngress, unexpected: true }],
      [
        "unknown configured rule field",
        { ...declaredIngress, ingress: [{ from: peers, ports, unexpected: true }] },
      ],
      ["configured SDK alias", { ...declaredIngress, ingress: [{ _from: peers, ports }] }],
      [
        "configured wire field with SDK alias",
        { ...declaredIngress, ingress: [{ from: peers, _from: peers, ports }] },
      ],
    ] satisfies readonly [string, Readonly<Record<string, unknown>>][]) {
      await ensure(label, configured, [operatorPolicy(wireIngress)], refused, policyReads);
    }

    // Kubernetes omits empty lists. An explicit direction still denies traffic unless a rule grants it.
    await ensure(
      "omitted empty rules",
      empty,
      [operatorPolicy(omitted)],
      ready,
      successfulRequests,
    );
    for (const [label, changed] of [
      ["allow-all ingress", { ingress: [{}] }],
      ["allow-all egress", { egress: [{}] }],
      ["omitted direction", { policyTypes: ["Ingress"] }],
      ["changed selector", { podSelector: { matchLabels: { app: "other" } } }],
    ] satisfies readonly [string, Partial<PolicySpec>][]) {
      await ensure(label, empty, [operatorPolicy({ ...empty, ...changed })], refused, policyReads);
    }
    // A zero-length value must still be a list before it can match the omission.
    for (const egress of ["", { length: 0 }]) {
      await ensure(
        "malformed configured egress",
        { ...empty, egress },
        [operatorPolicy(omitted)],
        refused,
        policyReads,
      );
    }

    const stock = operatorPolicy(wireIngress);
    const invalidPolicy = {
      ...refused,
      reason: `The existing Kubernetes namespace ${namespace} returned an invalid NetworkPolicy.`,
    } satisfies NamespaceEnsureResult;
    for (const [label, metadata] of [
      ["missing policy name", { ...stock.metadata, name: "" }],
      ["policy in another namespace", { ...stock.metadata, namespace: "another-namespace" }],
    ] as const) {
      await ensure(label, declaredIngress, [{ ...stock, metadata }], invalidPolicy, policyReads);
    }
    observedNamespace = {
      ...boundNamespace,
      metadata: { ...boundNamespace.metadata, uid: "00000000-0000-4000-8000-000000000099" },
    };
    await ensure(
      "bound Namespace UID changed",
      declaredIngress,
      [stock],
      {
        ...refused,
        reason:
          "Preprovisioned Kubernetes Namespace identity_ ownership_ gateway membership_ Pod Security or lifecycle does not match the Installation.",
      },
      [`GET ${namespacePath}`],
    );
  });
}
