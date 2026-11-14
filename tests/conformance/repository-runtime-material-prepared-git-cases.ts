import {
  isFixtureNetworkPolicy,
  type FixtureDeployment,
  type FixtureNetworkPolicy,
} from "./repository-runtime-material-kubernetes-fixture.ts";
import { parseRecord } from "./repository-runtime-material-observations.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import {
  runtimeBinding,
  fixture,
  present,
  codexAppServer,
  recordField,
  jsonRecord,
} from "./repository-runtime-material-fixture.ts";
import { preparedNativeDocument } from "./repository-runtime-material-observations.ts";

function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

test("Dedicated repository custody and networking belong only to Codex", async () => {
  const f = await fixture("dedicated");
  f.revision.configuration.tools = { exec: { pathPrepend: ["/operator/bin"] } };
  const original = JSON.stringify(f.revision.configuration);
  await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
  const agent = f.requireConsumer();
  const gateway = present(f.deployments().find((deployment) => deployment !== agent));
  const gatewayConfiguration = parseRecord(preparedNativeDocument(f));
  // Compute owns the hook callback and Gateway's local logical workspace
  // independently of repository credential custody.
  // Repository material must leave every other Gateway setting unchanged.
  delete codexAppServer(gatewayConfiguration).nativeHookRelay;
  const expectedGatewayConfiguration = parseRecord(original);
  const defaults = recordField(recordField(expectedGatewayConfiguration, "agents"), "defaults");
  defaults.workspace = "/home/node/workspace";
  // Compute requires explicit proxy scopes independently of repository material.
  recordField(
    recordField(recordField(expectedGatewayConfiguration, "gateway"), "auth"),
    "trustedProxy",
  ).requiredHeaders = ["x-openclaw-scopes"];
  // Compute translates the saved API-key destination into Codex's provider-qualified model.
  defaults.model = "codex/openai-compatible/gpt-5";
  defaults.models = {
    "codex/openai-compatible/gpt-5": recordField(defaults, "models")["codex/gpt-5"],
  };
  const models = recordField(
    recordField(recordField(expectedGatewayConfiguration, "models"), "providers"),
    "codex",
  ).models;
  assert.ok(isArray(models));
  jsonRecord(models[0]).id = "openai-compatible/gpt-5";
  assert.deepEqual(
    gatewayConfiguration,
    expectedGatewayConfiguration,
    "repository material does not change the separate Gateway's execution configuration",
  );
  assert.equal(JSON.stringify(f.revision.configuration), original);
  const assertGatewayIsolated = (deployment: FixtureDeployment) => {
    const pod = deployment.spec.template.spec;
    assert.equal(
      deployment.metadata.annotations["openclaw.dev/repository-material-generation"],
      undefined,
    );
    assert.ok(pod.volumes.every(({ name }) => !name.startsWith("repository-material")));
    assert.ok(pod.initContainers.every(({ name }) => name !== "prepare-repository-material"));
    for (const container of pod.containers) {
      assert.ok(
        container.env.every(
          ({ name, value }) =>
            name !== "OPENAI_API_KEY" &&
            name !== "OPENCLAW_GATEWAY_TOKEN" &&
            !value?.includes("repository-credentials"),
        ),
      );
      assert.ok(
        container.volumeMounts.every(({ name }) => !name.startsWith("repository-material")),
      );
    }
  };
  assertGatewayIsolated(gateway);
  const environment = agent.spec.template.spec.containers[0].env;
  assert.ok(environment.some(({ name }) => name === "OPENAI_API_KEY"));
  assert.match(
    present(environment.find(({ name }) => name === "PATH")?.value),
    /^\/opt\/oce\/repository-credentials\/bin:/,
  );
  const configuredPeer = {
    to: [
      {
        namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "credentials" } },
        podSelector: { matchLabels: { app: "credentials" } },
      },
    ],
    ports: [{ protocol: "TCP", port: 8443 }],
  };
  f.markReady();
  await f.driver.activateRevision(f.revision, f.context([runtimeBinding()]));
  const policies = [...f.objects.values()].filter(isFixtureNetworkPolicy);
  const repositoryPolicies = policies.filter((policy) =>
    policy.spec.egress?.some((rule) => isDeepStrictEqual(rule, configuredPeer)),
  );
  assert.equal(
    repositoryPolicies.length,
    2,
    "preparation and activation both permit the configured repository peer",
  );
  for (const policy of repositoryPolicies) {
    assert.equal(policy.spec.podSelector.matchLabels["openclaw.dev/workload-role"], "agent");
    assert.equal(policy.spec.podSelector.matchLabels["openclaw.dev/revision"], f.revision.id);
  }
  assertGatewayIsolated(
    present(
      f.deployments().find((deployment) => deployment.metadata.name === gateway.metadata.name),
    ),
  );
});

async function preparedIngressFixture({
  hostname,
  servicePort = 443,
  targetPort = 8443,
}: {
  hostname?: string;
  servicePort?: number;
  targetPort?: number;
} = {}) {
  const worker = {
    "app.kubernetes.io/name": "openclaw-enterprise",
    "app.kubernetes.io/instance": "oce",
    "app.kubernetes.io/component": "worker",
  };
  const f = await fixture("dedicated", undefined, {
    preparedRepositoryIngress: true,
    repositoryPodLabels: worker,
  });
  const name = "openclaw-enterprise-prepared-repository-ingress";
  const metadata = { name, namespace: "credentials", uid: "policy-uid", resourceVersion: "1" };
  const start = { podSelector: { matchLabels: worker }, policyTypes: ["Ingress"], ingress: [] };
  const savePolicy = (spec: FixtureNetworkPolicy["spec"]) =>
    f.save({ kind: "NetworkPolicy", metadata, spec });
  savePolicy(start);
  f.save({
    kind: "Service",
    metadata: {
      namespace: "credentials",
      name: "git",
      ...(hostname === undefined
        ? {}
        : { annotations: { "openclaw.dev/repository-credentials-hostname": hostname } }),
    },
    spec: {
      type: "ClusterIP",
      selector: worker,
      ports: [{ port: servicePort, targetPort, protocol: "TCP" }],
    },
  });
  const networking = f.clients.networking;
  const read = async () => (await networking.readNamespacedNetworkPolicy(metadata)).spec;
  const prepare = (origin?: string) =>
    f.driver.prepareRevision(f.revision, f.context([runtimeBinding(undefined, undefined, origin)]));
  return { f, worker, metadata, start, savePolicy, networking, read, prepare };
}

test("prepared Git admits only the dedicated Harness peer and retires it without evicting another Agent", async () => {
  const { f, worker, metadata, savePolicy, networking, read, prepare } =
    await preparedIngressFixture({
      hostname: "git.credentials.svc.cluster.local",
    });
  const revision = f.revision;
  assert.throws(
    () =>
      f.driver.validateRepositoryCredentials({
        id: "openclaw",
        version: "1.0.0",
        mode: "embedded",
      }),
    /dedicated Compute-owned Codex Harness/,
  );

  const replace = networking.replaceNamespacedNetworkPolicy;
  let writes = 0;
  let other:
    | NonNullable<NonNullable<FixtureNetworkPolicy["spec"]["ingress"]>[number]["_from"]>[number]
    | undefined;
  networking.replaceNamespacedNetworkPolicy = async (request) => {
    if (request.name !== metadata.name) {
      return replace(request);
    }
    const spec = structuredClone(request.body.spec);
    if (++writes === 1) {
      // Another Agent wins the update. Compute must preserve its exact peer on the conflict.
      other = present(spec.ingress?.[0]?._from?.[0]);
      const labels = present(other.podSelector?.matchLabels);
      labels["openclaw.dev/agent"] = "another-agent";
      labels["openclaw.dev/revision"] = "another-revision";
      metadata.resourceVersion = "2";
      savePolicy(spec);
      throw Object.assign(new Error("conflict"), { statusCode: 409 });
    }
    assert.equal(request.body.metadata.resourceVersion, metadata.resourceVersion);
    metadata.resourceVersion = String(writes + 1);
    savePolicy(spec);
    if (writes === 2) {
      throw new Error("lost policy response");
    }
    return networking.readNamespacedNetworkPolicy(metadata);
  };
  await assert.rejects(prepare(), /lost policy response/);
  await prepare();
  assert.equal(writes, 2, "a lost response must be resolved by observation, with no second grant");
  f.markReady();
  await f.driver.activateRevision(revision, f.context([runtimeBinding()]));
  assert.equal(writes, 2);
  const { ingress, ...destination } = await read();
  assert.deepEqual(destination, { podSelector: { matchLabels: worker }, policyTypes: ["Ingress"] });
  const expected = {
    "openclaw.dev/agent": revision.agentId,
    "openclaw.dev/namespace": revision.namespaceId,
    "openclaw.dev/revision": revision.id,
    "openclaw.dev/service-principal": revision.servicePrincipalId,
    "openclaw.dev/workload-role": "agent",
    "openclaw.dev/network-profile": "broad-egress-v1",
  };
  // Match both halves of Kubernetes' AND peer selector to the actual dedicated Pod template.
  // This excludes gateways, sibling Agents, stale revisions and another Kubernetes namespace.
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(f.requireConsumer().spec.template.metadata.labels[key], value, key);
  }
  const peer = {
    namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": f.namespace } },
    podSelector: { matchLabels: expected },
  };
  const ports = [{ port: 8443, protocol: "TCP" }];
  assert.deepEqual(ingress, [{ _from: [other, peer], ports }]);

  f.observePods(() => f.setPods([]));
  await f.driver.retireRevision(revision);
  assert.deepEqual((await read()).ingress, [{ _from: [other], ports }]);

  // Namespace retirement prunes the last peer. No peers must mean no rule, not an empty 'from'.
  await f.driver.deleteNamespace({
    id: revision.namespaceId,
    name: "Repository material tenant",
    status: "deleting",
    createdAt: revision.createdAt,
  });
  assert.deepEqual((await read()).ingress, []);
});

test("prepared Git binds the session origin to the selected broker Service", async (t) => {
  const custom = "git.credentials.svc.cluster.internal";
  for (const scenario of [
    { name: "custom cluster domain", hostname: custom, origin: custom, admitted: true },
    { name: "foreign suffix", hostname: custom, origin: "git.credentials.svc.attacker.example" },
    { name: "missing Service hostname", origin: custom },
    { name: "wrong Service port", hostname: custom, origin: custom, servicePort: 444 },
    { name: "wrong worker port", hostname: custom, origin: custom, targetPort: 9443 },
  ]) {
    await t.test(scenario.name, async () => {
      const { read, prepare, start } = await preparedIngressFixture(scenario);
      const preparing = prepare(`https://${scenario.origin}`);
      if (scenario.admitted) {
        await preparing;
        assert.equal((await read()).ingress?.[0]?._from?.length, 1);
      } else {
        await assert.rejects(preparing, /selected broker/);
        assert.deepEqual(await read(), start, "a refused origin must not admit a broker peer");
      }
    });
  }
});
