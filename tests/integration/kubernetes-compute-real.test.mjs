import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { WORKSPACE_DEFAULTS_ID } from "../../packages/contracts/src/index.ts";
import { kubernetesConfigurationName } from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import { createGatewayNodeEnrollment } from "../../apps/controller/src/gateway/node-enrollment-client.ts";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { inlineProbeCommand } from "../helpers/kubernetes-real.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import {
  kubeconfigPath,
  kubernetesContext,
  runtimeImage,
  databaseUrl,
  requiresKubernetes,
  requiresKubernetesAndPostgres,
  driverPath,
  probeSource,
  hash,
  kubectl,
  kubectlRead,
  resource,
  resources,
  missing,
  waitFor,
  provisioningRequestBody,
  createProvisioningApiFixture,
  assertKubernetesFixtureAvailable,
  namespace,
  provisionFixtureAuth,
  revisionContext,
  revision,
  agentName,
  gatewayName,
  harnessWorkspaceClaimName,
  revisionName,
  assertReadyGateway,
  assertHarnessWorkspaceClaim,
  assertAgentServiceEndpointCount,
  fixtureComputeConfiguration,
  createDriver,
  workloadPod,
  assertExecDenied,
  createDnsTrafficFixture,
  createScopedController,
} from "../helpers/kubernetes-compute-real.mjs";

// After hooks in this file delete their randomly named namespaces without waiting: no later
// step reads them, and each deletion waits out namespace-controller passes (5 s each, longer
// while Pods terminate). local-path removes a deleted claim's host directory with a helper
// Pod, which lane cleanup cannot do itself, so the file waits once, at its end, for those
// volumes to be deleted.
const deletedNamespaces = new Set();
function deleteNamespaces(...names) {
  for (const name of names) {
    deletedNamespaces.add(name);
  }
  return kubectl("delete", "namespace", ...names, "--ignore-not-found=true", "--wait=false");
}
after(async () => {
  if (deletedNamespaces.size === 0) {
    return;
  }
  let remaining = [];
  try {
    await waitFor(
      "local-path volumes of deleted namespaces to be removed",
      async () => {
        const volumes = JSON.parse(await kubectlRead("get", "persistentvolumes", "-o", "json"));
        remaining = volumes.items
          .filter(({ spec }) => deletedNamespaces.has(spec.claimRef?.namespace))
          .map(({ metadata, status }) => `${metadata.name} (${status?.phase ?? "unknown"})`);
        return remaining.length === 0;
      },
      180_000,
    );
  } catch (error) {
    // Bound means a namespace is stuck; Released or Failed means local-path's helper failed.
    error.message = `${error.message} Remaining: ${remaining.join(", ")}`;
    throw error;
  }
});

test(
  "real Kubernetes Drivers safely use and preserve an externally managed tenant namespace",
  { ...requiresKubernetes, timeout: 300_000 },
  async (context) => {
    await assertKubernetesFixtureAvailable();
    const installationId = `ins_${randomUUID()}`;
    const platformNamespace = `oce-platform-${hash(installationId)}`;
    const directory = await mkdtemp(join(tmpdir(), "openclaw-existing-namespace-"));
    const existingName = `oce-existing-${hash(randomUUID())}`;
    const cleanupName = `oce-existing-${hash(randomUUID())}`;
    const duplicateName = `oce-duplicate-${hash(randomUUID())}`;
    const unclaimedName = `oce-unclaimed-${hash(randomUUID())}`;
    const owner = {
      ...namespace("existing"),
      id: `ns_${randomUUID()}`,
      status: "provisioning",
      existingNamespace: existingName,
    };
    const cleanupOwner = {
      ...namespace("empty-existing"),
      id: `ns_${randomUUID()}`,
      status: "provisioning",
      existingNamespace: cleanupName,
    };

    await kubectl("create", "namespace", platformNamespace);
    context.after(async () => {
      await deleteNamespaces(
        platformNamespace,
        existingName,
        cleanupName,
        duplicateName,
        unclaimedName,
      );
      await rm(directory, { force: true, recursive: true });
    });
    const controller = await createScopedController(context, installationId, platformNamespace);
    const { driver, kubernetesNamespaceName } = await createDriver({
      authentication: controller.authentication,
    });
    const { KubernetesConfigurationDriver, kubernetesConfigurationName } =
      await import("../../apps/controller/src/drivers/configuration/kubernetes/index.ts");
    const configurationDriver = new KubernetesConfigurationDriver({
      authentication: controller.authentication,
    });

    // Operators prepare arbitrary names before the API generates a platform Namespace identity.
    async function createExistingNamespace(name) {
      await kubectl("create", "namespace", name);
      await kubectl(
        "label",
        "namespace",
        name,
        "app.kubernetes.io/managed-by=Helm",
        "pod-security.kubernetes.io/enforce=restricted",
        "pod-security.kubernetes.io/audit=restricted",
        "pod-security.kubernetes.io/warn=restricted",
      );
      await kubectl("annotate", "namespace", name, "openclaw.dev/namespace-lifecycle=external");
    }

    async function grantTenantAccess(name) {
      await kubectl(
        "create",
        "rolebinding",
        "openclaw-controller",
        "--namespace",
        name,
        `--clusterrole=${controller.tenantRole}`,
        `--serviceaccount=${platformNamespace}:${controller.account}`,
      );
    }

    async function assertPermanentlyRejected(tenant = owner) {
      assert.deepEqual(await driver.ensureNamespace(tenant), {
        namespaceId: tenant.id,
        namespaceReady: false,
        failure: "permanent",
      });
    }

    // Explicit selection never creates the requested namespace or silently falls back to a new one.
    const missingOwner = {
      ...namespace("missing-existing"),
      id: `ns_${randomUUID()}`,
      status: "provisioning",
      existingNamespace: `oce-missing-${hash(randomUUID())}`,
    };
    await assertPermanentlyRejected(missingOwner);
    assert.equal(await missing("namespace", missingOwner.existingNamespace), true);
    assert.equal(await missing("namespace", kubernetesNamespaceName(missingOwner.id)), true);

    // Failed provisioning may be deleted without adopting or mutating an unclaimed operator namespace.
    await createExistingNamespace(unclaimedName);
    const unclaimedOwner = {
      ...namespace("failed-existing"),
      id: `ns_${randomUUID()}`,
      status: "deleting",
      existingNamespace: unclaimedName,
    };
    const untouchedNamespace = await resource("namespace", unclaimedName);
    assert.deepEqual(await driver.deleteNamespace(unclaimedOwner), {
      namespaceId: unclaimedOwner.id,
      namespaceDeleted: true,
    });
    assert.deepEqual(await resource("namespace", unclaimedName), untouchedNamespace);

    await createExistingNamespace(existingName);
    assert.notEqual(existingName, kubernetesNamespaceName(owner.id));
    const originalNamespace = await resource("namespace", existingName);
    assert.equal(Object.hasOwn(originalNamespace.metadata.labels, "openclaw.dev/namespace"), false);
    assert.equal(
      Object.hasOwn(originalNamespace.metadata.annotations, "openclaw.dev/namespace-id"),
      false,
    );

    // Existing foreign identity, missing external consent, and unsafe Pod Security fail closed.
    for (const [operation, key, rejectedValue, restoredValue] of [
      ["label", "openclaw.dev/namespace", randomUUID(), undefined],
      ["label", "openclaw.dev/gateway-namespace", randomUUID(), undefined],
      ["annotate", "openclaw.dev/namespace-id", `ns_${randomUUID()}`, undefined],
      ["annotate", "openclaw.dev/namespace-lifecycle", undefined, "external"],
      ["label", "pod-security.kubernetes.io/enforce", "baseline", "restricted"],
    ]) {
      await kubectl(
        operation,
        "namespace",
        existingName,
        rejectedValue === undefined ? `${key}-` : `${key}=${rejectedValue}`,
        "--overwrite",
      );
      const rejectedNamespace = await resource("namespace", existingName);
      await assertPermanentlyRejected();
      assert.deepEqual(await resource("namespace", existingName), rejectedNamespace);
      await kubectl(
        operation,
        "namespace",
        existingName,
        restoredValue === undefined ? `${key}-` : `${key}=${restoredValue}`,
        "--overwrite",
      );
    }

    // Listing tenant NetworkPolicies is scoped RBAC: absent permission remains retryable and inert.
    const namespaceBeforeAuthorization = await resource("namespace", existingName);
    assert.deepEqual(await driver.ensureNamespace(owner), {
      namespaceId: owner.id,
      namespaceReady: false,
    });
    assert.deepEqual(await resource("namespace", existingName), namespaceBeforeAuthorization);
    assert.equal(await missing("resourcequota", "openclaw-quota", existingName), true);
    await grantTenantAccess(existingName);

    // An already-bound tenant cannot claim a second physical namespace through explicit selection.
    await createExistingNamespace(duplicateName);
    await kubectl("label", "namespace", duplicateName, `openclaw.dev/namespace=${owner.id}`);
    await kubectl("annotate", "namespace", duplicateName, `openclaw.dev/namespace-id=${owner.id}`);
    const namespaceBeforeDuplicateRejection = await resource("namespace", existingName);
    await assertPermanentlyRejected();
    assert.deepEqual(await resource("namespace", existingName), namespaceBeforeDuplicateRejection);
    assert.equal(await missing("resourcequota", "openclaw-quota", existingName), true);
    await kubectl("delete", "namespace", duplicateName, "--wait=true");

    // Additive foreign allow-all policy would defeat default-deny, so reject before any OCC mutation.
    const foreignPolicyPath = join(directory, "foreign-allow-all.json");
    await writeFile(
      foreignPolicyPath,
      JSON.stringify({
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: "operator-allow-all", namespace: existingName },
        spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"], ingress: [{}], egress: [{}] },
      }),
    );
    await kubectl("create", "-f", foreignPolicyPath);
    const originalForeignPolicy = await resource(
      "networkpolicy",
      "operator-allow-all",
      existingName,
    );
    const namespaceBeforePolicyRejection = await resource("namespace", existingName);
    await assertPermanentlyRejected();
    assert.deepEqual(
      await resource("namespace", existingName),
      namespaceBeforePolicyRejection,
      "foreign NetworkPolicies must be rejected before binding tenant ownership metadata",
    );
    assert.deepEqual(
      await resource("networkpolicy", "operator-allow-all", existingName),
      originalForeignPolicy,
      "a foreign allow-all policy must remain entirely unchanged after rejection",
    );
    assert.equal(await missing("resourcequota", "openclaw-quota", existingName), true);
    await kubectl(
      "delete",
      "networkpolicy",
      "operator-allow-all",
      "--namespace",
      existingName,
      "--wait=true",
    );

    await driver.ensureNamespace(owner);
    await waitFor("explicitly selected existing tenant namespace to become ready", async () => {
      const observation = await driver.ensureNamespace(owner);
      assert.notEqual(observation.failure, "permanent");
      return observation.namespaceReady ? observation : undefined;
    });
    const preparedNamespace = await resource("namespace", existingName);
    assert.equal(preparedNamespace.metadata.uid, originalNamespace.metadata.uid);
    assert.deepEqual(preparedNamespace.metadata.labels, {
      ...originalNamespace.metadata.labels,
      "openclaw.dev/namespace": owner.id,
      "openclaw.dev/gateway-namespace": owner.id,
    });
    assert.deepEqual(preparedNamespace.metadata.annotations, {
      ...originalNamespace.metadata.annotations,
      "openclaw.dev/namespace-id": owner.id,
    });
    assert.equal(preparedNamespace.metadata.labels["app.kubernetes.io/managed-by"], "Helm");
    assert.equal(
      preparedNamespace.metadata.annotations["openclaw.dev/namespace-lifecycle"],
      "external",
    );
    assert.equal(await missing("namespace", kubernetesNamespaceName(owner.id)), true);
    assert.deepEqual(
      (await resources("networkpolicies", existingName))
        .map(({ metadata }) => metadata.name)
        .sort(),
      ["allow-dns", "allow-gateway-ingress", "default-deny"],
    );
    await resource("resourcequota", "openclaw-quota", existingName);
    await resource("limitrange", "openclaw-limits", existingName);
    const readyOwner = { ...owner, status: "ready" };
    await provisionFixtureAuth(readyOwner);

    // Canonical Configuration uses the exact adopted namespace alongside runtime resources.
    const configuration = {
      id: `cfg_${randomUUID()}`,
      namespaceId: owner.id,
      kind: "agent",
      generation: 1,
      values: { gateway: { controlUi: { enabled: false } }, logging: { level: "info" } },
      createdAt: new Date().toISOString(),
    };
    const reference = { id: configuration.id, namespaceId: owner.id };
    const configurationName = kubernetesConfigurationName(configuration.id);
    assert.deepEqual(await configurationDriver.create(configuration), configuration);
    assert.equal(
      (await resource("configmap", configurationName, existingName)).metadata.namespace,
      existingName,
    );
    assert.deepEqual(await configurationDriver.read(reference), configuration);
    const updatedConfiguration = {
      ...configuration,
      generation: 2,
      values: { ...configuration.values, logging: { level: "debug" } },
    };
    assert.deepEqual(await configurationDriver.update(updatedConfiguration), updatedConfiguration);
    assert.deepEqual(await configurationDriver.read(reference), updatedConfiguration);
    await configurationDriver.delete(reference);
    assert.equal(await missing("configmap", configurationName, existingName), true);

    // Dedicated workloads and the Harness workspace must remain inside the exact tenant.
    const agentId = `agt_${randomUUID()}`;
    const candidate = revision(driver, readyOwner, agentId, 1);
    await waitFor("discovered Agent gateway and immutable revision to become ready", async () => {
      const observation = await driver.prepareRevision(candidate, revisionContext(candidate));
      assert.equal(observation.namespaceId, owner.id);
      return observation.ready ? observation : undefined;
    });
    const gateway = await assertReadyGateway(existingName, agentId, owner.id, candidate);
    const workload = await resource("deployment", revisionName(candidate), existingName);
    const harnessClaim = await assertHarnessWorkspaceClaim(existingName, owner.id, agentId);
    assert.equal(
      gateway.spec.template.spec.volumes.some(
        ({ persistentVolumeClaim }) =>
          persistentVolumeClaim?.claimName === harnessClaim.metadata.name,
      ),
      false,
      "Gateway must not mount the Harness workspace claim",
    );
    assert.deepEqual(
      workload.spec.template.spec.volumes.find(({ name }) => name === "openclaw-workspace"),
      {
        name: "openclaw-workspace",
        persistentVolumeClaim: { claimName: harnessClaim.metadata.name },
      },
    );
    await driver.stopRevision(candidate);
    assert.equal(await missing("deployment", revisionName(candidate), existingName), true);
    assert.equal(await missing("deployment", gatewayName(agentId), existingName), true);
    assert.deepEqual(
      (await resources("pods", existingName)).filter(
        ({ metadata }) =>
          metadata.labels?.["openclaw.dev/agent"] === agentId &&
          metadata.labels?.["openclaw.dev/revision"] === candidate.id,
      ),
      [],
      "stop must not return while an exact revision Pod can still execute",
    );
    assert.equal(
      (await resource("persistentvolumeclaim", harnessClaim.metadata.name, existingName)).metadata
        .uid,
      harnessClaim.metadata.uid,
      "stop must preserve the Agent-owned Harness workspace claim",
    );

    // Namespace deletion is legal only for an owner with no Agents or Configurations.
    await createExistingNamespace(cleanupName);
    await grantTenantAccess(cleanupName);
    await driver.ensureNamespace(cleanupOwner);
    await waitFor("empty external tenant namespace to become ready", async () => {
      const observation = await driver.ensureNamespace(cleanupOwner);
      assert.notEqual(observation.failure, "permanent");
      return observation.namespaceReady ? observation : undefined;
    });
    const originalCleanupNamespace = await resource("namespace", cleanupName);
    const originalRoleBinding = await resource("rolebinding", "openclaw-controller", cleanupName);
    for (const kind of ["configmap", "secret"]) {
      await kubectl(
        "create",
        kind,
        ...(kind === "secret" ? ["generic"] : []),
        "operator-sentinel",
        "--namespace",
        cleanupName,
        "--from-literal=owner=operator",
      );
    }
    const originalOperatorConfigMap = await resource("configmap", "operator-sentinel", cleanupName);
    const originalOperatorSecret = await resource("secret", "operator-sentinel", cleanupName);

    // Valid deletion removes fixed OCC infrastructure without touching the operator's namespace.
    const deletingOwner = { ...cleanupOwner, status: "deleting" };
    await waitFor(
      "empty tenant infrastructure to be deleted without deleting its namespace",
      async () => {
        const observation = await driver.deleteNamespace(deletingOwner);
        assert.notEqual(observation.failure, "permanent");
        return observation.namespaceDeleted ? observation : undefined;
      },
    );
    for (const kind of ["networkpolicies", "resourcequotas", "limitranges"]) {
      assert.deepEqual(await resources(kind, cleanupName), []);
    }
    const preservedNamespace = await resource("namespace", cleanupName);
    assert.equal(preservedNamespace.metadata.uid, originalCleanupNamespace.metadata.uid);
    assert.deepEqual(preservedNamespace.metadata.labels, originalCleanupNamespace.metadata.labels);
    assert.deepEqual(
      preservedNamespace.metadata.annotations,
      originalCleanupNamespace.metadata.annotations,
    );
    assert.equal(
      (await resource("rolebinding", "openclaw-controller", cleanupName)).metadata.uid,
      originalRoleBinding.metadata.uid,
    );
    assert.equal(
      (await resource("configmap", "operator-sentinel", cleanupName)).metadata.uid,
      originalOperatorConfigMap.metadata.uid,
    );
    assert.equal(
      (await resource("secret", "operator-sentinel", cleanupName)).metadata.uid,
      originalOperatorSecret.metadata.uid,
    );
    assert.deepEqual(await driver.deleteNamespace(deletingOwner), {
      namespaceId: cleanupOwner.id,
      namespaceDeleted: true,
    });
  },
);

test(
  "provisioning API and worker hand off a dedicated Agent with real Kubernetes fixture storage",
  { ...requiresKubernetesAndPostgres, timeout: 360_000 },
  async (context) => {
    await assertKubernetesFixtureAvailable();
    const installationId = `ins_${randomUUID()}`;
    const platformNamespace = `oce-provisioning-${hash(installationId)}`;
    await kubectl("create", "namespace", platformNamespace);
    context.after(() => deleteNamespaces(platformNamespace));
    const controller = await createScopedController(context, installationId, platformNamespace);
    await kubectl(
      "patch",
      "clusterrole",
      controller.tenantRole,
      "--type=json",
      "--patch",
      JSON.stringify([
        {
          op: "add",
          path: "/rules/-",
          value: {
            apiGroups: [""],
            resources: ["secrets"],
            verbs: ["get", "list", "create", "patch", "update", "delete"],
          },
        },
        // Final deletion checks routes even when deployment failed before creating them.
        ...[
          ["gateway.networking.k8s.io", "httproutes"],
          ["gateway.envoyproxy.io", "securitypolicies"],
        ].map(([group, resource]) => ({
          op: "add",
          path: "/rules/-",
          value: { apiGroups: [group], resources: [resource], verbs: ["get", "delete"] },
        })),
      ]),
    );
    const gatewayRouting = {
      gatewayName: `oce-agent-gateways-${hash(installationId, 8)}`,
      gatewayNamespace: platformNamespace,
      envoyNamespace: platformNamespace,
    };
    const nodeEnrollment = createGatewayNodeEnrollment(
      async () => "fixture-node-enrollment-api-key",
    );
    const { driver, kubernetesNamespaceName } = await createDriver(
      {
        authentication: controller.authentication,
        gatewayRouting,
        network: {
          dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
          gatewayPort: 8080,
          gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
        },
        runtime: {
          transportSecretPrefix: "transport",
          gatewayStorageClassName: "local-path",
          gatewayNodeSelector: {
            "kubernetes.io/hostname": JSON.parse(await kubectl("get", "nodes", "-o", "json"))
              .items[0].metadata.name,
          },
        },
      },
      { nodeEnrollment },
    );
    const fixture = await createProvisioningApiFixture(context, driver, controller.authentication);
    context.after(async () => {
      await Promise.all(
        fixture.bootstrapNamespaceIds.map((namespaceId) =>
          deleteNamespaces(kubernetesNamespaceName(namespaceId)),
        ),
      );
    });
    const namespaceResponse = await fixture.request("POST", "/namespaces", {
      name: `k8s-provision-${randomUUID().slice(0, 8)}`,
    });
    assert.equal(namespaceResponse.status, 201, JSON.stringify(namespaceResponse.body));
    const namespaceOwner = namespaceResponse.data;
    const placement = kubernetesNamespaceName(namespaceOwner.id);
    const gatewayPlacement = placement;
    context.after(() => deleteNamespaces(placement));

    await fixture.startWorker();
    for (const target of [placement]) {
      await waitFor(`worker to create provisioning namespace ${target}`, async () =>
        (await missing("namespace", target)) ? undefined : true,
      );
      await kubectl(
        "create",
        "rolebinding",
        "openclaw-controller",
        "--namespace",
        target,
        `--clusterrole=${controller.tenantRole}`,
        `--serviceaccount=${platformNamespace}:${controller.account}`,
      );
    }
    await waitFor("provisioning tenant Namespace to become ready", async () => {
      const observed = await fixture.request("GET", `/namespaces/${namespaceOwner.id}`);
      assert.equal(observed.status, 200, JSON.stringify(observed.body));
      return observed.data.status === "ready" ? observed.data : undefined;
    });
    await fixture.stopWorker();

    const discoveryPat = `at-kubernetes-fixture-${randomUUID()}`;
    const rotatedPat = `at-kubernetes-rotated-${randomUUID()}`;
    const modelSecret = await fixture.request("POST", `/namespaces/${namespaceOwner.id}/secrets`, {
      name: `Provisioning model key ${randomUUID().slice(0, 8)}`,
      value: discoveryPat,
    });
    assert.equal(modelSecret.status, 201, JSON.stringify(modelSecret.body));
    const slackBotSecret = await fixture.request(
      "POST",
      `/namespaces/${namespaceOwner.id}/secrets`,
      {
        name: `Provisioning Slack bot token ${randomUUID().slice(0, 8)}`,
        value: `xoxb-${randomUUID()}`,
      },
    );
    assert.equal(slackBotSecret.status, 201, JSON.stringify(slackBotSecret.body));

    // Before creating the Agent, use the actual Kubernetes-backed PAT through the
    // real discovery Driver; only the external provider responses are controlled.
    const originalFetch = globalThis.fetch;
    const observedTokens = [];
    const provider = context.mock.method(globalThis, "fetch", async (url, init) => {
      const address = String(url);
      if (
        !address.startsWith("https://auth.openai.com/") &&
        !address.startsWith("https://chatgpt.com/backend-api/ps/")
      ) {
        return originalFetch(url, init);
      }
      observedTokens.push(init.headers.Authorization.slice("Bearer ".length));
      if (address.includes("/whoami")) {
        return Response.json({
          chatgpt_account_id: "fixture-account",
          chatgpt_account_is_fedramp: false,
        });
      }
      assert.equal(init.headers["ChatGPT-Account-ID"], "fixture-account");
      const plugin = {
        id: "fixture-plugin",
        name: "fixture",
        scope: "GLOBAL",
        status: "ENABLED",
        installation_policy: "AVAILABLE",
        release: {
          display_name: "Fixture",
          interface: {},
          requires_local_executor: false,
          app_ids: ["fixture-app"],
          app_manifest: null,
          skills: [],
          mcp_servers: [],
        },
      };
      if (address.includes("plugins/list")) {
        return Response.json({ plugins: [plugin], pagination: { next_page_token: null } });
      }
      if (address.includes("plugins/fixture-plugin")) {
        return Response.json(plugin);
      }
      assert.ok(address.endsWith("apps/batch"));
      return Response.json({
        apps: [{ id: "fixture-app", status: "ENABLED", tools: [{ name: "search" }] }],
      });
    });
    const discoveryPath = `/namespaces/${namespaceOwner.id}/agents/plugins`;
    const catalog = await fixture.request("POST", discoveryPath, {
      secretRef: modelSecret.data.ref,
    });
    assert.equal(catalog.status, 200);
    assert.equal(catalog.data.plugins[0].remoteId, "fixture-plugin");
    const detail = await fixture.request("POST", `${discoveryPath}/details`, {
      secretRef: modelSecret.data.ref,
      pluginId: "fixture-plugin",
    });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.tools[0].id, "fixture-app/search");
    assert.ok(observedTokens.length > 0 && observedTokens.every((token) => token === discoveryPat));
    assert.equal(
      (
        await fixture.request(
          "PATCH",
          `/namespaces/${namespaceOwner.id}/secrets/${modelSecret.data.id}`,
          { value: rotatedPat },
        )
      ).status,
      200,
    );
    observedTokens.length = 0;
    assert.equal(
      (await fixture.request("POST", discoveryPath, { secretRef: modelSecret.data.ref })).status,
      200,
    );
    assert.ok(observedTokens.length > 0 && observedTokens.every((token) => token === rotatedPat));
    assert.doesNotMatch(
      JSON.stringify([catalog.body, detail.body]),
      /at-kubernetes-(fixture|rotated)-/,
    );
    provider.mock.restore();

    const body = provisioningRequestBody({
      modelSecretRef: modelSecret.data.ref,
      slackBotSecretRef: slackBotSecret.data.ref,
      authMethod: "codex_pat",
    });
    assert.equal(
      JSON.stringify(body).includes(rotatedPat),
      false,
      "provisioning must carry only saved Secret references, not Secret values",
    );
    assert.equal(
      JSON.stringify(body).includes("xoxb-"),
      false,
      "provisioning must carry only saved Secret references, not Slack token values",
    );
    const admitted = await fixture.request(
      "POST",
      `/namespaces/${namespaceOwner.id}/agents/provision`,
      body,
    );
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    assert.equal(admitted.data.agent, undefined);
    assert.equal(typeof admitted.data.provisioning.workId, "string");
    assert.match(admitted.data.provisioning.url, /^\/namespaces\//);
    await fixture.startWorker();
    const provisioned = await waitFor("Kubernetes provisioning handoff to succeed", async () => {
      const observed = await fixture.request("GET", admitted.data.provisioning.url);
      assert.equal(observed.status, 200, JSON.stringify(observed.body));
      return observed.data.status === "succeeded" ? observed.data : undefined;
    });
    await fixture.stopWorker();
    assert.equal(typeof provisioned.agentId, "string");
    assert.equal(typeof provisioned.configurationId, "string");
    assert.equal(typeof provisioned.revisionId, "string");

    const revisions = await fixture.request(
      "GET",
      `/namespaces/${namespaceOwner.id}/agents/${provisioned.agentId}/revisions`,
    );
    assert.equal(revisions.status, 200, JSON.stringify(revisions.body));
    assert.equal(revisions.data.length, 1);
    assert.equal(revisions.data[0].id, provisioned.revisionId);
    assert.equal(revisions.data[0].compute.id, driver.id);
    assert.equal(revisions.data[0].compute.implementation, driver.implementation);

    const configuration = await resource(
      "configmap",
      kubernetesConfigurationName(revisions.data[0].configurationId),
      gatewayPlacement,
    );
    assert.equal(
      configuration.metadata.annotations["openclaw.dev/configuration-id"],
      revisions.data[0].configurationId,
    );
    assert.equal(configuration.metadata.annotations["openclaw.dev/configuration-generation"], "1");

    const provisionedSecrets = (await resources("secrets", gatewayPlacement)).filter(
      ({ metadata }) =>
        metadata.labels?.["app.kubernetes.io/managed-by"] === "openclaw-enterprise" &&
        metadata.labels?.["openclaw.dev/namespace"] === namespaceOwner.id &&
        metadata.labels?.["openclaw.dev/secret"] !== undefined,
    );
    assert.equal(
      provisionedSecrets.length,
      2,
      "Console-saved Secrets must be stored through the real Kubernetes Secret Driver",
    );
    const transportName = `transport-${hash(provisioned.agentId)}`;
    const passwordName = `gateway-password-${hash(provisioned.agentId)}`;
    const transport = await resource("secret", transportName, gatewayPlacement);
    const password = await resource("secret", passwordName, gatewayPlacement);
    assert.deepEqual(
      Object.keys(transport.data),
      ["app-server-token"],
      "the canonical app-server credential must be generated before provisioning handoff",
    );
    assert.deepEqual(
      Object.keys(password.data),
      ["gateway-password"],
      "the Gateway password must be a separate canonical credential",
    );
    const canonicalNames = [
      transportName,
      passwordName,
      ...provisionedSecrets.map(({ metadata }) => metadata.name),
    ];
    for (const name of canonicalNames) {
      await resource("secret", name, placement);
    }

    // Seed an owned pre-upgrade RWX workspace without altering any supported Agent.
    // No RWX provisioner is needed: rejection must happen before mounting the claim.
    const legacyConfiguration = await fixture.request(
      "POST",
      `/namespaces/${namespaceOwner.id}/configurations`,
      {
        kind: "agent",
        values: {
          gateway: body.configuration.values.gateway,
          agents: body.configuration.values.agents,
        },
      },
    );
    assert.equal(legacyConfiguration.status, 201, JSON.stringify(legacyConfiguration.body));
    const legacy = await fixture.request("POST", `/namespaces/${namespaceOwner.id}/agents`, {
      name: `legacy-rwx-${randomUUID()}`,
      configurationId: legacyConfiguration.data.id,
      executionMode: "dedicated",
      harnessAuth: body.harnessAuth,
    });
    assert.equal(legacy.status, 201, JSON.stringify(legacy.body));
    const legacyPath = `/namespaces/${namespaceOwner.id}/agents/${legacy.data.id}`;
    const role = await fixture.request("POST", `/namespaces/${namespaceOwner.id}/iam/roles`, {
      name: `legacy-rwx-secrets-${randomUUID()}`,
      permissions: [{ action: "operate", resourceKind: "secret" }],
    });
    assert.equal(role.status, 201, JSON.stringify(role.body));
    for (const secret of [modelSecret]) {
      const grant = await fixture.request(
        "POST",
        `/namespaces/${namespaceOwner.id}/iam/access-bindings`,
        {
          subjectKind: "identity",
          subjectId: legacy.data.servicePrincipalId,
          roleId: role.data.id,
          resourceKind: "secret",
          resourceId: secret.data.id,
        },
      );
      assert.equal(grant.status, 201, JSON.stringify(grant.body));
    }
    const credentials = await fixture.request("POST", `${legacyPath}/runtime-credentials`, {});
    assert.equal(credentials.status, 200, JSON.stringify(credentials.body));
    const workspaceName = harnessWorkspaceClaimName(legacy.data.id);
    const gatewayStateName = `gateway-state-${hash(legacy.data.id)}`;
    const claimDirectory = await mkdtemp(join(tmpdir(), "openclaw-legacy-rwx-"));
    context.after(() => rm(claimDirectory, { recursive: true, force: true }));
    for (const [name, namespace, accessMode, storage] of [
      [workspaceName, placement, "ReadWriteMany", "40Gi"],
      [gatewayStateName, gatewayPlacement, "ReadWriteOnce", "10Gi"],
    ]) {
      const claimPath = join(claimDirectory, `${name}.json`);
      await writeFile(
        claimPath,
        JSON.stringify({
          apiVersion: "v1",
          kind: "PersistentVolumeClaim",
          metadata: {
            name,
            namespace,
            labels: {
              "app.kubernetes.io/managed-by": "openclaw-enterprise",
              "openclaw.dev/namespace": namespaceOwner.id,
              "openclaw.dev/agent": legacy.data.id,
            },
            annotations: {
              "openclaw.dev/namespace-id": namespaceOwner.id,
              "openclaw.dev/agent-id": legacy.data.id,
            },
          },
          spec: {
            accessModes: [accessMode],
            volumeMode: "Filesystem",
            storageClassName: "local-path",
            resources: { requests: { storage } },
          },
        }),
        { mode: 0o600 },
      );
      await kubectl("apply", "--filename", claimPath);
    }
    const originalWorkspace = await resource("persistentvolumeclaim", workspaceName, placement);
    const originalGatewayState = await resource(
      "persistentvolumeclaim",
      gatewayStateName,
      gatewayPlacement,
    );
    // Observe the real Driver failure without replacing its Kubernetes client or behavior.
    // A generic worker failure alone could otherwise pass for an unrelated configuration error.
    const prepareRevision = driver.prepareRevision.bind(driver);
    const preparationFailures = [];
    const preparation = context.mock.method(driver, "prepareRevision", async (...args) => {
      try {
        return await prepareRevision(...args);
      } catch (error) {
        if (args[0].agentId === legacy.data.id) {
          preparationFailures.push(error.message);
        }
        throw error;
      }
    });
    const deployment = await fixture.request("POST", `${legacyPath}/deploy`);
    assert.equal(deployment.status, 202, JSON.stringify(deployment.body));
    await fixture.startWorker();
    const failedDeployment = await waitFor("legacy RWX deployment to fail", async () => {
      const work = await fixture.readWork(`agent_revision:${deployment.data.id}:reconcile`);
      return work?.state === "failed_permanent" ? work : undefined;
    });
    preparation.mock.restore();
    assert.deepEqual(
      new Set(preparationFailures),
      new Set([`Refusing invalid PersistentVolumeClaim ${workspaceName}.`]),
    );
    assert.equal(failedDeployment.reason_code, "DEPENDENCY_UNAVAILABLE");
    const undeployed = await fixture.request("GET", legacyPath);
    assert.equal(undeployed.status, 200, JSON.stringify(undeployed.body));
    assert.equal(undeployed.data.activeRevisionId, undefined);
    assert.equal(await missing("deployment", revisionName(deployment.data), placement), true);
    assert.equal(await missing("deployment", gatewayName(legacy.data.id), gatewayPlacement), true);
    assert.equal(
      (await resource("persistentvolumeclaim", gatewayStateName, gatewayPlacement)).metadata.uid,
      originalGatewayState.metadata.uid,
    );
    const beforeDelete = await resource("persistentvolumeclaim", workspaceName, placement);
    assert.equal(beforeDelete.metadata.uid, originalWorkspace.metadata.uid);
    assert.deepEqual(beforeDelete.spec, originalWorkspace.spec);

    const deleting = await fixture.request("DELETE", legacyPath);
    assert.equal(deleting.status, 202, JSON.stringify(deleting.body));
    const failedDeletion = await waitFor(
      "legacy RWX deletion to exhaust its retry budget",
      async () => {
        const work = await fixture.readWork(`agent:${legacy.data.id}:reconcile:deleted`);
        return work?.state === "failed_permanent" ? work : undefined;
      },
    );
    assert.equal(failedDeletion.reason_code, "DEPENDENCY_UNAVAILABLE");
    await fixture.stopWorker();
    const retained = await fixture.request("GET", legacyPath);
    assert.equal(retained.status, 200, JSON.stringify(retained.body));
    assert.equal(retained.data.status, "deleting");
    assert.equal(retained.data.desiredRuntimeState, "stopped");
    const rejectedWorkspace = await resource("persistentvolumeclaim", workspaceName, placement);
    assert.equal(rejectedWorkspace.metadata.uid, originalWorkspace.metadata.uid);
    assert.deepEqual(rejectedWorkspace.spec, originalWorkspace.spec);
    assert.equal(rejectedWorkspace.metadata.deletionTimestamp, undefined);
    // Final deletion removes Gateway state before Harness workspace validation.
    // This is why the legacy Agent must be discarded with a compatible release.
    assert.equal(
      await missing("persistentvolumeclaim", gatewayStateName, gatewayPlacement),
      true,
      "Gateway state is removed before final deletion rejects the RWX claim",
    );
    assert.equal(
      await missing("secret", `transport-${hash(legacy.data.id)}`, gatewayPlacement),
      true,
    );
    assert.equal(
      await missing("secret", `gateway-password-${hash(legacy.data.id)}`, gatewayPlacement),
      true,
    );
    // The unrelated Agent and its canonical credentials are not deleted.
    assert.equal(
      (
        await fixture.request(
          "GET",
          `/namespaces/${namespaceOwner.id}/agents/${provisioned.agentId}`,
        )
      ).status,
      200,
    );
    assert.equal(
      (await resource("secret", transportName, gatewayPlacement)).metadata.uid,
      transport.metadata.uid,
    );
  },
);

test(
  "authenticated PostgreSQL OCC API and worker deploy real Agent-owned gateways, Secret bindings, and revisions",
  { ...requiresKubernetesAndPostgres, timeout: runtimeImage === undefined ? 360_000 : 600_000 },
  async (context) => {
    await assertKubernetesFixtureAvailable();
    const database = new URL(databaseUrl);
    assert.ok(
      ["127.0.0.1", "localhost", "[::1]"].includes(database.hostname),
      "the real-cluster end-to-end test requires a loopback PostgreSQL instance",
    );
    assert.match(
      database.pathname,
      /^\/openclaw_k8s_[a-z0-9_]+$/,
      "refusing to modify a database that is not explicitly dedicated to disposable Kubernetes integration",
    );

    const [
      { default: pg },
      { PostgresPlatformState },
      { composePostgresDevelopment },
      { loadInstallationConfiguration },
      { createControllerWorker },
      { authenticatedHeaders, signInToControllerApp },
    ] = await Promise.all([
      import("pg"),
      import("../../packages/occ/src/state/postgres-state.ts"),
      import("../../apps/controller/src/composition/development-postgres.ts"),
      import("../../apps/controller/src/composition/installation-config.ts"),
      import("../../apps/controller/src/worker.ts"),
      import("../helpers/auth-session.mjs"),
    ]);

    const observerPool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
    const state = new PostgresPlatformState(observerPool);
    const previous = await state.loadInstallation();
    if (previous !== undefined) {
      assert.equal(
        previous.name,
        "OpenClaw Kubernetes integration",
        "refusing to alter a preexisting database Installation not owned by this test",
      );
    }

    const { kubernetesNamespaceName } = await import(driverPath);
    const { kubernetesConfigurationName } =
      await import("../../apps/controller/src/drivers/configuration/kubernetes/index.ts");
    const configuration = createInstallationDriverConfiguration();
    configuration.drivers.compute.configuration = fixtureComputeConfiguration(
      runtimeImage === undefined
        ? {}
        : {
            images: {
              gateway: runtimeImage,
              agent: runtimeImage,
              requireImmutableDigest: true,
            },
            resources: {
              gateway: {
                requests: { cpu: "50m", memory: "128Mi" },
                limits: { cpu: "500m", memory: "768Mi" },
              },
              agent: {
                requests: { cpu: "50m", memory: "128Mi" },
                limits: { cpu: "500m", memory: "768Mi" },
              },
              namespace: {
                quota: {
                  pods: "20",
                  "requests.cpu": "2",
                  "requests.memory": "4Gi",
                  "limits.cpu": "8",
                  "limits.memory": "8Gi",
                },
                containerDefaults: {
                  requests: { cpu: "50m", memory: "128Mi" },
                  limits: { cpu: "500m", memory: "768Mi" },
                },
              },
            },
            runtime: {
              transportSecretPrefix: "transport",
              gatewayStorageClassName: "local-path",
              gatewayNodeSelector: {
                "kubernetes.io/hostname": JSON.parse(await kubectl("get", "nodes", "-o", "json"))
                  .items[0].metadata.name,
              },
              channels: { secretPrefix: "channel", proxyUrl: "http://10.42.0.15:3128" },
            },
          },
    );
    const proxyCidrs = process.env.OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS?.split(",")
      .map((cidr) => cidr.trim())
      .filter(Boolean);
    assert.ok(
      proxyCidrs?.length,
      "the real diagnostics route requires the k3d API server Pod proxy source CIDR",
    );
    configuration.drivers.compute.configuration.network.pluginStatusProxySourceCidrs = proxyCidrs;
    for (const capability of ["configuration", "secret"]) {
      configuration.drivers[capability].configuration.authentication = {
        mode: "kubeconfig",
        kubeconfigPath,
        context: kubernetesContext,
      };
    }
    const drivers = await loadInstallationConfiguration({
      mode: "development",
      environment: {},
      startupConfiguration: { configuration, logging: { level: "info" } },
    });
    assert.ok(drivers);
    const driver = drivers.computeDriver;
    const adminCredentials = {
      email: "admin-kubernetes-integration@example.test",
      password: "kubernetes-integration-admin-password",
    };
    const namespaceIds = [];
    const placements = new Map();
    const existingName = `oce-api-existing-${hash(randomUUID())}`;
    let app;
    let worker;
    let workerPool;
    let workerDrivers = drivers;
    let workerStarts = 0;
    context.after(async () => {
      if (worker !== undefined) {
        await worker.stop();
      } else if (workerPool !== undefined) {
        await workerPool.end();
      }
      if (app !== undefined) {
        await app.close();
      }
      await observerPool.end();
      await deleteNamespaces(
        ...new Set([
          existingName,
          ...placements.values(),
          ...namespaceIds.map(kubernetesNamespaceName),
        ]),
      );
    });

    const authSecret = "kubernetes-integration-auth-secret-32-bytes";
    const authBaseURL = "http://127.0.0.1";
    if (previous === undefined) {
      await ensureDevelopmentBootstrap(context, {
        databaseUrl,
        email: adminCredentials.email,
        password: adminCredentials.password,
        authSecret,
        authBaseURL,
        installationName: "OpenClaw Kubernetes integration",
      });
    }

    const developmentConfig = {
      mode: "development",
      host: "127.0.0.1",
      databaseUrl,
      authSecret,
      authBaseURL,
    };
    // Both supported startup callers must reject old storage before admitting
    // API writes or claiming work, even when running the development profile.
    const legacyOwner = namespace("dev-upgrade");
    const legacyName = `oce-gateways-${hash(legacyOwner.id, 24)}`;
    await kubectl("create", "namespace", legacyName);
    try {
      await kubectl(
        "label",
        "namespace",
        legacyName,
        "app.kubernetes.io/managed-by=openclaw-enterprise",
        `openclaw.dev/gateway-namespace=${legacyOwner.id}`,
      );
      await kubectl(
        "annotate",
        "namespace",
        legacyName,
        `openclaw.dev/namespace-id=${legacyOwner.id}`,
      );
      const before = await resource("namespace", legacyName);
      await assert.rejects(async () => {
        const unexpected = await composePostgresDevelopment(developmentConfig, drivers);
        await unexpected.close();
      }, /Existing split-layout Gateway storage/);
      const rejectedWorker = createControllerWorker({
        pool: new pg.Pool({ connectionString: databaseUrl, max: 2 }),
        drivers,
        emit: () => {},
      });
      try {
        await assert.rejects(rejectedWorker.start(), /Existing split-layout Gateway storage/);
      } finally {
        await rejectedWorker.stop();
      }
      const after = await resource("namespace", legacyName);
      assert.equal(after.metadata.uid, before.metadata.uid);
      assert.deepEqual(after.metadata.labels, before.metadata.labels);
      assert.equal(await missing("namespace", kubernetesNamespaceName(legacyOwner.id)), true);
    } finally {
      await kubectl("delete", "namespace", legacyName, "--wait=true");
    }
    app = await composePostgresDevelopment(developmentConfig, drivers);
    const session = await signInToControllerApp(app, adminCredentials);

    async function request(method, url, payload, options = {}) {
      const mutation = ["POST", "PATCH", "PUT", "DELETE"].includes(method);
      const response = await app.inject({
        method,
        url,
        headers: {
          ...(options.session === false ? {} : authenticatedHeaders(options.session ?? session)),
          ...(mutation ? { origin: authBaseURL } : {}),
          ...options.headers,
          host: "127.0.0.1",
        },
        ...(payload === undefined ? {} : { payload }),
      });
      return { status: response.statusCode, ...response.json() };
    }

    async function startWorker({ convergenceTimeoutMs } = {}) {
      workerPool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
      if (workerStarts > 0) {
        workerDrivers = await loadInstallationConfiguration({
          mode: "development",
          environment: {},
          startupConfiguration: { configuration, logging: { level: "info" } },
        });
        assert.ok(workerDrivers);
      }
      workerStarts += 1;
      worker = createControllerWorker({
        pool: workerPool,
        drivers: workerDrivers,
        pollIntervalMs: 25,
        leaseDurationMs: 30_000,
        maxAttempts: 20,
        ...(convergenceTimeoutMs === undefined ? {} : { convergenceTimeoutMs }),
        emit: () => {},
      });
      await worker.start();
    }

    // External consent and restricted security can be prepared before its platform ID exists.
    await kubectl("create", "namespace", existingName);
    await kubectl(
      "label",
      "namespace",
      existingName,
      "app.kubernetes.io/managed-by=Helm",
      "pod-security.kubernetes.io/enforce=restricted",
      "pod-security.kubernetes.io/audit=restricted",
      "pod-security.kubernetes.io/warn=restricted",
    );
    await kubectl(
      "annotate",
      "namespace",
      existingName,
      "openclaw.dev/namespace-lifecycle=external",
    );
    const unclaimedExistingNamespace = await resource("namespace", existingName);
    assert.equal(
      Object.hasOwn(unclaimedExistingNamespace.metadata.labels, "openclaw.dev/namespace"),
      false,
    );
    assert.equal(
      Object.hasOwn(unclaimedExistingNamespace.metadata.annotations, "openclaw.dev/namespace-id"),
      false,
    );

    // Keep the shared worker running throughout Namespace creation and external namespace adoption.
    await startWorker();
    const unauthorized = await request(
      "POST",
      "/namespaces",
      { name: "unauthorized" },
      { session: false, headers: { authorization: "Bearer denied" } },
    );
    assert.ok([401, 403].includes(unauthorized.status));

    for (const label of ["primary", "secondary"]) {
      const created = await request("POST", "/namespaces", {
        name: `kubernetes-${label}-${randomUUID()}`,
      });
      assert.equal(created.status, 201);
      namespaceIds.push(created.data.id);
      placements.set(created.data.id, kubernetesNamespaceName(created.data.id));
    }

    const adopted = await request("POST", "/namespaces", {
      name: `kubernetes-adopted-${randomUUID()}`,
      existingNamespace: existingName,
    });
    assert.equal(adopted.status, 201, JSON.stringify(adopted.error));
    assert.equal(adopted.data.existingNamespace, existingName);
    namespaceIds.push(adopted.data.id);
    placements.set(adopted.data.id, existingName);

    await Promise.all(
      namespaceIds.map((id) =>
        waitFor(`API Namespace ${id} to become ready`, async () => {
          const current = await request("GET", `/namespaces/${id}`);
          assert.equal(current.status, 200);
          return current.data.status === "ready" ? current.data : undefined;
        }),
      ),
    );
    for (const id of namespaceIds) {
      assert.equal(
        (await resources("deployments", placements.get(id))).length,
        0,
        "a ready Namespace must not have a gateway until an Agent is deployed",
      );
    }
    const adoptedBacking = await resource("namespace", existingName);
    assert.equal(adoptedBacking.metadata.uid, unclaimedExistingNamespace.metadata.uid);
    assert.equal(adoptedBacking.metadata.labels["app.kubernetes.io/managed-by"], "Helm");
    assert.equal(adoptedBacking.metadata.labels["openclaw.dev/namespace"], adopted.data.id);
    assert.equal(adoptedBacking.metadata.annotations["openclaw.dev/namespace-id"], adopted.data.id);
    assert.equal(
      adoptedBacking.metadata.annotations["openclaw.dev/namespace-lifecycle"],
      "external",
    );
    assert.equal(await missing("namespace", kubernetesNamespaceName(adopted.data.id)), true);
    assert.equal(
      (await state.read((view) => view.namespaces.findNamespace(adopted.data.id)))
        .existingNamespace,
      existingName,
      "the real worker must recover explicit namespace selection from PostgreSQL",
    );

    async function grantSecretOperate(namespaceId, servicePrincipalId, secretId, label) {
      const role = await request("POST", `/namespaces/${namespaceId}/iam/roles`, {
        name: `${label} Secret operate ${randomUUID()}`,
        permissions: [{ action: "operate", resourceKind: "secret" }],
      });
      assert.equal(role.status, 201, JSON.stringify(role.error));
      const binding = await request("POST", `/namespaces/${namespaceId}/iam/access-bindings`, {
        subjectKind: "identity",
        subjectId: servicePrincipalId,
        roleId: role.data.id,
        resourceKind: "secret",
        resourceId: secretId,
      });
      assert.equal(binding.status, 201, JSON.stringify(binding.error));
      return { role: role.data, binding: binding.data };
    }

    async function assertDeployDenied(namespaceId, agentId, label) {
      const denied = await request("POST", `/namespaces/${namespaceId}/agents/${agentId}/deploy`);
      assert.equal(denied.status, 403, `${label}: ${JSON.stringify(denied.error)}`);
    }

    const initialWorkspaceFilesByAgent = new Map();
    async function assertInitialWorkspace(
      namespaceId,
      agentId,
      expectedFiles,
      candidate,
      executionMode = "dedicated",
    ) {
      const placement = placements.get(namespaceId);
      const output = await kubectlRead(
        "exec",
        `deployment/${executionMode === "embedded" ? gatewayName(agentId) : revisionName(candidate)}`,
        "--namespace",
        placement,
        "-c",
        executionMode === "embedded" ? "gateway" : "agent",
        "--",
        "node",
        "-e",
        `const fs = require('node:fs'); process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(expectedFiles))}.map(name => [name, fs.readFileSync(${JSON.stringify(executionMode === "embedded" ? "/home/node/.openclaw/workspace/" : "/home/node/workspace/")} + name, 'utf8')]))));`,
      );
      assert.deepEqual(JSON.parse(output), expectedFiles);
      const completed = await state.read((view) => view.workspaceSetups.find(namespaceId, agentId));
      assert.equal(completed.completed, true);
      assert.equal(completed.files, undefined, "activation removes staged document bytes");
      const delivered = await resource("secret", `workspace-setup-${hash(agentId)}`, placement);
      const payload = JSON.parse(
        Buffer.from(delivered.data["setup.json"], "base64").toString("utf8"),
      );
      assert.equal(payload.completed, true);
      assert.equal(payload.files, undefined, "runtime delivery retains only its restart guard");
    }

    async function createAgent(namespaceId, label, options = {}) {
      const executionMode = options.executionMode ?? "dedicated";
      const model = executionMode === "embedded" ? "openai/gpt-4.1" : "codex/gpt-4.1";
      const agentRuntime = executionMode === "embedded" ? "openclaw" : "codex";
      const secret = await request("POST", `/namespaces/${namespaceId}/secrets`, {
        name: `${label} fixture model key`,
        value: `fixture-only-${randomUUID()}`,
      });
      assert.equal(secret.status, 201, JSON.stringify(secret.error));
      let boundSecret;
      let boundSecretValue;
      if (options.boundSecret === true) {
        boundSecretValue = `bound-secret-${randomUUID()}`;
        boundSecret = await request("POST", `/namespaces/${namespaceId}/secrets`, {
          name: `${label} bound sentinel`,
          value: boundSecretValue,
        });
        assert.equal(boundSecret.status, 201, JSON.stringify(boundSecret.error));
      }
      const baseValues = {
        gateway: {
          mode: "local",
          bind: "loopback",
          controlUi: { enabled: false },
          auth: {
            password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
          },
        },
        logging: { level: "info" },
        agents: {
          defaults: {
            skipBootstrap: true,
            model,
            models: { [model]: { agentRuntime: { id: agentRuntime } } },
          },
        },
      };
      const missingChannelBindingValues = {
        ...baseValues,
        plugins: { allow: ["slack"], entries: { slack: { enabled: true } } },
        channels: {
          slack: {
            enabled: true,
            mode: "socket",
            appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
            botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
            dmPolicy: "allowlist",
            allowFrom: ["U0123456789"],
            channels: {
              C0123456789: { requireMention: true, allowBots: "mentions" },
            },
          },
        },
      };
      const configuration = await request("POST", `/namespaces/${namespaceId}/configurations`, {
        kind: "agent",
        values: baseValues,
      });
      assert.equal(configuration.status, 201, JSON.stringify(configuration.error));
      const created = await request("POST", `/namespaces/${namespaceId}/agents`, {
        name: `${label}-${randomUUID()}`,
        configurationId: configuration.data.id,
        ...(runtimeImage === undefined
          ? {}
          : {
              initialWorkspaceFiles: {
                "USER.md": `Initial ${label} user directives\n`,
                "SOUL.md": "",
              },
              workspaceDefaultsId: WORKSPACE_DEFAULTS_ID,
            }),
        executionMode,
        harnessAuth: {
          method: "api_key",
          source: { kind: "secret", namespaceId, id: secret.data.id },
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.error));
      assert.equal(typeof created.data.servicePrincipalId, "string");
      assert.notEqual(created.data.servicePrincipalId.trim(), "");
      if (runtimeImage !== undefined) {
        initialWorkspaceFilesByAgent.set(created.data.id, {
          "USER.md": `Initial ${label} user directives\n`,
          "SOUL.md": "",
        });
        assert.equal(
          JSON.stringify(created.data).includes(`Initial ${label} user directives`),
          false,
        );
      }
      await assertDeployDenied(namespaceId, created.data.id, `${label} before model Secret grant`);
      await grantSecretOperate(namespaceId, created.data.servicePrincipalId, secret.data.id, label);
      if (boundSecret !== undefined) {
        // Isolate missing channel credentials from the model permission denial above.
        const missingConfiguration = await request(
          "PATCH",
          `/namespaces/${namespaceId}/configurations/${configuration.data.id}`,
          { values: missingChannelBindingValues },
        );
        assert.equal(missingConfiguration.status, 200, JSON.stringify(missingConfiguration.error));
        const missingBindings = await request(
          "POST",
          `/namespaces/${namespaceId}/agents/${created.data.id}/deploy`,
        );
        assert.equal(
          missingBindings.status,
          400,
          `${label} before channel Secret bindings: ${JSON.stringify(missingBindings.error)}`,
        );
        assert.equal(missingBindings.error.code, "CHANNEL_CREDENTIAL_BINDING_REQUIRED");
        // This k3d fixture has no runtime.channels proxy and uses the fixture image,
        // so successful deployment proves generic API/IAM/admission/gateway Secret
        // projection. Real Slack channel runtime proof belongs to the real-runtime suite.
        const updated = await request(
          "PATCH",
          `/namespaces/${namespaceId}/configurations/${configuration.data.id}`,
          {
            values: baseValues,
            secretBindings: {
              BOUND_SENTINEL: {
                source: boundSecret.data.ref,
                delivery: { type: "env" },
              },
            },
          },
        );
        assert.equal(updated.status, 200, JSON.stringify(updated.error));
        await assertDeployDenied(
          namespaceId,
          created.data.id,
          `${label} before bound Secret grant`,
        );
        await grantSecretOperate(
          namespaceId,
          created.data.servicePrincipalId,
          boundSecret.data.id,
          `${label} bound`,
        );
      }
      return {
        ...created.data,
        ...(boundSecret === undefined
          ? {}
          : { boundSecretId: boundSecret.data.id, boundSecretValue }),
      };
    }

    async function deploy(namespaceId, agentId) {
      const result = await request("POST", `/namespaces/${namespaceId}/agents/${agentId}/deploy`);
      assert.equal(result.status, 202, JSON.stringify(result.error));
      assert.deepEqual(result.data.compute, {
        id: driver.id,
        implementation: driver.implementation,
      });
      assert.equal(Object.hasOwn(result.data, "servicePrincipalId"), false);
      return result.data;
    }

    async function waitForActive(namespaceId, agentId, revisionId) {
      return waitFor(
        `Agent ${agentId} to activate revision ${revisionId}`,
        async () => {
          const current = await request("GET", `/namespaces/${namespaceId}/agents/${agentId}`);
          assert.equal(current.status, 200);
          return current.data.activeRevisionId === revisionId ? current.data : undefined;
        },
        runtimeImage === undefined ? 120_000 : 240_000,
      );
    }

    const first = await createAgent(namespaceIds[0], "first");
    const second = await createAgent(namespaceIds[0], "second");
    const boundSecretAgent = await createAgent(namespaceIds[0], "bound-secret", {
      boundSecret: true,
    });
    const separateTenant = await createAgent(namespaceIds[1], "separate-tenant");
    const embeddedDelete = await createAgent(namespaceIds[1], "embedded-delete", {
      executionMode: "embedded",
    });
    const adoptedTenant = await createAgent(namespaceIds[2], "adopted-tenant");
    if (runtimeImage !== undefined) {
      const firstCredentialsPath = `/namespaces/${namespaceIds[0]}/agents/${first.id}/runtime-credentials`;
      const beforeDeploy = await request("GET", firstCredentialsPath);
      assert.equal(beforeDeploy.status, 200, JSON.stringify(beforeDeploy.error));
      assert.deepEqual(beforeDeploy.data, { transportConfigured: false });
      for (const [namespaceId, agent] of [
        [namespaceIds[0], second],
        [namespaceIds[0], boundSecretAgent],
        [namespaceIds[1], separateTenant],
        [namespaceIds[1], embeddedDelete],
        [adopted.data.id, adoptedTenant],
      ]) {
        const provisioned = await request(
          "POST",
          `/namespaces/${namespaceId}/agents/${agent.id}/runtime-credentials`,
          {},
        );
        assert.equal(provisioned.status, 200, JSON.stringify(provisioned.error));
        assert.deepEqual(provisioned.data, {
          transportConfigured: true,
        });
      }
    }
    const adoptedCredentialSecrets =
      runtimeImage === undefined
        ? []
        : ["transport"].map((prefix) => `${prefix}-${hash(adoptedTenant.id)}`);
    const embeddedCredentialSecrets =
      runtimeImage === undefined
        ? []
        : ["transport"].map((prefix) => `${prefix}-${hash(embeddedDelete.id)}`);
    for (const name of adoptedCredentialSecrets) {
      await resource("secret", name, existingName);
    }
    for (const name of embeddedCredentialSecrets) {
      await resource("secret", name, placements.get(namespaceIds[1]));
    }
    const admitted = await Promise.all([
      deploy(namespaceIds[0], first.id),
      deploy(namespaceIds[0], second.id),
      deploy(namespaceIds[1], separateTenant.id),
      deploy(namespaceIds[1], embeddedDelete.id),
      deploy(namespaceIds[2], adoptedTenant.id),
      deploy(namespaceIds[0], boundSecretAgent.id),
    ]);
    if (runtimeImage !== undefined) {
      const afterDeploy = await request(
        "GET",
        `/namespaces/${namespaceIds[0]}/agents/${first.id}/runtime-credentials`,
      );
      assert.equal(afterDeploy.status, 200, JSON.stringify(afterDeploy.error));
      assert.deepEqual(afterDeploy.data, { transportConfigured: true });
      await resource(
        "secret",
        `transport-${hash(first.id)}`,
        kubernetesNamespaceName(namespaceIds[0]),
      );
    }

    await Promise.all(
      [
        [namespaceIds[0], first, admitted[0]],
        [namespaceIds[0], second, admitted[1]],
        [namespaceIds[0], boundSecretAgent, admitted[5]],
        [namespaceIds[1], separateTenant, admitted[2]],
        [namespaceIds[1], embeddedDelete, admitted[3], "embedded"],
        [namespaceIds[2], adoptedTenant, admitted[4], "dedicated"],
      ].map(async ([namespaceId, agent, candidate, executionMode = "dedicated"]) => {
        await waitForActive(namespaceId, agent.id, candidate.id);
        const placement = placements.get(namespaceId);
        await assertReadyGateway(placement, agent.id, namespaceId, candidate);
        const imagePath = `/namespaces/${namespaceId}/agents/${agent.id}/runtime-images`;
        const byContainer = (a, b) =>
          `${a.workload}/${a.container}`.localeCompare(`${b.workload}/${b.container}`);
        const podImages = async () =>
          (await resources("pods", placement))
            .filter(
              (pod) =>
                pod.metadata.labels?.["openclaw.dev/agent"] === agent.id &&
                pod.metadata.labels?.["openclaw.dev/revision"] === candidate.id &&
                !pod.metadata.deletionTimestamp,
            )
            .flatMap((pod) =>
              [
                [pod.spec.containers, pod.status.containerStatuses],
                [pod.spec.initContainers, pod.status.initContainerStatuses],
                [pod.spec.ephemeralContainers, pod.status.ephemeralContainerStatuses],
              ].flatMap(([containers = [], statuses = []]) =>
                containers.map((container) => ({
                  workload: `${pod.metadata.namespace}/${pod.metadata.name}`,
                  container: container.name,
                  image: container.image,
                  // Kubernetes reports an unknown image ID as "", which the API returns as null.
                  imageId: statuses.find((state) => state.name === container.name)?.imageID || null,
                })),
              ),
            )
            .sort(byContainer);
        // The read lists live Pods through the Kubernetes API on every call, and its
        // contract reports a failed Kubernetes read as 503 DEPENDENCY_UNAVAILABLE for
        // the caller to retry, so activation cannot make a single read infallible.
        // Pod snapshots taken before and after each read bound what it could see:
        // when they agree the Pods did not change, and the API must match exactly.
        const imagesDeadline = Date.now() + 60_000;
        for (;;) {
          const before = await podImages();
          const imageRead = await request("GET", imagePath);
          const after = await podImages();
          const retry = Date.now() < imagesDeadline;
          if (
            retry &&
            imageRead.status === 503 &&
            imageRead.error?.code === "DEPENDENCY_UNAVAILABLE"
          ) {
            await delay(500);
            continue;
          }
          assert.equal(imageRead.status, 200, JSON.stringify(imageRead.error));
          assert.equal(imageRead.data.status, "observed");
          if (retry && !isDeepStrictEqual(before, after)) {
            await delay(500);
            continue;
          }
          assert.ok(after.length > 0);
          assert.deepEqual(
            imageRead.data.images
              .map(({ commit, openclawCommit, ...identity }) => {
                assert.ok(commit === null || /^[a-f0-9]{40}$/.test(commit));
                assert.ok(openclawCommit === null || /^[a-f0-9]{40}$/.test(openclawCommit));
                return identity;
              })
              .sort(byContainer),
            after,
          );
          break;
        }
        assert.equal((await request("GET", imagePath, undefined, { session: false })).status, 401);
        if (runtimeImage !== undefined) {
          // These bytes came through normal HTTP creation, PostgreSQL and the worker;
          // readiness cannot be reported before native setup and private delivery cleanup.
          await assertInitialWorkspace(
            namespaceId,
            agent.id,
            initialWorkspaceFilesByAgent.get(agent.id),
            candidate,
            executionMode,
          );
        }
        if (executionMode === "dedicated") {
          const deployment = await resource("deployment", revisionName(candidate), placement);
          assert.equal(deployment.spec.template.spec.serviceAccountName, agentName(agent.id));
          if (agent.boundSecretValue !== undefined) {
            assert.deepEqual(Object.keys(candidate.secretBindings), ["BOUND_SENTINEL"]);
            const harnessContainer = deployment.spec.template.spec.containers[0];
            assert.equal(
              harnessContainer.env.some((entry) => entry.name === "BOUND_SENTINEL"),
              false,
              "dedicated Harness must not receive gateway Secret bindings",
            );
            const gatewayDeployment = await resource(
              "deployment",
              gatewayName(agent.id),
              placements.get(namespaceId),
            );
            const gatewayContainer = gatewayDeployment.spec.template.spec.containers[0];
            const projection = gatewayContainer.env.find(
              (entry) => entry.name === "BOUND_SENTINEL",
            );
            assert.equal(projection.valueFrom.secretKeyRef.optional ?? false, false);
            assert.ok(
              projection.valueFrom.secretKeyRef.name,
              "Configuration Secret bindings must render a concrete Kubernetes Secret name",
            );
            const pod = await waitFor(`bound Secret gateway ${agent.id} Pod`, async () =>
              (await resources("pods", placements.get(namespaceId))).find(
                ({ metadata, status }) =>
                  metadata.labels?.["openclaw.dev/workload-role"] === "gateway" &&
                  metadata.labels?.["app.kubernetes.io/name"] === gatewayName(agent.id) &&
                  status.conditions?.some(
                    ({ type, status: conditionStatus }) =>
                      type === "Ready" && conditionStatus === "True",
                  ),
              ),
            );
            const script = `const expected=${JSON.stringify(agent.boundSecretValue)};process.stdout.write(process.env.BOUND_SENTINEL===expected?"matched":"missing")`;
            const observedSecret = await kubectlRead(
              "exec",
              pod.metadata.name,
              "--namespace",
              placements.get(namespaceId),
              "--",
              "node",
              "-e",
              script,
            );
            assert.equal(observedSecret, "matched");
          }
        } else {
          assert.equal(await missing("deployment", revisionName(candidate), placement), true);
          assert.equal(await missing("service", agentName(agent.id), placement), true);
        }
        const storedAgent = await state.read((view) =>
          view.agents.findAgent(namespaceId, agent.id),
        );
        const storedRevision = await state.read((view) =>
          view.revisions.findRevision(namespaceId, agent.id, candidate.id),
        );
        assert.equal(storedAgent.servicePrincipalId, `service-agent-${agent.id}`);
        assert.equal(storedRevision.servicePrincipalId, storedAgent.servicePrincipalId);
        const account = await resource("serviceaccount", agentName(agent.id), placement);
        assert.equal(
          account.metadata.annotations["openclaw.dev/service-principal-id"],
          storedAgent.servicePrincipalId,
        );
        // Fixture mode stages workloads without live routing; the optional real runtime must
        // activate the exact revision and publish one ready Service endpoint.
        if (executionMode === "dedicated") {
          await assertAgentServiceEndpointCount(
            placement,
            agent.id,
            runtimeImage === undefined ? 0 : 1,
            runtimeImage === undefined
              ? "the HTTP fixture Agent Service must remain nonserving"
              : "the exact active revision must become routable",
          );
        }
      }),
    );

    // Use the API-deployed embedded runtime, dedicated Harness, and dedicated Gateway.
    // Reachable CoreDNS listeners outside the peer/port grant distinguish CNI denial from an absent server.
    const dns = await createDnsTrafficFixture(
      context,
      configuration.drivers.compute.configuration.network.dns,
    );
    const dnsSources = await Promise.all([
      workloadPod(
        placements.get(namespaceIds[0]),
        `app.kubernetes.io/name=${revisionName(admitted[0])}`,
      ),
      workloadPod(
        kubernetesNamespaceName(namespaceIds[0]),
        `app.kubernetes.io/name=${gatewayName(first.id)}`,
      ),
      workloadPod(
        placements.get(namespaceIds[1]),
        `app.kubernetes.io/name=${gatewayName(embeddedDelete.id)}`,
      ),
    ]);
    assert.ok(dnsSources.every(Boolean), "all API-deployed DNS source Pods must be running");
    for (const protocol of ["udp", "tcp"]) {
      for (const [target, port] of [
        [dns.selected, 5353],
        [dns.selected, 5354],
        [dns.unselected, 5353],
      ]) {
        assert.equal(
          JSON.parse(await dns.query(dns.control, target, protocol, port)).address,
          "192.0.2.53",
        );
      }
    }
    // A denied UDP query waits out the probe's 2.5 s timeout, so the three source Pods
    // are probed concurrently. Each Pod still runs one probe at a time, in the same order:
    // the allowed control, both denied queries, then the control again.
    for (const protocol of ["udp", "tcp"]) {
      await Promise.all(
        dnsSources.map(async (source) => {
          assert.equal(
            JSON.parse(await dns.query(source, dns.selected, protocol, 5353)).address,
            "192.0.2.53",
            `${source.metadata.name} must resolve over ${protocol} port 5353`,
          );
          for (const [target, port] of [
            [dns.selected, 5354],
            [dns.unselected, 5353],
          ]) {
            await dns.assertQueryDenied(
              `DNS from ${source.metadata.name} to ${target.metadata.name} over ${protocol} port ${port}`,
              source,
              target,
              protocol,
              port,
            );
          }
          assert.equal(
            JSON.parse(await dns.query(source, dns.selected, protocol, 5353)).address,
            "192.0.2.53",
            "the allowed DNS control must still work after denied queries",
          );
        }),
      );
    }

    const deploymentPath = `/namespaces/${namespaceIds[0]}/agents/${first.id}/deployments/${admitted[0].id}`;
    const persistedBefore = await waitFor("first revision deployment to settle", async () => {
      const observed = await request("GET", deploymentPath);
      assert.equal(observed.status, 200, JSON.stringify(observed.error));
      return observed.data.status === "succeeded" ? observed.data : undefined;
    });
    const diagnosticsPath = `${deploymentPath}/diagnostics`;
    const diagnostics = await request("POST", diagnosticsPath);
    assert.equal(diagnostics.status, 200, JSON.stringify(diagnostics.error));
    assert.equal(diagnostics.data.revisionId, admitted[0].id);
    assert.equal(new Date(diagnostics.data.observedAt).toISOString(), diagnostics.data.observedAt);
    assert.ok(diagnostics.data.checks.length <= 32);
    if (runtimeImage === undefined) {
      assert.deepEqual(
        diagnostics.data.checks,
        ["agent", "gateway"].map((component) => ({
          component,
          check: "runtime-status",
          state: "unknown",
          checkedAt: null,
          code: "UNAVAILABLE",
        })),
        "the fixture image cannot provide current runtime checks",
      );
    } else {
      const gatewayConfiguration = diagnostics.data.checks.find(
        ({ component, check }) => component === "gateway" && check === "configuration",
      );
      assert.ok(gatewayConfiguration, "the real Gateway must answer its native Slack check");
      assert.equal(
        new Date(gatewayConfiguration.checkedAt).toISOString(),
        gatewayConfiguration.checkedAt,
      );
    }
    assert.equal(
      (await request("POST", diagnosticsPath, undefined, { session: false })).status,
      401,
    );
    const persistedAfter = await request("GET", deploymentPath);
    assert.equal(persistedAfter.status, 200, JSON.stringify(persistedAfter.error));
    assert.deepEqual(persistedAfter.data, persistedBefore);

    // Runtime status and container logs for the same exact revision, read through the
    // regular API with the Installation's Kubernetes credentials. Only Pods carrying
    // this Agent's and revision's labels are listed and read.
    const runtimePath = `${deploymentPath}/runtime`;
    const runningGateway = (observed) => {
      const source = observed.data?.sources.find(({ id }) => id === "gateway");
      return source?.pods.find(({ uid }) =>
        observed.data.pods.some(
          (pod) =>
            pod.uid === uid &&
            pod.containers.some(({ name, state }) => name === "gateway" && state === "running"),
        ),
      );
    };
    const gatewayPod = await waitFor("a running Gateway container in runtime status", async () => {
      const observed = await request("GET", runtimePath);
      return observed.status === 200 ? runningGateway(observed) : undefined;
    });
    const runtimeStatus = await request("GET", runtimePath);
    assert.equal(runtimeStatus.data.revisionId, admitted[0].id);
    assert.ok(runtimeStatus.data.pods.every(({ name }) => name.length > 0));
    const logsPath = `${runtimePath}/logs?source=gateway&tailLines=100`;
    const firstPage = await request("GET", logsPath);
    assert.equal(firstPage.status, 200, JSON.stringify(firstPage.error));
    assert.equal(firstPage.data.stream.pod, gatewayPod.name);
    assert.equal(typeof firstPage.data.cursor, "string");
    assert.ok(
      firstPage.data.records.every(
        (record) => record.type !== "line" || record.contentClass === "operational",
      ),
    );
    const followPage = await request(
      "GET",
      `${runtimePath}/logs?source=gateway&cursor=${encodeURIComponent(firstPage.data.cursor)}`,
    );
    assert.equal(followPage.status, 200, JSON.stringify(followPage.error));
    // One audited view for the first page; the cursor poll is not re-audited.
    const views = await observerPool.query(
      `SELECT count(*)::integer AS count FROM occ.audit_events
       WHERE action = 'openclaw.agents.runtime_logs.view' AND resource_id = $1`,
      [first.id],
    );
    assert.equal(views.rows[0].count, 1);
    // Replacing the Pod ends the cursor's instance; the next poll labels it.
    const gatewayNamespace = JSON.parse(
      await kubectl(
        "get",
        "pods",
        "--all-namespaces",
        "-l",
        `openclaw.dev/revision=${admitted[0].id},openclaw.dev/workload-role=gateway`,
        "-o",
        "json",
      ),
    ).items.find(({ metadata }) => metadata.uid === gatewayPod.uid).metadata.namespace;
    await kubectl("delete", "pod", gatewayPod.name, "-n", gatewayNamespace, "--wait=false");
    const replacementGateway = await waitFor(
      "a replacement Gateway Pod in runtime status",
      async () => {
        const observed = await request("GET", runtimePath);
        const pod = observed.status === 200 ? runningGateway(observed) : undefined;
        return pod !== undefined && pod.uid !== gatewayPod.uid ? pod : undefined;
      },
      180_000,
    );
    const replaced = await request(
      "GET",
      `${runtimePath}/logs?source=gateway&cursor=${encodeURIComponent(followPage.data.cursor)}`,
    );
    assert.equal(replaced.status, 200, JSON.stringify(replaced.error));
    assert.equal(replaced.data.records[0].type, "gap");
    assert.equal(replaced.data.records[0].reason, "stream_replaced");
    assert.equal(replaced.data.stream.pod, replacementGateway.name);
    const previousInstance = await request(
      "GET",
      `${runtimePath}/logs?source=gateway&pod=${replacementGateway.name}&previous=true`,
    );
    assert.equal(previousInstance.status, 200, JSON.stringify(previousInstance.error));
    assert.equal((await request("GET", runtimePath, undefined, { session: false })).status, 401);

    if (runtimeImage !== undefined) {
      const gatewayTarget = kubernetesNamespaceName(namespaceIds[0]);
      const dataTarget = placements.get(namespaceIds[0]);
      const firstGateway = await resource("deployment", gatewayName(first.id), gatewayTarget);
      assert.equal(firstGateway.spec.template.spec.automountServiceAccountToken, false);
      const env = firstGateway.spec.template.spec.containers[0].env;
      const transportUrl = env.find(({ name }) => name === "APP_SERVER_URL").value;
      assert.equal(new URL(transportUrl).hostname, `${agentName(first.id)}.${dataTarget}.svc`);
      const gatewayConnectArguments = (target) => [
        "exec",
        `deployment/${gatewayName(first.id)}`,
        "--namespace",
        gatewayTarget,
        "-c",
        "gateway",
        "--",
        ...inlineProbeCommand(probeSource, "tcp", target, 18790),
      ];
      await kubectlRead(...gatewayConnectArguments(new URL(transportUrl).hostname));
      // Finding 335: only the probe's own refused or unanswered connection is a
      // denial, never a DNS error or a dropped exec stream.
      for (const [description, forbidden] of [
        ["same-tenant gateway-to-Agent traffic", `${agentName(second.id)}.${dataTarget}.svc`],
        [
          "cross-tenant gateway-to-Agent traffic",
          `${agentName(separateTenant.id)}.${placements.get(namespaceIds[1])}.svc`,
        ],
      ]) {
        await assertExecDenied(description, gatewayConnectArguments(forbidden));
      }
    }

    async function ownedComputeResources(namespaceName, agentId, namespaceId, _dedicated = false) {
      const kinds = [
        ["deployment", "deployments"],
        ["service", "services"],
        ["serviceaccount", "serviceaccounts"],
        ["configmap", "configmaps"],
        ["networkpolicy", "networkpolicies"],
        ["persistentvolumeclaim", "persistentvolumeclaims"],
        ["secret", "secrets"],
      ];
      const owned = [];
      for (const target of [namespaceName]) {
        for (const [kind, plural] of kinds) {
          for (const object of await resources(plural, target)) {
            if (object.metadata.labels?.["openclaw.dev/agent"] === agentId) {
              owned.push({ kind, name: object.metadata.name, namespace: target });
            }
          }
        }
      }
      return owned;
    }

    const embeddedPlacement = placements.get(namespaceIds[1]);
    const embeddedOwned = await ownedComputeResources(embeddedPlacement, embeddedDelete.id);
    assert.ok(
      embeddedOwned.some(
        ({ kind, name }) => kind === "deployment" && name === gatewayName(embeddedDelete.id),
      ),
    );
    if (runtimeImage !== undefined) {
      assert.ok(embeddedOwned.some(({ kind }) => kind === "networkpolicy"));
      assert.ok(embeddedOwned.some(({ kind }) => kind === "persistentvolumeclaim"));
    }
    assert.ok(
      embeddedOwned.some(
        ({ kind, name }) => kind === "serviceaccount" && name === agentName(embeddedDelete.id),
      ),
    );
    assert.ok(
      embeddedOwned.some(
        ({ kind, name }) =>
          kind === "configmap" &&
          name === `gateway-${hash(embeddedDelete.id)}-rev-${hash(admitted[3].id)}`,
      ),
    );

    // Editing the draft mode does not move the deployed revision or its private storage.
    const updatedEmbedded = await request(
      "PATCH",
      `/namespaces/${namespaceIds[1]}/agents/${embeddedDelete.id}`,
      { configurationId: embeddedDelete.configurationId, executionMode: "dedicated" },
    );
    assert.equal(updatedEmbedded.status, 200, JSON.stringify(updatedEmbedded.error));
    // Deleting an active embedded Agent must not finalize until its gateway Pod is gone.
    const deletingEmbedded = await request(
      "DELETE",
      `/namespaces/${namespaceIds[1]}/agents/${embeddedDelete.id}`,
    );
    assert.equal(deletingEmbedded.status, 202, JSON.stringify(deletingEmbedded.error));
    await waitFor("running embedded Agent deletion to finalize after Pod termination", async () => {
      const current = await request(
        "GET",
        `/namespaces/${namespaceIds[1]}/agents/${embeddedDelete.id}`,
      );
      const ownedPods = (await resources("pods", embeddedPlacement)).filter(
        ({ metadata }) => metadata.labels?.["openclaw.dev/agent"] === embeddedDelete.id,
      );
      return current.status === 404 && ownedPods.length === 0 ? true : undefined;
    });
    for (const { kind, name } of embeddedOwned) {
      assert.equal(await missing(kind, name, embeddedPlacement), true, `${kind} ${name} remains`);
    }
    for (const name of embeddedCredentialSecrets) {
      assert.equal(await missing("secret", name, embeddedPlacement), true);
    }
    await assertReadyGateway(embeddedPlacement, separateTenant.id, namespaceIds[1]);
    const adoptedWorkspace = await assertHarnessWorkspaceClaim(
      existingName,
      adopted.data.id,
      adoptedTenant.id,
    );
    await resource(
      "configmap",
      kubernetesConfigurationName(adoptedTenant.configurationId),
      existingName,
    );

    const retainedFile = `stop-state-${randomUUID()}.txt`;
    const retainedValue = `retained-${randomUUID()}`;
    const adoptedRevisionPod = await waitFor(
      "adopted Agent revision Pod to become ready",
      async () =>
        (await resources("pods", existingName)).find(
          ({ metadata, status }) =>
            metadata.labels?.["openclaw.dev/agent"] === adoptedTenant.id &&
            metadata.labels?.["openclaw.dev/revision"] === admitted[4].id &&
            status.conditions?.some(
              ({ type, status: conditionStatus }) => type === "Ready" && conditionStatus === "True",
            ),
        ),
    );
    await kubectl(
      "exec",
      adoptedRevisionPod.metadata.name,
      "--namespace",
      existingName,
      "--",
      "node",
      "-e",
      `require('node:fs').writeFileSync('/home/node/workspace/${retainedFile}', ${JSON.stringify(retainedValue)})`,
    );
    const editedWorkspaceFiles = {
      "USER.md": "User edit retained across stop and redeploy\n",
      "SOUL.md": "",
    };
    if (runtimeImage !== undefined) {
      // A real edit to the live durable files must survive a later admitted revision.
      await kubectl(
        "exec",
        `deployment/${revisionName(admitted[4])}`,
        "--namespace",
        existingName,
        "-c",
        "agent",
        "--",
        "node",
        "-e",
        `require('node:fs').writeFileSync('/home/node/workspace/USER.md', ${JSON.stringify(editedWorkspaceFiles["USER.md"])})`,
      );
    }
    const stopped = await request(
      "POST",
      `/namespaces/${adopted.data.id}/agents/${adoptedTenant.id}/stop`,
    );
    assert.equal(stopped.status, 202, JSON.stringify(stopped.error));
    assert.equal(stopped.data.desiredRuntimeState, "stopped");
    await waitFor("the stopped Agent pointer and real runtime to be cleared", async () => {
      const current = await request(
        "GET",
        `/namespaces/${adopted.data.id}/agents/${adoptedTenant.id}`,
      );
      assert.equal(current.status, 200);
      if (current.data.activeRevisionId !== undefined) {
        return undefined;
      }
      if (!(await missing("deployment", revisionName(admitted[4]), existingName))) {
        return undefined;
      }
      if (!(await missing("deployment", gatewayName(adoptedTenant.id), existingName))) {
        return undefined;
      }
      const ownedPods = (
        await Promise.all([existingName].map((target) => resources("pods", target)))
      )
        .flat()
        .filter(({ metadata }) => metadata.labels?.["openclaw.dev/agent"] === adoptedTenant.id);
      return ownedPods.length === 0 ? current.data : undefined;
    });
    assert.equal(
      (await resource("persistentvolumeclaim", adoptedWorkspace.metadata.name, existingName))
        .metadata.uid,
      adoptedWorkspace.metadata.uid,
      "API stop must retain the exact Agent workspace claim",
    );
    assert.equal(
      (
        await state.read((view) =>
          view.revisions.findRevision(adopted.data.id, adoptedTenant.id, admitted[4].id),
        )
      ).id,
      admitted[4].id,
      "API stop must retain immutable revision history",
    );

    const restarted = await deploy(adopted.data.id, adoptedTenant.id);
    assert.notEqual(restarted.id, admitted[4].id);
    await waitForActive(adopted.data.id, adoptedTenant.id, restarted.id);
    await assertReadyGateway(existingName, adoptedTenant.id, adopted.data.id, restarted);
    if (runtimeImage !== undefined) {
      await assertInitialWorkspace(
        adopted.data.id,
        adoptedTenant.id,
        editedWorkspaceFiles,
        restarted,
      );
    }
    const restartedPod = await waitFor("redeployed Agent revision Pod to become ready", async () =>
      (await resources("pods", existingName)).find(
        ({ metadata, status }) =>
          metadata.labels?.["openclaw.dev/agent"] === adoptedTenant.id &&
          metadata.labels?.["openclaw.dev/revision"] === restarted.id &&
          status.conditions?.some(
            ({ type, status: conditionStatus }) => type === "Ready" && conditionStatus === "True",
          ),
      ),
    );
    assert.equal(
      await kubectlRead(
        "exec",
        restartedPod.metadata.name,
        "--namespace",
        existingName,
        "--",
        "node",
        "-e",
        `process.stdout.write(require('node:fs').readFileSync('/home/node/workspace/${retainedFile}', 'utf8'))`,
      ),
      retainedValue,
      "redeployment must mount the exact persistent data retained by stop",
    );
    assert.equal(
      (await assertHarnessWorkspaceClaim(existingName, adopted.data.id, adoptedTenant.id)).metadata
        .uid,
      adoptedWorkspace.metadata.uid,
    );

    await worker.stop();
    worker = undefined;
    workerPool = undefined;
    const replacementPlacement = kubernetesNamespaceName(namespaceIds[0]);
    // A controller upgrade leaves ready Namespaces and their old DNS grants in place.
    // Preparing one replacement must add backend ports without narrowing access for other Agents.
    const readyNamespace = await request("GET", `/namespaces/${namespaceIds[0]}`);
    assert.equal(readyNamespace.data.status, "ready");
    const legacyDnsPolicies = [];
    for (const target of [replacementPlacement]) {
      await kubectl(
        "patch",
        "networkpolicy",
        "allow-dns",
        "-n",
        target,
        "--type=json",
        "-p",
        JSON.stringify([
          { op: "replace", path: "/spec/podSelector", value: {} },
          {
            op: "replace",
            path: "/spec/egress/0/ports",
            value: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
            ],
          },
        ]),
      );
      legacyDnsPolicies.push(await resource("networkpolicy", "allow-dns", target));
    }
    const otherAgentPods = (await resources("pods", replacementPlacement))
      .filter(({ metadata }) => metadata.labels?.["openclaw.dev/agent"] === second.id)
      .map(({ metadata }) => metadata.uid)
      .sort();
    const replacementClaim = await assertHarnessWorkspaceClaim(
      replacementPlacement,
      namespaceIds[0],
      first.id,
    );
    await kubectl(
      "exec",
      `deployment/${revisionName(admitted[0])}`,
      "-n",
      replacementPlacement,
      "-c",
      "agent",
      "--",
      "node",
      "-e",
      "require('node:fs').writeFileSync('/home/node/workspace/replacement-proof.txt', 'retain across replacement')",
    );
    const replacement = await deploy(namespaceIds[0], first.id);
    await startWorker();
    await waitForActive(namespaceIds[0], first.id, replacement.id);
    for (const previous of legacyDnsPolicies) {
      const current = await resource("networkpolicy", "allow-dns", previous.metadata.namespace);
      const expected = structuredClone(previous.spec);
      expected.egress[0].ports.push(
        { protocol: "UDP", port: 5353 },
        { protocol: "TCP", port: 5353 },
      );
      assert.equal(current.metadata.uid, previous.metadata.uid);
      assert.deepEqual(
        current.spec,
        expected,
        "DNS upgrade must preserve the old selectors and other rules",
      );
    }
    assert.deepEqual(
      (await resources("pods", replacementPlacement))
        .filter(({ metadata }) => metadata.labels?.["openclaw.dev/agent"] === second.id)
        .map(({ metadata }) => metadata.uid)
        .sort(),
      otherAgentPods,
      "preparing one Agent must not restart another Agent's Pods",
    );
    const placement = kubernetesNamespaceName(namespaceIds[0]);
    await waitFor(`old revision deployment ${revisionName(admitted[0])} to be deleted`, () =>
      missing("deployment", revisionName(admitted[0]), placement),
    );
    await resource("deployment", revisionName(replacement), placement);
    await assertHarnessWorkspaceClaim(
      placement,
      namespaceIds[0],
      first.id,
      replacementClaim.metadata.uid,
    );
    assert.equal(
      await kubectlRead(
        "exec",
        `deployment/${revisionName(replacement)}`,
        "-n",
        placement,
        "-c",
        "agent",
        "--",
        "node",
        "-e",
        "process.stdout.write(require('node:fs').readFileSync('/home/node/workspace/replacement-proof.txt', 'utf8'))",
      ),
      "retain across replacement",
    );
    await resource("deployment", revisionName(admitted[1]), placement);
    await resource("deployment", revisionName(admitted[5]), placement);
    await resource("serviceaccount", agentName(first.id), placement);
    await assertReadyGateway(placement, first.id, namespaceIds[0]);
    await assertReadyGateway(placement, second.id, namespaceIds[0]);
    await assertReadyGateway(placement, boundSecretAgent.id, namespaceIds[0]);
    assert.equal(
      (await resources("deployments", kubernetesNamespaceName(namespaceIds[0]))).filter(
        ({ spec }) => spec.template.metadata.labels?.["openclaw.dev/workload-role"] === "gateway",
      ).length,
      3,
      "worker restart and replacement revisions must preserve one gateway for each running Agent",
    );

    if (runtimeImage === undefined) {
      // Block the fixture's native readiness using the retained workspace, then
      // prove a failed candidate and recovery both keep the same volume and data.
      await worker.stop();
      worker = undefined;
      workerPool = undefined;
      await kubectl(
        "exec",
        `deployment/${revisionName(replacement)}`,
        "-n",
        placement,
        "-c",
        "agent",
        "--",
        "node",
        "-e",
        "require('node:fs').writeFileSync('/home/node/workspace/.fixture-unready', 'blocked')",
      );
      const failed = await deploy(namespaceIds[0], first.id);
      await startWorker({ convergenceTimeoutMs: 20_000 });
      const failedWork = await waitFor(
        "replacement to fail native readiness",
        async () => {
          const work = await observerPool.query(
            "SELECT state, reason_code FROM occ.controller_work WHERE idempotency_key = $1",
            [`agent_revision:${failed.id}:reconcile`],
          );
          return work.rows[0]?.state === "failed_permanent" ? work.rows[0] : undefined;
        },
        60_000,
      );
      assert.equal(failedWork.reason_code, "CONVERGENCE_DEADLINE_EXCEEDED");
      assert.equal(await missing("deployment", revisionName(replacement), placement), true);
      await assertHarnessWorkspaceClaim(
        placement,
        namespaceIds[0],
        first.id,
        replacementClaim.metadata.uid,
      );
      await kubectl(
        "exec",
        `deployment/${revisionName(failed)}`,
        "-n",
        placement,
        "-c",
        "agent",
        "--",
        "node",
        "-e",
        "const fs=require('node:fs'); fs.writeFileSync('/home/node/workspace/failed-candidate.txt', 'preserved'); fs.unlinkSync('/home/node/workspace/.fixture-unready')",
      );
      const recovered = await deploy(namespaceIds[0], first.id);
      await waitForActive(namespaceIds[0], first.id, recovered.id);
      await waitFor("failed candidate to release its workspace", () =>
        missing("deployment", revisionName(failed), placement),
      );
      await assertHarnessWorkspaceClaim(
        placement,
        namespaceIds[0],
        first.id,
        replacementClaim.metadata.uid,
      );
      assert.equal(
        await kubectlRead(
          "exec",
          `deployment/${revisionName(recovered)}`,
          "-n",
          placement,
          "-c",
          "agent",
          "--",
          "node",
          "-e",
          "const fs=require('node:fs'); process.stdout.write(fs.readFileSync('/home/node/workspace/replacement-proof.txt', 'utf8') + ':' + fs.readFileSync('/home/node/workspace/failed-candidate.txt', 'utf8'))",
        ),
        "retain across replacement:preserved",
      );
    }

    const adoptedOwned = await ownedComputeResources(
      existingName,
      adoptedTenant.id,
      adopted.data.id,
      true,
    );
    assert.ok(
      adoptedOwned.some(
        ({ kind, name }) =>
          kind === "configmap" &&
          name === `gateway-${hash(adoptedTenant.id)}-rev-${hash(restarted.id)}`,
      ),
    );
    if (runtimeImage !== undefined) {
      assert.ok(adoptedOwned.some(({ kind }) => kind === "networkpolicy"));
      assert.ok(adoptedOwned.some(({ kind }) => kind === "persistentvolumeclaim"));
    }
    assert.ok(
      adoptedOwned.some(
        ({ kind, name }) =>
          kind === "configmap" &&
          name === `plugin-runtime-${hash(adoptedTenant.id)}-rev-${hash(restarted.id)}`,
      ),
    );

    const updatedDedicated = await request(
      "PATCH",
      `/namespaces/${adopted.data.id}/agents/${adoptedTenant.id}`,
      { configurationId: adoptedTenant.configurationId, executionMode: "embedded" },
    );
    assert.equal(updatedDedicated.status, 200, JSON.stringify(updatedDedicated.error));
    // Public deletion of an active dedicated Agent must remove persisted ownership only after
    // every real Agent-owned Kubernetes effect, including its live Pods, has been removed.
    const deleting = await request(
      "DELETE",
      `/namespaces/${adopted.data.id}/agents/${adoptedTenant.id}`,
    );
    assert.equal(deleting.status, 202, JSON.stringify(deleting.error));
    assert.equal(deleting.data.status, "deleting");
    await waitFor(
      "running dedicated Agent deletion to finalize after Pod termination",
      async () => {
        const current = await request(
          "GET",
          `/namespaces/${adopted.data.id}/agents/${adoptedTenant.id}`,
        );
        const ownedPods = (
          await Promise.all([existingName].map((target) => resources("pods", target)))
        )
          .flat()
          .filter(({ metadata }) => metadata.labels?.["openclaw.dev/agent"] === adoptedTenant.id);
        return current.status === 404 && ownedPods.length === 0 ? true : undefined;
      },
    );
    for (const name of adoptedCredentialSecrets) {
      assert.equal(await missing("secret", name, existingName), true);
    }
    const deletedClaims = [adoptedWorkspace.metadata.name];
    if (runtimeImage !== undefined) {
      deletedClaims.push(`gateway-state-${hash(adoptedTenant.id)}`);
    }
    for (const name of deletedClaims) {
      assert.equal(await missing("persistentvolumeclaim", name, existingName), true);
    }
    assert.equal(await missing("deployment", gatewayName(adoptedTenant.id), existingName), true);
    assert.equal(await missing("service", gatewayName(adoptedTenant.id), existingName), true);
    assert.equal(await missing("service", agentName(adoptedTenant.id), existingName), true);
    assert.equal(await missing("serviceaccount", agentName(adoptedTenant.id), existingName), true);
    for (const { kind, name, namespace: target } of adoptedOwned) {
      assert.equal(await missing(kind, name, target), true, `${kind} ${name} remains`);
    }
    assert.equal(
      await state.read((view) =>
        view.revisions.findRevision(adopted.data.id, adoptedTenant.id, restarted.id),
      ),
      undefined,
    );
    await resource(
      "configmap",
      kubernetesConfigurationName(adoptedTenant.configurationId),
      existingName,
    );
    await resource("namespace", existingName);
    await assertReadyGateway(placement, second.id, namespaceIds[0]);
  },
);
