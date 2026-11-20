import assert from "node:assert/strict";
import test from "node:test";
import { asRecord } from "../../packages/utils/src/index.ts";
import { gitExpiryGateway } from "../helpers/openshell-online-git-journey.mjs";
import { ensureOpenShellProviderProfile } from "../../apps/controller/src/backends/openshell.ts";
import {
  GrpcOpenShellGatewayClient,
  type OpenShellProviderProfile,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { workspaceNodeNetworkPolicy } from "../../apps/controller/src/drivers/sandbox/openshell-workspace-node-policy.ts";
import {
  checkOpenShellGitProviders,
  OpenShellGitRouteError,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-git-installation.ts";
import {
  OpenShellPreparedGitProvider,
  OpenShellPreparedGitProviderError,
  type OpenShellPreparedGitScope,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts";

test("prepared Git provider binds repository read and write rules to its wire profile", async (t) => {
  const commonScope = {
    workspace: "profile-acl",
    workspaceId: "workspace-id",
    sandbox: "sandbox",
    executionId: "revision-1",
    gitOrigin: "https://github.com",
    apiOrigin: "https://api.github.com",
    binaries: ["/usr/bin/git"],
  };
  const scope = { ...commonScope, installationId: "42" } satisfies OpenShellPreparedGitScope;
  const providerReads: unknown[] = [];
  const { client, world } = await gitExpiryGateway(t, {
    model: "model",
    workspace: scope.workspace,
    sandbox: scope.sandbox,
    revisionId: scope.executionId,
    deadline: "2030-01-01T00:00:00Z",
    platformProfile: false,
    configure(methods: {
      CreateProvider: (request: Record<string, unknown>) => {
        provider: { metadata: { id: string; name: string } };
      };
      GetProvider: (request: Record<string, unknown>) => unknown;
    }) {
      const { CreateProvider: createProvider, GetProvider: getProvider } = methods;
      methods.CreateProvider = (request) => {
        const response = createProvider(request);
        // The fixture normally gives every provider the same ID.
        response.provider.metadata.id = response.provider.metadata.name + "-id";
        return response;
      };
      methods.GetProvider = (request) => {
        providerReads.push(request.name);
        return getProvider(request);
      };
    },
  });
  const signal = AbortSignal.timeout(10_000);
  const read = { repository: "fixture/a", access: "read" } as const;
  const write = { repository: "fixture/b", access: "write" } as const;
  const readGrant: { repository: string; access: "read" | "write" } = { ...read };
  const policy = [{ ...write }, readGrant];
  const scoped = new OpenShellPreparedGitProvider(client, {
    ...scope,
    repositoryNetworkPolicy: policy,
  });

  // Edits to the original grant objects or array cannot change the prepared profile.
  readGrant.access = "write";
  policy.push({ repository: "fixture/c", access: "read" });
  // A caller inspecting the expected rule must not be able to widen the imported
  // profile while keeping the identity derived from the original grants.
  const discovery = scoped.previewNetworkRule().endpoints[0];
  assert.ok(discovery && "rules" in discovery);
  const service = discovery.rules?.[0]?.allow.query?.service;
  assert.ok(service);
  Reflect.set(service, "glob", "*");

  const binding = await scoped.bootstrap(signal);
  const stored = await client.getProviderProfile(scope.workspace, binding.profile, signal);
  assert.deepEqual(stored?.definition?.endpoints, [
    {
      host: "github.com",
      port: 443,
      protocol: "rest",
      enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
      rules: [
        {
          allow: {
            method: "GET",
            path: "/fixture/a.git/info/refs",
            query: { service: { glob: "git-upload-pack" } },
          },
        },
        { allow: { method: "POST", path: "/fixture/a.git/git-upload-pack" } },
        {
          allow: {
            method: "GET",
            path: "/fixture/b.git/info/refs",
            query: { service: { glob: "git-upload-pack" } },
          },
        },
        { allow: { method: "POST", path: "/fixture/b.git/git-upload-pack" } },
        {
          allow: {
            method: "GET",
            path: "/fixture/b.git/info/refs",
            query: { service: { glob: "git-receive-pack" } },
          },
        },
        { allow: { method: "POST", path: "/fixture/b.git/git-receive-pack" } },
      ],
    },
  ]);

  function profileIdForPolicy(
    repositoryNetworkPolicy: NonNullable<OpenShellPreparedGitScope["repositoryNetworkPolicy"]>,
  ) {
    return new OpenShellPreparedGitProvider(client, { ...scope, repositoryNetworkPolicy }).restore(
      binding,
    ).profile;
  }
  assert.equal(profileIdForPolicy([read, write]), binding.profile);
  assert.notEqual(profileIdForPolicy([{ ...read, access: "write" }, write]), binding.profile);
  assert.notEqual(
    profileIdForPolicy([read, { ...write, repository: "fixture/c" }]),
    binding.profile,
  );

  const punctuationRead = { repository: "fixture/a-b", access: "read" } as const;
  const punctuationWrite = { repository: "fixture/a_b", access: "write" } as const;
  const punctuationProfile = "oce-github-installation-3cb27d015493c84eeba6d445f69af0cc";
  assert.equal(profileIdForPolicy([punctuationWrite, punctuationRead]), punctuationProfile);
  assert.equal(profileIdForPolicy([punctuationRead, punctuationWrite]), punctuationProfile);

  let releaseCalls = 0;
  async function release() {
    releaseCalls++;
    return undefined;
  }

  assert.equal(await scoped.rotate(binding, release, signal), undefined);
  assert.equal(releaseCalls, 1);
  assert.equal(world.writes, 0);
  releaseCalls = 0;

  const changed = new OpenShellPreparedGitProvider(client, {
    ...scope,
    repositoryNetworkPolicy: [{ ...read, access: "write" }, write],
  });
  const changedBinding = await changed.bootstrap(signal);
  assert.notEqual(changedBinding.profile, binding.profile);
  assert.equal(changedBinding.profileVersion, binding.profileVersion);
  assert.notEqual(changedBinding.providerId, binding.providerId);
  providerReads.length = 0;

  const refused = (error: unknown) =>
    error instanceof OpenShellPreparedGitProviderError &&
    error.outcome === "refused" &&
    error.readFailure === undefined;

  await assert.rejects(changed.rotate(binding, release, signal), refused);
  assert.equal(releaseCalls, 0);
  assert.deepEqual(providerReads, []);

  // Restore uses the changed policy's profile but retains the old provider generation.
  const restored = changed.restore(binding);
  assert.equal(restored.profile, changedBinding.profile);
  assert.equal(restored.providerId, binding.providerId);
  await assert.rejects(changed.rotate(restored, release, signal), refused);
  assert.equal(releaseCalls, 0);
  assert.deepEqual(providerReads, [changedBinding.provider]);
  assert.equal(world.writes, 0);

  const legacy = await new OpenShellPreparedGitProvider(client, scope).bootstrap(signal);
  assert.equal(legacy.profile, "oce-github-installation-f941504fe8c04d629f0fcd8569984de1");
  const legacyStored = await client.getProviderProfile(scope.workspace, legacy.profile, signal);
  assert.deepEqual(legacyStored?.definition?.endpoints, [
    {
      host: "github.com",
      port: 443,
      protocol: "rest",
      enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
      rules: [
        { allow: { method: "GET", path: "/**/info/refs" } },
        { allow: { method: "POST", path: "/**/git-upload-pack" } },
        { allow: { method: "POST", path: "/**/git-receive-pack" } },
      ],
    },
    {
      host: "api.github.com",
      port: 443,
      protocol: "rest",
      enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
      access: "NETWORK_ACCESS_PRESET_FULL",
    },
    {
      host: "api.github.com",
      port: 443,
      protocol: "graphql",
      path: "/graphql",
      enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
      access: "NETWORK_ACCESS_PRESET_FULL",
    },
  ]);

  const single = await new OpenShellPreparedGitProvider(client, {
    ...commonScope,
    repository: "Fixture/Legacy_Repo",
    gitOrigin: "https://git.example.test:8443",
    apiOrigin: "https://api.example.test:9443",
  }).bootstrap(signal);
  const singleStored = await client.getProviderProfile(scope.workspace, single.profile, signal);
  assert.deepEqual(singleStored?.definition?.endpoints, [
    {
      host: "git.example.test",
      port: 8443,
      protocol: "rest",
      path: "/Fixture/Legacy_Repo.git/**",
      enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
      access: "NETWORK_ACCESS_PRESET_READ_WRITE",
    },
    {
      host: "api.example.test",
      port: 9443,
      protocol: "rest",
      path: "/repos/Fixture/Legacy_Repo/pulls",
      enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
      access: "NETWORK_ACCESS_PRESET_READ_WRITE",
    },
  ]);

  for (const { name, policy } of [
    { name: "empty policy", policy: [] },
    { name: "unsupported grant constraint", policy: [Object.assign({}, read, { branch: "main" })] },
    { name: "inherited grant", policy: [Object.create(read)] },
    { name: "noncanonical owner", policy: [{ ...read, repository: "a_b/repo" }] },
    { name: "noncanonical name", policy: [{ ...read, repository: "fixture/.repo" }] },
    {
      name: "too many grants",
      policy: Array.from({ length: 33 }, (_, i) => ({ ...read, repository: "fixture/r" + i })),
    },
    { name: "duplicate repository", policy: [read, { ...read, access: "write" }] },
    { name: "uppercase repository", policy: [{ ...read, repository: "Fixture/a" }] },
    { name: "Git suffix", policy: [{ ...read, repository: "fixture/a.git" }] },
    { name: "parent path", policy: [{ ...read, repository: "fixture/.." }] },
    { name: "trailing newline", policy: [{ ...read, repository: "fixture/a\n" }] },
    { name: "wildcard", policy: [{ ...read, repository: "fixture/a*" }] },
    { name: "encoded separator", policy: [{ ...read, repository: "fixture/a%2Fb" }] },
  ] satisfies {
    name: string;
    policy: NonNullable<OpenShellPreparedGitScope["repositoryNetworkPolicy"]>;
  }[]) {
    assert.throws(
      () => new OpenShellPreparedGitProvider(client, { ...scope, repositoryNetworkPolicy: policy }),
      { name: OpenShellPreparedGitProviderError.name, outcome: "refused" },
      name,
    );
  }
  assert.throws(
    () =>
      new OpenShellPreparedGitProvider(client, {
        ...commonScope,
        repository: "fixture/a",
        repositoryNetworkPolicy: [read],
      }),
    OpenShellPreparedGitProviderError,
  );
});

test("prepared repository ACL requires a matching loaded effective policy", async (t) => {
  const modelEndpoint = {
    host: "model.example.test",
    port: 443,
    protocol: "rest",
    access: "NETWORK_ACCESS_PRESET_FULL" as const,
  };
  const modelId = "model-id";
  const modelRule = {
    name: "_provider_model",
    binaries: [{ path: "/usr/bin/codex" }],
    endpoints: [
      {
        ...modelEndpoint,
        host: "model.example.net",
        enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
        provider_credentialed: true,
      },
    ],
  };
  const runtime = "runtime-files";
  const runtimeRule = { name: "_provider_runtime_files", binaries: [], endpoints: [] };
  const scope = {
    workspace: "loaded-repo-acl",
    workspaceId: "workspace-id",
    sandbox: "sandbox",
    executionId: "revision-1",
    installationId: "42",
    gitOrigin: "https://github.com",
    apiOrigin: "https://api.github.com",
    binaries: ["/usr/bin/git"],
    repositoryNetworkPolicy: [{ repository: "fixture/a", access: "read" }],
    expectedProviders: [
      { name: "model", providerId: modelId, rule: modelRule },
      { name: runtime, rule: runtimeRule },
    ],
  } satisfies OpenShellPreparedGitScope;
  const hash = "a".repeat(64);
  const sourceRule = { name: "model", endpoints: [modelEndpoint] };
  const sourceWithoutMiddleware = { version: 1, network_policies: { model: sourceRule } };
  const stockSource = {
    ...sourceWithoutMiddleware,
    network_middlewares: {
      model: {
        name: "model",
        middleware: "fixture-model-egress",
        on_error: "fail_closed",
        endpoints: { include: [modelEndpoint.host] },
      },
    },
  };
  const generation = { policy_hash: hash, config_revision: "100", provider_env_revision: "120" };
  const endpoint = {
    host: "github.com",
    port: 443,
    protocol: "rest",
    enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
    provider_credentialed: true,
    rules: [
      {
        allow: {
          method: "GET",
          path: "/fixture/a.git/info/refs",
          query: { service: { glob: "git-upload-pack" } },
        },
      },
      { allow: { method: "POST", path: "/fixture/a.git/git-upload-pack" } },
    ],
  };
  let providerName = "";
  let elapsedReadbackMs = 0;
  let overrides: {
    source?: Record<string, unknown>;
    effective?: Record<string, unknown>;
    active?: number;
    missingConfig?: boolean;
    config?: Record<string, unknown>;
    sandboxId?: string;
    sandboxPolicy?: Record<string, unknown> | null;
    providers?: string[];
    ageDuringReadback?: boolean;
  } = {};
  const { client }: { client: GrpcOpenShellGatewayClient } = await gitExpiryGateway(t, {
    model: "model",
    workspace: scope.workspace,
    sandbox: scope.sandbox,
    revisionId: scope.executionId,
    deadline: "2030-01-01T00:00:00Z",
    platformProfile: false,
    configure(methods: Record<string, (request: Record<string, unknown>) => unknown>) {
      const scopeCheck = (request: Record<string, unknown>, nameField: "name" | "sandbox") => {
        assert.ok(request.workspace_scope && typeof request.workspace_scope === "object");
        assert.ok("workspace" in request.workspace_scope);
        assert.equal(request.workspace_scope.workspace, scope.workspace);
        assert.equal(request[nameField], scope.sandbox);
      };
      methods.GetSandboxPolicyStatus = (request) => {
        scopeCheck(request, "sandbox");
        return {
          active_version: overrides.active ?? 17,
          revision: {
            version: 17,
            policy_hash: "b".repeat(64),
            status: "POLICY_STATUS_LOADED",
            policy: overrides.source ?? stockSource,
          },
        };
      };
      methods.GetSandboxConfig = (request) => {
        scopeCheck(request, "name");
        return overrides.missingConfig
          ? undefined
          : {
              version: 17,
              ...generation,
              workspace: scope.workspace,
              policy_source: 1,
              policy_validation_failure_mode: "fail_closed",
              configuration_admitted: true,
              configuration_instance_id: "configuration",
              provider_attachment_epoch: "original",
              policy: {
                ...stockSource,
                network_policies: {
                  ...stockSource.network_policies,
                  ...overrides.effective,
                },
              },
              ...overrides.config,
            };
      };
      methods.GetSandbox = (request) => {
        scopeCheck(request, "name");
        if (overrides.ageDuringReadback) {
          elapsedReadbackMs = 2_000;
        }
        return {
          sandbox: {
            metadata: {
              id: overrides.sandboxId ?? "sandbox-id",
              workspace: scope.workspace,
              name: scope.sandbox,
            },
            spec: {
              provider_attachment_epoch: "original",
              providers: overrides.providers ?? ["model", runtime, providerName],
              ...(overrides.sandboxPolicy === null
                ? {}
                : { policy: overrides.sandboxPolicy ?? stockSource }),
            },
            status: {
              main_process_instance_id: "network-instance",
              configuration_activated: true,
              configuration_admission: {
                instance_id: "configuration",
                state: 2,
                policy_version: 17,
                ...generation,
              },
            },
          },
        };
      };
      methods.GetSandboxProviderStatus = (request) => {
        scopeCheck(request, "sandbox");
        assert.equal(request.provider, providerName);
        const now = { seconds: Math.floor(Date.now() / 1000) };
        const observationAgeSeconds = overrides.ageDuringReadback
          ? 14 + elapsedReadbackMs / 1000
          : 0;
        const snapshot = { ...generation, attachment_epoch: "original" };
        return {
          status: {
            state:
              observationAgeSeconds < 15
                ? "PROVIDER_READINESS_STATE_READY"
                : "PROVIDER_READINESS_STATE_PENDING",
            receipt: {
              receipt_id: "observe-git",
              kind: "PROVIDER_MUTATION_KIND_OBSERVE",
              workspace: scope.workspace,
              provider: providerName,
              desired: {
                ...snapshot,
                sandbox: scope.sandbox,
                sandbox_id: "sandbox-id",
                provider_id: "git-id",
                provider_resource_version: "1",
              },
            },
            observed: {
              ...snapshot,
              session_id: "supervisor",
              sequence: "1",
              process_instance_id: "process",
              credentials_installed: true,
              policy_active: true,
              launch_environment_installed: true,
            },
            network_instance_id: "network-instance",
            evaluated_time: now,
            observed_time: { seconds: now.seconds - observationAgeSeconds },
          },
        };
      };
    },
  });
  const prepared = new OpenShellPreparedGitProvider(client, scope);
  const binding = await prepared.prepare(
    { value: "synthetic-fixture", expiresAt: new Date(Date.now() + 60_000).toISOString() },
    AbortSignal.timeout(10_000),
  );
  providerName = binding.provider;
  const name = "_provider_" + providerName.replaceAll("-", "_");
  const gitRule = { name, binaries: [{ path: "/usr/bin/git" }], endpoints: [endpoint] };
  // Generated independently with OpenShell 0.1.8's protobuf schema and its
  // policy_identity.rs framing. The Gateway stamps the complete rule per endpoint.
  const stockGitOwner =
    "grant-owner:v1:f91498eb9e144f317eea2b4979aa24d368eee926d1040e22d41e355f27f6b412";
  const stockModelOwner =
    "grant-owner:v1:f06e4e3075fd5cf5654d660d9186ab91841454eb090e22950206a7c5de3bb50a";
  const replacementModelOwner =
    "grant-owner:v1:b824b689ceadbe85c88600cf8344d577eecdfae4ddebd4e55574eac1825a3be0";
  const stockModelEndpoint = { ...modelRule.endpoints[0]!, token_grant_owner: stockModelOwner };
  const expected = {
    [name]: { ...gitRule, endpoints: [{ ...endpoint, token_grant_owner: stockGitOwner }] },
    [modelRule.name]: { ...modelRule, endpoints: [stockModelEndpoint] },
    [runtimeRule.name]: runtimeRule,
  };
  const observe = () => prepared.observe(binding, "sandbox-id", AbortSignal.timeout(10_000));
  // A READY supervisor and matching rule names cannot authorize the first observation
  // when the effective policy has an unstamped Git endpoint.
  overrides = { effective: { ...expected, [name]: gitRule } };
  assert.equal(await observe(), undefined);
  overrides = { effective: expected };
  const installed = await observe();
  assert.ok(installed);
  assert.equal(installed.policyHash, hash);
  const predecessor = () =>
    prepared.observePredecessor(binding, installed, AbortSignal.timeout(10_000));
  assert.deepEqual(await predecessor(), installed);

  await t.test("Workspace TLS-skip prevents current and predecessor observation", async () => {
    function reportWorkspaceRule(host: string, tls: boolean, sibling = false) {
      const workspaceRules = workspaceNodeNetworkPolicy({
        host,
        port: 443,
        path: "/namespaces/ns1/agents/agent1/node",
        tls,
      });
      const rule = asRecord(workspaceRules["workspace-node-enrollment"]);
      assert.ok(rule);
      const rules = sibling ? { sibling: { ...rule, name: "sibling" } } : workspaceRules;
      const source = {
        ...stockSource,
        network_policies: { ...stockSource.network_policies, ...rules },
      };
      overrides = { source, sandboxPolicy: source, effective: { ...expected, ...rules } };
    }
    reportWorkspaceRule("workspace.example.test", false);
    assert.ok(await observe());
    assert.deepEqual(await predecessor(), installed);
    for (const host of ["github.com", "api.github.com", "workspace.example.test"]) {
      for (const sibling of [false, true]) {
        // The reports agree on the rule and generation, so shape and TLS are decisive.
        reportWorkspaceRule(host, true, sibling);
        assert.equal(await observe(), undefined, host);
        assert.equal(await predecessor(), undefined, host);
      }
    }
  });

  await t.test("an exact sibling profile still cannot allow uninspected credentials", async () => {
    const unsafe = {
      ...modelRule,
      endpoints: modelRule.endpoints.map((endpoint) => ({
        ...endpoint,
        allow_uninspected_credentials: true,
      })),
    };
    const matchingProfile = new OpenShellPreparedGitProvider(client, {
      ...scope,
      expectedProviders: [
        { name: "model", providerId: modelId, rule: unsafe },
        { name: runtime, rule: runtimeRule },
      ],
    });
    overrides = { effective: { ...expected, [modelRule.name]: unsafe } };
    assert.equal(
      await matchingProfile.observe(binding, "sandbox-id", AbortSignal.timeout(10_000)),
      undefined,
    );
    assert.equal(
      await matchingProfile.observePredecessor(binding, installed, AbortSignal.timeout(10_000)),
      undefined,
    );
  });

  await t.test(
    "ready sibling model generation gains a literal HTTPS REST destination",
    async () => {
      // All live generations and the admitted source still agree. Only the sibling
      // model rule changed, and the new route passes the general non-Git endpoint checks.
      overrides = {
        effective: {
          ...expected,
          [modelRule.name]: {
            ...modelRule,
            endpoints: [
              stockModelEndpoint,
              { ...stockModelEndpoint, host: "second-model.example.test" },
            ],
          },
        },
      };
      assert.deepEqual(
        { active: (await observe()) !== undefined, predecessor: await predecessor() },
        { active: false, predecessor: undefined },
      );
    },
  );

  await t.test("same-named model Provider has a different token-grant owner", async () => {
    // Only the Provider record ID used to derive the grant owner changed.
    // All routes, attached names, and live generation reports agree.
    overrides = {
      effective: {
        ...expected,
        [modelRule.name]: {
          ...modelRule,
          endpoints: [{ ...stockModelEndpoint, token_grant_owner: replacementModelOwner }],
        },
      },
    };
    assert.equal(await observe(), undefined);
    assert.equal(await predecessor(), undefined);
  });

  await t.test("ACL observation requires an independently selected model Provider ID", async () => {
    overrides = { effective: expected };
    const unbound = new OpenShellPreparedGitProvider(client, {
      ...scope,
      expectedProviders: [
        { name: "model", rule: modelRule },
        { name: runtime, rule: runtimeRule },
      ],
    });
    assert.equal(
      await unbound.observe(binding, "sandbox-id", AbortSignal.timeout(10_000)),
      undefined,
    );
    assert.equal(
      await unbound.observePredecessor(binding, installed, AbortSignal.timeout(10_000)),
      undefined,
    );
  });

  await t.test("ACL observation requires an independently selected sibling policy", async () => {
    overrides = { effective: expected };
    const { expectedProviders: _expectedProviders, ...unboundScope } = scope;
    const unbound = new OpenShellPreparedGitProvider(client, unboundScope);
    assert.equal(
      await unbound.observe(binding, "sandbox-id", AbortSignal.timeout(10_000)),
      undefined,
    );
    assert.equal(
      await unbound.observePredecessor(binding, installed, AbortSignal.timeout(10_000)),
      undefined,
    );
  });

  await t.test("a wildcard source host refuses initial and predecessor readback", async () => {
    // The literal source route already passed both observations. Change only its
    // host, keeping the same REST rule in admitted, loaded, and effective policy.
    const wildcardRule = {
      ...sourceRule,
      endpoints: [{ ...modelEndpoint, host: "**.com" }],
    };
    const wildcardSource = {
      ...stockSource,
      network_policies: { ...stockSource.network_policies, model: wildcardRule },
    };
    overrides = {
      source: wildcardSource,
      sandboxPolicy: wildcardSource,
      effective: { ...expected, model: wildcardRule },
    };
    assert.deepEqual(
      { active: (await observe()) !== undefined, predecessor: await predecessor() },
      { active: false, predecessor: undefined },
    );
  });

  const broadGit = { endpoints: [{ host: "github.com", port: 443, protocol: "tcp" }] };
  const broadApi = { endpoints: [{ host: "API.GITHUB.COM", port: 443, protocol: "rest" }] };
  const broadSource = {
    ...stockSource,
    network_policies: { ...stockSource.network_policies, broadGit },
  };
  const opaqueModel = {
    ...sourceRule,
    endpoints: [{ host: "alias.example.test", port: 443 }],
  };
  const opaqueSource = { ...stockSource, network_policies: { model: opaqueModel } };
  await t.test("missing policy readback", async () => {
    overrides = { effective: expected, missingConfig: true };
    assert.equal(await observe(), undefined);
    // The predecessor caller receives the failed read for classification.
    await assert.rejects(predecessor(), /NOT_FOUND/);
  });
  for (const [label, evidence] of Object.entries({
    "missing admitted Sandbox policy": { sandboxPolicy: null },
    "missing effective Git rule": { effective: {} },
    "source revision not active": { active: 16 },
    "wrong active hash": { config: { policy_hash: "c".repeat(64) } },
    "wrong active Provider generation": { config: { provider_env_revision: "119" } },
    "replacement Sandbox": { sandboxId: "replacement" },
    "unexpected attached Provider": { providers: ["model", runtime, providerName, "other"] },
    "global policy override": { config: { policy_source: 2 } },
    "broad source Git route": {
      source: broadSource,
      sandboxPolicy: broadSource,
      effective: { ...expected, broadGit },
    },
    "overlapping Provider API route": { effective: { ...expected, _provider_other: broadApi } },
    "unexpected inspected Provider route": {
      effective: {
        ...expected,
        _provider_other: {
          name: "_provider_other",
          endpoints: [{ ...modelRule.endpoints[0], host: "other.example.test" }],
        },
      },
    },
    "opaque Provider alias": {
      effective: {
        ...expected,
        _provider_model: {
          name: "_provider_model",
          endpoints: [
            { ...modelEndpoint, host: "alias.example.test", tls: "NETWORK_TLS_MODE_SKIP" },
          ],
        },
      },
    },
    "opaque source endpoint": {
      source: opaqueSource,
      sandboxPolicy: opaqueSource,
      effective: { ...expected, model: opaqueModel },
    },
    "missing model token-grant owner": {
      effective: { ...expected, [modelRule.name]: modelRule },
    },
    "missing Git token-grant owner": {
      effective: { ...expected, [name]: gitRule },
    },
    "Git audit": {
      effective: {
        ...expected,
        [name]: {
          ...gitRule,
          endpoints: [
            {
              ...endpoint,
              token_grant_owner: stockGitOwner,
              enforcement: "NETWORK_ENFORCEMENT_MODE_AUDIT",
            },
          ],
        },
      },
    },
    "Git TLS skip": {
      effective: {
        ...expected,
        [name]: {
          ...gitRule,
          endpoints: [
            { ...endpoint, token_grant_owner: stockGitOwner, tls: "NETWORK_TLS_MODE_SKIP" },
          ],
        },
      },
    },
    "widened Git query": {
      effective: {
        ...expected,
        [name]: {
          ...gitRule,
          endpoints: [
            {
              ...endpoint,
              token_grant_owner: stockGitOwner,
              rules: [{ allow: { method: "GET", path: "/fixture/a.git/info/refs" } }],
            },
          ],
        },
      },
    },
  })) {
    await t.test(label, async () => {
      overrides = { effective: expected, ...evidence };
      assert.equal(await observe(), undefined);
      assert.equal(await predecessor(), undefined);
    });
  }

  await t.test("live policy drops admitted middleware from both readbacks", async () => {
    // The loaded source and effective policy agree with each other, and the Git rule
    // and live Provider generation still match. The admitted Sandbox policy still has the middleware.
    overrides = {
      source: sourceWithoutMiddleware,
      config: {
        policy: {
          ...sourceWithoutMiddleware,
          network_policies: { ...sourceWithoutMiddleware.network_policies, ...expected },
        },
      },
    };
    assert.equal(await observe(), undefined);
    assert.equal(await predecessor(), undefined);
  });

  await t.test("matching observation expires during effective policy readback", async (t) => {
    overrides = { effective: expected, ageDuringReadback: true };
    elapsedReadbackMs = 0;
    // Age the same report while the final Sandbox read is in flight.
    const monotonicNow = performance.now.bind(performance);
    t.mock.method(performance, "now", () => monotonicNow() + elapsedReadbackMs);
    assert.equal(await observe(), undefined);
    assert.equal(elapsedReadbackMs, 2_000);
  });

  await t.test(
    "predecessor requires supervisor readiness after effective policy readback",
    async () => {
      overrides = { effective: expected, ageDuringReadback: true };
      elapsedReadbackMs = 0;
      assert.equal(await predecessor(), undefined);
      assert.equal(elapsedReadbackMs, 2_000);
    },
  );
});

test("provider profile wire defaults preserve Git overlap enforcement", async (t) => {
  const workspace = "profile-wire";
  const provider = "oce-runtime-revision-1";
  const id = "oce-codex-runtime";
  const files = [
    {
      path: "runtime.json",
      content: "{{config.runtime_json}}",
      env_var: "OPENCLAW_PLUGIN_RUNTIME_MANIFEST",
    },
    {
      path: "config.toml",
      content: "{{config.config_toml}}",
      env_var: "OPENCLAW_PLUGIN_CODEX_CONFIG_TOML",
    },
    {
      path: "node-setup.json",
      content: "{{config.node_setup_json}}",
      env_var: "OPENCLAW_NODE_SETUP_ENVELOPE",
    },
    { path: "node-ca.pem", content: "{{config.node_ca_pem}}", env_var: "OPENCLAW_NODE_CA_PATH" },
  ];
  const runtime = {
    id,
    display_name: "Codex runtime files (OpenClaw Enterprise)",
    category: "PROVIDER_PROFILE_CATEGORY_OTHER",
    files,
    inference_capable: false,
  };
  const endpoints = [{ host: "model.example.test", port: 443 }];
  const credentials = [{ name: "model_key", env_vars: ["MODEL_KEY"] }];
  let response: { profile?: Record<string, unknown> } | undefined;
  const { client }: { client: GrpcOpenShellGatewayClient } = await gitExpiryGateway(t, {
    model: "model",
    workspace,
    sandbox: "sandbox",
    revisionId: "revision-1",
    deadline: "2030-01-01T00:00:00Z",
    platformProfile: false,
    configure(methods: Record<string, (request: Record<string, unknown>) => unknown>) {
      methods.GetProvider = (request) => {
        assert.equal(request.name, provider);
        return {
          provider: {
            type: id,
            profile_workspace: workspace,
            metadata: { name: provider, workspace, resource_version: "1" },
          },
        };
      };
      methods.GetProviderProfile = (request) => {
        assert.equal(request.id, id);
        assert.ok(request.workspace_scope && typeof request.workspace_scope === "object");
        assert.equal(
          "workspace" in request.workspace_scope && request.workspace_scope.workspace,
          workspace,
        );
        return response;
      };
    },
  });
  assert.ok(client instanceof GrpcOpenShellGatewayClient);
  const signal = AbortSignal.timeout(10_000);

  for (const lists of [{}, { endpoints }, { credentials }, { endpoints, credentials }]) {
    await t.test(
      `accepts runtime files with ${Object.keys(lists).join(" and ") || "omitted lists"}`,
      async () => {
        // The real codec omits empty repeated fields; the guard must still inspect this profile.
        response = { profile: { ...runtime, ...lists } };
        await checkOpenShellGitProviders(client, workspace, [provider], signal);
        const profile = await client.getProviderProfile(workspace, id, signal);
        assert.deepEqual(profile?.definition?.files, files);
        assert.deepEqual(profile?.definition?.endpoints, "endpoints" in lists ? endpoints : []);
        assert.deepEqual(
          profile?.definition?.credentials,
          "credentials" in lists ? credentials : [],
        );
      },
    );
  }

  await t.test("missing profile remains unverified", async () => {
    response = undefined;
    assert.equal(await client.getProviderProfile(workspace, id, signal), undefined);
    await assert.rejects(checkOpenShellGitProviders(client, workspace, [provider], signal), {
      name: OpenShellGitRouteError.name,
      reason: "provider_overlap",
    });
  });

  for (const profile of [undefined, { ...runtime, id: "another-profile" }]) {
    await t.test(
      profile ? "rejects mismatched profile ID" : "rejects absent profile envelope",
      async () => {
        response = profile ? { profile } : {};
        await assert.rejects(
          checkOpenShellGitProviders(client, workspace, [provider], signal),
          /GetProviderProfile returned another profile/,
        );
      },
    );
  }

  for (const overlap of [
    { endpoints: [{ host: "uploads.github.com", port: 443 }], credentials },
    { endpoints, credentials: [{ name: "github", env_vars: ["GITHUB_TOKEN"] }] },
  ]) {
    await t.test(
      `rejects overlap through ${overlap.endpoints === endpoints ? "GITHUB_TOKEN" : "GitHub hostname"}`,
      async () => {
        response = { profile: { ...runtime, ...overlap } };
        await assert.rejects(checkOpenShellGitProviders(client, workspace, [provider], signal), {
          name: OpenShellGitRouteError.name,
          reason: "provider_overlap",
        });
      },
    );
  }
});

test("reconciles a Workspace provider profile without replaying a failed write", async (t) => {
  const workspace = "profile-reconcile";
  const profile: Omit<OpenShellProviderProfile, "annotations"> = {
    id: "oce-source-profile",
    displayName: "Original profile",
    category: "PROVIDER_PROFILE_CATEGORY_OTHER",
    credentials: [],
    endpoints: [{ host: "tools.example.test", port: 443, protocol: "rest" }],
    binaries: ["/usr/bin/curl"],
    inferenceCapable: false,
  };
  const calls: string[] = [];
  let stored: Record<string, unknown> | undefined;
  let update: "success" | "matching" | "foreign" = "success";
  function profileFrom(value: unknown): Record<string, unknown> {
    assert.ok(value && typeof value === "object" && "profile" in value);
    assert.ok(value.profile && typeof value.profile === "object");
    return { ...value.profile };
  }
  function checkWorkspace(request: Record<string, unknown>) {
    const scope = request.workspace_scope;
    assert.ok(scope && typeof scope === "object" && "workspace" in scope);
    assert.equal(scope.workspace, workspace);
  }
  const { client }: { client: GrpcOpenShellGatewayClient } = await gitExpiryGateway(t, {
    model: "model",
    workspace,
    sandbox: "sandbox",
    revisionId: "revision-1",
    deadline: "2030-01-01T00:00:00Z",
    platformProfile: false,
    configure(methods: Record<string, (request: Record<string, unknown>) => unknown>) {
      methods.GetProviderProfile = (request) => {
        checkWorkspace(request);
        assert.equal(request.id, profile.id);
        calls.push("read");
        return stored && { profile: stored };
      };
      methods.ImportProviderProfiles = (request) => {
        checkWorkspace(request);
        assert.ok(Array.isArray(request.profiles) && request.profiles.length === 1);
        const incoming = profileFrom(request.profiles[0]);
        assert.equal(incoming.id, profile.id);
        calls.push("import");
        stored = { ...incoming, resource_version: "7" };
        return { imported: true };
      };
      methods.UpdateProviderProfiles = (request) => {
        checkWorkspace(request);
        assert.equal(request.id, profile.id);
        const incoming = profileFrom(request.profile);
        assert.equal(incoming.id, profile.id);
        assert.equal(request.expected_resource_version, stored?.resource_version);
        const version = String(request.expected_resource_version);
        calls.push("update:" + version);
        if (update !== "foreign") {
          stored = { ...incoming, resource_version: String(Number(version) + 1) };
        }
        return { updated: update === "success" };
      };
    },
  });
  assert.ok(client instanceof GrpcOpenShellGatewayClient);
  const signal = AbortSignal.timeout(10_000);
  const reconcile = (displayName: string) =>
    ensureOpenShellProviderProfile(client, workspace, { ...profile, displayName }, signal);

  await reconcile("Original profile");
  assert.deepEqual(calls.splice(0), ["read", "import"]);
  await reconcile("Original profile");
  assert.deepEqual(calls.splice(0), ["read"]);

  await reconcile("Updated profile");
  assert.deepEqual(calls.splice(0), ["read", "update:7"]);

  update = "matching";
  await reconcile("Concurrent matching profile");
  assert.deepEqual(calls.splice(0), ["read", "update:8", "read"]);

  update = "foreign";
  await assert.rejects(reconcile("Unapplied profile"), /UpdateProviderProfiles did not update/);
  assert.deepEqual(calls.splice(0), ["read", "update:9", "read"]);
  assert.equal(stored?.display_name, "Concurrent matching profile");
});
