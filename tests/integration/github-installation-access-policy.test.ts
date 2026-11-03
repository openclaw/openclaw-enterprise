import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import {
  githubInstallationProfile as profile,
  repositoryGitProfileAvailable,
  type CredentialSourceControl,
  type RepositoryGitRecipient,
} from "../../packages/contracts/src/index.ts";
import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import { signComputeExecutionRelease } from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import { validateGitHubRepositoryRegistry as registry } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import { normalizedRepositoryAccess } from "../../packages/occ/src/state/repository-credential-state.ts";

// Runtime policy decisions cannot detect accidental widening of this constructor input.
// @ts-expect-error Repository policy receives identity fields, never a transport client.
type _PolicyTransport = ConstructorParameters<typeof GitHubRepositoryPolicy>[0]["client"];

const namespaceId = "first";
const repositoryRef = "team-installation";
const policy = { namespaceId, accessMode: "installation" };
const registration = {
  version: 1,
  backendId: "repo-driver",
  providerInstanceId: "github-test",
  appId: "123",
  githubInstallationId: "456",
  maximumDurationSeconds: 600,
  repositories: [
    {
      repositoryRef: "example",
      repositoryId: "789",
      repository: "example/private",
      namespaces: [
        {
          namespaceId,
          profiles: ["git-write"],
          allowStandingApproval: true,
          transport: "git-only",
          pushRefAllowlist: ["refs/heads/review"],
        },
      ],
    },
  ],
};
function config(namespacePolicy: unknown, options = {}) {
  return {
    ...registration,
    ...options,
    installationAccess: { repositoryRef, namespaces: [namespacePolicy] },
  };
}
function driver(options: unknown) {
  return new GitHubRepositoryPolicy(
    { driverId: "repo", backendId: registration.backendId },
    registry(options),
    { sessionDurationSeconds: 600 },
  );
}

test("policy validates the registry against the selected Backend", () => {
  const build = (owner: ConstructorParameters<typeof GitHubRepositoryPolicy>[0], duration = 600) =>
    new GitHubRepositoryPolicy(owner, registry(config(policy)), {
      sessionDurationSeconds: duration,
    });
  const selected = { driverId: "selected-repo", backendId: registration.backendId };
  assert.equal(build(selected).id, selected.driverId);
  assert.throws(
    () => build({ ...selected, backendId: "another-backend" }),
    /invalid-repository-registry/,
  );
  // An untyped caller must not disable the registry validator's optional expected-ID check.
  // @ts-expect-error The selected Backend is required.
  assert.throws(() => build({ driverId: selected.driverId }), /owning Backend/);
  for (const driverId of ["", "bad\nidentity", "é".repeat(257)]) {
    assert.throws(() => build({ ...selected, driverId }), /repository policy Driver/);
  }
  assert.throws(() => build(selected, 601), /session duration exceeds/);
});

test("only explicit Namespace and Agent selections allow GitHub installation scope", async () => {
  const options = config(policy);
  const repo = driver(options);
  const selection = { repositoryRef, profile };
  for (const extra of [
    { accessMode: undefined },
    { accessMode: "repository" },
    { profiles: ["git-write"] },
    { pushRefAllowlist: [] },
    { pullRequestBase: "main" },
    { draftPullLimit: "none" },
    { repositoryId: "789" },
    { repository: "example/private" },
    { permissions: {} },
  ]) {
    assert.throws(() => registry(config({ ...policy, ...extra })), /invalid-repository-registry/);
  }
  assert.throws(
    () =>
      registry({
        ...options,
        installationAccess: {
          ...options.installationAccess,
          repositoryRef: registration.repositories[0]!.repositoryRef,
        },
      }),
    /invalid-repository-registry/,
    "the installation must have a distinct selection",
  );
  const resolve = (
    bindings: { repositoryRef: string; profile?: string }[],
    namespace = namespaceId,
  ) => repo.resolve({ namespaceId: namespace, bindings }).bindings[0]!;
  for (const old of [undefined, "git-write", "git-full", "*"]) {
    assert.throws(
      () => resolve([{ repositoryRef, ...(old && { profile: old }) }]),
      /not permitted/,
    );
  }
  assert.throws(() => resolve([selection], "another"), /not permitted/);
  assert.throws(() => resolve([{ ...selection, repositoryRef: "example" }]), /not permitted/);
  assert.throws(
    () =>
      normalizedRepositoryAccess({ defaultProfile: profile, repositories: [{ repositoryRef }] }, [
        selection,
      ]),
    /intent does not match/,
  );
  const intent = { defaultProfile: "git-write", repositories: [selection] };
  assert.deepEqual(normalizedRepositoryAccess(intent, [selection]), intent);

  // The existing repository grant is a compatibility vector, including in a registry with both scopes.
  assert.equal(
    resolve([{ repositoryRef: "example", profile: "git-write" }]).grant.grantId,
    "sha256:c45b1934a76bdaef28404f736c25161ecdae98f081704847cdd3e72a10217a05",
  );
  const binding = resolve([selection]);
  assert.equal(binding.grant.repositoryId, "github-installation:456");
  assert.equal(
    repo.standingApprovalScope({ namespaceId, binding }),
    undefined,
    "finite access is independent of standing permission",
  );
  const standing = driver(
    config(
      { ...policy, allowStandingApproval: true },
      { allowStandingApprovals: true, repositories: [] },
    ),
  );
  assert.deepEqual((await standing.listOptions({ namespaceId })).options, [
    {
      repositoryRef,
      displayName: "All repositories and permissions available to this GitHub App installation",
      allowedProfiles: [profile],
    },
  ]);
  const scope = standing.standingApprovalScope({ namespaceId, binding });
  assert.equal(scope?.repositorySelection, "installation");
  assert.equal(scope.apiPermissions, "inherited-from-github-app-installation");
  for (const field of [
    "repositoryId",
    "repository",
    "pushRefAllowlist",
    "pullRequestBase",
    "draftPullLimit",
  ]) {
    assert.equal(Object.hasOwn(scope, field), false);
  }
  assert.equal(
    standing.standingApprovalScope({
      namespaceId,
      binding: { ...binding, grant: { ...binding.grant, grantId: "other-grant" } },
    }),
    undefined,
  );

  assert.equal("open" in repo, false);
});

test("installation access needs positive sender capability and a profile-bound signed recipient", async () => {
  const signal = new AbortController().signal;
  const identity = { id: "example", generation: 1 };
  const oldControl = {
    backend: identity,
    sender: identity,
    resolver: identity,
    providers: [],
    async assertAvailable() {
      /* old counterpart ignores the requested profile */
    },
  } satisfies CredentialSourceControl;
  assert.equal(await repositoryGitProfileAvailable(oldControl, signal, "repository_git"), true);
  assert.equal(
    await repositoryGitProfileAvailable(oldControl, signal, "github_installation"),
    false,
  );
  assert.equal(
    await repositoryGitProfileAvailable(
      {
        ...oldControl,
        async assertAvailable(_signal, requested) {
          assert.equal(requested, "github_installation");
          return "github_installation";
        },
      },
      signal,
      "github_installation",
    ),
    true,
  );

  const selected = driver(config(policy)).resolve({
    namespaceId,
    bindings: [{ repositoryRef, profile }],
  }).bindings[0]!;
  const recipient = {
    providerId: "provider",
    attachmentEpoch: "one",
    processInstanceId: "process",
    networkInstanceId: "network",
  };
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const sign = (observed: RepositoryGitRecipient, selectedProfile: string = profile) =>
    signComputeExecutionRelease(privateKey, "startup", {
      plan: {
        id: "test-installation",
        generation: 1,
        routes: [],
        sandboxDriverId: identity.id,
        egressDriverId: identity.id,
        execution: {
          installationId: "site",
          namespaceId,
          agentId: "agent",
          servicePrincipalId: "principal",
          revisionId: "revision",
          executionId: "execution",
        },
        repositoryGit: {
          driver: { id: "repo", implementation: "github" },
          deadlineWallMs: Date.now() + 60_000,
          bindings: [{ ...selected, profile: selectedProfile }],
        },
      },
      sandboxId: "sandbox",
      sender: identity,
      installedAt: new Date().toISOString(),
      enforcement: {
        instanceId: "instance",
        configurationId: "config",
        peerKeyId: "peer",
        policyHash: "policy",
        authorityScope: "execution",
        repositoryGitRecipient: observed,
      },
    });
  assert.throws(() => sign(recipient), /verified recipient/);
  assert.throws(() => sign(recipient, "unknown-profile"), /verified recipient/);
  const broad = { ...recipient, deliveryProfile: "github_installation" as const };
  assert.throws(() => sign(broad, "git-write"), /verified recipient/);
  const { challenge, installation, expiresAt, signature } = sign(broad);
  assert.deepEqual(
    (installation as { repositoryGitRecipient: unknown }).repositoryGitRecipient,
    broad,
  );
  assert.ok(
    verify(
      null,
      Buffer.from(JSON.stringify([challenge, installation, expiresAt])),
      publicKey,
      Buffer.from(signature, "base64url"),
    ),
  );
});
