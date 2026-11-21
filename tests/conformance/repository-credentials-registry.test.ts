import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { chmod, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRevision, RepositoryRevisionState } from "@openclaw-enterprise/contracts";
import { controlledProtectedDriver } from "../fixtures/prepared-repository-git.mjs";
import {
  resolveGitHubRepositoryBinding,
  resolveGitHubStandingApprovalScope,
  createGitHubRepositoryDeliveryResolver,
  validateGitHubRepositoryRegistry,
} from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
import { loadGitHubRepositoryRegistry } from "../../apps/controller/src/composition/repository-credentials/registry.ts";
import { repositoryApprovalFingerprint } from "../../packages/occ/src/repository-approval.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { completeSandboxRevision } from "../integration/sandbox-driver-revision-fixture.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

interface NamespaceInput {
  namespaceId: string;
  profiles: string[];
  pushRefAllowlist?: unknown;
  transport?: "git-only" | "git-and-draft-pr";
  pullRequestBase?: string;
  draftPullLimit?: string | number | boolean | null;
  permissions?: Record<string, string>;
  allowStandingApproval?: true;
  token?: string;
}

interface RepositoryInput {
  repositoryRef: string;
  repositoryId: string;
  repository: string;
  namespaces: [NamespaceInput, ...NamespaceInput[]];
}

interface RegistryInput {
  version: number;
  backendId: string;
  providerInstanceId: string;
  appId: string;
  githubInstallationId: string;
  maximumDurationSeconds: number;
  allowStandingApprovals?: true;
  repositories: [RepositoryInput, ...RepositoryInput[]];
}

type RegistryMutation = (input: RegistryInput) => void;

function namespacePolicy(registry: ReturnType<typeof validateGitHubRepositoryRegistry>) {
  const policy = registry.repositories[0]?.namespaces[0];
  assert.ok(policy);
  return policy;
}

function registryInput(): RegistryInput {
  return {
    version: 1,
    backendId: "github-primary",
    providerInstanceId: "github-com-primary",
    appId: "12345",
    githubInstallationId: "67890",
    maximumDurationSeconds: 86400,
    repositories: [
      {
        repositoryRef: "application",
        repositoryId: "34567",
        repository: "Example/Application",
        namespaces: [
          { namespaceId: "namespace-a", profiles: ["git-write", "git-read", "git-full"] },
          { namespaceId: "namespace-b", profiles: ["git-read"] },
        ],
      },
    ],
  };
}

test("canonical registry fingerprints bind exact authority and the selected Namespace policy", async (t) => {
  const input = registryInput();
  const registry = validateGitHubRepositoryRegistry(input, "github-primary");
  const request = { namespaceId: "namespace-a", repositoryRef: "application" };
  const binding = resolveGitHubRepositoryBinding(registry, request);
  assert.equal(binding.profile, "git-write");
  assert.equal(binding.grant.repositoryId, "34567");
  const [firstRepository] = registry.repositories;
  assert.ok(firstRepository);
  const [firstPolicy] = firstRepository.namespaces;
  assert.ok(firstPolicy);
  assert.equal(firstRepository.repository, "example/application");
  assert.match(binding.grant.grantId, /^sha256:[a-f0-9]{64}$/);
  // Frozen pre-access-level digest for this same registry/default profile. Deploying
  // broader permission or capability semantics must invalidate the old admission.
  assert.notEqual(
    binding.grant.grantId,
    "sha256:fec4c807b7dbb4a2611d8201ba72d118addd28bdda270761216cc6ca7cb204f0",
  );

  // Input mutation, JSON property ordering, and policy list ordering cannot change a snapshot.
  input.repositories[0].namespaces[0].profiles.pop();
  assert.equal(
    resolveGitHubRepositoryBinding(registry, request).grant.grantId,
    binding.grant.grantId,
  );
  const reordered = registryInput();
  reordered.repositories[0].repository = "example/application";
  reordered.repositories[0].namespaces.reverse();
  const selectedPolicy = reordered.repositories[0].namespaces.find(
    (entry) => entry.namespaceId === "namespace-a",
  );
  assert.ok(selectedPolicy);
  selectedPolicy.profiles.reverse();
  assert.deepEqual(
    resolveGitHubRepositoryBinding(validateGitHubRepositoryRegistry(reordered), request),
    binding,
  );

  for (const [name, mutate] of Object.entries({
    "backend identity": (value) => {
      value.backendId = "another-backend";
    },
    "provider instance": (value) => {
      value.providerInstanceId = "another-instance";
    },
    "application identity": (value) => {
      value.appId = "12346";
    },
    "installation identity": (value) => {
      value.githubInstallationId = "67891";
    },
    "maximum duration": (value) => {
      value.maximumDurationSeconds = 3600;
    },
    "repository identity": (value) => {
      value.repositories[0].repositoryId = "34569";
    },
    "repository name": (value) => {
      value.repositories[0].repository = "example/renamed";
    },
    "selected Namespace profiles": (value) => {
      value.repositories[0].namespaces[0].profiles = ["git-write"];
    },
    "selected Namespace push refs": (value) => {
      value.repositories[0].namespaces[0].pushRefAllowlist = [];
    },
  } satisfies Record<string, RegistryMutation>)) {
    await t.test(name, () => {
      const changed = registryInput();
      mutate(changed);
      assert.notEqual(
        resolveGitHubRepositoryBinding(validateGitHubRepositoryRegistry(changed), request).grant
          .grantId,
        binding.grant.grantId,
      );
    });
  }
  assert.notEqual(
    resolveGitHubRepositoryBinding(registry, { ...request, profile: "git-read" }).grant.grantId,
    binding.grant.grantId,
  );
  assert.notEqual(
    resolveGitHubRepositoryBinding(registry, { ...request, profile: "git-read" }).grant.grantId,
    resolveGitHubRepositoryBinding(registry, {
      ...request,
      namespaceId: "namespace-b",
      profile: "git-read",
    }).grant.grantId,
  );
  // Exercise the runtime freeze when a JavaScript caller attempts to append a profile.
  const appendProfile: (this: readonly string[], profile: string) => number = Array.prototype.push;
  assert.throws(() => appendProfile.call(firstPolicy.profiles, "git-read"), TypeError);
});

test("Git-only registry policy binds its transport and exact ref before opening a session", () => {
  const input = registryInput();
  const policy = input.repositories[0].namespaces[0];
  policy.profiles = ["git-write"];
  const registry = () => validateGitHubRepositoryRegistry(input);
  const grant = () =>
    resolveGitHubRepositoryBinding(registry(), {
      namespaceId: "namespace-a",
      repositoryRef: "application",
    }).grant.grantId;
  policy.pushRefAllowlist = ["refs/heads/review/exact"];
  const legacyGrant = grant();
  policy.transport = "git-only";
  const scopedGrant = grant();
  assert.notEqual(scopedGrant, legacyGrant, "legacy client-only ref policy is not the same grant");
  policy.pushRefAllowlist = [];
  assert.notEqual(grant(), scopedGrant, "ref authorization is bound to the grant");
  delete policy.pushRefAllowlist;
  assert.throws(
    registry,
    /invalid-repository-registry/,
    "a Git-only policy requires explicit refs",
  );
  policy.pushRefAllowlist = [];
  policy.profiles = ["git-full"];
  assert.throws(
    registry,
    /invalid-repository-registry/,
    "Git-only cannot silently widen a profile",
  );
});

test("a draft policy's operator opt-out of the one-draft limit is its own grant", () => {
  // Finding 2147 (owner 10-20): an operator may drop the one-draft-per-grant limit for one
  // namespace's draft policy. The default stays enforced and keeps its grant; the opt-out
  // changes the grant, and only a draft transport accepts it.
  const input = registryInput();
  const policy = input.repositories[0].namespaces[0];
  policy.profiles = ["git-write"];
  policy.pushRefAllowlist = ["refs/heads/review/exact"];
  policy.transport = "git-and-draft-pr";
  policy.pullRequestBase = "main";
  const registry = () => validateGitHubRepositoryRegistry(input);
  const grant = () =>
    resolveGitHubRepositoryBinding(registry(), {
      namespaceId: "namespace-a",
      repositoryRef: "application",
    }).grant.grantId;
  const enforced = grant();
  policy.draftPullLimit = "one-per-grant";
  assert.equal(grant(), enforced, "the explicit default is the same grant");
  assert.equal(Object.hasOwn(namespacePolicy(registry()), "draftPullLimit"), false);
  policy.draftPullLimit = "none";
  assert.equal(namespacePolicy(registry()).draftPullLimit, "none");
  assert.notEqual(grant(), enforced, "the opt-out is a new grant");
  for (const value of ["", "unlimited", false, null, 2]) {
    policy.draftPullLimit = value;
    assert.throws(registry, /invalid-repository-registry/, String(value));
  }
  policy.draftPullLimit = "none";
  policy.transport = "git-only";
  delete policy.pullRequestBase;
  assert.throws(registry, /invalid-repository-registry/, "a Git-only policy has no drafts");
  delete policy.transport;
  assert.throws(registry, /invalid-repository-registry/, "nor does a legacy policy");
});

test("push-ref policy normalizes branch refs and changes grant identity", () => {
  const request = { namespaceId: "namespace-a", repositoryRef: "application" };
  const resolvePolicy = (policy: unknown) => {
    const input = registryInput();
    input.repositories[0].namespaces[0].pushRefAllowlist = policy;
    const registry = validateGitHubRepositoryRegistry(input);
    return { registry, binding: resolveGitHubRepositoryBinding(registry, request) };
  };
  const first = resolvePolicy(["refs/heads/z", "refs/heads/agent/*", "refs/heads/z"]);
  const reordered = resolvePolicy(["refs/heads/agent/*", "refs/heads/z"]);
  assert.deepEqual(first.binding, reordered.binding);
  assert.deepEqual(namespacePolicy(first.registry).pushRefAllowlist, [
    "refs/heads/agent/*",
    "refs/heads/z",
  ]);
  assert.notEqual(resolvePolicy([]).binding.grant.grantId, first.binding.grant.grantId);
  assert.notEqual(
    resolvePolicy([]).binding.grant.grantId,
    resolveGitHubRepositoryBinding(validateGitHubRepositoryRegistry(registryInput()), request).grant
      .grantId,
  );
  assert.ok(resolvePolicy(["refs/heads/*"]).binding.grant.grantId);
  assert.equal(
    namespacePolicy(
      resolvePolicy(Array.from({ length: 40 }, (_, index) => `refs/heads/branch-${index}`))
        .registry,
    ).pushRefAllowlist?.length,
    40,
  );
  assert.ok(resolvePolicy(["refs/heads/" + "a/".repeat(150) + "branch"]).binding.grant.grantId);
  for (const invalid of [
    null,
    "refs/heads/main",
    ["main"],
    ["refs/tags/v1"],
    ["refs/heads/"],
    ["refs/heads/a*"],
    ["refs/heads/a/**"],
    ["refs/heads/a/../b"],
    ["refs/heads/.hidden"],
    ["refs/heads/a.lock"],
    ["refs/heads/a@{b"],
    ["refs/heads/a\nb"],
    ["refs/heads/a b"],
    ["refs/heads/a?"],
    ["refs/heads/a//b"],
  ]) {
    assert.throws(() => resolvePolicy(invalid), /invalid-repository-registry/);
  }
});

test("registry refuses ambiguous repositories, wildcard policy, unsupported profiles and noncanonical IDs", async (t) => {
  for (const [name, mutate] of Object.entries({
    "leading-zero application ID": (value) => {
      value.appId = "01";
    },
    "unsafe installation ID": (value) => {
      value.githubInstallationId = "9007199254740992";
    },
    "zero repository ID": (value) => {
      value.repositories[0].repositoryId = "0";
    },
    "ambiguous repository path": (value) => {
      value.repositories[0].repository = "example/release..archive";
    },
    "wildcard Namespace": (value) => {
      value.repositories[0].namespaces[0].namespaceId = "*";
    },
    "unsupported profile": (value) => {
      value.repositories[0].namespaces[0].profiles = ["app-full"];
    },
    "duplicate profile": (value) => {
      value.repositories[0].namespaces[0].profiles = ["git-read", "git-read"];
    },
    "duplicate Namespace policy": (value) => {
      value.repositories[0].namespaces.push(value.repositories[0].namespaces[0]);
    },
    "aliased repository identity": (value) => {
      value.repositories.push({ ...value.repositories[0], repositoryRef: "alias" });
    },
    "duplicate repository reference": (value) => {
      value.repositories.push({
        ...value.repositories[0],
        repositoryId: "44",
        repository: "example/other",
      });
    },
    "unexpected policy field": (value) => {
      value.repositories[0].namespaces[0].token = "unexpected";
    },
    "infinite maximum duration": (value) => {
      value.maximumDurationSeconds = Infinity;
    },
  } satisfies Record<string, RegistryMutation>)) {
    await t.test(name, () => {
      const input = registryInput();
      mutate(input);
      assert.throws(() => validateGitHubRepositoryRegistry(input), /invalid-repository-registry/);
    });
  }
  assert.throws(
    () => validateGitHubRepositoryRegistry(registryInput(), "another-backend"),
    /invalid-repository-registry/,
  );
  const registry = validateGitHubRepositoryRegistry(registryInput());
  // A well-formed request outside the registry's policy is not authorized; a malformed
  // profile is refused by the registry's profile validation before any policy lookup.
  const notAuthorized = /repository-binding-not-authorized/;
  const invalidProfile = /invalid-repository-registry/;
  for (const [name, [request, expected]] of Object.entries({
    "default write profile outside Namespace policy": [
      { namespaceId: "namespace-b", repositoryRef: "application" },
      notAuthorized,
    ],
    "unknown repository reference": [
      { namespaceId: "namespace-a", repositoryRef: "missing" },
      notAuthorized,
    ],
    "Namespace without a policy": [
      { namespaceId: "namespace-c", repositoryRef: "application", profile: "git-read" },
      notAuthorized,
    ],
    "unsupported selected profile": [
      { namespaceId: "namespace-a", repositoryRef: "application", profile: "app-full" },
      invalidProfile,
    ],
    "explicit null profile": [
      { namespaceId: "namespace-a", repositoryRef: "application", profile: null },
      invalidProfile,
    ],
  } satisfies Record<
    string,
    [
      request: { namespaceId: string; repositoryRef: string; profile?: string | null },
      expected: RegExp,
    ]
  >)) {
    await t.test(name, () => {
      // @ts-expect-error Null is deliberately sent through the runtime profile validator.
      assert.throws(() => resolveGitHubRepositoryBinding(registry, request), expected);
    });
  }
});

test("registry loader accepts a bounded projected regular file and rejects unsafe file contents", async (t) => {
  const directory = await temporaryDirectory(t, "repository-registry-");
  const file = join(directory, "registry.json");
  const projected = join(directory, "projected.json");
  await writeFile(file, JSON.stringify(registryInput()), { mode: 0o644 });
  await symlink(file, projected);
  assert.equal(
    (await loadGitHubRepositoryRegistry(projected, "github-primary")).backendId,
    "github-primary",
  );
  await assert.rejects(
    loadGitHubRepositoryRegistry(projected, "wrong-provider"),
    /invalid-repository-registry/,
  );
  await chmod(file, 0o666);
  await assert.rejects(
    loadGitHubRepositoryRegistry(projected, "github-primary"),
    /invalid-repository-registry/,
  );
  await chmod(file, 0o644);
  const validJson = JSON.stringify(registryInput());
  await writeFile(file, validJson.padEnd(256 * 1024 + 1, " "));
  await assert.rejects(
    loadGitHubRepositoryRegistry(projected, "github-primary"),
    /invalid-repository-registry/,
  );
  await assert.rejects(
    loadGitHubRepositoryRegistry(directory, "github-primary"),
    /invalid-repository-registry/,
  );
});

test("selected repository standing approval binds permissions and rechecks delivery policy", () => {
  const input = registryInput();
  input.allowStandingApprovals = true;
  input.repositories[0].namespaces = [
    {
      namespaceId: "namespace-a",
      profiles: ["github-repository"],
      permissions: { pull_requests: "write", metadata: "read", contents: "write" },
      allowStandingApproval: true,
    },
  ];
  input.repositories.push({
    ...structuredClone(input.repositories[0]),
    repositoryRef: "second",
    repositoryId: "34568",
    repository: "example/second",
  });
  const registry = validateGitHubRepositoryRegistry(input);
  const request = { namespaceId: "namespace-a", repositoryRef: "application" };
  const binding = resolveGitHubRepositoryBinding(registry, request);
  const scopeInput = { namespaceId: request.namespaceId, binding };
  const scope = resolveGitHubStandingApprovalScope(registry, scopeInput);
  assert.ok(scope);
  assert.equal(scope.repositorySelection, "repository");
  assert.equal(scope.repositoryId, "34567");
  assert.equal(scope.repository, "example/application");
  assert.deepEqual(scope.apiPermissions, {
    contents: "write",
    metadata: "read",
    pull_requests: "write",
  });
  const sandboxDriverId = controlledProtectedDriver.id;
  const base = completeSandboxRevision({
    id: `rev_${randomUUID()}`,
    namespaceId: request.namespaceId,
    agentId: `agt_${randomUUID()}`,
    sandboxDriverId,
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
  });
  const admittedAt = Date.now();
  const finiteState: RepositoryRevisionState = {
    driver: { id: "repository-credentials", implementation: "github" },
    deadlineWallMs: admittedAt + 3_600_000,
    bindings: [binding],
  };
  const nativeConfiguration: (harness: "codex", model: string) => AgentRevision["configuration"] =
    createHarnessConfiguration;
  // The persisted revision and its protected Git plan carry the same admitted grant.
  const deliveryRevision = (repositoryCredentials: RepositoryRevisionState): AgentRevision => ({
    ...base,
    createdAt: new Date(admittedAt).toISOString(),
    configuration: nativeConfiguration("codex", "gpt-5.1"),
    repositoryCredentials,
    executionAdmission: { version: 5, mode: "protected" },
    egressPlan: {
      id: randomUUID(),
      generation: 1,
      driver: controlledProtectedDriver,
      sandboxDriverId,
      egressDriverId: sandboxDriverId,
      execution: {
        installationId: "installation",
        namespaceId: base.namespaceId,
        agentId: base.agentId,
        servicePrincipalId: base.servicePrincipalId,
        revisionId: base.id,
        executionId: randomUUID().replaceAll("-", ""),
      },
      repositoryGit: repositoryCredentials,
      repositoryGitAuthorization: "online-request",
      routes: [],
    },
  });
  const standingState = {
    ...finiteState,
    standingApprovalId: "approval",
    standingApprovalGeneration: 1,
    standingApprovalScopeFingerprint: repositoryApprovalFingerprint({
      namespaceId: base.namespaceId,
      agentId: base.agentId,
      binding,
      scope,
    }),
  };
  const revision = deliveryRevision(standingState);
  assert.deepEqual(createGitHubRepositoryDeliveryResolver(registry)(revision).delivery, {
    scope: "github-repository",
    installationId: "67890",
    repositories: [{ repositoryId: "34567", repository: "example/application" }],
    permissions: scope.apiPermissions,
  });
  const enabled = structuredClone(input);
  Object.assign(enabled.repositories[0].namespaces[0], { scopedRest: "v1" });
  const optedIn = validateGitHubRepositoryRegistry(enabled);
  assert.equal(resolveGitHubStandingApprovalScope(optedIn, scopeInput), undefined);
  assert.throws(
    () => createGitHubRepositoryDeliveryResolver(optedIn)(deliveryRevision(finiteState)),
    /selected-repository-grant-changed/,
  );
  const v1Binding = resolveGitHubRepositoryBinding(optedIn, request);
  assert.notEqual(v1Binding.grant.grantId, binding.grant.grantId);

  // Changing only the REST version requires a fresh binding and approval.
  const upgraded = structuredClone(enabled);
  const registration = upgraded.repositories[0].namespaces[0];
  Object.assign(registration, { scopedRest: "v2" });
  const v2Registry = validateGitHubRepositoryRegistry(upgraded);
  const v2Binding = resolveGitHubRepositoryBinding(v2Registry, request);
  assert.notEqual(v2Binding.grant.grantId, v1Binding.grant.grantId);
  const v1ScopeInput = { ...scopeInput, binding: v1Binding };
  assert.ok(resolveGitHubStandingApprovalScope(optedIn, v1ScopeInput));
  assert.equal(resolveGitHubStandingApprovalScope(v2Registry, v1ScopeInput), undefined);
  assert.throws(
    () =>
      createGitHubRepositoryDeliveryResolver(v2Registry)(
        deliveryRevision({ ...finiteState, bindings: [v1Binding] }),
      ),
    /selected-repository-grant-changed/,
  );
  Object.assign(registration, { scopedRest: "v3" });
  assert.throws(() => validateGitHubRepositoryRegistry(upgraded), /invalid-repository-registry/);

  const reordered = structuredClone(input);
  reordered.repositories[0].namespaces[0].permissions = {
    contents: "write",
    metadata: "read",
    pull_requests: "write",
  };
  assert.deepEqual(
    resolveGitHubStandingApprovalScope(validateGitHubRepositoryRegistry(reordered), scopeInput),
    scope,
    "permission order cannot invalidate the same reviewed authority",
  );
  for (const mutate of [
    (value) => {
      delete value.allowStandingApprovals;
    },
    (value) => {
      delete value.repositories[0].namespaces[0].allowStandingApproval;
    },
  ] satisfies RegistryMutation[]) {
    const withdrawn = structuredClone(input);
    mutate(withdrawn);
    const current = validateGitHubRepositoryRegistry(withdrawn);
    assert.deepEqual(resolveGitHubRepositoryBinding(current, request), binding);
    assert.equal(resolveGitHubStandingApprovalScope(current, scopeInput), undefined);
    assert.throws(
      () => createGitHubRepositoryDeliveryResolver(current)(revision),
      /Standing repository policy/,
    );
    assert.doesNotThrow(
      () => createGitHubRepositoryDeliveryResolver(current)(deliveryRevision(finiteState)),
      "withdrawing standing permission does not reject an independent finite grant",
    );
  }
  for (const mutate of [
    (value) => {
      const policy = value.repositories[0].namespaces[0];
      assert.ok(policy.permissions);
      policy.permissions.contents = "read";
    },
    (value) => {
      value.repositories[0].repositoryId = "34569";
    },
    (value) => {
      value.repositories[0].repository = "example/renamed";
    },
  ] satisfies RegistryMutation[]) {
    const changed = structuredClone(input);
    mutate(changed);
    const current = validateGitHubRepositoryRegistry(changed);
    assert.equal(resolveGitHubStandingApprovalScope(current, scopeInput), undefined);
    assert.throws(
      () => createGitHubRepositoryDeliveryResolver(current)(revision),
      /Standing repository policy/,
    );
  }
  assert.throws(
    () =>
      createGitHubRepositoryDeliveryResolver(registry)(
        deliveryRevision({ ...standingState, bindings: [binding, binding] }),
      ),
    /Standing repository policy/,
    "standing approval never authorizes multiple bindings",
  );
});
