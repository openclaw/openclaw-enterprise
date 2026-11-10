import { sandboxNamespaceLifecycleBinding } from "../../apps/controller/src/composition/namespace-lifecycle.ts";
import { DEDICATED_OPENCLAW_SUPPORT } from "./sandbox-driver.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver, type NativeIAMState } from "../../packages/iam/src/index.ts";
import { validSandboxPolicyDecision } from "../../packages/contracts/src/index.ts";
import type {
  AgentRevision,
  AgentRuntimeDescribeOptions,
  AgentRuntimeEvent,
  AgentRuntimeLogChunk,
  AgentRuntimeLogRequest,
  AgentRuntimeLogSource,
  AgentRuntimePodStatus,
  ComputeAgentRevisionBinding,
  ComputeDriver,
  Namespace,
  Permission,
  SandboxDriver,
  SandboxHarnessObservation,
  SandboxLogLine,
  SandboxLogRequest,
  ServicePrincipal,
} from "../../packages/contracts/src/index.ts";
import {
  InMemoryPlatformState,
  OpenClawController,
  sanitizeSandboxLogLines,
  type ControllerOptions,
} from "../../packages/occ/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { openShellLogDecisions } from "../../apps/controller/src/drivers/sandbox/openshell-log-decisions.ts";
import { createControllerApp, type ControllerAppOptions } from "../../apps/controller/src/index.ts";
import {
  authenticatedHeaders,
  signInToControllerApp,
  createTestAuthPrincipal,
} from "./auth-session.mjs";
import { createTestConfigurationDriver } from "./configuration-driver.ts";
import { createReadyComputeDriver } from "./development.mjs";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import { grantRole } from "./iam-grants.mjs";
import { jsonRequestInit } from "./inject-json.mjs";
import { createTestSecretDriver } from "./secret-driver.mjs";

type MutableIAMState = { [K in keyof NativeIAMState]: Array<NativeIAMState[K][number]> };

type RuntimeLogComputeState = {
  restartCount: number;
  podUid: string;
  lines: Array<AgentRuntimeLogChunk["lines"][number]>;
  previousLines: Array<AgentRuntimeLogChunk["lines"][number]>;
  truncated: boolean;
  events: AgentRuntimeEvent[];
  describeError: unknown;
  readError: unknown;
  extraPods: Array<{ name: string; uid: string }>;
  gatewayPod: boolean;
  podlessRevisions: string[];
  harnessPod: { ready: boolean; created?: true; stale?: boolean } | { created: false } | undefined;
  harnessLines: Array<AgentRuntimeLogChunk["lines"][number]>;
  observedAt?: string;
  terminationReason?: string;
  readPodUid?: string;
  readRestartCount?: number;
};

type RuntimeLogComputeCall =
  | { operation: "resolveSandboxNamespace"; namespaceId: string; revisionId?: never }
  | { operation: "describe"; revisionId: string; options: AgentRuntimeDescribeOptions }
  | ({ operation: "read"; revisionId: string } & Pick<
      AgentRuntimeLogRequest,
      "pod" | "container" | "previous" | "tailLines" | "sinceSeconds" | "limitBytes"
    >);

type RuntimeLogComputeOptions = {
  id?: string;
  state?: Partial<RuntimeLogComputeState>;
  runtimeLogging?: ComputeDriver["runtimeLogging"];
  sandboxNamespaceName?: (namespaceId: string) => string;
  withoutDescribe?: boolean;
  withoutRead?: boolean;
};

type RuntimeLogFixtureOptions = Pick<
  ControllerAppOptions,
  "agentRuntimeLogs" | "computeDriver" | "sandboxDriver"
> & {
  auditSink?: InMemoryAuditSink;
  driverConfigurations?: ControllerOptions["driverConfigurations"];
};

type RuntimeLogTarget = {
  namespace: { id: string };
  agent: { id: string };
  revisionId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResourceData(value: unknown): value is Record<string, unknown> & { id: string } {
  return isRecord(value) && typeof value.id === "string";
}

function resourceData(value: unknown): Record<string, unknown> & { id: string } {
  assert.ok(isResourceData(value));
  return value;
}

function isSandboxLogLine(value: unknown): value is SandboxLogLine {
  return (
    isRecord(value) &&
    (value.time === null || typeof value.time === "string") &&
    typeof value.sandboxId === "string" &&
    typeof value.level === "string" &&
    typeof value.target === "string" &&
    typeof value.message === "string" &&
    typeof value.source === "string" &&
    isRecord(value.fields) &&
    Object.values(value.fields).every((field) => typeof field === "string") &&
    (value.decision === undefined || validSandboxPolicyDecision(value.decision))
  );
}

export const runtimeLogPodUid = "0f3b6c1e-7d52-4f4b-9a2e-5c6d7e8f9a01";

/**
 * The runtime log records a read of raw OpenShell Sandbox lines produces: the Driver's
 * decoration over the whole read, then OCC's sanitizer. Console tests that route the log
 * page serve these, so what they render is what the product parses.
 */
export function openShellSandboxRecords(lines: readonly unknown[], sandbox = "browser-policy") {
  assert.ok(lines.every(isSandboxLogLine));
  return sanitizeSandboxLogLines({ source: "sandbox", sandbox }, openShellLogDecisions(lines))
    .records;
}

/**
 * A Compute Driver that implements the runtime log contract over in-memory Pod state.
 * It stands in for the cluster only; OCC authorization, cursor, gap and sanitizer
 * behavior under test is the production code path.
 */
export function createRuntimeLogComputeDriver(options: RuntimeLogComputeOptions = {}) {
  const calls: RuntimeLogComputeCall[] = [];
  const state: RuntimeLogComputeState = {
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
    /** `false` reports no Gateway Pod, as for a version whose Pods are gone. */
    gatewayPod: true,
    /** Revisions that report no Gateway Pod, as a version stopped and replaced since. */
    podlessRevisions: [],
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
  const podName = (revision: Pick<AgentRevision, "id">) => `gateway-${revision.id.slice(4, 12)}-0`;
  return createReadyComputeDriver(options.id ?? "runtime-log-compute", {
    implementation: "in-memory-runtime-log-test",
    ...(options.runtimeLogging === undefined ? {} : { runtimeLogging: options.runtimeLogging }),
    calls,
    state,
    podName,
    validateHarnessAuth() {},
    async resolveSandboxNamespaceContext(namespace, signal) {
      return { namespace: await this.resolveSandboxNamespace!(namespace), kubernetes: {}, signal };
    },
    ...(options.sandboxNamespaceName === undefined
      ? {}
      : {
          // Compute's placement of the Namespace, where the Sandbox Driver finds the Sandbox.
          async resolveSandboxNamespace(namespace: Readonly<Namespace>) {
            calls.push({ operation: "resolveSandboxNamespace", namespaceId: namespace.id });
            return Object.freeze({
              ...namespace,
              name: options.sandboxNamespaceName!(namespace.id),
            });
          },
        }),
    ...(options.withoutDescribe
      ? {}
      : {
          async describeAgentRuntime(
            binding: ComputeAgentRevisionBinding,
            signal: AbortSignal,
            options: AgentRuntimeDescribeOptions = {},
          ) {
            assert.ok(signal instanceof AbortSignal);
            calls.push({ operation: "describe", revisionId: binding.revision.id, options });
            if (state.describeError !== undefined) {
              throw state.describeError;
            }
            const name = podName(binding.revision);
            const pods = [
              ...(state.gatewayPod === false || state.podlessRevisions.includes(binding.revision.id)
                ? []
                : [{ name, uid: state.podUid }]),
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
            const described: {
              revisionId: string;
              observedAt: string;
              pods: AgentRuntimePodStatus[];
              sources: AgentRuntimeLogSource[];
            } = {
              revisionId: binding.revision.id,
              observedAt: state.observedAt ?? "2026-09-30T12:00:00.000Z",
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
                  available: pods.length > 0,
                  ...(pods.length > 0 ? {} : { unavailableCode: "NO_POD" }),
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
          async readAgentRuntimeLogs(
            binding: ComputeAgentRevisionBinding,
            request: AgentRuntimeLogRequest,
          ) {
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
 * A Sandbox Driver that stands in for the provider (OpenShell) only: it names one Sandbox per
 * revision and answers from `state`. `state.lines` (or `state.error`) answer the Sandbox log
 * read, decoded by the OpenShell Driver's own decision parser; `state.harness` (or
 * `state.harnessError`) answers the Harness observation, such as a Sandbox a node restart left
 * stopped. OCC's handling of both is the production code path.
 */
export function createProviderSandboxDriver({ id = "console-sandbox" }: { id?: string } = {}) {
  const state: {
    lines: SandboxLogLine[];
    error: Error | undefined;
    harness: SandboxHarnessObservation;
    harnessError: Error | undefined;
  } = {
    lines: [],
    error: undefined,
    harness: { state: "running" },
    harnessError: undefined,
  };
  const logRequests: Array<SandboxLogRequest & { namespace: string }> = [];
  const sandboxName = (revision: Pick<AgentRevision, "id">) => `sb-${revision.id.slice(4, 12)}`;
  const driver = {
    id,
    capability: "sandbox",
    implementation: "openshell",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["networking", "filesystem", "process"],
    async provisionHarness(context) {
      return {
        namespaceName: context.namespace.name,
        resourceName: sandboxName(context.revision),
        agentId: context.revision.agentId,
        revisionId: context.revision.id,
      };
    },
    async cleanup() {},
    async readSandboxLogs(context, request) {
      logRequests.push({ namespace: context.namespace.name, ...request });
      if (state.error !== undefined) {
        throw state.error;
      }
      return {
        sandbox: sandboxName(context.revision),
        observedAt: "2026-09-30T12:00:05.000Z",
        lines: openShellLogDecisions(state.lines),
        bufferTotal: state.lines.length,
      };
    },
    async observeHarness() {
      if (state.harnessError !== undefined) {
        throw state.harnessError;
      }
      return state.harness;
    },
  } satisfies SandboxDriver;
  return { driver, state, logRequests };
}

/**
 * The production controller app over in-memory state with native IAM, one deployed
 * embedded Agent, and helpers to add principals with exact Agent grants.
 */
export async function createRuntimeLogFixture(options: RuntimeLogFixtureOptions = {}) {
  const installationId = `ins_${randomUUID()}`;
  const admin = await createTestAuthPrincipal({ installationId, name: "Runtime Log Admin" });
  const policy: MutableIAMState = {
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
  let controller: OpenClawController;
  let platformState: InMemoryPlatformState;
  const app = createControllerApp({
    auth: admin.auth,
    iamDriver,
    auditSink,
    development: { enabled: true, installationId, browserOrigin: "https://console.oce.localhost" },
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
      platformState = new InMemoryPlatformState({ auditSink });
      controller = new OpenClawController(installation, {
        state: platformState,
        namespaceLifecycleBindings:
          options.sandboxDriver?.ensureNamespace === undefined
            ? []
            : [sandboxNamespaceLifecycleBinding(computeDriver, options.sandboxDriver)],
        recordOperations: false,
        ...(options.driverConfigurations === undefined
          ? {}
          : { driverConfigurations: options.driverConfigurations }),
      });
      return controller;
    },
  });
  const adminSession = await signInToControllerApp(app, admin);

  async function request(
    method: string,
    path: string,
    {
      session = adminSession,
      serviceKey,
      body,
    }: {
      session?: string | { cookie: string; origin?: string };
      serviceKey?: string;
      body?: unknown;
    } = {},
  ) {
    const response = await app.fetch(
      new Request(
        new URL(path, "https://console.oce.localhost"),
        jsonRequestInit(
          method,
          body,
          serviceKey === undefined ? authenticatedHeaders(session) : { "x-api-key": serviceKey },
        ),
      ),
    );
    const text = await response.text();
    const responseBody: unknown =
      text.length === 0 || !response.headers.get("content-type")?.includes("json")
        ? undefined
        : JSON.parse(text);
    return {
      status: response.status,
      headers: response.headers,
      text,
      // Downloads are text/plain attachments; every other response is JSON.
      body: responseBody,
      get data(): unknown {
        return typeof this.body === "object" && this.body !== null && "data" in this.body
          ? this.body.data
          : undefined;
      },
    };
  }

  const bootstrap = await request("POST", "/installation/bootstrap", {
    body: { name: "Runtime log test" },
  });
  assert.equal(bootstrap.status, 201, bootstrap.text);

  async function createReadyNamespace(label: string) {
    const namespace = await request("POST", "/namespaces", {
      body: { name: `${label}-${randomUUID().slice(0, 8)}` },
    });
    assert.equal(namespace.status, 201, namespace.text);
    const data = resourceData(namespace.data);
    await controller.handleNamespaceLifecycle(admin.seed.principal.id, data.id, "ready");
    return data;
  }

  /**
   * Deploys an embedded Agent in a new ready Namespace or, with `namespace`, beside the Agents
   * already there: a sibling of the same kind and Namespace that an exact grant must not reach.
   */
  async function deployAgent(
    label = "runtime-logs",
    { namespace: shared }: { namespace?: { id: string } } = {},
  ) {
    const namespace = shared ?? (await createReadyNamespace(label));
    // Secret and Agent names are unique within a Namespace, so a sibling's carry its label.
    const suffix = shared === undefined ? "" : ` ${label}`;
    const secret = await request("POST", `/namespaces/${namespace.id}/secrets`, {
      body: { name: `Model API key${suffix}`, value: `model-key-${randomUUID()}` },
    });
    assert.equal(secret.status, 201, secret.text);
    const secretData = resourceData(secret.data);
    const configuration = await request("POST", `/namespaces/${namespace.id}/configurations`, {
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
    const configurationData = resourceData(configuration.data);
    const agent = await request("POST", `/namespaces/${namespace.id}/agents`, {
      body: {
        name: `Runtime log Agent${suffix}`,
        configurationId: configurationData.id,
        // A selected Sandbox Driver provisions dedicated Harnesses only.
        executionMode: options.sandboxDriver === undefined ? "embedded" : "dedicated",
        harnessAuth: { method: "api_key", source: secretData.ref },
      },
    });
    assert.equal(agent.status, 201, agent.text);
    const agentData = resourceData(agent.data);
    policy.identities.push({
      id: `service-agent-${agentData.id}`,
      kind: "service_principal",
      namespaceId: namespace.id,
      agentId: agentData.id,
    });
    grantRole(policy, `service-agent-${agentData.id}`, {
      id: `auth-${agentData.id}`,
      namespaceId: namespace.id,
      permissions: { secret: ["operate"] },
      resource: { kind: "secret", id: secretData.id },
    });
    const deployed = await request(
      "POST",
      `/namespaces/${namespace.id}/agents/${agentData.id}/deploy`,
    );
    assert.equal(deployed.status, 202, deployed.text);
    const deployedData = resourceData(deployed.data);
    const base = `/namespaces/${namespace.id}/agents/${agentData.id}/deployments/${deployedData.id}`;
    return {
      namespace,
      agent: agentData,
      revisionId: deployedData.id,
      runtimePath: `${base}/runtime`,
      logsPath: (query = "source=gateway") => `${base}/runtime/logs?${query}`,
    };
  }

  /** One single-permission Role bound to the exact Agent (or its revision). */
  function grantExact(
    subjectId: string,
    id: string,
    grant: Permission,
    { namespace, agent, revisionId }: RuntimeLogTarget,
  ) {
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
  async function createPrincipal(
    label: string,
    { namespace, agent, revisionId }: RuntimeLogTarget,
    grants: readonly Permission[],
  ) {
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
      revoke(action: Permission["action"], resourceKind: Permission["resourceKind"]) {
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
  async function createServicePrincipal(
    label: string,
    { namespace, agent, revisionId }: RuntimeLogTarget,
    grants: readonly Permission[],
  ) {
    const principal: ServicePrincipal = {
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

  /** Publishes the deployed revision as the Agent's active one, as a worker activation would. */
  async function activate({ namespace, agent, revisionId }: RuntimeLogTarget) {
    // Bypasses the worker's activation path (not run here) through the fixture-owned state store.
    const active = await platformState.transact((unit) =>
      unit.agents.compareAndSetActiveRevision(namespace.id, agent.id, undefined, revisionId),
    );
    assert.equal(active?.activeRevisionId, revisionId);
  }

  return {
    activate,
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

export const operateGrants: Permission[] = [
  { action: "operate", resourceKind: "agent" },
  { action: "read", resourceKind: "agent" },
  { action: "read", resourceKind: "agent_revision" },
];

export const administerGrants: Permission[] = [
  { action: "administer", resourceKind: "agent" },
  { action: "read", resourceKind: "agent" },
  { action: "read", resourceKind: "agent_revision" },
];
