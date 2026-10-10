import type { AuditEventFactory, AuditSink } from "@openclaw-enterprise/audit";
import type {
  Agent,
  AgentRevision,
  AuthorizationEvidence,
  ComputeDriver,
  IAMDriver,
  OccApiRoute,
} from "@openclaw-enterprise/contracts";
import {
  NoActiveAgentRevisionError,
  ResourceConflictError,
  type AuthorizationDeniedError,
  type OpenClawController,
} from "@openclaw-enterprise/occ";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifySchema } from "fastify";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { AdmittedCaller } from "../admission/admission-verifier.ts";
import {
  hostnameMatchesSharedCookieDomain,
  normalizeSharedCookieDomain,
  type ControllerAuth,
} from "../auth/index.ts";
import {
  proxyNativeAdminWebSocket,
  proxyNativeAdminHttp as streamNativeAdminHttp,
  type NativeAdminProxyContext,
  type NativeAdminWebSocketCloseCause,
  type NativeAdminWebSocketCloseReason,
} from "../gateway/native-admin-proxy.ts";
import {
  deriveNativeAdminHost,
  nativeAdminConfigurationSupported,
  nativeAdminGatewayHttpBase,
  nativeAdminTarget,
  normalizeNativeAdminDomain,
  type NativeAdminAccessConfig,
  type NativeAdminTarget,
} from "../gateway/native-admin.ts";
import {
  canonicalFailure,
  dependencyUnavailable,
  failure,
  isAuthorizationDenied,
  isDependencyUnavailable,
  requestFailure,
} from "./errors.ts";
import type { RequestContext } from "./types.ts";

interface NativeAdminOptions {
  readonly app: FastifyInstance;
  readonly installationId: string;
  readonly publicOrigin: string | undefined;
  readonly factory: AuditEventFactory;
  readonly getController: () => OpenClawController | undefined;
  readonly selectedIAMDriver: () => IAMDriver;
  readonly getContext: (request: FastifyRequest) => RequestContext | undefined;
  readonly getAdmission: (request: FastifyRequest) => AdmittedCaller | undefined;
  readonly auth: ControllerAuth;
  readonly nativeAdmin: NativeAdminAccessConfig | undefined;
  readonly nativeAdminGatewayApiKey: (() => Promise<string>) | undefined;
  readonly webSocketLeaseIntervalMs: number | undefined;
  readonly auditSink: AuditSink;
}

interface NativeAdminProxyResolution {
  readonly parentSessionId: string;
  readonly actorId: string;
  readonly actorIssuer: string;
  readonly actorSubject: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly target: NativeAdminTarget;
  readonly gatewayBase: string;
}

interface NativeAdminProxyDenial {
  readonly denied: true;
  readonly reason: NativeAdminWebSocketCloseReason;
  readonly actorId?: string;
  readonly actorIssuer?: string;
  readonly actorSubject?: string;
  readonly namespaceId?: string;
  readonly agentId?: string;
  readonly revisionId?: string;
  readonly host?: string;
  readonly actualAuthorizationDenied?: true;
  readonly evidence?: AuthorizationEvidence;
  readonly authorization?: NonNullable<AuthorizationDeniedError["authorization"]>;
}

type NativeAdminProxyAdmission = NativeAdminProxyResolution | NativeAdminProxyDenial;
const NATIVE_ADMIN_PROXY_ADMISSION_TIMEOUT_MS = 5_000;
const NATIVE_ADMIN_WORK_DRAIN_MS = 5_000;
export const nativeAdminStatusOperation = {
  operationId: "getAgentNativeAdmin",
  method: "GET",
  path: "/namespaces/:namespaceId/agents/:agentId/native-admin",
  action: "openclaw.agents.native_admin.read",
  iamAction: "administer",
  resourceKind: "agent",
  authorizationTarget: "agent",
  summary: "Resolve native admin UI launch availability for one Agent",
  tags: ["Agents"],
  schema: {},
} as unknown as OccApiRoute;
const nativeAdminParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["namespaceId", "agentId"],
  properties: {
    namespaceId: { type: "string", minLength: 1, maxLength: 200 },
    agentId: { type: "string", minLength: 1, maxLength: 200 },
  },
};
const nativeAdminMetaSchema = {
  type: "object",
  additionalProperties: false,
  required: ["requestId"],
  properties: { requestId: { type: "string" } },
};
const nativeAdminErrorSchema = { $ref: "ErrorResponse#" };
const nativeAdminStatusDataSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: {
      type: "string",
      enum: ["available", "disabled", "stopped", "unavailable", "unsupported"],
    },
    host: { type: "string" },
    origin: { type: "string", format: "uri" },
    activeRevisionId: { type: "string" },
    url: { type: "string", format: "uri" },
  },
};
export const nativeAdminStatusSchema = {
  operationId: nativeAdminStatusOperation.operationId,
  summary: nativeAdminStatusOperation.summary,
  description:
    "Requires a human session with administer permission on the exact Agent. Service API keys cannot launch or inspect native admin UI access.",
  tags: [...nativeAdminStatusOperation.tags],
  security: [{ sessionCookie: [] }],
  "x-openclaw-permissions": [{ action: "administer", resourceKind: "agent", scope: "requested" }],
  params: nativeAdminParamsSchema,
  response: {
    200: {
      description: "OK",
      type: "object",
      additionalProperties: false,
      required: ["data", "meta"],
      properties: { data: nativeAdminStatusDataSchema, meta: nativeAdminMetaSchema },
    },
    401: { description: "Unauthorized", ...nativeAdminErrorSchema },
    403: { description: "Forbidden", ...nativeAdminErrorSchema },
    404: { description: "Not Found", ...nativeAdminErrorSchema },
    503: { description: "Service Unavailable", ...nativeAdminErrorSchema },
  },
} as FastifySchema;

/** Owns native-host admission, proxy sockets and their shutdown audits. */
export function createNativeAdminAccess(options: NativeAdminOptions) {
  const {
    app,
    installationId,
    publicOrigin,
    factory,
    getController,
    selectedIAMDriver,
    getContext,
    getAdmission,
  } = options;
  const nativeAdminDomain = normalizeNativeAdminDomain(options.nativeAdmin?.domain);
  if (options.nativeAdmin?.enabled === true) {
    if (publicOrigin === undefined) {
      throw new Error("Native admin UI access requires OCC public origin configuration.");
    }
    if (new URL(publicOrigin).protocol !== "https:") {
      throw new Error("Native admin UI access requires an HTTPS public origin.");
    }
    if (nativeAdminDomain === undefined) {
      throw new Error("Native admin UI access requires an Agent domain.");
    }
    const sharedCookieDomain = options.auth.sharedCookieDomain;
    if (
      sharedCookieDomain === undefined ||
      normalizeSharedCookieDomain(options.nativeAdmin.sharedCookieDomain) !== sharedCookieDomain ||
      !hostnameMatchesSharedCookieDomain(new URL(publicOrigin).hostname, sharedCookieDomain)
    ) {
      throw new Error("Native admin UI access requires a shared cookie domain containing OCC.");
    }
    if (!hostnameMatchesSharedCookieDomain(nativeAdminDomain, sharedCookieDomain)) {
      throw new Error(
        "Native admin UI access requires an Agent domain inside the shared cookie domain.",
      );
    }
    if (options.nativeAdminGatewayApiKey === undefined) {
      throw new Error("Native admin UI access requires a private gateway API key.");
    }
  }

  const nativeAdminSockets = new Set<Socket>();
  const nativeAdminPendingWork = new Set<Promise<unknown>>();
  let nativeAdminShuttingDown = false;
  function requireNativeAdminHumanSession(request: FastifyRequest, context: RequestContext) {
    const admitted = getAdmission(request);
    if (admitted?.method !== "session") {
      // Depends only on how the caller authenticated, so it discloses nothing about the Agent.
      throw failure(
        403,
        "FORBIDDEN",
        "Native admin UI requires a signed-in console session; service API keys cannot open it.",
      );
    }
    const session = admitted.session;
    if (session.userId !== context.subject || Date.parse(session.expiresAt) <= Date.now()) {
      throw failure(401, "UNAUTHENTICATED", "The caller did not provide valid credentials.");
    }
    return session;
  }

  async function appendNativeAdminSocketAudit(
    eventName: "connect" | "close",
    resolution: NativeAdminProxyResolution,
    socketEvent: {
      readonly connectionId: string;
      readonly closeReason?: NativeAdminWebSocketCloseReason;
    },
  ): Promise<void> {
    await options.auditSink.append(
      factory.create({
        installationId,
        namespaceId: resolution.namespaceId,
        kind: "mutation",
        source: "occ",
        actor: {
          principalId: resolution.actorId,
          issuer: resolution.actorIssuer,
          subject: resolution.actorSubject,
        },
        iamDriverId: selectedIAMDriver().id,
        authorization: {
          principalId: resolution.actorId,
          action: "administer",
          resource: {
            kind: "agent",
            id: resolution.agentId,
            namespaceId: resolution.namespaceId,
          },
        },
        action: `openclaw.agents.native_admin.websocket.${eventName}`,
        resource: {
          kind: "agent",
          id: resolution.agentId,
          namespaceId: resolution.namespaceId,
        },
        outcome: "success",
        details: {
          nativeAdmin: {
            event: eventName,
            connectionId: socketEvent.connectionId,
            ...(socketEvent.closeReason === undefined
              ? {}
              : { closeReason: socketEvent.closeReason }),
            parentSessionId: resolution.parentSessionId,
            revisionId: resolution.revisionId,
            host: resolution.target.host,
          },
        },
      }),
    );
  }

  async function appendNativeAdminProxyDenialAudit(
    admission: NativeAdminProxyAdmission | undefined,
  ): Promise<void> {
    if (
      admission === undefined ||
      !("denied" in admission) ||
      admission.actualAuthorizationDenied !== true ||
      admission.authorization === undefined ||
      !isNonEmptyString(admission.actorId) ||
      !isNonEmptyString(admission.actorIssuer) ||
      !isNonEmptyString(admission.actorSubject) ||
      !isNonEmptyString(admission.namespaceId) ||
      !isNonEmptyString(admission.agentId)
    ) {
      return;
    }
    await options.auditSink.append(
      factory.create({
        installationId,
        namespaceId: admission.namespaceId,
        kind: "authorization_denial",
        source: "occ",
        actor: {
          principalId: admission.actorId,
          issuer: admission.actorIssuer,
          subject: admission.actorSubject,
        },
        iamDriverId: selectedIAMDriver().id,
        authorization: { principalId: admission.actorId, ...admission.authorization },
        action: "openclaw.agents.native_admin.proxy.authorize",
        resource: {
          kind: "agent",
          id: admission.agentId,
          namespaceId: admission.namespaceId,
        },
        outcome: "denied",
        reasonCode: admission.reason.toUpperCase(),
        ...(admission.evidence?.restrictionIds.length
          ? { decisionReason: "A matching Restriction denied the operation." }
          : {}),
        details: {
          nativeAdmin: {
            reason: admission.reason,
            ...(isNonEmptyString(admission.revisionId) ? { revisionId: admission.revisionId } : {}),
            ...(isNonEmptyString(admission.host) ? { host: admission.host } : {}),
          },
          ...(admission.evidence === undefined
            ? {}
            : {
                iamEvidence: {
                  ...(admission.evidence.identityId === undefined
                    ? {}
                    : { identityId: admission.evidence.identityId }),
                  groupIds: admission.evidence.groupIds,
                  bindingIds: admission.evidence.bindingIds,
                  roleIds: admission.evidence.roleIds,
                  restrictionIds: admission.evidence.restrictionIds,
                },
              }),
        },
      }),
    );
  }

  function nativeAdminAuthority(
    hostHeader: string | readonly string[] | undefined,
  ): string | undefined {
    if (Array.isArray(hostHeader) || !isNonEmptyString(hostHeader)) {
      return undefined;
    }
    const raw = hostHeader.trim();
    if (raw !== hostHeader) {
      return undefined;
    }
    const trimmed = raw.toLowerCase();
    if (
      trimmed.includes("/") ||
      trimmed.includes("\\") ||
      trimmed.includes("@") ||
      trimmed.includes("?") ||
      trimmed.includes("#")
    ) {
      return undefined;
    }
    try {
      const parsed = new URL(`https://${trimmed}`);
      if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.pathname !== "/") {
        return undefined;
      }
      return parsed.host;
    } catch {
      return undefined;
    }
  }

  function nativeAdminHostname(
    hostHeader: string | readonly string[] | undefined,
  ): string | undefined {
    const authority = nativeAdminAuthority(hostHeader);
    if (authority === undefined) {
      return undefined;
    }
    return new URL(`https://${authority}`).hostname.toLowerCase();
  }

  function publicOriginHostname(): string | undefined {
    if (publicOrigin === undefined) {
      return undefined;
    }
    try {
      return new URL(publicOrigin).hostname.toLowerCase();
    } catch {
      return undefined;
    }
  }

  function isNativeAdminDomainHost(hostname: string | undefined): hostname is string {
    if (hostname === undefined || nativeAdminDomain === undefined) {
      return false;
    }
    return hostname !== publicOriginHostname() && hostname.endsWith(`.${nativeAdminDomain}`);
  }

  function isNativeAdminAgentHost(hostname: string | undefined): hostname is string {
    return isNativeAdminDomainHost(hostname) && hostname.startsWith("agent-");
  }

  function nativeAdminPathname(url: string | undefined): string {
    return url?.split("?", 1)[0] || "/";
  }

  function isNativeAdminReservedPrefix(url: string | undefined): boolean {
    return nativeAdminPathname(url).startsWith("/__occ/native-admin/");
  }

  async function boundedNativeAdminAdmission<T>(operation: Promise<T>): Promise<T | undefined> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<undefined>((resolve) => {
          const timer = setTimeout(
            () => resolve(undefined),
            NATIVE_ADMIN_PROXY_ADMISSION_TIMEOUT_MS,
          );
          timeout = timer;
          timer.unref();
        }),
      ]);
    } catch {
      return undefined;
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  function startNativeAdminAdmission(
    request: IncomingMessage,
    hostname: string,
    kind: "http" | "websocket",
    expectedRevisionId?: string,
  ) {
    const result = nativeAdminProxyContext(request, hostname, expectedRevisionId);
    // Own the result through its audit attempt, even after the caller stops waiting.
    // Tracking one chain prevents shutdown from missing admission becoming an append.
    const audit = result.then(
      async (admission) => {
        try {
          await appendNativeAdminProxyDenialAudit(admission);
          return true;
        } catch {
          if (kind === "http") {
            app.log.warn({ event: "native_admin.http_denial_audit_failed" });
          } else {
            app.log.warn({ event: "native_admin.websocket_denial_audit_failed" });
          }
          return false;
        }
      },
      () => true,
    );
    nativeAdminPendingWork.add(audit);
    void audit.then(() => nativeAdminPendingWork.delete(audit));
    return { result, audit };
  }

  async function drainNativeAdminWork(): Promise<void> {
    if (nativeAdminPendingWork.size === 0) {
      return;
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...nativeAdminPendingWork]),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, NATIVE_ADMIN_WORK_DRAIN_MS);
          timeout = timer;
          timer.unref();
        }),
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
    if (nativeAdminPendingWork.size > 0) {
      // This bounds shutdown waiting, not producer lifetime or durable delivery.
      // Keep ownership until settlement so a late denial still gets its attempt.
      app.log.warn({
        event: "native_admin.pending_work_unresolved",
        pending: nativeAdminPendingWork.size,
      });
    }
  }

  async function nativeAdminProxyTransportContext(
    resolution: NativeAdminProxyResolution | undefined,
  ): Promise<NativeAdminProxyContext | undefined> {
    if (resolution === undefined || options.nativeAdminGatewayApiKey === undefined) {
      return undefined;
    }
    try {
      const apiKey = await options.nativeAdminGatewayApiKey();
      if (!isNonEmptyString(apiKey)) {
        return undefined;
      }
      return {
        gatewayBase: resolution.gatewayBase,
        agentOrigin: resolution.target.origin,
        apiKey,
      };
    } catch {
      return undefined;
    }
  }

  type NativeAdminTargetStatus = {
    readonly agent: Agent;
    readonly revision: AgentRevision;
    readonly target: NativeAdminTarget;
  };
  type NativeAdminAvailability =
    | { readonly status: "disabled" | "stopped" | "unavailable" }
    | ({ readonly status: "stopped" | "unsupported" } & NativeAdminTargetStatus)
    | ({ readonly status: "available"; readonly gatewayBase: string } & NativeAdminTargetStatus);

  // An exclusive Compute Driver stops the active revision's workload before a newer
  // revision starts, so nothing serves until that revision activates. If it fails, the
  // Agent stays down while the old revision is still recorded as active.
  function replacesActiveWorkload(successor: Readonly<AgentRevision>): boolean {
    const controller = getController();
    let compute: ComputeDriver;
    try {
      compute = controller!.selectedDriver("compute");
    } catch {
      throw dependencyUnavailable();
    }
    return (
      successor.compute.id === compute.id &&
      successor.compute.implementation === compute.implementation &&
      compute.requiresStoppedPredecessors?.(successor) === true
    );
  }

  async function resolveNativeAdminAvailability(input: {
    readonly actorId: string;
    readonly namespaceId: string;
    readonly agentId: string;
  }): Promise<NativeAdminAvailability> {
    const controller = getController();
    if (!controller) {
      throw failure(404, "NOT_FOUND", "The requested platform resource was not found.");
    }
    if (options.nativeAdmin?.enabled !== true) {
      await controller.getAdministerableAgent(input.actorId, input.namespaceId, input.agentId);
      return { status: "disabled" };
    }
    if (publicOrigin === undefined || nativeAdminDomain === undefined) {
      throw dependencyUnavailable();
    }
    let selection;
    try {
      selection = await controller.getAdministerableActiveAgentRevision(
        input.actorId,
        input.namespaceId,
        input.agentId,
      );
    } catch (error) {
      // This administering lookup conflicts only when the authorized Agent is stopped without an active revision.
      if (error instanceof ResourceConflictError) {
        return { status: "stopped" };
      }
      // A running Agent still activating its first revision is a state the console shows.
      // Every other dependency failure, an IAM outage included, reaches the error handler.
      if (error instanceof NoActiveAgentRevisionError) {
        return { status: "unavailable" };
      }
      throw error;
    }
    const { agent, revision, successor } = selection;
    const target = nativeAdminTarget({
      publicOrigin,
      installationId,
      agent,
      revision,
      domain: nativeAdminDomain,
    });
    if (agent.desiredRuntimeState !== "running") {
      return { status: "stopped", agent, revision, target };
    }
    if (successor !== undefined && replacesActiveWorkload(successor)) {
      return { status: "unavailable" };
    }
    if (!nativeAdminConfigurationSupported(revision, target.origin)) {
      return { status: "unsupported", agent, revision, target };
    }
    let compute: ComputeDriver;
    try {
      compute = controller.selectedDriver("compute");
    } catch {
      throw dependencyUnavailable();
    }
    const gatewayBase = nativeAdminGatewayHttpBase(compute.getGatewayEndpoint?.(revision) ?? "");
    if (gatewayBase === undefined) {
      return { status: "unsupported", agent, revision, target };
    }
    return { status: "available", agent, revision, target, gatewayBase };
  }

  async function resolveNativeAdminAgentHost(
    hostname: string,
  ): Promise<Pick<Agent, "id" | "namespaceId"> | undefined> {
    const controller = getController();
    const domain = nativeAdminDomain;
    if (!controller || domain === undefined) {
      return undefined;
    }
    return controller.resolveAgentReference(
      (agent) => deriveNativeAdminHost(installationId, agent, domain) === hostname,
    );
  }

  function nativeAdminAvailabilityData(availability: NativeAdminAvailability) {
    if (!("target" in availability)) {
      return { status: availability.status };
    }
    return {
      status: availability.status,
      host: availability.target.host,
      origin: availability.target.origin,
      activeRevisionId: availability.revision.id,
      url: availability.target.url,
    };
  }

  async function requireAvailableNativeAdminTarget(input: {
    readonly actorId: string;
    readonly namespaceId: string;
    readonly agentId: string;
    readonly expectedHost?: string;
    readonly expectedRevisionId?: string;
  }) {
    const controller = getController();
    if (!controller) {
      throw failure(403, "FORBIDDEN", "The exact platform operation was not authorized.");
    }
    const availability = await resolveNativeAdminAvailability(input);
    if (availability.status === "disabled") {
      throw failure(403, "FORBIDDEN", "The exact platform operation was not authorized.");
    }
    if (
      availability.status === "unsupported" &&
      input.expectedRevisionId !== undefined &&
      availability.revision.id !== input.expectedRevisionId
    ) {
      throw failure(409, "RESOURCE_CONFLICT", "The active AgentRevision changed.");
    }
    if (availability.status !== "available") {
      throw dependencyUnavailable();
    }
    if (
      input.expectedRevisionId !== undefined &&
      availability.revision.id !== input.expectedRevisionId
    ) {
      throw failure(409, "RESOURCE_CONFLICT", "The active AgentRevision changed.");
    }
    if (input.expectedHost !== undefined && availability.target.host !== input.expectedHost) {
      throw failure(403, "FORBIDDEN", "The exact platform operation was not authorized.");
    }
    return availability;
  }

  async function getNativeAdminStatus(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const context = getContext(request);
    if (!context) {
      throw dependencyUnavailable();
    }
    const params = request.params as Record<string, string | undefined>;
    const namespaceId = params.namespaceId;
    const agentId = params.agentId;
    if (!isNonEmptyString(namespaceId) || !isNonEmptyString(agentId)) {
      throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
    }
    requireNativeAdminHumanSession(request, context);
    const availability = await resolveNativeAdminAvailability({
      actorId: context.actorId,
      namespaceId,
      agentId,
    });
    reply.send({
      data: nativeAdminAvailabilityData(availability),
      meta: { requestId: request.id },
    });
  }

  async function resolveNativeAdminActor(input: {
    readonly actorIssuer: string;
    readonly actorSubject: string;
  }): Promise<string | undefined> {
    try {
      const identity = await selectedIAMDriver().lookupIdentity({
        issuer: input.actorIssuer,
        subject: input.actorSubject,
      });
      if (
        identity?.kind !== "principal" ||
        identity.issuer !== input.actorIssuer ||
        identity.subject !== input.actorSubject
      ) {
        return undefined;
      }
      return identity.id;
    } catch {
      return undefined;
    }
  }

  function nativeAdminProxyDenial(
    reason: NativeAdminWebSocketCloseReason,
    input: Omit<NativeAdminProxyDenial, "denied" | "reason"> = {},
  ): NativeAdminProxyDenial {
    return { denied: true, reason, ...input };
  }

  function isNativeAdminProxyResolution(
    admission: NativeAdminProxyAdmission | undefined,
  ): admission is NativeAdminProxyResolution {
    return admission !== undefined && !("denied" in admission);
  }

  function nativeAdminFailureReason(error: unknown): NativeAdminWebSocketCloseReason {
    const mapped = requestFailure(error);
    if (mapped.code === "RESOURCE_CONFLICT") {
      return "revision_changed";
    }
    if (mapped.code === "DEPENDENCY_UNAVAILABLE") {
      return "agent_unavailable";
    }
    if (mapped.code === "FORBIDDEN") {
      return options.nativeAdmin?.enabled === true ? "authorization_denied" : "disabled";
    }
    return "dependency_failure";
  }

  async function nativeAdminProxyContext(
    request: IncomingMessage,
    hostname: string,
    expectedRevisionId?: string,
  ): Promise<NativeAdminProxyAdmission> {
    let admitted: AdmittedCaller;
    try {
      admitted = await options.auth.admissionVerifier.verify({
        requestId: `nar_${randomUUID()}`,
        method: request.method ?? "GET",
        routeId: "nativeAdminProxy",
        requestedScope: { installationId },
        transport: {
          remoteAddress: request.socket.remoteAddress ?? "127.0.0.1",
          ...(request.socket.localAddress === undefined
            ? {}
            : { localAddress: request.socket.localAddress }),
          trustProxy: false,
        },
        ...(typeof request.headers.authorization === "string"
          ? { authorizationHeader: request.headers.authorization }
          : {}),
        headers: request.headers,
      });
    } catch {
      return nativeAdminProxyDenial("session_invalid");
    }
    if (
      admitted.method !== "session" ||
      admitted.admittedScope.installationId !== installationId ||
      !isNonEmptyString(admitted.externalIdentity.issuer) ||
      !isNonEmptyString(admitted.externalIdentity.subject)
    ) {
      return nativeAdminProxyDenial("session_invalid");
    }
    const session = admitted.session;
    if (
      session.userId !== admitted.externalIdentity.subject ||
      Date.parse(session.expiresAt) <= Date.now()
    ) {
      return nativeAdminProxyDenial("session_invalid");
    }
    const actorIssuer = admitted.externalIdentity.issuer;
    const actorSubject = admitted.externalIdentity.subject;
    const currentActor = await resolveNativeAdminActor({ actorIssuer, actorSubject });
    if (currentActor === undefined) {
      return nativeAdminProxyDenial("authorization_denied");
    }
    const agent = await resolveNativeAdminAgentHost(hostname);
    if (agent === undefined) {
      return nativeAdminProxyDenial("authorization_denied");
    }
    try {
      const resolved = await requireAvailableNativeAdminTarget({
        actorId: currentActor,
        namespaceId: agent.namespaceId,
        agentId: agent.id,
        expectedHost: hostname,
        ...(expectedRevisionId === undefined ? {} : { expectedRevisionId }),
      });
      const requestAuthority = nativeAdminAuthority(request.headers.host);
      if (requestAuthority !== new URL(resolved.target.origin).host.toLowerCase()) {
        return nativeAdminProxyDenial("session_invalid");
      }
      return {
        parentSessionId: session.id,
        actorId: currentActor,
        actorIssuer,
        actorSubject,
        namespaceId: resolved.agent.namespaceId,
        agentId: resolved.agent.id,
        revisionId: resolved.revision.id,
        target: resolved.target,
        gatewayBase: resolved.gatewayBase,
      };
    } catch (error) {
      // A dependency outage (IAM or State) is not a denial, though its error class extends
      // AuthorizationDeniedError: close or refuse it as a dependency failure.
      if (isDependencyUnavailable(error)) {
        return nativeAdminProxyDenial("dependency_failure");
      }
      if (isAuthorizationDenied(error)) {
        return nativeAdminProxyDenial("authorization_denied", {
          actorId: currentActor,
          actorIssuer,
          actorSubject,
          namespaceId: agent.namespaceId,
          agentId: agent.id,
          ...(expectedRevisionId === undefined ? {} : { revisionId: expectedRevisionId }),
          host: hostname,
          actualAuthorizationDenied: true,
          ...(error.evidence === undefined ? {} : { evidence: error.evidence }),
          ...(error.authorization === undefined ? {} : { authorization: error.authorization }),
        });
      }
      return nativeAdminProxyDenial(nativeAdminFailureReason(error));
    }
  }

  async function interceptNativeAdminHttp(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<boolean> {
    const hostname = nativeAdminHostname(request.headers.host);
    if (!isNativeAdminDomainHost(hostname)) {
      return false;
    }
    if (isNativeAdminReservedPrefix(request.url) || !isNativeAdminAgentHost(hostname)) {
      canonicalFailure(
        reply,
        failure(403, "FORBIDDEN", "The exact platform operation was not authorized."),
      );
      return true;
    }
    if (nativeAdminShuttingDown) {
      canonicalFailure(reply, dependencyUnavailable());
      return true;
    }
    const operation = startNativeAdminAdmission(request.raw, hostname, "http");
    const admission = await boundedNativeAdminAdmission(operation.result);
    if (!isNativeAdminProxyResolution(admission)) {
      if (admission !== undefined && !(await operation.audit)) {
        canonicalFailure(reply, dependencyUnavailable());
        return true;
      }
      canonicalFailure(
        reply,
        admission === undefined
          ? dependencyUnavailable()
          : failure(403, "FORBIDDEN", "The exact platform operation was not authorized."),
      );
      return true;
    }
    if (nativeAdminShuttingDown || request.raw.socket.destroyed) {
      canonicalFailure(reply, dependencyUnavailable());
      return true;
    }
    const context = await boundedNativeAdminAdmission(nativeAdminProxyTransportContext(admission));
    if (context === undefined || nativeAdminShuttingDown || request.raw.socket.destroyed) {
      canonicalFailure(reply, dependencyUnavailable());
      return true;
    }
    await streamNativeAdminHttp({ request, reply, context });
    return true;
  }

  async function handleNativeAdminUpgrade(
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): Promise<void> {
    const hostname = nativeAdminHostname(request.headers.host);
    if (
      nativeAdminShuttingDown ||
      !isNativeAdminAgentHost(hostname) ||
      isNativeAdminReservedPrefix(request.url)
    ) {
      socket.destroy();
      return;
    }
    nativeAdminSockets.add(socket);
    socket.once("close", () => nativeAdminSockets.delete(socket));
    // Admission awaits before proxyNativeAdminWebSocket attaches its listener.
    // A reset in that gap is an 'error' event, and Node exits if nobody is listening.
    socket.on("error", () => {
      socket.destroy();
    });
    const operation = startNativeAdminAdmission(request, hostname, "websocket");
    const admission = await boundedNativeAdminAdmission(operation.result);
    if (!isNativeAdminProxyResolution(admission)) {
      socket.destroy();
      return;
    }
    if (socket.destroyed || nativeAdminShuttingDown) {
      socket.destroy();
      return;
    }
    const context = await boundedNativeAdminAdmission(nativeAdminProxyTransportContext(admission));
    if (socket.destroyed || nativeAdminShuttingDown) {
      socket.destroy();
      return;
    }
    if (context === undefined) {
      socket.destroy();
      return;
    }
    const connectionId = `naws_${randomUUID()}`;
    proxyNativeAdminWebSocket({
      request,
      socket,
      head,
      context,
      connectionId,
      ...(options.webSocketLeaseIntervalMs === undefined
        ? {}
        : { leaseIntervalMs: options.webSocketLeaseIntervalMs }),
      lease: async () => {
        if (nativeAdminShuttingDown) {
          return "shutdown";
        }
        if (socket.destroyed) {
          return "client_disconnect";
        }
        const renewal = startNativeAdminAdmission(
          request,
          hostname,
          "websocket",
          admission.revisionId,
        );
        const renewed = await boundedNativeAdminAdmission(renewal.result);
        if (renewed === undefined) {
          return "dependency_timeout";
        }
        if (!isNativeAdminProxyResolution(renewed)) {
          return renewed.reason;
        }
        return undefined;
      },
      onConnect: async () => {
        await appendNativeAdminSocketAudit("connect", admission, { connectionId });
      },
      onClose: (cause: NativeAdminWebSocketCloseCause) => {
        const closeReason = nativeAdminShuttingDown ? "shutdown" : cause.reason;
        const closeAudit = appendNativeAdminSocketAudit("close", admission, {
          connectionId: cause.connectionId,
          closeReason,
        }).catch((error) => {
          app.log.warn({
            event: "native_admin.websocket_audit_failed",
            error,
            namespaceId: admission.namespaceId,
            agentId: admission.agentId,
            revisionId: admission.revisionId,
          });
        });
        nativeAdminPendingWork.add(closeAudit);
        void closeAudit.then(() => nativeAdminPendingWork.delete(closeAudit));
      },
    });
  }

  app.server.on("upgrade", (request, socket, head) => {
    void handleNativeAdminUpgrade(request, socket as Socket, head);
  });

  app.addHook("preClose", async () => {
    nativeAdminShuttingDown = true;
    await Promise.all(
      [...nativeAdminSockets].map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.once("close", () => resolve());
            socket.destroy();
          }),
      ),
    );
    nativeAdminSockets.clear();
    await drainNativeAdminWork();
  });
  return { interceptHttp: interceptNativeAdminHttp, status: getNativeAdminStatus };
}
