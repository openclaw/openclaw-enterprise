import { sharedRsaKeyPair } from "../shared-keys.mjs";
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
  expectedRepositoryIds = [repositoryId],
  additionalRepositories = [],
  description = null,
  keyPair = sharedRsaKeyPair("github-app"),
  tokenLifetimeMs = 3600000,
  tokenResponse = (packet) => packet,
  additionalPermissions = [],
  installationAccess = false,
  encodeIssueResponse = JSON.stringify,
  beforeIssue,
  beforeIssueResponse,
  beforeMetadataResponse,
  issueResponse = (response) => response,
  issueResponseGate,
  /** Awaited after GitHub revokes a token, before its answer is sent. */
  revokeResponseGate,
  draftResponse = (body) => body,
  /** Maps the repository metadata body, e.g. to GitHub's own spelling of the name. */
  metadataResponse = (body) => body,
  revokeStatus = 204,
  issueStatus = 201,
}) {
  /** @type {string | undefined} */
  let issueBody;
  const { privateKey, publicKey } = keyPair;
  const authority = createTokenAuthority({
    clock,
    publicKey,
    lifetimeMs: tokenLifetimeMs,
    repositoryId,
    expectedRepositoryIds,
    additionalPermissions,
    installationAccess,
  });
  const resources = createRepositoryResources({ repository, repositoryId, description });
  const repositoryResources = [
    resources,
    ...additionalRepositories.map((entry) => createRepositoryResources(entry)),
  ];
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
        await beforeIssue?.();
        if (issueBody !== undefined) {
          // A raw answer in place of minting: malformed or ambiguous provider bodies.
          if (!disconnect(request, response, url)) {
            response.writeHead(issueStatus, { "content-type": "application/json" });
            response.end(issueBody);
          }
          return;
        }
        if (issueStatus !== 201) {
          // GitHub refuses before minting: a rejected App key (401), an unknown installation
          // (404) or a repository outside it (422) answers with no token.
          json(issueStatus, { message: "Refused", status: String(issueStatus) });
          return;
        }
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
            repositories: repositoryResources
              .filter((entry) => expectedRepositoryIds.map(String).includes(String(entry.repo.id)))
              .map((entry) => entry.repo),
          }),
        });
        if (!disconnect(request, response, url)) {
          response.writeHead(issued.status, { "content-type": "application/json" });
          response.end(encodeIssueResponse(issued.body));
        }
        return;
      }
      if (request.method === "DELETE" && url.pathname === "/installation/token") {
        if (revokeStatus !== 204) {
          json(revokeStatus, { message: "Revocation not confirmed" });
          return;
        }
        authority.revoke(request.headers.authorization);
        await revokeResponseGate?.();
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
      const selectedResources =
        repositoryResources.find(
          (entry) =>
            url.pathname === `/repos/${entry.repo.full_name}` ||
            url.pathname.startsWith(`/repos/${entry.repo.full_name}/`),
        ) ??
        (url.pathname === "/graphql" && body.variables?.owner && body.variables?.name
          ? repositoryResources.find(
              (entry) => entry.repo.full_name === `${body.variables.owner}/${body.variables.name}`,
            )
          : resources);
      if (
        !selectedResources ||
        !authority.permitsRepository(request.headers.authorization, selectedResources.repo.id)
      ) {
        json(404, { message: "Not Found" });
        return;
      }
      const result = selectedResources.dispatch({
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
        const createPull =
          request.method === "POST" && url.pathname === "/repos/" + repository + "/pulls";
        if (createPull) {
          entry.forwardedOperationId = Object.hasOwn(request.headers, "x-oce-operation-id");
          entry.usedBearer = request.headers.authorization.startsWith("Bearer ");
        }
        const metadata = request.method === "GET" && url.pathname === `/repos/${repository}`;
        json(
          result.status,
          createPull
            ? draftResponse(result.body)
            : metadata
              ? metadataResponse(result.body)
              : result.body,
          result.headers,
        );
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
    authorizeRepository: authority.authorizeRepository,
    acceptStatic: authority.acceptStatic,
    tokenState: authority.tokenState,
    setRevokeStatus(status) {
      revokeStatus = status;
    },
    /**
     * Answer issue requests with this status and no token (201 issues again), or with this
     * raw body in place of minting.
     */
    setIssueStatus(status, body = undefined) {
      issueStatus = status;
      issueBody = body;
    },
    disconnectAfterMutation(method, target) {
      disconnectMutation = `${method} ${target}`;
    },
  };
}
