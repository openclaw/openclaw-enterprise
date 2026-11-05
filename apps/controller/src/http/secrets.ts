import type { SecretDetail, SecretMetadata } from "@openclaw-enterprise/contracts";
import {
  MUTATION_BACKEND_BUDGET_MS,
  withMutationDeadline,
} from "../admission/mutation-deadline.ts";
import { removedAccessBindingDetails, type ResourceHandlers } from "./types.ts";

// Writes bound their Kubernetes calls like Configuration writes (configurations.ts, finding 3106).

function clientSecret(secret: Readonly<SecretMetadata>): Record<string, unknown> {
  return {
    id: secret.id,
    namespaceId: secret.namespaceId,
    name: secret.name,
    ref: secret.ref,
  };
}

function clientSecretDetail(secret: Readonly<SecretDetail>): Record<string, unknown> {
  const { consumers } = secret;
  return {
    ...clientSecret(secret),
    consumers: {
      agents: consumers.agents,
      configurations: consumers.configurations,
      credentialSources: consumers.credentialSources,
      provisioningRequests: consumers.provisioningRequests,
      unreadable: consumers.unreadable,
      truncated: consumers.truncated,
    },
  };
}

export const secretHandlers = {
  async createSecret({ controller, context, request, reply, body, namespaceId, mutationEvent }) {
    const deadline = Date.now() + MUTATION_BACKEND_BUDGET_MS;
    const secret = await controller.transact(async (unit) => {
      const created = await withMutationDeadline(deadline, () =>
        controller.createSecret(context.actorId, {
          namespaceId,
          name: body?.name as string,
          value: body?.value as string,
        }),
      );
      await unit.audit.append(mutationEvent({ kind: "secret", id: created.id, namespaceId }));
      return clientSecret(created);
    });
    reply.status(201).send({ data: secret, meta: { requestId: request.id } });
  },
  async listSecrets({ controller, context, request, reply, namespaceId }) {
    const secrets = await controller.listSecrets(context.actorId, namespaceId);
    reply.send({ data: secrets.map(clientSecret), meta: { requestId: request.id } });
  },
  async getSecret({ controller, context, request, reply, params, namespaceId, callerMay }) {
    const secret = await controller.readSecret(
      context.actorId,
      namespaceId,
      params.secretId as string,
    );
    // The targets match operationTarget() for updateSecret and deleteSecret, so the console can
    // disable Replace value and Delete Secret with their reason instead of a refusal after the
    // caller acts (finding D761). Advisory only: no allow or deny decision changes.
    const target = { kind: "secret", id: secret.id, namespaceId } as const;
    const [update, remove] = await Promise.all([
      callerMay("update", target),
      callerMay("delete", target),
    ]);
    reply.send({
      data: { ...clientSecretDetail(secret), callerPermissions: { update, delete: remove } },
      meta: { requestId: request.id },
    });
  },
  async updateSecret({
    controller,
    context,
    request,
    reply,
    params,
    body,
    namespaceId,
    mutationEvent,
  }) {
    const deadline = Date.now() + MUTATION_BACKEND_BUDGET_MS;
    const secret = await controller.transact(async (unit) => {
      const updated = await withMutationDeadline(deadline, () =>
        controller.updateSecret(context.actorId, {
          namespaceId,
          secretId: params.secretId as string,
          value: body?.value as string,
        }),
      );
      await unit.audit.append(mutationEvent({ kind: "secret", id: updated.id, namespaceId }));
      return clientSecret(updated);
    });
    reply.send({ data: secret, meta: { requestId: request.id } });
  },
  async deleteSecret({ controller, context, reply, params, namespaceId, mutationEvent }) {
    const deadline = Date.now() + MUTATION_BACKEND_BUDGET_MS;
    await controller.transact(async (unit) => {
      const removed = await withMutationDeadline(deadline, () =>
        controller.deleteSecret(context.actorId, namespaceId, params.secretId as string),
      );
      await unit.audit.append(
        mutationEvent(
          { kind: "secret", id: params.secretId as string, namespaceId },
          removedAccessBindingDetails(removed),
        ),
      );
    });
    reply.status(204).send();
  },
} satisfies ResourceHandlers;
