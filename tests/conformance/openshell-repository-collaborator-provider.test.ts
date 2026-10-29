import assert from "node:assert/strict";
import test from "node:test";
import { preparedGitWire } from "../helpers/openshell-prepared-git-wire.ts";
import {
  deleteOpenShellPreparedGitProvider,
  OpenShellPreparedGitProvider,
  OpenShellPreparedGitProviderError,
  type OpenShellPreparedGitScope,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts";
import type { OpenShellRepositorySelection } from "../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts";

// The credential owner verifies token permissions. Transport binds its resolved grant ID.
const grant: OpenShellRepositorySelection = {
  scope: "github-repository",
  installationId: "34",
  repositoryId: "56",
  repository: "owner/repo-a",
  grantId: "grant-repo-a",
};
const scope: OpenShellPreparedGitScope = {
  workspace: "git-dogfood",
  workspaceId: "workspace-id",
  sandbox: "git-execution",
  executionId: "execution-one",
  ...grant,
  gitOrigin: "https://github.com",
  apiOrigin: "https://api.github.com",
  binaries: ["/usr/bin/git", "/usr/bin/gh"],
};
const token = (repositoryGrant?: OpenShellRepositorySelection) => ({
  value: "synthetic-installation-token_selected",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  ...(repositoryGrant ?? {}),
});
const signal = () => AbortSignal.timeout(5000);

test("selected repository transport requires the owner's exact material identity before provisioning", async (t) => {
  const { binding, state } = await preparedGitWire(t, scope);
  for (const material of [
    token(),
    token({ ...grant, repositoryId: "57" }),
    token({ ...grant, grantId: "changed-permissions" }),
    token({ ...grant, grantId: "other-grant" }),
    token({ ...grant, installationId: "35" }),
  ]) {
    await assert.rejects(binding.prepare(material, signal()), OpenShellPreparedGitProviderError);
    assert.equal(state.requests.length, 0);
  }
  const receipt = await binding.prepare(token(grant), signal());
  assert.match(receipt.provider, /^oce-github-repository-[a-f0-9]{32}$/);
  assert.equal(receipt.supervisor, "unknown");
  assert.equal(receipt.credentialState, "active");
  assert.ok(state.profile);
  assert.ok(state.provider);
  assert.deepEqual(
    state.profile.endpoints.map((endpoint: { host: string }) => endpoint.host),
    ["github.com", "api.github.com", "api.github.com"],
  );
  assert.equal(state.provider.credentials.GITHUB_TOKEN, token().value);
  assert.equal(JSON.stringify(receipt).includes(token().value), false);
  const before = state.requests.length;
  await assert.rejects(
    binding.rotate(receipt, async () => token({ ...grant, repositoryId: "57" }), signal()),
    OpenShellPreparedGitProviderError,
  );
  assert.equal(
    state.requests.slice(before).some((q: { provider?: unknown }) => q.provider !== undefined),
    false,
  );
  const rotated = await binding.rotate(receipt, async () => token(grant), signal());
  assert.equal(rotated?.resourceVersion, "2");
});

test("selected recipient identity includes the resolved grant ID and never adopts legacy or changed selections", async (t) => {
  const { binding, client } = await preparedGitWire(t, scope);
  const receipt = await binding.prepare(token(grant), signal());
  for (const changed of [
    { ...grant, repositoryId: "57" },
    { ...grant, repository: "owner/renamed" },
    { ...grant, grantId: "grant-new" },
    { ...grant, grantId: "changed-permissions" },
  ]) {
    const other = new OpenShellPreparedGitProvider(client, { ...scope, ...changed });
    await assert.rejects(
      other.rotate(receipt, async () => token(changed), signal()),
      OpenShellPreparedGitProviderError,
    );
  }
  const {
    scope: _,
    repositoryId: _id,
    repository: _repo,
    grantId: _grant,
    ...legacyScope
  } = { ...scope, ...grant };
  const legacy = new OpenShellPreparedGitProvider(client, legacyScope);
  await assert.rejects(
    legacy.rotate(receipt, async () => token(), signal()),
    OpenShellPreparedGitProviderError,
  );
  await assert.rejects(legacy.prepare(token(grant), signal()), OpenShellPreparedGitProviderError);
});

test("selected transport snapshots selection and refuses noncanonical IDs", async (t) => {
  const mutable = { ...scope, ...grant };
  const { binding, client } = await preparedGitWire(t, mutable);
  mutable.grantId = "changed-permissions";
  await assert.rejects(
    binding.prepare(token(mutable), signal()),
    OpenShellPreparedGitProviderError,
  );
  await binding.prepare(token(grant), signal());
  for (const repositoryId of ["056", "9007199254740992", "0"]) {
    assert.throws(
      () => new OpenShellPreparedGitProvider(client, { ...scope, ...grant, repositoryId }),
      OpenShellPreparedGitProviderError,
    );
  }
});

test("selected provider cleanup retains exact owner matching", async (t) => {
  const { binding, client } = await preparedGitWire(t, scope);
  const receipt = await binding.prepare(token(grant), signal());
  const provider = await client.getProvider(scope.workspace, receipt.provider, signal());
  assert.ok(provider);
  const removed: string[] = [];
  const cleanup = {
    getProviderProfile: client.getProviderProfile.bind(client),
    deleteProvider: async (_workspace: string, name: string) => {
      removed.push(name);
    },
    deleteProviderProfile: async (_workspace: string, name: string) => {
      removed.push(name);
    },
  };
  await deleteOpenShellPreparedGitProvider(
    cleanup,
    scope.workspace,
    { ...provider, labels: {} },
    signal(),
  );
  assert.deepEqual(removed, []);
  await deleteOpenShellPreparedGitProvider(cleanup, scope.workspace, provider, signal());
  assert.deepEqual(removed, [receipt.provider, receipt.profile]);
});
