import type { AuditSink } from "@openclaw-enterprise/audit";
import type { AuditEvent, ResourceRef } from "@openclaw-enterprise/contracts";
import type { ResourceHandler, ResourceHandlers } from "./types.ts";

type HandlerInput = Parameters<ResourceHandler>[0];

function agentTarget({ namespaceId, params }: HandlerInput): ResourceRef {
  return { kind: "agent", id: params.agentId ?? namespaceId, namespaceId };
}

export function createDeviceAuthorizationHandlers(options: {
  readonly auditSink: AuditSink;
  readonly startEvent: (
    input: Pick<HandlerInput, "context" | "request">,
    resource: ResourceRef,
    details: { readonly phase: string; readonly sourceId: string },
  ) => AuditEvent;
}) {
  const start: ResourceHandler = async (input) => {
    const { controller, context, namespaceId, body, params, request, reply } = input;
    const data = await controller.startAgentDeviceAuthorization(
      context.actorId,
      namespaceId,
      body?.harnessId as string,
      params.agentId,
      (source, phase) =>
        options.startEvent(input, phase === "session_pending" ? agentTarget(input) : source.ref, {
          phase,
          sourceId: source.id,
        }),
    );
    reply.header("cache-control", "no-store").send({ data, meta: { requestId: request.id } });
  };

  const poll: ResourceHandler = async (input) => {
    const { controller, context, namespaceId, params, request, reply, mutationEvent } = input;
    const data = await controller.pollAgentDeviceAuthorization(
      context.actorId,
      namespaceId,
      params.sessionId as string,
      params.agentId,
    );
    // Clients poll on the provider interval; audit the transition, not every pending poll.
    if (data.status !== "pending") {
      await options.auditSink.append(mutationEvent(agentTarget(input)));
    }
    reply.header("cache-control", "no-store").send({ data, meta: { requestId: request.id } });
  };

  const cancel: ResourceHandler = async (input) => {
    const { controller, context, namespaceId, params, reply, mutationEvent } = input;
    await controller.cancelAgentDeviceAuthorization(
      context.actorId,
      namespaceId,
      params.sessionId as string,
      params.agentId,
    );
    await options.auditSink.append(mutationEvent(agentTarget(input)));
    reply.header("cache-control", "no-store").status(204).send();
  };

  return {
    startAgentDeviceAuthorization: start,
    startSavedAgentDeviceAuthorization: start,
    pollAgentDeviceAuthorization: poll,
    pollSavedAgentDeviceAuthorization: poll,
    cancelAgentDeviceAuthorization: cancel,
    cancelSavedAgentDeviceAuthorization: cancel,
  } satisfies ResourceHandlers;
}
