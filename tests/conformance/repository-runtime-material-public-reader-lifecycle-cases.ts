import type { SandboxDriver } from "../../packages/contracts/src/index.ts";
import type { OpenShellGitRuntime } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { parseRecord } from "./repository-runtime-material-observations.ts";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { openShellRepositoryAccess } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { runOpenClawRuntimeHelper } from "../helpers/plugin-runtime.mjs";
import {
  runtimeBinding,
  workloadPod,
  fixture,
  codexAppServer,
  present,
  recordField,
  jsonRecord,
  type MaterialRevision,
} from "./repository-runtime-material-fixture.ts";
import {
  preparedCodexManifest,
  preparedNativeDocument,
} from "./repository-runtime-material-observations.ts";
import {
  publicReader,
  publicReaderPolicies,
  computeAfterProxyCutover,
} from "./repository-runtime-material-public-reader-fixture.ts";

function isMap(value: unknown): value is ReadonlyMap<unknown, unknown> {
  return value instanceof Map;
}

test("withdrawing a selected reader narrows access and stops only its revision", async () => {
  for (const replacement of [undefined, { ...publicReader, podLabels: { app: "replacement" } }]) {
    const f = await fixture("dedicated", undefined, { publicGithubRead: publicReader });
    delete f.revision.repositoryCredentials;
    codexAppServer(f.revision.configuration).networkProxy = {
      enabled: true,
      domains: { [publicReader.address]: "allow" },
    };
    f.revision.compute.admission = present(f.driver.admitRevision(f.revision), "Compute admission");
    const context = f.context(undefined);
    await f.driver.prepareRevision(f.revision, context);
    f.markReady();
    await f.driver.activateRevision(f.revision, context);
    const selected = f.requireConsumer();
    const successor = { ...structuredClone(f.revision), id: "unselected-successor", revision: 2 };
    recordField(codexAppServer(successor.configuration), "networkProxy").domains = {};
    successor.compute.admission = present(f.driver.admitRevision(successor), "Compute admission");
    f.enroll(successor);
    await f.driver.prepareRevision(successor, context);
    const successorDeployment = f
      .deployments()
      .find(
        (deployment) =>
          deployment.spec.template.metadata.labels["openclaw.dev/revision"] === successor.id,
      );
    assert.ok(successorDeployment);
    const successorPod = workloadPod(successorDeployment, f.namespace, "successor");
    f.setPods([workloadPod(selected, f.namespace, "selected"), successorPod]);
    assert.equal(publicReaderPolicies(f).length, 1);
    if (replacement === undefined) {
      delete f.ports.options.network.publicGithubRead;
    } else {
      f.ports.options.network.publicGithubRead = replacement;
    }
    // Selecting Credential Proxy cannot convert the old grant, or block withdrawal of its owned workload.
    const driver = replacement === undefined ? f.driver : computeAfterProxyCutover(f);
    if (replacement !== undefined) {
      await assert.rejects(
        driver.prepareRevision(successor, context),
        /exact paired Compute release/,
      );
    }
    const deleteDeployment = f.clients.apps.deleteNamespacedDeployment;
    const readDeployment = f.clients.apps.readNamespacedDeployment;
    let deleting = false;
    let observedTerminatingDeployment = false;
    const { promise: reached, resolve: reachedObservation } = Promise.withResolvers<void>();
    const { promise: release, resolve: releaseObservation } = Promise.withResolvers<void>();
    f.clients.apps.deleteNamespacedDeployment = async (request) => {
      assert.equal(publicReaderPolicies(f).length, 0);
      assert.equal(request.body?.propagationPolicy, "Foreground");
      assert.ok(request.body?.preconditions && selected.metadata.uid);
      assert.equal(request.body.preconditions.uid, selected.metadata.uid);
      await deleteDeployment(request);
      deleting = true;
    };
    f.clients.apps.readNamespacedDeployment = async (request) => {
      if (deleting && request.name === selected.metadata.name && !observedTerminatingDeployment) {
        observedTerminatingDeployment = true;
        reachedObservation();
        await release;
      }
      return readDeployment(request);
    };
    let observed = false;
    f.observePods(() => {
      observed = true;
      assert.equal(observedTerminatingDeployment, true);
      assert.ok(!f.deployments().some(({ metadata }) => metadata.name === selected.metadata.name));
      assert.ok(
        f.deployments().some(({ metadata }) => metadata.name === successorDeployment.metadata.name),
      );
      assert.equal(
        publicReaderPolicies(f).length,
        0,
        "new connections are narrowed before Pod termination",
      );
      f.setPods([successorPod]);
    });
    const withdrawal = driver.prepareRevision(f.revision, context);
    await reached;
    assert.equal(
      observed,
      false,
      "Pods cannot establish completion before the Deployment observation",
    );
    releaseObservation();
    await assert.rejects(withdrawal, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /reader peer was withdrawn/);
      assert.equal(
        driver.describePrepareRevisionFailure(error).code,
        "KUBERNETES_CONFIGURATION_INVALID",
      );
      return true;
    });
    assert.equal(observed, true);
    assert.equal(publicReaderPolicies(f).length, 0);
    assert.ok(
      f.deployments().some(({ metadata }) => metadata.name === successorDeployment.metadata.name),
    );
    f.observePods(undefined);
    let removedProjection = 0;
    for (const [key, object] of f.objects) {
      if (
        object.kind === "ConfigMap" &&
        object.data?.["runtime.json"] &&
        object.metadata.labels?.["openclaw.dev/revision"] === f.revision.id
      ) {
        f.objects.delete(key);
        removedProjection++;
      }
    }
    assert.equal(removedProjection, 1);
    await assert.rejects(driver.activateRevision(f.revision, context), /reader peer was withdrawn/);
    await assert.rejects(driver.prepareRevision(f.revision, context), /reader peer was withdrawn/);
    assert.equal(publicReaderPolicies(f).length, 0);
    assert.ok(!f.deployments().some(({ metadata }) => metadata.name === selected.metadata.name));
    assert.ok(
      f.deployments().some(({ metadata }) => metadata.name === successorDeployment.metadata.name),
    );
  }
});

test("withdrawal precedes missing or expired repository material in preparation and activation", async () => {
  for (const operation of ["prepareRevision", "activateRevision"] as const) {
    for (const invalid of ["missing", "expired"]) {
      const f = await fixture("dedicated", undefined, { publicGithubRead: publicReader });
      codexAppServer(f.revision.configuration).networkProxy = {
        enabled: true,
        domains: { [publicReader.address]: "allow" },
      };
      f.revision.compute.admission = present(
        f.driver.admitRevision(f.revision),
        "Compute admission",
      );
      const valid = f.context([runtimeBinding()]);
      await f.driver.prepareRevision(f.revision, valid);
      f.markReady();
      await f.driver.activateRevision(f.revision, valid);
      assert.equal(publicReaderPolicies(f).length, 1);
      const selected = f.requireConsumer();
      f.setPods([]);
      delete f.ports.options.network.publicGithubRead;
      const context =
        invalid === "missing"
          ? f.context(undefined)
          : f.context([{ ...runtimeBinding(), deadlineWallMs: 1 }]);
      await assert.rejects(f.driver[operation](f.revision, context), /reader peer was withdrawn/);
      assert.equal(publicReaderPolicies(f).length, 0);
      assert.ok(!f.deployments().some(({ metadata }) => metadata.name === selected.metadata.name));
    }
  }
});

test("reader withdrawal uses the admitted Compute ownership when the Sandbox changes", async () => {
  for (const [operation, replacement] of [
    ["prepareRevision", undefined],
    ["activateRevision", { id: "different-sandbox" }],
    ["prepareRevision", { id: "sandbox", async provisionHarness() {} }],
  ] as const) {
    const f = await fixture("dedicated", undefined, { publicGithubRead: publicReader });
    delete f.revision.repositoryCredentials;
    f.revision.sandboxDriverId = "sandbox";
    f.ports.sandboxDriver = { id: "sandbox" };
    codexAppServer(f.revision.configuration).networkProxy = {
      enabled: true,
      domains: { [publicReader.address]: "allow" },
    };
    f.revision.compute.admission = present(f.driver.admitRevision(f.revision), "Compute admission");
    const context = f.context(undefined);
    await f.driver.prepareRevision(f.revision, context);
    f.markReady();
    await f.driver.activateRevision(f.revision, context);
    const selected = f.requireConsumer();
    assert.equal(publicReaderPolicies(f).length, 1);
    f.setPods([]);
    delete f.ports.options.network.publicGithubRead;
    f.ports.sandboxDriver = replacement;
    await assert.rejects(f.driver[operation](f.revision, context), /reader peer was withdrawn/);
    assert.equal(publicReaderPolicies(f).length, 0);
    assert.ok(!f.deployments().some(({ metadata }) => metadata.name === selected.metadata.name));
  }
});

test("stop and retirement fence an admitted reader when the Sandbox is unavailable or changed", async () => {
  for (const [operation, replacement] of [
    ["stopRevision", undefined],
    ["retireRevision", { id: "different-sandbox" }],
    ["stopRevision", { id: "sandbox", async provisionHarness() {}, async cleanup() {} }],
    ["retireRevision", { id: "sandbox", async provisionHarness() {}, async cleanup() {} }],
  ] as const) {
    const f = await fixture("dedicated", undefined, { publicGithubRead: publicReader });
    delete f.revision.repositoryCredentials;
    f.revision.sandboxDriverId = "sandbox";
    f.ports.sandboxDriver = { id: "sandbox" };
    codexAppServer(f.revision.configuration).networkProxy = {
      enabled: true,
      domains: { [publicReader.address]: "allow" },
    };
    f.revision.compute.admission = present(f.driver.admitRevision(f.revision), "Compute admission");
    const context = f.context(undefined);
    await f.driver.prepareRevision(f.revision, context);
    f.markReady();
    await f.driver.activateRevision(f.revision, context);
    const selected = f.requireConsumer();
    assert.equal(publicReaderPolicies(f).length, 1);
    f.setPods([]);
    f.ports.sandboxDriver = replacement;
    await assert.rejects(f.driver[operation](f.revision), /SandboxDriver|Sandbox-owned/);
    assert.ok(!f.deployments().some(({ metadata }) => metadata.name === selected.metadata.name));
    assert.equal(publicReaderPolicies(f).length, 0);
  }
});

// With an OpenShell repository-access Sandbox the worker transfers repository Git material to
// the Sandbox, so Compute projects no material Secret and the Installation configures no
// repository credential endpoint; the chart then grants the worker no Secret list. Stopping,
// retiring or deleting such a revision must finish without listing Secrets: the refused list
// once left repository cleanup retrying forever and Agent deletion failing (finding 2201).
test("a repository-access Sandbox revision stops, retires and is deleted without listing Secrets", async () => {
  for (const operation of ["stopRevision", "retireRevision"] as const) {
    const cleanups: string[] = [];
    const gitObservation: Pick<OpenShellGitRuntime, "route" | "materialInstalledAt"> = {
      route: () => ({ state: "installed" }),
      materialInstalledAt: () => undefined,
    };
    const sandboxDriver: SandboxDriver = {
      id: "openshell-sandbox",
      implementation: "openshell",
      capability: "sandbox",
      supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
      facets: ["networking", "filesystem", "process"],
      repositoryAccess: openShellRepositoryAccess(
        gitObservation as OpenShellGitRuntime,
        () => undefined,
      ),
      async provisionHarness(context) {
        return {
          namespaceName: context.namespace.name,
          resourceName: "openshell-harness",
          agentId: context.revision.agentId,
          revisionId: context.revision.id,
        };
      },
      async cleanup(context) {
        cleanups.push(present(context.revision).id);
      },
    };
    const f = await fixture("dedicated", undefined, { repositoryBroker: false, sandboxDriver });
    f.revision.sandboxDriverId = sandboxDriver.id;
    present(present(f.revision.repositoryCredentials).bindings[0]).profile = "git-write";
    // Preparation projects no material: the Sandbox receives it from the worker.
    await f.driver.prepareRevision(f.revision, f.context(undefined));
    assert.deepEqual(f.secrets(), []);
    await f.driver[operation](f.revision);
    assert.deepEqual(cleanups, [f.revision.id], operation);
    // A fresh deploy with no active predecessor prepares without material either.
    const next = { ...structuredClone(f.revision), id: "revision-repository-material-next" };
    await f.driver.prepareRevision(next, f.context(undefined));
    assert.deepEqual(f.secrets(), []);
    // Agent deletion retires each revision, then removes the Agent's runtime credentials.
    for (const revision of [f.revision, next]) {
      await f.driver.retireRevision(revision);
    }
    await f.driver.deleteAgentRuntimeCredentials(f.agentBinding);
    assert.deepEqual(cleanups, [f.revision.id, f.revision.id, next.id], operation);
    assert.equal(
      f.apiCalls.includes("core.listNamespacedSecret"),
      false,
      `${operation} must not list Secrets`,
    );
  }
});

test("reader withdrawal refuses an ambiguous workload profile", async () => {
  const f = await fixture("dedicated", undefined, { publicGithubRead: publicReader });
  delete f.revision.repositoryCredentials;
  codexAppServer(f.revision.configuration).networkProxy = {
    enabled: true,
    domains: { [publicReader.address]: "allow" },
  };
  f.revision.compute.admission = present(f.driver.admitRevision(f.revision), "Compute admission");
  const context = f.context(undefined);
  await f.driver.prepareRevision(f.revision, context);
  const selected = f.requireConsumer();
  selected.spec.template.metadata.labels["openclaw.dev/network-profile"] = "provider-fenced-v1";
  f.save(selected);
  delete f.ports.options.network.publicGithubRead;
  await assert.rejects(f.driver.prepareRevision(f.revision, context), /workload profile/);
  assert.ok(f.deployments().some(({ metadata }) => metadata.name === selected.metadata.name));
});

test("withdrawal cannot complete when Pod termination cannot be observed completely", async () => {
  const f = await fixture("dedicated", undefined, { publicGithubRead: publicReader });
  delete f.revision.repositoryCredentials;
  codexAppServer(f.revision.configuration).networkProxy = {
    enabled: true,
    domains: { [publicReader.address]: "allow" },
  };
  f.revision.compute.admission = present(f.driver.admitRevision(f.revision), "Compute admission");
  const context = f.context(undefined);
  await f.driver.prepareRevision(f.revision, context);
  f.markReady();
  await f.driver.activateRevision(f.revision, context);
  delete f.ports.options.network.publicGithubRead;
  const listPods = f.clients.core.listNamespacedPod;
  f.clients.core.listNamespacedPod = async () => ({ items: [], metadata: { continue: "next" } });
  await assert.rejects(f.driver.prepareRevision(f.revision, context), /invalid workload Pod list/);
  assert.equal(publicReaderPolicies(f).length, 0);
  f.clients.core.listNamespacedPod = listPods;
  f.setPods([]);
  await assert.rejects(f.driver.prepareRevision(f.revision, context), /reader peer was withdrawn/);
  assert.equal(publicReaderPolicies(f).length, 0);
});

test("withdrawal fails if the reader policy reappears during Pod termination", async () => {
  const f = await fixture("dedicated", undefined, { publicGithubRead: publicReader });
  delete f.revision.repositoryCredentials;
  codexAppServer(f.revision.configuration).networkProxy = {
    enabled: true,
    domains: { [publicReader.address]: "allow" },
  };
  f.revision.compute.admission = present(f.driver.admitRevision(f.revision), "Compute admission");
  const context = f.context(undefined);
  await f.driver.prepareRevision(f.revision, context);
  f.markReady();
  await f.driver.activateRevision(f.revision, context);
  const policy = present(publicReaderPolicies(f)[0]);
  delete f.ports.options.network.publicGithubRead;
  f.observePods(() => {
    f.save(policy);
    f.setPods([]);
  });
  await assert.rejects(f.driver.prepareRevision(f.revision, context), /reader policy reappeared/);
});

test("ordinary dedicated revision gets only the public reader peer and skill; a disabled proxy or deny removes both", async () => {
  const { address } = publicReader;
  for (const [proxy, allowed] of [
    [
      {
        enabled: true,
        mode: "limited",
        allowLocalBinding: false,
        domains: { "example.org": "deny", [address]: "allow" },
      },
      true,
    ],
    [{ enabled: true }, false],
    [{ enabled: false, domains: { [address]: "allow" } }, false],
    [{ enabled: true, domains: { [address]: "allow", "10.43.0.*": "deny" } }, false],
    [{ enabled: true, domains: { [address]: "allow", [`[${address}]:8080`]: "deny" } }, false],
  ] as const) {
    const f = await fixture("dedicated", undefined, { publicGithubRead: publicReader });
    delete f.revision.repositoryCredentials;
    codexAppServer(f.revision.configuration).networkProxy = proxy;
    f.revision.compute.admission = present(f.driver.admitRevision(f.revision), "Compute admission");
    await f.driver.prepareRevision(f.revision, f.context(undefined));
    f.markReady();
    await f.driver.activateRevision(f.revision, f.context(undefined));

    // Inspect the mounts and policies that the kubelet and CNI actually consume,
    // then run the Gateway's generated translator on this revision's real artifacts.
    const agent = f.requireConsumer().spec.template.spec;
    const mounts = agent.containers[0].volumeMounts;
    const skill = mounts.find(({ mountPath }) => mountPath.endsWith("public-github-read/SKILL.md"));
    assert.equal(Boolean(skill), allowed, JSON.stringify(proxy));
    const gateway = present(
      f
        .deployments()
        .find(
          ({ spec }) => spec.template.metadata.labels["openclaw.dev/workload-role"] === "gateway",
        ),
    ).spec.template.spec;
    const gatewaySkill = gateway.containers[0].volumeMounts.find(({ mountPath }) =>
      mountPath.endsWith("public-github-read/SKILL.md"),
    );
    assert.equal(Boolean(gatewaySkill), allowed, "Gateway managed skill discovery");
    if (allowed) {
      assert.ok(skill && gatewaySkill);
      assert.equal(gatewaySkill.readOnly, true);
      assert.equal(gatewaySkill.subPath, skill.subPath);
    }
    // Prepare the private parent as the runtime user before projecting a read-only
    // file there. A root-owned .openclaw would break the node's existing skill publication.
    const prepareHome = agent.initContainers.find(({ name }) => name === "prepare-private-state");
    assert.equal(
      present(prepareHome?.args?.[0]).includes(
        "/runtime-state/home/.openclaw/skills/public-github-read",
      ),
      allowed,
    );
    const policies = publicReaderPolicies(f);
    assert.equal(policies.length, allowed ? 1 : 0, JSON.stringify(proxy));
    const manifest = preparedCodexManifest(f);
    assert.equal(manifest.repositoryBrokerNetworkPolicy, undefined);
    const result: unknown = runOpenClawRuntimeHelper({ manifest }, [], {
      baseConfig: parseRecord(preparedNativeDocument(f)),
    });
    const { files } = jsonRecord(result);
    assert.ok(isMap(files));
    const output = files.get("/home/node/.openclaw/openclaw.json");
    assert.ok(typeof output === "string");
    const config = parseRecord(output);
    const effective = recordField(codexAppServer(config), "networkProxy");
    if (allowed) {
      assert.deepEqual(present(policies[0]).spec.egress, [
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": publicReader.namespace },
              },
              podSelector: { matchLabels: publicReader.podLabels },
            },
          ],
          ports: [{ protocol: "TCP", port: 8080 }],
        },
      ]);
      assert.ok(skill?.subPath);
      assert.equal(skill.readOnly, true);
      assert.deepEqual(effective.domains, { "example.org": "deny", [address]: "allow" });
      assert.equal(effective.allowLocalBinding, false);
      assert.equal(effective.mode, "limited");
      assert.deepEqual(effective.readOnlyPaths, ["/app/node_modules/openclaw", skill.mountPath]);
      const { subPath } = skill;
      const runtime = [...f.objects.values()].find(({ data }) => data?.[subPath]);
      assert.ok(runtime?.data?.[subPath]?.includes("http://" + address + ":8080/repos/"));
    } else {
      assert.equal(manifest.publicGithubRead, undefined);
      assert.deepEqual(effective.domains, proxy.domains);
      assert.deepEqual(effective.readOnlyPaths, ["/app/node_modules/openclaw"]);
    }
  }
});

for (const [change, previouslySelected] of [
  ["selects", false],
  ["deselects", true],
] as const) {
  test(`successor that ${change} the public reader changes only its own grant, through exact retirement`, async () => {
    const f = await fixture("dedicated", undefined, { publicGithubRead: publicReader });
    delete f.revision.repositoryCredentials;
    const context = f.context(undefined);
    const prepare = (revision: MaterialRevision, selected: boolean) => {
      codexAppServer(revision.configuration).networkProxy = {
        enabled: true,
        domains: selected ? { [publicReader.address]: "allow" } : {},
      };
      revision.compute.admission = present(f.driver.admitRevision(revision), "Compute admission");
      return f.driver.prepareRevision(revision, context);
    };
    const deployment = (revision: MaterialRevision) =>
      f
        .deployments()
        .find(
          ({ spec }) =>
            spec.template.metadata.labels["openclaw.dev/workload-role"] === "agent" &&
            spec.template.metadata.labels["openclaw.dev/revision"] === revision.id,
        );
    const assertGatewaySkill = (selected: boolean) => {
      const gateway = f
        .deployments()
        .find(
          ({ spec }) => spec.template.metadata.labels["openclaw.dev/workload-role"] === "gateway",
        );
      const mounts = present(gateway).spec.template.spec.containers[0].volumeMounts;
      assert.equal(
        mounts.some(({ mountPath }) => mountPath.endsWith("public-github-read/SKILL.md")),
        selected,
        "the serving Gateway follows its selected revision",
      );
    };
    const assertAccess = (revision: MaterialRevision, selected: boolean) => {
      const { labels } = present(deployment(revision)).spec.template.metadata;
      const grants = publicReaderPolicies(f).filter(({ spec }) =>
        Object.entries(spec.podSelector.matchLabels).every(([key, value]) => labels[key] === value),
      );
      assert.equal(grants.length, selected ? 1 : 0, revision.id + ": public reader egress");
    };

    const current = f.revision;
    await prepare(current, previouslySelected);
    f.markReady();
    await f.driver.activateRevision(current, context);
    assertGatewaySkill(previouslySelected);
    const next = { ...structuredClone(current), id: "revision-public-read-successor", revision: 2 };
    f.enroll(next);

    // Compute must preserve the serving revision's choice even when its worker
    // has not stopped it before preparing a successor with the opposite choice.
    assert.equal((await prepare(next, !previouslySelected)).ready, false);
    assertAccess(current, previouslySelected);
    assertAccess(next, !previouslySelected);
    assertGatewaySkill(previouslySelected);
    f.markReady();
    assert.equal((await f.driver.prepareRevision(next, context)).ready, true);
    await assert.rejects(f.driver.activateRevision(next, context), /gateway is not ready/);
    f.markReady();
    await f.driver.activateRevision(next, context);
    assertGatewaySkill(!previouslySelected);
    assertAccess(current, previouslySelected);
    assertAccess(next, !previouslySelected);

    // Kubernetes has terminated the predecessor's Pods. The successor still serves.
    f.setPods([workloadPod(present(deployment(next)), f.namespace, "serving-successor")]);
    await f.driver.retireRevision(current);
    assert.deepEqual(
      publicReaderPolicies(f).map(
        ({ spec }) => spec.podSelector.matchLabels["openclaw.dev/revision"],
      ),
      previouslySelected ? [] : [next.id],
    );
    f.setPods([]);
    await f.driver.retireRevision(next);
    assert.equal(publicReaderPolicies(f).length, 0);
  });
}
