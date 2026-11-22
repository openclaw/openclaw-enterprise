import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { chmod, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRevision } from "@openclaw-enterprise/contracts";
import {
  createGitHubRepositoryDeliveryResolver,
  resolveGitHubRepositoryBinding,
  resolveSelectedRepositoryGrant,
  resolveSelectedRepositoryScope,
  validateGitHubRepositoryRegistry,
} from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
import { preparedGitHubConfiguration } from "../../apps/controller/src/drivers/repo/github/access/prepared-configuration.ts";
import { startPreparedGitHubGitOwner } from "../../apps/controller/src/backends/repository-credentials/prepared-git-owner.ts";
import type { PostgresPool } from "../../packages/occ/src/index.ts";
import {
  GitHubTokenSourceError,
  createGitHubTokenLoanSource,
  createGitHubTokenMaterialReader,
  githubTokenLoanMaximumMs,
} from "../../apps/controller/src/drivers/repo/github/access/token-loan.ts";
import { compileOpenShellBoundGitRule } from "../../apps/controller/src/drivers/sandbox/openshell-git-network-policy.ts";
import {
  OpenShellPreparedGitProvider,
  OpenShellPreparedGitProviderError,
  type OpenShellPreparedGitScope,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts";
import type { OpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

// Obviously fake values with the documented prefixes; none is a real credential.
const fakeFineGrained = "github_pat_" + "FAKE0fixture0only0".repeat(4);
const fakeReplacement = "github_pat_" + "FAKE1replacement1".repeat(4);
const fakeOther = {
  classic: "ghp_" + "FAKEfixture".repeat(3),
  oauth: "gho_" + "FAKEfixture".repeat(3),
  "app-user": "ghu_" + "FAKEfixture".repeat(3),
  "app-installation": "ghs_" + "FAKEfixture".repeat(3),
  unknown: "FAKE-not-a-github-token",
} as const;

// The registry says only which authority; Helm names and mounts the Secret.
const tokenAuthority = { kind: "github-token" } as const;

function tokenRegistryInput(): Record<string, unknown> & {
  repositories: (Record<string, unknown> & { namespaces: Record<string, unknown>[] })[];
} {
  return {
    version: 1,
    backendId: "github-primary",
    providerInstanceId: "github-com-primary",
    authority: { ...tokenAuthority },
    maximumDurationSeconds: 3600,
    repositories: [
      {
        repositoryRef: "a",
        repositoryId: "101",
        repository: "fixture/a",
        namespaces: [
          {
            namespaceId: "namespace-a",
            profiles: ["github-repository"],
            permissions: { metadata: "read", contents: "write" },
            nativeGit: "v1",
          },
        ],
      },
      {
        repositoryRef: "b",
        repositoryId: "102",
        repository: "fixture/b",
        namespaces: [
          {
            namespaceId: "namespace-a",
            profiles: ["github-repository"],
            permissions: { metadata: "read", contents: "write" },
            nativeGit: "v1",
          },
        ],
      },
    ],
  };
}

test("a token authority replaces the App fields and binds the same Namespace grants", () => {
  const registry = validateGitHubRepositoryRegistry(tokenRegistryInput(), "github-primary");
  assert.deepEqual(registry.authority, tokenAuthority);
  assert.equal("appId" in registry, false);
  assert.equal("githubInstallationId" in registry, false);
  const binding = resolveGitHubRepositoryBinding(registry, {
    namespaceId: "namespace-a",
    repositoryRef: "a",
  });
  assert.equal(binding.profile, "github-repository");
  // The grant identity binds the token source, so a changed providerInstanceId is a changed grant.
  const renamed = tokenRegistryInput();
  renamed.providerInstanceId = "github-com-secondary";
  assert.notEqual(
    resolveGitHubRepositoryBinding(validateGitHubRepositoryRegistry(renamed), {
      namespaceId: "namespace-a",
      repositoryRef: "a",
    }).grant.grantId,
    binding.grant.grantId,
  );
  assert.deepEqual(
    resolveSelectedRepositoryScope(registry, "namespace-a", [binding]).repositories,
    [{ repositoryId: "101", repository: "fixture/a" }],
  );
});

test("registry load refuses every option the network policy cannot enforce for a token", () => {
  const refusals: Record<string, (input: ReturnType<typeof tokenRegistryInput>) => void> = {
    "App fields beside the token": (input) => {
      input.appId = "12345";
      input.githubInstallationId = "67890";
    },
    "an App id alone": (input) => {
      input.appId = "12345";
    },
    "an unknown authority kind": (input) => {
      input.authority = { kind: "github-app" };
    },
    "an extra authority field": (input) => {
      input.authority = { ...tokenAuthority, tokenSecret: "repository-token" };
    },
    "a providerInstanceId that cannot name a token source": (input) => {
      input.providerInstanceId = "GitHub_Primary";
    },
    "a registration without nativeGit": (input) => {
      delete input.repositories[0]!.namespaces[0]!.nativeGit;
    },
    "a legacy profile": (input) => {
      input.repositories[0]!.namespaces[0] = {
        namespaceId: "namespace-a",
        profiles: ["git-write"],
        pushRefAllowlist: ["refs/heads/agent"],
        transport: "git-only",
      };
    },
    "installation access": (input) => {
      input.installationAccess = {
        repositoryRef: "all",
        namespaces: [{ namespaceId: "namespace-a", accessMode: "installation" }],
      };
    },
    "standing approvals": (input) => {
      input.allowStandingApprovals = true;
    },
    "REST permissions (scoped REST)": (input) => {
      input.repositories[0]!.namespaces[0]!.permissions = {
        metadata: "read",
        contents: "write",
        issues: "read",
      };
    },
    "pull request permissions": (input) => {
      input.repositories[0]!.namespaces[0]!.permissions = {
        metadata: "read",
        contents: "read",
        pull_requests: "write",
      };
    },
    "a push ref allowlist": (input) => {
      input.repositories[0]!.namespaces[0]!.pushRefAllowlist = ["refs/heads/agent"];
    },
  };
  for (const [name, mutate] of Object.entries(refusals)) {
    const input = tokenRegistryInput();
    mutate(input);
    assert.throws(
      () => validateGitHubRepositoryRegistry(input),
      /invalid-repository-registry/,
      name,
    );
  }
  // A registry without the token authority is still the App registry: both fields are required.
  const app = tokenRegistryInput();
  delete app.authority;
  assert.throws(() => validateGitHubRepositoryRegistry(app), /invalid-repository-registry/);
  app.appId = "12345";
  app.githubInstallationId = "67890";
  assert.equal(validateGitHubRepositoryRegistry(app).appId, "12345");
});

test("delivery names the token source in place of an installation and requires native Git", () => {
  const registry = validateGitHubRepositoryRegistry(tokenRegistryInput());
  const bindings = ["a", "b"].map((repositoryRef) =>
    resolveGitHubRepositoryBinding(registry, { namespaceId: "namespace-a", repositoryRef }),
  );
  const revision = (grants?: { repository: string; access: "read" | "write" }[]) =>
    ({
      id: "rev_token",
      namespaceId: "namespace-a",
      repositoryCredentials: {
        driver: { id: "repository-credentials", implementation: "github" },
        deadlineWallMs: Date.now() + 3_600_000,
        bindings,
      },
      ...(grants && { sandboxPolicy: { repositoryNetworkPolicy: { grants } } }),
    }) as unknown as AgentRevision;
  const resolve = createGitHubRepositoryDeliveryResolver(registry);
  assert.deepEqual(
    resolve(
      revision([
        { repository: "fixture/a", access: "read" },
        { repository: "fixture/b", access: "write" },
      ]),
    ).delivery,
    {
      scope: "github-repository",
      tokenSource: "github-com-primary",
      repositories: [
        { repositoryId: "101", repository: "fixture/a" },
        { repositoryId: "102", repository: "fixture/b" },
      ],
      permissions: { contents: "write", metadata: "read" },
      nativeGit: "v1",
    },
  );
  assert.throws(() => resolve(revision()), /token source requires native Git/);
  assert.throws(() => resolve(revision([])), /nonempty network policy/);
});

test("the bound Sandbox rule accepts the token Provider family and nothing else new", () => {
  const grants = [{ repository: "fixture/a", access: "read" }] as const;
  const binaries = ["/usr/bin/git"];
  const hex = "0123456789abcdef0123456789abcdef";
  for (const provider of [`oce-github-installation-${hex}`, `oce-github-token-${hex}`]) {
    assert.equal(
      compileOpenShellBoundGitRule(grants, provider, binaries).endpoints[0]?.credential_binding
        .provider,
      provider,
    );
  }
  for (const provider of [`oce-git-${hex}`, `oce-github-token-${hex}0`, "oce-github-token-x"]) {
    assert.throws(() => compileOpenShellBoundGitRule(grants, provider, binaries), /Git Provider/);
  }
});

test("a token source gets its own endpointless Provider; installation and token never mix", () => {
  const client = {} as OpenShellGatewayClient;
  const base = {
    workspace: "token-acl",
    workspaceId: "workspace-id",
    sandbox: "sandbox",
    executionId: "revision-1",
    gitOrigin: "https://github.com",
    apiOrigin: "https://api.github.com",
    binaries: ["/usr/bin/git"],
    nativeGit: "v1",
    repositoryNetworkPolicy: [{ repository: "fixture/a", access: "write" }],
  } as const;
  const token = new OpenShellPreparedGitProvider(client, {
    ...base,
    tokenSource: "repository-token",
  } as OpenShellPreparedGitScope);
  const installation = new OpenShellPreparedGitProvider(client, {
    ...base,
    installationId: "42",
  } as OpenShellPreparedGitScope);
  const tokenProvider = token.boundNetworkRule()?.endpoints[0]?.credential_binding.provider;
  const installationProvider =
    installation.boundNetworkRule()?.endpoints[0]?.credential_binding.provider;
  assert.match(tokenProvider ?? "", /^oce-github-token-[a-f0-9]{32}$/);
  assert.match(installationProvider ?? "", /^oce-github-installation-[a-f0-9]{32}$/);
  const refused = [
    {
      ...base,
      tokenSource: "repository-token",
      nativeGit: undefined,
      repositoryNetworkPolicy: undefined,
    },
    { ...base, tokenSource: "repository-token", installationId: "42" },
    { ...base, tokenSource: "Repository_Token" },
  ];
  for (const scope of refused) {
    assert.throws(
      () => new OpenShellPreparedGitProvider(client, scope as unknown as OpenShellPreparedGitScope),
      OpenShellPreparedGitProviderError,
    );
  }
});

async function secretFile(t: test.TestContext, value: string) {
  const directory = await temporaryDirectory(t, "token-loan-");
  const path = join(directory, "token");
  await writeFile(path, value, { mode: 0o440 });
  await chmod(path, 0o440);
  // Kubernetes replaces a projected Secret atomically; a rename stands in for the swap.
  const replace = async (next: string) => {
    const staged = join(directory, "token.next");
    await writeFile(staged, next, { mode: 0o440 });
    await chmod(staged, 0o440);
    await rename(staged, path);
  };
  return { path, replace };
}

test("a loan lasts at most one hour, names no provider expiry and audits no value", async (t) => {
  const { path } = await secretFile(t, fakeFineGrained + "\n");
  const audit: unknown[] = [];
  let now = Date.parse("2030-01-01T00:00:00.400Z");
  const source = createGitHubTokenLoanSource({
    path,
    secretName: "repository-token",
    clock: { now: () => now },
    audit: (event) => audit.push(event),
  });
  const loan = await source.lend({ revisionId: "rev_token" });
  assert.equal(loan.value, fakeFineGrained, "a trailing newline from the Secret is not sent");
  assert.equal(loan.tokenClass, "fine-grained");
  assert.equal(Object.hasOwn(loan, "providerExpiresAt"), false);
  const remaining = Date.parse(loan.usableUntil) - now;
  assert.ok(remaining > 0 && remaining <= githubTokenLoanMaximumMs, String(remaining));
  assert.equal(githubTokenLoanMaximumMs, 3_600_000);
  assert.equal(
    new Date(loan.usableUntil).getUTCMilliseconds(),
    0,
    "whole seconds for the Provider",
  );
  // A caller cannot ask for more than an hour.
  now += 1000;
  const long = await source.lend({ revisionId: "rev_token", loanMs: 86_400_000 });
  assert.ok(Date.parse(long.usableUntil) - now <= githubTokenLoanMaximumMs);
  const short = await source.lend({ revisionId: "rev_token", loanMs: 60_000 });
  assert.ok(Date.parse(short.usableUntil) - now <= 60_000);
  const digest = createHash("sha256").update(fakeFineGrained).digest("hex");
  const recorded = JSON.stringify(audit);
  assert.equal(audit.length, 3);
  assert.equal(recorded.includes(fakeFineGrained), false);
  assert.equal(recorded.includes(digest), false);
  assert.equal(recorded.includes(digest.slice(0, 16)), false);
  assert.deepEqual(Object.keys(audit[0] as object).sort(), [
    "at",
    "event",
    "revisionId",
    "secretName",
    "secretVersion",
    "source",
    "usableUntil",
  ]);
});

test("a replaced Secret value is lent at the next loan, without a restart", async (t) => {
  const { path, replace } = await secretFile(t, fakeFineGrained);
  const source = createGitHubTokenLoanSource({ path, secretName: "repository-token" });
  const first = await source.lend({ revisionId: "rev_token" });
  await replace(fakeReplacement);
  const second = await source.lend({ revisionId: "rev_token" });
  assert.equal(first.value, fakeFineGrained);
  assert.equal(second.value, fakeReplacement);
  assert.notEqual(second.secretVersion, first.secretVersion);
});

test("every token class but fine-grained fails the loan with a named diagnostic", async (t) => {
  for (const [tokenClass, value] of Object.entries(fakeOther)) {
    const { path } = await secretFile(t, value);
    const audit: unknown[] = [];
    const source = createGitHubTokenLoanSource({
      path,
      secretName: "repository-token",
      audit: (event) => audit.push(event),
    });
    await assert.rejects(source.lend({ revisionId: "rev_token" }), (error: unknown) => {
      assert.ok(error instanceof GitHubTokenSourceError);
      assert.equal(error.code, "GITHUB_TOKEN_SOURCE_REFUSED");
      assert.equal(error.reason, "token_class_refused");
      assert.equal(error.tokenClass, tokenClass);
      assert.equal(error.message.includes(value), false);
      return true;
    });
    assert.equal(JSON.stringify(audit).includes(value), false);
  }
  const { path } = await secretFile(t, fakeFineGrained);
  await chmod(path, 0o644);
  await assert.rejects(
    createGitHubTokenLoanSource({ path, secretName: "repository-token" }).lend({
      revisionId: "rev_token",
    }),
    (error: unknown) =>
      error instanceof GitHubTokenSourceError && error.reason === "token_unreadable",
  );
});

test("the native material reader lends without a row and turns stale on replacement", async (t) => {
  const { path, replace } = await secretFile(t, fakeFineGrained);
  let now = Date.parse("2030-01-01T00:10:00Z");
  const clock = { now: () => now };
  const audit: unknown[] = [];
  const loans = createGitHubTokenLoanSource({
    path,
    secretName: "repository-token",
    clock,
    audit: (event) => audit.push(event),
  });
  const refused: GitHubTokenSourceError[] = [];
  const reader = createGitHubTokenMaterialReader<null, { key: { source: { id: string } } }>(
    loans,
    clock,
    (error) => refused.push(error),
  );
  const source = { key: { source: { id: "repository-git:admission-1" } } };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const warm = await reader.readWarm(null, source);
  assert.ok(warm);
  assert.match(warm.preparationAttemptId, uuid);
  assert.match(warm.materialVersion, uuid);
  const remaining = warm.usableUntil - now;
  assert.ok(remaining >= 1_800_000 && remaining <= githubTokenLoanMaximumMs, String(remaining));
  const bytes = warm.open();
  assert.equal(bytes.toString("ascii"), fakeFineGrained);
  bytes.fill(0);
  assert.throws(() => warm.open(), /already opened/);
  const installed = {
    preparationAttemptId: warm.preparationAttemptId,
    materialVersion: warm.materialVersion,
  };
  // Current within its loan, across the next renewal window, and never past its end.
  assert.equal((await reader.current(null, source, installed))?.usableUntil, warm.usableUntil);
  now += 1_800_000;
  assert.equal((await reader.current(null, source, installed))?.usableUntil, warm.usableUntil);
  const renewed = await reader.readWarm(null, source);
  assert.ok(renewed && renewed.materialVersion !== warm.materialVersion);
  now = warm.usableUntil;
  assert.equal(await reader.current(null, source, installed), undefined);
  // Another source never shares a version.
  const other = await reader.readWarm(null, {
    key: { source: { id: "repository-git:admission-2" } },
  });
  assert.ok(other && renewed && other.materialVersion !== renewed.materialVersion);
  // Replacement: the installed version turns stale at once; the next loan carries the new value.
  const before = {
    preparationAttemptId: renewed!.preparationAttemptId,
    materialVersion: renewed!.materialVersion,
  };
  now = renewed!.usableUntil - 1_800_000;
  assert.ok(await reader.current(null, source, before));
  await replace(fakeReplacement);
  assert.equal(await reader.current(null, source, before), undefined);
  const next = await reader.readWarm(null, source);
  assert.equal(next?.open().toString("ascii"), fakeReplacement);
  // A classic token fails the loan: no material, and no value in the audit.
  await replace(fakeOther.classic);
  assert.equal(await reader.readWarm(null, source), undefined);
  // The waiting route reads again at every pass; the same refused file is reported once.
  assert.equal(await reader.readWarm(null, source), undefined);
  // The operator is told why, by fixed reason and class: the Worker reports this refusal.
  assert.deepEqual(
    refused.map(({ reason, tokenClass }) => [reason, tokenClass]),
    [["token_class_refused", "classic"]],
  );
  // A new refused file generation is a new refusal.
  await replace(fakeOther.classic);
  assert.equal(await reader.readWarm(null, source), undefined);
  assert.equal(refused.length, 2);
  const recorded = JSON.stringify(audit);
  for (const value of [fakeFineGrained, fakeReplacement, fakeOther.classic]) {
    assert.equal(recorded.includes(value), false);
  }
});

test("a selected token grant names its source and carries no App identity", () => {
  const registry = validateGitHubRepositoryRegistry(tokenRegistryInput(), "github-primary");
  const binding = resolveGitHubRepositoryBinding(registry, {
    namespaceId: "namespace-a",
    repositoryRef: "a",
  });
  assert.deepEqual(
    resolveSelectedRepositoryGrant(registry, "namespace-a", "rev_token", [binding]),
    {
      id: binding.grant.grantId,
      isolationId: "rev_token",
      tokenSource: "github-com-primary",
      profile: "github-repository",
      repositories: [{ repositoryId: "101", repository: "fixture/a" }],
      permissions: { metadata: "read", contents: "write" },
    },
  );
});

test("the Worker mounts exactly one authority and refuses one the registry does not name", async () => {
  const paths = {
    custodyKeyPath: "/etc/openclaw/prepared-repository/custody.key",
    privateKeyPath: "/etc/openclaw/prepared-repository/private-key.pem",
    tokenPath: "/etc/openclaw/prepared-repository/token",
  };
  assert.deepEqual(
    preparedGitHubConfiguration(
      { custodyKeyPath: paths.custodyKeyPath, tokenPath: paths.tokenPath },
      true,
    ),
    { custodyKeyPath: paths.custodyKeyPath, tokenPath: paths.tokenPath },
  );
  for (const input of [paths, { custodyKeyPath: paths.custodyKeyPath }]) {
    assert.throws(
      () => preparedGitHubConfiguration(input, true),
      /exactly one of privateKeyPath and tokenPath/,
    );
  }
  // Worker start compares the registry's authority with the mounted material before it reads
  // a key or opens the database, and names both settings in its refusal.
  const start = (registry: unknown, mounted: { privateKeyPath?: string; tokenPath?: string }) =>
    startPreparedGitHubGitOwner({
      ...mounted,
      custodyKeyPath: paths.custodyKeyPath,
      pool: {} as PostgresPool,
      driverId: "openshell",
      implementation: "openshell",
      backendId: "github-primary",
      registry: registry as never,
      repositoryGitCustody: { kind: "native-broker" },
      startWorker: false,
    });
  const appRegistry = tokenRegistryInput();
  delete appRegistry.authority;
  appRegistry.appId = "12345";
  appRegistry.githubInstallationId = "67890";
  for (const [registry, mounted, authority] of [
    [tokenRegistryInput(), { privateKeyPath: paths.privateKeyPath }, /github-token/],
    [appRegistry, { tokenPath: paths.tokenPath }, /the GitHub App/],
  ] as const) {
    await assert.rejects(start(registry, mounted), (error: Error) => {
      assert.match(error.message, authority);
      assert.match(error.message, /repositoryCredentials\.(?:appKey|token)SecretName/);
      return true;
    });
  }
});
