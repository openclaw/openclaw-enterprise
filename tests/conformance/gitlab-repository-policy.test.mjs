import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveGitLabRepositoryBinding,
  resolveGitLabStandingApprovalScope,
  validateGitLabRepositoryRegistry,
} from "../../apps/controller/src/drivers/repo/gitlab/credentials/registry.ts";
import { createGitLabGrantIdentity } from "../../apps/controller/src/drivers/repo/gitlab/credentials/grants.ts";
import { GitLabRepositoryPolicy } from "../../apps/controller/src/drivers/repo/gitlab/policy.ts";

const registry = {
  version: 1,
  backendId: "gitlab",
  providerInstanceId: "acme-repo",
  configVersion: "1",
  maximumDurationSeconds: 3600,
  projects: [
    {
      projectId: "88516404",
      path: "rmcook84/test",
      displayName: "rmcook84/test",
      namespaces: [
        {
          namespaceId: "ns_1",
          profiles: ["git-read", "git-write"],
          pushRefAllowlist: ["refs/heads/*"],
          allowStandingApproval: true,
        },
      ],
    },
    {
      projectId: "88516405",
      path: "rmcook84/other",
      namespaces: [{ namespaceId: "ns_2", profiles: ["git-read"], pushRefAllowlist: [] }],
    },
  ],
};

test("a GitLab registry is canonical, numeric, and Namespace bounded", () => {
  const validated = validateGitLabRepositoryRegistry(registry, "gitlab");
  assert.equal(validated.projects.length, 2);
  assert.deepEqual(validated.projects[0].namespaces[0].profiles, ["git-read", "git-write"]);
  for (const refused of [
    { ...registry, backendId: "other" },
    { ...registry, projects: [] },
    { ...registry, projects: [{ ...registry.projects[0], path: "rmcook84/test/" }] },
    { ...registry, projects: [{ ...registry.projects[0], projectId: "0" }] },
    { ...registry, projects: [{ ...registry.projects[0], namespaces: [] }] },
    {
      ...registry,
      projects: [
        {
          ...registry.projects[0],
          namespaces: [{ ...registry.projects[0].namespaces[0], profiles: ["merge"] }],
        },
      ],
    },
    {
      ...registry,
      projects: [
        {
          ...registry.projects[0],
          namespaces: [registry.projects[0].namespaces[0], registry.projects[0].namespaces[0]],
        },
      ],
    },
    { ...registry, projects: [registry.projects[0], registry.projects[0]] },
    { ...registry, host: "gitlab.com" },
    { ...registry, maximumDurationSeconds: 0 },
  ]) {
    assert.throws(
      () => validateGitLabRepositoryRegistry(refused, "gitlab"),
      /invalid-repository-registry/,
      JSON.stringify(refused),
    );
  }
});

test("binding resolution admits only approved Namespace projects and profiles", () => {
  const validated = validateGitLabRepositoryRegistry(registry, "gitlab");
  const binding = resolveGitLabRepositoryBinding(validated, {
    namespaceId: "ns_1",
    repositoryRef: "88516404",
    profile: "git-write",
  });
  assert.equal(binding.repositoryRef, "88516404");
  assert.equal(binding.backendId, "gitlab");
  assert.deepEqual(
    binding.grant,
    createGitLabGrantIdentity({
      authority: "gitlab-token",
      configVersion: "1",
      providerInstanceId: "acme-repo",
      projectId: "88516404",
      project: "rmcook84/test",
      namespaceId: "ns_1",
      profile: "git-write",
      pushRefAllowlist: ["refs/heads/*"],
    }),
  );
  assert.throws(
    () =>
      resolveGitLabRepositoryBinding(validated, {
        namespaceId: "ns_2",
        repositoryRef: "88516404",
        profile: "git-read",
      }),
    /invalid-repository-registry/,
  );
  assert.throws(
    () =>
      resolveGitLabRepositoryBinding(validated, {
        namespaceId: "ns_1",
        repositoryRef: "88516405",
        profile: "git-read",
      }),
    /invalid-repository-registry/,
  );
  assert.throws(
    () =>
      resolveGitLabRepositoryBinding(validated, {
        namespaceId: "ns_2",
        repositoryRef: "88516405",
        profile: "git-write",
      }),
    /invalid-repository-registry/,
  );
});

test("the policy lists and resolves only the Namespace's projects", async () => {
  const policy = new GitLabRepositoryPolicy({ driverId: "gitlab", backendId: "gitlab" }, registry, {
    sessionDurationSeconds: 1800,
  });
  const options = await policy.listOptions({ namespaceId: "ns_1" });
  assert.deepEqual(options.options, [
    {
      repositoryRef: "88516404",
      displayName: "rmcook84/test",
      allowedProfiles: ["git-read", "git-write"],
    },
  ]);
  const otherOptions = await policy.listOptions({ namespaceId: "ns_2" });
  assert.deepEqual(otherOptions.options, [
    {
      repositoryRef: "88516405",
      displayName: "rmcook84/other",
      allowedProfiles: ["git-read"],
    },
  ]);
  const resolved = policy.resolve({
    namespaceId: "ns_1",
    bindings: [{ repositoryRef: "88516404", profile: "git-read" }],
  });
  assert.equal(resolved.sessionDurationSeconds, 1800);
  assert.equal(resolved.bindings[0].grant.repositoryId, "88516404");
  assert.throws(
    () =>
      policy.resolve({
        namespaceId: "ns_2",
        bindings: [{ repositoryRef: "88516404", profile: "git-read" }],
      }),
    (error) => error.name === "ScopeViolationError",
  );
  assert.throws(
    () =>
      policy.resolve({
        namespaceId: "ns_1",
        bindings: [
          { repositoryRef: "88516404", profile: "git-read" },
          { repositoryRef: "88516404", profile: "git-read" },
        ],
      }),
    (error) => error.name === "ScopeViolationError",
  );
});

test("standing approvals follow the Namespace opt-in and approved binding", () => {
  const validated = validateGitLabRepositoryRegistry(registry, "gitlab");
  const binding = resolveGitLabRepositoryBinding(validated, {
    namespaceId: "ns_1",
    repositoryRef: "88516404",
    profile: "git-write",
  });
  assert.deepEqual(
    resolveGitLabStandingApprovalScope(validated, { namespaceId: "ns_1", binding }),
    {
      providerInstanceId: "acme-repo",
      projectId: "88516404",
      project: "rmcook84/test",
      profile: "git-write",
    },
  );
  const withoutOptIn = validateGitLabRepositoryRegistry(
    {
      ...registry,
      projects: [
        {
          ...registry.projects[0],
          namespaces: [{ ...registry.projects[0].namespaces[0], allowStandingApproval: undefined }],
        },
        registry.projects[1],
      ],
    },
    "gitlab",
  );
  assert.equal(
    resolveGitLabStandingApprovalScope(withoutOptIn, { namespaceId: "ns_1", binding }),
    undefined,
  );
  const otherBinding = resolveGitLabRepositoryBinding(withoutOptIn, {
    namespaceId: "ns_2",
    repositoryRef: "88516405",
    profile: "git-read",
  });
  assert.equal(
    resolveGitLabStandingApprovalScope(withoutOptIn, {
      namespaceId: "ns_2",
      binding: otherBinding,
    }),
    undefined,
  );
});

test("the composed routes' GitLab request helpers stay within the provider intent", async () => {
  const { draftMergeRequestRequest, refuseGitLabQuickActions } =
    await import("../../apps/controller/src/drivers/repo/gitlab/client.ts");
  // Notes and descriptions are data, never commands: a quick action can merge or approve.
  for (const value of ["/ready", "  /merge", "comment\n/close"]) {
    assert.throws(
      () => refuseGitLabQuickActions(value, "merge request note"),
      /must not contain a quick action line/,
      value,
    );
  }
  // A slash inside a sentence is not a command line.
  assert.equal(
    refuseGitLabQuickActions("See docs/runbook.md", "merge request note"),
    "See docs/runbook.md",
  );
  // A draft request names the two branches the route policy admitted; it never pushes or forks.
  const draft = draftMergeRequestRequest({
    sourceBranch: "agent/work",
    targetBranch: "main",
    title: "Release notes",
  });
  assert.equal(draft.method, "POST");
  assert.equal(draft.path, "/merge_requests");
  assert.equal(draft.body.source_branch, "agent/work");
  assert.equal(draft.body.target_branch, "main");
  assert.equal(draft.body.title, "Draft: Release notes");
});
