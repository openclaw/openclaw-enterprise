import defaultCodexPreset from "/console/default-codex-preset.mjs";
import standardCodexPreset from "/console/standard-codex-preset.mjs";
import standardOpenclawPreset from "/console/standard-openclaw-preset.mjs";
import swePreset from "/console/swe-preset.mjs";

const createdAt = "2026-09-01T12:00:00.000Z";
const namespaceId = "ns_00000000-0000-4000-8000-000000000001";
const currentRevisionId = "rev_00000000-0000-4000-8000-000000000006";
const candidateRevisionId = "rev_00000000-0000-4000-8000-000000000007";
const secretRef = (id) => ({ kind: "secret", namespaceId, id });
const auth = { method: "api_key", source: secretRef("sec_demo_model") };

function initialDeploymentProgress(status) {
  if (status !== "queued" && status !== "running") {
    return null;
  }
  return { lastAttempt: null, nextAttemptAt: status === "queued" ? createdAt : null };
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
  if (scenario.candidateModelProbeCause) {
    return {
      code: "RUNTIME_MODEL_PROBE_FAILED",
      message: "Deployment runtime startup model check failed.",
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
  if (scenario.candidateSelected) {
    return {
      code: "REVISION_FINALIZATION_INCOMPLETE",
      message: "Deployment reconciliation failed.",
    };
  }
  return {
    code: "CONVERGENCE_DEADLINE_EXCEEDED",
    message: "Deployment convergence deadline exceeded.",
    data: {
      timeoutMs: 60000,
      runtimeFailure: { component: "harness", check: "readiness", code: "TIMEOUT", checkedAt },
    },
  };
}

export function installFixture(scenario, evidence) {
  const rules = structuredClone(scenario.rules ?? []);
  let signedIn = !scenario.signedOut;
  let repositoryDescriptionRequests = 0;
  if (scenario.pendingGithubAttempt) {
    // Simulates returning from a GitHub callback started in this tab.
    sessionStorage.setItem("occ.console.githubAttempt", "a".repeat(43));
  }
  if (scenario.pendingGoogleAttempt) {
    // Simulates returning from a Google callback started in this tab.
    sessionStorage.setItem("occ.console.googleAttempt", "a".repeat(43));
  }
  let serial = 100;
  const nextId = (prefix) =>
    `${prefix}_00000000-0000-4000-8000-${String(serial++).padStart(12, "0")}`;
  const configs = new Map();
  const agents = new Map();
  const revisions = new Map();
  const deployments = new Map();
  const provisioning = new Map();
  const credentials = new Map();
  const deviceLogins = new Map();
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
              ? { method: "oauth", source: secretRef("sec_demo_oauth_deployed") }
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
    ...(scenario.agentPlugins ? { plugins: structuredClone(scenario.agentPlugins) } : {}),
    ...(scenario.agentPluginApprovers !== undefined
      ? { pluginApprovers: structuredClone(scenario.agentPluginApprovers) }
      : {}),
    servicePrincipalId: "identity_demo_agent",
    createdAt,
    activeRevisionId: selectedRevisionId,
    ...(scenario.repositoryAccess
      ? { repositoryAccess: structuredClone(scenario.repositoryAccess) }
      : {}),
    ...(scenario.repositoryBindings
      ? { repositoryBindings: structuredClone(scenario.repositoryBindings) }
      : {}),
  };
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
      progress: null,
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
  if (scenario.presetWorkspaceFiles) {
    preset.template.agent.initialWorkspaceFiles = structuredClone(scenario.presetWorkspaceFiles);
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
  const response = (data, status = 200, errorCode, meta = {}) =>
    new Response(
      JSON.stringify({
        ...(errorCode
          ? { error: { code: errorCode, message: "The selected preview simulates this failure." } }
          : { data }),
        meta: { requestId: "req_00000000-0000-4000-8000-000000000001", ...meta },
      }),
      { status, headers: { "content-type": "application/json" } },
    );
  const error = (status, code) => response(null, status, code);
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
        (rule.suffix && !path.endsWith(rule.suffix)) ||
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
      if (rule.status) {
        return error(rule.status, rule.code);
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
    if (path === "/installation" && method === "GET") {
      return response({
        id: "ins_00000000-0000-4000-8000-000000000001",
        name: "Demo installation",
        createdAt,
        capabilities: {
          ...(scenario.unsupportedProvisioning === true
            ? {}
            : { agentProvisioning: { executionModes: ["dedicated"] } }),
          ...(scenario.nativeWorkerSupport
            ? { nativeWorkers: { support: scenario.nativeWorkerSupport } }
            : {}),
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
    if (path === "/observability" && method === "GET") {
      return scenario.observabilityDenied
        ? error(403)
        : response({ url: scenario.observabilityUrl ?? null });
    }
    const match = path.match(/^\/namespaces\/([^/]+)\/(.*)$/);
    if (match) {
      const [, ns, resource] = match;
      if (ns !== namespaceId) {
        return response([]);
      }
      const deviceLogin = resource.match(
        /^agents(?:\/[^/]+)?\/device-authorizations(?:\/([^/]+)(\/poll)?)?$/,
      );
      if (deviceLogin) {
        const [, id, poll] = deviceLogin;
        if (!id && method === "POST") {
          const source = secretRef(nextId("sec"));
          const login = {
            source,
            status: "pending",
            verificationUrl: "https://auth.openai.com/codex/device",
            userCode: "DEMO-1234",
            expiresAt: new Date(Date.now() + (scenario.oauthExpired ? -1 : 600_000)).toISOString(),
            intervalSeconds: 1,
          };
          deviceLogins.set(source.id, login);
          secrets.set(
            source.id,
            secretMetadata(source.id, "Codex OAuth login (Experimental, simulated)"),
          );
          return response(login);
        }
        const login = deviceLogins.get(id);
        if (!login) {
          return error(404);
        }
        if (poll && method === "POST") {
          if (!scenario.oauthPending) {
            login.status = "ready";
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
          descriptionsPending ? { descriptionsPending: true } : {},
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
          status: scenario.provisionedDeploymentStatus ?? "queued",
          progress: initialDeploymentProgress(scenario.provisionedDeploymentStatus ?? "queued"),
          reads: scenario.provisionedDeploymentStatus === undefined ? 0 : undefined,
          error:
            scenario.provisionedDeploymentStatus === "failed"
              ? { code: "DEPENDENCY_UNAVAILABLE", message: "Deployment reconciliation failed." }
              : null,
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
            progress: initialDeploymentProgress("queued"),
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
        if (suffix.startsWith("/deployments/") && suffix.endsWith("/runtime") && method === "GET") {
          const revisionId = suffix.split("/")[2];
          if (!revisions.has(revisionId)) {
            return error(404);
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
          return response({
            revisionId,
            observedAt: "2026-09-27T12:00:00.000Z",
            pods: [pod],
            sources: [
              {
                id: "gateway",
                kind: "container",
                pods: [{ name: pod.name, uid: pod.uid, container: "gateway", restartCount: 1 }],
                available: true,
                retention:
                  "Kubernetes keeps only the current and the previous instance of each container; older output and output from deleted Pods is gone.",
              },
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
          const stream = {
            source: "gateway",
            pod: "gateway-7d9f8c-x2k4q",
            podUid: "0f3b6c1e-7d52-4f4b-9a2e-5c6d7e8f9a01",
            container: "gateway",
            restartCount: 1,
          };
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
              line("2026-09-27T11:40:03.400Z", "openclaw", "info", "gateway listening", {
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
            deployment.progress = null;
            saved.desiredRuntimeState = "running";
            saved.activeRevisionId = deployment.deploymentId;
          }
          const { reads: _reads, ...status } = deployment;
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
