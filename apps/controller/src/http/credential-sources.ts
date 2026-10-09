import type {
  CredentialSourceMetadata,
  CredentialSourceStatus,
  CredentialWithdrawalStatus,
  SecretReference,
} from "@openclaw-enterprise/contracts";
import { removedAccessBindingDetails, type ResourceHandlers } from "./types.ts";

function clientCredentialSource(
  source: Readonly<CredentialSourceMetadata & { readonly status?: CredentialSourceStatus }>,
): Record<string, unknown> {
  return {
    id: source.id,
    namespaceId: source.namespaceId,
    name: source.name,
    type: source.type,
    config: source.config,
    secrets: source.secrets,
    state: source.state,
    ref: source.ref,
    ...(source.status === undefined ? {} : { status: source.status }),
  };
}

function clientCredentialWithdrawal(
  withdrawal: Readonly<CredentialWithdrawalStatus>,
): Record<string, unknown> {
  return {
    namespaceId: withdrawal.namespaceId,
    agentId: withdrawal.agentId,
    revisionId: withdrawal.revisionId,
    credentialSourceId: withdrawal.credentialSourceId,
    state: withdrawal.state,
    requestedBy: withdrawal.requestedBy,
    requestedAt: withdrawal.requestedAt,
    ...(withdrawal.completedAt === undefined ? {} : { completedAt: withdrawal.completedAt }),
    ...(withdrawal.lastReason === undefined ? {} : { reason: withdrawal.lastReason }),
    ...(withdrawal.lastAttemptAt === undefined ? {} : { lastAttemptAt: withdrawal.lastAttemptAt }),
    withdrawalInProgress: withdrawal.withdrawalInProgress,
  };
}

export const credentialSourceHandlers = {
  async createCredentialSource({
    controller,
    context,
    request,
    reply,
    body,
    namespaceId,
    mutationEvent,
  }) {
    // Registration spans a gateway write, so the core commits the audit with its final step.
    const created = await controller.createCredentialSource(
      context.actorId,
      {
        namespaceId,
        name: body?.name as string,
        type: body?.type as string,
        ...(body?.config === undefined ? {} : { config: body.config as Record<string, string> }),
        ...(body?.secrets === undefined
          ? {}
          : { secrets: body.secrets as Record<string, SecretReference> }),
      },
      (source) => mutationEvent({ kind: "credential_source", id: source.id, namespaceId }),
    );
    const source = clientCredentialSource(created);
    reply.status(201).send({ data: source, meta: { requestId: request.id } });
  },
  async listCredentialSources({ controller, context, request, reply, namespaceId }) {
    const sources = await controller.listCredentialSources(context.actorId, namespaceId);
    reply.send({ data: sources.map(clientCredentialSource), meta: { requestId: request.id } });
  },
  async getCredentialSource({ controller, context, request, reply, params, namespaceId }) {
    const source = await controller.readCredentialSource(
      context.actorId,
      namespaceId,
      params.credentialSourceId as string,
    );
    reply.send({ data: clientCredentialSource(source), meta: { requestId: request.id } });
  },
  async updateCredentialSource({
    controller,
    context,
    request,
    reply,
    body,
    params,
    namespaceId,
    mutationEvent,
  }) {
    const credentialSourceId = params.credentialSourceId as string;
    const source = await controller.transact(async (unit) => {
      const updated = await controller.updateCredentialSource(context.actorId, {
        namespaceId,
        credentialSourceId,
        ...(body?.secrets === undefined
          ? {}
          : { secrets: body.secrets as Record<string, SecretReference> }),
      });
      await unit.audit.append(
        mutationEvent({ kind: "credential_source", id: credentialSourceId, namespaceId }),
      );
      return clientCredentialSource(updated);
    });
    reply.send({ data: source, meta: { requestId: request.id } });
  },
  async rotateCredentialSource({
    controller,
    context,
    request,
    reply,
    params,
    namespaceId,
    mutationEvent,
  }) {
    const credentialSourceId = params.credentialSourceId as string;
    const source = await controller.transact(async (unit) => {
      const rotated = await controller.rotateCredentialSource(context.actorId, {
        namespaceId,
        credentialSourceId,
      });
      await unit.audit.append(
        mutationEvent({ kind: "credential_source", id: credentialSourceId, namespaceId }),
      );
      return clientCredentialSource(rotated);
    });
    reply.send({ data: source, meta: { requestId: request.id } });
  },
  async withdrawAgentCredentialSource({
    controller,
    context,
    request,
    reply,
    params,
    namespaceId,
    mutationEvent,
  }) {
    const agentId = params.agentId as string;
    const withdrawal = await controller.transact(async (unit) => {
      const recorded = await controller.withdrawAgentCredentialSource(context.actorId, {
        namespaceId,
        agentId,
        credentialSourceId: params.credentialSourceId as string,
      });
      await unit.audit.append(mutationEvent({ kind: "agent", id: agentId, namespaceId }));
      return clientCredentialWithdrawal(recorded);
    });
    reply.status(202).send({ data: withdrawal, meta: { requestId: request.id } });
  },
  async getAgentCredentialWithdrawal({ controller, context, request, reply, params, namespaceId }) {
    const withdrawal = await controller.readAgentCredentialWithdrawal(context.actorId, {
      namespaceId,
      agentId: params.agentId as string,
      credentialSourceId: params.credentialSourceId as string,
    });
    reply.send({ data: clientCredentialWithdrawal(withdrawal), meta: { requestId: request.id } });
  },
  async deleteCredentialSource({ controller, context, reply, params, namespaceId, mutationEvent }) {
    // Deletion commits in two steps around the gateway call; the audit commits with the removal.
    const credentialSourceId = params.credentialSourceId as string;
    await controller.deleteCredentialSource(
      context.actorId,
      namespaceId,
      credentialSourceId,
      (removed) =>
        mutationEvent(
          { kind: "credential_source", id: credentialSourceId, namespaceId },
          removedAccessBindingDetails(removed),
        ),
    );
    reply.status(204).send();
  },
} satisfies ResourceHandlers;
