import assert from "node:assert/strict";
import type { KeyObject } from "node:crypto";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { sharedRsaKeyPair } from "../shared-keys.mjs";
import { fixtureInstallationId, fixtureRepository, fixtureRepositoryId } from "./metadata.ts";
import { createTokenAuthority, type Permissions, type WallClock } from "./token-authority.ts";
import {
  createRepositoryResources,
  readGraphQLRequest,
  type CreatedPull,
  type RepositoryMetadata,
  type RepositoryOptions,
} from "./repository-resources.ts";

export {
  fixtureRepository,
  fixtureRepositoryId,
  fixtureInstallationId,
  fixtureAppId,
  humanText,
} from "./metadata.ts";

type TokenPacket = {
  token: string;
  expires_at: string;
  permissions: Permissions;
  repository_selection: "selected";
  repositories: RepositoryMetadata[];
};

type IssueResponse = { status: number; body: unknown };
type Gate = () => void | Promise<void>;
type MetadataGate = (exchange: {
  request: IncomingMessage;
  response: ServerResponse;
}) => void | Promise<void>;

export type GitHubProtocolOptions = RepositoryOptions & {
  clock: WallClock;
  expectedRepositoryIds?: readonly (number | string)[];
  additionalRepositories?: readonly RepositoryOptions[];
  keyPair?: { privateKey: KeyObject; publicKey: KeyObject };
  tokenLifetimeMs?: number | ((index: number) => number);
  tokenResponse?: (packet: TokenPacket) => unknown;
  additionalPermissions?: readonly Permissions[];
  installationAccess?: boolean;
  encodeIssueResponse?: (body: unknown) => string | Buffer | undefined;
  beforeIssue?: Gate | undefined;
  beforeIssueResponse?: Gate;
  beforeMetadataResponse?: MetadataGate | undefined;
  issueResponse?: (reply: IssueResponse) => IssueResponse;
  issueResponseGate?: Gate;
  revokeResponseGate?: Gate;
  draftResponse?: (body: CreatedPull) => unknown;
  metadataResponse?: (body: RepositoryMetadata) => unknown;
  revokeStatus?: number;
  issueStatus?: number;
};

type RequestTrace = {
  method: string | undefined;
  target: string | undefined;
  userAgent: string | undefined;
  apiVersion: string | string[] | undefined;
  graphQLFeatures: string | string[] | undefined;
  accept: string | undefined;
  tokenIndex: number | undefined;
  query?: string | null | undefined;
  variables?: Record<string, unknown> | null | undefined;
  operation?: "createPullRequest" | "query";
  forwardedOperationId?: boolean;
  usedBearer?: boolean;
};

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
}: GitHubProtocolOptions) {
  let issueBody: string | Buffer | undefined;
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
  const trace: RequestTrace[] = [];
  const errors: string[] = [];
  let disconnectMutation: string | undefined;
  function disconnect(request: IncomingMessage, response: ServerResponse, url: URL) {
    if (disconnectMutation !== `${request.method} ${url.pathname}`) {
      return false;
    }
    disconnectMutation = undefined;
    response.destroy();
    return true;
  }
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request as AsyncIterable<unknown>) {
        assert.ok(Buffer.isBuffer(chunk), "expected HTTP request bytes");
        size += chunk.length;
        if (size > 1024 * 1024) {
          throw new Error("fixture request limit");
        }
        chunks.push(chunk);
      }
      const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      assert.ok(request.url, "expected an HTTP request target");
      const url = new URL(request.url, "https://api.github.com");
      const entry: RequestTrace = {
        method: request.method,
        target: request.url,
        userAgent: request.headers["user-agent"],
        apiVersion: request.headers["x-github-api-version"],
        graphQLFeatures: request.headers["graphql-features"],
        accept: request.headers.accept,
        tokenIndex: authority.tokenIndex(request.headers.authorization),
      };
      trace.push(entry);
      const json = (status: number, value: unknown, headers: OutgoingHttpHeaders = {}) => {
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
      const graph = url.pathname === "/graphql" ? readGraphQLRequest(body) : undefined;
      if (graph) {
        entry.query = graph.query;
        entry.variables = graph.variables;
        entry.operation = graph.query?.includes("createPullRequest")
          ? "createPullRequest"
          : "query";
      }
      // Commit provider mutations before injecting a lost response, including DELETE.
      const owner = graph?.variables?.owner;
      const name = graph?.variables?.name;
      assert.ok(owner == null || typeof owner === "string", "invalid GraphQL owner");
      assert.ok(name == null || typeof name === "string", "invalid GraphQL repository name");
      const selectedResources =
        repositoryResources.find(
          ({ repo }) =>
            url.pathname === `/repos/${repo.full_name}` ||
            url.pathname.startsWith(`/repos/${repo.full_name}/`),
        ) ??
        (owner && name
          ? repositoryResources.find(({ repo }) => repo.full_name === `${owner}/${name}`)
          : resources);
      if (
        !selectedResources ||
        !authority.permitsRepository(request.headers.authorization, selectedResources.repo.id)
      ) {
        json(404, { message: "Not Found" });
        return;
      }
      const permissions = authority.permissions(request.headers.authorization);
      assert.ok(permissions, "no permissions for authorized credential");
      const result = graph
        ? selectedResources.dispatchGraphQL(graph, permissions)
        : selectedResources.dispatch({
            method: request.method,
            url,
            body,
            accept: request.headers.accept,
            permissions,
            ...(selectedResources === resources && {
              metadataResponse,
              draftResponse: (pull: CreatedPull) => {
                entry.forwardedOperationId = Object.hasOwn(request.headers, "x-oce-operation-id");
                entry.usedBearer = request.headers.authorization?.startsWith("Bearer ") === true;
                return draftResponse(pull);
              },
            }),
          });
      if (result.status === 204) {
        if (!disconnect(request, response, url)) {
          response.writeHead(204).end();
        }
        return;
      }
      if ("raw" in result && result.raw !== undefined) {
        response.writeHead(result.status, {
          "content-type": "text/plain; charset=utf-8",
          ...result.headers,
        });
        response.end(result.raw);
        return;
      }
      if ("body" in result) {
        json(result.status, result.body, result.headers);
      }
    } catch (error) {
      // Keep failure evidence safe: assertion values may include signing input.
      try {
        const name = error instanceof Error ? error.name : undefined;
        errors.push(typeof name === "string" ? name : "Error");
      } catch {
        // A callback can throw an Error whose name accessor also throws.
        errors.push("Error");
      }
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
    setRevokeStatus(status: number) {
      revokeStatus = status;
    },
    /**
     * Answer issue requests with this status and no token (201 issues again), or with this
     * raw body in place of minting.
     */
    setIssueStatus(status: number, body?: string | Buffer) {
      issueStatus = status;
      issueBody = body;
    },
    disconnectAfterMutation(method: string, target: string) {
      disconnectMutation = `${method} ${target}`;
    },
  };
}
