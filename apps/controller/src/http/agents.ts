import {
  WORKSPACE_DEFAULTS_ID,
  harnessAuthBindingFromSnapshot,
  normalizeInitialWorkspaceFiles,
  type AgentRead,
  type AgentRevisionRead,
  type AgentRuntimeCredentialsBody,
} from "@openclaw-enterprise/contracts";
import {
  accessBindingsRemovedWithAgent,
  deployerRevisionReadAuditDetails,
  NamespaceNotReadyError,
  RepositoryOptionsUnavailableError,
  restrictionsRemovedWithAgent,
  type AgentProvisioningProgress,
  type CreateAgentInput,
  type HarnessResolver,
  type ProvisionAgentInput,
  type UpdateAgentInput,
} from "@openclaw-enterprise/occ";
import type { FastifyRequest } from "fastify";
import { dependencyUnavailable, failure } from "./errors.ts";
import type { RequestContext, ResourceHandler, ResourceHandlers } from "./types.ts";

interface AgentHandlerOptions {
  readonly resolveHarness: HarnessResolver;
  readonly requireCredentialCsrf: (request: FastifyRequest) => void;
  readonly rejectDeployment: (request: FastifyRequest, context: RequestContext) => Promise<void>;
}

function clientAgent(agent: Readonly<AgentRead>): Record<string, unknown> {
  if ("configurationReadError" in agent) {
    return { ...agent };
  }
  return {
    id: agent.id,
    namespaceId: agent.namespaceId,
    name: agent.name,
    servicePrincipalId: agent.servicePrincipalId,
    configurationId: agent.configurationId,
    backendId: agent.backendId,
    executionMode: agent.executionMode,
    plugins: agent.plugins,
    pluginApprovers: agent.pluginApprovers,
    repositoryBindings: agent.repositoryBindings,
    repositoryAccess: agent.repositoryAccess,
    harnessAuth: agent.harnessAuth,
    ...(agent.credentialSources === undefined || agent.credentialSources.length === 0
      ? {}
      : { credentialSources: agent.credentialSources }),
    activeRevisionId: agent.activeRevisionId,
    desiredRuntimeState: agent.desiredRuntimeState,
    status: agent.status,
    createdAt: agent.createdAt,
  };
}

function agentProvisioningUrl(namespaceId: string, workId: string): string {
  return `/namespaces/${encodeURIComponent(namespaceId)}/agents/provision/${encodeURIComponent(workId)}`;
}

function clientAgentProvisioning(
  provisioning: Readonly<AgentProvisioningProgress>,
  namespaceId: string,
): Record<string, unknown> {
  return {
    workId: provisioning.workId,
    status: provisioning.status,
    phase: provisioning.phase,
    attemptCount: provisioning.attemptCount,
    updatedAt: provisioning.updatedAt,
    agentId: provisioning.agentId,
    configurationId: provisioning.configurationId,
    revisionId: provisioning.revisionId,
    url: provisioning.url ?? agentProvisioningUrl(namespaceId, provisioning.workId),
    error: provisioning.error,
  };
}

function clientRevision(revision: Readonly<AgentRevisionRead>): Record<string, unknown> {
  if ("configurationReadError" in revision) {
    return { ...revision };
  }
  return {
    id: revision.id,
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    revision: revision.revision,
    configurationId: revision.configurationId,
    configurationKind: revision.configurationKind,
    configurationGeneration: revision.configurationGeneration,
    backendId: revision.backendId,
    configuration: revision.configuration,
    harness: revision.harness,
    compute: revision.compute,
    secretDriverId: revision.secretDriverId,
    secretBindings: revision.secretBindings,
    plugins: revision.plugins,
    pluginApprovers: revision.pluginApprovers,
    ...(revision.repositoryCredentials === undefined
      ? {}
      : {
          repositoryCredentials: {
            driver: revision.repositoryCredentials.driver,
            deadlineWallMs: revision.repositoryCredentials.deadlineWallMs,
            bindings: revision.repositoryCredentials.bindings.map(({ repositoryRef, profile }) => ({
              repositoryRef,
              profile,
            })),
          },
        }),
    harnessAuth: harnessAuthBindingFromSnapshot(revision.harnessAuth),
    ...(revision.credentialSources === undefined
      ? {}
      : { credentialSources: revision.credentialSources.map(({ sourceId }) => ({ sourceId })) }),
    createdAt: revision.createdAt,
  };
}

async function listRepositoryOptions({
  controller,
  context,
  request,
  reply,
  params,
  namespaceId,
}: Parameters<ResourceHandler>[0]) {
  const query = request.query as { descriptionRefs?: string };
  const descriptionRefs = query.descriptionRefs?.split(",") ?? [];
  if (new Set(descriptionRefs).size !== descriptionRefs.length) {
    throw failure(400, "INVALID_REQUEST", "Repository description references must be unique.");
  }
  const result = await controller
    .listRepositoryOptions(
      context.actorId,
      namespaceId,
      context.operation.operationId === "listAgentRepositoryOptions" ? params.agentId : undefined,
      descriptionRefs,
    )
    .catch((error: unknown) => {
      if (error instanceof RepositoryOptionsUnavailableError) {
        throw failure(503, "REPOSITORY_OPTIONS_UNAVAILABLE", "Repository options are unavailable.");
      }
      throw error;
    });
  reply.send({
    data: result.options.map(({ repositoryRef, displayName, allowedProfiles, description }) => ({
      repositoryRef,
      displayName,
      allowedProfiles,
      ...(description === undefined ? {} : { description }),
    })),
    meta: { requestId: request.id, descriptionsPending: result.descriptionsPending },
  });
}

function validateWorkspaceSetup(
  input: Pick<CreateAgentInput, "initialWorkspaceFiles" | "workspaceDefaultsId">,
): void {
  try {
    normalizeInitialWorkspaceFiles(input.initialWorkspaceFiles);
  } catch {
    throw failure(
      400,
      "INVALID_REQUEST",
      "Initial workspace files must use the four allowed names and valid Unicode without NUL, within 16 KiB per file.",
    );
  }
  if (
    input.workspaceDefaultsId !== undefined &&
    input.workspaceDefaultsId !== WORKSPACE_DEFAULTS_ID
  ) {
    throw failure(
      409,
      "RESOURCE_CONFLICT",
      "Workspace defaults changed. Reload the create form before submitting.",
    );
  }
}

// Closed Fastify body schemas admit these input fields. Handlers supply route scope
// after spreading the body; omitted fields and explicit null stay distinct.
export function createAgentHandlers(options: AgentHandlerOptions) {
  return {
    listRepositoryOptions,
    listAgentRepositoryOptions: listRepositoryOptions,
    async provisionAgent({
      controller,
      context,
      request,
      reply,
      body,
      namespaceId,
      mutationEvent,
    }) {
      const input = body as Omit<ProvisionAgentInput, "namespaceId">;
      validateWorkspaceSetup(input);
      const provisioned = await controller.provisionAgent(
        context.actorId,
        { ...input, namespaceId },
        (provisioned) =>
          mutationEvent({
            kind: "agent",
            id: provisioned.provisioning.agentId ?? provisioned.provisioning.workId,
            namespaceId,
          }),
      );
      const result = {
        provisioning: clientAgentProvisioning(provisioned.provisioning, namespaceId),
      };
      reply.status(202).send({ data: result, meta: { requestId: request.id } });
    },
    async createAgent({ controller, context, request, reply, body, namespaceId, mutationEvent }) {
      const input = body as Omit<CreateAgentInput, "namespaceId">;
      validateWorkspaceSetup(input);
      const agent = await controller.transact(async (unit) => {
        const created = await controller.createAgent(context.actorId, { ...input, namespaceId });
        await unit.audit.append(mutationEvent({ kind: "agent", id: created.id, namespaceId }));
        return clientAgent(created);
      });
      reply.status(201).send({ data: agent, meta: { requestId: request.id } });
    },
    async listAgents({ controller, context, request, reply, namespaceId }) {
      const agents = await controller.listAgents(context.actorId, namespaceId);
      reply.send({ data: agents.map(clientAgent), meta: { requestId: request.id } });
    },
    async getAgentProvisioning({ controller, context, request, reply, params, namespaceId }) {
      const workId = params.workId;
      if (!workId) {
        throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
      }
      const provisioned = await controller.getAgentProvisioning(
        context.actorId,
        namespaceId,
        workId,
      );
      reply.send({
        data: clientAgentProvisioning(provisioned.provisioning, namespaceId),
        meta: { requestId: request.id },
      });
    },
    async retryAgentProvisioning({
      controller,
      context,
      request,
      reply,
      params,
      namespaceId,
      mutationEvent,
    }) {
      const workId = params.workId;
      if (!workId) {
        throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
      }
      const provisioning = await controller.transact(async (unit) => {
        const retried = await controller.retryAgentProvisioning(
          context.actorId,
          namespaceId,
          workId,
        );
        await unit.audit.append(
          mutationEvent({
            kind: "agent",
            id: retried.provisioning.agentId ?? retried.provisioning.workId,
            namespaceId,
          }),
        );
        return retried.provisioning;
      });
      reply.status(202).send({
        data: clientAgentProvisioning(provisioning, namespaceId),
        meta: { requestId: request.id },
      });
    },
    async getAgent({ controller, context, request, reply, params, namespaceId }) {
      const agentId = params.agentId!;
      reply.send({
        data: clientAgent(
          await controller.getAgentForBrowsing(context.actorId, namespaceId, agentId),
        ),
        meta: { requestId: request.id },
      });
    },
    async updateAgent({
      controller,
      context,
      request,
      reply,
      params,
      body,
      namespaceId,
      mutationEvent,
    }) {
      const agentId = params.agentId!;
      const agent = await controller.transact(async (unit) => {
        const updated = await controller.updateAgent(context.actorId, {
          ...(body as Omit<UpdateAgentInput, "namespaceId" | "agentId">),
          namespaceId,
          agentId,
        });
        await unit.audit.append(mutationEvent({ kind: "agent", id: updated.id, namespaceId }));
        return clientAgent(updated);
      });
      reply.send({ data: agent, meta: { requestId: request.id } });
    },
    async deleteAgent({ controller, context, request, reply, params, namespaceId, mutationEvent }) {
      const agentId = params.agentId!;
      const agent = await controller.transact(async (unit) => {
        const deleting = await controller.deleteAgent(context.actorId, namespaceId, agentId);
        // The deleting Agent refuses new bindings on itself, its AgentRevisions, and its
        // ServicePrincipal, so these are exactly the AccessBindings that completing the
        // deletion removes (unless deleted explicitly first).
        const pending = await accessBindingsRemovedWithAgent(unit, deleting);
        // The finalizer also deletes the Restrictions on the Agent and its AgentRevisions.
        const restrictions = await restrictionsRemovedWithAgent(unit, deleting);
        await unit.audit.append(
          mutationEvent(
            { kind: "agent", id: deleting.id, namespaceId },
            pending.length === 0 && restrictions.length === 0
              ? undefined
              : {
                  ...(pending.length === 0 ? {} : { accessBindingsRemovedOnCompletion: pending }),
                  ...(restrictions.length === 0
                    ? {}
                    : { restrictionsRemovedOnCompletion: restrictions }),
                },
          ),
        );
        return clientAgent(deleting);
      });
      reply.status(202).send({ data: agent, meta: { requestId: request.id } });
    },
    async getAgentRuntimeImages({ controller, context, request, reply, params, namespaceId }) {
      const agentId = params.agentId!;
      const images = await controller.getAgentRuntimeImages(context.actorId, namespaceId, agentId);
      reply.send({ data: images, meta: { requestId: request.id } });
    },
    async getAgentRuntimeCredentials({ controller, context, request, reply, params, namespaceId }) {
      const agentId = params.agentId!;
      const status = await controller.getAgentRuntimeCredentialStatus(
        context.actorId,
        namespaceId,
        agentId,
      );
      reply.send({ data: status, meta: { requestId: request.id } });
    },
    async provisionAgentRuntimeCredentials({
      controller,
      context,
      request,
      reply,
      params,
      body,
      namespaceId,
      mutationEvent,
    }) {
      const agentId = params.agentId!;
      options.requireCredentialCsrf(request);
      const status = await controller.transact(async (unit) => {
        const provisioned = await controller.provisionAgentRuntimeCredentials(
          context.actorId,
          namespaceId,
          agentId,
          body as AgentRuntimeCredentialsBody,
        );
        try {
          await unit.audit.append(mutationEvent({ kind: "agent", id: agentId, namespaceId }));
        } catch {
          throw dependencyUnavailable();
        }
        return provisioned;
      });
      reply.send({ data: status, meta: { requestId: request.id } });
    },
    async deployAgent({ controller, context, request, reply, params, namespaceId, mutationEvent }) {
      const agentId = params.agentId!;
      try {
        const admitted = await controller.deployAgentWithAuthorization(
          context.actorId,
          { namespaceId, agentId },
          options.resolveHarness,
          (admitted) =>
            mutationEvent(
              { kind: "agent_revision", id: admitted.revision.id, namespaceId },
              deployerRevisionReadAuditDetails(admitted),
              admitted.authorization,
            ),
        );
        const revision = clientRevision(admitted.revision);
        reply.status(202).send({ data: revision, meta: { requestId: request.id } });
      } catch (error) {
        if (error instanceof NamespaceNotReadyError) {
          await options.rejectDeployment(request, context);
        }
        throw error;
      }
    },
    async stopAgent({ controller, context, request, reply, params, namespaceId, mutationEvent }) {
      const agentId = params.agentId!;
      const stopped = await controller.transact(async (unit) => {
        const agent = await controller.stopAgent(context.actorId, namespaceId, agentId);
        try {
          await unit.audit.append(mutationEvent({ kind: "agent", id: agentId, namespaceId }));
        } catch {
          throw dependencyUnavailable();
        }
        return clientAgent(agent);
      });
      reply.status(202).send({ data: stopped, meta: { requestId: request.id } });
    },
    async listAgentRevisions({ controller, context, request, reply, params, namespaceId }) {
      const agentId = params.agentId!;
      const revisions = await controller.listRevisions(context.actorId, namespaceId, agentId);
      reply.send({
        data: revisions.map(clientRevision),
        meta: { requestId: request.id },
      });
    },
    async getAgentRevision({ controller, context, request, reply, params, namespaceId }) {
      const agentId = params.agentId!;
      const revision = await controller.getRevisionForBrowsing(
        context.actorId,
        namespaceId,
        agentId,
        params.revisionId as string,
      );
      reply.send({ data: clientRevision(revision), meta: { requestId: request.id } });
    },
    async getAgentDeployment({ controller, context, request, reply, params, namespaceId }) {
      const agentId = params.agentId!;
      const status = await controller.getDeploymentStatus(
        context.actorId,
        namespaceId,
        agentId,
        params.deploymentId as string,
      );
      reply.send({ data: status, meta: { requestId: request.id } });
    },
    async diagnoseAgentDeployment({ controller, context, request, reply, params, namespaceId }) {
      const agentId = params.agentId!;
      const diagnostics = await controller.diagnoseAgentDeployment(
        context.actorId,
        namespaceId,
        agentId,
        params.deploymentId as string,
      );
      reply.send({ data: diagnostics, meta: { requestId: request.id } });
    },
  } satisfies ResourceHandlers;
}
