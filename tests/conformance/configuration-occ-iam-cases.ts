import assert from "node:assert/strict";
import test from "node:test";
import { administrator, fixture, deployOnly } from "./configuration-occ-fixture.ts";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { AuthorizationDeniedError, NamespaceNotEmptyError } from "../../packages/occ/src/index.ts";

export function registerConfigurationIAMCases(): void {
  test("Agent deployment separately authorizes its exact Configuration", async () => {
    const { agent, controller, namespace } = await fixture();

    // An Agent deploy grant does not imply authority to read its referenced Configuration.
    await assert.rejects(
      controller.deployAgent(
        deployOnly,
        { namespaceId: namespace.id, agentId: agent.id },
        resolveApprovedDevelopmentHarness,
      ),
      (error: unknown) => {
        assert.ok(error instanceof AuthorizationDeniedError);
        assert.deepEqual(error.authorization, {
          action: "read",
          resource: { kind: "configuration", id: agent.configurationId, namespaceId: namespace.id },
        });
        return true;
      },
    );
    assert.deepEqual(
      (await controller.listRevisions(administrator, namespace.id, agent.id)).revisions,
      [],
    );
  });

  test("Agent creation and update separately authorize their exact Configuration", async () => {
    const { agent, configuration, controller, iamState, namespace } = await fixture();
    const deniedRead = (error: unknown) => {
      assert.ok(error instanceof AuthorizationDeniedError);
      assert.deepEqual(error.authorization, {
        action: "read",
        resource: { kind: "configuration", id: configuration.id, namespaceId: namespace.id },
      });
      return true;
    };
    const create = () =>
      controller.createAgent(administrator, {
        namespaceId: namespace.id,
        name: "Configuration read probe",
        configurationId: configuration.id,
      });
    const update = () =>
      controller.updateAgent(administrator, {
        namespaceId: namespace.id,
        agentId: agent.id,
        configurationId: configuration.id,
      });

    // Agent create and update grants do not imply reading the Configuration they select.
    iamState.restrictions.push({
      id: "deny-configuration-read",
      namespaceId: namespace.id,
      action: "read",
      resourceKind: "configuration",
      resourceId: configuration.id,
      effect: "deny",
    });
    await assert.rejects(create(), deniedRead);
    await assert.rejects(update(), deniedRead);
    assert.deepEqual(
      (await controller.listAgents(administrator, namespace.id)).map(({ id }) => id),
      [agent.id],
    );

    iamState.restrictions.pop();
    assert.equal((await create()).configurationId, configuration.id);
    assert.equal((await update()).configurationId, configuration.id);
  });

  test("Namespace deletion refuses an otherwise agent-free Namespace with Configuration", async () => {
    const { controller } = await fixture();
    const namespace = await controller.createNamespace(administrator, {
      name: "Configuration-only tenant",
    });
    await controller.createConfiguration(administrator, {
      namespaceId: namespace.id,
      kind: "agent",
      values: { model: "unattached-model" },
    });

    // Namespace ownership must remain intact until every ConfigMap-backed resource is removed.
    await assert.rejects(
      controller.deleteNamespace(administrator, namespace.id),
      NamespaceNotEmptyError,
    );
    assert.equal(
      (await controller.getNamespace(administrator, namespace.id)).status,
      "provisioning",
    );
  });
}
