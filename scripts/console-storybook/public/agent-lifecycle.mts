import type {
  AgentWire,
  AgentDeploymentStatusWire,
  OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";
import type { StoredConfiguration } from "./configuration-store.mts";
import { createAgentRoutes } from "./create-agent-routes.mts";
import { candidateDeploymentError, initialDeploymentProgress } from "./deployment-fixture.mts";
import { fixtureError as error, fixtureResponse as response } from "./preview-rules.mts";

// PATCH is deliberately schema-free in this preview. These fields are copied into
// responses, not certified as Controller records. Narrow only when consuming them.
type StoredAgent = {
  id: unknown;
  namespaceId: unknown;
  name: unknown;
  status: unknown;
  desiredRuntimeState: unknown;
  configurationId: unknown;
  createdAt: unknown;
  servicePrincipalId: unknown;
  activeRevisionId?: unknown;
  backendId?: unknown;
  executionMode?: unknown;
  gatewayManagedMode?: unknown;
  harnessAuth?: unknown;
  credentialSources?: unknown;
  plugins?: unknown;
  pluginApprovers?: unknown;
  repositoryAccess?: unknown;
  repositoryBindings?: unknown;
  configurationReadError?: unknown;
};
export type StoredDeployment = Omit<
  AgentDeploymentStatusWire,
  "agentId" | "error" | "status" | "cleanup"
> & {
  agentId: unknown;
  status: string;
  cleanup: { status: string; nextAttemptAt: string | null } | null;
  error: ReturnType<typeof candidateDeploymentError> | null;
  reads?: number | undefined;
  cleanupReads?: number;
};
// Snapshots retain unvalidated Agent settings, but their identity, Configuration and
// generated runtime metadata have concrete types. Unreadable historical snapshots
// are a separate stored variant, not a claim that all revisions omit these fields.
export type CreatedRevision = {
  id: string;
  namespaceId: string;
  agentId: unknown;
  revision: number;
  backendId: unknown;
  gatewayManagedMode: unknown;
  createdAt: string;
  configurationId: string;
  configurationKind: StoredConfiguration["kind"];
  configurationGeneration: number;
  configuration: StoredConfiguration["values"];
  secretBindings: StoredConfiguration["secretBindings"];
  harnessAuth: unknown;
  credentialSources: unknown;
  pluginApprovers?: unknown;
  plugins?: { driver: unknown; plugins: unknown };
  harness: { id: unknown; version: string; mode: unknown };
  compute: { id: string; implementation: string };
  sandboxDriverId?: string;
  servicePrincipalId: unknown;
  repositoryCredentials?: {
    driver: { id: string; implementation: string };
    deadlineWallMs: number;
    bindings: {
      backendId: string;
      grant: { providerInstanceId: string; repositoryId: string; grantId: string };
    }[];
  };
};
type UnreadableRevision = Pick<
  CreatedRevision,
  "id" | "namespaceId" | "agentId" | "revision" | "backendId" | "createdAt"
> & {
  configurationReadError: { code: "SAVED_CONFIGURATION_UNREADABLE"; field: string };
  configurationId?: never;
  configurationGeneration?: never;
  harness?: never;
};
type StoredRevision = CreatedRevision | UnreadableRevision;
type LifecycleScenario = Parameters<typeof createAgentRoutes>[0] & {
  candidateSuperseded?: boolean;
  candidateSelected?: boolean;
  agentId?: string;
  agentName?: string;
  deleting?: boolean;
  deletionStatus?: "queued" | "running" | "waiting" | "failed" | "deleted";
  stopped?: boolean;
  deployed?: boolean;
  candidateDeploymentStatus?: string;
  stopNoSelection?: boolean;
  firstDeploymentFailed?: boolean;
  firstDeploymentQueued?: boolean;
  credentialSources?: AgentWire["credentialSources"];
  agentPlugins?: AgentWire["plugins"];
  agentPluginApprovers?: AgentWire["pluginApprovers"];
  repositoryAccess?: AgentWire["repositoryAccess"];
  repositoryBindings?: AgentWire["repositoryBindings"];
  workspaceFiles?: Readonly<Record<string, string>>;
  pluginCapabilities?: { driver: unknown };
  policyState?: string;
  revisionHistory?: number;
  earlierFailedVersion?: number;
  earlierVersionError?: ReturnType<typeof candidateDeploymentError>;
  cleanupStatus?: string;
  deploymentLastAttempt?: NonNullable<AgentDeploymentStatusWire["progress"]>["lastAttempt"];
  candidateDeploymentWarnings?: AgentDeploymentStatusWire["warnings"];
  candidateActivates?: boolean;
  emptyAgents?: boolean;
  unreadableAgentConfiguration?: string;
  unreadableRevisionConfiguration?: string;
  transport?: boolean;
  stoppedOnListReread?: boolean;
  deletingOnListReread?: boolean;
  deletingOnRefresh?: boolean;
  stopElsewhereOnReread?: boolean;
  failedRedeployOnReread?: boolean;
  clearRevisionOnStopReadback?: boolean;
  latestDeploymentReadStatus?: number;
  latestDeploymentReadDelay?: number;
  revisionPageSize?: number;
  cleanupCompletes?: boolean;
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function");
}
function property(value: unknown, key: string): unknown {
  if (value === null || value === undefined) {
    throw new TypeError("Missing preview value");
  }
  const boxed: unknown = Object(value);
  return isRecord(boxed) ? boxed[key] : undefined;
}
function optionalProperty(value: unknown, key: string): unknown {
  return value === null || value === undefined ? undefined : property(value, key);
}
function repositoryBindings(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid preview repository bindings");
  }
  return value;
}
function spreadProperties(value: unknown): Record<string, unknown> {
  const boxed: unknown = Object(value);
  return isRecord(boxed) ? boxed : {};
}
function isCodexModel(value: unknown) {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== "string") {
    throw new TypeError("Preview primary model has no startsWith method");
  }
  return value.startsWith("codex/");
}
function setPrimaryModel(configuration: OpenClawConfigurationDocument, model: string) {
  const defaults = property(property(configuration, "agents"), "defaults");
  if (!isRecord(defaults)) {
    throw new TypeError("Missing preview model defaults");
  }
  defaults.model = model;
}
function lastPageRevision(page: StoredRevision[]) {
  const last = page.at(-1);
  if (!last) {
    throw new TypeError("Empty preview revision page");
  }
  return last.revision;
}

const currentRevisionId = "rev_00000000-0000-4000-8000-000000000006";
const candidateRevisionId = "rev_00000000-0000-4000-8000-000000000007";
const hiddenRevisionId = "rev_00000000-0000-4000-8000-000000000008";
// v8, deployed from elsewhere after the page loaded (failedRedeployOnReread).
const redeployRevisionId = "rev_00000000-0000-4000-8000-000000000018";

export function createAgentLifecycle(
  scenario: LifecycleScenario,
  dependencies: {
    namespaceId: string;
    createdAt: string;
    nextId: (prefix: string) => string;
    configs: Map<string, StoredConfiguration>;
    config: StoredConfiguration;
    selectedAuth: unknown;
    deploymentError: (checkedAt: string) => ReturnType<typeof candidateDeploymentError>;
    credentials: Map<string, { transportConfigured: boolean }>;
  },
) {
  const {
    namespaceId,
    createdAt,
    nextId,
    configs,
    config,
    selectedAuth,
    credentials,
    deploymentError,
  } = dependencies;
  const seedAgentId = scenario.agentId ?? "agt_00000000-0000-4000-8000-000000000001";
  const agents = new Map<string, StoredAgent>();
  const revisions = new Map<string, StoredRevision>();
  const deployments = new Map<string, StoredDeployment>();
  const files = new Map<string, unknown>();
  const stagedWorkspaceFiles = new Map<string, Record<string, string>>();
  const deleted = new Set<string>();
  const deletionReceipts = new Map<string, string>();
  const deletionReads = new Map<string, number>();
  const clearRevisionOnRead = new Set<string>();
  let runtimeStatusReads = 0;
  let runtimeLogReads = 0;
  let selectedRevisionId: string | null = null;
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
  let agentListReadCount = 0;
  const agent: StoredAgent = {
    id: scenario.agentId ?? "agt_00000000-0000-4000-8000-000000000001",
    namespaceId,
    name: scenario.agentName ?? "Research assistant",
    status: scenario.deleting ? "deleting" : "active",
    desiredRuntimeState: scenario.stopped ? "stopped" : scenario.deployed ? "running" : "stopped",
    configurationId: config.id,
    executionMode: "dedicated",
    gatewayManagedMode: true,
    harnessAuth: selectedAuth,
    credentialSources: structuredClone(
      scenario.credentialSources ??
        (optionalProperty(selectedAuth, "method") === "credential_source"
          ? [{ sourceId: property(selectedAuth, "sourceId") }]
          : []),
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

  agents.set(seedAgentId, agent);
  credentials.set(seedAgentId, { transportConfigured: scenario.transport !== false });
  function snapshot(owner: StoredAgent, id: string, revision: number): CreatedRevision {
    const configuration =
      typeof owner.configurationId === "string" ? configs.get(owner.configurationId) : undefined;
    if (!configuration) {
      throw new TypeError("Missing preview Configuration");
    }
    const defaults = optionalProperty(optionalProperty(configuration.values, "agents"), "defaults");
    const model = optionalProperty(defaults, "model");
    const primaryModel = typeof model === "string" ? model : optionalProperty(model, "primary");
    const runtime = optionalProperty(
      optionalProperty(optionalProperty(defaults, "models"), String(primaryModel)),
      "agentRuntime",
    );
    const harnessId =
      optionalProperty(runtime, "id") ?? (isCodexModel(primaryModel) ? "codex" : "openclaw");
    return {
      id,
      namespaceId,
      agentId: owner.id,
      revision,
      backendId: owner.backendId ?? null,
      gatewayManagedMode: owner.gatewayManagedMode,
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
              driver: structuredClone(property(scenario.pluginCapabilities, "driver")),
              plugins: structuredClone(owner.plugins),
            },
          }
        : {}),
      harness: { id: harnessId, version: "demo", mode: owner.executionMode },
      compute: { id: "kubernetes-demo", implementation: "kubernetes" },
      ...(scenario.policyState ? { sandboxDriverId: "sandbox-story" } : {}),
      servicePrincipalId: owner.servicePrincipalId,
      ...(optionalProperty(owner.repositoryBindings, "length")
        ? {
            repositoryCredentials: {
              driver: { id: "github-demo", implementation: "github" },
              deadlineWallMs: Date.parse(createdAt) + 3600000,
              bindings: repositoryBindings(owner.repositoryBindings).map((binding) => ({
                ...spreadProperties(binding),
                backendId: "github-demo",
                grant: {
                  providerInstanceId: "github-demo",
                  repositoryId: `demo-${property(binding, "repositoryRef")}`,
                  grantId: `demo-${property(binding, "repositoryRef")}-${property(binding, "profile")}`,
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
      setPrimaryModel(currentRevision.configuration, "codex/gpt-4.1");
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
        // An earlier version whose deployment failed, or that a newer one superseded
        // (earlierVersionError), before a later one succeeded.
        if (scenario.earlierFailedVersion === number) {
          deployments.set(older.id, {
            deploymentId: older.id,
            namespaceId,
            agentId: agent.id,
            status: "failed",
            cleanup: null,
            progress: null,
            error: scenario.earlierVersionError ?? deploymentError(older.createdAt),
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
      cleanup: null,
      progress: null,
      error: scenario.firstDeploymentFailed ? deploymentError(currentRevision.createdAt) : null,
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
            ? deploymentError(candidate.createdAt)
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
    delete agent.harnessAuth;
    delete agent.plugins;
    delete agent.pluginApprovers;
    delete agent.repositoryBindings;
    agent.configurationReadError = {
      code: "SAVED_CONFIGURATION_UNREADABLE",
      field: scenario.unreadableAgentConfiguration,
    };
  }
  if (scenario.unreadableRevisionConfiguration) {
    const saved = selectedRevisionId === null ? undefined : revisions.get(selectedRevisionId);
    if (!saved) {
      throw new TypeError("Missing preview revision");
    }
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

  const serveCreate = createAgentRoutes(scenario, {
    namespaceId,
    createdAt,
    nextId,
    configs,
    credentials,
    lifecycle: {
      saveAgent: (saved) => {
        agents.set(saved.id, saved);
      },
      snapshot,
      saveRevision: (revision) => {
        revisions.set(revision.id, revision);
      },
      deployments,
      files,
      stagedWorkspaceFiles,
    },
  });
  async function serve(
    resource: string,
    method: string,
    body: unknown,
    url: URL,
  ): Promise<Response | undefined> {
    if (resource === "agents") {
      if (method === "GET") {
        const reread = ++agentListReadCount > 1;
        // Another person's stop completes after the list's first read: no version is selected.
        if (scenario.stoppedOnListReread && reread) {
          for (const listed of agents.values()) {
            listed.desiredRuntimeState = "stopped";
            listed.activeRevisionId = null;
          }
        }
        // Another person's deletion of the first Agent started after the list's first read.
        if (scenario.deletingOnListReread && reread) {
          agent.status = "deleting";
        }
        return response([...agents.values()]);
      }
    }
    const createReply = serveCreate(resource, method, body);
    if (createReply !== undefined) {
      return createReply;
    }

    const agentMatch = resource.match(/^agents\/([^/]+)(.*)$/);
    if (!agentMatch) {
      return undefined;
    }
    const id = agentMatch[1] ?? "";
    const suffix = agentMatch[2] ?? "";
    if (suffix === "/deletion-status" && method === "GET") {
      const receiptId = url.searchParams.get("receiptId");
      if (
        (receiptId !== null && deletionReceipts.get(receiptId) !== id) ||
        (!deleted.has(id) && agents.get(id)?.status !== "deleting")
      ) {
        return error(404);
      }
      const reads = deletionReads.get(id);
      let status = scenario.deletionStatus ?? "queued";
      if (deleted.has(id)) {
        status = "deleted";
      } else if (reads !== undefined) {
        status = (["queued", "running", "deleted"] as const)[Math.min(reads, 2)]!;
      }
      if (reads !== undefined) {
        deletionReads.set(id, reads + 1);
      }
      if (status === "deleted") {
        // Completion changes the same Agent inventory that Back to Agents reads.
        deleted.add(id);
        agents.delete(id);
        for (const [revisionId, revision] of revisions) {
          if (revision.agentId === id) {
            revisions.delete(revisionId);
            deployments.delete(revisionId);
          }
        }
        for (const key of files.keys()) {
          if (key.startsWith(`${id}/`)) {
            files.delete(key);
          }
        }
      }
      if (status === "deleted" && !receiptId) {
        return error(404);
      }
      return response({ agentId: id, namespaceId, status, ...(receiptId ? { receiptId } : {}) });
    }
    const saved = agents.get(id);
    if (!saved) {
      return error(404);
    }
    if (suffix === "") {
      if (method === "GET") {
        if (scenario.deletingOnRefresh && ++agentReadCount > 1) {
          saved.status = "deleting";
        }
        // Once the open Logs view has read output, another person stops the Agent and the
        // stop completes: no version is selected for service (stopElsewhereOnReread).
        if (scenario.stopElsewhereOnReread && runtimeLogReads > 0 && saved.activeRevisionId) {
          saved.desiredRuntimeState = "stopped";
          delete saved.activeRevisionId;
        }
        // By the open Logs view's second runtime status poll, another person has deployed v8,
        // whose startup model check timed out: the Agent runs again with no version selected.
        if (
          scenario.failedRedeployOnReread &&
          runtimeStatusReads > 1 &&
          !revisions.has(redeployRevisionId)
        ) {
          const redeploy = snapshot(saved, redeployRevisionId, 8);
          redeploy.createdAt = "2026-09-26T23:10:00.000Z";
          revisions.set(redeploy.id, redeploy);
          deployments.set(redeploy.id, {
            deploymentId: redeploy.id,
            namespaceId,
            agentId: saved.id,
            status: "failed",
            cleanup: null,
            progress: null,
            error: {
              code: "RUNTIME_MODEL_PROBE_TIMEOUT",
              message:
                "The startup model check got no reply from the provider in time. With OpenClaw this includes an unreachable provider (refused connection or unknown host). Check egress, proxy or a custom baseUrl and that the provider responds, then deploy a new version.",
            },
            warnings: [],
          });
          saved.desiredRuntimeState = "running";
          // The API omits the field when no version is selected.
          delete saved.activeRevisionId;
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
        const deletionReceiptId = nextId("aud");
        deletionReceipts.set(deletionReceiptId, id);
        deletionReads.set(id, 0);
        return response(saved, 202, undefined, { deletionReceiptId });
      }
    }
    if (suffix === "/stop" && method === "POST") {
      saved.desiredRuntimeState = "stopped";
      if (scenario.clearRevisionOnStopReadback) {
        clearRevisionOnRead.add(id);
      }
      return response(saved, 202);
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
        cleanup: null,
        progress: initialDeploymentProgress("queued", createdAt),
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
        { nextCursor: remaining.length > limit ? `v1.${lastPageRevision(page)}` : null },
      );
    }
    if (suffix.startsWith("/revisions/") && method === "GET") {
      const revision = revisions.get(suffix.split("/")[2] ?? "");
      if (!revision || revision.agentId !== id) {
        return error(404, "NOT_FOUND", "The requested platform resource was not found.");
      }
      return response(revision);
    }
    if (
      suffix.startsWith("/deployments/") &&
      !suffix.endsWith("/runtime") &&
      !suffix.endsWith("/runtime/logs") &&
      method === "GET"
    ) {
      const deployment = deployments.get(suffix.split("/")[2] ?? "");
      if (!deployment || deployment.agentId !== id) {
        return error(404, "NOT_FOUND", "The requested platform resource was not found.");
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
      const filename = decodeURIComponent(suffix.split("/").at(-1) ?? "undefined");
      const key = `${id}/${filename}`;
      if (method === "PUT") {
        files.set(key, property(body, "content"));
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

    return undefined;
  }
  return {
    serve,
    seedAgent: (): Readonly<StoredAgent> => ({ ...agent }),
    lookupAgent: (id: string): Readonly<{ activeRevisionId: unknown }> | undefined => {
      const saved = agents.get(id);
      return saved === undefined ? undefined : { activeRevisionId: saved.activeRevisionId };
    },
    hasAgentRevision: (agentId: string, revisionId: string) =>
      revisions.get(revisionId)?.agentId === agentId,
    recordRuntimeStatusRead: () => {
      runtimeStatusReads += 1;
    },
    recordRuntimeLogRead: () => {
      runtimeLogReads += 1;
    },
  };
}
