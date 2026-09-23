const createdAt = "2026-09-01T12:00:00.000Z";
const namespaceId = "ns_00000000-0000-4000-8000-000000000001";
const secretRef = (id) => ({ kind: "secret", namespaceId, id });
const auth = { method: "api_key", source: secretRef("sec_demo_model") };

function configurationValues(scenario) {
  const values = {
    gateway: { mode: "local", auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" } },
    agents: { defaults: { model: "codex/gpt-6-astra" } },
    channels: {},
  };
  if (scenario.slack) {
    values.channels.slack = {
      enabled: true,
      mode: scenario.slackMode ?? "socket",
      dmPolicy: scenario.slackPolicy ?? "pairing",
      groupPolicy: scenario.slackPolicy === "open" ? "open" : "allowlist",
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      allowFrom: scenario.slackPolicy === "open" ? ["*"] : ["UDEMO123"],
      channels: { CDEMO123: { requireMention: true, users: ["UDEMO123"] } },
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
  const credentials = new Map();
  const files = new Map();
  const stagedWorkspaceFiles = new Map();
  const roles = [];
  const bindings = [];
  const deleted = new Set();
  const session = { user: { name: "Demo Operator", email: "operator@example.com" } };
  const namespaces = scenario.emptyNamespaces
    ? []
    : [
        { id: namespaceId, name: "Engineering", status: "ready", createdAt },
        {
          id: "ns_00000000-0000-4000-8000-000000000002",
          name: "Research",
          status: "provisioning",
          createdAt,
        },
      ];
  const providers = scenario.emptyProviders
    ? []
    : [{ id: "chatgpt-demo", name: "ChatGPT", type: "chatgpt" }];
  const accounts = [
    {
      id: "sa_demo",
      name: "Research service",
      providerId: "chatgpt-demo",
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
  const agent = {
    id: "agt_00000000-0000-4000-8000-000000000001",
    namespaceId,
    name: "Research assistant",
    status: scenario.deleting ? "deleting" : "active",
    desiredRuntimeState: scenario.stopped ? "stopped" : scenario.deployed ? "running" : "stopped",
    configurationId: config.id,
    executionMode: "dedicated",
    harnessAuth: selectedAuth,
    servicePrincipalId: "identity_demo_agent",
    createdAt,
    activeRevisionId: scenario.deployed ? "rev_00000000-0000-4000-8000-000000000001" : null,
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
      providerId: owner.providerId ?? null,
      configurationId: configuration.id,
      configurationKind: configuration.kind,
      configurationGeneration: configuration.generation,
      createdAt,
      configuration: structuredClone(configuration.values),
      harnessAuth: structuredClone(owner.harnessAuth),
      harness: { id: "codex", version: "demo", mode: owner.executionMode },
      compute: { id: "kubernetes-demo", implementation: "kubernetes" },
      servicePrincipalId: owner.servicePrincipalId,
    };
  }
  if (scenario.deployed) {
    revisions.set(
      "rev_00000000-0000-4000-8000-000000000001",
      snapshot(agent, "rev_00000000-0000-4000-8000-000000000001", 1),
    );
    deployments.set("rev_00000000-0000-4000-8000-000000000001", {
      deploymentId: "dep_demo",
      revisionId: "rev_00000000-0000-4000-8000-000000000001",
      status: scenario.deploymentStatus ?? "succeeded",
      error:
        scenario.deploymentStatus === "failed"
          ? {
              code: "RUNTIME_NOT_READY",
              message: "The Harness did not become ready before the startup deadline.",
              data: {
                runtimeFailure: {
                  component: "harness",
                  check: "readiness",
                  code: "TIMEOUT",
                  checkedAt: createdAt,
                },
              },
            }
          : null,
    });
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
    id: "pre_00000000-0000-4000-8000-000000000001",
    namespaceId,
    name: "Research assistant",
    template: {
      variables: {
        name: { type: "string", description: "Name for this Agent." },
        model: {
          type: "string",
          default: "codex/gpt-6-astra",
          description: "Model reference copied into the draft.",
        },
      },
      agent: { name: "{{ vars.name }}", executionMode: "dedicated", harnessAuth: auth },
      configuration: {
        values: { ...configurationValues({}), agents: { defaults: { model: "{{ vars.model }}" } } },
      },
    },
  };
  const response = (data, status = 200) =>
    new Response(
      JSON.stringify({ data, meta: { requestId: "req_00000000-0000-4000-8000-000000000001" } }),
      { status, headers: { "content-type": "application/json" } },
    );
  const error = (status) => response(null, status);
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
      rule.used = rule.once === true;
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
      return error(rule.status);
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
    if (path === "/namespaces" && method === "GET") {
      return response(namespaces);
    }
    if (path === "/providers" && method === "GET") {
      return response(providers);
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
      if (resource === "presets" && method === "GET") {
        return response(scenario.emptyPresets ? [] : [preset]);
      }
      if (resource === "presets/pre_00000000-0000-4000-8000-000000000001" && method === "GET") {
        return response(preset);
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
            url: "/storybook-fixtures/native-admin.html",
          });
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
          const next = snapshot(
            saved,
            nextId("rev"),
            [...revisions.values()].filter((item) => item.agentId === id).length + 1,
          );
          revisions.set(next.id, next);
          const stagedFiles = stagedWorkspaceFiles.get(id);
          for (const [filename, content] of Object.entries(stagedFiles ?? {})) {
            files.set(`${id}/${filename}`, content);
          }
          stagedWorkspaceFiles.delete(id);
          saved.desiredRuntimeState = "running";
          deployments.set(next.id, {
            deploymentId: `dep_${next.id}`,
            revisionId: next.id,
            status: "queued",
            reads: 0,
            error: null,
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
        if (suffix.startsWith("/deployments/") && method === "GET") {
          const deployment = deployments.get(suffix.split("/")[2]);
          if (!deployment) {
            return error(404);
          }
          if (deployment.reads !== undefined && ++deployment.reads > 1) {
            deployment.status = "succeeded";
            saved.desiredRuntimeState = "running";
            saved.activeRevisionId = deployment.revisionId;
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
      if (resource === "secrets" || resource.startsWith("secrets/")) {
        const id = resource.split("/")[1] ?? `sec_demo_${serial++}`;
        if (["GET", "POST", "PATCH"].includes(method)) {
          return response(
            { id, namespaceId, name: body.name ?? "Demo Secret", ref: secretRef(id) },
            method === "POST" ? 201 : 200,
          );
        }
      }
    }
    evidence.unhandled.push({ method, path });
    console.error(`Unconfigured story request: ${method} ${path}`);
    return error(501);
  };
}
