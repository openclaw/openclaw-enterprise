import { RuntimeLogLimiter } from "./runtime-logs.ts";
import type {
  SandboxNetworkGrant,
  SandboxPolicy,
  SandboxFacet,
} from "@openclaw-enterprise/contracts";
import type { ResourceHandlers } from "./types.ts";

const recommendationLimiter = new RuntimeLogLimiter();

function policyBody(policy: Readonly<SandboxPolicy>) {
  const application = policy.application;
  return {
    id: policy.id,
    namespaceId: policy.namespaceId,
    agentId: policy.agentId,
    version: policy.version,
    additions: policy.additions,
    ...(policy.applied === undefined ? {} : { applied: policy.applied }),
    ...(application === undefined
      ? {}
      : {
          application: {
            id: application.id,
            revisionId: application.revisionId,
            policyVersion: application.policyVersion,
            state: application.state,
            requestedBy: application.requestedBy,
            requestedAt: application.requestedAt,
            ...(application.providerVersion === undefined
              ? {}
              : { providerVersion: application.providerVersion }),
            ...(application.reason === undefined ? {} : { reason: application.reason }),
          },
        }),
  };
}

export const sandboxPolicyHandlers = {
  async discoverAgentConfigurations({ controller, context, namespaceId, params, reply, request }) {
    const configurations = await controller.discoverConfigurations(context.actorId, {
      scope: "agent",
      namespaceId,
      agentId: params.agentId!,
    });
    reply.send({ data: { configurations }, meta: { requestId: request.id } });
  },
  async validateAgentSandboxPolicy({
    controller,
    context,
    namespaceId,
    params,
    body,
    reply,
    request,
  }) {
    const result = await controller.validateAgentSandboxPolicy(
      context.actorId,
      namespaceId,
      params.agentId!,
      params.facet as SandboxFacet,
      body!.expectedVersion as number,
      body!.additions,
    );
    reply.send({ data: result, meta: { requestId: request.id } });
  },
  async getAgentSandboxPolicy({ controller, context, namespaceId, params, reply, request }) {
    const view = await controller.getAgentSandboxPolicy(
      context.actorId,
      namespaceId,
      params.agentId!,
      params.facet as SandboxFacet,
    );
    reply.send({
      data: { ...view, policy: policyBody(view.policy) },
      meta: { requestId: request.id },
    });
  },
  async TEMPORARY_API_WILL_BREAK_IN_FUTURE_setAgentSandboxPolicyEditing({
    controller,
    context,
    namespaceId,
    params,
    body,
    reply,
    request,
    mutationEvent,
  }) {
    const agent = await controller.transact(async (unit) => {
      const updated =
        await controller.TEMPORARY_API_WILL_BREAK_IN_FUTURE_setAgentSandboxPolicyEditing(
          context.actorId,
          namespaceId,
          params.agentId!,
          params.facet as SandboxFacet,
          body!.enabled as boolean,
        );
      await unit.audit.append(
        mutationEvent(
          { kind: "agent", id: updated.id, namespaceId },
          { sandboxPolicyEditing: updated.sandboxPolicyEditing },
        ),
      );
      return updated;
    });
    reply.send({ data: agent, meta: { requestId: request.id } });
  },
  async updateAgentSandboxPolicy({
    controller,
    context,
    namespaceId,
    params,
    body,
    reply,
    request,
    mutationEvent,
  }) {
    const policy = await controller.transact(async (unit) => {
      const updated = await controller.updateAgentSandboxPolicy(
        context.actorId,
        namespaceId,
        params.agentId!,
        params.facet as SandboxFacet,
        body!.expectedVersion as number,
        body!.additions as readonly SandboxNetworkGrant[],
      );
      await unit.audit.append(
        mutationEvent(
          { kind: "sandbox_policy", id: updated.id, namespaceId },
          {
            policyVersion: updated.version,
            agentId: updated.agentId,
            additions: updated.additions,
          },
        ),
      );
      return updated;
    });
    reply.send({ data: policyBody(policy), meta: { requestId: request.id } });
  },
  async applyAgentSandboxPolicy({
    controller,
    context,
    namespaceId,
    params,
    body,
    reply,
    request,
    mutationEvent,
  }) {
    const policy = await controller.transact(async (unit) => {
      const updated = await controller.applyAgentSandboxPolicy(
        context.actorId,
        namespaceId,
        params.agentId!,
        params.facet as SandboxFacet,
        body!.expectedVersion as number,
        body!.revisionId as string,
      );
      await unit.audit.append(
        mutationEvent(
          { kind: "sandbox_policy", id: updated.id, namespaceId },
          {
            policyVersion: updated.version,
            revisionId: updated.application!.revisionId,
            applicationId: updated.application!.id,
          },
        ),
      );
      return updated;
    });
    reply.status(202).send({ data: policyBody(policy), meta: { requestId: request.id } });
  },
  async getAgentSandboxRecommendations({
    controller,
    context,
    namespaceId,
    params,
    reply,
    request,
    mutationEvent,
  }) {
    const result = await controller.readAgentSandboxRecommendations(
      context.actorId,
      namespaceId,
      params.agentId!,
      params.facet as SandboxFacet,
      params.revisionId!,
      async (read) => {
        recommendationLimiter.admit(context.actorId, params.agentId!);
        return recommendationLimiter.run(async () => {
          await controller.transact(async (unit) => {
            await unit.audit.append({
              ...mutationEvent(
                { kind: "agent", id: params.agentId!, namespaceId },
                { revisionId: params.revisionId },
              ),
              kind: "access",
            });
          });
          return read();
        });
      },
    );
    reply.send({ data: result, meta: { requestId: request.id } });
  },
} satisfies ResourceHandlers;
