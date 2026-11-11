import type {
  RepositoryBackendFactory,
  Denied,
  RequestHead,
} from "../../access/backend-contracts.ts";

type GatewayAuthenticationDependencies = Readonly<{
  isGitRoute: (head: RequestHead) => boolean;
}>;

function parseSessionBearer(authorization: string, git: boolean): string | undefined {
  if (typeof authorization !== "string" || authorization.length > 4096) {
    return;
  }
  if (!git) {
    return /^(?:token|Bearer) ([A-Za-z0-9_-]{43,256})$/i.exec(authorization)?.[1];
  }
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
  if (!match) {
    return;
  }
  const bytes = Buffer.from(match[1]!, "base64");
  try {
    if (bytes.toString("base64") !== match[1]) {
      return;
    }
    const text = bytes.toString("utf8");
    const prefix = "gateway-session:";
    if (!text.startsWith(prefix)) {
      return;
    }
    const token = text.slice(prefix.length);
    return /^[A-Za-z0-9_-]{43,256}$/.test(token) ? token : undefined;
  } finally {
    bytes.fill(0);
  }
}

function invalidCredential(): Denied {
  return Object.freeze({ kind: "denied", status: 401, code: "invalid-credential" });
}

export function createGatewayAuthentication({
  isGitRoute,
}: GatewayAuthenticationDependencies): Pick<
  RepositoryBackendFactory,
  "parseAuthentication" | "unauthenticated"
> {
  return {
    parseAuthentication(head, authorization) {
      return parseSessionBearer(authorization, isGitRoute(head)) ?? invalidCredential();
    },
    unauthenticated(head) {
      return isGitRoute(head)
        ? Object.freeze({ kind: "challenge" as const, realm: "repository-credential-service" })
        : invalidCredential();
    },
  };
}
