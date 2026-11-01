import type { OpenClawConfigurationDocument, SecretBindings } from "@openclaw-enterprise/contracts";
import {
  KUBERNETES_MUTATION_BUDGET_MS,
  withKubernetesMutationDeadline,
} from "../drivers/kubernetes/request.ts";
import { removedAccessBindingDetails, type ResourceHandlers } from "./types.ts";

// Each write's Kubernetes calls end within KUBERNETES_MUTATION_BUDGET_MS, so a slow cluster
// fails the request before an ingress gives up on it, never commits it after (finding 3106).
// Only the forward path runs under the deadline: the transaction's compensations run after it.

export const configurationHandlers = {
  async createConfiguration({
    controller,
    context,
    request,
    reply,
    body,
    namespaceId,
    mutationEvent,
  }) {
    const deadline = Date.now() + KUBERNETES_MUTATION_BUDGET_MS;
    const configuration = await controller.transact(async (unit) => {
      const created = await withKubernetesMutationDeadline(deadline, () =>
        controller.createConfiguration(context.actorId, {
          namespaceId,
          kind: body?.kind as "agent",
          values: body?.values as OpenClawConfigurationDocument,
          ...(body?.secretBindings === undefined
            ? {}
            : { secretBindings: body.secretBindings as SecretBindings }),
        }),
      );
      await unit.audit.append(
        mutationEvent({ kind: "configuration", id: created.id, namespaceId }),
      );
      return created;
    });
    reply.status(201).send({ data: configuration, meta: { requestId: request.id } });
  },
  async getConfiguration({ controller, context, request, reply, params, namespaceId }) {
    const configuration = await controller.getConfiguration(
      context.actorId,
      namespaceId,
      params.configurationId as string,
    );
    reply.send({ data: configuration, meta: { requestId: request.id } });
  },
  async updateConfiguration({
    controller,
    context,
    request,
    reply,
    params,
    body,
    namespaceId,
    mutationEvent,
  }) {
    const deadline = Date.now() + KUBERNETES_MUTATION_BUDGET_MS;
    const configuration = await controller.transact(async (unit) => {
      const updated = await withKubernetesMutationDeadline(deadline, () =>
        controller.updateConfiguration(context.actorId, {
          namespaceId,
          configurationId: params.configurationId as string,
          values: body?.values as OpenClawConfigurationDocument,
          ...(body?.secretBindings === undefined
            ? {}
            : { secretBindings: body.secretBindings as SecretBindings }),
          ...(body?.expectedGeneration === undefined
            ? {}
            : { expectedGeneration: body.expectedGeneration as number }),
        }),
      );
      await unit.audit.append(
        mutationEvent({ kind: "configuration", id: updated.id, namespaceId }),
      );
      return updated;
    });
    reply.send({ data: configuration, meta: { requestId: request.id } });
  },
  async deleteConfiguration({ controller, context, reply, params, namespaceId, mutationEvent }) {
    const deadline = Date.now() + KUBERNETES_MUTATION_BUDGET_MS;
    await controller.transact(async (unit) => {
      const removed = await withKubernetesMutationDeadline(deadline, () =>
        controller.deleteConfiguration(
          context.actorId,
          namespaceId,
          params.configurationId as string,
        ),
      );
      await unit.audit.append(
        mutationEvent(
          { kind: "configuration", id: params.configurationId as string, namespaceId },
          removedAccessBindingDetails(removed),
        ),
      );
    });
    reply.status(204).send();
  },
} satisfies ResourceHandlers;
