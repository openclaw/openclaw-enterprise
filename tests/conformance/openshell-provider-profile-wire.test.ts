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
import { compileOpenShellBoundGitRule } from "../../apps/controller/src/drivers/sandbox/openshell-git-network-policy.ts";

test("the Sandbox wire policy binds exact Git routes to an endpointless Provider", async (t) => {
  const scope = {
    workspace: "profile-acl",
    workspaceId: "workspace-id",
    sandbox: "sandbox",
    executionId: "revision-1",
    installationId: "42",
    gitOrigin: "https://github.com",
    apiOrigin: "https://api.github.com",
    binaries: ["/usr/bin/git", "/usr/lib/git-core/git-remote-https"],
  } satisfies OpenShellPreparedGitScope;
  let addedProfileField: Record<string, unknown> | undefined;
  let wireSpec: unknown;
  const { client, world } = await gitExpiryGateway(t, {
    model: "model",
    workspace: scope.workspace,
    sandbox: scope.sandbox,
    revisionId: scope.executionId,
    deadline: "2030-01-01T00:00:00Z",
    platformProfile: false,
    configure(methods: Record<string, (request: Record<string, unknown>) => unknown>) {
      const getProfile = methods.GetProviderProfile!;
      methods.GetProviderProfile = (request) => {
        const response = getProfile(request) as { profile: Record<string, unknown> } | undefined;
        return response && addedProfileField
          ? { profile: { ...response.profile, ...addedProfileField } }
          : response;
      };
      methods.CreateSandbox = (request) => {
        wireSpec = request.spec;
        return {
          sandbox: {
            metadata: { id: "sandbox-id", name: scope.sandbox, workspace: scope.workspace },
            spec: request.spec,
          },
        };
      };
    },
  });
  const signal = AbortSignal.timeout(10_000);
  const binding = await new OpenShellPreparedGitProvider(client, {
    ...scope,
    nativeGit: "v1",
  }).bootstrap(signal);
  const profile = await client.getProviderProfile(scope.workspace, binding.profile, signal);
  assert.ok(profile?.definition);
  assert.deepEqual(profile.definition.endpoints, []);
  assert.deepEqual(profile.definition.binaries ?? [], []);
  assert.deepEqual(profile.definition.credentials, [
    {
      name: "installation_token",
      env_vars: ["GITHUB_TOKEN"],
      required: true,
      auth_style: "bearer",
      header_name: "authorization",
      stable_placeholder: true,
    },
  ]);

  const read = { repository: "fixture/a", access: "read" } as const;
  const write = { repository: "fixture/b", access: "write" } as const;
  const rule = compileOpenShellBoundGitRule([write, read], binding.provider, scope.binaries);
  assert.deepEqual(
    compileOpenShellBoundGitRule([read, write], binding.provider, scope.binaries),
    rule,
  );
  await client.createSandbox(
    {
      name: scope.sandbox,
      workspace: scope.workspace,
      requestId: "7dfed2b8-8cef-4513-ab04-020baf3ccbf3",
      labels: {},
      annotations: {},
      serviceExposures: [],
      spec: { providers: [binding.provider], policy: { network_policies: { [rule.name]: rule } } },
    },
    signal,
  );
  assert.deepEqual(wireSpec, {
    providers: [binding.provider],
    policy: {
      network_policies: {
        "repository-git-network": {
          name: "repository-git-network",
          binaries: [{ path: "/usr/bin/git" }, { path: "/usr/lib/git-core/git-remote-https" }],
          endpoints: [
            {
              host: "github.com",
              port: 443,
              protocol: "rest",
              enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
              credential_binding: { provider: binding.provider },
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
          ],
        },
      },
    },
  });

  // An endpointless managed Git credential still overlaps if offered as an ordinary Provider.
  await assert.rejects(
    checkOpenShellGitProviders(client, scope.workspace, [binding.provider], signal),
    {
      name: OpenShellGitRouteError.name,
      reason: "provider_overlap",
    },
  );
  const legacy = await new OpenShellPreparedGitProvider(client, scope).bootstrap(signal);
  assert.notEqual(legacy.profile, binding.profile);
  const legacyProfile = await client.getProviderProfile(scope.workspace, legacy.profile, signal);
  assert.deepEqual(legacyProfile?.definition?.endpoints, [
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
  assert.deepEqual(
    legacyProfile?.definition?.binaries,
    scope.binaries.map((path) => ({ path })),
  );

  // If readback after import introduces a network allow, stop before creating the Provider.
  const providerCreates = world.providerCreates.length;
  for (const [field, value] of Object.entries({
    endpoints: [{ host: "github.com", port: 443 }],
    binaries: [{ path: "/usr/bin/git" }],
  })) {
    addedProfileField = { [field]: value };
    await assert.rejects(
      new OpenShellPreparedGitProvider(client, {
        ...scope,
        executionId: `unexpected-${field}`,
        nativeGit: "v1",
      }).bootstrap(signal),
      { name: OpenShellPreparedGitProviderError.name, outcome: "unknown" },
    );
    assert.equal(world.providerCreates.length, providerCreates);
  }
});

test("the Git rule compiler rejects nonconcrete grants and transport paths", () => {
  const provider = "oce-github-installation-0123456789abcdef0123456789abcdef";
  const binaries = ["/usr/lib/git-core/git-remote-https"];
  const read = { repository: "fixture/a", access: "read" };
  for (const grants of [
    [],
    [Object.assign({}, read, { branch: "main" })],
    [Object.create(read) as unknown],
    [{ ...read, access: "admin" }],
    [read, { ...read, access: "write" }],
    ...[
      "a_b/repo",
      "Fixture/a",
      "fixture/.repo",
      "fixture/a.git",
      "fixture/..",
      "fixture/a\n",
      "fixture/a*",
      "fixture/a%2Fb",
    ].map((repository) => [{ ...read, repository }]),
    Array.from({ length: 33 }, (_, i) => ({ ...read, repository: `fixture/r${i}` })),
  ]) {
    assert.throws(
      () =>
        compileOpenShellBoundGitRule(
          grants as Parameters<typeof compileOpenShellBoundGitRule>[0],
          provider,
          binaries,
        ),
      /repository|grant/i,
    );
  }
  assert.throws(
    () =>
      compileOpenShellBoundGitRule([{ ...read, access: "read" }], "ordinary-provider", binaries),
    /installation Git Provider/,
  );
  for (const paths of [
    [],
    ["git"],
    ["/usr/*/git"],
    ["/usr/../bin/git"],
    ["/usr/./bin/git"],
    ["/usr//bin/git"],
    ["/usr/bin/git/"],
  ]) {
    assert.throws(
      () => compileOpenShellBoundGitRule([{ ...read, access: "read" }], provider, paths),
      /exact Git transport binary/,
    );
  }
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
