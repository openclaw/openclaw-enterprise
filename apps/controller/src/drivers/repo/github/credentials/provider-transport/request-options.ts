import type { RequestOptions } from "node:https";
import { isGitHubWireCredential } from "../wire-credential.ts";
import type { GitHubTokenProfile } from "../types.ts";
import { permissionsForProfile } from "../profiles.ts";

declare const scopeIdentity: unique symbol;
export type ProviderScope = Readonly<{ [scopeIdentity]: true }>;
type Scope = Readonly<{ origin: string; issuePath: string; issueBody: string }>;
const scopes = new WeakMap<ProviderScope, Scope>();

function numericId(value: string): number {
  if (typeof value !== "string") {
    throw new Error("invalid-provider-scope");
  }
  const number = Number(value);
  if (!/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(number)) {
    throw new Error("invalid-provider-scope");
  }
  return number;
}

export function prepareProviderScope(
  origin: string,
  scope: Readonly<{ installationId: string; repositoryId: string; profile: GitHubTokenProfile }>,
): ProviderScope {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) {
    throw new Error("invalid-provider-origin");
  }
  const { installationId, repositoryId: repository, profile } = scope;
  numericId(installationId);
  const repositoryId = numericId(repository);
  const ref = Object.freeze({}) as ProviderScope;
  scopes.set(
    ref,
    Object.freeze({
      origin,
      issuePath: `/app/installations/${installationId}/access_tokens`,
      issueBody: JSON.stringify({
        repository_ids: [repositoryId],
        permissions: permissionsForProfile(profile),
      }),
    }),
  );
  return ref;
}

export function providerRequestOptions(
  endpoint: ProviderScope,
  operation: "issue" | "revoke",
  authorization: string,
  ca: Uint8Array | undefined,
): Readonly<{ options: RequestOptions; body: string }> {
  const scope = scopes.get(endpoint);
  if (!scope || (operation !== "issue" && operation !== "revoke")) {
    throw new Error("invalid-provider-scope");
  }
  if (!isGitHubWireCredential(authorization)) {
    throw new Error("invalid-provider-credential");
  }
  const origin = new URL(scope.origin);
  const issue = operation === "issue";
  const body = issue ? scope.issueBody : "";
  return {
    body,
    options: {
      protocol: "https:",
      hostname: origin.hostname.replace(/^\[|\]$/g, ""),
      port: origin.port || 443,
      method: issue ? "POST" : "DELETE",
      path: issue ? scope.issuePath : "/installation/token",
      agent: false,
      rejectUnauthorized: true,
      maxHeaderSize: 32768,
      ...(ca ? { ca: Buffer.from(ca) } : {}),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${authorization}`,
        "user-agent": "openclaw-enterprise-repository-credentials",
        "x-github-api-version": "2026-03-10",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "accept-encoding": "identity",
        connection: "close",
      },
    },
  };
}
