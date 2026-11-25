import { constants, createPrivateKey, sign } from "node:crypto";
import { Agent, request as sendRequest } from "undici";

import { asRecord } from "@openclaw-enterprise/utils";
import {
  parseInstallationTokenResponse,
  validateInstallationTokenResponse,
} from "../repo/github/access/installation-token-response.ts";
import { githubProviderOrigin } from "../repo/github/access/origin.ts";
import {
  createRepositorySlugPattern,
  isGitHubRepositoryPermissions,
  parseGitHubNumericId,
  validateGitHubFiniteInstallationScope,
  type GitHubAppRepositorySelection,
} from "../repo/github/access/repository-grant.ts";
import { isGitHubWireCredential } from "../repo/github/access/wire-credential.ts";

const requestTimeoutMs = 10_000;
const responseLimitBytes = 256 * 1024;
const minimumValidityMs = 60_000;

export interface GitHubAppIssuerOptions {
  readonly apiOrigin?: string;
  readonly ca?: Uint8Array;
  readonly clock?: { wallNow(): number };
}

function appJwt(appId: string, pem: string, now: number): string {
  try {
    const key = createPrivateKey(pem);
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    if (
      parseGitHubNumericId(appId) === undefined ||
      key.asymmetricKeyType !== "rsa" ||
      bits < 2048 ||
      bits > 8192
    ) {
      throw new Error();
    }
    const seconds = Math.floor(now / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: seconds - 60, exp: seconds + 300, iss: appId })}`;
    const signature = sign("sha256", Buffer.from(unsigned), {
      key,
      padding: constants.RSA_PKCS1_PADDING,
    }).toString("base64url");
    return `${unsigned}.${signature}`;
  } catch {
    throw new Error("The provisioned GitHub App signing key is invalid.");
  }
}

function selectedScope(selection: GitHubAppRepositorySelection) {
  const repositories = selection.repositories;
  if (repositories.every(({ repositoryId }) => repositoryId !== undefined)) {
    validateGitHubFiniteInstallationScope(selection);
  } else {
    const names = repositories.map(({ repository }) => repository.toLowerCase());
    const owner = names[0]?.split("/")[0];
    if (
      names.length < 1 ||
      names.length > 16 ||
      new Set(names).size !== names.length ||
      names.some(
        (name) => !createRepositorySlugPattern().test(name) || !name.startsWith(`${owner}/`),
      ) ||
      repositories.some(
        ({ repositoryId }) =>
          repositoryId !== undefined && parseGitHubNumericId(repositoryId) === undefined,
      ) ||
      !isGitHubRepositoryPermissions(selection.permissions)
    ) {
      throw new Error("The GitHub installation scope is invalid.");
    }
  }
  const byId = repositories.every(({ repositoryId }) => repositoryId !== undefined);
  const selected = repositories
    .map(({ repository, repositoryId }) => ({
      name: repository.toLowerCase(),
      ...(repositoryId === undefined ? {} : { id: parseGitHubNumericId(repositoryId)! }),
    }))
    .sort((a, b) => (byId ? a.id! - b.id! : a.name.localeCompare(b.name, "en")));
  return {
    expected: {
      kind: "selected" as const,
      repositories: selected,
      permissions: selection.permissions,
    },
    body: {
      ...(byId
        ? { repository_ids: selected.map(({ id }) => id!) }
        : { repositories: selected.map(({ name }) => name.slice(name.indexOf("/") + 1)) }),
      permissions: selection.permissions,
    },
  };
}

/** TokenService alone selects the trusted GitHub origin and uses App signing material. */
export function createGitHubAppSourceIssuer(options: GitHubAppIssuerOptions = {}) {
  const origin = githubProviderOrigin(options.apiOrigin ?? "https://api.github.com");
  const now = () => options.clock?.wallNow() ?? Date.now();

  async function request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    bearer: string,
    signal: AbortSignal,
    body?: object,
  ) {
    if (!isGitHubWireCredential(bearer)) {
      throw new Error("The GitHub authorization is invalid.");
    }
    const dispatcher = new Agent({
      maxResponseSize: responseLimitBytes,
      connect: { rejectUnauthorized: true, ...(options.ca && { ca: Buffer.from(options.ca) }) },
    });
    try {
      const response = await sendRequest(`${origin}${path}`, {
        method,
        signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
        dispatcher,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${bearer}`,
          "user-agent": "openclaw-enterprise-token-service",
          "x-github-api-version": "2026-03-10",
          "accept-encoding": "identity",
          ...(body && { "content-type": "application/json" }),
        },
        ...(body && { body: JSON.stringify(body) }),
      });
      try {
        const encoding = response.headers["content-encoding"];
        if (encoding && encoding !== "identity") {
          throw new Error("Unexpected GitHub response encoding.");
        }
        return {
          status: response.statusCode,
          body: Buffer.from(await response.body.arrayBuffer()),
        };
      } finally {
        response.body.destroy();
      }
    } finally {
      await dispatcher.close();
    }
  }

  async function revoke(credential: string, signal: AbortSignal): Promise<boolean> {
    const response = await request("DELETE", "/installation/token", credential, signal);
    response.body.fill(0);
    return response.status === 204;
  }

  return {
    async verifySigningKey(appId: string, privateKey: string, signal: AbortSignal): Promise<void> {
      try {
        const reply = await request("GET", "/app", appJwt(appId, privateKey, now()), signal);
        try {
          if (
            reply.status === 200 &&
            asRecord(JSON.parse(reply.body.toString("utf8")))?.id === parseGitHubNumericId(appId)
          ) {
            return;
          }
        } finally {
          reply.body.fill(0);
        }
      } catch {
        signal.throwIfAborted();
      }
      throw new Error("The GitHub App identity could not be verified.");
    },
    async mintInstallationToken(
      scope: GitHubAppRepositorySelection,
      privateKey: string,
      signal: AbortSignal,
    ) {
      let candidate: string | undefined;
      try {
        const appId = parseGitHubNumericId(scope.appId);
        const installationId = parseGitHubNumericId(scope.installationId);
        if (appId === undefined || installationId === undefined) {
          throw new Error();
        }
        const jwt = appJwt(scope.appId, privateKey, now());
        let selection = scope;
        if (scope.repositories.some(({ repositoryId }) => repositoryId === undefined)) {
          const reply = await request("GET", `/app/installations/${installationId}`, jwt, signal);
          let owner: string | undefined;
          try {
            const record = asRecord(JSON.parse(reply.body.toString("utf8")));
            const login = asRecord(record?.account)?.login;
            if (
              reply.status === 200 &&
              record?.id === installationId &&
              record.app_id === appId &&
              typeof login === "string" &&
              createRepositorySlugPattern().test(`${login}/repository`)
            ) {
              owner = login.toLowerCase();
            }
          } finally {
            reply.body.fill(0);
          }
          if (!owner) {
            throw new Error();
          }
          selection = {
            ...scope,
            repositories: scope.repositories.map((repo) => ({
              ...repo,
              repository: repo.repository.includes("/")
                ? repo.repository
                : `${owner}/${repo.repository}`,
            })),
          };
          if (
            selection.repositories.some(
              ({ repository }) => !repository.toLowerCase().startsWith(`${owner}/`),
            )
          ) {
            throw new Error();
          }
        }
        const { expected, body } = selectedScope(selection);
        const reply = await request(
          "POST",
          `/app/installations/${installationId}/access_tokens`,
          jwt,
          signal,
          body,
        );
        try {
          const parsed = parseInstallationTokenResponse(reply.body);
          candidate = parsed.token;
          const result = validateInstallationTokenResponse(
            reply.status,
            parsed.packet,
            candidate,
            now(),
            expected,
            minimumValidityMs,
          );
          if (result.kind === "validated" && result.repositories) {
            signal.throwIfAborted();
            return {
              credential: result.credential,
              expiresAt: new Date(result.usableUntil).toISOString(),
              providerExpiresAt: new Date(result.providerExpiresAt).toISOString(),
              repositories: result.repositories,
            };
          }
        } finally {
          reply.body.fill(0);
        }
      } catch {
        /* Never expose issuer response details or credential material. */
      }
      if (isGitHubWireCredential(candidate)) {
        await revoke(candidate, AbortSignal.timeout(3_000)).catch(() => false);
      }
      throw new Error("GitHub did not issue a usable installation token.");
    },
    revoke,
  };
}

export type GitHubAppSourceIssuer = ReturnType<typeof createGitHubAppSourceIssuer>;
