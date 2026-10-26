import assert from "node:assert/strict";
import test from "node:test";
import { chmod, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  resolveGitHubRepositoryBinding,
  validateGitHubRepositoryRegistry,
} from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import { loadGitHubRepositoryRegistry } from "../../apps/controller/src/composition/repository-credentials/registry.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

function registryInput() {
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
  assert.equal(registry.repositories[0].repository, "example/application");
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
  reordered.repositories[0].namespaces
    .find((entry) => entry.namespaceId === "namespace-a")
    .profiles.reverse();
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
      value.repositories[0].repositoryId = "34568";
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
  })) {
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
  assert.throws(() => {
    registry.repositories[0].namespaces[0].profiles.push("git-read");
  }, TypeError);
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
  assert.equal(Object.hasOwn(registry().repositories[0].namespaces[0], "draftPullLimit"), false);
  policy.draftPullLimit = "none";
  assert.equal(registry().repositories[0].namespaces[0].draftPullLimit, "none");
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
  const resolvePolicy = (policy) => {
    const input = registryInput();
    input.repositories[0].namespaces[0].pushRefAllowlist = policy;
    const registry = validateGitHubRepositoryRegistry(input);
    return { registry, binding: resolveGitHubRepositoryBinding(registry, request) };
  };
  const first = resolvePolicy(["refs/heads/z", "refs/heads/agent/*", "refs/heads/z"]);
  const reordered = resolvePolicy(["refs/heads/agent/*", "refs/heads/z"]);
  assert.deepEqual(first.binding, reordered.binding);
  assert.deepEqual(first.registry.repositories[0].namespaces[0].pushRefAllowlist, [
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
    resolvePolicy(Array.from({ length: 40 }, (_, index) => `refs/heads/branch-${index}`)).registry
      .repositories[0].namespaces[0].pushRefAllowlist.length,
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
  })) {
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
  })) {
    await t.test(name, () => {
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
