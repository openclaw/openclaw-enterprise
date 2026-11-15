import type { CredentialSourceMetadata } from "../../packages/contracts/src/index.ts";
import type { UpdateAgentInput } from "../../packages/occ/src/index.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { requestFailure } from "../../apps/controller/src/http/errors.ts";
import {
  AuthorizationDeniedError,
  CredentialGatewayNotConfiguredError,
  CredentialSourceDriverError,
  CredentialSourceTypeNotOfferedError,
  DependencyUnavailableError,
  ResourceConflictError,
} from "../../packages/occ/src/index.ts";
import { CREDENTIAL_SOURCE_DRIVER_CHANGED } from "../helpers/refusal-text.mjs";
import { administrator, editor, fixture, zeroGrant } from "./credential-source-occ-fixture.ts";

export function registerAgentAdmissionCases(): void {
  test("an Agent's credentialSources list is validated, and binding or unbinding needs operate", async () => {
    const { controller, dedicatedAgent, iamState, makeReady, namespace } = await fixture();
    await makeReady();
    const registry = (name: string) =>
      controller.createCredentialSource(administrator, {
        namespaceId: namespace.id,
        name,
        type: "registry",
        config: { host: `${name}.example.com` },
      });
    const kept = await registry("registry-kept");
    const added = await registry("registry-added");
    const agent = await dedicatedAgent();
    const update = (credentialSources: NonNullable<UpdateAgentInput["credentialSources"]>) =>
      controller.updateAgent(administrator, {
        namespaceId: namespace.id,
        agentId: agent.id,
        configurationId: agent.configurationId,
        credentialSources,
      });
    const invalid = {
      name: "ScopeViolationError",
      message: "The Agent credential sources are invalid.",
    };

    // The controller enforces the list grammar itself, whatever the store would accept.
    const tooMany = Array.from({ length: 65 }, () => ({ sourceId: `cs_${crypto.randomUUID()}` }));
    await assert.rejects(update(tooMany), invalid);
    // @ts-expect-error OCC must reject an unexpected member in an otherwise valid binding.
    await assert.rejects(update([{ sourceId: kept.id, type: "registry" }]), invalid);
    // @ts-expect-error OCC must reject a nonstring source ID at runtime.
    await assert.rejects(update([{ sourceId: 7 }]), invalid);
    await assert.rejects(update([{ sourceId: "" }]), invalid);
    // @ts-expect-error OCC must reject a binding object in place of a list.
    await assert.rejects(update({ sourceId: kept.id }), invalid);
    await assert.rejects(update([{ sourceId: kept.id }, { sourceId: kept.id }]), invalid);

    // Creating an Agent that lists a source needs operate on that exact source.
    const denyOperate = (source: Pick<CredentialSourceMetadata, "id">) =>
      iamState.restrictions.push({
        id: `deny-operate-${source.id}`,
        namespaceId: namespace.id,
        action: "operate",
        resourceKind: "credential_source",
        resourceId: source.id,
        effect: "deny",
      });
    denyOperate(added);
    await assert.rejects(
      controller.createAgent(administrator, {
        namespaceId: namespace.id,
        name: `listed-${crypto.randomUUID()}`,
        configurationId: agent.configurationId,
        executionMode: "dedicated",
        credentialSources: [{ sourceId: added.id }],
      }),
      (error) => {
        assert.ok(error instanceof AuthorizationDeniedError);
        assert.deepEqual(error.authorization?.resource, {
          kind: "credential_source",
          namespaceId: namespace.id,
          id: added.id,
        });
        return true;
      },
    );
    iamState.restrictions.length = 0;

    // Unbinding a source needs operate on it too: a caller who lost operate on the bound source
    // cannot swap it out for another one.
    assert.deepEqual((await update([{ sourceId: kept.id }])).credentialSources, [
      { sourceId: kept.id },
    ]);
    denyOperate(kept);
    await assert.rejects(update([{ sourceId: added.id }]), (error) => {
      assert.ok(error instanceof AuthorizationDeniedError);
      assert.equal(error.authorization?.resource.id, kept.id);
      return true;
    });
    assert.deepEqual(
      (await controller.getAgent(administrator, namespace.id, agent.id)).credentialSources,
      [{ sourceId: kept.id }],
    );
    iamState.restrictions.length = 0;
    assert.deepEqual((await update([{ sourceId: added.id }])).credentialSources, [
      { sourceId: added.id },
    ]);
    const created = await controller.createAgent(administrator, {
      namespaceId: namespace.id,
      name: `listed-${crypto.randomUUID()}`,
      configurationId: agent.configurationId,
      executionMode: "dedicated",
      credentialSources: [{ sourceId: added.id }, { sourceId: kept.id }],
    });
    assert.deepEqual(created.credentialSources, [{ sourceId: added.id }, { sourceId: kept.id }]);

    // The controller names the listing rule itself; the store's own check is a backstop with
    // another message. Only the message is pinned, so the error class can still change.
    const listed = {
      message: "The Harness credential source must be listed in the Agent's credentialSources.",
    };
    const model = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai",
      type: "openai",
      secrets: {
        api_key: (
          await controller.createSecret(administrator, {
            namespaceId: namespace.id,
            name: `model-key-${crypto.randomUUID()}`,
            value: "synthetic-model-key",
          })
        ).ref,
      },
    });
    const harnessAuth = { method: "credential_source", sourceId: model.id } as const;
    const updateFields = (
      fields: Omit<UpdateAgentInput, "namespaceId" | "agentId" | "configurationId">,
    ) =>
      controller.updateAgent(administrator, {
        namespaceId: namespace.id,
        agentId: agent.id,
        configurationId: agent.configurationId,
        ...fields,
      });
    await assert.rejects(updateFields({ harnessAuth }), listed);
    await assert.rejects(
      updateFields({ harnessAuth, credentialSources: [{ sourceId: added.id }] }),
      listed,
    );
    await updateFields({ harnessAuth, credentialSources: [{ sourceId: model.id }] });
    await assert.rejects(updateFields({ credentialSources: [{ sourceId: added.id }] }), listed);
  });

  test("binding refuses a missing, deleting, other-Namespace or foreign-gateway source", async () => {
    let failRemove = false;
    const { controller, dedicatedAgent, gateway, makeReady, namespace } = await fixture({
      gateway: { removeError: () => (failRemove ? new Error("gateway unavailable") : undefined) },
    });
    await makeReady();
    const registry = (name: string) =>
      controller.createCredentialSource(administrator, {
        namespaceId: namespace.id,
        name,
        type: "registry",
        config: { host: `${name}.example.com` },
      });
    const deleting = await registry("registry-deleting");
    const ready = await registry("registry-ready");
    const agent = await dedicatedAgent();
    const bind = (sourceId: string) =>
      controller.updateAgent(administrator, {
        namespaceId: namespace.id,
        agentId: agent.id,
        configurationId: agent.configurationId,
        credentialSources: [{ sourceId }],
      });
    const unavailable = {
      name: "ScopeViolationError",
      message: "The credential source is unavailable in the exact Namespace.",
    };
    await assert.rejects(bind("cs_00000000-0000-4000-8000-00000000ffff"), unavailable);
    // A ready source of another Namespace is not in the Agent's Namespace.
    const other = await controller.createNamespace(administrator, { name: "Other source tenant" });
    await controller.handleNamespaceLifecycle(administrator, other.id, "ready");
    const foreign = await controller.createCredentialSource(administrator, {
      namespaceId: other.id,
      name: "registry-foreign",
      type: "registry",
      config: { host: "registry-foreign.example.com" },
    });
    await assert.rejects(bind(foreign.id), unavailable);
    failRemove = true;
    await assert.rejects(
      controller.deleteCredentialSource(administrator, namespace.id, deleting.id),
      DependencyUnavailableError,
    );
    // A source being deleted still exists, but it can no longer be newly bound.
    await assert.rejects(bind(deleting.id), unavailable);
    // A source registered through a gateway that is no longer selected cannot be bound.
    controller.registerDriver({ ...gateway, id: "credential-gateway-replacement" });
    controller.selectDriver("credential_gateway", "credential-gateway-replacement");
    await assert.rejects(bind(ready.id), DependencyUnavailableError);
    assert.equal(
      (await controller.getAgent(administrator, namespace.id, agent.id)).credentialSources,
      undefined,
    );
  });

  test("after a Credential Gateway change an Agent update can drop the old sources but not keep them", async () => {
    const { controller, dedicatedAgent, gateway, iamState, makeReady, modelSecret, namespace } =
      await fixture();
    await makeReady();
    const model = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai-old",
      type: "openai",
      secrets: { api_key: (await modelSecret()).ref },
    });
    const registry = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "registry-old",
      type: "registry",
      config: { host: "registry-old.example.com" },
    });
    const agent = await dedicatedAgent();
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
    const oldHarnessAuth = { method: "credential_source", sourceId: model.id } as const;
    await update(administrator, {
      harnessAuth: oldHarnessAuth,
      credentialSources: [{ sourceId: model.id }, { sourceId: registry.id }],
    });

    // The Installation re-selects its Credential Gateway; the old sources stay stored and ready.
    controller.registerDriver({ ...gateway, id: "credential-gateway-replacement" });
    controller.selectDriver("credential_gateway", "credential-gateway-replacement");
    const stored = async () => {
      const current = await controller.getAgent(administrator, namespace.id, agent.id);
      return { harnessAuth: current.harnessAuth, credentialSources: current.credentialSources };
    };
    const before = await stored();

    // Keeping an old-gateway source bound is still refused: deploy could not admit it.
    await assert.rejects(
      update(administrator, { credentialSources: [{ sourceId: model.id }] }),
      DependencyUnavailableError,
    );
    await assert.rejects(
      update(administrator, {
        harnessAuth: { method: "runtime" },
        credentialSources: [{ sourceId: registry.id }],
      }),
      DependencyUnavailableError,
    );
    await assert.rejects(
      update(administrator, { harnessAuth: oldHarnessAuth }),
      DependencyUnavailableError,
    );
    assert.deepEqual(await stored(), before);

    // Dropping a bound source still needs operate on it, and is denied before any lookup,
    // including the lookup of a requested source that does not exist.
    iamState.restrictions.push({
      id: `deny-operate-${registry.id}`,
      namespaceId: namespace.id,
      action: "operate",
      resourceKind: "credential_source",
      resourceId: registry.id,
      effect: "deny",
    });
    const drop: Omit<UpdateAgentInput, "namespaceId" | "agentId" | "configurationId"> = {
      harnessAuth: { method: "runtime" },
      credentialSources: [],
    };
    const missing = "cs_00000000-0000-4000-8000-00000000ffff";
    const missingSource = {
      harnessAuth: { method: "credential_source" as const, sourceId: missing },
      credentialSources: [{ sourceId: missing }],
    };
    for (const fields of [{}, drop, missingSource]) {
      await assert.rejects(update(administrator, fields), (error) => {
        assert.ok(error instanceof AuthorizationDeniedError);
        assert.deepEqual(error.authorization?.resource, {
          kind: "credential_source",
          namespaceId: namespace.id,
          id: registry.id,
        });
        return true;
      });
      assert.equal(
        requestFailure(await update(editor, fields).catch((e: unknown) => e)).status,
        403,
      );
    }
    iamState.restrictions.length = 0;
    assert.deepEqual(await stored(), before);

    // An update that binds nothing new succeeds, and so does one that drops the old sources.
    assert.deepEqual(
      (await update(administrator, { executionMode: "dedicated" })).credentialSources,
      [{ sourceId: model.id }, { sourceId: registry.id }],
    );
    // Leaving the list out keeps the old sources, which deploy admission still refuses.
    const implicitlyKept = await update(administrator, { harnessAuth: { method: "runtime" } });
    assert.deepEqual(implicitlyKept.credentialSources, before.credentialSources);
    await assert.rejects(
      controller.deployAgent(
        administrator,
        { namespaceId: namespace.id, agentId: agent.id },
        resolveApprovedDevelopmentHarness,
      ),
      DependencyUnavailableError,
    );
    const dropped = await update(administrator, drop);
    assert.deepEqual(
      { harnessAuth: dropped.harnessAuth, credentialSources: dropped.credentialSources },
      { harnessAuth: { method: "runtime" }, credentialSources: undefined },
    );

    // A source registered through the new gateway binds as usual.
    const replacement = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai-new",
      type: "openai",
      secrets: { api_key: (await modelSecret()).ref },
    });
    const rebound = await update(administrator, {
      harnessAuth: { method: "credential_source", sourceId: replacement.id },
      credentialSources: [{ sourceId: replacement.id }],
    });
    assert.deepEqual(rebound.credentialSources, [{ sourceId: replacement.id }]);
  });

  test("deploy admission rechecks every listed source for the deployer, Sandbox and gateway catalog", async () => {
    const {
      controller,
      dedicatedAgent,
      gateway,
      grantAgentSourceOperate,
      iamState,
      makeReady,
      modelSecret,
      namespace,
    } = await fixture();
    await makeReady();
    const model = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai",
      type: "openai",
      secrets: { api_key: (await modelSecret()).ref },
    });
    const source = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "registry",
      type: "registry",
      config: { host: "registry.example.com" },
    });
    const agent = await dedicatedAgent();
    await controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agent.configurationId,
      harnessAuth: { method: "credential_source", sourceId: model.id },
      credentialSources: [{ sourceId: model.id }, { sourceId: source.id }],
    });
    grantAgentSourceOperate(agent, model);
    grantAgentSourceOperate(agent, source, "registry");
    const deploy = () =>
      controller.deployAgent(
        administrator,
        { namespaceId: namespace.id, agentId: agent.id },
        resolveApprovedDevelopmentHarness,
      );

    // The Agent principal's grant is not enough: the deploying caller must still operate it.
    const sourceless = "principal-deployer-without-source-operate";
    const administratorRole = iamState.roles.find(({ id }) => id === "source-administrator-role");
    assert.ok(administratorRole);
    iamState.identities.push({
      kind: "principal",
      id: sourceless,
      issuer: "credential-source-occ",
      subject: sourceless,
    });
    iamState.roles.push({
      id: "deployer-without-source-operate-role",
      permissions: administratorRole.permissions.filter(
        ({ action, resourceKind }) =>
          !(action === "operate" && resourceKind === "credential_source"),
      ),
    });
    iamState.bindings.push(
      {
        id: "deployer-without-source-operate-binding",
        subjectKind: "identity",
        subjectId: sourceless,
        roleId: "deployer-without-source-operate-role",
      },
      {
        id: "deployer-model-operate-binding",
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: sourceless,
        roleId: "source-agent-role",
        resourceKind: "credential_source",
        resourceId: model.id,
      },
    );
    await assert.rejects(
      controller.deployAgent(
        sourceless,
        { namespaceId: namespace.id, agentId: agent.id },
        resolveApprovedDevelopmentHarness,
      ),
      (error) => {
        assert.ok(error instanceof AuthorizationDeniedError);
        assert.deepEqual(error.authorization, {
          action: "operate",
          resource: { kind: "credential_source", namespaceId: namespace.id, id: source.id },
        });
        return true;
      },
    );

    // A source type the selected gateway no longer offers is not frozen into a revision.
    const listSourceTypes = gateway.listSourceTypes;
    gateway.listSourceTypes = async (context) =>
      (await listSourceTypes(context)).filter(({ type }) => type !== "registry");
    await assert.rejects(deploy(), CredentialSourceTypeNotOfferedError);
    gateway.listSourceTypes = listSourceTypes;
    assert.deepEqual((await deploy()).credentialSources, [
      { sourceId: model.id, credentialGatewayId: gateway.id, sourceType: "openai" },
      { sourceId: source.id, credentialGatewayId: gateway.id, sourceType: "registry" },
    ]);

    // Only a Sandbox Driver can carry listed sources into the runtime.
    const unsandboxed = await fixture({ withoutSandbox: true });
    await unsandboxed.makeReady();
    const unsandboxedSource = await unsandboxed.controller.createCredentialSource(administrator, {
      namespaceId: unsandboxed.namespace.id,
      name: "registry",
      type: "registry",
      config: { host: "registry.example.com" },
    });
    const unsandboxedAgent = await unsandboxed.dedicatedAgent();
    await unsandboxed.controller.updateAgent(administrator, {
      namespaceId: unsandboxed.namespace.id,
      agentId: unsandboxedAgent.id,
      configurationId: unsandboxedAgent.configurationId,
      harnessAuth: { method: "runtime" },
      credentialSources: [{ sourceId: unsandboxedSource.id }],
    });
    unsandboxed.grantAgentSourceOperate(unsandboxedAgent, unsandboxedSource);
    await assert.rejects(
      unsandboxed.controller.deployAgent(
        administrator,
        { namespaceId: unsandboxed.namespace.id, agentId: unsandboxedAgent.id },
        resolveApprovedDevelopmentHarness,
      ),
      {
        name: "ResourceStateConflictError",
        message: "Agent credential sources require a selected Sandbox Driver.",
      },
    );
  });

  test("a source type the gateway stops offering is a 409 naming the fix, after the grant and lookup", async () => {
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
    const model = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai",
      type: "openai",
      secrets: { api_key: (await modelSecret()).ref },
    });
    const tool = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "registry",
      type: "registry",
      config: { host: "registry.example.com" },
    });
    const agent = await dedicatedAgent();
    await controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agent.configurationId,
      harnessAuth: { method: "credential_source", sourceId: model.id },
      credentialSources: [{ sourceId: model.id }, { sourceId: tool.id }],
    });
    grantAgentSourceOperate(agent, model);
    grantAgentSourceOperate(agent, tool, "registry");
    const deploy = (principal = administrator) =>
      controller.deployAgent(
        principal,
        { namespaceId: namespace.id, agentId: agent.id },
        resolveApprovedDevelopmentHarness,
      );
    const update = (principal = administrator) =>
      controller.updateCredentialSource(principal, {
        namespaceId: namespace.id,
        credentialSourceId: tool.id,
      });
    const register = (principal = administrator) =>
      controller.createCredentialSource(principal, {
        namespaceId: namespace.id,
        name: "registry-2",
        type: "registry",
        config: { host: "registry.example.com" },
      });
    // The sources exist, so a generic "not found" would mislead (D548): the answer names the
    // Installation setting to restore, the way OpenShell drops bearer-token without toolBinaries.
    const notOffered = (error: unknown) => {
      assert.ok(error instanceof CredentialSourceTypeNotOfferedError, String(error));
      const failure = requestFailure(error);
      assert.deepEqual(
        { status: failure.status, code: failure.code, message: failure.message },
        {
          status: 409,
          code: "RESOURCE_CONFLICT",
          // Fixed text that names the Installation setting and where it is documented.
          message:
            "The Credential Gateway does not offer this credential source type. An Installation administrator must enable it, for example toolBinaries for OpenShell bearer-token; see https://docs-enterprise.openclaw.org/reference/drivers/openshell-credential-gateway/",
        },
      );
      return true;
    };
    const offered = gateway.listSourceTypes;
    const withdrawType = (type: string) => {
      gateway.listSourceTypes = async (context) =>
        (await offered(context)).filter((entry) => entry.type !== type);
    };

    withdrawType("registry");
    const updatesBefore = gateway.calls.filter(({ operation }) => operation === "updateSource");
    await assert.rejects(update(), notOffered);
    await assert.rejects(register(), notOffered);
    await assert.rejects(deploy(), notOffered);
    assert.deepEqual(
      gateway.calls.filter(({ operation }) => operation === "updateSource"),
      updatesBefore,
    );
    // The catalog is an Installation property, but callers without the grant still learn nothing.
    for (const call of [update, register, deploy]) {
      await assert.rejects(call(zeroGrant), AuthorizationDeniedError);
    }

    // The Harness source's type is checked the same way.
    withdrawType("openai");
    await assert.rejects(deploy(), notOffered);

    // Offering the type again restores every path.
    gateway.listSourceTypes = offered;
    assert.deepEqual((await update()).status, { state: "ready" });
    assert.equal((await deploy()).credentialSources?.length, 2);
  });

  test("after a Credential Gateway change, every path refuses an old source with one fixed message and DELETE keeps it ready", async () => {
    const {
      controller,
      dedicatedAgent,
      gateway,
      makeReady,
      modelSecret,
      namespace,
      passRegistrationFence,
    } = await fixture();
    await makeReady();
    const registry = (name: string) =>
      controller.createCredentialSource(administrator, {
        namespaceId: namespace.id,
        name,
        type: "registry",
        config: { host: `${name}.example.com` },
      });
    const bound = await registry("registry-bound");
    const unbound = await registry("registry-unbound");
    const model = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai-old",
      type: "openai",
      secrets: { api_key: (await modelSecret()).ref },
    });
    // A source an earlier deletion left `deleting` through the old gateway, as before this fix.
    const stuck = await controller.transact((unit) =>
      unit.credentialSources.createCredentialSource({
        id: `cs_${crypto.randomUUID()}`,
        namespaceId: namespace.id,
        name: "registry-stuck",
        type: "registry",
        config: { host: "registry-stuck.example.com" },
        secrets: {},
        ownerCapability: "credential_gateway",
        driverId: gateway.id,
        state: "deleting",
        createdAt: "2026-09-27T12:00:00.000Z",
      }),
    );
    const agent = await dedicatedAgent();
    const update = (
      fields: Omit<UpdateAgentInput, "namespaceId" | "agentId" | "configurationId">,
    ) =>
      controller.updateAgent(administrator, {
        namespaceId: namespace.id,
        agentId: agent.id,
        configurationId: agent.configurationId,
        ...fields,
      });
    await update({
      harnessAuth: { method: "runtime" },
      credentialSources: [{ sourceId: bound.id }],
    });

    controller.registerDriver({ ...gateway, id: "credential-gateway-replacement" });
    controller.selectDriver("credential_gateway", "credential-gateway-replacement");
    const removals = () => gateway.calls.filter(({ operation }) => operation === "removeSource");
    const removalsBefore = removals().length;
    const ownership = (error: unknown) => {
      assert.ok(error instanceof CredentialSourceDriverError, String(error));
      const { status, code, message } = requestFailure(error);
      assert.deepEqual(
        { status, code, message },
        {
          status: 503,
          code: "DEPENDENCY_UNAVAILABLE",
          message: CREDENTIAL_SOURCE_DRIVER_CHANGED,
        },
      );
      assert.doesNotMatch(message, /cs_|credential-gateway-/);
      return true;
    };
    // Bind (list and Harness), deploy admission, update and delete all name the same fix.
    await assert.rejects(
      update({ credentialSources: [{ sourceId: bound.id }, { sourceId: unbound.id }] }),
      ownership,
    );
    await assert.rejects(
      update({
        harnessAuth: { method: "credential_source", sourceId: model.id },
        credentialSources: [{ sourceId: model.id }],
      }),
      ownership,
    );
    await assert.rejects(
      controller.deployAgent(
        administrator,
        { namespaceId: namespace.id, agentId: agent.id },
        resolveApprovedDevelopmentHarness,
      ),
      ownership,
    );
    await assert.rejects(
      controller.updateCredentialSource(administrator, {
        namespaceId: namespace.id,
        credentialSourceId: model.id,
      }),
      ownership,
    );
    for (const source of [unbound, stuck]) {
      await assert.rejects(
        controller.deleteCredentialSource(administrator, namespace.id, source.id),
        ownership,
      );
    }
    // The refused deletion committed nothing: the source is still ready, so it is not stranded
    // in the one-way `deleting` state, and no gateway was asked to remove anything.
    const unchanged = await controller.readCredentialSource(
      administrator,
      namespace.id,
      unbound.id,
    );
    assert.equal(unchanged.state, "ready");
    // Its live status names the driver change rather than an outage.
    assert.deepEqual(unchanged.status, {
      state: "failed",
      reason: "A Credential Gateway Driver that is no longer selected registered the source.",
    });
    assert.equal(removals().length, removalsBefore);
    // A referenced source still reports the reference first.
    await assert.rejects(
      controller.deleteCredentialSource(administrator, namespace.id, bound.id),
      ResourceConflictError,
    );

    // Selecting the registering driver again lets both sources be deleted.
    controller.selectDriver("credential_gateway", gateway.id);
    passRegistrationFence();
    for (const source of [unbound, stuck]) {
      await controller.deleteCredentialSource(administrator, namespace.id, source.id);
    }
    assert.deepEqual(
      (await controller.listCredentialSources(administrator, namespace.id))
        .map(({ name }) => name)
        .toSorted(),
      ["openai-old", "registry-bound"],
    );
  });

  test("update and delete without a Credential Gateway are a 409 after the grant, whether or not the source exists", async () => {
    const { controller, makeReady, namespace } = await fixture({ withoutGateway: true });
    await makeReady();
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
    const missing = "cs_00000000-0000-4000-8000-00000000ffff";
    const notConfigured = (error: unknown) => {
      assert.ok(error instanceof CredentialGatewayNotConfiguredError, String(error));
      assert.equal(requestFailure(error).status, 409);
      return true;
    };
    for (const id of [stored.id, missing]) {
      await assert.rejects(
        controller.updateCredentialSource(administrator, {
          namespaceId: namespace.id,
          credentialSourceId: id,
        }),
        notConfigured,
      );
      await assert.rejects(
        controller.deleteCredentialSource(administrator, namespace.id, id),
        notConfigured,
      );
      // A caller without the grant is denied first.
      await assert.rejects(
        controller.deleteCredentialSource(zeroGrant, namespace.id, id),
        AuthorizationDeniedError,
      );
    }
    const [after] = await controller.listCredentialSources(administrator, namespace.id);
    assert.equal(after?.state, "ready");
  });
}
