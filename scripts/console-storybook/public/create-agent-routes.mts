import type {
  AgentDeploymentStatusWire,
  AgentProvisioningStatusWire,
  AgentWire,
  AgentRevisionWire,
} from "@openclaw-enterprise/contracts";
import { configurationInput } from "./configuration-store.mts";
import type { StoredConfiguration } from "./configuration-store.mts";
import { deploymentFailureMessages, initialDeploymentProgress } from "./deployment-fixture.mts";
import { fixtureError as error, fixtureResponse as response } from "./preview-rules.mts";

// Only the creation lifecycle is owned here. The responder still owns Agent settings,
// revision snapshots and subsequent Agent routes; pass-through settings remain uninspected.
export type CreatedAgent = Pick<
  AgentWire,
  | "id"
  | "namespaceId"
  | "name"
  | "configurationId"
  | "status"
  | "desiredRuntimeState"
  | "createdAt"
  | "servicePrincipalId"
> & { activeRevisionId: string | null };

type Deployment = AgentDeploymentStatusWire & { reads?: number | undefined; cleanupReads?: number };
type ProvisioningJob = Pick<AgentProvisioningStatusWire, "workId" | "status" | "url"> & {
  requestId: string;
  reads: number;
  agentId: string;
  configurationId: string;
  revisionId: string | undefined;
};

type CreateScenario = {
  provisioningCancelledByStop?: boolean;
  provisionedDeploymentStopped?: boolean;
  provisionedDeploymentStatus?: AgentDeploymentStatusWire["status"];
  provisionedDeploymentAttempt?: Omit<
    NonNullable<NonNullable<AgentDeploymentStatusWire["progress"]>["lastAttempt"]>,
    "at"
  >;
  provisionedDeploymentError?: AgentDeploymentStatusWire["error"];
  provisioningStatus?: AgentProvisioningStatusWire["status"];
  malformedProvisioningReply?: "revision-id" | "error-message";
  provisioningNamesDeploymentWait?: boolean;
};

type CreateDependencies = {
  namespaceId: string;
  createdAt: string;
  nextId: (prefix: string) => string;
  configs: Map<string, StoredConfiguration>;
  saveAgent: (agent: CreatedAgent) => void;
  // Snapshot construction stays with the remaining Agent/revision simulation.
  snapshot: (
    agent: CreatedAgent,
    revisionId: string,
    revision: number,
  ) => Pick<AgentRevisionWire, "id">;
  saveRevision: (revision: Pick<AgentRevisionWire, "id">) => void;
  deployments: Map<string, Deployment>;
  credentials: Map<string, { transportConfigured: boolean }>;
  files: Map<string, string>;
  stagedWorkspaceFiles: Map<string, Record<string, string>>;
};

function isWorkspaceFiles(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((content: unknown) => typeof content === "string")
  );
}

// Unknown optional fields are transport input, not claims about the Agent model.
function isCreateInput(value: unknown): value is {
  name: string;
  initialWorkspaceFiles?: unknown;
  workspaceDefaultsId?: unknown;
} {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "name" in value &&
    typeof value.name === "string"
  );
}

function createInput(body: unknown) {
  if (!isCreateInput(body)) {
    return "The preview requires an object with a string Agent name.";
  }
  const {
    initialWorkspaceFiles = {},
    workspaceDefaultsId: _workspaceDefaultsId,
    ...agentBody
  } = body;
  if (!isWorkspaceFiles(initialWorkspaceFiles)) {
    return "The preview requires string workspace file contents keyed by filename.";
  }
  return { agentBody, initialWorkspaceFiles };
}

function credentialSourceProjection(body: object) {
  if (
    !("harnessAuth" in body) ||
    body.harnessAuth === null ||
    typeof body.harnessAuth !== "object"
  ) {
    return {};
  }
  const auth = body.harnessAuth;
  if (!("method" in auth) || auth.method !== "credential_source") {
    return {};
  }
  if (!("sourceId" in auth) || typeof auth.sourceId !== "string") {
    return undefined;
  }
  return { credentialSources: [{ sourceId: auth.sourceId }] };
}

export function createAgentRoutes(scenario: CreateScenario, dependencies: CreateDependencies) {
  const {
    namespaceId,
    createdAt,
    nextId,
    configs,
    saveAgent,
    snapshot,
    saveRevision,
    deployments,
    credentials,
    files,
    stagedWorkspaceFiles,
  } = dependencies;
  const provisioning = new Map<string, ProvisioningJob>();
  return function serve(resource: string, method: string, body: unknown): Response | undefined {
    if (resource === "agents" && method === "POST") {
      const input = createInput(body);
      if (typeof input === "string") {
        return error(400, "INVALID_REQUEST", input);
      }
      const { agentBody, initialWorkspaceFiles } = input;
      if (!("configurationId" in agentBody) || typeof agentBody.configurationId !== "string") {
        return error(
          400,
          "INVALID_REQUEST",
          "The preview requires a string Agent Configuration ID.",
        );
      }
      const saved: CreatedAgent = {
        ...agentBody,
        configurationId: agentBody.configurationId,
        id: nextId("agt"),
        namespaceId,
        status: "active",
        desiredRuntimeState: "stopped",
        createdAt,
        activeRevisionId: null,
        servicePrincipalId: "identity_demo_created",
      };
      saveAgent(saved);
      stagedWorkspaceFiles.set(saved.id, initialWorkspaceFiles);
      credentials.set(saved.id, { transportConfigured: false });
      return response(saved, 201);
    }
    // Create Agent's preflight accepts unless a scenario rule refuses it.
    if (resource === "agents/validate" && method === "POST") {
      return new Response(null, { status: 204 });
    }
    if (resource === "agents/provision" && method === "POST") {
      const parsed = createInput(body);
      if (typeof parsed === "string") {
        return error(400, "INVALID_REQUEST", parsed);
      }
      const { agentBody: input, initialWorkspaceFiles } = parsed;
      if (
        !("configuration" in input) ||
        !("requestId" in input) ||
        typeof input.requestId !== "string"
      ) {
        return error(
          400,
          "INVALID_REQUEST",
          "The preview requires a Configuration and string request ID.",
        );
      }
      const { configuration: rawConfiguration, requestId, ...agentBody } = input;
      const configuration = configurationInput(rawConfiguration);
      if (configuration === undefined) {
        return error(
          400,
          "INVALID_REQUEST",
          "The preview requires agent kind, JSON values and optional object bindings.",
        );
      }
      const credentialProjection = credentialSourceProjection(agentBody);
      if (credentialProjection === undefined) {
        return error(
          400,
          "INVALID_REQUEST",
          "The preview requires a string sourceId for credential_source auth.",
        );
      }
      const workId = nextId("work");
      const savedConfig = {
        ...configuration,
        id: nextId("cfg"),
        namespaceId,
        generation: configuration?.secretBindings ? 2 : 1,
        createdAt,
      };
      configs.set(savedConfig.id, savedConfig);
      const saved: CreatedAgent = {
        ...agentBody,
        id: nextId("agt"),
        namespaceId,
        configurationId: savedConfig.id,
        status: "active",
        desiredRuntimeState: "running",
        createdAt,
        activeRevisionId: null,
        servicePrincipalId: "identity_demo_provisioned",
        ...credentialProjection,
      };
      saveAgent(saved);
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
        saveRevision(revision);
        deployments.set(revision.id, {
          deploymentId: revision.id,
          namespaceId,
          agentId: saved.id,
          status: scenario.provisionedDeploymentStatus ?? "queued",
          cleanup: null,
          progress:
            scenario.provisionedDeploymentAttempt === undefined
              ? initialDeploymentProgress(
                  scenario.provisionedDeploymentStatus ?? "queued",
                  createdAt,
                )
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
                    message: deploymentFailureMessages.stopped,
                  }
                : (scenario.provisionedDeploymentError ?? {
                    code: "DEPENDENCY_UNAVAILABLE",
                    message: deploymentFailureMessages.dependencyUnavailable,
                  }),
          warnings: [],
        });
      }
      const job: ProvisioningJob = {
        requestId,
        workId,
        reads: 0,
        status: scenario.provisioningStatus ?? "queued",
        agentId: saved.id,
        configurationId: savedConfig.id,
        revisionId: revision?.id,
        url: `/namespaces/${namespaceId}/agents/provision/${workId}`,
      };
      provisioning.set(saved.id, job);
      provisioning.set(workId, job);
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
      const current = workId === undefined ? undefined : provisioning.get(workId);
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
                              ? deploymentFailureMessages.bootstrap
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
            // Corrupt only the outgoing terminal reply; stored deployment details stay valid.
            ...(current.status === "failed" && scenario.malformedProvisioningReply === "revision-id"
              ? { revisionId: 17 }
              : {}),
            ...(current.status === "failed" &&
            scenario.malformedProvisioningReply === "error-message"
              ? {
                  error: {
                    code: "HARNESS_CREDENTIAL_BOOTSTRAP_FAILED",
                    message: { detail: "Unreadable provisioning message" },
                  },
                }
              : {}),
            // After handoff the job names its first deployment's wait, as it does for a
            // reader of that deployment (#2744).
            ...(scenario.provisioningNamesDeploymentWait &&
            current.reads > 1 &&
            isWaiting(current.status)
              ? {
                  progress: {
                    phase: "deployment",
                    lastAttempt:
                      (current.revisionId === undefined
                        ? undefined
                        : deployments.get(current.revisionId)?.progress?.lastAttempt) ?? null,
                  },
                }
              : {}),
          },
        });
      }
    }
    return undefined;
  };
}

function isWaiting(status: AgentProvisioningStatusWire["status"]) {
  return status === "queued" || status === "running";
}
