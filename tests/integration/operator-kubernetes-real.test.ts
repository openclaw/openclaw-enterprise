import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  KubeConfig,
  CoreV1Api,
  CustomObjectsApi,
  ApiextensionsV1Api,
  setHeaderOptions,
} from "@kubernetes/client-node";
import {
  KubernetesAgentOperator,
  OPERATOR_GROUP,
  OPERATOR_VERSION,
  operatorCustomResourceDefinitions,
} from "../../apps/operator/src/index.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { grantRole } from "../helpers/iam-grants.mjs";
import { validateExplicitK3dLoopbackContext } from "../helpers/kubernetes-real.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import type { Principal, ServicePrincipal } from "../../packages/contracts/src/index.ts";

const selected = process.env.OCC_TEST_KUBERNETES_OPERATOR === "1";

test(
  "real Kubernetes Operator watches scoped resources, validates Enterprise identity and refuses another Installation",
  {
    skip:
      !selected && "Set OCC_TEST_KUBERNETES_OPERATOR=1 with an explicit disposable k3d selection",
  },
  async (t) => {
    const kubeconfigPath = process.env.OCC_TEST_KUBERNETES_KUBECONFIG;
    const kubernetesContext = process.env.OCC_TEST_KUBERNETES_CONTEXT;
    await validateExplicitK3dLoopbackContext({ kubeconfigPath, kubernetesContext });
    assert.ok(kubeconfigPath);
    assert.ok(kubernetesContext);
    const configuration = new KubeConfig();
    configuration.loadFromFile(kubeconfigPath);
    configuration.setCurrentContext(kubernetesContext);
    const core = configuration.makeApiClient(CoreV1Api);
    const custom = configuration.makeApiClient(CustomObjectsApi);
    const extensions = configuration.makeApiClient(ApiextensionsV1Api);
    for (const definition of operatorCustomResourceDefinitions()) {
      await extensions.patchCustomResourceDefinition(
        {
          name: String((definition.metadata as { name: string }).name),
          body: definition,
          fieldManager: "operator-integration",
          force: true,
        },
        setHeaderOptions("Content-Type", "application/apply-patch+yaml"),
      );
    }
    const namespace = `oce-operator-test-${randomUUID().slice(0, 8)}`;
    await core.createNamespace({ body: { metadata: { name: namespace } } });
    const target = { group: OPERATOR_GROUP, version: OPERATOR_VERSION, namespace };
    const lifecycle: { operator?: KubernetesAgentOperator } = {};
    t.after(async () => {
      await lifecycle.operator?.stop();
      // Only these test-owned, reference-only CRs receive forced cleanup.
      for (const plural of ["oceagents", "ocesecrets", "ocenamespaces", "oceconnections"]) {
        const resources = await custom.listNamespacedCustomObject({ ...target, plural });
        for (const resource of resources.items) {
          await custom.patchNamespacedCustomObject(
            {
              ...target,
              plural,
              name: resource.metadata.name,
              body: { metadata: { finalizers: [] } },
            },
            setHeaderOptions("Content-Type", "application/merge-patch+json"),
          );
        }
      }
      await core.deleteNamespace({ name: namespace });
    });
    // The real API/auth/IAM and real Kubernetes SDK are under proof. OCC State and
    // runtime Drivers are the console fixture; no model/runtime/Argo proof is claimed.
    const f = await createConsoleAppFixture(t);
    const installation = await f.bootstrap();
    const tenant = await f.createNamespace(`operator-tenant-${randomUUID()}`, { ready: true });
    const principal: ServicePrincipal = {
      kind: "service_principal",
      id: `sp_${randomUUID()}`,
      namespaceId: tenant.id,
    };
    const identities: (Principal | ServicePrincipal)[] = f.policy.identities;
    identities.push(principal);
    grantRole(f.policy, principal.id, {
      id: `operator-reader-${randomUUID()}`,
      namespaceId: tenant.id,
      permissions: { namespace: ["read"] },
      resource: undefined,
    });
    const issued = await f.request("POST", "/api/auth/service-keys", {
      body: {
        servicePrincipalId: principal.id,
        namespaceId: tenant.id,
        name: "operator-connection-test",
      },
    });
    assert.equal(issued.status, 201);
    await core.createNamespacedSecret({
      namespace,
      body: { metadata: { name: "connection-key" }, stringData: { key: issued.data.key } },
    });
    const create = (kind: string, plural: string, name: string, spec: Record<string, unknown>) =>
      custom.createNamespacedCustomObject({
        ...target,
        plural,
        body: {
          apiVersion: `${OPERATOR_GROUP}/${OPERATOR_VERSION}`,
          kind,
          metadata: { name },
          spec,
        },
      });
    const connection = {
      endpoint: f.origin,
      address: "127.0.0.1",
      installationId: installation.id,
      serviceKeyRef: { name: "connection-key", key: "key" },
      namespaceScope: { existingIds: [tenant.id], allowCreate: false },
    };
    await create("OCEConnection", "oceconnections", "enterprise", connection);
    await create("OCEConnection", "oceconnections", "wrong-installation", {
      ...connection,
      installationId: `ins_${randomUUID()}`,
    });
    await create("OCENamespace", "ocenamespaces", "tenant", {
      connectionRef: "enterprise",
      existingId: tenant.id,
      deletionPolicy: "Retain",
    });
    const operator = new KubernetesAgentOperator({
      configuration,
      namespace,
      sourceClusterId: randomUUID(),
      leaseName: "operator-test",
      healthPort: 0,
    });
    lifecycle.operator = operator;
    try {
      await operator.start();
      await waitFor(
        "scoped Connection and Namespace readiness",
        async () => {
          const connection = await custom.getNamespacedCustomObject({
            ...target,
            plural: "oceconnections",
            name: "enterprise",
          });
          const tenantResource = await custom.getNamespacedCustomObject({
            ...target,
            plural: "ocenamespaces",
            name: "tenant",
          });
          return connection.status?.conditions?.[0]?.status === "True" &&
            tenantResource.status?.namespaceId === tenant.id &&
            tenantResource.status?.conditions?.[0]?.status === "True"
            ? true
            : undefined;
        },
        { timeoutMs: 30_000, intervalMs: 250 },
      );
      const refused = await waitFor(
        "different Installation refusal",
        async () => {
          const resource = await custom.getNamespacedCustomObject({
            ...target,
            plural: "oceconnections",
            name: "wrong-installation",
          });
          return resource.status?.conditions?.[0]?.reason === "InstallationMismatch"
            ? resource
            : undefined;
        },
        { timeoutMs: 15_000, intervalMs: 250 },
      );
      assert.equal(refused.status.conditions[0].status, "False");
      // Connection validation worked with Namespace read only. Agent management gets
      // separate explicit permissions, with no Installation administration grant.
      grantRole(f.policy, principal.id, {
        id: `operator-manager-${randomUUID()}`,
        namespaceId: tenant.id,
        permissions: {
          agent: ["read", "update", "administer", "deploy", "operate"],
          configuration: ["read", "update"],
          secret: ["read", "operate"],
          agent_revision: ["read"],
        },
        resource: undefined,
      });
      const values = createHarnessConfiguration("codex", "gpt-5.1");
      const agent = await f.createAgent(tenant.id, "operator-managed", values, {
        executionMode: "dedicated",
      });
      const managementPath = `/namespaces/${tenant.id}/agents/${agent.id}/management`;
      const reviewed = (await f.request("GET", managementPath)).data.adoption;
      assert.ok(agent.harnessAuth?.method === "api_key");
      await create("OCESecret", "ocesecrets", "model", {
        namespaceRef: "tenant",
        existingId: agent.harnessAuth.source.id,
        deletionPolicy: "Retain",
      });
      await create("OCEAgent", "oceagents", "assistant", {
        namespaceRef: "tenant",
        executionMode: "dedicated",
        desiredState: "running",
        deletionPolicy: "Retain",
        nativeAdmin: false,
        adopt: {
          agentId: agent.id,
          configurationId: reviewed.configurationId,
          configurationGeneration: reviewed.configurationGeneration,
          fingerprint: reviewed.fingerprint,
          managementVersion: 0,
        },
        configuration: { values },
        harnessAuth: { method: "api_key", secretRef: "model" },
      });
      await waitFor(
        "Operator adoption and persisted apply receipt",
        async () => {
          const response = await f.request("GET", managementPath);
          return response.data.management?.requestedRevisionId ? response.data : undefined;
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      const revisions = (
        await f.request("GET", `/namespaces/${tenant.id}/agents/${agent.id}/revisions`)
      ).data;
      assert.equal(revisions.length, 1);
      // This fixture does not run a deployment worker. The Operator must not report
      // Healthy merely because OCC accepted its declaration.
      const pending = await custom.getNamespacedCustomObject({
        ...target,
        plural: "oceagents",
        name: "assistant",
      });
      assert.notEqual(pending.status?.conditions?.[0]?.status, "True");
      await custom.deleteNamespacedCustomObject({
        ...target,
        plural: "oceagents",
        name: "assistant",
      });
      await waitFor(
        "Retain releases exact ownership",
        async () => {
          const response = await f.request("GET", managementPath);
          return response.data.management?.released === true ? true : undefined;
        },
        { timeoutMs: 15_000, intervalMs: 250 },
      );
      assert.equal(
        (await f.request("GET", `/namespaces/${tenant.id}/agents/${agent.id}`)).status,
        200,
      );
    } catch (error) {
      const resources = await custom.listNamespacedCustomObject({ ...target, plural: "oceagents" });
      t.diagnostic(
        JSON.stringify(
          resources.items.map(
            (r: { metadata: { name: string; finalizers?: string[] }; status?: unknown }) => ({
              name: r.metadata.name,
              finalizers: r.metadata.finalizers,
              status: r.status,
            }),
          ),
        ),
      );
      throw error;
    }
  },
);
