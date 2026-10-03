import { generateKeyPairSync } from "node:crypto";
import { fixtureInstallationId, fixtureRepository, fixtureRepositoryId } from "./metadata.mjs";
import { createTokenAuthority } from "./token-authority.mjs";
import { createRepositoryResources } from "./repository-resources.mjs";

export {
  fixtureRepository,
  fixtureRepositoryId,
  fixtureInstallationId,
  fixtureAppId,
  humanText,
} from "./metadata.mjs";

export function createGitHubProtocol({
  clock,
  repository = fixtureRepository,
  repositoryId = fixtureRepositoryId,
  description = null,
  keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 }),
  tokenLifetimeMs = 3600000,
  tokenResponse = (packet) => packet,
  beforeIssueResponse,
  beforeMetadataResponse,
  issueResponse = (response) => response,
  issueResponseGate,
  revokeStatus = 204,
}) {
  const { privateKey, publicKey } = keyPair;
  const authority = createTokenAuthority({
    clock,
    publicKey,
    lifetimeMs: tokenLifetimeMs,
    repositoryId,
  });
  const resources = createRepositoryResources({ repository, repositoryId, description });
  const trace = [];
  const errors = [];
  let disconnectMutation;
  function disconnect(request, response, url) {
    if (disconnectMutation !== `${request.method} ${url.pathname}`) {
      return false;
    }
    disconnectMutation = undefined;
    response.destroy();
    return true;
  }
  const handleRequest = async (request, response) => {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1024 * 1024) {
          throw new Error("fixture request limit");
        }
        chunks.push(chunk);
      }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const url = new URL(request.url, "https://api.github.com");
      const entry = {
        method: request.method,
        target: request.url,
        userAgent: request.headers["user-agent"],
        apiVersion: request.headers["x-github-api-version"],
        graphQLFeatures: request.headers["graphql-features"],
        accept: request.headers.accept,
        tokenIndex: authority.tokenIndex(request.headers.authorization),
      };
      trace.push(entry);
      const json = (status, value, headers = {}) => {
        if (disconnect(request, response, url)) {
          return;
        }
        response.writeHead(status, { "content-type": "application/json", ...headers });
        response.end(JSON.stringify(value));
      };
      if (
        request.method === "POST" &&
        url.pathname === `/app/installations/${fixtureInstallationId}/access_tokens`
      ) {
        // The provider owns the token before response gates can delay or lose its delivery.
        const { token, expires, permissions } = authority.issue(
          request.headers.authorization,
          body,
        );
        await beforeIssueResponse?.();
        await issueResponseGate?.();
        const issued = issueResponse({
          status: 201,
          body: tokenResponse({
            token,
            expires_at: new Date(expires).toISOString(),
            permissions,
            repository_selection: "selected",
            repositories: [resources.repo],
          }),
        });
        json(issued.status, issued.body);
        return;
      }
      if (request.method === "DELETE" && url.pathname === "/installation/token") {
        if (revokeStatus !== 204) {
          json(revokeStatus, { message: "Revocation not confirmed" });
          return;
        }
        authority.revoke(request.headers.authorization);
        if (!disconnect(request, response, url)) {
          response.writeHead(204).end();
        }
        return;
      }
      if (!authority.authorize(request.headers.authorization)) {
        json(401, { message: "Unauthorized" });
        return;
      }
      if (request.method === "GET" && url.pathname === `/repos/${repository}`) {
        await beforeMetadataResponse?.({ request, response });
      }
      if (url.pathname === "/graphql") {
        entry.query = body.query;
        entry.variables = body.variables;
        entry.operation = (body.query ?? "").includes("createPullRequest")
          ? "createPullRequest"
          : "query";
      }
      // Commit provider mutations before injecting a lost response, including DELETE.
      const result = resources.dispatch({
        method: request.method,
        url,
        body,
        accept: request.headers.accept,
        permissions: authority.permissions(request.headers.authorization),
      });
      if (result.status === 204) {
        if (!disconnect(request, response, url)) {
          response.writeHead(204).end();
        }
        return;
      }
      if (result.raw !== undefined) {
        response.writeHead(result.status, {
          "content-type": "text/plain; charset=utf-8",
          ...result.headers,
        });
        response.end(result.raw);
      } else {
        json(result.status, result.body, result.headers);
      }
    } catch (error) {
      // Keep failure evidence safe: assertion values may include signing input.
      errors.push(error.name);
      response.destroy();
    }
  };
  return {
    handleRequest,
    clock,
    privateKey,
    publicKey,
    trace,
    issuesOfTokens: authority.issuesOfTokens,
    authenticationAttempts: authority.authenticationAttempts,
    issues: resources.issues,
    pulls: resources.pulls,
    comments: resources.comments,
    errors,
    authorize: authority.authorize,
    tokenState: authority.tokenState,
    setRevokeStatus(status) {
      revokeStatus = status;
    },
    disconnectAfterMutation(method, target) {
      disconnectMutation = `${method} ${target}`;
    },
  };
}
