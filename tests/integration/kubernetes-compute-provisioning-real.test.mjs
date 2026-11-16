import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayNodeEnrollment } from "../../apps/controller/src/gateway/node-enrollment-client.ts";
import {
  requiresKubernetes,
  requiresKubernetesAndPostgres,
  hash,
  kubectl,
  resource,
  resources,
  missing,
  waitFor,
  assertKubernetesFixtureAvailable,
  namespace,
  provisionFixtureAuth,
  revisionContext,
  revision,
  gatewayName,
  revisionName,
  assertReadyGateway,
  assertHarnessWorkspaceClaim,
  createDriver,
  createScopedController,
  deleteNamespaces,
} from "../helpers/kubernetes-compute-real.mjs";
import { createProvisioningContext } from "../helpers/kubernetes-provisioning-api.ts";
import { runProvisioningApiCase } from "./kubernetes-compute-provisioning-api-case.ts";

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

    // The reason is what the worker logs for the refusal (D521).
    async function assertPermanentlyRejected(reason, tenant = owner) {
      assert.deepEqual(await driver.ensureNamespace(tenant), {
        namespaceId: tenant.id,
        namespaceReady: false,
        failure: "permanent",
        reason,
      });
    }

    // Explicit selection never creates the requested namespace or silently falls back to a new one.
    const missingOwner = {
      ...namespace("missing-existing"),
      id: `ns_${randomUUID()}`,
      status: "provisioning",
      existingNamespace: `oce-missing-${hash(randomUUID())}`,
    };
    await assertPermanentlyRejected(
      `Existing Kubernetes namespace ${missingOwner.existingNamespace} does not exist.`,
      missingOwner,
    );
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
    // A foreign marker is named by its key only, never by its value (another tenant's ID).
    const foreignMarker = (key, kind) =>
      `Existing Kubernetes namespace ${existingName} belongs to another tenant: its ${key} ${kind} names a different Namespace.`;
    for (const [operation, key, rejectedValue, restoredValue, reason] of [
      [
        "label",
        "openclaw.dev/namespace",
        randomUUID(),
        undefined,
        foreignMarker("openclaw.dev/namespace", "label"),
      ],
      [
        "label",
        "openclaw.dev/gateway-namespace",
        randomUUID(),
        undefined,
        foreignMarker("openclaw.dev/gateway-namespace", "label"),
      ],
      [
        "annotate",
        "openclaw.dev/namespace-id",
        `ns_${randomUUID()}`,
        undefined,
        foreignMarker("openclaw.dev/namespace-id", "annotation"),
      ],
      [
        "annotate",
        "openclaw.dev/namespace-lifecycle",
        undefined,
        "external",
        `Existing Kubernetes namespace ${existingName} requires external ownership.`,
      ],
      [
        "label",
        "pod-security.kubernetes.io/enforce",
        "baseline",
        "restricted",
        `Existing Kubernetes namespace ${existingName} requires restricted Pod Security.`,
      ],
    ]) {
      await kubectl(
        operation,
        "namespace",
        existingName,
        rejectedValue === undefined ? `${key}-` : `${key}=${rejectedValue}`,
        "--overwrite",
      );
      const rejectedNamespace = await resource("namespace", existingName);
      await assertPermanentlyRejected(reason);
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
    await assertPermanentlyRejected(
      `Another Kubernetes namespace already claims tenant ${owner.id}.`,
    );
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
    await assertPermanentlyRejected(
      `The existing Kubernetes namespace ${existingName} has a NetworkPolicy that this Namespace does not own.`,
    );
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
    // Human ingress is external; this real Compute lifecycle proves the Gateway
    // receives distinct identity grants, not just that OCC stores their input.
    const gatewayAuth = {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-occ-identity",
        allowUsers: ["occ-workspace-files", "oidc:member-01"],
      },
      identityScopes: {
        "occ-workspace-files": ["operator.admin"],
        "oidc:member-01": ["operator.read", "operator.write"],
      },
    };
    candidate.configuration.gateway.auth = gatewayAuth;
    await waitFor("discovered Agent gateway and immutable revision to become ready", async () => {
      const observation = await driver.prepareRevision(candidate, revisionContext(candidate));
      assert.equal(observation.namespaceId, owner.id);
      return observation.ready ? observation : undefined;
    });
    const gateway = await assertReadyGateway(existingName, agentId, owner.id, candidate);
    const gatewayConfiguration = await resource(
      "configmap",
      `gateway-${hash(agentId)}-rev-${hash(candidate.id)}`,
      existingName,
    );
    // Admitting a human makes the Gateway require the proxy's scope header (finding 2183).
    assert.deepEqual(JSON.parse(gatewayConfiguration.data["openclaw.json"]).gateway.auth, {
      ...gatewayAuth,
      trustedProxy: { ...gatewayAuth.trustedProxy, requiredHeaders: ["x-openclaw-scopes"] },
    });
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
    // A Configuration whose OCC transaction failed after its ConfigMap create applied (finding
    // 1400): the Driver's own ownership metadata, no record, and teardown removes it.
    const orphanedConfiguration = {
      ...configuration,
      id: `cfg_${randomUUID()}`,
      namespaceId: cleanupOwner.id,
    };
    await configurationDriver.create(orphanedConfiguration);
    const orphanedConfigMap = kubernetesConfigurationName(orphanedConfiguration.id);
    await resource("configmap", orphanedConfigMap, cleanupName);

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
    assert.equal(await missing("configmap", orphanedConfigMap, cleanupName), true);
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
  "provisioning API retains the first deployment outcome with real Kubernetes fixture storage",
  { ...requiresKubernetesAndPostgres, timeout: 360_000 },
  async (t) => {
    const context = createProvisioningContext(t);
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
          gatewayStorageSizeGiB: 1024,
          // The provisioned Agent enables Slack, which needs the Installation's channel runtime.
          proxy: { proxyUrl: "http://10.42.0.15:3128" },
          gatewayNodeSelector: {
            "kubernetes.io/hostname": JSON.parse(await kubectl("get", "nodes", "-o", "json"))
              .items[0].metadata.name,
          },
        },
      },
      { nodeEnrollment },
    );
    await runProvisioningApiCase(context, {
      driver,
      kubernetesNamespaceName,
      controller,
      platformNamespace,
    });
  },
);
