import assert from "node:assert/strict";
import test from "node:test";
import { gitExpiryGateway } from "../helpers/openshell-online-git-journey.mjs";
import { ensureOpenShellProviderProfile } from "../../apps/controller/src/backends/openshell.ts";
import {
  GrpcOpenShellGatewayClient,
  type OpenShellProviderProfile,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
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

  for (const { name, policy } of [
    { name: "empty policy", policy: [] },
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
