import type {
  Denied,
  RequestPlan,
  ResolvedGrant,
  SessionAuthenticatedRequest,
} from "../../../../apps/controller/src/drivers/repo/access/backend-contracts.ts";

export const denied: Denied = Object.freeze({ kind: "denied", status: 403, code: "route-denied" });

export function resolveAlternateProfile(
  profile: string,
  { binding, gatewayOrigin }: { binding: ResolvedGrant["binding"]; gatewayOrigin: string },
): ResolvedGrant {
  if (profile !== "git-write") {
    throw new Error("unsupported-profile");
  }
  return Object.freeze({
    binding,
    client: Object.freeze({
      gatewayOrigin,
      gitRemote: `${gatewayOrigin}/team/nested/project`,
      gitUsername: "session",
      canonicalApiHost: "forge.example.test",
      apiHost: new URL(gatewayOrigin).host,
      repository: "team/nested/project",
    }),
  });
}

export function createAlternatePlan(
  request: SessionAuthenticatedRequest,
  { sessionId, origin, operationMs }: { sessionId: string; origin: string; operationMs: number },
): RequestPlan | Denied {
  if (
    request.authority.sessionId !== sessionId ||
    request.head.rawTarget !== "/team/nested/project" ||
    !["GET", "POST"].includes(request.head.method)
  ) {
    return denied;
  }
  const plan: Omit<RequestPlan, symbol> = {
    origin,
    target: "/v2/projects/team%2Fnested%2Fproject",
    method: request.head.method,
    category: request.head.method === "POST" ? "source-write" : "source-read",
    effect: request.head.method === "POST" ? "write" : "read",
    requestHeaders: Object.freeze({
      accept: "application/json",
      ...(request.head.method === "POST" ? { "content-type": "application/octet-stream" } : {}),
    }),
    limits: Object.freeze({
      inputWireBytes: 1024,
      inputDecodedBytes: 1024,
      responseBytes: 8192,
      totalMs: operationMs,
      inputMs: operationMs,
      firstHeaderMs: operationMs,
      stallMs: operationMs,
      connectMs: operationMs,
    }),
    responsePolicy: Object.freeze({
      body: "stream",
      headers: (_status, headers) => ({
        "content-type": headers["content-type"] ?? "application/json",
      }),
      rewriteJson: undefined,
    }),
  };
  return Object.freeze(plan) as RequestPlan;
}
