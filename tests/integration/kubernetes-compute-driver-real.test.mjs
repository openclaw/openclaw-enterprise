import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fixtureImage,
  requiresKubernetes,
  kubernetesGatewayNamespaceName,
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
  agentName,
  gatewayName,
  harnessWorkspaceClaimName,
  revisionName,
  assertReadyGateway,
  assertHarnessWorkspaceClaim,
  assertAgentServiceEndpointCount,
  createDriver,
  workloadPod,
  probe,
  assertDeniedTraffic,
  assertExplicitNetworkProfile,
  authorized,
  createScopedController,
} from "../helpers/kubernetes-compute-real.mjs";

test(
  "real Kubernetes Compute Driver owns isolated Agent gateways, identities, revisions, and deletion",
  { ...requiresKubernetes, timeout: 300_000 },
  async (context) => {
    await assertKubernetesFixtureAvailable();
    const installationId = `ins_${randomUUID()}`;
    const platformNamespace = `oce-platform-${hash(installationId)}`;
    await kubectl("create", "namespace", platformNamespace);
    context.after(async () => {
      // Start deletion without waiting: the owned namespaces' cleanup below waits
      // for its own deletions, and nothing reads the platform namespace again.
      await kubectl(
        "delete",
        "namespace",
        platformNamespace,
        "--ignore-not-found=true",
        "--wait=false",
      );
    });
    const controller = await createScopedController(context, installationId, platformNamespace);
    const platformPeer = {
      namespace: platformNamespace,
      podLabels: { "app.kubernetes.io/name": "platform-probe" },
    };
    await kubectl(
      "run",
      "platform-probe",
      "--namespace",
      platformNamespace,
      `--image=${fixtureImage}`,
      "--image-pull-policy=IfNotPresent",
      "--restart=Never",
      "--labels=app.kubernetes.io/name=platform-probe",
    );
    await kubectl(
      "wait",
      "--namespace",
      platformNamespace,
      "--for=condition=Ready",
      "pod/platform-probe",
      "--timeout=120s",
    );

    const { driver, kubernetesNamespaceName } = await createDriver({
      authentication: controller.authentication,
      network: {
        dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
        gatewayPort: 8080,
        gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
        gatewayClients: [platformPeer],
      },
    });
    assert.equal(driver.id, "compute-kubernetes-local");
    assert.equal(driver.implementation, "kubernetes-local");
    // The production preflight must observe the real API server through the same scoped identity
    // used for Namespace lifecycle without reporting the CI-supported 1.35 family as advisory.
    assert.deepEqual(await driver.preflight(), { warnings: [] });

    const first = namespace("first");
    const second = namespace("second");
    const empty = namespace("empty");
    const foreign = namespace("foreign");
    const owned = [first, second, empty].map(({ id }) => kubernetesNamespaceName(id));
    const gatewayTargets = [first, second, empty].map(({ id }) =>
      kubernetesGatewayNamespaceName(id),
    );
    const foreignName = kubernetesNamespaceName(foreign.id);
    context.after(async () => {
      await Promise.all(
        [...owned, ...gatewayTargets, foreignName].map((name) =>
          kubectl("delete", "namespace", name, "--ignore-not-found=true", "--wait=true"),
        ),
      );
    });

    assert.notEqual(owned[0], owned[1], "tenant IDs must map to distinct Kubernetes namespaces");
    for (const owner of [first, second, empty]) {
      const pending = await driver.ensureNamespace(owner);
      // A Namespace cannot be ready until its exact tenant-scoped RBAC admits backing resources.
      assert.equal(pending.namespaceReady, false);
      assert.equal(
        Object.hasOwn(pending, "failure"),
        false,
        "an expected operator-owned tenant RoleBinding must remain pending rather than fail permanently",
      );
      assert.equal(Object.hasOwn(pending, "gatewayReady"), false);
      await kubectl(
        "create",
        "rolebinding",
        "openclaw-controller",
        "--namespace",
        kubernetesNamespaceName(owner.id),
        `--clusterrole=${controller.tenantRole}`,
        `--serviceaccount=${platformNamespace}:${controller.account}`,
      );
      assert.equal((await driver.ensureNamespace(owner)).namespaceReady, false);
      await kubectl(
        "create",
        "rolebinding",
        "openclaw-controller",
        "--namespace",
        kubernetesGatewayNamespaceName(owner.id),
        `--clusterrole=${controller.tenantRole}`,
        `--serviceaccount=${platformNamespace}:${controller.account}`,
      );
    }
    await Promise.all(
      [first, second, empty].map((owner) =>
        waitFor(`Namespace ${owner.id} backing infrastructure to become ready`, async () => {
          const observation = await driver.ensureNamespace(owner);
          assert.equal(observation.namespaceId, owner.id);
          assert.notEqual(observation.failure, "permanent");
          return observation.namespaceReady ? observation : undefined;
        }),
      ),
    );

    for (const [index, owner] of [first, second].entries()) {
      const name = owned[index];
      const backing = await resource("namespace", name);
      assert.equal(backing.status.phase, "Active");
      assert.equal(backing.metadata.labels["app.kubernetes.io/managed-by"], "openclaw-enterprise");
      assert.equal(backing.metadata.labels["openclaw.dev/namespace"], owner.id);
      for (const mode of ["enforce", "audit", "warn"]) {
        assert.equal(backing.metadata.labels[`pod-security.kubernetes.io/${mode}`], "restricted");
      }

      const policyNames = (await resources("networkpolicies", name))
        .map(({ metadata }) => metadata.name)
        .sort();
      assert.deepEqual(policyNames, ["allow-dns", "allow-gateway-ingress", "default-deny"]);
      await resource("resourcequota", "openclaw-quota", name);
      await resource("limitrange", "openclaw-limits", name);
      await driver.ensureNamespace(owner);
      assert.equal(
        (await resources("deployments", name)).length,
        0,
        "Namespace preparation must not create a gateway before an Agent is deployed",
      );
    }

    await Promise.all([first, second].map(provisionFixtureAuth));

    const primaryAgent = `agt_${randomUUID()}`;
    const secondaryAgent = `agt_${randomUUID()}`;
    const crossTenantAgent = `agt_${randomUUID()}`;
    const firstRevision = revision(driver, first, primaryAgent, 1);
    const secondRevision = revision(driver, first, primaryAgent, 2);
    const separateAgentRevision = revision(driver, first, secondaryAgent, 1);
    const crossTenantRevision = revision(driver, second, crossTenantAgent, 1);
    const candidates = [firstRevision, secondRevision, separateAgentRevision, crossTenantRevision];
    const foreignCompute = { id: "different-driver", implementation: "different-implementation" };
    const unreadyFirstRevision = {
      namespaceId: firstRevision.namespaceId,
      agentId: firstRevision.agentId,
      revisionId: firstRevision.id,
      ready: false,
    };

    // Revisions pinned to another driver must never create actual tenant resources.
    assert.deepEqual(
      await driver.prepareRevision(
        { ...firstRevision, compute: foreignCompute },
        revisionContext(firstRevision),
      ),
      unreadyFirstRevision,
    );
    assert.equal(await missing("deployment", revisionName(firstRevision), owned[0]), true);
    assert.equal(await missing("service", agentName(primaryAgent), owned[0]), true);
    assert.equal(await missing("serviceaccount", agentName(primaryAgent), owned[0]), true);
    assert.equal(await missing("deployment", gatewayName(primaryAgent), owned[0]), true);

    const invalidClaimDirectory = await mkdtemp(join(tmpdir(), "openclaw-invalid-pvc-"));
    const invalidClaimPath = join(invalidClaimDirectory, "workspace-pvc.json");
    await writeFile(
      invalidClaimPath,
      JSON.stringify({
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: {
          name: harnessWorkspaceClaimName(primaryAgent),
          namespace: owned[0],
          labels: {
            "app.kubernetes.io/managed-by": "openclaw-enterprise",
            "openclaw.dev/namespace": first.id,
            "openclaw.dev/agent": primaryAgent,
          },
          annotations: {
            "openclaw.dev/namespace-id": first.id,
            "openclaw.dev/agent-id": primaryAgent,
          },
        },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: "1Gi" } },
        },
      }),
      { mode: 0o600 },
    );
    await kubectl("apply", "--filename", invalidClaimPath);
    try {
      await assert.rejects(
        driver.prepareRevision(firstRevision, revisionContext(firstRevision)),
        /invalid PersistentVolumeClaim workspace-/i,
      );
      assert.equal(await missing("deployment", gatewayName(primaryAgent), owned[0]), true);
      assert.equal(await missing("deployment", revisionName(firstRevision), owned[0]), true);
      const rejectedClaim = await resource(
        "persistentvolumeclaim",
        harnessWorkspaceClaimName(primaryAgent),
        owned[0],
      );
      assert.deepEqual(rejectedClaim.spec.accessModes, ["ReadWriteOnce"]);
      assert.equal(rejectedClaim.spec.resources.requests.storage, "1Gi");
    } finally {
      await rm(invalidClaimDirectory, { recursive: true, force: true });
      await kubectl(
        "delete",
        "persistentvolumeclaim",
        harnessWorkspaceClaimName(primaryAgent),
        "--namespace",
        owned[0],
        "--wait=true",
      );
    }

    const gatewayIdentities = new Map();
    const sharedWorkspaceIdentities = new Map();
    for (const candidate of candidates) {
      if (driver.requiresStoppedPredecessors(candidate)) {
        for (const previous of candidates.filter(
          (entry) => entry.agentId === candidate.agentId && entry.revision < candidate.revision,
        )) {
          await driver.stopRevision(previous);
          assert.equal(await missing("deployment", revisionName(previous), owned[0]), true);
        }
      }
      await waitFor(`AgentRevision ${candidate.id} to become ready`, async () => {
        const observation = await driver.prepareRevision(candidate, revisionContext(candidate));
        assert.deepEqual(
          {
            namespaceId: observation.namespaceId,
            agentId: observation.agentId,
            revisionId: observation.revisionId,
          },
          {
            namespaceId: candidate.namespaceId,
            agentId: candidate.agentId,
            revisionId: candidate.id,
          },
        );
        return observation.ready ? observation : undefined;
      });
      const placement = kubernetesNamespaceName(candidate.namespaceId);
      const gateway = await assertReadyGateway(
        placement,
        candidate.agentId,
        candidate.namespaceId,
        candidate,
      );
      const identityKey = `${candidate.namespaceId}:${candidate.agentId}`;
      if (gatewayIdentities.has(identityKey)) {
        assert.notEqual(
          gateway.metadata.uid,
          gatewayIdentities.get(identityKey),
          "exclusive replacement stops the predecessor before creating its successor",
        );
      } else {
        gatewayIdentities.set(identityKey, gateway.metadata.uid);
      }
      const deployment = await resource("deployment", revisionName(candidate), placement);
      const harnessClaim = await assertHarnessWorkspaceClaim(
        placement,
        candidate.namespaceId,
        candidate.agentId,
        sharedWorkspaceIdentities.get(identityKey),
      );
      sharedWorkspaceIdentities.set(identityKey, harnessClaim.metadata.uid);
      assert.equal(
        gateway.spec.template.spec.volumes.some(
          ({ persistentVolumeClaim }) =>
            persistentVolumeClaim?.claimName === harnessClaim.metadata.name,
        ),
        false,
        "Gateway must not mount the Harness workspace claim",
      );
      assert.deepEqual(
        deployment.spec.template.spec.volumes.find(({ name }) => name === "openclaw-workspace"),
        {
          name: "openclaw-workspace",
          persistentVolumeClaim: { claimName: harnessClaim.metadata.name },
        },
      );
      assert.equal(deployment.spec.template.spec.serviceAccountName, agentName(candidate.agentId));
      assert.equal(deployment.spec.template.spec.automountServiceAccountToken, false);
      assert.equal(deployment.spec.template.spec.securityContext.runAsNonRoot, true);
      assert.equal(
        deployment.spec.template.spec.securityContext.seccompProfile.type,
        "RuntimeDefault",
      );
      const container = deployment.spec.template.spec.containers[0];
      assert.equal(container.securityContext.allowPrivilegeEscalation, false);
      assert.equal(container.securityContext.readOnlyRootFilesystem, true);
      assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
      assert.deepEqual(container.resources.requests, { cpu: "25m", memory: "48Mi" });
      assert.equal(deployment.status.readyReplicas, 1);
      const account = await resource("serviceaccount", agentName(candidate.agentId), placement);
      assert.equal(account.automountServiceAccountToken, false);
      assert.equal(
        account.metadata.annotations["openclaw.dev/service-principal-id"],
        candidate.servicePrincipalId,
      );
      const projection = deployment.spec.template.spec.volumes.find(
        ({ projected }) => projected !== undefined,
      );
      assert.equal(
        projection.projected.sources[0].serviceAccountToken.audience,
        "openclaw-enterprise",
      );
      assert.equal(projection.projected.sources[0].serviceAccountToken.expirationSeconds, 3_600);
      await assertAgentServiceEndpointCount(
        placement,
        candidate.agentId,
        0,
        "an unactivated candidate must not become routable",
      );
    }

    assert.equal(
      (await resources("deployments", gatewayTargets[0])).filter(
        ({ spec }) => spec.template.metadata.labels?.["openclaw.dev/workload-role"] === "gateway",
      ).length,
      2,
      "two Agents in the same Namespace must own two independent gateway Deployments",
    );
    assert.equal(
      (await resources("deployments", gatewayTargets[1])).filter(
        ({ spec }) => spec.template.metadata.labels?.["openclaw.dev/workload-role"] === "gateway",
      ).length,
      1,
      "a separate Namespace must own only its deployed Agent's gateway",
    );
    assert.equal(
      (await resources("deployments", owned[2])).length,
      0,
      "an Agent-free Namespace must remain ready without a gateway",
    );

    assert.deepEqual(
      await driver.prepareRevision(firstRevision, revisionContext(firstRevision)),
      unreadyFirstRevision,
      "a stale previous revision cannot replace the newer live owner gateway",
    );

    const scaledRevision = revision(driver, first, primaryAgent, 3);
    await kubectl(
      "scale",
      `deployment/${gatewayName(primaryAgent)}`,
      "--namespace",
      gatewayTargets[0],
      "--replicas=2",
    );
    try {
      // An externally scaled owner gateway must not start another revision or affect its sibling.
      assert.deepEqual(
        await driver.prepareRevision(scaledRevision, revisionContext(scaledRevision)),
        {
          namespaceId: first.id,
          agentId: primaryAgent,
          revisionId: scaledRevision.id,
          ready: false,
        },
      );
      assert.equal(await missing("deployment", revisionName(scaledRevision), owned[0]), true);
      await assertReadyGateway(owned[0], secondaryAgent, first.id);
    } finally {
      await kubectl(
        "scale",
        `deployment/${gatewayName(primaryAgent)}`,
        "--namespace",
        gatewayTargets[0],
        "--replicas=1",
      );
    }
    await waitFor(
      "the externally scaled Agent gateway to return to one ready replica",
      async () => {
        const observation = await driver.prepareRevision(
          secondRevision,
          revisionContext(secondRevision),
        );
        return observation.ready ? observation : undefined;
      },
    );

    const firstPod = await workloadPod(
      owned[0],
      `app.kubernetes.io/name=${revisionName(secondRevision)}`,
    );
    const siblingPod = await workloadPod(
      owned[0],
      `app.kubernetes.io/name=${revisionName(separateAgentRevision)}`,
    );
    const foreignPod = await workloadPod(
      owned[1],
      `app.kubernetes.io/name=${revisionName(crossTenantRevision)}`,
    );
    const gatewayPod = await workloadPod(
      gatewayTargets[0],
      `app.kubernetes.io/name=${gatewayName(primaryAgent)}`,
    );
    const platformProbe = await resource("pod", "platform-probe", platformNamespace);
    assert.ok(firstPod && siblingPod && foreignPod && gatewayPod);
    await assertExplicitNetworkProfile(context, owned[0], firstPod);

    const gatewayUrl = `http://${gatewayName(primaryAgent)}.${gatewayTargets[0]}.svc.cluster.local:8080/readyz`;
    let lastApprovedGatewayError;
    try {
      await waitFor(
        "the approved platform client to reach the exact Agent's owned gateway through Service DNS",
        async () => {
          try {
            // Pod and EndpointSlice readiness can precede cross-Pod Service DNS reachability.
            assert.equal(
              JSON.parse(await probe(platformNamespace, "platform-probe", "http", gatewayUrl))
                .status,
              200,
              "an explicitly approved platform client must reach the exact Agent's owned gateway",
            );
            return true;
          } catch (error) {
            lastApprovedGatewayError = error;
            return false;
          }
        },
        60_000,
      );
    } catch (error) {
      throw lastApprovedGatewayError ?? error;
    }
    assert.ok(
      JSON.parse(
        await probe(
          owned[0],
          firstPod.metadata.name,
          "dns",
          "kubernetes.default.svc.cluster.local",
        ),
      ).address,
      "Agent DNS traffic must remain explicitly allowed",
    );
    await assertDeniedTraffic(
      "Agent outbound platform traffic",
      owned[0],
      firstPod.metadata.name,
      "tcp",
      platformProbe.status.podIP,
      8080,
    );
    await assertDeniedTraffic(
      "Agent outbound Kubernetes API traffic",
      owned[0],
      firstPod.metadata.name,
      "tcp",
      "kubernetes.default.svc.cluster.local",
      443,
    );
    await assertDeniedTraffic(
      "Agent outbound cloud metadata traffic",
      owned[0],
      firstPod.metadata.name,
      "tcp",
      "169.254.169.254",
      80,
    );
    const projectedIdentity = JSON.parse(
      await probe(
        owned[0],
        firstPod.metadata.name,
        "token",
        "/var/run/secrets/openclaw/service-principal/token",
      ),
    );
    assert.deepEqual(
      projectedIdentity.audience,
      ["openclaw-enterprise"],
      "projected credentials must carry the configured non-Kubernetes ServicePrincipal audience",
    );
    assert.equal(
      projectedIdentity.subject,
      `system:serviceaccount:${owned[0]}:${agentName(primaryAgent)}`,
      "projected ServicePrincipal credentials must belong only to the exact Agent ServiceAccount",
    );

    await assertDeniedTraffic(
      "cross-tenant Agent traffic",
      owned[0],
      firstPod.metadata.name,
      "tcp",
      foreignPod.status.podIP,
      8080,
    );
    await assertDeniedTraffic(
      "same-tenant Agent-to-Agent traffic",
      owned[0],
      firstPod.metadata.name,
      "tcp",
      siblingPod.status.podIP,
      8080,
    );
    await assertDeniedTraffic(
      "gateway-to-candidate Agent traffic",
      gatewayTargets[0],
      gatewayPod.metadata.name,
      "tcp",
      firstPod.status.podIP,
      8080,
    );

    const controllerActor = `system:serviceaccount:${platformNamespace}:${controller.account}`;
    for (const target of [owned[0], gatewayTargets[0]]) {
      assert.equal(
        await authorized(target, controllerActor, "get", "secrets"),
        true,
        "the controller needs exact-target access to canonical and delivered Secrets",
      );
      for (const [namespace, pod] of [
        [owned[0], firstPod],
        [gatewayTargets[0], gatewayPod],
      ]) {
        assert.equal(
          await authorized(
            target,
            `system:serviceaccount:${namespace}:${pod.spec.serviceAccountName}`,
            "get",
            "secrets",
          ),
          false,
          "neither Harness nor Gateway identities may read Kubernetes Secrets in either target",
        );
      }
    }

    const firstAgentAccount = await resource("serviceaccount", agentName(primaryAgent), owned[0]);
    const secondAgentAccount = await resource(
      "serviceaccount",
      agentName(secondaryAgent),
      owned[0],
    );
    assert.notEqual(firstAgentAccount.metadata.uid, secondAgentAccount.metadata.uid);
    assert.equal(
      (await resources("deployments", owned[0])).filter(
        ({ spec }) => spec.template.spec.serviceAccountName === agentName(primaryAgent),
      ).length,
      1,
      "only one revision of an Agent may hold its durable workspace",
    );

    const siblingGatewayService = await resource(
      "service",
      gatewayName(secondaryAgent),
      gatewayTargets[0],
    );
    await kubectl(
      "delete",
      "service",
      gatewayName(primaryAgent),
      "--namespace",
      gatewayTargets[0],
      "--wait=true",
    );
    await waitFor(
      "the controller to repair only the Agent's missing owned gateway Service",
      async () => {
        const observation = await driver.prepareRevision(
          secondRevision,
          revisionContext(secondRevision),
        );
        return observation.ready ? observation : undefined;
      },
    );
    await assertReadyGateway(owned[0], primaryAgent, first.id);
    assert.equal(
      (await resource("service", gatewayName(secondaryAgent), gatewayTargets[0])).metadata.uid,
      siblingGatewayService.metadata.uid,
      "repairing one Agent gateway must not replace a sibling Agent's gateway resources",
    );

    await kubectl("create", "namespace", foreignName);
    assert.equal(
      await authorized(foreignName, controllerActor, "get", "serviceaccounts"),
      false,
      "a namespace-only controller cluster grant must not leak namespaced access across tenants",
    );
    assert.equal(
      await authorized(foreignName, controllerActor, "get", "secrets"),
      false,
      "controller Secret access must not extend to a namespace without an explicit grant",
    );
    const denied = await driver.ensureNamespace(foreign);
    assert.deepEqual(denied, {
      namespaceId: foreign.id,
      namespaceReady: false,
      failure: "permanent",
    });
    const foreignLabels = (await resource("namespace", foreignName)).metadata.labels ?? {};
    assert.equal(
      foreignLabels["app.kubernetes.io/managed-by"],
      undefined,
      "a foreign namespace must not be relabeled as managed after ownership denial",
    );
    assert.equal(
      foreignLabels["openclaw.dev/namespace"],
      undefined,
      "a foreign namespace must not be labeled with a tenant owner after ownership denial",
    );

    await assert.rejects(
      driver.retireRevision({ ...firstRevision, compute: foreignCompute }),
      /another Compute Driver/i,
    );
    await resource("deployment", revisionName(secondRevision), owned[0]);

    await driver.retireRevision(firstRevision);
    assert.equal(await missing("deployment", revisionName(firstRevision), owned[0]), true);
    await assertHarnessWorkspaceClaim(
      owned[0],
      first.id,
      primaryAgent,
      sharedWorkspaceIdentities.get(`${first.id}:${primaryAgent}`),
    );
    await resource("deployment", revisionName(secondRevision), owned[0]);
    await resource("deployment", revisionName(separateAgentRevision), owned[0]);
    await resource("deployment", revisionName(crossTenantRevision), owned[1]);
    await resource("serviceaccount", agentName(primaryAgent), owned[0]);
    await assertReadyGateway(owned[0], primaryAgent, first.id);
    await assertReadyGateway(owned[0], secondaryAgent, first.id);

    const embeddedAgent = `agt_${randomUUID()}`;
    const embeddedRevision = {
      ...revision(driver, first, embeddedAgent, 1),
      harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    };
    embeddedRevision.configuration.agents.defaults.model = "openai/gpt-5";
    await waitFor(`embedded AgentRevision ${embeddedRevision.id} to become ready`, async () => {
      const observation = await driver.prepareRevision(
        embeddedRevision,
        revisionContext(embeddedRevision),
      );
      return observation.ready ? observation : undefined;
    });
    await assertReadyGateway(owned[0], embeddedAgent, first.id, embeddedRevision);
    assert.equal(
      await missing("persistentvolumeclaim", harnessWorkspaceClaimName(embeddedAgent), owned[0]),
      true,
      "embedded Agents must remain unchanged and create no Harness workspace claim",
    );

    await driver.retireRevision(secondRevision);
    await assertHarnessWorkspaceClaim(
      owned[0],
      first.id,
      primaryAgent,
      sharedWorkspaceIdentities.get(`${first.id}:${primaryAgent}`),
    );
    // Revision cleanup preserves the Agent workspace; only final Agent deletion removes it.
    await driver.deleteAgentRuntimeCredentials({
      namespace: first,
      agent: { id: primaryAgent, namespaceId: first.id },
    });
    await waitFor(
      `Harness workspace claim ${harnessWorkspaceClaimName(primaryAgent)} to be deleted`,
      () => missing("persistentvolumeclaim", harnessWorkspaceClaimName(primaryAgent), owned[0]),
    );
    await assertHarnessWorkspaceClaim(
      owned[0],
      first.id,
      secondaryAgent,
      sharedWorkspaceIdentities.get(`${first.id}:${secondaryAgent}`),
    );
    await assertReadyGateway(owned[0], secondaryAgent, first.id);

    await waitFor(`empty Namespace ${empty.id} to be completely deleted`, async () => {
      const observation = await driver.deleteNamespace(empty);
      assert.equal(observation.namespaceId, empty.id);
      assert.notEqual(observation.failure, "permanent");
      return observation.namespaceDeleted ? observation : undefined;
    });
    assert.equal(await missing("namespace", owned[2]), true);
    assert.equal(await missing("namespace", gatewayTargets[2]), true);
    assert.deepEqual(await driver.deleteNamespace(empty), {
      namespaceId: empty.id,
      namespaceDeleted: true,
    });
  },
);
