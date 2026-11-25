import type { GitHubAppInstallationScope } from "@openclaw-enterprise/contracts";

import { parseJsonMembers } from "../../../json-members.ts";
import { providerClockSkewMs, tokenLifetimeMs } from "./driver/lifetime.ts";
import { isGitHubWireCredential } from "./wire-credential.ts";

type InstallationTokenScope =
  | { readonly kind: "inherited" }
  | {
      readonly kind: "selected";
      readonly permissions: Readonly<Record<string, string>>;
      readonly repositories: readonly { readonly id?: number; readonly name: string }[];
    };

/** Custody identification is independent of evidence that permits using the token. */
export function parseInstallationTokenResponse(body: Buffer): Readonly<{
  token: string | undefined;
  packet: Record<string, unknown> | undefined;
}> {
  try {
    let ambiguous = false;
    let ambiguousToken = false;
    const parsed = parseJsonMembers(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body),
      (name, depth) => {
        ambiguous = true;
        if (depth === 1 && name === "token") {
          ambiguousToken = true;
        }
      },
    );
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const packet = parsed as Record<string, unknown>;
      return {
        token:
          !ambiguousToken && typeof packet.token === "string" && packet.token.length > 0
            ? packet.token
            : undefined,
        packet: ambiguous ? undefined : packet,
      };
    }
  } catch {
    // Malformed bytes or grammar identify neither a credential nor scope evidence.
  }
  return { token: undefined, packet: undefined };
}

/** Validate after capture so even a rejected grant retains a cleanup owner. */
export function validateInstallationTokenResponse<Credential>(
  status: number,
  packet: Record<string, unknown> | undefined,
  credential: Credential | undefined,
  observedWallMs: number,
  scope: InstallationTokenScope,
  minimumValidityMs: number,
):
  | Readonly<{
      kind: "validated";
      credential: Credential;
      providerExpiresAt: number;
      usableUntil: number;
      repositories?: GitHubAppInstallationScope["repositories"];
    }>
  | Readonly<{ kind: "uncertain" }>
  | Readonly<{ kind: "reauthorization-required"; code: "authority-unavailable" }>
  | Readonly<{
      kind: "rejected";
      code: "scope-mismatch" | "invalid-response" | "insufficient-validity";
    }> {
  if ([401, 403, 404, 422].includes(status)) {
    return { kind: "reauthorization-required", code: "authority-unavailable" };
  }
  if (status !== 201 || credential === undefined) {
    return { kind: "uncertain" };
  }
  const expiry = typeof packet?.expires_at === "string" ? Date.parse(packet.expires_at) : NaN;
  const token = packet?.token;
  if (!isGitHubWireCredential(token)) {
    return { kind: "uncertain" };
  }
  const verifiedScope = packet && verifyIssuedScope(packet, scope);
  if (!verifiedScope) {
    return { kind: "rejected", code: "scope-mismatch" };
  }
  if (
    typeof packet?.expires_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(packet.expires_at) ||
    !Number.isFinite(observedWallMs) ||
    !Number.isFinite(expiry) ||
    expiry <= observedWallMs + providerClockSkewMs ||
    expiry > observedWallMs + tokenLifetimeMs + providerClockSkewMs
  ) {
    return { kind: "rejected", code: "invalid-response" };
  }
  if (expiry - observedWallMs - providerClockSkewMs < minimumValidityMs) {
    return { kind: "rejected", code: "insufficient-validity" };
  }
  return {
    kind: "validated",
    credential,
    providerExpiresAt: expiry,
    usableUntil: expiry - providerClockSkewMs,
    ...verifiedScope,
  };
}

function verifyIssuedScope(
  packet: Record<string, unknown>,
  scope: InstallationTokenScope,
): { repositories?: GitHubAppInstallationScope["repositories"] } | undefined {
  const { permissions, repositories, repository_selection: selection } = packet;
  const reported =
    permissions !== null && typeof permissions === "object" && !Array.isArray(permissions)
      ? Object.entries(permissions)
      : undefined;
  if (scope.kind === "inherited") {
    // The empty POST selects inheritance. GitHub's 201 requires only token and expires_at;
    // any returned permissions, selection or repositories describe the installation, not a local grant.
    const valid =
      (selection === undefined || selection === "all" || selection === "selected") &&
      (permissions === undefined ||
        (!!reported?.length &&
          reported.every(
            ([name, level]) =>
              /^[a-z][a-z0-9_]*$/.test(name) &&
              (level === "read" || level === "write" || level === "admin"),
          ))) &&
      (!Object.hasOwn(packet, "repositories") ||
        (Array.isArray(repositories) &&
          repositories.every(
            (repo) =>
              Number.isSafeInteger(repo?.id) &&
              repo.id > 0 &&
              typeof repo.full_name === "string" &&
              /^[^/\s]+\/[^/\s]+$/.test(repo.full_name),
          ) &&
          new Set(repositories.map((r) => r.id)).size === repositories.length &&
          new Set(repositories.map((r) => r.full_name.toLowerCase())).size ===
            repositories.length));
    return valid ? {} : undefined;
  }
  const expected = Object.entries(scope.permissions);
  const selected = scope.repositories;
  if (
    reported?.length !== expected.length ||
    !expected.every(([name, level]) => (permissions as Record<string, unknown>)[name] === level) ||
    (Object.hasOwn(packet, "repository_selection") && selection !== "selected") ||
    !Array.isArray(repositories) ||
    repositories.length !== selected.length
  ) {
    return undefined;
  }
  const byName = new Map<string, number>();
  const ids = new Set<number>();
  for (const repository of repositories) {
    if (
      !Number.isSafeInteger(repository?.id) ||
      repository.id <= 0 ||
      typeof repository.full_name !== "string"
    ) {
      return undefined;
    }
    const name = repository.full_name.toLowerCase();
    if (byName.has(name) || ids.has(repository.id)) {
      return undefined;
    }
    byName.set(name, repository.id);
    ids.add(repository.id);
  }
  const verifiedRepositories = [];
  for (const { id, name } of selected) {
    const reportedId = byName.get(name.toLowerCase());
    if (reportedId === undefined || (id !== undefined && reportedId !== id)) {
      return undefined;
    }
    verifiedRepositories.push({ repositoryId: String(reportedId), repository: name });
  }
  return {
    repositories: verifiedRepositories.sort(
      (left, right) => Number(left.repositoryId) - Number(right.repositoryId),
    ),
  };
}
