import assert from "node:assert/strict";
import test from "node:test";

import {
  kubernetesGatewayNamespaceName,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { ResourceConflictError } from "../../packages/occ/src/index.ts";
import {
  agent,
  binding,
  credentialFixture,
  digest,
  embeddedFirstModes,
  namespace,
  runtimeSecret,
} from "./kubernetes-runtime-credentials-fixture.ts";

// The deletion worker stops the Agent and marks it for deletion before calling the Driver.
const deletingBinding = { namespace, agent: { ...agent, status: "deleting" } } as const;

export function registerEarlyTeardown(): void {
  test("mocked Kubernetes client deletes every owned Agent runtime credential Secret idempotently", async () => {
    const first = credentialFixture();
    const secrets = {
      [`transport-${digest(agent.id)}`]: runtimeSecret(
        first.resources,
        "transport",
        { incomplete: "deletion must not depend on credential contents" },
        { uid: "transport-uid" },
      ),
    };
    const fixture = credentialFixture({ secrets });

    await fixture.driver.deleteAgentRuntimeCredentials(deletingBinding);
    assert.deepEqual(fixture.deleted, [`transport-${digest(agent.id)}`]);

    // A retry after partial or complete teardown observes absence and converges.
    await fixture.driver.deleteAgentRuntimeCredentials(deletingBinding);
    assert.equal(fixture.deleted.length, 1);
  });

  test("Agent deletion removes the Gateway workspace node binding", async () => {
    const first = credentialFixture();
    const name = `gateway-${digest(agent.id)}-workspace-node`;
    const nodeBinding = {
      ...first.resources.manifest(
        "v1",
        "ConfigMap",
        name,
        { namespaceId: namespace.id, agentId: agent.id },
        { name: kubernetesNamespaceName(namespace.id), plane: "control" },
      ),
      data: {
        "workspace-node.json": JSON.stringify({ revisionId: "revision-1", deviceId: "node" }),
      },
    };
    nodeBinding.metadata.uid = "binding-uid";
    const configMaps = { [name]: nodeBinding };
    const fixture = credentialFixture({ configMaps });
    await fixture.driver.deleteAgentRuntimeCredentials(deletingBinding);
    assert.deepEqual(configMaps, {});
    assert.deepEqual(
      fixture.calls.filter((call) => call.kind === "deleteConfigMap").map(({ name }) => name),
      [name],
    );
    // A retry observes absence and converges.
    await fixture.driver.deleteAgentRuntimeCredentials(deletingBinding);
  });

  for (const runtime of [true, false]) {
    test(`Agent deletion removes owned claims after transport loss with runtime ${runtime ? "configured" : "disabled"}`, async () => {
      const first = credentialFixture();
      const ownership = { namespaceId: namespace.id, agentId: agent.id };
      const owned = [
        first.resources.harnessWorkspaceClaim(agent.id, ownership, {
          name: first.namespaceName,
          plane: "execution",
        }),
        ...(runtime
          ? [
              first.resources.gatewayPrivateStateClaim(agent.id, ownership, {
                name: kubernetesNamespaceName(namespace.id),
                plane: "control",
              }),
            ]
          : []),
      ];
      const claims = Object.fromEntries(
        owned.map((claim) => {
          claim.metadata.uid = `${claim.metadata.name}-uid`;
          return [claim.metadata.name, claim];
        }),
      );
      const fixture = credentialFixture({ claims, runtime });

      // Recovery cannot depend on the transport Secret surviving earlier teardown.
      await fixture.driver.deleteAgentRuntimeCredentials(deletingBinding);
      assert.deepEqual(Object.keys(claims), []);
      assert.deepEqual(
        fixture.calls
          .filter((call) => call.kind === "deleteClaim")
          .map(({ name }) => name)
          .sort(),
        owned.map(({ metadata }) => metadata.name).sort(),
      );
      await fixture.driver.deleteAgentRuntimeCredentials(deletingBinding);
      assert.equal(
        fixture.calls.filter((call) => call.kind === "deleteClaim").length,
        owned.length,
      );
    });
  }

  test("draft Agent cleanup tolerates absent compute Namespace without bypassing scope or backend denial", async () => {
    const absent = credentialFixture({ runtime: false, namespaceReadStatus: 404 });

    // A draft Agent can be deleted before Namespace provisioning creates any workload storage.
    await absent.driver.deleteAgentRuntimeCredentials(deletingBinding);
    assert.deepEqual(
      absent.calls.map(({ kind }) => kind),
      ["listNamespace", "readNamespace"],
    );

    const wrongBinding = credentialFixture({ runtime: false, namespaceReadStatus: 404 });
    await assert.rejects(
      wrongBinding.driver.deleteAgentRuntimeCredentials({
        namespace,
        agent: { ...deletingBinding.agent, namespaceId: "another-namespace" },
      }),
      ResourceConflictError,
    );
    assert.deepEqual(wrongBinding.calls, []);

    const denied = credentialFixture({ runtime: false, namespaceReadStatus: 403 });
    await assert.rejects(
      denied.driver.deleteAgentRuntimeCredentials(deletingBinding),
      /backend is not authorized/,
    );
    assert.deepEqual(
      denied.calls.map(({ kind }) => kind),
      ["listNamespace", "readNamespace"],
    );

    // Cleanup absence does not authorize credential operations against a missing Namespace.
    const credential = credentialFixture({ namespaceReadStatus: 404 });
    await assert.rejects(
      credential.driver.getAgentRuntimeCredentialStatus(binding()),
      /namespace is unavailable/,
    );
  });
}

export function registerSharedAndTwoClusterTeardown(): void {
  test("credential provisioning cannot replace transport while a Gateway survives in the shared namespace", async () => {
    const initial = credentialFixture();
    const gateway = initial.resources.manifest(
      "apps/v1",
      "Deployment",
      "gateway-existing",
      { namespaceId: namespace.id, agentId: agent.id },
      { name: kubernetesNamespaceName(namespace.id), plane: "control" },
    );
    const fixture = credentialFixture({ deployments: [gateway] });
    await assert.rejects(
      fixture.driver.provisionAgentRuntimeCredentials(binding(), {}),
      /already been deployed/,
    );
    assert.equal(fixture.created.length, 0);
  });

  test("Agent deletion is idempotent after its shared namespace disappears", async () => {
    const fixture = credentialFixture({ namespaceReadStatus: 404 });
    await fixture.driver.deleteAgentRuntimeCredentials(deletingBinding);
    assert.equal(
      fixture.calls.some(({ kind }) => kind === "deleteClaim" || kind === "deleteSecret"),
      false,
    );
  });

  test("two-cluster Agent deletion removes Gateway state after the execution namespace disappears", async () => {
    const initial = credentialFixture({ twoCluster: true });
    const claim = initial.resources.gatewayPrivateStateClaim(
      agent.id,
      { namespaceId: namespace.id, agentId: agent.id },
      { name: kubernetesGatewayNamespaceName(namespace.id), plane: "control" },
    );
    claim.metadata.uid = "retained-gateway-claim";
    const claims = { [claim.metadata.name]: claim };
    const fixture = credentialFixture({ twoCluster: true, claims, namespaceReadStatus: 404 });
    await fixture.driver.deleteAgentRuntimeCredentials(deletingBinding);
    assert.deepEqual(Object.keys(claims), []);
  });

  for (const executionMode of embeddedFirstModes) {
    test(`Agent deletion cleans the shared target despite draft mode ${executionMode}`, async () => {
      const initial = credentialFixture();
      const ownership = { namespaceId: namespace.id, agentId: agent.id };
      const target = initial.namespaceName;
      const claim = initial.resources.gatewayPrivateStateClaim(agent.id, ownership, {
        name: target,
        plane: "execution",
      });
      claim.metadata.uid = `${target}-claim-uid`;
      const claims = { [target]: claim };
      const secret = initial.resources.manifest(
        "v1",
        "Secret",
        `transport-${digest(agent.id)}`,
        ownership,
        { name: target, plane: "execution" },
      );
      secret.metadata.uid = `${target}-transport-uid`;
      const secrets = { [target]: secret };
      const fixture = credentialFixture({ claims, secrets });
      const current = { namespace, agent: { ...deletingBinding.agent, executionMode } };
      await fixture.driver.deleteAgentRuntimeCredentials(current);
      assert.deepEqual(
        Object.keys(claims),
        [],
        "The private claim must be removed at Agent deletion",
      );
      assert.deepEqual(Object.keys(secrets), [], "The owned transport Secret must be removed");
      await fixture.driver.deleteAgentRuntimeCredentials(current);
      assert.equal(fixture.calls.filter((call) => call.kind === "deleteClaim").length, 1);
      assert.equal(fixture.deleted.length, 1);
    });
  }
}
