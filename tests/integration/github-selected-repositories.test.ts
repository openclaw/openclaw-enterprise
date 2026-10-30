import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareProviderScope,
  providerRequestOptions,
} from "../../apps/controller/src/drivers/repo/github/credentials/provider-transport/request-options.ts";
import { validateInstallationTokenResponse } from "../../apps/controller/src/drivers/repo/github/credentials/installation-token-response.ts";

const grant = {
  id: "selected-grant",
  isolationId: "revision-a",
  appId: "10",
  installationId: "20",
  profile: "github-repository" as const,
  repositories: [
    { repositoryId: "101", repository: "team/a" },
    { repositoryId: "102", repository: "team/b" },
  ],
  permissions: { metadata: "read", contents: "write", pull_requests: "write" },
};

test("selected repository issuance sends every selected stable ID and explicit permissions", () => {
  const scope = prepareProviderScope("https://api.github.com", grant);
  const request = providerRequestOptions(scope, "issue", "fixture-jwt", undefined);
  assert.deepEqual(JSON.parse(request.body), {
    repository_ids: [101, 102],
    permissions: grant.permissions,
  });
  assert.equal(request.options.path, "/app/installations/20/access_tokens");
  for (const repositories of [
    [],
    [grant.repositories[0], grant.repositories[0]],
    [{ repositoryId: "0", repository: "team/a" }],
  ]) {
    assert.throws(
      () =>
        prepareProviderScope("https://api.github.com", { ...grant, repositories } as typeof grant),
      /invalid-github-repository-grant/,
    );
  }
});

test("selected repository response requires exact IDs, names and permissions and refuses broader credentials", () => {
  const now = Date.now();
  const packet = {
    token: "ghs_" + "a".repeat(36),
    expires_at: new Date(now + 3600000).toISOString(),
    repositories: [
      { id: 102, full_name: "team/b" },
      { id: 101, full_name: "team/a" },
    ],
    permissions: grant.permissions,
  };
  const check = (candidate: Record<string, unknown>) =>
    validateInstallationTokenResponse(201, candidate, Buffer.from(packet.token), now, {
      ...grant,
      minimumValidityMs: 60000,
    });
  assert.equal(check(packet).kind, "validated");
  assert.equal(check({ ...packet, repository_selection: "selected" }).kind, "validated");
  for (const candidate of [
    { ...packet, repository_selection: "all" },
    { ...packet, repositories: undefined },
    { ...packet, repositories: [packet.repositories[0]] },
    { ...packet, repositories: [packet.repositories[0], packet.repositories[0]] },
    { ...packet, repositories: [...packet.repositories, { id: 103, full_name: "team/c" }] },
    { ...packet, repositories: [{ id: 101, full_name: "team/renamed" }, packet.repositories[0]] },
    { ...packet, permissions: { ...packet.permissions, administration: "write" } },
  ]) {
    assert.equal(check(candidate).kind, "rejected");
  }
});

import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import {
  validateGitHubRepositoryRegistry,
  resolveSelectedRepositoryGrant,
} from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";

test("ordinary fresh selections resolve one or N repositories without broadening explicit historical grants", () => {
  const registry = validateGitHubRepositoryRegistry(
    {
      version: 1,
      backendId: "github",
      providerInstanceId: "github",
      appId: "10",
      githubInstallationId: "20",
      maximumDurationSeconds: 3600,
      repositories: ["a", "b"].map((name, index) => ({
        repositoryRef: name,
        repositoryId: String(101 + index),
        repository: "team/" + name,
        namespaces: [
          { namespaceId: "team", profiles: ["github-repository"], permissions: grant.permissions },
        ],
      })),
    },
    "github",
  );
  const permissions = registry.repositories[0]!.namespaces[0]!.permissions!;
  assert.notEqual(permissions, grant.permissions);
  assert.equal(Object.isFrozen(permissions), true);
  assert.deepEqual(permissions, grant.permissions);
  assert.deepEqual(Object.keys(permissions), ["contents", "metadata", "pull_requests"]);
  assert.equal(Object.isFrozen(grant.permissions), false);
  assert.deepEqual(Object.keys(grant.permissions), ["metadata", "contents", "pull_requests"]);
  assert.deepEqual(grant.permissions, {
    metadata: "read",
    contents: "write",
    pull_requests: "write",
  });
  const policy = new GitHubRepositoryPolicy({ driverId: "github", backendId: "github" }, registry, {
    sessionDurationSeconds: 600,
  });
  for (const refs of [["a"], ["b", "a"]]) {
    const resolved = policy.resolve({
      namespaceId: "team",
      bindings: refs.map((repositoryRef) => ({ repositoryRef })),
    });
    assert.ok(resolved.bindings.every((b) => b.profile === "github-repository"));
    const scope = resolveSelectedRepositoryGrant(registry, "team", "revision", resolved.bindings);
    assert.deepEqual(
      scope.repositories.map((r) => r.repositoryId),
      refs.length === 1 ? ["101"] : ["101", "102"],
    );
    assert.throws(
      () =>
        resolveSelectedRepositoryGrant(
          { ...registry, repositories: [] },
          "team",
          "revision",
          resolved.bindings,
        ),
      /repository-binding-not-authorized/,
    );
    assert.throws(
      () => resolveSelectedRepositoryGrant(registry, "other-team", "revision", resolved.bindings),
      /repository-binding-not-authorized/,
    );
  }
  assert.throws(
    () =>
      policy.resolve({
        namespaceId: "team",
        bindings: [{ repositoryRef: "a", profile: "git-write" }],
      }),
    { name: "ScopeViolationError" },
  );
});
