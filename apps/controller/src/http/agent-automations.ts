import { createHash } from "node:crypto";
import { match } from "ts-pattern";
import type {
  AgentAutomationCreateInput,
  AgentAutomationOwnership,
  AgentAutomationUpdateInput,
  OccApiRoute,
} from "@openclaw-enterprise/contracts";
import type { AuditEventFactory, AuditSink } from "@openclaw-enterprise/audit";
import type { FastifyRequest } from "fastify";

import {
  nativeAdminConfigurationSupported,
  nativeAdminTarget,
  normalizeNativeAdminDomain,
  type NativeAdminAccessConfig,
} from "../gateway/native-admin.ts";
import {
  AutomationGatewayError,
  AutomationCreateNotCommittedError,
  type AgentAutomationsAccess,
  type BoundAutomation,
  type AgentAutomationGatewaySession,
} from "../gateway/agent-automations-client.ts";
import { dependencyUnavailable, failure } from "./errors.ts";
import type { RequestContext, ResourceHandler, ResourceHandlers } from "./types.ts";

type AutomationOperation = Extract<
  OccApiRoute,
  {
    operationId:
      | "createAgentAutomation"
      | "listAgentAutomations"
      | "getAgentAutomation"
      | "updateAgentAutomation"
      | "deleteAgentAutomation"
      | "listAgentAutomationRuns";
  }
>;
export function isAgentAutomationOperation(
  operation: OccApiRoute,
): operation is AutomationOperation {
  return operation.action.startsWith("openclaw.agents.automations.");
}

export function createAgentAutomationHandlers(options: {
  readonly installationId: string;
  readonly publicOrigin: string | undefined;
  readonly nativeAdmin: NativeAdminAccessConfig | undefined;
  readonly access: AgentAutomationsAccess | undefined;
  readonly factory: AuditEventFactory;
  readonly auditSink: AuditSink;
  readonly requireCsrf: (request: FastifyRequest, requireOrigin: boolean) => void;
  readonly reauthenticate: (request: FastifyRequest, context: RequestContext) => Promise<void>;
  readonly logAuditFailure: (request: FastifyRequest, error: unknown) => void;
}): ResourceHandlers {
  const handle: ResourceHandler = async ({
    controller,
    context,
    request,
    reply,
    params,
    body,
    setAuditReadTarget,
  }) => {
    if (!isAgentAutomationOperation(context.operation)) {
      throw dependencyUnavailable();
    }
    const operation = context.operation.operationId;
    const create = operation === "createAgentAutomation";
    const mutate =
      create || operation === "updateAgentAutomation" || operation === "deleteAgentAutomation";
    if (context.sessionId === undefined) {
      throw failure(403, "FORBIDDEN", "Agent automations require a human controller session.");
    }
    options.requireCsrf(request, mutate);
    if (Object.keys(request.headers).some((name) => name.startsWith("x-openclaw-"))) {
      throw failure(400, "INVALID_REQUEST", "Native routing and authority headers are reserved.");
    }
    const namespaceId = params.namespaceId!;
    const agentId = params.agentId!;
    // Creation requires operate before lookup. Administration admits only management.
    const agent = create
      ? await controller.getOperableAgent(context.actorId, namespaceId, agentId)
      : (await controller.getAgentBrowserAccess(context.actorId, namespaceId, agentId)).agent;
    setAuditReadTarget({ kind: "agent", namespaceId: agent.namespaceId, id: agent.id });
    // Ownership precedes native availability and eligibility, including history and DELETE.
    let record: Readonly<AgentAutomationOwnership> | undefined;
    let ownershipAdminister: boolean | undefined;
    let owned: readonly Readonly<AgentAutomationOwnership>[] = [];
    if (operation === "listAgentAutomations") {
      owned = await controller.listAgentAutomationOwnership(context.actorId, namespaceId, agentId);
    } else if (!create) {
      const access = await controller.getAgentAutomationOwnership(
        context.actorId,
        namespaceId,
        agentId,
        params.automationId!,
      );
      record = access.record;
      ownershipAdminister = access.administer;
      if (record.retiredAt !== null && operation !== "listAgentAutomationRuns") {
        throw failure(404, "NOT_FOUND", "The automation was not found.");
      }
    }
    if (
      options.nativeAdmin?.enabled !== true ||
      agent.status !== "active" ||
      agent.desiredRuntimeState !== "running" ||
      !agent.activeRevisionId
    ) {
      throw dependencyUnavailable();
    }
    async function select() {
      const selection = await controller.getBrowserAccessibleActiveAgentRevision(
        context.actorId,
        namespaceId,
        agentId,
      );
      const compute = controller.selectedDriver("compute");
      const { revision, successor } = selection;
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
      return selection;
    }
    const selection = await select();
    const administer = selection.mode === "admin";
    if (ownershipAdminister !== undefined && ownershipAdminister !== administer) {
      throw dependencyUnavailable();
    }
    // The ownership read can finish under an earlier grant. Commit disclosure to
    // this final mode; assertCurrent fences subsequent mode changes around RPCs.
    if (!administer) {
      owned = owned.filter((entry) => entry.creatorPrincipalId === context.actorId);
    }
    const domain = normalizeNativeAdminDomain(options.nativeAdmin.domain);
    if (options.publicOrigin === undefined || domain === undefined) {
      throw dependencyUnavailable();
    }
    const target = nativeAdminTarget({
      publicOrigin: options.publicOrigin,
      installationId: options.installationId,
      agent: selection.agent,
      revision: selection.revision,
      domain,
    });
    if (!nativeAdminConfigurationSupported(selection.revision, target.origin)) {
      throw dependencyUnavailable();
    }
    if (!options.access) {
      throw failure(
        503,
        "AUTOMATIONS_UNQUALIFIED",
        "The controller has no qualified automation transport.",
      );
    }
    async function assertCurrent() {
      await options.reauthenticate(request, context);
      if (create) {
        await controller.getOperableAgent(context.actorId, namespaceId, agentId);
      } else if (record) {
        await controller.getAgentAutomationOwnership(
          context.actorId,
          namespaceId,
          agentId,
          record.id,
        );
      }
      if ((await select()).mode !== selection.mode) {
        throw dependencyUnavailable();
      }
    }
    function audit(
      outcome: "admitted" | "bound" | "retired" | "success" | "unknown" | "discarded",
      ownership = record,
      action: "operate" | "administer" = create || selection.mode !== "admin"
        ? "operate"
        : "administer",
    ) {
      return options.factory.create({
        installationId: options.installationId,
        namespaceId,
        kind: "mutation",
        source: "occ",
        actor: {
          principalId: context.actorId,
          kind: "principal",
          issuer: context.issuer,
          subject: context.subject,
        },
        resource: { kind: "agent", id: agentId, namespaceId },
        authorization: {
          principalId: context.actorId,
          action,
          resource: { kind: "agent", id: agentId, namespaceId },
        },
        action: `${context.operation.action}.${outcome}`,
        outcome: outcome === "unknown" || outcome === "discarded" ? "failure" : "success",
        requestId: request.id,
        admissionDecisionId: context.admissionDecisionId,
        details: {
          revisionId: selection.revision.id,
          operation,
          phase: outcome,
          ...(ownership
            ? {
                jobId: ownership.id,
                ...(ownership.nativeJobId === null ? {} : { nativeJobId: ownership.nativeJobId }),
              }
            : {}),
        },
      });
    }
    const location = (id: string) =>
      `/namespaces/${encodeURIComponent(namespaceId)}/agents/${encodeURIComponent(agentId)}/automations/${encodeURIComponent(id)}`;
    const abort = new AbortController();
    const deadline = new Date(Date.now() + 30_000);
    const disconnect = () => {
      if (!reply.raw.writableEnded) {
        abort.abort();
      }
    };
    request.raw.once("aborted", disconnect);
    reply.raw.once("close", disconnect);
    if (request.raw.aborted || reply.raw.destroyed) {
      abort.abort();
    }
    const query = request.query as Record<string, string | undefined>;
    const offset = Number(query.offset ?? "0");
    const limit = Number(query.limit ?? "50");
    let native: AgentAutomationGatewaySession | undefined;
    let committed = false;
    try {
      await assertCurrent();
      native = await options.access.open({
        revision: selection.revision,
        signal: abort.signal,
        deadline,
        assertCurrent,
      });
      const session = native;
      if (create) {
        const toolGrant = await session.captureToolGrant();
        record = await controller.reserveAgentAutomation(
          context.actorId,
          {
            namespaceId,
            agentId,
            revisionId: selection.revision.id,
            nativeAgentId: session.nativeAgentId,
            toolGrant,
          },
          (reserved) => audit("admitted", reserved),
        );
      } else if (mutate) {
        await options.auditSink.append(audit("admitted"));
      }
      async function bind(
        ownership: Readonly<AgentAutomationOwnership>,
        nativeJobId: string,
      ): Promise<Readonly<AgentAutomationOwnership> & BoundAutomation> {
        await assertCurrent();
        return controller.bindAgentAutomation(
          context.actorId,
          { namespaceId, agentId, id: ownership.id, nativeJobId, requireOperate: create },
          (bound, action) => audit("bound", bound, action),
        );
      }
      async function resolved(): Promise<BoundAutomation> {
        if (!record) {
          throw dependencyUnavailable();
        }
        const nativeJobId = await session.resolve(record);
        if (record.nativeJobId === null) {
          record = await bind(record, nativeJobId);
        }
        if (record.nativeJobId !== nativeJobId) {
          throw dependencyUnavailable();
        }
        return { ...record, nativeJobId };
      }
      const result = await match(operation)
        .with("createAgentAutomation", async () => {
          const input = body as unknown as AgentAutomationCreateInput;
          const created = await session.create(record!.id, input, record!.toolGrant);
          committed = true;
          const bound = await bind(record!, created.nativeJobId);
          record = bound;
          // Native creation is disabled until the durable binding can authorize post-deletion history.
          return input.enabled
            ? session.update(bound, {
                enabled: true,
                expectedConfigRevision: created.job.configRevision,
              })
            : created.job;
        })
        .with("getAgentAutomation", async () => session.get(await resolved()))
        .with("updateAgentAutomation", async () =>
          session.update(await resolved(), body as unknown as AgentAutomationUpdateInput),
        )
        .with("deleteAgentAutomation", async () => {
          await session.remove(await resolved(), query.expectedConfigRevision!, administer);
          committed = true;
          record = await controller.retireAgentAutomation(
            context.actorId,
            { namespaceId, agentId, id: record!.id },
            (retired, action) => audit("retired", retired, action),
          );
        })
        .with("listAgentAutomationRuns", async () => session.runs(await resolved(), offset, limit))
        .with("listAgentAutomations", async () => {
          const inventory = await session.list(owned);
          const byId = new Map(owned.map((entry) => [entry.id, entry]));
          for (const entry of inventory.entries) {
            const ownership = byId.get(entry.id)!;
            if (ownership.nativeJobId === null) {
              await bind(ownership, entry.nativeJobId);
            } else if (ownership.nativeJobId !== entry.nativeJobId) {
              throw dependencyUnavailable();
            }
          }
          const jobs = inventory.entries
            .map((entry) => entry.summary)
            .sort((a, b) => a.id.localeCompare(b.id));
          const total = jobs.length;
          const snapshotRevision = createHash("sha256").update(JSON.stringify(jobs)).digest("hex");
          const page = jobs.slice(offset, offset + limit);
          return {
            jobs: page,
            total,
            nextOffset: offset + page.length < total ? offset + page.length : null,
            snapshotRevision,
          };
        })
        .exhaustive();
      committed = mutate;
      await assertCurrent();
      if (mutate) {
        await options.auditSink.append(audit("success"));
      }
      if (operation === "deleteAgentAutomation") {
        reply.code(204).send();
      } else {
        if (create && record) {
          reply.header("location", location(record.id));
        }
        reply.code(create ? 201 : 200).send({ data: result, meta: { requestId: request.id } });
      }
    } catch (caught) {
      let error = caught;
      if (create && !committed && record && error instanceof AutomationCreateNotCommittedError) {
        try {
          await controller.discardUnboundAgentAutomation(
            context.actorId,
            { namespaceId, agentId, id: record.id },
            (discarded) => audit("discarded", discarded),
          );
        } catch (cleanupError) {
          options.logAuditFailure(request, cleanupError);
          throw dependencyUnavailable();
        }
        error = error.cause;
      }
      if (committed || (error instanceof AutomationGatewayError && error.code === "unknown")) {
        if (record) {
          reply.header("location", location(record.id));
        }
        try {
          await options.auditSink.append(audit("unknown"));
        } catch (auditError) {
          options.logAuditFailure(request, auditError);
        }
        throw failure(
          503,
          "UNKNOWN_OUTCOME",
          "The automation mutation outcome is unknown. Refresh the automation inventory before deciding whether to retry.",
        );
      }
      if (
        operation === "deleteAgentAutomation" &&
        record?.nativeJobId &&
        error instanceof AutomationGatewayError &&
        error.code === "missing"
      ) {
        // Native one-shot deletion can precede an OCC delete. Retire the grant
        // after definite absence so retained history cannot block deployment.
        await controller.retireAgentAutomation(
          context.actorId,
          { namespaceId, agentId, id: record.id },
          (retired, action) => audit("retired", retired, action),
        );
      }
      if (error instanceof AutomationGatewayError) {
        throw match(error.code)
          .with("missing", () => failure(404, "NOT_FOUND", "The automation was not found."))
          .with("invalid", () =>
            failure(400, "INVALID_REQUEST", "The native scheduler refused the automation request."),
          )
          .with("conflict", () =>
            failure(
              409,
              "RESOURCE_CONFLICT",
              "The automation or inventory changed. Refresh before retrying.",
            ),
          )
          .with("unsupported", () =>
            failure(409, "RESOURCE_CONFLICT", "The automation has an unsupported configuration."),
          )
          .with("unavailable", () => dependencyUnavailable())
          .with("unknown", () =>
            failure(503, "UNKNOWN_OUTCOME", "The automation mutation outcome is unknown."),
          )
          .exhaustive();
      }
      throw error;
    } finally {
      request.raw.removeListener("aborted", disconnect);
      reply.raw.removeListener("close", disconnect);
      await native?.close();
    }
  };
  return {
    createAgentAutomation: handle,
    listAgentAutomations: handle,
    getAgentAutomation: handle,
    updateAgentAutomation: handle,
    deleteAgentAutomation: handle,
    listAgentAutomationRuns: handle,
  };
}
