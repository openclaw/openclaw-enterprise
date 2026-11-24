import type { UpdateAgentInput } from "../../packages/occ/src/index.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { requestFailure } from "../../apps/controller/src/http/errors.ts";
import {
  AgentCredentialSourceBindingError,
  AuthorizationDeniedError,
  CredentialGatewayNotConfiguredError,
  ResourceConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import {
  administrator,
  deployer,
  editor,
  fixture,
  zeroGrant,
} from "./credential-source-occ-fixture.ts";

export function registerHarnessAccessCases(): void {
  test("deploy admission freezes the source and requires the Agent principal to operate it", async () => {
    const {
      controller,
      dedicatedAgent,
      gateway,
      grantAgentSourceOperate,
      makeReady,
      modelSecret,
      namespace,
    } = await fixture();
    await makeReady();
    const secret = await modelSecret();
    const source = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai",
      type: "openai",
      secrets: { api_key: secret.ref },
    });
    const agent = await dedicatedAgent();
    await controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agent.configurationId,
      harnessAuth: { method: "credential_source", sourceId: source.id },
      credentialSources: [{ sourceId: source.id }],
    });
    const deploy = () =>
      controller.deployAgent(
        administrator,
        { namespaceId: namespace.id, agentId: agent.id },
        resolveApprovedDevelopmentHarness,
      );

    await assert.rejects(deploy(), AuthorizationDeniedError);
    grantAgentSourceOperate(agent, source);
    const revision = await deploy();
    assert.deepEqual(revision.harnessAuth, {
      method: "credential_source",
      sourceId: source.id,
      credentialGatewayId: gateway.id,
      sourceType: "openai",
      loginMode: "api_key",
    });
  });

  test("one credentialSources list binds every source, and harnessAuth names a listed one", async () => {
    const {
      controller,
      dedicatedAgent,
      gateway,
      grantAgentSourceOperate,
      makeReady,
      modelSecret,
      namespace,
    } = await fixture();
    await makeReady();
    const secret = await modelSecret();
    const model = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai",
      type: "openai",
      secrets: { api_key: secret.ref },
    });
    const otherModel = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai-other",
      type: "openai",
      secrets: { api_key: secret.ref },
    });
    // A type without Harness authentication, such as a registry token.
    const registry = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "registry",
      type: "registry",
      config: { host: "registry.example.com" },
    });
    const agent = await dedicatedAgent();
    const update = (
      principalId: string,
      fields: Omit<UpdateAgentInput, "namespaceId" | "agentId" | "configurationId">,
    ) =>
      controller.updateAgent(principalId, {
        namespaceId: namespace.id,
        agentId: agent.id,
        configurationId: agent.configurationId,
        ...fields,
      });

    // harnessAuth only points into the list, so the source it names must be listed. The
    // rule names itself as an invalid request instead of the generic not-found.
    const unlisted = await update(administrator, {
      harnessAuth: { method: "credential_source", sourceId: model.id },
      credentialSources: [{ sourceId: registry.id }],
    }).catch((error: unknown) => error);
    assert.ok(unlisted instanceof AgentCredentialSourceBindingError);
    assert.deepEqual(
      (({ status, code, message }) => ({ status, code, message }))(requestFailure(unlisted)),
      {
        status: 400,
        code: "INVALID_REQUEST",
        message: "The Harness credential source must be listed in the Agent's credentialSources.",
      },
    );
    await assert.rejects(
      update(administrator, {
        credentialSources: [{ sourceId: registry.id }, { sourceId: registry.id }],
      }),
      ScopeViolationError,
    );
    // Binding needs operate on the exact source, which an Agent editor alone lacks.
    await assert.rejects(
      update(editor, { credentialSources: [{ sourceId: registry.id }] }),
      AuthorizationDeniedError,
    );
    const bound = await update(administrator, {
      harnessAuth: { method: "credential_source", sourceId: model.id },
      credentialSources: [{ sourceId: model.id }, { sourceId: registry.id }],
    });
    assert.deepEqual(bound.credentialSources, [{ sourceId: model.id }, { sourceId: registry.id }]);
    // Dropping the Harness source from the list while harnessAuth still names it is refused.
    await assert.rejects(
      update(administrator, { credentialSources: [{ sourceId: registry.id }] }),
      AgentCredentialSourceBindingError,
    );

    // Admission rechecks every listed source for the Agent principal.
    const deploy = () =>
      controller.deployAgent(
        administrator,
        { namespaceId: namespace.id, agentId: agent.id },
        resolveApprovedDevelopmentHarness,
      );
    grantAgentSourceOperate(agent, model);
    await assert.rejects(deploy(), AuthorizationDeniedError);
    grantAgentSourceOperate(agent, registry, "registry");
    const revision = await deploy();
    assert.equal(revision.harnessAuth.method, "credential_source");
    assert.equal(revision.harnessAuth.sourceId, model.id);
    assert.deepEqual(revision.credentialSources, [
      { sourceId: model.id, credentialGatewayId: gateway.id, sourceType: "openai" },
      { sourceId: registry.id, credentialGatewayId: gateway.id, sourceType: "registry" },
    ]);
    await controller.transact((unit) =>
      unit.agents.compareAndSetActiveRevision(namespace.id, agent.id, undefined, revision.id),
    );

    // Both the draft and the active revision keep the source referenced.
    await assert.rejects(
      controller.deleteCredentialSource(administrator, namespace.id, registry.id),
      ResourceConflictError,
    );
    // Any listed source on the active revision can be withdrawn.
    const withdrawal = await controller.withdrawAgentCredentialSource(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      credentialSourceId: registry.id,
    });
    assert.equal(withdrawal.revisionId, revision.id);

    // A model-type source that harnessAuth does not name is an ordinary listed credential.
    await update(administrator, {
      credentialSources: [{ sourceId: model.id }, { sourceId: otherModel.id }],
    });
    grantAgentSourceOperate(agent, otherModel, "other-model");
    const toolRevision = await deploy();
    assert.deepEqual(
      toolRevision.credentialSources?.map(({ sourceId }) => sourceId),
      [model.id, otherModel.id],
    );

    // Clearing the list requires clearing the Harness binding that points into it.
    const cleared = await update(administrator, { harnessAuth: null, credentialSources: [] });
    assert.equal(cleared.credentialSources, undefined);
  });

  test("the listing rule answers only after every source authorization", async () => {
    const { controller, dedicatedAgent, iamState, makeReady, modelSecret, namespace } =
      await fixture();
    await makeReady();
    const secret = await modelSecret();
    const model = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai",
      type: "openai",
      secrets: { api_key: secret.ref },
    });
    const registry = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "registry",
      type: "registry",
      config: { host: "registry.example.com" },
    });
    const agent = await dedicatedAgent();
    const unlisted = {
      harnessAuth: { method: "credential_source", sourceId: model.id },
      credentialSources: [{ sourceId: registry.id }],
    } satisfies Omit<UpdateAgentInput, "namespaceId" | "agentId" | "configurationId">;
    const update = (principalId: string) =>
      controller.updateAgent(principalId, {
        namespaceId: namespace.id,
        agentId: agent.id,
        configurationId: agent.configurationId,
        ...unlisted,
      });
    const create = (principalId: string) =>
      controller.createAgent(principalId, {
        namespaceId: namespace.id,
        name: `unlisted-${crypto.randomUUID()}`,
        configurationId: agent.configurationId,
        executionMode: "dedicated",
        ...unlisted,
      });
    // An Agent editor without operate on any source gets 403, not the listing rule.
    await assert.rejects(update(editor), (error) => {
      assert.ok(error instanceof AuthorizationDeniedError);
      assert.equal(requestFailure(error).status, 403);
      return true;
    });
    // operate on a listed source is checked before the rule, too.
    iamState.restrictions.push({
      id: "deny-registry-operate",
      namespaceId: namespace.id,
      action: "operate",
      resourceKind: "credential_source",
      resourceId: registry.id,
      effect: "deny",
    });
    for (const write of [update, create]) {
      await assert.rejects(write(administrator), (error) => {
        assert.ok(error instanceof AuthorizationDeniedError);
        assert.equal(error.authorization?.resource.id, registry.id);
        return true;
      });
    }
    iamState.restrictions.pop();
    for (const write of [update, create]) {
      await assert.rejects(write(administrator), AgentCredentialSourceBindingError);
    }
  });

  test("binding without a Credential Gateway is a 409 after operate, whether or not the source exists", async () => {
    const { controller, dedicatedAgent, makeReady, namespace } = await fixture({
      withoutGateway: true,
    });
    await makeReady();
    const agent = await dedicatedAgent();
    // A stored source the Installation can no longer serve: the answer must match a missing one.
    const stored = await controller.transact((unit) =>
      unit.credentialSources.createCredentialSource({
        id: `cs_${crypto.randomUUID()}`,
        namespaceId: namespace.id,
        name: "stored",
        type: "registry",
        config: { host: "registry.example.com" },
        secrets: {},
        ownerCapability: "credential_gateway",
        driverId: "credential-gateway-test",
        state: "ready",
        createdAt: "2026-09-27T12:00:00.000Z",
      }),
    );
    const writes = (sourceId: string) => ({
      "list on update": (principalId: string) =>
        controller.updateAgent(principalId, {
          namespaceId: namespace.id,
          agentId: agent.id,
          configurationId: agent.configurationId,
          credentialSources: [{ sourceId }],
        }),
      "Harness source on update": (principalId: string) =>
        controller.updateAgent(principalId, {
          namespaceId: namespace.id,
          agentId: agent.id,
          configurationId: agent.configurationId,
          harnessAuth: { method: "credential_source", sourceId },
          credentialSources: [{ sourceId }],
        }),
      "unlisted Harness source on update": (principalId: string) =>
        controller.updateAgent(principalId, {
          namespaceId: namespace.id,
          agentId: agent.id,
          configurationId: agent.configurationId,
          harnessAuth: { method: "credential_source", sourceId },
        }),
      "list on create": (principalId: string) =>
        controller.createAgent(principalId, {
          namespaceId: namespace.id,
          name: `no-gateway-${crypto.randomUUID()}`,
          configurationId: agent.configurationId,
          executionMode: "dedicated",
          credentialSources: [{ sourceId }],
        }),
    });
    const outcome = async (
      write: (principalId: string) => Promise<unknown>,
      principalId: string,
    ) => {
      const error = await write(principalId).then(
        () => assert.fail("binding without a Credential Gateway succeeded"),
        (rejection: unknown) => rejection,
      );
      const { status, code, message } = requestFailure(error);
      return {
        status,
        code,
        message,
        gateway: error instanceof CredentialGatewayNotConfiguredError,
      };
    };
    for (const sourceId of [stored.id, `cs_${crypto.randomUUID()}`]) {
      for (const [name, write] of Object.entries(writes(sourceId))) {
        const administered = await outcome(write, administrator);
        assert.equal(administered.gateway, true, `${name}, ${sourceId}`);
        assert.equal(administered.status, 409, `${name}, ${sourceId}`);
        assert.equal(
          administered.code,
          "CREDENTIAL_GATEWAY_NOT_CONFIGURED",
          `${name}, ${sourceId}`,
        );
        // The Agent editor holds no grant on any source: 403 for both, so neither the source
        // nor the Installation's gateway selection leaks.
        const denied = await outcome(write, editor);
        assert.deepEqual(
          { status: denied.status, code: denied.code },
          { status: 403, code: "FORBIDDEN" },
          `${name}, ${sourceId}`,
        );
      }
    }
    assert.equal(
      (await controller.getAgent(administrator, namespace.id, agent.id)).credentialSources,
      undefined,
    );

    // An Agent whose stored binding outlived the gateway: deploy names the fix, and an update
    // that binds nothing new still needs operate on every bound source but no gateway.
    await controller.transact((unit) =>
      unit.agents.updateConfiguration(
        namespace.id,
        agent.id,
        agent.configurationId,
        undefined,
        { method: "credential_source", sourceId: stored.id },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [{ sourceId: stored.id }],
      ),
    );
    const deploy = (principalId: string) =>
      controller.deployAgent(
        principalId,
        { namespaceId: namespace.id, agentId: agent.id },
        resolveApprovedDevelopmentHarness,
      );
    const administered = await outcome(deploy, administrator);
    assert.equal(administered.gateway, true);
    assert.equal(administered.status, 409);
    assert.equal((await outcome(deploy, editor)).status, 403);
    const update = (
      principalId: string,
      fields: Omit<UpdateAgentInput, "namespaceId" | "agentId" | "configurationId"> = {},
    ) =>
      controller.updateAgent(principalId, {
        namespaceId: namespace.id,
        agentId: agent.id,
        configurationId: agent.configurationId,
        ...fields,
      });
    const drop: Omit<UpdateAgentInput, "namespaceId" | "agentId" | "configurationId"> = {
      harnessAuth: { method: "runtime" },
      credentialSources: [],
    };
    assert.equal((await outcome(update, editor)).status, 403);
    assert.equal((await outcome((principalId) => update(principalId, drop), editor)).status, 403);
    assert.deepEqual((await update(administrator)).credentialSources, [{ sourceId: stored.id }]);
    const dropped = await update(administrator, drop);
    assert.deepEqual(
      { harnessAuth: dropped.harnessAuth, credentialSources: dropped.credentialSources },
      { harnessAuth: { method: "runtime" }, credentialSources: undefined },
    );
  });

  test("deploying credential sources without a Sandbox Driver is a 409 naming the driver, after agent:deploy", async () => {
    const { controller, dedicatedAgent, iamState, makeReady, namespace } = await fixture({
      withoutSandbox: true,
    });
    await makeReady();
    const source = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "registry",
      type: "registry",
      config: { host: "registry.example.com" },
      secrets: {},
    });
    const agent = await dedicatedAgent();
    await controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agent.configurationId,
      harnessAuth: { method: "runtime" },
      credentialSources: [{ sourceId: source.id }],
    });
    const deploy = (principalId: string) =>
      controller.deployAgent(
        principalId,
        { namespaceId: namespace.id, agentId: agent.id },
        resolveApprovedDevelopmentHarness,
      );
    const outcome = async (principalId: string) => {
      const error = await deploy(principalId).then(
        () => assert.fail("deploying credential sources without a Sandbox Driver succeeded"),
        (rejection: unknown) => rejection,
      );
      const { status, code, message } = requestFailure(error);
      return { status, code, message };
    };
    const refusal = {
      status: 409,
      code: "RESOURCE_CONFLICT",
      message: "Agent credential sources require a selected Sandbox Driver.",
    };
    assert.deepEqual(await outcome(administrator), refusal);
    // Like the other capability refusals on deploy, the missing driver is an Installation
    // property that precedes source grants: a deployer without operate on the source gets the
    // same answer. A caller without agent:deploy still gets 403 before any of it.
    iamState.restrictions.push({
      id: "deny-source-operate",
      namespaceId: namespace.id,
      action: "operate",
      resourceKind: "credential_source",
      resourceId: source.id,
      effect: "deny",
    });
    // The restriction takes effect: binding the source is now denied.
    await assert.rejects(
      controller.updateAgent(administrator, {
        namespaceId: namespace.id,
        agentId: agent.id,
        configurationId: agent.configurationId,
        credentialSources: [{ sourceId: source.id }],
      }),
      AuthorizationDeniedError,
    );
    assert.deepEqual(await outcome(administrator), refusal);
    iamState.restrictions.pop();
    const denied = await outcome(editor);
    assert.deepEqual(
      { status: denied.status, code: denied.code },
      { status: 403, code: "FORBIDDEN" },
    );
  });

  test("Namespace IAM delegates operate on an exact credential source to an Agent principal", async () => {
    const { controller, dedicatedAgent, makeReady, modelSecret, namespace } = await fixture();
    await makeReady();
    const secret = await modelSecret();
    const source = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai",
      type: "openai",
      secrets: { api_key: secret.ref },
    });
    const agent = await dedicatedAgent();
    // Operators grant deployment access through the Namespace IAM API, so the policy surface
    // must accept credential_source Roles and exact source targets like other Namespace kinds.
    const role = await controller.createIAMRole(administrator, {
      namespaceId: namespace.id,
      name: "Use a credential source",
      permissions: [{ action: "operate", resourceKind: "credential_source" }],
    });
    const binding = await controller.createIAMAccessBinding(administrator, {
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: agent.servicePrincipalId,
      roleId: role.id,
      resourceKind: "credential_source",
      resourceId: source.id,
    });
    assert.equal(binding.resourceId, source.id);
    // A target outside the Namespace's credential sources is refused before policy is written.
    await assert.rejects(
      controller.createIAMAccessBinding(administrator, {
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: agent.servicePrincipalId,
        roleId: role.id,
        resourceKind: "credential_source",
        resourceId: "cs_00000000-0000-4000-8000-000000000000",
      }),
      ScopeViolationError,
    );
  });

  test("listing credential sources requires Namespace read before filtering each source", async () => {
    const { controller, makeReady, modelSecret, namespace } = await fixture();
    await makeReady();
    const secret = await modelSecret();
    const source = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai",
      type: "openai",
      secrets: { api_key: secret.ref },
    });
    // Without Namespace read, an existing and a missing Namespace are indistinguishable.
    for (const namespaceId of [namespace.id, "ns_00000000-0000-4000-8000-000000000000"]) {
      await assert.rejects(
        controller.listCredentialSources(zeroGrant, namespaceId),
        AuthorizationDeniedError,
      );
    }
    const listed = await controller.listCredentialSources(deployer, namespace.id);
    assert.deepEqual(
      listed.map(({ id }) => id),
      [source.id],
    );
  });

  test("a selected Credential Gateway rejects Secret-backed Harness authentication", async () => {
    const { controller, dedicatedAgent, makeReady, modelSecret, namespace } = await fixture();
    await makeReady();
    const secret = await modelSecret();
    const agent = await dedicatedAgent();
    await controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agent.configurationId,
      harnessAuth: { method: "api_key", source: secret.ref },
    });
    // There is no environment-delivery fallback once a gateway owns model credentials.
    await assert.rejects(
      controller.deployAgent(
        administrator,
        { namespaceId: namespace.id, agentId: agent.id },
        resolveApprovedDevelopmentHarness,
      ),
      /requires credential-source Harness authentication/,
    );
  });

  test("binding a credential source as Harness authentication requires operate on it", async () => {
    const { controller, dedicatedAgent, iamState, makeReady, modelSecret, namespace } =
      await fixture();
    await makeReady();
    const secret = await modelSecret();
    const source = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai",
      type: "openai",
      secrets: { api_key: secret.ref },
    });
    const agent = await dedicatedAgent();
    const bindSource = () =>
      controller.updateAgent(administrator, {
        namespaceId: namespace.id,
        agentId: agent.id,
        configurationId: agent.configurationId,
        harnessAuth: { method: "credential_source", sourceId: source.id },
        credentialSources: [{ sourceId: source.id }],
      });
    // The administrator may update the Agent but is denied operate on this one source.
    iamState.restrictions.push({
      id: "deny-source-operate",
      namespaceId: namespace.id,
      action: "operate",
      resourceKind: "credential_source",
      resourceId: source.id,
      effect: "deny",
    });
    await assert.rejects(bindSource(), (error) => {
      assert.ok(error instanceof AuthorizationDeniedError);
      assert.deepEqual(error.authorization, {
        action: "operate",
        resource: { kind: "credential_source", namespaceId: namespace.id, id: source.id },
      });
      return true;
    });
    assert.equal(
      (await controller.getAgent(administrator, namespace.id, agent.id)).harnessAuth ?? null,
      agent.harnessAuth ?? null,
    );
    iamState.restrictions.pop();
    assert.deepEqual((await bindSource()).harnessAuth, {
      method: "credential_source",
      sourceId: source.id,
    });
  });
}
