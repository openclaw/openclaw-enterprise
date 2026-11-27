import type { AuditEvent, ResourceRef } from "@openclaw-enterprise/contracts";
import { createHash, randomBytes } from "node:crypto";
import {
  BrowserAuthorizationError,
  CallerStateDeniedError,
  type OpenClawController,
  type PlatformUnitOfWork,
} from "@openclaw-enterprise/occ";
import type { FastifyReply, FastifyRequest } from "fastify";
import { failure } from "./errors.ts";
import type { RequestContext, ResourceHandlers } from "./types.ts";

export const CONNECTION_CALLBACK_PATH = "/oauth/callback";

export function namespaceConnectionHandlers(redirectUri: string | undefined): ResourceHandlers {
  return {
    async listUsableConnectionTemplates({ controller, context, request, reply, namespaceId }) {
      const data = await controller.listUsableConnectionTemplates(context.actorId, namespaceId);
      reply.send({ data, meta: { requestId: request.id } });
    },
    async listEligibleOAuthClients({ controller, context, request, reply, namespaceId }) {
      const { connectionTemplateId } = request.query as { connectionTemplateId: string };
      const data = await controller.listEligibleOAuthClients(
        context.actorId,
        namespaceId,
        connectionTemplateId,
      );
      reply.send({ data, meta: { requestId: request.id } });
    },
    async startNamespaceConnection({
      controller,
      context,
      request,
      reply,
      body,
      namespaceId,
      mutationEvent,
    }) {
      if (!context.sessionId) {
        throw failure(
          403,
          "FORBIDDEN",
          "Connecting an account requires a signed-in browser session.",
        );
      }
      if (!redirectUri) {
        throw failure(
          503,
          "DEPENDENCY_UNAVAILABLE",
          "The public OAuth callback origin is unavailable.",
        );
      }
      const data = await controller.startNamespaceConnection(
        context.actorId,
        {
          namespaceId,
          connectionTemplateId: body!.connectionTemplateId as string,
          oauthClientId: body!.oauthClientId as string,
          ...(body!.selectedScopes === undefined
            ? {}
            : { selectedScopes: body!.selectedScopes as string[] }),
          redirectUri,
          sessionId: context.sessionId,
        },
        () => mutationEvent({ kind: "credential_source", namespaceId, id: namespaceId }),
      );
      reply
        .header("cache-control", "no-store")
        .status(201)
        .send({ data, meta: { requestId: request.id } });
    },
  };
}

/** Admission identity for the callback, which is a browser redirect rather than a JSON API. */
export const connectionCallbackOperation = {
  operationId: "completeNamespaceConnection",
  method: "GET",
  path: CONNECTION_CALLBACK_PATH,
  action: "openclaw.namespaces.connections.complete",
  iamAction: "create",
  resourceKind: "credential_source",
  authorizationTarget: "namespace_collection",
  summary: "Complete a browser connection for the signed-in person who started it",
  tags: ["Connections"],
} as const;

export const connectionCallbackSchema = {
  operationId: connectionCallbackOperation.operationId,
  summary: connectionCallbackOperation.summary,
  description:
    "Requires the signed-in human session that started the connection, permission to create a credential source in the starting Namespace, and a template available there. The provider redirects here with `state` and `code`, or with `error`. Browser success returns a small HTML page that confirms the saved Source to the initiating Console tab; other requests redirect to the console without the provider query.",
  tags: [...connectionCallbackOperation.tags],
  security: [{ sessionCookie: [] }],
  "x-openclaw-permissions": [
    { action: "create", resourceKind: "credential_source", scope: "namespace" },
  ],
  response: {
    200: {
      description: "Browser consent completion page",
      content: { "text/html": { schema: { type: "string" } } },
    },
    303: { description: "Redirect to the console with the connection outcome" },
    429: { description: "Too many requests; wait for Retry-After" },
  },
  querystring: {
    type: "object",
    additionalProperties: true,
    properties: {
      state: { type: "string", maxLength: 512 },
      code: { type: "string", maxLength: 4096 },
      error: { type: "string", maxLength: 256 },
      iss: {
        type: "string",
        maxLength: 2048,
        description:
          "Authorization server issuer. Must match the connection template when present. Required for code exchange if another issuer has a client registration when consent starts or when the callback arrives.",
      },
    },
  },
} as const;

export interface ConnectionCallbackDependencies {
  readonly withCurrentSession: <T>(
    request: FastifyRequest,
    work: (holdSession: (unit: PlatformUnitOfWork) => Promise<void>) => Promise<T>,
  ) => Promise<T>;
  readonly getController: () => OpenClawController | undefined;
  readonly getContext: (request: FastifyRequest) => RequestContext | undefined;
  readonly auditEvent: (
    request: FastifyRequest,
    context: RequestContext,
    target: ResourceRef,
  ) => AuditEvent;
  /** Audits a refused or failed callback with its safe reason code, never the query. */
  readonly auditFailure: (
    request: FastifyRequest,
    context: RequestContext,
    reasonCode: string,
  ) => Promise<void>;
}

/**
 * Only the successfully verified callback can confirm a Source to the initiating tab.
 * A URL that the provider can construct is not proof that consent completed.
 */
export function createConnectionCallback(dependencies: ConnectionCallbackDependencies) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.header("referrer-policy", "no-referrer");
    reply.header("cache-control", "no-store");
    const controller = dependencies.getController();
    const context = dependencies.getContext(request);
    const sessionId = context?.sessionId;
    const query = request.query as Record<string, unknown>;
    const state = typeof query.state === "string" ? query.state : "";
    const fail = (reason: string) =>
      reply.redirect(`/console/?connection=failed&reason=${encodeURIComponent(reason)}`, 303);
    if (controller === undefined || !context || sessionId === undefined) {
      fail("session_required");
      return;
    }
    try {
      const connection = await dependencies.withCurrentSession(request, (holdSession) =>
        controller.completeNamespaceConnection(
          context.actorId,
          {
            state,
            sessionId,
            ...(typeof query.iss === "string" ? { iss: query.iss } : {}),
            ...(typeof query.code === "string" ? { code: query.code } : {}),
            ...(typeof query.error === "string" ? { error: query.error } : {}),
          },
          (result) =>
            dependencies.auditEvent(request, context, {
              kind: "credential_source",
              namespaceId: result.namespaceId,
              id: result.id,
            }),
          holdSession,
        ),
      );
      const cleanUrl = `/console/?namespace=${encodeURIComponent(connection.namespaceId)}&connection=connected&sourceId=${encodeURIComponent(connection.id)}`;
      if (acceptsHtml(request.headers.accept)) {
        const nonce = randomBytes(18).toString("base64");
        const stateHash = createHash("sha256").update(state).digest("hex");
        reply
          .header(
            "content-security-policy",
            `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
          )
          .header("x-content-type-options", "nosniff")
          .type("text/html; charset=utf-8")
          .send(consentCompletionPage(nonce, cleanUrl, stateHash, connection.id));
        return;
      }
      reply.redirect(cleanUrl, 303);
    } catch (error) {
      let reason = "unavailable";
      if (error instanceof CallerStateDeniedError) {
        reason = "session_required";
      } else if (
        error instanceof BrowserAuthorizationError &&
        /^[a-z][a-z0-9_]{0,63}$/.test(error.code)
      ) {
        reason = error.code;
      }
      await dependencies.auditFailure(request, context, reason);
      fail(reason);
    }
  };
}

function acceptsHtml(accept: string | undefined): boolean {
  return (accept ?? "")
    .split(",")
    .some((part) => part.trim().split(";", 1)[0]?.toLowerCase() === "text/html");
}

function scriptString(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function consentCompletionPage(
  nonce: string,
  cleanUrl: string,
  stateHash: string,
  sourceId: string,
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Account connected</title></head><body><script nonce="${nonce}">(() => {
    const clean = ${scriptString(cleanUrl)};
    history.replaceState(null, "", clean);
    try {
      const key = "oce.pluginAccountConsent";
      const name = sessionStorage.getItem(key);
      const expected = sessionStorage.getItem(key + ".stateHash");
      if (name && expected === ${scriptString(stateHash)} && typeof BroadcastChannel !== "undefined") {
        sessionStorage.removeItem(key);
        sessionStorage.removeItem(key + ".stateHash");
        const channel = new BroadcastChannel(name);
        channel.postMessage({ outcome: "saved", sourceId: ${scriptString(sourceId)} });
        channel.close();
        document.body.textContent = "Return to the original Console tab to check your connection.";
        window.close();
        return;
      }
    } catch {}
    location.replace(clean);
  })();</script></body></html>`;
}
