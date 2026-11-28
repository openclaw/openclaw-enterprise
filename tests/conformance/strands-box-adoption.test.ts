import assert from "node:assert/strict";
import test from "node:test";
import { RUNTIME_WRAPPER_COMMAND } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { StrandsBoxSandboxDriver } from "../../apps/controller/src/drivers/sandbox/strands-box.ts";
import {
  KubernetesObjectApi,
  PatchStrategy,
  type KubernetesObject,
} from "../../apps/controller/node_modules/@kubernetes/client-node/dist/index.js";
import { ObjectSerializer } from "../../apps/controller/node_modules/@kubernetes/client-node/dist/serializer.js";
import { gatewayRouting, routedRevision, tenant } from "../helpers/kubernetes-routed-scenarios.mjs";

type Resource = KubernetesObject & {
  metadata: NonNullable<KubernetesObject["metadata"]>;
  spec?: { ingress?: unknown[]; egress?: unknown[] };
};

function harness() {
  const driver = new StrandsBoxSandboxDriver(
    {
      kubernetes: {
        seccompProfile: "strands.json",
        nodeSelector: { "kubernetes.io/arch": "arm64" },
        controlPlanePeer: { namespace: "controller", podLabels: { app: "controller" } },
      },
      policy: { network: { endpoints: [{ host: "127.0.0.2", ports: [31443] }] } },
    },
    {
      id: "strands",
      authentication: { mode: "inCluster" },
      dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
      routing: gatewayRouting,
    },
  );
  const revision = routedRevision(
    { id: "kubernetes", implementation: "kubernetes" },
    { sandboxDriverId: driver.id },
  );
  const namespace = { ...tenant, name: "execution", status: "ready" } as const;
  const ref = driver.harnessResource({ namespace, revision });
  const resources = new Map<string, Resource>();
  const reads = new Map<string, number>();
  const creates: string[] = [];
  const patches: Resource[] = [];
  const effects: {
    beforeRead?: (key: string, count: number) => void;
    afterCreate?: (resource: Resource) => void;
    beforePatch?: (current: Resource) => void;
    afterPatch?: (current: Resource) => void;
  } = {};
  const key = ({ kind, metadata }: Resource) => `${kind}/${metadata.name}`;
  const transport = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: "transport",
      labels: {
        "openclaw.dev/namespace": namespace.id,
        "openclaw.dev/agent": revision.agentId,
        "openclaw.dev/revision": revision.id,
      },
    },
    data: { token: Buffer.from("synthetic transport").toString("base64") },
  };
  resources.set(key(transport), transport);
  const notFound = () => Object.assign(new Error("not found"), { statusCode: 404 });
  const conflict = () => Object.assign(new Error("resource version conflict"), { statusCode: 409 });
  const client = {
    async read(reference: Resource) {
      const id = key(reference);
      const count = (reads.get(id) ?? 0) + 1;
      reads.set(id, count);
      effects.beforeRead?.(id, count);
      const resource = resources.get(id);
      if (!resource) {
        throw notFound();
      }
      return resource.kind === "NetworkPolicy"
        ? ObjectSerializer.deserialize(structuredClone(resource), "V1NetworkPolicy")
        : structuredClone(resource);
    },
    async create(resource: Resource) {
      const id = key(resource);
      creates.push(id);
      assert.ok(!resources.has(id), "create must not overwrite an existing object");
      const stored: Resource =
        resource.kind === "NetworkPolicy"
          ? JSON.parse(JSON.stringify(ObjectSerializer.serialize(resource, "V1NetworkPolicy")))
          : structuredClone(resource);
      stored.metadata.uid = `uid-${id}`;
      stored.metadata.resourceVersion = "1";
      effects.afterCreate?.(stored);
      resources.set(id, stored);
      return stored.kind === "NetworkPolicy"
        ? ObjectSerializer.deserialize(structuredClone(stored), "V1NetworkPolicy")
        : structuredClone(stored);
    },
    async patch(
      patch: Resource,
      _pretty: string | undefined,
      _dryRun: string | undefined,
      _manager: string | undefined,
      _force: boolean | undefined,
      strategy: PatchStrategy,
    ) {
      patches.push(structuredClone(patch));
      assert.equal(strategy, PatchStrategy.MergePatch);
      const current = resources.get(key(patch));
      assert.ok(current);
      effects.beforePatch?.(current);
      if (
        patch.metadata.uid !== current.metadata.uid ||
        patch.metadata.resourceVersion !== current.metadata.resourceVersion
      ) {
        throw conflict();
      }
      current.spec = { ...current.spec, ...patch.spec };
      current.metadata.resourceVersion = "2";
      effects.afterPatch?.(current);
      return ObjectSerializer.deserialize(structuredClone(current), "V1NetworkPolicy");
    },
  };
  Object.setPrototypeOf(client, KubernetesObjectApi.prototype);
  const context: Parameters<typeof driver.provisionHarness>[0] = {
    namespace,
    revision,
    kubernetes: client,
    signal: new AbortController().signal,
    requirements: {
      image: "fixture.invalid/box:synthetic",
      loginMode: "api_key",
      command: [...RUNTIME_WRAPPER_COMMAND, "process.exitCode = 0"],
      credentialAttachments: [],
      retainedDirectories: [],
      workspaceMounts: [
        {
          mountPath: "/home/node/workspace",
          readOnly: false,
          claimName: "fixture",
          subPath: "workspace",
        },
      ],
      environment: [
        { name: "APP_SERVER_PORT", value: "18789" },
        {
          name: "APP_SERVER_TOKEN",
          valueFrom: { secretKeyRef: { name: "transport", key: "token" } },
        },
      ],
      files: [],
      labels: {},
    },
  };
  return {
    ref,
    resources,
    creates,
    patches,
    effects,
    configMap: `ConfigMap/${ref.resourceName}`,
    deployment: `Deployment/${ref.resourceName}`,
    policy: `NetworkPolicy/${ref.resourceName}`,
    provision: () => driver.provisionHarness(context),
  };
}

function endpoint(cidr: string) {
  return { to: [{ ipBlock: { cidr } }], ports: [{ protocol: "TCP", port: 31443 }] };
}

test("Strands Box adopts wire policy and refreshes only stale endpoint addresses", async () => {
  const f = harness();
  assert.deepEqual(await f.provision(), f.ref);
  const policy = f.resources.get(f.policy);
  assert.ok(policy?.spec?.egress);
  assert.deepEqual(policy.spec.egress.at(-1), endpoint("127.0.0.2/32"));
  assert.deepEqual(await f.provision(), f.ref);
  assert.equal(f.patches.length, 0);

  policy.spec.egress.splice(-1, 1, endpoint("127.0.0.1/32"));
  const staticEgress = policy.spec.egress.slice(0, -1);
  const ingress = structuredClone(policy.spec.ingress);
  f.resources.delete("Secret/transport");
  assert.deepEqual(await f.provision(), f.ref);
  assert.equal(f.patches.length, 1);
  assert.deepEqual(f.patches[0]?.spec, { egress: [...staticEgress, endpoint("127.0.0.2/32")] });
  assert.deepEqual(policy.spec.ingress, ingress);
});

for (const direction of ["ingress", "egress"] as const) {
  test(`Strands Box refuses an allow-all ${direction} rule without patching`, async () => {
    const f = harness();
    await f.provision();
    const spec = f.resources.get(f.policy)?.spec;
    assert.ok(spec?.egress && spec.ingress);
    spec.egress.splice(-1, 1, endpoint("127.0.0.1/32"));
    spec[direction]!.push({});
    await assert.rejects(f.provision(), /NetworkPolicy/);
    assert.deepEqual(f.patches, []);
  });
}

for (const [description, rule] of [
  ["a CIDR range", endpoint("127.0.0.0/24")],
  [
    "an additional peer",
    { ...endpoint("127.0.0.1/32"), to: [...endpoint("127.0.0.1/32").to, { podSelector: {} }] },
  ],
  [
    "a port range",
    { ...endpoint("127.0.0.1/32"), ports: [{ protocol: "TCP", port: 31443, endPort: 31444 }] },
  ],
] as const) {
  test(`Strands Box refuses a previous endpoint rule with ${description}`, async () => {
    const f = harness();
    await f.provision();
    const spec = f.resources.get(f.policy)?.spec;
    assert.ok(spec?.egress);
    spec.egress.splice(-1, 1, structuredClone(rule));
    await assert.rejects(f.provision(), /endpoint rule/);
    assert.deepEqual(f.patches, []);
  });
}

test("Strands Box stops before workload creation when admission broadens the created policy", async () => {
  const f = harness();
  f.effects.afterCreate = (resource) => {
    if (resource.kind === "NetworkPolicy") {
      // A mutating admission webhook can add this valid allow-all rule before storage.
      resource.spec!.egress!.push({});
    }
  };
  await assert.rejects(f.provision(), /NetworkPolicy/);
  assert.ok(f.resources.has(f.policy));
  assert.ok(!f.creates.includes(f.deployment));
  assert.deepEqual(f.patches, []);
});

test("Strands Box refuses a policy broadened by admission during endpoint refresh", async () => {
  const f = harness();
  await f.provision();
  const policy = f.resources.get(f.policy);
  assert.ok(policy?.spec?.egress);
  policy.spec.egress.splice(-1, 1, endpoint("127.0.0.1/32"));
  f.effects.afterPatch = (current) => {
    current.spec!.ingress!.push({});
  };

  await assert.rejects(f.provision(), /NetworkPolicy/);
  assert.equal(f.patches.length, 1);
  assert.deepEqual(policy.spec.ingress?.at(-1), {});
});

test("Strands Box endpoint refresh does not overwrite a newer policy version", async () => {
  const f = harness();
  await f.provision();
  const policy = f.resources.get(f.policy);
  assert.ok(policy?.spec?.egress);
  const stale = endpoint("127.0.0.1/32");
  policy.spec.egress.splice(-1, 1, stale);
  f.effects.beforePatch = (current) => {
    current.metadata.resourceVersion = "3";
    current.spec!.egress!.push({});
  };
  await assert.rejects(f.provision(), { statusCode: 409 });
  assert.equal(f.patches.length, 1);
  assert.deepEqual(policy.spec.egress.slice(-2), [stale, {}]);
});

test("Strands Box refuses a foreign ConfigMap that appears after preflight", async () => {
  const f = harness();
  f.effects.beforeRead = (key, count) => {
    if (key === f.configMap && count === 2) {
      f.resources.set(key, {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: f.ref.resourceName, namespace: f.ref.namespaceName },
      });
    }
  };
  await assert.rejects(f.provision(), /ownership/);
  assert.deepEqual(f.creates, []);
  assert.ok(!f.resources.has(f.deployment));
});

test("Strands Box reuses matching ConfigMap created after preflight", async () => {
  const source = harness();
  await source.provision();
  const configMap = source.resources.get(source.configMap);
  assert.ok(configMap);

  const f = harness();
  f.effects.beforeRead = (key, count) => {
    if (key === f.configMap && count === 2) {
      f.resources.set(key, configMap);
    }
  };
  assert.deepEqual(await f.provision(), f.ref);
  assert.ok(!f.creates.includes(f.configMap));
  assert.ok(f.creates.includes(f.deployment));
});

test("Strands Box refuses a deleting ConfigMap with matching revision metadata", async () => {
  const f = harness();
  await f.provision();
  f.resources.delete(f.deployment);
  const configMap = f.resources.get(f.configMap);
  assert.ok(configMap);
  configMap.metadata.deletionTimestamp = new Date("2026-11-24T00:00:00Z");
  const created = f.creates.length;

  await assert.rejects(f.provision(), /not adoptable/);
  assert.equal(f.creates.length, created);
  assert.deepEqual(f.patches, []);
});

test("Strands Box refuses policy drift introduced after successful preflight", async () => {
  const f = harness();
  await f.provision();
  f.resources.delete(f.deployment);
  const policy = f.resources.get(f.policy);
  assert.ok(policy?.spec?.ingress);
  f.effects.beforeRead = (key, count) => {
    // The first preparation read each resource twice. The next preflight sees the
    // original policy, and the following read sees an independently broadened rule.
    if (key === f.policy && count === 4) {
      policy.spec!.ingress!.push({});
    }
  };
  await assert.rejects(f.provision(), /NetworkPolicy/);
  assert.deepEqual(f.patches, []);
  assert.ok(!f.resources.has(f.deployment));
});
