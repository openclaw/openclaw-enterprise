import {
  isSourceProviderPresetId,
  SOURCE_PROVIDER_PRESET_CONFIG_KEY,
  type AuditEvent,
  type CredentialSourceMetadata,
  type CredentialSourceStatus,
  type CredentialWithdrawalStatus,
  type PushAgentCredentialsBody,
  type SourceProviderPresetId,
} from "@openclaw-enterprise/contracts";
import type { UpdateManagedCredentialSourceInput } from "@openclaw-enterprise/occ";
import { BUILTIN_CODEX_OAUTH_PRESET } from "../backends/token-service/codex-oauth-preset.ts";

import { failure } from "./errors.ts";
import { removedAccessBindingDetails, type ResourceHandlers } from "./types.ts";

function managedConfig(config: Readonly<Record<string, string>> | undefined): {
  readonly settings: Readonly<Record<string, string>>;
  readonly providerPreset?: SourceProviderPresetId;
} {
  const { [SOURCE_PROVIDER_PRESET_CONFIG_KEY]: preset, ...settings } = config ?? {};
  if (preset !== undefined && !isSourceProviderPresetId(preset)) {
    throw failure(400, "INVALID_REQUEST", "Choose an approved credential source provider preset.", [
      { path: `/config/${SOURCE_PROVIDER_PRESET_CONFIG_KEY}`, code: "INVALID_VALUE" },
    ]);
  }
  return { settings, ...(preset === undefined ? {} : { providerPreset: preset }) };
}

function phaseAudit(event: AuditEvent, phase: string | undefined): AuditEvent {
  return phase === undefined
    ? event
    : { ...event, action: `${event.action}.started`, details: { ...event.details, phase } };
}

function clientCredentialSource(
  source: Readonly<CredentialSourceMetadata & { readonly status?: CredentialSourceStatus }>,
): Record<string, unknown> {
  if (source.type === "oauth2-refresh-token" && source.consent.kind === "builtin_codex") {
    return { ...source, consent: { ...source.consent, ...BUILTIN_CODEX_OAUTH_PRESET } };
  }
  return { ...source };
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

const credentialPushFailures = {
  resolution_failed: {
    event: "credential.resolution_failed",
    code: "CREDENTIAL_RESOLUTION_FAILED",
  },
  delivery_failed: { event: "credential.delivery_failed", code: "CREDENTIAL_DELIVERY_FAILED" },
} as const;

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
    const { [SOURCE_PROVIDER_PRESET_CONFIG_KEY]: providerPreset, ...settings } =
      (body?.config as Record<string, string> | undefined) ?? {};
    const created = await controller.createManagedCredentialSource(
      context.actorId,
      namespaceId,
      {
        name: body!.name as string,
        lifecycleConfig: { type: "static", settings },
        secret: body!.secret as Record<string, string>,
        ...(providerPreset === undefined ? {} : { providerPreset }),
        ...(body!.connectionTemplateId === undefined
          ? {}
          : { connectionTemplateId: body!.connectionTemplateId as string }),
      },
      (resource, phase) => phaseAudit(mutationEvent(resource), phase),
    );
    const source = clientCredentialSource(created);
    reply.status(201).send({ data: source, meta: { requestId: request.id } });
  },
  async listCredentialSources({ controller, context, request, reply, namespaceId }) {
    const sources = await controller.listCredentialSources(context.actorId, namespaceId);
    reply.send({ data: sources.map(clientCredentialSource), meta: { requestId: request.id } });
  },
  async getCredentialSource({
    controller,
    context,
    request,
    reply,
    params,
    namespaceId,
    setAuditReadTarget,
  }) {
    const source = await controller.readCredentialSource(
      context.actorId,
      namespaceId,
      params.credentialSourceId as string,
    );
    setAuditReadTarget({
      kind: "credential_source",
      id: source.id,
      namespaceId: source.namespaceId,
    });
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
    const resource = { kind: "credential_source" as const, id: credentialSourceId, namespaceId };
    const identity = await controller.credentialSourceUpdateIdentity(
      context.actorId,
      namespaceId,
      credentialSourceId,
    );
    if (!identity.managed || identity.type !== "static") {
      throw failure(409, "RESOURCE_CONFLICT", "Only a static Source can be updated.");
    }
    if (identity.managed) {
      const config = body?.config as Record<string, string> | undefined;
      const secret = body?.secret as Record<string, string> | undefined;
      const parsed = managedConfig(config);
      const presetUpdate =
        config === undefined ? {} : { providerPreset: parsed.providerPreset ?? null };
      const lifecycleUpdate =
        config !== undefined && Object.keys(parsed.settings).length > 0
          ? { lifecycleConfig: { type: identity.type, settings: parsed.settings } }
          : {};
      let input: UpdateManagedCredentialSourceInput;
      if (secret !== undefined) {
        input = { secret, ...lifecycleUpdate, ...presetUpdate };
      } else if (lifecycleUpdate.lifecycleConfig !== undefined) {
        input = { lifecycleConfig: lifecycleUpdate.lifecycleConfig, ...presetUpdate };
      } else {
        input = { providerPreset: parsed.providerPreset ?? null };
      }
      const updated = await controller.updateManagedCredentialSource(
        context.actorId,
        { namespaceId, credentialSourceId },
        input,
        (target, phase) => phaseAudit(mutationEvent(target), phase),
        (reasonCode) => mutationEvent(resource, undefined, undefined, { reasonCode }),
      );
      reply.send({ data: clientCredentialSource(updated), meta: { requestId: request.id } });
      return;
    }
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
    const resource = { kind: "credential_source" as const, id: credentialSourceId, namespaceId };
    const rotated = await controller.rotateCredentialSource(
      context.actorId,
      { namespaceId, credentialSourceId },
      (reasonCode) => mutationEvent(resource, undefined, undefined, { reasonCode }),
      mutationEvent(resource),
    );
    const source = clientCredentialSource(rotated);
    reply.send({ data: source, meta: { requestId: request.id } });
  },
  async pushAgentCredentials({
    controller,
    context,
    request,
    reply,
    params,
    body,
    namespaceId,
    mutationEvent,
  }) {
    const agentId = params.agentId as string;
    const agent = { kind: "agent" as const, id: agentId, namespaceId };
    const results = await controller.pushAgentCredentials(
      context.actorId,
      {
        namespaceId,
        agentId,
        sources: (body as PushAgentCredentialsBody).sources,
      },
      {
        started: () => phaseAudit(mutationEvent(agent), "delivery_retry_started"),
        empty: () => mutationEvent(agent),
        result: (result) => {
          const source = { kind: "credential_source" as const, id: result.sourceId, namespaceId };
          return result.outcome === "succeeded"
            ? mutationEvent(source, { agentId })
            : mutationEvent(source, { agentId }, undefined, {
                reasonCode: credentialPushFailures[result.outcome].code,
              });
        },
      },
    );
    for (const result of results) {
      if (result.outcome !== "succeeded") {
        request.log.warn({
          ...credentialPushFailures[result.outcome],
          requestId: request.id,
          namespaceId,
          credentialSourceId: result.sourceId,
        });
      }
    }
    reply.send({ data: { results }, meta: { requestId: request.id } });
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
    // Managed removal and completion audit commit independently.
    const credentialSourceId = params.credentialSourceId as string;
    await controller.deleteCredentialSource(
      context.actorId,
      namespaceId,
      credentialSourceId,
      (removed, phase) =>
        phaseAudit(
          mutationEvent(
            { kind: "credential_source", id: credentialSourceId, namespaceId },
            removedAccessBindingDetails(removed),
          ),
          phase,
        ),
    );
    reply.status(204).send();
  },
} satisfies ResourceHandlers;
