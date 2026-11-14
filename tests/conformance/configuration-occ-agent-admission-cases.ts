import assert from "node:assert/strict";
import test from "node:test";
import {
  administrator,
  fixture,
  grantFixtureRole,
  installation,
} from "./configuration-occ-fixture.ts";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { type UpdateAgentInput, type CreateAgentInput } from "../../packages/occ/src/index.ts";
import { registerAndSelectDrivers } from "../helpers/development.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { refusedAnswer } from "../helpers/refusal-answers.mjs";
import { GATEWAY_MANAGED_MODE_DENIED } from "../helpers/refusal-text.mjs";

export function registerAgentAdmissionCases(): void {
  test("deployment freezes and persists the Compute Driver's admission decision", async () => {
    const { agent, compute, controller, namespace, state } = await fixture();
    let decision = "peer-one";
    compute.admitRevision = (draft) => {
      assert.equal(Object.isFrozen(draft), true);
      assert.equal(Object.isFrozen(draft.configuration), true);
      assert.equal(Object.isFrozen(draft.compute), true);
      return decision;
    };
    const revision = await controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    );
    decision = "peer-two";
    const stored = await state.read((view) =>
      view.revisions.findRevision(namespace.id, agent.id, revision.id),
    );
    assert.ok(stored);
    assert.equal(stored.compute.admission, "peer-one");
  });

  test("partial Agent updates keep completed workspace topology unless its Configuration or mode changes", async () => {
    const { controller, iamState, namespace, state } = await fixture();
    grantFixtureRole(iamState, administrator, {
      id: "managed-mode-administrator",
      permissions: { installation: ["administer"] },
      resource: { kind: "installation", id: installation.id },
    });
    // Use the production Driver's workspace admission rules without a cluster client.
    const compute = createTestKubernetesComputeDriver("partial-update-compute", {
      gatewayRuntime: true,
    });
    registerAndSelectDrivers(controller, [compute]);
    const base = createHarnessConfiguration("openclaw", "gpt-4.1");
    const values = {
      ...base,
      agents: { defaults: { ...base.agents.defaults, workspace: "/home/node/workspace" } },
    };
    const configuration = await controller.createConfiguration(administrator, {
      namespaceId: namespace.id,
      kind: "agent",
      values,
    });
    const agent = await controller.createAgent(
      administrator,
      {
        namespaceId: namespace.id,
        name: "Partial update workspace",
        configurationId: configuration.id,
        executionMode: "dedicated",
        initialWorkspaceFiles: { "USER.md": "Synthetic workspace owner" },
      },
      resolveApprovedDevelopmentHarness,
    );
    // Retain the metadata a successful initial deployment leaves, with no staged bytes.
    const setup = await state.read((view) => view.workspaceSetups.find(namespace.id, agent.id));
    assert.ok(setup);
    await state.transact((unit) => unit.workspaceSetups.complete(namespace.id, agent.id, setup.id));
    const identity = { namespaceId: namespace.id, agentId: agent.id };
    const update = (body: Omit<UpdateAgentInput, "namespaceId" | "agentId">) =>
      controller.updateAgent(
        administrator,
        {
          ...identity,
          ...body,
        },
        resolveApprovedDevelopmentHarness,
      );
    const workspaceError = {
      name: "ConfigurationHarnessError",
      message: /^Configuration setting agents\.defaults\.workspace must be /u,
    };
    // The same Configuration's workspace is valid only for dedicated execution.
    await assert.rejects(
      update({ gatewayManagedMode: false, executionMode: "embedded" }),
      workspaceError,
    );
    const edited = structuredClone(values);
    edited.agents.defaults.workspace = "/srv/experiment";
    await controller.updateConfiguration(administrator, {
      namespaceId: namespace.id,
      configurationId: configuration.id,
      values: edited,
    });
    // A later Configuration edit may break deployment without locking unrelated Agent edits.
    for (const body of [
      { configurationId: configuration.id, gatewayManagedMode: false },
      { gatewayManagedMode: true },
      { gatewayManagedMode: false, executionMode: agent.executionMode },
    ]) {
      const saved = await update(body);
      assert.equal(saved.gatewayManagedMode, body.gatewayManagedMode);
      assert.equal(saved.configurationId, configuration.id);
      assert.equal(saved.executionMode, agent.executionMode);
    }
    const other = await controller.createConfiguration(administrator, {
      namespaceId: namespace.id,
      kind: "agent",
      values: edited,
    });
    await assert.rejects(update({ configurationId: other.id }), workspaceError);
    const saved = await controller.getAgent(administrator, namespace.id, agent.id);
    assert.equal(saved.configurationId, configuration.id);
    assert.equal(saved.executionMode, agent.executionMode);
    assert.equal(saved.gatewayManagedMode, false);
  });

  test("a new Agent's Gateway managed mode defaults to what the selected Compute Driver enforces", async () => {
    const { configuration, controller, iamState, namespace } = await fixture();
    const create = (name: string, extra: Pick<CreateAgentInput, "gatewayManagedMode"> = {}) =>
      controller.createAgent(administrator, {
        namespaceId: namespace.id,
        name,
        configurationId: configuration.id,
        ...extra,
      });
    const unsupported = {
      name: "ConfigurationHarnessError",
      message: "Agent setting gatewayManagedMode is not supported by the selected Compute Driver.",
    };
    // Kubernetes without a Gateway runtime cannot apply managed mode (finding 2676). The default
    // is off, which needs no Installation administer: there is nothing to opt out of.
    registerAndSelectDrivers(controller, [createTestKubernetesComputeDriver("no-gateway-runtime")]);
    const unmanaged = await create("No Gateway runtime");
    assert.equal(unmanaged.gatewayManagedMode, false);
    // Asking for it is refused at save and in the create preflight, not at the next deploy.
    await assert.rejects(
      create("Managed without runtime", { gatewayManagedMode: true }),
      unsupported,
    );
    await assert.rejects(
      controller.validateAgentCreate(administrator, {
        namespaceId: namespace.id,
        configuration: { kind: "agent", values: configuration.values },
        gatewayManagedMode: true,
      }),
      unsupported,
    );
    // Turning it on later is an Installation administrator's change, refused for the same reason.
    grantFixtureRole(iamState, administrator, {
      id: "managed-mode-administrator",
      permissions: { installation: ["administer"] },
      resource: { kind: "installation", id: installation.id },
    });
    await assert.rejects(
      controller.updateAgent(administrator, {
        namespaceId: namespace.id,
        agentId: unmanaged.id,
        gatewayManagedMode: true,
      }),
      unsupported,
    );
    // With a Gateway runtime the Driver enforces managed mode, so it is on by default.
    registerAndSelectDrivers(controller, [
      createTestKubernetesComputeDriver("gateway-runtime", { gatewayRuntime: true }),
    ]);
    assert.equal((await create("Gateway runtime")).gatewayManagedMode, true);
  });

  test("only an Installation administrator opts an Agent out of Gateway managed mode or changes it later", async () => {
    const { configuration, controller, iamState, namespace } = await fixture();
    // This fixture's administrator holds Agent create and update in the Namespace but not
    // Installation administer: the managed-mode member persona.
    const member = administrator;
    const installationAdministrator = "principal-configuration-installation-administrator";
    iamState.identities.push({
      kind: "principal",
      id: installationAdministrator,
      issuer: "configuration-conformance",
      subject: installationAdministrator,
    });
    grantFixtureRole(iamState, installationAdministrator, {
      id: "managed-mode-installation-administrator",
      permissions: {
        installation: ["administer"],
        agent: ["create", "read", "update"],
        configuration: ["read"],
      },
    });
    // The denial names the one field that needs the grant (finding 2691).
    const denied = { status: 403, code: "FORBIDDEN", message: GATEWAY_MANAGED_MODE_DENIED };
    const refused = (work: () => Promise<unknown>) => refusedAnswer(work, { actorId: member });
    const create = (principalId: string, name: string, mode: boolean | undefined) =>
      controller.createAgent(principalId, {
        namespaceId: namespace.id,
        name,
        configurationId: configuration.id,
        ...(mode === undefined ? {} : { gatewayManagedMode: mode }),
      });
    const validate = (mode: boolean | undefined) =>
      controller.validateAgentCreate(member, {
        namespaceId: namespace.id,
        name: "Managed mode preflight",
        configuration: { kind: "agent", values: configuration.values },
        ...(mode === undefined ? {} : { gatewayManagedMode: mode }),
      });

    // Opting out at create, or in its preflight, is the Installation administrator's decision.
    assert.deepEqual(await refused(() => create(member, "Member opt-out", false)), denied);
    assert.deepEqual(await refused(() => validate(false)), denied);
    // The default and an explicit on need only the Agent create grant.
    await validate(undefined);
    await validate(true);
    assert.equal((await create(member, "Member default", undefined)).gatewayManagedMode, true);
    assert.equal((await create(member, "Member explicit on", true)).gatewayManagedMode, true);

    // Once an Installation administrator turns it off, turning it back on is a change too.
    const optedOut = await create(installationAdministrator, "Administrator opt-out", false);
    assert.equal(optedOut.gatewayManagedMode, false);
    const identity = { namespaceId: namespace.id, agentId: optedOut.id };
    assert.deepEqual(
      await refused(() =>
        controller.updateAgent(member, { ...identity, gatewayManagedMode: true }),
      ),
      denied,
    );
    // Sending the saved value changes nothing, so the member's ordinary update grant suffices.
    const unchanged = await controller.updateAgent(member, {
      ...identity,
      gatewayManagedMode: false,
    });
    assert.equal(unchanged.gatewayManagedMode, false);
    const enabled = await controller.updateAgent(installationAdministrator, {
      ...identity,
      gatewayManagedMode: true,
    });
    assert.equal(enabled.gatewayManagedMode, true);
  });
}
