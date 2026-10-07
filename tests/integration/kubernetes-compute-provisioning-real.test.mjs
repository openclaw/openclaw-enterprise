import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { kubernetesConfigurationName } from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
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
  provisioningRequestBody,
  createProvisioningApiFixture,
  assertKubernetesFixtureAvailable,
  namespace,
  provisionFixtureAuth,
  revisionContext,
  revision,
  gatewayName,
  harnessWorkspaceClaimName,
  revisionName,
  assertReadyGateway,
  assertHarnessWorkspaceClaim,
  createDriver,
  createScopedController,
  createNamespaceReaper,
} from "../helpers/kubernetes-compute-real.mjs";

const { deleteNamespaces, waitForDeletedVolumes } = createNamespaceReaper();
after(waitForDeletedVolumes);

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
