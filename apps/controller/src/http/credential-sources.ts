import type {
  CredentialSourceMetadata,
  CredentialSourceStatus,
  SecretReference,
} from "@openclaw-enterprise/contracts";
import type { ResourceHandlers } from "./types.ts";

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
  async deleteCredentialSource({ controller, context, reply, params, namespaceId, mutationEvent }) {
    // Deletion commits in two steps around the gateway call; the audit commits with the removal.
    const credentialSourceId = params.credentialSourceId as string;
    await controller.deleteCredentialSource(context.actorId, namespaceId, credentialSourceId, () =>
      mutationEvent({ kind: "credential_source", id: credentialSourceId, namespaceId }),
    );
    reply.status(204).send();
  },
} satisfies ResourceHandlers;
