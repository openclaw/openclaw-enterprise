import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createControllerApp } from "../../apps/controller/src/index.ts";
import {
  authenticatedHeaders,
  signInToControllerApp,
  createTestAuthPrincipal,
} from "./auth-session.mjs";
import { createTestConfigurationDriver } from "./configuration-driver.mjs";
import { createReadyComputeDriver } from "./development.mjs";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import { grantRole } from "./iam-grants.mjs";
import { createTestSecretDriver } from "./secret-driver.mjs";

export const runtimeLogPodUid = "0f3b6c1e-7d52-4f4b-9a2e-5c6d7e8f9a01";

/**
 * A Compute Driver that implements the runtime log contract over in-memory Pod state.
 * It stands in for the cluster only; OCC authorization, cursor, gap and sanitizer
 * behavior under test is the production code path.
 */
export function createRuntimeLogComputeDriver(options = {}) {
  const calls = [];
  const state = {
    restartCount: 0,
    podUid: runtimeLogPodUid,
    lines: [],
    previousLines: [],
    truncated: false,
    events: [],
    describeError: undefined,
    readError: undefined,
    /** Pods named by the Driver; tests may add a Pod that does not belong to the revision. */
    extraPods: [],
    /**
     * `{ ready }` adds a dedicated Harness Pod and the Agent (Harness) source;
     * `{ created: false }` lists the source with no Pod; `{ ready, stale: true }`
     * also keeps an unready old Harness Pod, as during a rollout.
     */
    harnessPod: undefined,
    /** Lines the Agent (Harness) source returns. */
    harnessLines: [],
    ...options.state,
  };
  const podName = (revision) => `gateway-${revision.id.slice(4, 12)}-0`;
  return createReadyComputeDriver(options.id ?? "runtime-log-compute", {
    implementation: "in-memory-runtime-log-test",
    ...(options.runtimeLogging === undefined ? {} : { runtimeLogging: options.runtimeLogging }),
    calls,
    state,
    podName,
    validateHarnessAuth() {},
    ...(options.sandboxNamespace === undefined
      ? {}
      : {
          // Compute's placement of the Namespace, where the Sandbox Driver finds the Sandbox.
          async resolveSandboxNamespace(namespace) {
            calls.push({ operation: "resolveSandboxNamespace", namespaceId: namespace.id });
            return Object.freeze({ ...namespace, name: options.sandboxNamespace });
          },
        }),
    ...(options.withoutDescribe
      ? {}
      : {
          async describeAgentRuntime(binding, signal, options = {}) {
            assert.ok(signal instanceof AbortSignal);
            calls.push({ operation: "describe", revisionId: binding.revision.id, options });
            if (state.describeError !== undefined) {
              throw state.describeError;
            }
            const name = podName(binding.revision);
            const pods = [
              { name, uid: state.podUid },
              ...state.extraPods.map((pod) => ({ name: pod.name, uid: pod.uid })),
            ];
            const harnessPods =
              state.harnessPod === undefined || state.harnessPod.created === false
                ? []
                : [
                    {
                      name: `agent-${binding.revision.id.slice(4, 12)}-0`,
                      uid: "8d6b1c2e-3f4a-4b5c-9d6e-7f8a9b0c1d2e",
                      ready: state.harnessPod.ready,
                    },
                    ...(state.harnessPod.stale
                      ? [
                          {
                            name: `agent-${binding.revision.id.slice(4, 12)}-old`,
                            uid: "9e7c2d3f-4a5b-4c6d-8e7f-8a9b0c1d2e3f",
                            ready: false,
                          },
                        ]
                      : []),
                  ];
            const described = {
              revisionId: binding.revision.id,
              observedAt: "2026-09-30T12:00:00.000Z",
              pods: pods.map((pod) => ({
                role: "gateway",
                cluster: "control",
                name: pod.name,
                uid: pod.uid,
                phase: "Running",
                ready: true,
                createdAt: "2026-09-30T11:00:00Z",
                containers: [
                  {
                    name: "gateway",
                    state: "running",
                    reason: null,
                    ready: true,
                    restartCount: state.restartCount,
                    startedAt: "2026-09-30T11:00:05Z",
                    lastTermination:
                      state.restartCount === 0
                        ? null
                        : {
                            reason: state.terminationReason ?? "OOMKilled",
                            exitCode: 137,
                            finishedAt: "2026-09-30T11:30:00Z",
                          },
                  },
                ],
                events: pod.name === name && options.events !== false ? state.events : [],
              })),
              sources: [
                {
                  id: "gateway",
                  kind: "container",
                  pods: pods.map((pod) => ({
                    name: pod.name,
                    uid: pod.uid,
                    container: "gateway",
                    restartCount: state.restartCount,
                  })),
                  available: true,
                  retention: "Kubernetes keeps the current and the previous instance.",
                },
              ],
            };
            if (state.harnessPod !== undefined) {
              for (const { ready, ...harness } of harnessPods) {
                described.pods.push({
                  role: "agent",
                  cluster: "control",
                  ...harness,
                  phase: "Running",
                  ready,
                  createdAt: "2026-09-30T11:00:00Z",
                  containers: [
                    {
                      name: "agent",
                      state: "running",
                      reason: null,
                      ready,
                      restartCount: 0,
                      startedAt: "2026-09-30T11:00:05Z",
                      lastTermination: null,
                    },
                  ],
                  events: [],
                });
              }
              described.sources.push({
                id: "agent",
                kind: "container",
                pods: harnessPods.map(({ name, uid }) => ({
                  name,
                  uid,
                  container: "agent",
                  restartCount: 0,
                })),
                available: harnessPods.length > 0,
                ...(harnessPods.length > 0 ? {} : { unavailableCode: "NO_POD" }),
                retention: "Kubernetes keeps the current and the previous instance.",
              });
            }
            return described;
          },
        }),
    ...(options.withoutRead
      ? {}
      : {
          async readAgentRuntimeLogs(binding, request) {
            calls.push({
              operation: "read",
              revisionId: binding.revision.id,
              pod: request.pod,
              container: request.container,
              previous: request.previous,
              tailLines: request.tailLines,
              ...(request.sinceSeconds === undefined ? {} : { sinceSeconds: request.sinceSeconds }),
              limitBytes: request.limitBytes,
            });
            if (state.readError !== undefined) {
              throw state.readError;
            }
            const harness = request.source === "agent";
            const source = harness
              ? state.harnessLines
              : request.previous
                ? state.previousLines
                : state.lines;
            return {
              stream: {
                source: request.source ?? "gateway",
                pod: request.pod,
                podUid: harness ? request.podUid : (state.readPodUid ?? state.podUid),
                container: request.container,
                restartCount: state.readRestartCount ?? state.restartCount,
              },
              observedAt: "2026-09-30T12:00:01.000Z",
              lines: source.slice(-request.tailLines),
              truncated: state.truncated,
            };
          },
        }),
  });
}

/**
 * The production controller app over in-memory state with native IAM, one deployed
 * embedded Agent, and helpers to add principals with exact Agent grants.
 */
export async function createRuntimeLogFixture(options = {}) {
  const installationId = `ins_${randomUUID()}`;
  const admin = await createTestAuthPrincipal({ installationId, name: "Runtime Log Admin" });
  const policy = {
    identities: [admin.seed.principal],
    groups: [],
    memberships: [],
    roles: admin.seed.roles.map((role) => ({
      ...role,
      permissions: role.permissions.map((permission) => ({ ...permission })),
    })),
    bindings: admin.seed.bindings.map((binding) => ({ ...binding })),
    restrictions: [],
  };
  const auditSink = options.auditSink ?? new InMemoryAuditSink();
  const iamDriver = new NativeIAMDriver(
    { loadNativeIAMState: async () => policy },
    { id: "runtime-log-iam" },
  );
  const computeDriver = options.computeDriver ?? createRuntimeLogComputeDriver();
  let controller;
  const app = createControllerApp({
    auth: admin.auth,
    iamDriver,
    auditSink,
    development: { enabled: true, installationId },
    computeDriver,
    ...(options.sandboxDriver === undefined ? {} : { sandboxDriver: options.sandboxDriver }),
    configurationDriver: createTestConfigurationDriver({ id: "runtime-log-configuration" }),
    secretDriver: createTestSecretDriver({ id: "runtime-log-secret" }),
    resolveHarness: resolveApprovedHarness,
    agentRuntimeLogs: options.agentRuntimeLogs ?? {
      enabled: true,
      cursorSecret: `runtime-log-cursor-secret-${randomUUID()}`,
    },
    createController(installation) {
      controller = new OpenClawController(installation, {
        state: new InMemoryPlatformState({ auditSink }),
        recordOperations: false,
      });
      return controller;
    },
  });
  const adminSession = await signInToControllerApp(app, admin);

  async function request(method, path, { session = adminSession, serviceKey, body } = {}) {
    const response = await app.fetch(
      new Request(new URL(path, "http://127.0.0.1"), {
        method,
        headers: {
          ...(serviceKey === undefined
            ? authenticatedHeaders(session)
            : { "x-api-key": serviceKey }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      text,
      // Downloads are text/plain attachments; every other response is JSON.
      body:
        text.length === 0 || !response.headers.get("content-type")?.includes("json")
          ? undefined
          : JSON.parse(text),
      get data() {
        return this.body?.data;
      },
    };
  }

  const bootstrap = await request("POST", "/installation/bootstrap", {
    body: { name: "Runtime log test" },
  });
  assert.equal(bootstrap.status, 201, bootstrap.text);

  async function deployAgent(label = "runtime-logs") {
    const namespace = await request("POST", "/namespaces", {
      body: { name: `${label}-${randomUUID().slice(0, 8)}` },
    });
    assert.equal(namespace.status, 201, namespace.text);
    await controller.handleNamespaceLifecycle(admin.seed.principal.id, namespace.data.id, "ready");
    const secret = await request("POST", `/namespaces/${namespace.data.id}/secrets`, {
      body: { name: "Model API key", value: `model-key-${randomUUID()}` },
    });
    assert.equal(secret.status, 201, secret.text);
    const configuration = await request("POST", `/namespaces/${namespace.data.id}/configurations`, {
      // Dedicated revisions under a Sandbox Driver run the Codex Harness.
      body: {
        kind: "agent",
        values:
          options.sandboxDriver === undefined
            ? createHarnessConfiguration("openclaw", "gpt-4.1")
            : createHarnessConfiguration("codex", "gpt-5.5"),
      },
    });
    assert.equal(configuration.status, 201, configuration.text);
    const agent = await request("POST", `/namespaces/${namespace.data.id}/agents`, {
      body: {
        name: "Runtime log Agent",
        configurationId: configuration.data.id,
        // A selected Sandbox Driver provisions dedicated Harnesses only.
        executionMode: options.sandboxDriver === undefined ? "embedded" : "dedicated",
        harnessAuth: { method: "api_key", source: secret.data.ref },
      },
    });
    assert.equal(agent.status, 201, agent.text);
    policy.identities.push({
      id: `service-agent-${agent.data.id}`,
      kind: "service_principal",
      namespaceId: namespace.data.id,
      agentId: agent.data.id,
    });
    grantRole(policy, `service-agent-${agent.data.id}`, {
      id: `auth-${agent.data.id}`,
      namespaceId: namespace.data.id,
      permissions: { secret: ["operate"] },
      resource: { kind: "secret", id: secret.data.id },
    });
    const deployed = await request(
      "POST",
      `/namespaces/${namespace.data.id}/agents/${agent.data.id}/deploy`,
    );
    assert.equal(deployed.status, 202, deployed.text);
    const base = `/namespaces/${namespace.data.id}/agents/${agent.data.id}/deployments/${deployed.data.id}`;
    return {
      namespace: namespace.data,
      agent: agent.data,
      revisionId: deployed.data.id,
      runtimePath: `${base}/runtime`,
      logsPath: (query = "source=gateway") => `${base}/runtime/logs?${query}`,
    };
  }

  /** One single-permission Role bound to the exact Agent (or its revision). */
  function grantExact(subjectId, id, grant, { namespace, agent, revisionId }) {
    grantRole(policy, subjectId, {
      id,
      namespaceId: namespace.id,
      permissions: [{ action: grant.action, resourceKind: grant.resourceKind }],
      resource: {
        kind: grant.resourceKind,
        id: grant.resourceKind === "agent_revision" ? revisionId : agent.id,
      },
    });
  }

  /** A signed-in human principal holding exactly the listed Agent-scoped actions. */
  async function createPrincipal(label, { namespace, agent, revisionId }, grants) {
    const credentials = {
      email: `${label}-${randomUUID()}@example.com`,
      password: `runtime-password-${randomUUID()}`,
      name: label,
    };
    const account = await admin.auth.createAccount(credentials);
    const principal = admin.auth.principalSeed(account, { grant: "none" }).principal;
    policy.identities.push(principal);
    const bindingIds = [];
    for (const grant of grants) {
      const id = `${label}-${grant.resourceKind}-${grant.action}-${randomUUID().slice(0, 8)}`;
      grantExact(principal.id, id, grant, { namespace, agent, revisionId });
      bindingIds.push(id);
    }
    return {
      principal,
      session: await signInToControllerApp(app, credentials),
      bindingIds,
      revoke(action, resourceKind) {
        const index = policy.bindings.findIndex(
          (binding) =>
            binding.subjectId === principal.id &&
            policy.roles.find((role) => role.id === binding.roleId)?.permissions[0]?.action ===
              action &&
            binding.resourceKind === resourceKind,
        );
        assert.notEqual(index, -1);
        policy.bindings.splice(index, 1);
      },
    };
  }

  /** A Namespace ServicePrincipal with exact Agent grants and one service API key. */
  async function createServicePrincipal(label, { namespace, agent, revisionId }, grants) {
    const principal = {
      id: `service-${label}-${randomUUID().slice(0, 8)}`,
      kind: "service_principal",
      namespaceId: namespace.id,
    };
    policy.identities.push(principal);
    for (const grant of grants) {
      const id = `${principal.id}-${grant.resourceKind}-${grant.action}`;
      grantExact(principal.id, id, grant, { namespace, agent, revisionId });
    }
    const key = await admin.auth.createServiceKey({ principal, name: label });
    return { principal, serviceKey: key.key };
  }

  return {
    app,
    admin,
    adminSession,
    auditSink,
    computeDriver,
    createPrincipal,
    createServicePrincipal,
    deployAgent,
    policy,
    request,
    get controller() {
      return controller;
    },
  };
}

export const operateGrants = [
  { action: "operate", resourceKind: "agent" },
  { action: "read", resourceKind: "agent" },
  { action: "read", resourceKind: "agent_revision" },
];

export const administerGrants = [
  { action: "administer", resourceKind: "agent" },
  { action: "read", resourceKind: "agent" },
  { action: "read", resourceKind: "agent_revision" },
];
