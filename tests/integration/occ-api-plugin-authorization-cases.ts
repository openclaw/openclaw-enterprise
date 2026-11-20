import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import {
  AgentListResponse,
  AgentResponse,
  InstallationResponse,
  type AccessBinding,
  type PluginApprovers,
  type PluginDesiredSelection,
  type PluginDesiredState,
  type Role,
} from "../../packages/contracts/src/index.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  bindHarnessKey,
  bootstrapInstallation,
  checkedInjectedBody,
  createConfiguration,
  createNamespace,
  injectedRequest,
} from "./occ-api-injected-fixture.ts";
import {
  apiError,
  diffsPluginId,
  diffsSelection,
  linearPluginId,
  readAgent,
  selectPluginDriver,
  type AgentCreate,
  type AgentUpdate,
  type ConfiguredController,
} from "./occ-api-plugin-policy-support.ts";

export function registerCodexPluginApproversCase(configuredController: ConfiguredController): void {
  test("Codex Agents refuse plugin and tool approver overrides and keep Agent-wide approvers", async () => {
    const controller = await configuredController();
    await bootstrapInstallation(controller);
    const namespace = await createNamespace(controller, "codex-plugin-approvers-api");
    const configuration = await createConfiguration(controller, namespace.id, {
      ...createHarnessConfiguration("codex", "gpt-6-astra"),
    });
    selectPluginDriver(controller, new CodexPluginDriver());
    // The Console reads this capability to hide plugin and tool approver fields for Codex.
    const installation = checkedInjectedBody(
      await controller.request("GET", "/installation"),
      200,
      InstallationResponse,
    ).data;
    const catalog = installation.capabilities?.pluginCatalogs?.[0];
    assert(catalog, "the selected Plugin Driver must publish its policy capabilities");
    assert.deepEqual(catalog.pluginPolicies.approvers, {
      agent: true,
      plugin: false,
      tools: false,
    });

    const approvers = [{ channel: "slack", id: "team:T123:user:U123" }] satisfies PluginApprovers;
    const plugins = { [linearPluginId]: { enabled: true } } satisfies PluginDesiredState;
    const agents = `/namespaces/${namespace.id}/agents`;
    const created = checkedInjectedBody(
      await controller.request("POST", agents, {
        body: {
          name: "codex-approvers-agent",
          executionMode: "dedicated",
          configurationId: configuration.id,
          plugins,
          pluginApprovers: approvers,
        } satisfies AgentCreate,
      }),
      201,
      AgentResponse,
    ).data;
    assert.deepEqual(created.pluginApprovers, approvers);
    const path = `${agents}/${created.id}`;

    // Codex approval requests carry no plugin or tool identity, so any override list would make
    // every Codex plugin request unapprovable in Slack. Admission refuses it with remediation.
    const message =
      "This Plugin Driver does not support plugin or tool approvers. Omit approvers from plugin selections and set Agent-wide pluginApprovers instead.";
    for (const policy of [
      { enabled: true, approvers },
      { enabled: true, approvers: [] },
      { enabled: true, tools: { "app/search": { approvers } } },
    ] satisfies PluginDesiredSelection[]) {
      const rejectedUpdate = await controller.request("PATCH", path, {
        body: {
          configurationId: configuration.id,
          plugins: { [linearPluginId]: policy },
        } satisfies AgentUpdate,
      });
      assert.equal(apiError(rejectedUpdate, 400, "INVALID_REQUEST").message, message);
    }
    const rejectedCreate = await controller.request("POST", agents, {
      body: {
        name: "codex-override-agent",
        executionMode: "dedicated",
        configurationId: configuration.id,
        plugins: { [linearPluginId]: { enabled: true, approvers } },
      } satisfies AgentCreate,
    });
    assert.equal(apiError(rejectedCreate, 400, "INVALID_REQUEST").message, message);
    const saved = readAgent(await controller.request("GET", path));
    assert.deepEqual(saved.plugins, plugins);
    assert.deepEqual(saved.pluginApprovers, approvers);
  });
}

export function registerPluginAuthorizationCase(configuredController: ConfiguredController): void {
  test("Agent plugin maps reject structural errors and preserve exact authorization and audit boundaries", async () => {
    const controller = await configuredController();
    await bootstrapInstallation(controller);
    const namespace = await createNamespace(controller, "plugin-api-auth");
    const configuration = await createConfiguration(controller, namespace.id);
    selectPluginDriver(controller, new OCCPluginDriver());
    const { auditSink } = controller.fixture;
    assert(auditSink instanceof InMemoryAuditSink);
    const auditCount = auditSink.events.length;
    const policy = diffsSelection[diffsPluginId];

    // These bodies are intentionally outside the shared request schema.
    for (const invalidPolicy of [
      { ...policy, nativeId: "diffs" },
      { enabled: true, approvalMode: "always" },
    ]) {
      const invalidCreate = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
        body: {
          name: "invalid-plugin-agent",
          configurationId: configuration.id,
          plugins: { [diffsPluginId]: invalidPolicy },
        },
      });
      apiError(invalidCreate, 400, "INVALID_REQUEST");
      assert.equal(auditSink.events.length, auditCount);
    }

    const agents = `/namespaces/${namespace.id}/agents`;
    const agent = checkedInjectedBody(
      await controller.request("POST", agents, {
        body: {
          name: "plugin-auth-agent",
          configurationId: configuration.id,
        } satisfies AgentCreate,
      }),
      201,
      AgentResponse,
    ).data;
    const secondAgent = checkedInjectedBody(
      await controller.request("POST", agents, {
        body: {
          name: "plugin-auth-sibling",
          configurationId: configuration.id,
        } satisfies AgentCreate,
      }),
      201,
      AgentResponse,
    ).data;
    const agentPath = `${agents}/${agent.id}`;
    const siblingPath = `${agents}/${secondAgent.id}`;

    const auditBeforeInvalidUpdate = auditSink.events.length;
    const snakeCaseReviewer = await controller.request("PATCH", agentPath, {
      body: {
        configurationId: configuration.id,
        plugins: {
          [linearPluginId]: {
            enabled: true,
            toolDefaults: { approval: "provider_default" },
            approvals_reviewer: "auto_review",
          },
        },
      },
    });
    apiError(snakeCaseReviewer, 400, "INVALID_REQUEST");
    assert.equal(auditSink.events.length, auditBeforeInvalidUpdate);

    for (const plugins of [
      { "codex-plugin:bad/plugin@openai-curated-remote": policy },
      { [linearPluginId]: { ...policy, tools: { "bad tool": { enabled: true } } } },
      { [linearPluginId]: { ...policy, tools: { search: {} } } },
      { [diffsPluginId]: { enabled: true, approvalMode: "never" } },
      { [diffsPluginId]: { ...policy, approvalsReviewer: "user" } },
      { [diffsPluginId]: { ...policy, destructiveActions: "never" } },
      { [diffsPluginId]: { ...policy, writes: "prompt" } },
      { [diffsPluginId]: { ...policy, tools: { diffs: { approvalMode: "always" } } } },
      { [diffsPluginId]: { ...policy, toolDefaults: { approval: "native" } } },
      { [diffsPluginId]: { ...policy, toolDefaults: { approval: "auto" } } },
      { [diffsPluginId]: { ...policy, toolDefaults: { reviewer: "user" } } },
      { [diffsPluginId]: { ...policy, tools: { diffs: { reviewer: null } } } },
    ]) {
      const invalid = await controller.request("PATCH", agentPath, {
        body: { configurationId: configuration.id, plugins },
      });
      apiError(invalid, 400, "INVALID_REQUEST");
      assert.equal(auditSink.events.length, auditBeforeInvalidUpdate);
    }

    const afterInvalidUpdate = readAgent(await controller.request("GET", agentPath));
    assert.equal(Object.hasOwn(afterInvalidUpdate, "plugins"), false);

    // These policies satisfy the shared schema but the selected native driver cannot apply them.
    for (const [unsupportedPolicy, message] of [
      [
        { ...policy, toolDefaults: { approval: "all_actions" } },
        "The supplied plugin policies are invalid.",
      ],
      [
        { ...policy, toolDefaults: { approval: "write_actions" } },
        "The supplied plugin policies are invalid.",
      ],
      [
        { ...policy, tools: { diffs: { approval: "all_actions" } } },
        "The supplied plugin policies are invalid.",
      ],
      [
        { ...policy, driverPolicy: { destructiveEnabled: false } },
        "The supplied plugin policies are invalid.",
      ],
      [
        { ...policy, toolDefaults: { reviewer: "human" } },
        "This Plugin Driver does not support toolDefaults.reviewer. Omit the reviewer to inherit the Harness setting.",
      ],
      [
        { ...policy, tools: { diffs: { reviewer: "auto" } } },
        "This Plugin Driver does not support tools[id].reviewer. Use toolDefaults.reviewer when supported, or omit the reviewer.",
      ],
    ] satisfies [PluginDesiredSelection, string][]) {
      const unsupportedCreate = await controller.request("POST", agents, {
        body: {
          name: "unsupported-plugin-agent",
          configurationId: configuration.id,
          plugins: { [diffsPluginId]: unsupportedPolicy },
        } satisfies AgentCreate,
      });
      const unsupportedUpdate = await controller.request("PATCH", agentPath, {
        body: {
          configurationId: configuration.id,
          plugins: { [diffsPluginId]: unsupportedPolicy },
        } satisfies AgentUpdate,
      });
      for (const response of [unsupportedCreate, unsupportedUpdate]) {
        assert.equal(apiError(response, 400, "INVALID_REQUEST").message, message);
      }
    }
    // A plugin the selected Driver does not offer, as after an Installation switches Drivers:
    // the refusal names the rejected ID and points at its selection.
    const otherDriverUpdate = await controller.request("PATCH", agentPath, {
      body: {
        configurationId: configuration.id,
        plugins: { [diffsPluginId]: policy, [linearPluginId]: policy },
      } satisfies AgentUpdate,
    });
    const otherDriverError = apiError(otherDriverUpdate, 400, "INVALID_REQUEST");
    assert.match(
      otherDriverError.message,
      /^A plugin selection names a plugin that the selected Plugin Driver \(occ-plugin\) does not offer: codex-plugin:linear@openai-curated-remote\./,
    );
    assert.deepEqual(otherDriverError.details, [
      { path: `/plugins/${linearPluginId}`, code: "INVALID_VALUE" },
    ]);
    assert.deepEqual(readAgent(await controller.request("GET", agentPath)), afterInvalidUpdate);
    const savedAgents = checkedInjectedBody(
      await controller.request("GET", agents),
      200,
      AgentListResponse,
    ).data;
    assert.equal(savedAgents.length, 2, "unsupported policies must not create an Agent");

    const { principal: noGrantPrincipal } =
      await controller.fixture.createAuthPrincipal("plugin-no-grant");
    controller.fixture.state.identities.push(noGrantPrincipal);
    const noGrantApp = controller.fixture.createApp(noGrantPrincipal);
    apiError(await injectedRequest(noGrantApp, "GET", agentPath), 403, "FORBIDDEN");
    apiError(
      await injectedRequest(noGrantApp, "PATCH", agentPath, {
        body: { configurationId: configuration.id, plugins: diffsSelection } satisfies AgentUpdate,
      }),
      403,
      "FORBIDDEN",
    );
    assert.equal(
      Object.hasOwn(readAgent(await controller.request("GET", agentPath)), "plugins"),
      false,
    );

    const { principal: exactAgentPrincipal } =
      await controller.fixture.createAuthPrincipal("plugin-exact-agent");
    controller.fixture.state.identities.push(exactAgentPrincipal);
    controller.fixture.state.roles.push({
      id: "role-plugin-exact-agent",
      namespaceId: namespace.id,
      permissions: [
        { action: "read", resourceKind: "agent" },
        { action: "update", resourceKind: "agent" },
        { action: "read", resourceKind: "configuration" },
      ],
    } satisfies Role);
    controller.fixture.state.bindings.push(
      {
        id: "binding-plugin-exact-agent",
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: exactAgentPrincipal.id,
        roleId: "role-plugin-exact-agent",
        resourceKind: "agent",
        resourceId: agent.id,
      } satisfies AccessBinding,
      {
        id: "binding-plugin-exact-configuration",
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: exactAgentPrincipal.id,
        roleId: "role-plugin-exact-agent",
        resourceKind: "configuration",
        resourceId: configuration.id,
      } satisfies AccessBinding,
    );
    const exactAgentApp = controller.fixture.createApp(exactAgentPrincipal);
    readAgent(await injectedRequest(exactAgentApp, "GET", agentPath));
    apiError(await injectedRequest(exactAgentApp, "GET", siblingPath), 403, "FORBIDDEN");
    apiError(
      await injectedRequest(exactAgentApp, "PATCH", siblingPath, {
        body: { configurationId: configuration.id, plugins: diffsSelection } satisfies AgentUpdate,
      }),
      403,
      "FORBIDDEN",
    );

    // A catalog refusal must not bypass the exact grant on a newly requested source.
    const requestedSourceId = `cs_${randomUUID()}`;
    const deniedSource = await injectedRequest(exactAgentApp, "PATCH", agentPath, {
      body: {
        configurationId: configuration.id,
        credentialSources: [{ sourceId: requestedSourceId }],
        plugins: { [linearPluginId]: { enabled: true } },
      } satisfies AgentUpdate,
    });
    apiError(deniedSource, 403, "FORBIDDEN");
    const denial = auditSink.events.at(-1);
    assert(denial, "the refused source operation must emit an audit event");
    assert.equal(denial.kind, "authorization_denial");
    assert.equal(denial.outcome, "denied");
    assert.equal(denial.action, "openclaw.agents.update");
    assert.equal(denial.actorId, exactAgentPrincipal.id);
    assert.deepEqual(denial.resource, { kind: "agent", namespaceId: namespace.id, id: agent.id });
    assert(denial.authorization, "the audit event must identify the denied permission");
    assert.equal(denial.authorization.principalId, exactAgentPrincipal.id);
    assert.equal(denial.authorization.action, "operate");
    assert.deepEqual(denial.authorization.resource, {
      kind: "credential_source",
      namespaceId: namespace.id,
      id: requestedSourceId,
    });

    const updated = checkedInjectedBody(
      await injectedRequest(exactAgentApp, "PATCH", agentPath, {
        body: { configurationId: configuration.id, plugins: diffsSelection } satisfies AgentUpdate,
      }),
      200,
      AgentResponse,
    ).data;
    assert.deepEqual(updated.plugins, diffsSelection);
    assert.equal(
      Object.hasOwn(readAgent(await controller.request("GET", siblingPath)), "plugins"),
      false,
    );

    const beforeAuditFailure = readAgent(await controller.request("GET", agentPath));
    const originalAppend = auditSink.append;
    auditSink.append = async () => {
      throw new Error("plugin audit sink unavailable");
    };
    try {
      const failedAudit = await controller.request("PATCH", agentPath, {
        body: {
          configurationId: configuration.id,
          plugins: { [diffsPluginId]: { ...policy, enabled: false } },
        } satisfies AgentUpdate,
      });
      apiError(failedAudit, 503, "DEPENDENCY_UNAVAILABLE");
    } finally {
      auditSink.append = originalAppend;
    }
    assert.deepEqual(readAgent(await controller.request("GET", agentPath)), beforeAuditFailure);

    // After the Installation switches Plugin Drivers, the Agent's stored selection is refused
    // where the plugins are read from storage: an update that omits plugins and a bodiless
    // deploy. The message still names the plugin, but no detail points into a request body
    // the caller never sent.
    assert(controller.fixture.controller, "bootstrap must create the controller");
    await controller.fixture.controller.handleNamespaceLifecycle(
      controller.fixture.principal.id,
      namespace.id,
      "ready",
    );
    await bindHarnessKey(controller.fixture, namespace.id, agent);
    const beforeDriverSwitch = readAgent(await controller.request("GET", agentPath));
    selectPluginDriver(controller, new CodexPluginDriver());
    const storedUpdate = await controller.request("PATCH", agentPath, {
      body: { configurationId: configuration.id } satisfies AgentUpdate,
    });
    const storedDeploy = await controller.request("POST", `${agentPath}/deploy`);
    for (const response of [storedUpdate, storedDeploy]) {
      const error = apiError(response, 400, "INVALID_REQUEST");
      assert.match(error.message, /No Plugin Driver is enabled for the openclaw Harness/);
      assert.equal(Object.hasOwn(error, "details"), false);
    }
    assert.deepEqual(readAgent(await controller.request("GET", agentPath)), beforeDriverSwitch);
  });
}
