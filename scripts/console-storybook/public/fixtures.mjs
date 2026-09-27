import standardCodexPreset from "/console/standard-codex-preset.mjs";
import standardOpenclawPreset from "/console/standard-openclaw-preset.mjs";
import devdayPreset from "/console/devday-preset.mjs";
import devdayPartnersPreset from "/console/devday-partners-preset.mjs";
import devdayQaPreset from "/console/devday-qa-preset.mjs";
import devdayOncallPreset from "/console/devday-oncall-preset.mjs";

const createdAt = "2026-09-01T12:00:00.000Z";
const namespaceId = "ns_00000000-0000-4000-8000-000000000001";
const currentRevisionId = "rev_00000000-0000-4000-8000-000000000006";
const candidateRevisionId = "rev_00000000-0000-4000-8000-000000000007";
const secretRef = (id) => ({ kind: "secret", namespaceId, id });
const auth = { method: "api_key", source: secretRef("sec_demo_model") };

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
    agents: { defaults: { model: "codex/gpt-4.1" } },
    channels: {},
  };
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
      allowFrom: scenario.slackPolicy === "open" ? ["*"] : ["UDEMO123"],
      channels: slackChannels(scenario),
    };
  }
  return values;
}

// This is a presentation fixture, not a controller implementation or backend test double.
// Every request stays inside this frame. Unsupported requests fail visibly, never go live.
export function installFixture(scenario, evidence) {
  const rules = structuredClone(scenario.rules ?? []);
  let signedIn = !scenario.signedOut;
  let serial = 100;
  const nextId = (prefix) =>
    `${prefix}_00000000-0000-4000-8000-${String(serial++).padStart(12, "0")}`;
  const configs = new Map();
  const agents = new Map();
  const revisions = new Map();
  const deployments = new Map();
  const provisioning = new Map();
  const credentials = new Map();
  const files = new Map();
  const secrets = new Map();
  const stagedWorkspaceFiles = new Map();
  const roles = [];
  const bindings = [];
  const deleted = new Set();
  const session = {
    authenticated: true,
    sessionKey: "storybook-session",
    user: { id: "storybook-operator", name: "Demo Operator", email: "operator@example.com" },
  };
  const namespaces = scenario.emptyNamespaces
    ? []
    : [
        {
          id: namespaceId,
          name: scenario.namespaceName ?? "Engineering",
          status: "ready",
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
  }
  configs.set(config.id, config);
  const selectedAuth =
    scenario.auth === null
      ? null
      : scenario.auth === "runtime"
        ? { method: "runtime" }
        : scenario.auth === "service"
          ? { method: "chatgpt_service_account", serviceAccountId: "sa_demo" }
          : auth;
  let selectedRevisionId = null;
  if (scenario.candidateDeploymentStatus) {
    selectedRevisionId =
      scenario.candidateDeploymentStatus === "succeeded" || scenario.candidateSelected
        ? candidateRevisionId
        : currentRevisionId;
  } else if (scenario.deployed) {
    selectedRevisionId = "rev_00000000-0000-4000-8000-000000000001";
  }
  const agent = {
    id: "agt_00000000-0000-4000-8000-000000000001",
    namespaceId,
    name: scenario.agentName ?? "Research assistant",
    status: scenario.deleting ? "deleting" : "active",
    desiredRuntimeState: scenario.stopped ? "stopped" : scenario.deployed ? "running" : "stopped",
    configurationId: config.id,
    executionMode: "dedicated",
    harnessAuth: selectedAuth,
    servicePrincipalId: "identity_demo_agent",
    createdAt,
    activeRevisionId: selectedRevisionId,
    ...(scenario.repositoryBindings
      ? { repositoryBindings: structuredClone(scenario.repositoryBindings) }
      : {}),
  };
  agents.set(agent.id, agent);
  credentials.set(agent.id, { transportConfigured: scenario.transport !== false });
  function snapshot(owner, id, revision) {
    const configuration = configs.get(owner.configurationId);
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
      harness: { id: "codex", version: "demo", mode: owner.executionMode },
      compute: { id: "kubernetes-demo", implementation: "kubernetes" },
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
    deployments.set(revisionId, {
      deploymentId: revisionId,
      namespaceId,
      agentId: agent.id,
      status: "succeeded",
      error: null,
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
        error:
          scenario.candidateDeploymentStatus === "failed"
            ? scenario.candidateSelected
              ? {
                  code: "REVISION_FINALIZATION_INCOMPLETE",
                  message: "Deployment reconciliation failed.",
                }
              : {
                  code: "CONVERGENCE_DEADLINE_EXCEEDED",
                  message: "Deployment convergence deadline exceeded.",
                  data: {
                    timeoutMs: 60000,
                    runtimeFailure: {
                      component: "harness",
                      check: "readiness",
                      code: "TIMEOUT",
                      checkedAt: candidate.createdAt,
                    },
                  },
                }
            : null,
        warnings: scenario.candidateDeploymentWarnings ?? [],
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
  const preset = {
    id: scenario.devdayPreset ? "pre_devday_codex" : "pre_00000000-0000-4000-8000-000000000001",
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
  if (scenario.standardCodexPreset || scenario.standardOpenclawPreset || scenario.devdayPreset) {
    Object.assign(
      preset,
      structuredClone(
        scenario.devdayPreset
          ? devdayPreset
          : scenario.standardOpenclawPreset
            ? standardOpenclawPreset
            : standardCodexPreset,
      ),
    );
  }
  if (scenario.presetWorkspaceFiles) {
    preset.template.agent.initialWorkspaceFiles = structuredClone(scenario.presetWorkspaceFiles);
  }
  const presets = [preset];
  if (scenario.devdayPreset) {
    for (const [name, definition] of [
      ["standard-codex", standardCodexPreset],
      ["standard-openclaw", standardOpenclawPreset],
      ["devday-partners", devdayPartnersPreset],
      ["devday-qa", devdayQaPreset],
      ["devday-oncall", devdayOncallPreset],
    ]) {
      presets.push({
        ...structuredClone(definition),
        id: `pre_${name.replaceAll("-", "_")}`,
        namespaceId,
      });
    }
  }
  const response = (data, status = 200, errorCode) =>
    new Response(
      JSON.stringify({
        ...(errorCode
          ? { error: { code: errorCode, message: "The selected preview simulates this failure." } }
          : { data }),
        meta: { requestId: "req_00000000-0000-4000-8000-000000000001" },
      }),
      { status, headers: { "content-type": "application/json" } },
    );
  const error = (status, code) => response(null, status, code);
  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.origin);
    const path = url.pathname;
    const method = options.method ?? "GET";
    evidence.requests.push({ method, path });
    for (const rule of rules) {
      if (
        rule.used ||
        (rule.method ?? "GET") !== method ||
        (rule.path && rule.path !== path) ||
        (rule.prefix && !path.startsWith(rule.prefix)) ||
        (rule.suffix && !path.endsWith(rule.suffix))
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
      if (rule.status) {
        return error(rule.status, rule.code);
      }
    }
    const body = options.body ? JSON.parse(options.body) : {};
    if (path === "/api/auth/session") {
      return response(signedIn ? session : null);
    }
    if (path === "/api/auth/sign-in/email" && method === "POST") {
      signedIn = true;
      return response(session);
    }
    if (path === "/api/auth/sign-out" && method === "POST") {
      signedIn = false;
      return response({});
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
          ...(scenario.pluginCapabilities ? { pluginPolicies: scenario.pluginCapabilities } : {}),
          ...(scenario.pluginDiscoveryCredential
            ? { pluginDiscovery: { credential: scenario.pluginDiscoveryCredential } }
            : {}),
        },
      });
    }
    if (path === "/namespaces" && method === "GET") {
      return response(namespaces);
    }
    if (path === "/backends" && method === "GET") {
      return response(backends);
    }
    const match = path.match(/^\/namespaces\/([^/]+)\/(.*)$/);
    if (match) {
      const [, ns, resource] = match;
      if (ns !== namespaceId) {
        return response([]);
      }
      if (resource === "service-accounts" && method === "GET") {
        return response(accounts);
      }
      if (resource === "agents/repository-options" && method === "GET") {
        return response(
          scenario.repositoryOptions ?? [
            {
              repositoryRef: "application",
              displayName: "example/application",
              allowedProfiles: ["git-read", "git-write", "git-full"],
            },
            {
              repositoryRef: "handbook",
              displayName: "example/handbook",
              allowedProfiles: ["git-read"],
            },
          ],
        );
      }
      if (resource === "presets" && method === "GET") {
        return response(scenario.emptyPresets ? [] : presets);
      }
      if (resource.startsWith("presets/") && method === "GET") {
        const selectedPreset = presets.find((item) => item.id === resource.split("/")[1]);
        return selectedPreset ? response(selectedPreset) : error(404);
      }
      if (resource === "agents/plugins" && method === "POST" && scenario.pluginDiscovery) {
        const page = scenario.pluginDiscovery.pages[body.cursor ?? "initial"];
        return page ? response(page) : error(400, "PLUGIN_DISCOVERY_INVALID_RESPONSE");
      }
      if (resource === "agents/plugins/details" && method === "POST" && scenario.pluginDiscovery) {
        const entry = scenario.pluginDiscovery.details[body.pluginId];
        return entry ? response(entry) : error(503, "PLUGIN_DISCOVERY_UNAVAILABLE");
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
          return response(saved);
        }
        if (method === "PATCH") {
          Object.assign(saved, body, { generation: saved.generation + 1 });
          return response(saved);
        }
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
        };
        agents.set(saved.id, saved);
        credentials.set(saved.id, { transportConfigured: true });
        for (const [filename, content] of Object.entries(initialWorkspaceFiles)) {
          files.set(`${saved.id}/${filename}`, content);
        }
        const revision = snapshot(saved, nextId("rev"), 1);
        revisions.set(revision.id, revision);
        deployments.set(revision.id, {
          deploymentId: revision.id,
          namespaceId,
          agentId: saved.id,
          status: "queued",
          reads: 0,
          error: null,
          warnings: [],
        });
        provisioning.set(saved.id, {
          requestId,
          workId,
          reads: 0,
          status: scenario.provisioningStatus ?? "queued",
          agentId: saved.id,
          configurationId: savedConfig.id,
          revisionId: revision.id,
          url: `/namespaces/${namespaceId}/agents/provision/${workId}`,
        });
        provisioning.set(workId, provisioning.get(saved.id));
        return response(
          {
            provisioning: {
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
            current.status = current.reads > 1 ? "succeeded" : "running";
          }
          return response({
            provisioning: {
              workId: current.workId,
              status: current.status,
              phase: current.status === "succeeded" ? "handoff" : "configuration",
              attemptCount: 1,
              updatedAt: createdAt,
              url: current.url,
              ...(current.status === "failed"
                ? {
                    error: {
                      code: "PROVISIONING_FAILED",
                      message: "The worker could not finish provisioning.",
                    },
                  }
                : {}),
              ...(current.status === "succeeded"
                ? {
                    configurationId: current.configurationId,
                    agentId: current.agentId,
                    revisionId: current.revisionId,
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
        if (suffix === "") {
          if (method === "GET") {
            if (deleted.has(id)) {
              agents.delete(id);
              return error(404);
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
        if (suffix === "/stop" && method === "POST") {
          saved.desiredRuntimeState = "stopped";
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
            reads: 0,
            error: null,
            warnings: [],
          });
          return response(next, 202);
        }
        if (suffix === "/revisions" && method === "GET") {
          return response([...revisions.values()].filter((item) => item.agentId === id));
        }
        if (suffix.startsWith("/revisions/") && method === "GET") {
          return revisions.has(suffix.split("/")[2])
            ? response(revisions.get(suffix.split("/")[2]))
            : error(404);
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
          if (deployment.reads !== undefined && ++deployment.reads > 1) {
            deployment.status = "succeeded";
            saved.desiredRuntimeState = "running";
            saved.activeRevisionId = deployment.deploymentId;
          }
          return response(deployment);
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
          const role = { ...body, id: `role_${serial++}` };
          roles.push(role);
          return response(role, 201);
        }
      }
      if (resource === "iam/access-bindings") {
        if (method === "GET") {
          return response(bindings);
        }
        if (method === "POST") {
          const binding = { ...body, id: `binding_${serial++}` };
          bindings.push(binding);
          return response(binding, 201);
        }
      }
      if (resource === "secrets") {
        if (method === "POST" && scenario.denySecretCreate) {
          return response(undefined, 403, "FORBIDDEN");
        }
        if (method === "GET") {
          return response(
            scenario.emptySecrets
              ? []
              : [...secrets.values()].map((secret) => structuredClone(secret)),
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
        if (!secret) {
          return error(404);
        }
        if (method === "GET") {
          return response(structuredClone(secret));
        }
        if (method === "PATCH") {
          const updated = { ...secret, name: body.name ?? secret.name };
          secrets.set(id, updated);
          return response(structuredClone(updated));
        }
      }
    }
    evidence.unhandled.push({ method, path });
    console.error(`Unconfigured story request: ${method} ${path}`);
    return error(501);
  };
}
