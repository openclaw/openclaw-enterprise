import type { OccApiRoute } from "@openclaw-enterprise/contracts";
import type { FastifyRequest } from "fastify";

import {
  nativeAdminConfigurationSupported,
  nativeAdminTarget,
  normalizeNativeAdminDomain,
  type NativeAdminAccessConfig,
} from "../gateway/native-admin.ts";
import { dependencyUnavailable, failure } from "./errors.ts";
import type { ResourceHandler, ResourceHandlers } from "./types.ts";

export function isAgentAutomationOperation(operation: Pick<OccApiRoute, "action">): boolean {
  return operation.action.startsWith("openclaw.agents.automations.");
}

export function createAgentAutomationHandlers(options: {
  readonly installationId: string;
  readonly publicOrigin: string | undefined;
  readonly nativeAdmin: NativeAdminAccessConfig | undefined;
  readonly requireCsrf: (request: FastifyRequest, requireOrigin: boolean) => void;
}): ResourceHandlers {
  const admit: ResourceHandler = async ({
    controller,
    context,
    request,
    params,
    setAuditReadTarget,
  }) => {
    if (context.sessionId === undefined) {
      throw failure(403, "FORBIDDEN", "Agent automations require a human controller session.");
    }
    options.requireCsrf(request, request.method !== "GET" && request.method !== "HEAD");
    if (Object.keys(request.headers).some((name) => name.startsWith("x-openclaw-"))) {
      throw failure(400, "INVALID_REQUEST", "Native routing and authority headers are reserved.");
    }
    const namespaceId = params.namespaceId!;
    const agentId = params.agentId!;
    // Creation requires operate before lookup. Administration only admits management of
    // existing jobs; no browser credential or admin delegation is selected by either query.
    const agent =
      context.operation.operationId === "createAgentAutomation"
        ? await controller.getOperableAgent(context.actorId, namespaceId, agentId)
        : (await controller.getAgentBrowserAccess(context.actorId, namespaceId, agentId)).agent;
    setAuditReadTarget({ kind: "agent", namespaceId: agent.namespaceId, id: agent.id });
    if (
      options.nativeAdmin?.enabled !== true ||
      agent.status !== "active" ||
      agent.desiredRuntimeState !== "running" ||
      !agent.activeRevisionId
    ) {
      throw dependencyUnavailable();
    }
    const selection = await controller.getBrowserAccessibleActiveAgentRevision(
      context.actorId,
      namespaceId,
      agentId,
    );
    const { revision, successor } = selection;
    const compute = controller.selectedDriver("compute");
    if (
      selection.agent.status !== "active" ||
      selection.agent.desiredRuntimeState !== "running" ||
      revision.id !== agent.activeRevisionId ||
      compute.id !== revision.compute.id ||
      compute.implementation !== revision.compute.implementation ||
      selection.predecessorPhase === "stopping" ||
      (selection.predecessorPhase === undefined &&
        successor !== undefined &&
        compute.requiresStoppedPredecessors?.(successor) === true)
    ) {
      throw dependencyUnavailable();
    }
    const domain = normalizeNativeAdminDomain(options.nativeAdmin.domain);
    if (options.publicOrigin === undefined || domain === undefined) {
      throw dependencyUnavailable();
    }
    const target = nativeAdminTarget({
      publicOrigin: options.publicOrigin,
      installationId: options.installationId,
      agent: selection.agent,
      revision,
      domain,
    });
    if (!nativeAdminConfigurationSupported(revision, target.origin)) {
      throw dependencyUnavailable();
    }
    // TODO(RFC-20261121-agent-automations): dispatch only after upstream supplies a qualified
    // six-method delegation with authenticated creator/Agent authority and retained history.
    // A transport, public cron.get response, or broad operator scope cannot establish it.
    // Until then even a third-party Driver returning a transport cannot enable scheduling.
    throw failure(
      503,
      "AUTOMATIONS_UNQUALIFIED",
      "The runtime automation authority and retained-history contract is not qualified.",
    );
  };
  return {
    createAgentAutomation: admit,
    listAgentAutomations: admit,
    getAgentAutomation: admit,
    updateAgentAutomation: admit,
    deleteAgentAutomation: admit,
    listAgentAutomationRuns: admit,
  };
}
