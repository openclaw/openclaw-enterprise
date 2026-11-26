import type {
  RepositoryBackendFactory,
  Denied,
  RequestHead,
} from "../../access/backend-contracts.ts";
import { repositorySessionBearerSource } from "../../access/client-contracts.ts";

const repositorySessionBearerPattern = new RegExp(`^${repositorySessionBearerSource}$`);
const apiSessionBearerPattern = new RegExp(
  `^(?:token|Bearer) (${repositorySessionBearerSource})$`,
  "i",
);

type GatewayAuthenticationDependencies = Readonly<{
  isGitRoute: (head: RequestHead) => boolean;
}>;

function parseSessionBearer(authorization: string, git: boolean): string | undefined {
  if (typeof authorization !== "string" || authorization.length > 4096) {
    return;
  }
  if (!git) {
    return apiSessionBearerPattern.exec(authorization)?.[1];
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
    return repositorySessionBearerPattern.test(token) ? token : undefined;
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
