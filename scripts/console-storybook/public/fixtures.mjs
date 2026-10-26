import networkPolicySchema from "./network-policy-schema.mjs";
import defaultCodexPreset from "/console/default-codex-preset.mjs";
import standardCodexPreset from "/console/standard-codex-preset.mjs";
import standardOpenclawPreset from "/console/standard-openclaw-preset.mjs";
import swePreset from "/console/swe-preset.mjs";

const createdAt = "2026-09-01T12:00:00.000Z";
const namespaceId = "ns_00000000-0000-4000-8000-000000000001";
const currentRevisionId = "rev_00000000-0000-4000-8000-000000000006";
const candidateRevisionId = "rev_00000000-0000-4000-8000-000000000007";
const hiddenRevisionId = "rev_00000000-0000-4000-8000-000000000008";
const secretRef = (id) => ({ kind: "secret", namespaceId, id });
const auth = { method: "api_key", source: secretRef("sec_demo_model") };

function initialDeploymentProgress(status) {
  if (status !== "queued" && status !== "running") {
    return null;
  }
  return { lastAttempt: null, nextAttemptAt: status === "queued" ? createdAt : null };
}

// Another browser's save in configurationChangedElsewhere: objects merge, other values replace.
function mergeElsewhere(target, changes) {
  for (const [key, value] of Object.entries(changes)) {
    const current = target[key];
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === "object" &&
      !Array.isArray(current)
    ) {
      mergeElsewhere(current, value);
    } else {
      target[key] = structuredClone(value);
    }
  }
}

function slackChannels(scenario) {
  if (scenario.slackChannels !== undefined) {
    return structuredClone(scenario.slackChannels);
  }
  return {
    CDEMO123: {
      requireMention: true,
      users: scenario.slackAllowEveryone ? ["*"] : ["UDEMO123"],
    },
  };
}

function configurationValues(scenario) {
  const values = {
    gateway: { mode: "local" },
    agents: {
      defaults: {
        model: "codex/gpt-4.1",
        models: { "codex/gpt-4.1": { agentRuntime: { id: "codex" } } },
      },
    },
    channels: {},
  };
  if (scenario.gatewayPassword) {
    values.gateway.auth = {
      password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
    };
  }
  if (scenario.slack) {
    values.channels.slack = {
      enabled: true,
      mode: scenario.slackMode ?? "socket",
      ...(scenario.slackReplyToMode === undefined
        ? {}
        : { replyToMode: scenario.slackReplyToMode }),
      ...(scenario.slackEnterpriseOrgInstall ? { enterpriseOrgInstall: true } : {}),
      dmPolicy: scenario.slackPolicy ?? "pairing",
      groupPolicy: scenario.slackPolicy === "open" ? "open" : "allowlist",
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      allowFrom:
        scenario.slackAllowFrom ?? (scenario.slackPolicy === "open" ? ["*"] : ["UDEMO123"]),
      channels: slackChannels(scenario),
    };
  }
  return values;
}

// This is a presentation fixture, not a controller implementation or backend test double.
// Every request stays inside this frame. Unsupported requests fail visibly, never go live.
function candidateDeploymentError(scenario, checkedAt) {
  if (scenario.bootstrapFailure) {
    return {
      code: "HARNESS_CREDENTIAL_BOOTSTRAP_FAILED",
      message: "Harness credential initialization failed. Correct the cause and deploy again.",
      data: {
        preparation: {
          workload: {
            kind: "Job",
            name: "oauth-bootstrap-demo",
            uid: "job-demo-uid",
            namespace: "oce-tenant-demo",
          },
          reason: "retry_limit",
          observedAt: checkedAt,
          startedAt: checkedAt,
          finishedAt: checkedAt,
          pods: [
            {
              name: "oauth-bootstrap-demo-pod",
              uid: "bootstrap-demo-uid",
              phase: "Failed",
              scheduling: "scheduled",
              containers: [
                {
                  name: "prepare-oauth-home",
                  kind: "init",
                  state: "terminated",
                  reason: "Completed",
                  exitCode: 0,
                  startedAt: checkedAt,
                  finishedAt: checkedAt,
                },
                {
                  name: "oauth-bootstrap",
                  kind: "main",
                  state: "terminated",
                  reason: "Error",
                  exitCode: 1,
                  startedAt: checkedAt,
                  finishedAt: checkedAt,
                },
              ],
            },
          ],
        },
      },
    };
  }
  if (scenario.candidateSuperseded) {
    return {
      code: "REVISION_SUPERSEDED",
      message: "Deployment was superseded by a newer revision.",
    };
  }
  if (scenario.candidateStopped) {
    return {
      code: "REVISION_STOPPED",
      message: "Deployment ended because the Agent was stopped.",
    };
  }
  // Deployment error messages copy deploymentErrorMessage in
  // packages/occ/src/state/controller-work.ts; keep them in step.
  if (scenario.candidateCredentialRejected) {
    return {
      code: "RUNTIME_AUTHENTICATION_FAILED",
      message:
        "The model provider rejected this version's credential (HTTP 401 or 403). Check that the key or token is valid and can use the selected model, update or replace the Agent's model credential, then deploy a new version.",
    };
  }
  if (scenario.candidateModelProbeCause) {
    return {
      code: "RUNTIME_MODEL_PROBE_FAILED",
      message:
        "The startup model check failed, but not for a rejected credential: for example an unknown model, bad provider settings, a TLS error, a rate limit, or, with Codex, an unreachable provider. Check these and the provider account, then deploy a new version.",
      data: {
        runtimeFailure: {
          component: "gateway",
          check: "model-probe",
          code: "MODEL_PROBE_FAILED",
          checkedAt,
          cause: scenario.candidateModelProbeCause,
        },
      },
    };
  }
  // A scenario can name any failure code with the message OCC returns for it.
  if (scenario.candidateFailure) {
    return scenario.candidateFailure;
  }
  if (scenario.candidateDependencyUnavailable) {
    return {
      code: "DEPENDENCY_UNAVAILABLE",
      message:
        "A dependency the controller needs stayed unavailable through every attempt. Deploy again; if it keeps failing, ask an Installation administrator to check the controller worker log.",
    };
  }
  if (scenario.candidateSelected) {
    return {
      code: "REVISION_FINALIZATION_INCOMPLETE",
      message:
        "Deployment failed. Check this version's logs; if they show nothing, ask an Installation administrator to check the controller worker log for this code.",
    };
  }
  return {
    code: "CONVERGENCE_DEADLINE_EXCEEDED",
    message:
      "Deployment convergence deadline exceeded: the version did not become ready in time. Check its logs and runtime diagnostics, correct the cause if there is one, then deploy a new version.",
    data: {
      timeoutMs: 60000,
      runtimeFailure: { component: "harness", check: "readiness", code: "TIMEOUT", checkedAt },
    },
  };
}

export function installFixture(scenario, evidence) {
  const rules = structuredClone(scenario.rules ?? []);
  const namespaceRechecks = [...(scenario.namespaceRechecks ?? [])];
  let podRolloverStatusReads = 0;
  let signedIn = !scenario.signedOut;
  let repositoryDescriptionRequests = 0;
  if (scenario.pendingGithubAttempt) {
    // Simulates returning from a GitHub callback started in this tab.
    sessionStorage.setItem("occ.console.githubAttempt", "a".repeat(43));
  }
  // Preview frames share tab storage, so every scenario sets the signed-in mark itself: only
  // one whose tab had a session before it expired keeps it; a first visit has none.
  if (scenario.expiredSession) {
    sessionStorage.setItem("occ.console.signedIn", "1");
  } else {
    sessionStorage.removeItem("occ.console.signedIn");
  }
  if (scenario.pendingGoogleAttempt) {
    // Simulates returning from a Google callback started in this tab.
    sessionStorage.setItem("occ.console.googleAttempt", "a".repeat(43));
  }
  let serial = 100;
  const nextId = (prefix) =>
    `${prefix}_00000000-0000-4000-8000-${String(serial++).padStart(12, "0")}`;
  const configs = new Map();
  const configurationReads = new Set();
  let configurationChangedElsewhere = false;
  const agents = new Map();
  const revisions = new Map();
  const deployments = new Map();
  const provisioning = new Map();
  const credentials = new Map();
  const credentialSources = new Map();
  let credentialRegistrationFailed = false;
  const deviceLogins = new Map();
  const files = new Map();
  const secrets = new Map();
  const stagedWorkspaceFiles = new Map();
  const roles = [];
  const bindings = [];
  const deleted = new Set();
  const clearRevisionOnRead = new Set();
  const session = {
    authenticated: true,
    sessionKey: "storybook-session",
    user: scenario.sessionUser ?? {
      id: "storybook-operator",
      name: "Demo Operator",
      email: "operator@example.com",
    },
  };
  const namespaces = scenario.emptyNamespaces
    ? []
    : [
        {
          id: namespaceId,
          name: scenario.namespaceName ?? "Engineering",
          status: scenario.namespaceStatus ?? "ready",
          createdAt,
        },
        {
          id: "ns_00000000-0000-4000-8000-000000000002",
          name: "Research",
          status: "provisioning",
          createdAt,
        },
      ];
  const backends = scenario.emptyBackends
    ? []
    : [{ id: "chatgpt-demo", name: "ChatGPT", type: "chatgpt" }];
  const secretMetadata = (id, name) => ({ id, namespaceId, name, ref: secretRef(id) });
  for (const secret of [
    secretMetadata("sec_demo_model", "Demo model API key (simulated)"),
    secretMetadata("sec_demo_service_account", "Demo Service Accounts token (simulated)"),
    secretMetadata("sec_demo_slack_app_token", "Slack app token (simulated)"),
    secretMetadata("sec_demo_slack_bot_token", "Slack bot token (simulated)"),
    secretMetadata("sec_demo_slack_backup_token", "Slack backup token (simulated)"),
    ...(scenario.extraSecrets ?? []).map((secret) => secretMetadata(secret.id, secret.name)),
  ]) {
    secrets.set(secret.id, secret);
  }
  const accounts = [
    {
      id: "sa_demo",
      name: "Research service",
      credential: { kind: "access_token" },
      backendId: "chatgpt-demo",
      status: "active",
      createdAt,
    },
  ];
  const config = {
    id: "cfg_00000000-0000-4000-8000-000000000001",
    namespaceId,
    kind: "agent",
    generation: 1,
    createdAt,
    values: configurationValues(scenario),
    secretBindings: {},
  };
  if (scenario.candidateDeploymentStatus) {
    config.generation = 2;
    config.values.agents.defaults.model = "codex/gpt-5.1";
  }
  if (scenario.slack && scenario.slackBindings !== false) {
    const keys =
      scenario.slackBindings === "app"
        ? ["SLACK_APP_TOKEN"]
        : ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"];
    for (const key of keys) {
      config.secretBindings[key] = {
        source: secretRef(`sec_demo_${key.toLowerCase()}`),
        delivery: { type: "env" },
      };
    }
    // The demo Agent was granted the Slack Secrets it binds, unless the scenario left one out:
    // an administrator's console reads these grants (finding 1920).
    roles.push({
      id: "role_demo_secret_operate",
      namespaceId,
      name: "Agent Secret operate",
      permissions: [{ action: "operate", resourceKind: "secret" }],
    });
    for (const key of keys.filter((name) => name !== scenario.slackGrantMissing)) {
      bindings.push({
        id: `binding_demo_${key.toLowerCase()}`,
        namespaceId,
        subjectKind: "identity",
        subjectId: "identity_demo_agent",
        roleId: "role_demo_secret_operate",
        resourceKind: "secret",
        resourceId: `sec_demo_${key.toLowerCase()}`,
      });
    }
  }
  configs.set(config.id, config);
  const selectedAuth =
    scenario.auth === null
      ? null
      : scenario.auth === "runtime"
        ? { method: "runtime" }
        : scenario.auth === "service"
          ? { method: "codex_pat", source: { kind: "service_account", namespaceId, id: "sa_demo" } }
          : scenario.auth === "codex_pat"
            ? { method: "codex_pat", source: secretRef("sec_demo_service_account") }
            : scenario.auth === "oauth"
              ? { method: "credential_source", sourceId: "cs_00000000-0000-4000-8000-000000000010" }
              : auth;
  // The demo Agent was granted its harness authentication Secret or credential source, unless the
  // scenario left it out: an administrator's Credentials tab reads this grant (finding 2260).
  const harnessCredential =
    selectedAuth?.method === "credential_source"
      ? { kind: "credential_source", id: selectedAuth.sourceId }
      : selectedAuth?.source?.kind === "secret"
        ? { kind: "secret", id: selectedAuth.source.id }
        : null;
  if (harnessCredential && !scenario.harnessGrantMissing) {
    const roleId = `role_demo_${harnessCredential.kind}_operate`;
    if (!roles.some((role) => role.id === roleId)) {
      roles.push({
        id: roleId,
        namespaceId,
        name:
          harnessCredential.kind === "secret"
            ? "Agent Secret operate"
            : "Agent Credential Source operate",
        permissions: [{ action: "operate", resourceKind: harnessCredential.kind }],
      });
    }
    bindings.push({
      id: "binding_demo_harness_auth",
      namespaceId,
      subjectKind: "identity",
      subjectId: "identity_demo_agent",
      roleId,
      resourceKind: harnessCredential.kind,
      resourceId: harnessCredential.id,
    });
  }
  let selectedRevisionId = null;
  if (scenario.candidateSuperseded) {
    // A newer v8 the viewer cannot read superseded v7 and is now selected.
    selectedRevisionId = hiddenRevisionId;
  } else if (scenario.candidateDeploymentStatus) {
    selectedRevisionId =
      scenario.candidateDeploymentStatus === "succeeded" || scenario.candidateSelected
        ? candidateRevisionId
        : currentRevisionId;
  } else if (scenario.deployed) {
    selectedRevisionId = "rev_00000000-0000-4000-8000-000000000001";
  }
  let agentReadCount = 0;
  const agent = {
    id: scenario.agentId ?? "agt_00000000-0000-4000-8000-000000000001",
    namespaceId,
    name: scenario.agentName ?? "Research assistant",
    status: scenario.deleting ? "deleting" : "active",
    desiredRuntimeState: scenario.stopped ? "stopped" : scenario.deployed ? "running" : "stopped",
    configurationId: config.id,
    executionMode: "dedicated",
    harnessAuth: selectedAuth,
    credentialSources: structuredClone(
      scenario.credentialSources ??
        (selectedAuth?.method === "credential_source" ? [{ sourceId: selectedAuth.sourceId }] : []),
    ),
    ...(scenario.agentPlugins ? { plugins: structuredClone(scenario.agentPlugins) } : {}),
    ...(scenario.agentPluginApprovers !== undefined
      ? { pluginApprovers: structuredClone(scenario.agentPluginApprovers) }
      : {}),
    servicePrincipalId: "identity_demo_agent",
    createdAt,
    activeRevisionId:
      scenario.stopNoSelection || scenario.firstDeploymentFailed || scenario.firstDeploymentQueued
        ? null
        : selectedRevisionId,
    ...(scenario.repositoryAccess
      ? { repositoryAccess: structuredClone(scenario.repositoryAccess) }
      : {}),
    ...(scenario.repositoryBindings
      ? { repositoryBindings: structuredClone(scenario.repositoryBindings) }
      : {}),
  };
  for (const [name, content] of Object.entries(scenario.workspaceFiles ?? {})) {
    files.set(`${agent.id}/${name}`, content);
  }

  agents.set(agent.id, agent);
  credentials.set(agent.id, { transportConfigured: scenario.transport !== false });
  function snapshot(owner, id, revision) {
    const configuration = configs.get(owner.configurationId);
    const model = configuration.values.agents?.defaults?.model;
    const primaryModel = typeof model === "string" ? model : model?.primary;
    const harnessId =
      configuration.values.agents?.defaults?.models?.[primaryModel]?.agentRuntime?.id ??
      (primaryModel?.startsWith("codex/") ? "codex" : "openclaw");
    return {
      id,
      namespaceId,
      agentId: owner.id,
      revision,
      backendId: owner.backendId ?? null,
      configurationId: configuration.id,
      configurationKind: configuration.kind,
      configurationGeneration: configuration.generation,
      createdAt,
      configuration: structuredClone(configuration.values),
      secretBindings: structuredClone(configuration.secretBindings),
      harnessAuth: structuredClone(owner.harnessAuth),
      credentialSources: structuredClone(owner.credentialSources),
      ...(owner.pluginApprovers !== undefined
        ? { pluginApprovers: structuredClone(owner.pluginApprovers) }
        : {}),
      ...(owner.plugins
        ? {
            plugins: {
              driver: structuredClone(scenario.pluginCapabilities.driver),
              plugins: structuredClone(owner.plugins),
            },
          }
        : {}),
      harness: { id: harnessId, version: "demo", mode: owner.executionMode },
      compute: { id: "kubernetes-demo", implementation: "kubernetes" },
      ...(scenario.policyState ? { sandboxDriverId: "sandbox-story" } : {}),
      servicePrincipalId: owner.servicePrincipalId,
      ...(owner.repositoryBindings?.length
        ? {
            repositoryCredentials: {
              driver: { id: "github-demo", implementation: "github" },
              deadlineWallMs: Date.parse(createdAt) + 3600000,
              bindings: owner.repositoryBindings.map((binding) => ({
                ...binding,
                backendId: "github-demo",
                grant: {
                  providerInstanceId: "github-demo",
                  repositoryId: `demo-${binding.repositoryRef}`,
                  grantId: `demo-${binding.repositoryRef}-${binding.profile}`,
                },
              })),
            },
          }
        : {}),
    };
  }
  if (scenario.deployed) {
    const revisionId = scenario.candidateDeploymentStatus
      ? currentRevisionId
      : "rev_00000000-0000-4000-8000-000000000001";
    const currentRevision = snapshot(agent, revisionId, scenario.candidateDeploymentStatus ? 6 : 1);
    if (scenario.candidateDeploymentStatus) {
      currentRevision.createdAt = "2026-09-25T12:00:00.000Z";
      currentRevision.configurationGeneration = 1;
      currentRevision.configuration.agents.defaults.model = "codex/gpt-4.1";
    }
    revisions.set(revisionId, currentRevision);
    if (scenario.revisionHistory) {
      // Earlier deploys of the same Agent, one per day before the current version.
      currentRevision.revision = scenario.revisionHistory;
      for (let number = 1; number < scenario.revisionHistory; number += 1) {
        const older = snapshot(
          agent,
          `rev_00000000-0000-4000-8000-${String(100 + number).padStart(12, "0")}`,
          number,
        );
        older.createdAt = new Date(
          Date.parse(createdAt) - (scenario.revisionHistory - number) * 86_400_000,
        ).toISOString();
        revisions.set(older.id, older);
        // An earlier version whose deployment failed before a later one succeeded.
        if (scenario.earlierFailedVersion === number) {
          deployments.set(older.id, {
            deploymentId: older.id,
            namespaceId,
            agentId: agent.id,
            status: "failed",
            cleanup: null,
            progress: null,
            error: candidateDeploymentError(scenario, older.createdAt),
            warnings: [],
          });
        }
      }
    }
    deployments.set(revisionId, {
      deploymentId: revisionId,
      namespaceId,
      agentId: agent.id,
      // A failed or still queued first deployment selects no version for service.
      status: scenario.firstDeploymentFailed
        ? "failed"
        : scenario.firstDeploymentQueued
          ? "queued"
          : "succeeded",
      progress: null,
      error: scenario.firstDeploymentFailed
        ? candidateDeploymentError(scenario, currentRevision.createdAt)
        : null,
      warnings: [],
    });
    if (scenario.candidateDeploymentStatus) {
      const candidate = snapshot(agent, candidateRevisionId, 7);
      candidate.createdAt = "2026-09-26T22:52:53.000Z";
      revisions.set(candidate.id, candidate);
      deployments.set(candidate.id, {
        deploymentId: candidate.id,
        namespaceId,
        agentId: agent.id,
        status: scenario.candidateDeploymentStatus,
        cleanup: scenario.cleanupStatus
          ? { status: scenario.cleanupStatus, nextAttemptAt: null }
          : null,
        progress: ["queued", "running"].includes(scenario.candidateDeploymentStatus)
          ? {
              lastAttempt: scenario.deploymentLastAttempt ?? null,
              nextAttemptAt:
                scenario.candidateDeploymentStatus === "queued" ? "2026-09-26T22:53:01.000Z" : null,
            }
          : null,
        error:
          scenario.candidateDeploymentStatus === "failed"
            ? candidateDeploymentError(scenario, candidate.createdAt)
            : null,
        warnings: scenario.candidateDeploymentWarnings ?? [],
        // The next status poll records success and selects v7 for service.
        ...(scenario.candidateActivates ? { reads: 0 } : {}),
      });
    }
  }
  if (scenario.emptyAgents) {
    agents.clear();
  } else {
    agents.set("agt_00000000-0000-4000-8000-000000000002", {
      ...agent,
      id: "agt_00000000-0000-4000-8000-000000000002",
      name: "Documentation assistant",
      activeRevisionId: null,
    });
  }
  if (scenario.unreadableAgentConfiguration) {
    for (const field of ["harnessAuth", "plugins", "pluginApprovers", "repositoryBindings"]) {
      delete agent[field];
    }
    agent.configurationReadError = {
      code: "SAVED_CONFIGURATION_UNREADABLE",
      field: scenario.unreadableAgentConfiguration,
    };
  }
  if (scenario.unreadableRevisionConfiguration) {
    const saved = revisions.get(selectedRevisionId);
    revisions.set(saved.id, {
      id: saved.id,
      namespaceId: saved.namespaceId,
      agentId: saved.agentId,
      revision: saved.revision,
      backendId: saved.backendId,
      createdAt: saved.createdAt,
      configurationReadError: {
        code: "SAVED_CONFIGURATION_UNREADABLE",
        field: scenario.unreadableRevisionConfiguration,
      },
    });
  }
  const preset = {
    id: scenario.swePreset ? "pre_swe_codex" : "pre_00000000-0000-4000-8000-000000000001",
    namespaceId,
    name: "Research assistant",
    template: {
      variables: {
        name: { type: "string", description: "Name for this Agent." },
        model: {
          type: "string",
          default: "codex/gpt-4.1",
          description: "Model reference copied into the draft.",
        },
      },
      agent: {
        name: "{{ vars.name }}",
        executionMode: "dedicated",
        harnessAuth: { ...auth, method: scenario.presetAuth ?? auth.method },
      },
      configuration: {
        values: { ...configurationValues({}), agents: { defaults: { model: "{{ vars.model }}" } } },
      },
    },
  };
  if (scenario.standardCodexPreset || scenario.standardOpenclawPreset || scenario.swePreset) {
    Object.assign(
      preset,
      structuredClone(
        scenario.swePreset
          ? swePreset
          : scenario.standardOpenclawPreset
            ? standardOpenclawPreset
            : standardCodexPreset,
      ),
    );
  }
  if (scenario.modelFallbackSelection) {
    const ids = ["primary-model", "fallback-one", "fallback-two"];
    preset.name = "Models with ordered fallbacks";
    delete preset.template.variables;
    preset.template.agent.executionMode = "embedded";
    preset.template.agent.name = "Model selection example";
    preset.template.configuration.values = {
      agents: {
        defaults: {
          model: {
            primary: `openai/${ids[0]}`,
            fallbacks: ids.slice(1).map((id) => `openai/${id}`),
          },
          models: Object.fromEntries(
            ids.map((id) => [
              `openai/${id}`,
              {
                agentRuntime: { id: "openclaw" },
                alias: `Saved ${id}`,
                params: { temperature: 0.3 },
              },
            ]),
          ),
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://models.example.test/v1",
            api: "openai-responses",
            models: ids.map((id) => ({
              id,
              name: id,
              contextWindow: 128000,
              maxTokens: 8192,
              reasoning: true,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            })),
          },
        },
      },
    };
  }
  if (scenario.modelRosterSelection) {
    const values = preset.template.configuration.values;
    const primary = values.agents.defaults.model.primary;
    const policy = values.agents.defaults.models;
    values.agents.ownership = "explicit";
    values.agents.entries = {
      main: { model: primary, models: { [primary]: { ...policy[primary], alias: "Main policy" } } },
      assistant: {
        model: structuredClone(values.agents.defaults.model),
        models: structuredClone(policy),
      },
      inherited: {},
    };
    preset.name = "Roster with a shared primary";
  }
  if (scenario.presetAgent) {
    Object.assign(preset.template.agent, structuredClone(scenario.presetAgent));
  }
  if (scenario.presetWorkspaceFiles) {
    preset.template.agent.initialWorkspaceFiles = structuredClone(scenario.presetWorkspaceFiles);
  }
  if (scenario.presetVariables) {
    Object.assign(preset.template.variables, structuredClone(scenario.presetVariables));
  }
  const presets = [
    preset,
    {
      ...structuredClone(defaultCodexPreset),
      id: "pre_default_codex",
      namespaceId,
    },
  ];
  if (scenario.swePreset) {
    for (const [name, definition] of [
      ["standard-codex", standardCodexPreset],
      ["standard-openclaw", standardOpenclawPreset],
    ]) {
      presets.push({
        ...structuredClone(definition),
        id: `pre_${name.replaceAll("-", "_")}`,
        namespaceId,
      });
    }
  }
  const policyGrant = {
    id: scenario.policyState === "unicode" ? "unicode-tool" : "python-web",
    binary:
      scenario.policyState === "unicode"
        ? "/" + Array(6).fill("\u{10400}".repeat(45)).join("/") + "/tool"
        : "/usr/bin/python3.11",
    host: "example.org",
    ports: [{ from: 443, to: 443 }],
  };
  let policyEditing = scenario.policyState !== "disabled";
  let policyPolls = 0;
  let policyReads = 0;
  let sandboxPolicy = {
    id: "sbp_00000000-0000-4000-8000-000000000001",
    namespaceId,
    agentId: agent.id,
    version: 1,
    additions:
      scenario.policyState === "protected"
        ? [policyGrant]
        : Array.from({ length: scenario.policyRuleCount ?? 0 }, (_, index) => ({
            ...structuredClone(policyGrant),
            id: `explicit-${index + 1}`,
            host: `allowed-${index + 1}.example.org`,
          })),
  };
  if (scenario.policyRuleCount) {
    sandboxPolicy.applied = {
      revisionId: candidateRevisionId,
      policyVersion: 1,
      providerVersion: "4",
      appliedAt: createdAt,
    };
  }
  const policyCeiling = scenario.policyCeiling ?? [
    policyGrant,
    ...(scenario.policyDenialCount
      ? [{ ...policyGrant, id: "observed-services-ceiling", host: "*.example.org" }]
      : []),
    ...sandboxPolicy.additions,
    ...(scenario.policySuggestions ?? []).map((entry) => entry.grant),
  ];
  if (scenario.policyInitialOutcome) {
    sandboxPolicy.version = 2;
    if (scenario.policyInitialOutcome !== "saved") {
      sandboxPolicy.application = {
        id: "00000000-0000-4000-8000-000000000009",
        revisionId: candidateRevisionId,
        policyVersion: 2,
        state: scenario.policyInitialOutcome,
        requestedBy: "identity_demo",
        requestedAt: createdAt,
      };
    }
    if (scenario.policyInitialOutcome === "applied") {
      sandboxPolicy.applied.policyVersion = 2;
    }
  }
  let policyNewRead = false;
  if (scenario.policyState === "failed" || scenario.policyState === "failedCeiling") {
    sandboxPolicy.application = {
      id: "00000000-0000-4000-8000-000000000009",
      revisionId: candidateRevisionId,
      policyVersion: 1,
      state: "failed",
      requestedBy: "identity_demo",
      requestedAt: createdAt,
      reason:
        scenario.policyState === "failed"
          ? "SANDBOX_POLICY_UNCONFIRMED"
          : "SANDBOX_POLICY_CEILING_CHANGED",
    };
  }
  const response = (data, status = 200, errorCode, meta = {}, errorMessage, details) =>
    new Response(
      JSON.stringify({
        ...(errorCode
          ? {
              error: {
                code: errorCode,
                message: errorMessage ?? "The selected preview simulates this failure.",
                ...(details ? { details } : {}),
              },
            }
          : { data }),
        meta: { requestId: "req_00000000-0000-4000-8000-000000000001", ...meta },
      }),
      { status, headers: { "content-type": "application/json" } },
    );
  const error = (status, code, message) => response(null, status, code, {}, message);
  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.origin);
    const path = url.pathname;
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(options.body) : {};
    evidence.requests.push({ method, path });
    for (const rule of rules) {
      if (
        rule.used ||
        (rule.method ?? "GET") !== method ||
        (rule.path && rule.path !== path) ||
        (rule.prefix && !path.startsWith(rule.prefix)) ||
        (rule.pathIncludes && !path.includes(rule.pathIncludes)) ||
        (rule.suffix && !path.endsWith(rule.suffix)) ||
        (rule.queryParam && !url.searchParams.has(rule.queryParam)) ||
        (rule.bodyHasIds !== undefined && rule.bodyHasIds !== Array.isArray(body.ids))
      ) {
        continue;
      }
      if (rule.skip > 0) {
        rule.skip -= 1;
        continue;
      }
      rule.used = rule.once === true;
      if (rule.delayMs) {
        await new Promise((resolve, reject) => {
          const finish = () => {
            options.signal?.removeEventListener("abort", abort);
            resolve();
          };
          const timer = setTimeout(finish, rule.delayMs);
          const abort = () => {
            clearTimeout(timer);
            reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError"));
          };
          if (options.signal?.aborted) {
            abort();
          } else {
            options.signal?.addEventListener("abort", abort, { once: true });
          }
        });
      }
      if (rule.hold) {
        return new Promise((_resolve, reject) => {
          const abort = () =>
            reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError"));
          if (options.signal?.aborted) {
            abort();
          } else {
            options.signal?.addEventListener("abort", abort, { once: true });
          }
        });
      }
      if (rule.bodyError) {
        // A simulated after-headers failure exercises the production body reader.
        // Real socket interruption is proved separately by the transport tests.
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"data":'));
              queueMicrotask(() => controller.error(new TypeError("Response body interrupted")));
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (rule.status) {
        const failure = response(null, rule.status, rule.code, {}, rule.message, rule.details);
        if (rule.retryAfter !== undefined) {
          failure.headers.set("retry-after", String(rule.retryAfter));
        }
        return failure;
      }
      if (rule.data !== undefined) {
        return response(rule.data);
      }
    }
    if (path === "/api/auth/providers" && method === "GET") {
      return response({
        github: scenario.githubEnabled === true,
        google: scenario.googleEnabled === true,
        password: scenario.passwordRecoveryOnly !== true,
        sessionBinding: scenario.githubEnabled === true || scenario.googleEnabled === true,
      });
    }
    if (
      (path === "/api/auth/providers/github/start" ||
        path === "/api/auth/providers/google/start") &&
      method === "POST"
    ) {
      // Keep the preview local; provider navigation needs real backend verification.
      return error(503);
    }
    if (
      (path === "/api/auth/providers/github/result" ||
        path === "/api/auth/providers/google/result") &&
      method === "POST"
    ) {
      return response({ sessionKey: session.sessionKey });
    }
    if (path === "/api/auth/session") {
      return response(signedIn ? session : null);
    }
    if (path === "/api/auth/sign-in/email" && method === "POST") {
      signedIn = true;
      return response({ authenticated: true, sessionKey: session.sessionKey });
    }
    if (path === "/api/auth/sign-out" && method === "POST") {
      signedIn = false;
      return response({});
    }
    if (path === "/installation/driver-configurations" && method === "GET") {
      return response({
        configurations: [
          {
            capability: "sandbox",
            driverId: "sandbox-story",
            implementation: "storybook-driver",
            scope: "installation",
            key: "startup",
            binding: "installation-startup",
            configurationSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                endpoint: { type: "string", description: "Operator-managed endpoint." },
              },
            },
            actions: {},
          },
        ],
      });
    }
    if (path === "/installation" && method === "GET") {
      return response({
        id: "ins_00000000-0000-4000-8000-000000000001",
        name: "Demo installation",
        createdAt,
        capabilities: {
          ...(scenario.unsupportedProvisioning === true
            ? {}
            : { agentProvisioning: { executionModes: ["dedicated"] } }),
          ...(scenario.nativeWorkerSupport === false
            ? {}
            : { nativeWorkers: { support: scenario.nativeWorkerSupport ?? "pinned-runtime" } }),
          ...(scenario.openclawExecutionModes === undefined
            ? {}
            : {
                openclaw: {
                  executionModes: scenario.openclawExecutionModes,
                  ...(scenario.openclawSettingRefusal
                    ? { settingRefusals: { dedicated: scenario.openclawSettingRefusal } }
                    : {}),
                  ...(scenario.sandboxDriverUnavailable ? { sandboxDriverUnavailable: true } : {}),
                },
              }),
          ...(scenario.credentialSourceTypes !== undefined
            ? { credentialSources: { types: scenario.credentialSourceTypes } }
            : {}),
          ...(scenario.pluginCapabilities ? { pluginPolicies: scenario.pluginCapabilities } : {}),
          ...(scenario.pluginDiscoveryCredential
            ? { pluginDiscovery: { credential: scenario.pluginDiscoveryCredential } }
            : {}),
        },
      });
    }
    if (path === "/namespaces" && method === "POST") {
      if (namespaces.some((item) => item.name === body.name)) {
        return error(409, "RESOURCE_CONFLICT");
      }
      const created = { id: nextId("ns"), name: body.name, status: "provisioning", createdAt };
      namespaces.push(created);
      return response(created, 201);
    }
    if (path === "/namespaces" && method === "GET") {
      // Once the story's actions ran, each read takes the next recheck answer: a status for the
      // story's Namespace, "missing" to leave it out of the list, or an HTTP status to fail
      // with. The last one repeats.
      if (evidence.ready && namespaceRechecks.length) {
        const next =
          namespaceRechecks.length > 1 ? namespaceRechecks.shift() : namespaceRechecks[0];
        if (typeof next === "number") {
          return error(next);
        }
        if (next === "missing") {
          return response(namespaces.slice(1));
        }
        namespaces[0].status = next;
      }
      return response(namespaces);
    }
    if (path === "/backends" && method === "GET") {
      return response(backends);
    }
    if (path === "/observability" && method === "GET") {
      return scenario.observabilityDenied
        ? error(403)
        : response({ url: scenario.observabilityUrl ?? null });
    }
    const match = path.match(/^\/namespaces\/([^/]+)\/(.*)$/);
    if (match) {
      const [, ns, resource] = match;
      if (ns !== namespaceId) {
        if (resource === "permissions" && namespaces.some((item) => item.id === ns)) {
          return response({
            agents: { create: true },
            secrets: { create: true },
            installation: { administer: !scenario.observabilityDenied },
          });
        }
        return response([]);
      }
      const deviceLogin = resource.match(
        /^agents(?:\/[^/]+)?\/device-authorizations(?:\/([^/]+)(\/poll)?)?$/,
      );
      if (deviceLogin) {
        const [, id, poll] = deviceLogin;
        if (!id && method === "POST") {
          const session = secretRef(nextId("sec"));
          const login = {
            session,
            status: "pending",
            verificationUrl: "https://auth.openai.com/codex/device",
            userCode: "DEMO-1234",
            expiresAt: new Date(Date.now() + (scenario.oauthExpired ? -1 : 600_000)).toISOString(),
            intervalSeconds: 1,
          };
          deviceLogins.set(session.id, login);
          return response(login);
        }
        const login = deviceLogins.get(id);
        if (!login) {
          return error(404);
        }
        if (poll && method === "POST") {
          if (!scenario.oauthPending) {
            login.status = "ready";
            login.source ??= { kind: "credential_source", namespaceId, id: nextId("cs") };
          }
          return response(login);
        }
        if (!poll && method === "DELETE") {
          deviceLogins.delete(id);
          secrets.delete(id);
          return new Response(null, { status: 204 });
        }
      }
      if (resource === "service-accounts" && method === "GET") {
        return response(scenario.serviceAccountsEmpty ? [] : accounts);
      }
      if (
        (resource === "agents/repository-options" ||
          /^agents\/[^/]+\/repository-options$/.test(resource)) &&
        method === "GET"
      ) {
        const options = scenario.repositoryOptions ?? [
          {
            repositoryRef: "application",
            displayName: "example/application",
            description: "The application and services used by the team.",
            allowedProfiles: ["git-read", "git-write", "git-full"],
          },
          {
            repositoryRef: "handbook",
            displayName: "example/handbook",
            description: "Guides and operating practices for the team.",
            allowedProfiles: ["git-read"],
          },
        ];
        const requestedDescriptions = new Set(
          url.searchParams.get("descriptionRefs")?.split(",") ?? [],
        );
        const descriptionsPending =
          requestedDescriptions.size > 0 &&
          scenario.repositoryDescriptionsPending &&
          repositoryDescriptionRequests++ === 0;
        return response(
          options.map(({ description, ...option }) =>
            requestedDescriptions.has(option.repositoryRef) && !descriptionsPending && description
              ? { ...option, description }
              : option,
          ),
          200,
          undefined,
          {
            ...(descriptionsPending ? { descriptionsPending: true } : {}),
            ...(scenario.repositoryNotConfigured ? { notConfigured: true } : {}),
          },
        );
      }
      if (resource === "presets" && method === "GET") {
        // Lists carry summaries; the template stays on the exact Preset read.
        return response(
          scenario.emptyPresets
            ? []
            : presets.map(({ id, namespaceId, name, createdAt }) => ({
                id,
                namespaceId,
                name,
                createdAt,
              })),
        );
      }
      if (resource.startsWith("presets/") && method === "GET") {
        const selectedPreset = presets.find((item) => item.id === resource.split("/")[1]);
        return selectedPreset ? response(selectedPreset) : error(404);
      }
      if (resource === "agents/plugins" && method === "POST" && scenario.pluginDiscovery) {
        const query = body.q?.trim().toLowerCase();
        if (query) {
          const matches = Object.values(scenario.pluginDiscovery.pages)
            .flatMap((page) => page.plugins)
            .filter((entry) =>
              [entry.name, entry.id, entry.description ?? ""].some((value) =>
                value.toLowerCase().includes(query),
              ),
            );
          const offset = body.cursor ? Number(body.cursor.slice("search-".length)) : 0;
          return response({
            plugins: matches.slice(offset, offset + 20),
            nextCursor: offset + 20 < matches.length ? `search-${offset + 20}` : null,
            setup: scenario.pluginDiscovery.pages.initial.setup,
          });
        }
        const page = scenario.pluginDiscovery.pages[body.cursor ?? "initial"];
        return page ? response(page) : error(400, "PLUGIN_DISCOVERY_INVALID_RESPONSE");
      }
      if (resource === "agents/plugins/details" && method === "POST" && scenario.pluginDiscovery) {
        const entry = scenario.pluginDiscovery.details[body.pluginId];
        return entry ? response(entry) : error(503, "PLUGIN_DISCOVERY_UNAVAILABLE");
      }
      if (resource === "channel-directory/lookup" && method === "POST") {
        if (!secrets.has(body.secretId) || !["users", "channels"].includes(body.kind)) {
          return error(400);
        }
        const candidates =
          body.kind === "users"
            ? [
                { id: "UDEMO123", name: "alex.chen", displayName: "Alex Chen" },
                { id: "UDEMO124", name: "alex.ops", displayName: "Alex Chen" },
                { id: "WDEMO125", name: "sam.rivers", displayName: "Sam Rivers" },
                { id: "UDEMO126", name: "riley.park", displayName: "Riley Park" },
                { id: "UDEMO127", name: "morgan.lee", displayName: "Morgan Lee" },
                { id: "UDEMO128", name: "jordan.bell", displayName: "Jordan Bell" },
                { id: "UDEMO129", name: "taylor.reed", displayName: "Taylor Reed" },
                { id: "UDEMO130", name: "casey.wong", displayName: "Casey Wong" },
                { id: "UDEMO131", name: "jamie.stone", displayName: "Jamie Stone" },
              ]
            : [
                { id: "CDEMO123", name: "general" },
                { id: "GDEMO124", name: "incident-private" },
                { id: "CDEMO125", name: "platform" },
                { id: "CDEMO126", name: "releases" },
                { id: "CDEMO127", name: "support" },
                { id: "CDEMO128", name: "design" },
                { id: "CDEMO129", name: "engineering" },
                { id: "CDEMO130", name: "product" },
                { id: "CDEMO131", name: "announcements" },
              ];
        const query = (body.query ?? "").toLowerCase();
        const matches = candidates.filter((candidate) =>
          body.ids
            ? body.ids.includes(candidate.id)
            : [candidate.id, candidate.name, candidate.displayName ?? ""].some((value) =>
                value.toLowerCase().includes(query),
              ),
        );
        const offset = body.cursor === "page-2" ? 7 : 0;
        if (body.cursor && body.cursor !== "page-2") {
          return error(400);
        }
        const nextCursor = !body.ids && matches.length > offset + 7 ? "page-2" : undefined;
        evidence.directoryResponses.push({
          kind: body.kind,
          query: body.query ?? "",
          cursor: body.cursor ?? null,
          ids: body.ids ?? null,
        });
        return response({
          workspaceId: "TDEMO123",
          workspaceName: "Demo workspace",
          candidates: body.ids ? matches : matches.slice(offset, offset + 7),
          ...(nextCursor ? { nextCursor } : {}),
          complete: !nextCursor,
        });
      }
      if (resource === "credential-sources") {
        if (method === "GET") {
          return response([...credentialSources.values()]);
        }
        if (method === "POST") {
          const uncertain = scenario.credentialRegistrationOutcome && !credentialRegistrationFailed;
          const id = nextId("csr");
          const saved = {
            ...body,
            id,
            config: body.config ?? {},
            ref: { kind: "credential_source", namespaceId, id },
            namespaceId,
            driverId: "credential-gateway-storybook",
            state:
              uncertain && scenario.credentialRegistrationOutcome === "deleting"
                ? "deleting"
                : "ready",
            createdAt,
          };
          credentialSources.set(saved.id, saved);
          if (uncertain) {
            // Preserve the server-owned registration after an uncertain response;
            // recovery operates on the saved source, never another model Secret.
            credentialRegistrationFailed = true;
            if (scenario.credentialRegistrationOutcome === "different-source") {
              const otherId = nextId("csr");
              const other = {
                ...saved,
                id: otherId,
                name: "Another model registration",
                ref: { ...saved.ref, id: otherId },
              };
              credentialSources.set(other.id, other);
              return response(other, 201);
            }
            return error(503, "DEPENDENCY_UNAVAILABLE");
          }
          return response(saved, 201);
        }
      }
      if (resource.startsWith("credential-sources/")) {
        const id = resource.split("/")[1];
        const source = credentialSources.get(id);
        if (!source) {
          return error(404, "NOT_FOUND");
        }
        if (method === "GET") {
          return response(source);
        }
        if (method === "DELETE") {
          credentialSources.delete(id);
          return new Response(null, { status: 204 });
        }
      }
      if (resource === "configurations" && method === "POST") {
        const saved = {
          ...body,
          id: nextId("cfg"),
          namespaceId,
          generation: 1,
          createdAt,
        };
        configs.set(saved.id, saved);
        return response(saved, 201);
      }
      if (resource.startsWith("configurations/")) {
        const saved = configs.get(resource.split("/")[1]);
        if (!saved) {
          return error(404);
        }
        if (method === "GET") {
          // Another browser saves this Configuration once the page has read it
          // (configurationChangedElsewhere), so the next save preflight finds a newer generation.
          if (scenario.configurationChangedElsewhere && !configurationChangedElsewhere) {
            if (configurationReads.has(saved.id)) {
              configurationChangedElsewhere = true;
              saved.generation += 1;
              mergeElsewhere(saved.values, scenario.configurationChangedElsewhere.values ?? {});
            }
            configurationReads.add(saved.id);
          }
          return response(saved);
        }
        if (method === "PATCH") {
          Object.assign(saved, body, { generation: saved.generation + 1 });
          return response({ ...saved, id: scenario.configurationSaveResponseId ?? saved.id });
        }
      }
      if (resource === "permissions" && method === "GET") {
        return response({
          agents: {
            create: !scenario.readOnlyPermissionSummary && !scenario.agentCreateRestricted,
          },
          secrets: { create: !scenario.secretCreateNotPermitted },
          // A read-only member is no Installation administrator either.
          installation: {
            administer: !scenario.readOnlyPermissionSummary && !scenario.observabilityDenied,
          },
        });
      }
      if (resource === "permissions/secrets" && method === "GET") {
        return response({ operateDenied: scenario.secretOperateDenied ?? [] });
      }
      if (resource === "agents") {
        if (method === "GET") {
          return response([...agents.values()]);
        }
        if (method === "POST") {
          const {
            initialWorkspaceFiles = {},
            workspaceDefaultsId: _workspaceDefaultsId,
            ...agentBody
          } = body;
          const saved = {
            ...agentBody,
            id: nextId("agt"),
            namespaceId,
            status: "active",
            desiredRuntimeState: "stopped",
            createdAt,
            activeRevisionId: null,
            servicePrincipalId: "identity_demo_created",
          };
          agents.set(saved.id, saved);
          stagedWorkspaceFiles.set(saved.id, initialWorkspaceFiles);
          credentials.set(saved.id, { transportConfigured: false });
          return response(saved, 201);
        }
      }
      // Create Agent's preflight accepts unless a scenario rule refuses it.
      if (resource === "agents/validate" && method === "POST") {
        return new Response(null, { status: 204 });
      }
      if (resource === "agents/provision" && method === "POST") {
        const {
          configuration,
          initialWorkspaceFiles = {},
          workspaceDefaultsId: _workspaceDefaultsId,
          requestId,
          ...agentBody
        } = body;
        const workId = nextId("work");
        const savedConfig = {
          ...configuration,
          id: nextId("cfg"),
          namespaceId,
          generation: configuration?.secretBindings ? 2 : 1,
          createdAt,
        };
        configs.set(savedConfig.id, savedConfig);
        const saved = {
          ...agentBody,
          id: nextId("agt"),
          namespaceId,
          configurationId: savedConfig.id,
          status: "active",
          desiredRuntimeState: "running",
          createdAt,
          activeRevisionId: null,
          servicePrincipalId: "identity_demo_provisioned",
          ...(agentBody.harnessAuth?.method === "credential_source"
            ? { credentialSources: [{ sourceId: agentBody.harnessAuth.sourceId }] }
            : {}),
        };
        agents.set(saved.id, saved);
        credentials.set(saved.id, { transportConfigured: true });
        for (const [filename, content] of Object.entries(initialWorkspaceFiles)) {
          files.set(`${saved.id}/${filename}`, content);
        }
        // A Stop before the first revision cancels provisioning; the stopped Agent keeps its name.
        const revision = scenario.provisioningCancelledByStop
          ? null
          : snapshot(saved, nextId("rev"), 1);
        if (scenario.provisionedDeploymentStopped || scenario.provisioningCancelledByStop) {
          saved.desiredRuntimeState = "stopped";
        }
        if (revision) {
          revisions.set(revision.id, revision);
          deployments.set(revision.id, {
            deploymentId: revision.id,
            namespaceId,
            agentId: saved.id,
            status: scenario.provisionedDeploymentStatus ?? "queued",
            progress:
              scenario.provisionedDeploymentAttempt === undefined
                ? initialDeploymentProgress(scenario.provisionedDeploymentStatus ?? "queued")
                : {
                    lastAttempt: { at: createdAt, ...scenario.provisionedDeploymentAttempt },
                    nextAttemptAt: createdAt,
                  },
            reads: scenario.provisionedDeploymentStatus === undefined ? 0 : undefined,
            error:
              scenario.provisionedDeploymentStatus !== "failed"
                ? null
                : scenario.provisionedDeploymentStopped
                  ? {
                      code: "REVISION_STOPPED",
                      message: "Deployment ended because the Agent was stopped.",
                    }
                  : (scenario.provisionedDeploymentError ?? {
                      code: "DEPENDENCY_UNAVAILABLE",
                      message:
                        "A dependency the controller needs stayed unavailable through every attempt. Deploy again; if it keeps failing, ask an Installation administrator to check the controller worker log.",
                    }),
            warnings: [],
          });
        }
        provisioning.set(saved.id, {
          requestId,
          workId,
          reads: 0,
          status: scenario.provisioningStatus ?? "queued",
          agentId: saved.id,
          configurationId: savedConfig.id,
          revisionId: revision?.id,
          url: `/namespaces/${namespaceId}/agents/provision/${workId}`,
        });
        provisioning.set(workId, provisioning.get(saved.id));
        return response(
          {
            provisioning: {
              requestId,
              workId,
              status: scenario.provisioningStatus ?? "queued",
              phase: "admitted",
              attemptCount: 1,
              updatedAt: createdAt,
              url: `/namespaces/${namespaceId}/agents/provision/${workId}`,
            },
          },
          202,
        );
      }
      const provisioningMatch = resource.match(/^agents\/provision\/([^/]+)(\/retry)?$/);
      if (provisioningMatch) {
        const [, workId, retrySuffix] = provisioningMatch;
        const current = provisioning.get(workId);
        if (!current) {
          return error(404);
        }
        if (retrySuffix === "/retry" && method === "POST") {
          current.status = "queued";
          current.reads = 0;
          return response(
            {
              provisioning: {
                requestId: current.requestId,
                workId: current.workId,
                status: current.status,
                phase: "admitted",
                attemptCount: 2,
                updatedAt: createdAt,
                url: current.url,
              },
            },
            202,
          );
        }
        if (retrySuffix === undefined && method === "GET") {
          current.reads += 1;
          if (current.status !== "failed") {
            current.status =
              scenario.provisionedDeploymentStatus === "running"
                ? "running"
                : current.reads > 1
                  ? scenario.provisionedDeploymentStatus === "failed" ||
                    scenario.provisioningCancelledByStop
                    ? "failed"
                    : "succeeded"
                  : "running";
          }
          return response({
            provisioning: {
              requestId: current.requestId,
              workId: current.workId,
              status: current.status,
              phase: current.reads > 1 ? "handoff" : "configuration",
              attemptCount: 1,
              updatedAt: createdAt,
              url: current.url,
              ...(current.status === "failed"
                ? {
                    error: scenario.provisioningCancelledByStop
                      ? {
                          code: "PROVISIONING_CANCELLED",
                          message: "Provisioning was cancelled because the Agent was stopped.",
                        }
                      : scenario.provisionedDeploymentStopped
                        ? {
                            code: "REVISION_STOPPED",
                            message: "The Agent was stopped before its first deployment finished.",
                          }
                        : (scenario.provisionedDeploymentError ?? {
                            code:
                              scenario.provisionedDeploymentStatus === "failed"
                                ? "HARNESS_CREDENTIAL_BOOTSTRAP_FAILED"
                                : "PROVISIONING_FAILED",
                            message:
                              scenario.provisionedDeploymentStatus === "failed"
                                ? "Harness credential initialization failed. Correct the cause and deploy again."
                                : "The worker could not finish provisioning.",
                          }),
                  }
                : {}),
              ...(current.status === "succeeded" || current.reads > 1
                ? {
                    configurationId: current.configurationId,
                    agentId: current.agentId,
                    revisionId: current.revisionId,
                  }
                : {}),
              // After handoff the job names its first deployment's wait, as it does for a
              // reader of that deployment (#2744).
              ...(scenario.provisioningNamesDeploymentWait &&
              current.reads > 1 &&
              (current.status === "queued" || current.status === "running")
                ? {
                    progress: {
                      phase: "deployment",
                      lastAttempt:
                        deployments.get(current.revisionId)?.progress?.lastAttempt ?? null,
                    },
                  }
                : {}),
            },
          });
        }
      }
      const agentMatch = resource.match(/^agents\/([^/]+)(.*)$/);
      if (agentMatch) {
        const [, id, suffix] = agentMatch;
        const saved = agents.get(id);
        if (!saved) {
          return error(404);
        }
        const policyPath = `/namespaces/${namespaceId}/agents/${id}/sandbox-policy/networking`;
        const policyDescriptor = {
          capability: "sandbox",
          driverId: "sandbox-story",
          implementation: "storybook-driver",
          scope: "agent",
          key: "sandbox-network-policy",
          binding: "sandbox-policy",
          configurationSchema: networkPolicySchema,
          actions: {
            read: { method: "GET", href: policyPath, available: true },
            validate: { method: "POST", href: `${policyPath}/validate`, available: policyEditing },
            save: { method: "PUT", href: policyPath, available: policyEditing },
            apply: { method: "POST", href: `${policyPath}/apply`, available: policyEditing },
          },
        };
        if (scenario.policyState === "alternate") {
          policyDescriptor.implementation = "another-sandbox-driver";
          policyDescriptor.configurationSchema = structuredClone(networkPolicySchema);
          policyDescriptor.configurationSchema.properties.additions.items.properties.host.enum = [
            "example.org",
            "service.example.org",
          ];
        }
        if (scenario.policyState === "json") {
          policyDescriptor.configurationSchema = structuredClone(networkPolicySchema);
          policyDescriptor.configurationSchema.properties.additions.items.properties.host = {
            title: "Destination hostname",
            anyOf: [{ const: "example.org" }, { const: "service.example.org" }],
          };
        }
        if (suffix === "/driver-configurations" && method === "GET") {
          return response({
            configurations:
              !scenario.policyState || ["unsupported", "ownerDenied"].includes(scenario.policyState)
                ? []
                : [policyDescriptor],
          });
        }
        if (suffix === "/sandbox-policy/networking/validate" && method === "POST") {
          if (scenario.policyState === "editDenied") {
            return error(403, "FORBIDDEN");
          }
          if (scenario.policyState === "conflict") {
            return error(409, "RESOURCE_CONFLICT", "The policy changed. Reload before editing.");
          }
          if (["ceilingDenied", "invalid"].includes(scenario.policyState)) {
            return response({
              success: false,
              error: {
                details: [
                  {
                    path: "/additions/0/host",
                    code: "OUTSIDE_CEILING",
                    message: "The grant exceeds the Installation delegation ceiling.",
                  },
                ],
              },
            });
          }
          return response({
            success: true,
            data: scenario.policyState === "incompletePreview" ? {} : { additions: body.additions },
          });
        }
        if (scenario.policyState && suffix === "/sandbox-policy/networking" && method === "GET") {
          if (scenario.policyState === "ownerDenied") {
            return error(403, "FORBIDDEN");
          }
          const read = ++policyReads;
          if (scenario.policyState === "refreshRace" && !sandboxPolicy.application && read <= 3) {
            // Simulate another operator saving between reads; HTTP workflow coverage uses real saves.
            sandboxPolicy.version = read;
          }
          if (
            sandboxPolicy.application?.state === "pending" &&
            !scenario.policyKeepPending &&
            ++policyPolls > 1
          ) {
            sandboxPolicy.application.state = "applied";
            sandboxPolicy.application.providerVersion = "5";
            sandboxPolicy.applied = {
              revisionId: candidateRevisionId,
              policyVersion: sandboxPolicy.version,
              providerVersion: "5",
              appliedAt: createdAt,
            };
          }
          const result = response({
            policy: sandboxPolicy,
            configuration: policyDescriptor,
            editingEnabled: policyEditing,
            protectedExecution: scenario.policyState === "protected",
            ceiling: policyCeiling,
            defaults:
              scenario.policyState === "unsupported"
                ? null
                : {
                    networkPolicies: [
                      {
                        name: "python-default",
                        binaries: [{ path: policyGrant.binary }],
                        endpoints: [{ host: "example.com", ports: [443], tls: "skip" }],
                      },
                    ],
                  },
            ...(scenario.policyState === "unsupported" || scenario.policyState === "protected"
              ? {}
              : { defaultsRevisionId: candidateRevisionId }),
            capability:
              scenario.policyState === "unsupported"
                ? null
                : { live: true, wildcards: true, portRanges: true },
          });
          if (scenario.policyState === "refreshRace" && (read === 2 || read === 3)) {
            await new Promise((resolve) => setTimeout(resolve, read === 2 ? 300 : 1500));
          }
          return result;
        }
        if (
          scenario.policyState &&
          suffix === "/sandbox-policy/networking/editing" &&
          method === "PATCH"
        ) {
          if (scenario.policyAdminDenied) {
            return error(403, "AUTHORIZATION_DENIED");
          }
          policyEditing = body.enabled;
          return response({ ...agent, sandboxPolicyEditing: policyEditing });
        }
        if (scenario.policyState && suffix === "/sandbox-policy/networking" && method === "PUT") {
          if (scenario.policyState === "ceilingDenied") {
            return error(
              409,
              "RESOURCE_CONFLICT",
              "The requested network grant exceeds the Installation delegation ceiling.",
            );
          }
          if (scenario.policyState === "editDenied") {
            return error(403, "AUTHORIZATION_DENIED");
          }
          if (scenario.policyState === "protected" && body.additions.length > 0) {
            return error(
              409,
              "SANDBOX_POLICY_PROTECTED_EXECUTION",
              "Protected execution applies to this Agent: the Credential Proxy routes alone govern its egress, so network policy additions are refused; only an empty policy can be saved.",
            );
          }
          if (body.expectedVersion !== sandboxPolicy.version) {
            return error(409, "RESOURCE_STATE_CONFLICT");
          }
          sandboxPolicy = {
            ...sandboxPolicy,
            version: sandboxPolicy.version + 1,
            additions: body.additions,
          };
          delete sandboxPolicy.application;
          return response(
            scenario.policyState === "unconfirmedSave"
              ? { ...sandboxPolicy, additions: [] }
              : sandboxPolicy,
          );
        }
        if (
          scenario.policyState &&
          suffix === "/sandbox-policy/networking/apply" &&
          method === "POST"
        ) {
          if (scenario.policyState === "applyRejected") {
            return error(
              409,
              "RESOURCE_CONFLICT",
              "The Agent, revision, editing setting, or policy changed. Reload before applying.",
            );
          }
          sandboxPolicy.application = {
            id: "00000000-0000-4000-8000-000000000009",
            revisionId: body.revisionId,
            policyVersion: sandboxPolicy.version,
            state: "pending",
            requestedBy: "identity_demo",
            requestedAt: createdAt,
          };
          policyPolls = 0;
          return response(sandboxPolicy, 202);
        }
        if (scenario.policyState && suffix.endsWith("/sandbox-policy/networking/recommendations")) {
          if (scenario.policyState === "ownerDenied") {
            return error(403, "FORBIDDEN");
          }
          if (scenario.policyState === "suggestionsUnavailable") {
            return error(503, "DEPENDENCY_UNAVAILABLE");
          }
          return response({
            recommendations:
              scenario.policySuggestions ??
              (scenario.policyState === "empty"
                ? []
                : [
                    {
                      id: "00000000-0000-4000-8000-000000000011",
                      status: "pending",
                      grant:
                        scenario.policyState === "ceilingDenied"
                          ? { ...policyGrant, host: "outside.example.org" }
                          : policyGrant,
                      observations: 4,
                    },
                  ]),
            truncated: false,
          });
        }
        if (scenario.policyState && suffix.endsWith("/runtime/logs")) {
          const stream = { source: "sandbox", sandbox: "os-demo" };
          const log = {
            type: "line",
            time: createdAt,
            level: "warn",
            kind: "sandbox",
            contentClass: "activity",
            stream,
            message: "NET:OPEN DENIED python3.11 → example.org:443",
            fields: { action: "DENIED", rule_name: "default" },
            decision:
              scenario.policyState === "missingMetadata"
                ? undefined
                : {
                    decision: "denied",
                    enforcement: "blocked",
                    binary: policyGrant.binary,
                    host: policyGrant.host,
                    port: 443,
                    rule: "default",
                    engine: "OPA",
                    reason: "Destination is not in the network policy",
                  },
          };
          if (url.searchParams.has("cursor") && scenario.policyNewDenials && !policyNewRead) {
            policyNewRead = true;
            return response({
              revisionId: candidateRevisionId,
              source: "sandbox",
              stream,
              observedAt: createdAt,
              records: Array.from({ length: scenario.policyNewDenials }, (_, index) => ({
                ...log,
                time: new Date(Date.parse(createdAt) + (index + 1) * 1000).toISOString(),
              })),
              cursor: "simulated-policy-new-cursor",
              withheld: 0,
              truncated: false,
            });
          }
          return response({
            revisionId: candidateRevisionId,
            source: "sandbox",
            stream,
            observedAt: createdAt,
            records:
              scenario.policyState === "empty" || url.searchParams.has("cursor")
                ? []
                : [
                    ...(scenario.policyState === "gap"
                      ? [
                          {
                            type: "gap",
                            time: createdAt,
                            stream,
                            reason: "buffer_lost",
                            remedy: "Earlier records are unavailable. Start a fresh window.",
                          },
                        ]
                      : []),
                    ...Array.from({ length: scenario.policyDenialCount ?? 1 }, (_, index) => ({
                      ...log,
                      time: new Date(
                        Date.parse(createdAt) -
                          ((scenario.policyDenialCount ?? 1) - index - 1) * 17000,
                      ).toISOString(),
                      ...(scenario.policyDenialCount
                        ? {
                            decision: {
                              ...log.decision,
                              host: `service-${Math.floor(index / 2) + 1}.example.org`,
                            },
                          }
                        : {}),
                    })),
                  ],
            cursor: "simulated-policy-cursor",
            withheld: 0,
            truncated: false,
          });
        }
        if (suffix === "/plugins/capabilities" && method === "GET" && scenario.pluginCapabilities) {
          return response({
            ...scenario.pluginCapabilities,
            discoveryCredential: scenario.pluginDiscoveryCredential ?? "required",
          });
        }
        if (suffix === "/plugins" && method === "POST" && scenario.pluginDiscovery) {
          const page = scenario.pluginDiscovery.pages[body.cursor ?? "initial"];
          return page ? response(page) : error(400, "PLUGIN_DISCOVERY_INVALID_RESPONSE");
        }
        if (suffix === "/plugins/details" && method === "POST" && scenario.pluginDiscovery) {
          const entry = scenario.pluginDiscovery.details[body.pluginId];
          return entry ? response(entry) : error(503, "PLUGIN_DISCOVERY_UNAVAILABLE");
        }
        if (suffix === "") {
          if (method === "GET") {
            if (scenario.deletingOnRefresh && ++agentReadCount > 1) {
              saved.status = "deleting";
            }
            if (deleted.has(id)) {
              agents.delete(id);
              return error(404);
            }
            if (clearRevisionOnRead.delete(id)) {
              saved.activeRevisionId = null;
            }
            return response(saved);
          }
          if (method === "PATCH") {
            Object.assign(saved, body);
            return response(saved);
          }
          if (method === "DELETE") {
            saved.status = "deleting";
            saved.desiredRuntimeState = "stopped";
            deleted.add(id);
            return response(saved, 202);
          }
        }
        if (suffix === "/permissions" && method === "GET") {
          const allowed = !scenario.readOnlyPermissionSummary;
          return response(
            scenario.agentPermissionSummary ?? {
              update: allowed,
              deploy: allowed,
              operate: allowed,
              delete: allowed,
              administer: allowed,
              configurationUpdate: allowed,
              configurationRead: true,
              configurationSecretsOperate: allowed,
              configurationSecretsOperateDeniedBindings: [],
              agentSourcesOperate: allowed,
              sandboxPolicyRead: allowed,
              readLogs: allowed,
            },
          );
        }
        if (suffix === "/permissions/secrets" && method === "GET") {
          return response({ operateDenied: scenario.secretOperateDenied ?? [] });
        }
        if (suffix === "/stop" && method === "POST") {
          saved.desiredRuntimeState = "stopped";
          if (scenario.clearRevisionOnStopReadback) {
            clearRevisionOnRead.add(id);
          }
          return response(saved, 202);
        }
        if (suffix === "/native-admin" && method === "GET") {
          return response({
            status: scenario.nativeAdmin ?? "disabled",
            url:
              (id === agent.id ? scenario.nativeAdminUrl : undefined) ??
              "/storybook-fixtures/native-admin.html",
          });
        }
        if (suffix === "/harness-status" && method === "GET") {
          // A scenario's harness answers for the current version, as OCC reads it.
          return response(
            scenario.harness === undefined || !saved.activeRevisionId
              ? { status: "unobserved" }
              : {
                  status: "observed",
                  revisionId: saved.activeRevisionId,
                  harness: scenario.harness,
                },
          );
        }
        if (suffix === "/runtime-images" && method === "GET") {
          return response(scenario.runtimeImages ?? { status: "unsupported", images: [] });
        }
        if (suffix === "/runtime-credentials") {
          if (method === "POST") {
            credentials.set(id, { transportConfigured: true });
          }
          if (["GET", "POST"].includes(method)) {
            return response(credentials.get(id) ?? { transportConfigured: true });
          }
        }
        if (suffix === "/deploy" && method === "POST") {
          const lastRevision = Math.max(
            0,
            ...[...revisions.values()]
              .filter((item) => item.agentId === id)
              .map((item) => item.revision),
          );
          const next = snapshot(saved, nextId("rev"), lastRevision + 1);
          revisions.set(next.id, next);
          const stagedFiles = stagedWorkspaceFiles.get(id);
          for (const [filename, content] of Object.entries(stagedFiles ?? {})) {
            files.set(`${id}/${filename}`, content);
          }
          stagedWorkspaceFiles.delete(id);
          saved.desiredRuntimeState = "running";
          deployments.set(next.id, {
            deploymentId: next.id,
            namespaceId,
            agentId: id,
            status: "queued",
            progress: initialDeploymentProgress("queued"),
            reads: 0,
            error: null,
            warnings: [],
          });
          return response(next, 202);
        }
        if (suffix === "/revisions" && method === "GET") {
          if (scenario.latestDeploymentReadStatus) {
            return error(scenario.latestDeploymentReadStatus);
          }
          if (scenario.latestDeploymentReadDelay) {
            await new Promise((resolve) => setTimeout(resolve, scenario.latestDeploymentReadDelay));
          }
          // Summaries, newest first, one page at a time; a cursor continues below a revision.
          const limit = Number(url.searchParams.get("limit") ?? scenario.revisionPageSize ?? 50);
          const cursor = url.searchParams.get("cursor");
          const before = cursor ? Number(cursor.slice("v1.".length)) : Infinity;
          const remaining = [...revisions.values()]
            .filter((item) => item.agentId === id && item.revision < before)
            .sort((left, right) => right.revision - left.revision);
          const page = remaining.slice(0, limit);
          return response(
            page.map((item) => ({
              id: item.id,
              namespaceId: item.namespaceId,
              agentId: item.agentId,
              revision: item.revision,
              backendId: item.backendId,
              configurationId: item.configurationId,
              configurationGeneration: item.configurationGeneration,
              harness: item.harness,
              createdAt: item.createdAt,
              // The API lists each version's deployment outcome and error code (finding 2422).
              deploymentStatus: deployments.get(item.id)?.status ?? null,
              deploymentErrorCode: deployments.get(item.id)?.error?.code ?? null,
            })),
            200,
            undefined,
            { nextCursor: remaining.length > limit ? `v1.${page.at(-1).revision}` : null },
          );
        }
        if (suffix.startsWith("/revisions/") && method === "GET") {
          return revisions.has(suffix.split("/")[2])
            ? response(revisions.get(suffix.split("/")[2]))
            : error(404);
        }
        if (suffix.startsWith("/deployments/") && suffix.endsWith("/runtime") && method === "GET") {
          const revisionId = suffix.split("/")[2];
          if (!revisions.has(revisionId)) {
            return error(404);
          }
          if (scenario.bootstrapRuntime) {
            const terminated = (name, reason, exitCode) => ({
              name,
              state: "terminated",
              reason,
              ready: false,
              restartCount: 0,
              startedAt: createdAt,
              lastTermination: { reason, exitCode, finishedAt: createdAt },
            });
            const pod = {
              role: "agent",
              cluster: "control",
              name: "oauth-bootstrap-demo-pod",
              uid: "bootstrap-demo-uid",
              phase: "Failed",
              ready: false,
              createdAt,
              events: [],
              containers: [
                terminated("prepare-oauth-home", "Completed", 0),
                terminated("oauth-bootstrap", "Error", 1),
              ],
            };
            return response({
              revisionId,
              observedAt: createdAt,
              pods: [pod],
              sources: [
                {
                  id: "agent",
                  kind: "container",
                  available: true,
                  retention: "Output disappears after cleanup.",
                  pods: ["oauth-bootstrap", "prepare-oauth-home"].map((container) => ({
                    name: pod.name,
                    uid: pod.uid,
                    container,
                    restartCount: 0,
                  })),
                },
              ],
            });
          }
          const startup = scenario.runtimePod === "startupWarnings";
          const pod = {
            role: "gateway",
            cluster: "control",
            name: "gateway-7d9f8c-x2k4q",
            uid: "0f3b6c1e-7d52-4f4b-9a2e-5c6d7e8f9a01",
            phase: "Running",
            ready: true,
            createdAt: "2026-09-27T10:00:00.000Z",
            containers: [
              {
                name: "gateway",
                state: "running",
                reason: null,
                ready: true,
                restartCount: startup ? 0 : 1,
                startedAt: "2026-09-27T11:40:00.000Z",
                lastTermination: startup
                  ? null
                  : {
                      reason: "OOMKilled",
                      exitCode: 137,
                      finishedAt: "2026-09-27T11:39:58.000Z",
                    },
              },
            ],
            // A healthy first deploy: readiness probes failed while the Gateway started.
            events: startup
              ? [
                  {
                    type: "Warning",
                    container: "gateway",
                    reason: "Unhealthy",
                    message: "Readiness probe failed: Gateway /readyz unavailable: ECONNREFUSED",
                    count: 8,
                    lastObservedAt: "2026-09-27T11:40:20.000Z",
                  },
                ]
              : [
                  {
                    type: "Warning",
                    reason: "BackOff",
                    message: "Back-off restarting failed container gateway",
                    count: 2,
                    lastObservedAt: "2026-09-27T11:39:59.000Z",
                  },
                ],
          };
          const pods = [pod];
          if (scenario.runtimePod === "dedicatedPair") {
            // A dedicated Agent: a Harness Pod beside the Gateway, both with the generated long
            // names and completed init containers a real install shows. This story is about the
            // Pod cards; its Agent (Harness) source reads the same simulated Gateway output.
            const completed = (name) => ({
              name,
              state: "terminated",
              reason: "Completed",
              ready: false,
              restartCount: 0,
              startedAt: "2026-09-27T10:00:02.000Z",
              lastTermination: {
                reason: "Completed",
                exitCode: 0,
                finishedAt: "2026-09-27T10:00:04.000Z",
              },
            });
            const running = (name) => ({
              name,
              state: "running",
              reason: null,
              ready: true,
              restartCount: 0,
              startedAt: "2026-09-27T10:00:05.000Z",
              lastTermination: null,
            });
            pods.splice(
              0,
              1,
              {
                ...pod,
                role: "agent",
                name: "agent-9194e1800111-rev-997042d6ce64-6b5bbd9699-v5rcp",
                uid: "8d6b1c2e-3f4a-4b5c-9d6e-7f8a9b0c1d2e",
                containers: [
                  running("agent"),
                  completed("prepare-private-state"),
                  completed("initialize-workspace"),
                ],
                events: [],
              },
              {
                ...pod,
                name: "gateway-9194e1800111-65579dc888-j2czd",
                containers: [running("gateway"), completed("prepare-private-state")],
                events: [],
              },
            );
          }
          if (scenario.runtimePod === "rollover") {
            const retiring = podRolloverStatusReads++ === 0;
            pods.push({
              ...pod,
              name: retiring ? "gateway-retiring" : "gateway-standby",
              uid: pod.uid.slice(0, -1) + (retiring ? "2" : "3"),
            });
          }
          return response({
            revisionId,
            observedAt: "2026-09-27T12:00:00.000Z",
            pods,
            sources: [
              {
                id: "gateway",
                kind: "container",
                pods: pods
                  .filter(({ role }) => role === "gateway")
                  .map(({ name, uid }) => ({
                    name,
                    uid,
                    container: "gateway",
                    restartCount: 1,
                  })),
                available: true,
                retention:
                  "Kubernetes keeps only the current and the previous instance of each container; older output and output from deleted Pods is gone.",
              },
              ...pods
                .filter(({ role }) => role === "agent")
                .map(({ name, uid }) => ({
                  id: "agent",
                  kind: "container",
                  pods: [{ name, uid, container: "agent", restartCount: 0 }],
                  available: true,
                  retention: "Kubernetes keeps the current and the previous instance.",
                })),
            ],
          });
        }
        if (
          suffix.startsWith("/deployments/") &&
          suffix.endsWith("/runtime/logs") &&
          method === "GET"
        ) {
          const revisionId = suffix.split("/")[2];
          if (url.searchParams.get("download") === "true") {
            // Downloads are a text/plain attachment, not a JSON envelope.
            if (scenario.runtimeLogDownloadNoPod) {
              return new Response(
                `# agent=${id} revision=${revisionId} source=${url.searchParams.get("source")} observedAt=2026-09-27T11:41:10.000Z withheld=0\n`,
                {
                  status: 200,
                  headers: {
                    "content-type": "text/plain; charset=utf-8",
                    "content-disposition": `attachment; filename="${id}-${revisionId}-${url.searchParams.get("source")}-no-pod.log"`,
                  },
                },
              );
            }
            return new Response(
              [
                "2026-09-27T11:40:01.120Z info wrapper runtime.startup_phase container=gateway phase=config outcome=ok ms=12",
                "2026-09-27T11:40:03.400Z info openclaw [gateway] gateway listening",
                "2026-09-27T11:41:10.000Z warn openclaw [channels/slack] slack socket reconnect with token=[redacted:key-value]",
                "",
              ].join("\n"),
              {
                status: 200,
                headers: {
                  "content-type": "text/plain; charset=utf-8",
                  "content-disposition": `attachment; filename="${revisionId}-gateway.log"`,
                },
              },
            );
          }
          if (scenario.bootstrapRuntime) {
            const container = url.searchParams.get("container") ?? "oauth-bootstrap";
            const stream = {
              source: "agent",
              pod: "oauth-bootstrap-demo-pod",
              podUid: "bootstrap-demo-uid",
              container,
              restartCount: 0,
            };
            return response({
              revisionId,
              source: "agent",
              stream,
              observedAt: createdAt,
              withheld: 0,
              truncated: false,
              cursor: null,
              records: [
                {
                  type: "line",
                  time: createdAt,
                  stream,
                  contentClass: "operational",
                  kind: "text",
                  level: "unknown",
                  message:
                    container === "oauth-bootstrap"
                      ? "Credential file initialization failed."
                      : "Private directory initialization completed.",
                },
              ],
            });
          }
          const pod = url.searchParams.get("pod") ?? "gateway-7d9f8c-x2k4q";
          const podSuffix =
            pod === "gateway-retiring" ? "2" : pod === "gateway-standby" ? "3" : "1";
          const stream = {
            source: "gateway",
            pod,
            podUid: "0f3b6c1e-7d52-4f4b-9a2e-5c6d7e8f9a0" + podSuffix,
            container: "gateway",
            restartCount: 1,
          };
          const listeningMessage =
            scenario.runtimePod === "rollover" ? `${pod} ready for requests` : "gateway listening";
          const line = (time, kind, level, message, extra = {}) => ({
            type: "line",
            time,
            stream,
            contentClass: "operational",
            kind,
            level,
            message,
            ...extra,
          });
          return response({
            revisionId,
            source: "gateway",
            stream,
            observedAt: "2026-09-27T12:00:00.000Z",
            records: [
              line("2026-09-27T11:40:01.120Z", "wrapper", "info", "runtime.startup_phase", {
                fields: { container: "gateway", phase: "config", outcome: "ok", ms: 12 },
              }),
              line("2026-09-27T11:40:03.400Z", "openclaw", "info", listeningMessage, {
                subsystem: "gateway",
              }),
              {
                type: "withheld",
                time: "2026-09-27T11:40:04.000Z",
                stream,
                count: 3,
                reason: "unrecognised_structured",
              },
              line(
                "2026-09-27T11:41:10.000Z",
                "openclaw",
                "warn",
                "slack socket reconnect with token=[redacted:key-value]",
                { subsystem: "channels/slack" },
              ),
            ],
            withheld: 3,
            truncated: false,
            cursor: `v1.${"a".repeat(40)}.${"b".repeat(43)}`,
          });
        }
        if (
          suffix.startsWith("/deployments/") &&
          suffix.endsWith("/diagnostics") &&
          method === "POST"
        ) {
          const revisionId = suffix.split("/")[2];
          if (!revisions.has(revisionId)) {
            return error(404);
          }
          if (scenario.diagnosticsState === "noSlack") {
            // The gateway's answer for a version with no Slack channel.
            return response({
              revisionId,
              observedAt: "2026-09-27T12:00:00.000Z",
              checks: [
                ["configuration", "failed", "NOT_CONFIGURED"],
                ["authentication", "unknown"],
                ["connectivity", "unknown"],
              ].map(([check, state, code]) => ({
                component: "gateway",
                check,
                state,
                checkedAt: "2026-09-27T11:59:59.000Z",
                ...(code ? { code } : {}),
              })),
            });
          }
          return response({
            revisionId,
            observedAt: "2026-09-27T12:00:00.000Z",
            checks:
              scenario.diagnosticsState === "unknown"
                ? [
                    {
                      component: "gateway",
                      check: "configuration",
                      state: "succeeded",
                      checkedAt: "2026-09-27T11:59:59.000Z",
                    },
                    {
                      component: "gateway",
                      check: "authentication",
                      state: "unknown",
                      checkedAt: "2026-09-27T11:59:59.000Z",
                      code: "PROBE_FAILED",
                    },
                    {
                      component: "gateway",
                      check: "connectivity",
                      state: "unknown",
                      checkedAt: "2026-09-27T11:59:59.000Z",
                      code: "INCOMPATIBLE_RESPONSE",
                    },
                  ]
                : [
                    {
                      component: "gateway",
                      check: "configuration",
                      state: "succeeded",
                      checkedAt: "2026-09-27T11:59:59.000Z",
                    },
                    {
                      component: "gateway",
                      check: "authentication",
                      state: "succeeded",
                      checkedAt: "2026-09-27T11:59:59.000Z",
                    },
                    {
                      component: "gateway",
                      check: "connectivity",
                      state: "succeeded",
                      checkedAt: "2026-09-27T11:59:59.000Z",
                    },
                  ],
          });
        }
        if (suffix.startsWith("/deployments/") && method === "GET") {
          const deployment = deployments.get(suffix.split("/")[2]);
          if (!deployment) {
            return error(404);
          }
          if (scenario.cleanupCompletes && deployment.cleanup) {
            deployment.cleanupReads = (deployment.cleanupReads ?? 0) + 1;
            if (deployment.cleanupReads >= 3) {
              deployment.cleanup = { status: "succeeded", nextAttemptAt: null };
            }
          }
          if (deployment.reads !== undefined && ++deployment.reads > 1) {
            deployment.status = "succeeded";
            deployment.progress = null;
            saved.desiredRuntimeState = "running";
            saved.activeRevisionId = deployment.deploymentId;
          }
          const { reads: _reads, cleanupReads: _cleanupReads, ...status } = deployment;
          return response(status);
        }
        if (suffix.startsWith("/workspace/files/")) {
          const filename = decodeURIComponent(suffix.split("/").at(-1));
          const key = `${id}/${filename}`;
          if (method === "PUT") {
            files.set(key, body.content);
          }
          if (["GET", "PUT"].includes(method)) {
            return response({
              name: filename,
              content:
                files.get(key) ??
                `# ${filename}\n\nDemo workspace guidance. Edit this text and save to the local fixture.\n`,
            });
          }
        }
      }
      if (resource === "iam/roles") {
        if (method === "GET") {
          return response(roles);
        }
        if (method === "POST") {
          const role = { ...body, id: `role_${serial++}`, namespaceId };
          roles.push(role);
          return response(role, 201);
        }
      }
      if (resource === "iam/access-bindings") {
        if (method === "GET") {
          return response(bindings);
        }
        if (method === "POST") {
          const binding = { ...body, id: `binding_${serial++}`, namespaceId };
          bindings.push(binding);
          return response(binding, 201);
        }
      }
      const bindingMatch = resource.match(/^iam\/access-bindings\/([^/]+)$/);
      if (bindingMatch && method === "DELETE") {
        const index = bindings.findIndex((binding) => binding.id === bindingMatch[1]);
        if (index < 0) {
          return error(404);
        }
        bindings.splice(index, 1);
        return new Response(null, { status: 204 });
      }
      if (resource === "secrets") {
        if (method === "POST" && scenario.denySecretCreate) {
          return response(undefined, 403, "FORBIDDEN");
        }
        if (method === "GET") {
          return response(
            scenario.emptySecrets
              ? []
              : [...secrets.values()]
                  .filter(({ id }) => id !== scenario.unreadableSecretId)
                  .map((secret) => structuredClone(secret)),
          );
        }
        if (method === "POST") {
          if ([...secrets.values()].some((secret) => secret.name === body.name?.trim())) {
            return response(undefined, 409, "RESOURCE_CONFLICT");
          }
          const id = nextId("sec");
          const secret = secretMetadata(id, body.name ?? "Demo Secret (simulated)");
          secrets.set(secret.id, secret);
          return response(structuredClone(secret), 201);
        }
      }
      if (resource.startsWith("secrets/")) {
        const id = resource.split("/")[1];
        const secret = secrets.get(id);
        if (!secret || id === scenario.unreadableSecretId) {
          return error(404);
        }
        if (method === "GET") {
          return response({
            ...structuredClone(secret),
            consumers: structuredClone(
              scenario.secretConsumers ?? {
                agents: [],
                configurations: [],
                credentialSources: [],
                provisioningRequests: [],
                unreadable: 0,
                truncated: false,
              },
            ),
            callerPermissions: { update: true, delete: true, ...scenario.secretCallerPermissions },
          });
        }
        if (method === "PATCH") {
          const updated = { ...secret };
          secrets.set(id, updated);
          return response(structuredClone(updated));
        }
        if (method === "DELETE") {
          const consumers = scenario.secretConsumers;
          if (
            consumers &&
            (consumers.unreadable ||
              consumers.truncated ||
              [
                consumers.agents,
                consumers.configurations,
                consumers.credentialSources,
                consumers.provisioningRequests,
              ].some((ids) => ids.length))
          ) {
            return response(undefined, 409, "RESOURCE_CONFLICT");
          }
          secrets.delete(id);
          return new Response(null, { status: 204 });
        }
      }
    }
    evidence.unhandled.push({ method, path });
    console.error(`Unconfigured story request: ${method} ${path}`);
    return error(501);
  };
}
