import {
  openShellModelRequestPolicy,
  verifyModelRequestPolicy,
  verifyModelRequestProfile,
} from "../../apps/controller/src/drivers/sandbox/openshell-model-request-policy.ts";
import { OPEN_SHELL_CODEX_BINARIES } from "../../apps/controller/src/drivers/sandbox/openshell-codex-artifacts.ts";
import { openShellProfileEndpoint } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { ProxyPlan } from "../../packages/contracts/src/index.ts";
import { OpenShellPreparedGitProvider } from "../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts";
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

test("model profile wire retains zero-cache token grants and output-only endpoint ownership", async (t) => {
  const workspace = "model-profile-wire";
  const name = "oce-model-" + "a".repeat(32);
  const tokenEndpoint = "https://authority.example.test/token";
  const profile = {
    id: name,
    displayName: "Request-authorized model access",
    category: "PROVIDER_PROFILE_CATEGORY_OTHER",
    credentials: [
      {
        name: "access_token",
        envVars: [],
        required: false,
        authStyle: "bearer",
        headerName: "Authorization",
        tokenGrant: {
          token_endpoint: tokenEndpoint,
          jwt_svid_audience: tokenEndpoint,
          audience: "018f923f-f00e-744b-8001-8423f0021bc0",
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          cache_ttl: { seconds: 0, nanos: 0 },
        },
      },
    ],
    endpoints: [
      {
        host: "api.example.test",
        port: 443,
        path: "/v1/responses",
        protocol: "rest",
        rules: [{ allow: { method: "POST", path: "/v1/responses" } }],
      },
    ],
    binaries: OPEN_SHELL_CODEX_BINARIES,
    inferenceCapable: false,
  } satisfies NonNullable<ReturnType<typeof openShellModelRequestPolicy>>["provider"]["profile"];
  const expected = {
    provider: { name, profile },
    host: "api.example.test",
    environment: { OPENAI_API_KEY: "oce:request-authorized:model" },
    registration: { name: "model-authority", audience: "model-authority", tokenEndpoint },
    middlewares: {
      "oce-model": {
        name: "oce-model",
        middleware: "model-authority",
        on_error: "fail_closed",
        endpoints: { include: ["api.example.test"] },
        order: 2147483646,
        config: {
          fields: {
            binding_id: { stringValue: profile.credentials[0]!.tokenGrant.audience },
            namespace_id: { stringValue: "namespace-1" },
            agent_id: { stringValue: "agent-1" },
            revision_id: { stringValue: "revision-1" },
          },
        },
      },
    },
  };
  const ruleName = "_provider_" + name.replaceAll("-", "_");
  let stored: Record<string, unknown> | undefined;
  const owner = "grant-owner:v1:" + "1".repeat(64);
  let ownerPresent = true;
  const { client }: { client: GrpcOpenShellGatewayClient } = await gitExpiryGateway(t, {
    model: name,
    workspace,
    sandbox: "sandbox",
    revisionId: "revision-1",
    deadline: "2030-01-01T00:00:00Z",
    platformProfile: false,
    configure(methods: Record<string, (request: Record<string, unknown>) => unknown>) {
      methods.ImportProviderProfiles = (request) => {
        assert.ok(Array.isArray(request.profiles));
        const item = request.profiles[0] as { profile: Record<string, unknown> };
        stored = { ...item.profile, scope: "workspace", resource_version: "1" };
        return { imported: true };
      };
      methods.GetProviderProfile = () => ({ profile: stored });
      methods.GetSandboxConfig = () => ({
        workspace,
        policy_source: 1,
        configuration_admitted: true,
        policy_validation_failure_mode: "fail_closed",
        extension_authentication_enabled: true,
        supervisor_middleware_services: [
          {
            name: "model-authority",
            audience: "model-authority",
            grpc_endpoint: "https://authority.example.test:9443",
            binding_policy: 2,
            bindings: [1],
          },
        ],
        policy: {
          network_middlewares: expected.middlewares,
          network_policies: {
            [ruleName]: {
              name: ruleName,
              binaries: profile.binaries.map((path) => ({ path })),
              endpoints: profile.endpoints.map((endpoint) => ({
                ...openShellProfileEndpoint(endpoint),
                provider_credentialed: true,
                ...(ownerPresent && { token_grant_owner: owner }),
              })),
            },
          },
        },
      });
    },
  });
  const signal = AbortSignal.timeout(10000);
  // Both request serialization and response decoding use the real gRPC client.
  // This proves the adapter preserves upstream fields, not that an installed supervisor enforces them.
  await client.importProviderProfile(workspace, { ...profile, annotations: {} }, signal);
  const read = () => client.getProviderProfile(workspace, name, signal);
  verifyModelRequestProfile(await read(), profile, workspace);
  const credential = (stored!.credentials as { token_grant: Record<string, unknown> }[])[0]!;
  assert.deepEqual(credential.token_grant.cache_ttl, { seconds: "0", nanos: 0 });
  const grant = structuredClone(credential.token_grant);
  for (const mutation of [
    { ...grant, cache_ttl: undefined },
    { ...grant, cache_ttl: { seconds: 1 } },
    { ...grant, audience: "another-binding" },
    { ...grant, token_endpoint: "https://wrong.example.test/token" },
    { ...grant, jwt_svid_audience: "wrong-recipient" },
  ]) {
    credential.token_grant = mutation;
    const observed = await read();
    assert.throws(
      () => verifyModelRequestProfile(observed, profile, workspace),
      /zero-cache model token grant/,
    );
  }
  credential.token_grant = grant;
  const config = await client.getSandboxConfig(workspace, "sandbox", signal);
  verifyModelRequestPolicy(config, expected, workspace);
  assert.deepEqual(config.tokenGrantOwners, { [ruleName]: [owner] });
  const policy = config.policy as {
    network_policies: Record<string, { endpoints: Record<string, unknown>[] }>;
  };
  assert.equal(
    Object.hasOwn(policy.network_policies[ruleName]!.endpoints[0]!, "token_grant_owner"),
    false,
  );
  ownerPresent = false;
  const missingOwner = await client.getSandboxConfig(workspace, "sandbox", signal);
  assert.throws(
    () => verifyModelRequestPolicy(missingOwner, expected, workspace),
    /token grant provider/,
  );
});

test("Gateway assertion profiles use the exact supported wire and refuse a downgraded grant", async (t) => {
  const workspace = "model-profile-wire";
  const capability = "openshell-profile-openshell-gateway-assertion-source";
  const tokenEndpoint = "https://authority.example.test/token";
  const options = {
    middlewareName: "model-authority",
    authorityScope: "execution",
    requestCredentials: {
      audience: "model-authority",
      tokenEndpoint,
      assertionSource: "openshell_gateway",
    },
  } as const;
  const execution = {
    installationId: "installation",
    namespaceId: "namespace",
    agentId: "agent",
    servicePrincipalId: "principal",
    revisionId: "revision",
    executionId: "execution",
  };
  const policyRef = { id: "model-policy", generation: 1 };
  const plan: ProxyPlan = {
    authorization: "online-request",
    id: "plan",
    generation: 1,
    execution,
    sandboxDriverId: "openshell",
    egressDriverId: "openshell",
    routes: [
      {
        route: { id: "model-route", generation: 1 },
        origin: "https://api.example.test",
        path: "/v1/responses",
        method: "POST",
        operationPolicy: policyRef,
        responsePolicy: policyRef,
        deadlineMs: 30_000,
        binding: {
          binding: { id: "binding", generation: 1 },
          execution,
          source: {
            installationId: execution.installationId,
            namespaceId: execution.namespaceId,
            source: { id: "source", generation: 1 },
            backend: { id: "backend", generation: 1 },
            provider: { id: "openai-online-request", generation: 1 },
          },
          grant: { kind: "inference", models: ["model"], providerTools: "none" },
          grantHash: "model-grant",
          isolationId: "model-isolation",
        },
      },
    ],
  };
  const identity = {
    id: execution.revisionId,
    agentId: execution.agentId,
    namespaceId: execution.namespaceId,
  };
  const native = { ...identity, harness: { id: "openclaw", mode: "dedicated" } } as const;
  const codex = { ...identity, harness: { id: "codex", mode: "dedicated" } } as const;
  const policy = openShellModelRequestPolicy(plan, options, native);
  const codexPolicy = openShellModelRequestPolicy(plan, options, codex);
  assert.ok(policy && codexPolicy);
  assert.deepEqual(policy.provider.profile.binaries, ["/usr/local/bin/node"]);
  assert.deepEqual(codexPolicy.provider.profile.binaries, OPEN_SHELL_CODEX_BINARIES);
  const expectedWire = {
    token_endpoint: tokenEndpoint,
    audience: "binding",
    grant_type: 3,
    cache_ttl: { seconds: "0", nanos: 0 },
  };
  const { name, profile } = policy.provider;
  const spire = {
    ...options,
    requestCredentials: { audience: options.requestCredentials.audience, tokenEndpoint },
  };
  assert.throws(() => openShellModelRequestPolicy(plan, spire, native), /dedicated Harness/);
  assert.equal(
    openShellModelRequestPolicy(plan, spire, codex)?.provider.profile.credentials[0]?.tokenGrant
      .jwt_svid_audience,
    tokenEndpoint,
  );

  const calls: string[] = [];
  let supportsGatewayAssertion = false;
  let stored: Record<string, unknown> | undefined;
  let lintRequest: Record<string, unknown> | undefined;
  let importRequest: Record<string, unknown> | undefined;
  let importCapability: unknown[] = [];
  let readCapability: unknown[] = [];
  function profileFrom(request: Record<string, unknown>) {
    assert.deepEqual(request.workspace_scope, { workspace, selection: "workspace" });
    assert.ok(Array.isArray(request.profiles) && request.profiles.length === 1);
    const item = request.profiles[0] as { profile: Record<string, unknown> };
    const credentials = item.profile.credentials as { token_grant: Record<string, unknown> }[];
    assert.deepEqual(credentials[0]?.token_grant, expectedWire);
    return item.profile;
  }
  const { client }: { client: GrpcOpenShellGatewayClient } = await gitExpiryGateway(t, {
    model: name,
    workspace,
    sandbox: "sandbox",
    revisionId: execution.revisionId,
    deadline: "2030-01-01T00:00:00Z",
    platformProfile: false,
    configure(
      methods: Record<
        string,
        (request: Record<string, unknown>, metadata: { get(key: string): unknown[] }) => unknown
      >,
    ) {
      methods.LintProviderProfiles = (request) => {
        calls.push("lint");
        lintRequest = request;
        return {
          valid: true,
          supports_openshell_gateway_assertion_source: supportsGatewayAssertion,
        };
      };
      methods.ImportProviderProfiles = (request, metadata) => {
        calls.push("import");
        importCapability = metadata.get(capability);
        importRequest = request;
        const item = (request.profiles as { profile: Record<string, unknown> }[])[0]!;
        stored = { ...item.profile, scope: "workspace", resource_version: "1" };
        return { imported: true };
      };
      methods.GetProviderProfile = (request, metadata) => {
        calls.push("get");
        assert.equal(request.id, name);
        readCapability = metadata.get(capability);
        return { profile: stored };
      };
    },
  });
  const importProfile = () =>
    client.importProviderProfile(workspace, { ...profile, annotations: {} }, t.signal);
  await assert.rejects(importProfile(), /does not support Gateway assertions/);
  assert.deepEqual(calls.splice(0), ["lint"]);
  assert.ok(lintRequest);
  profileFrom(lintRequest);
  supportsGatewayAssertion = true;
  await importProfile();
  const read = () => client.getProviderProfile(workspace, name, t.signal);
  verifyModelRequestProfile(await read(), profile, workspace);
  assert.ok(importRequest);
  profileFrom(importRequest);
  assert.deepEqual(importCapability, ["1"]);
  assert.deepEqual(readCapability, ["1"]);
  assert.deepEqual(calls.splice(0), ["lint", "import", "get"]);
  const [credential] = stored!.credentials as { token_grant: Record<string, unknown> }[];
  for (const grantType of [undefined, 1, 2, 4]) {
    credential!.token_grant.grant_type = grantType;
    const downgraded = await read();
    assert.throws(
      () => verifyModelRequestProfile(downgraded, profile, workspace),
      /zero-cache model token grant/,
    );
  }
});

test("Git grant provider creates an empty attachment for a single repository read route", async (t) => {
  const workspace = "git-profile-wire";
  const workspaceId = "workspace-id";
  const providerId = "immutable-git-provider";
  const tokenEndpoint = "https://git-authority.example.test/token";
  const bindingId = "git-execution-id";
  const repository = "example/repo";
  const calls: string[] = [];
  let imported: Record<string, unknown> | undefined;
  let created: Record<string, unknown> | undefined;
  const { client }: { client: GrpcOpenShellGatewayClient } = await gitExpiryGateway(t, {
    model: "model",
    workspace,
    sandbox: "sandbox",
    revisionId: "revision",
    deadline: "2030-01-01T00:00:00Z",
    platformProfile: false,
    configure(methods: Record<string, (request: Record<string, unknown>) => unknown>) {
      methods.GetWorkspace = () => ({
        workspace: { metadata: { name: workspace, id: workspaceId } },
      });
      methods.GetProvider = () => undefined;
      methods.GetProviderProfile = () => (imported ? { profile: imported } : undefined);
      methods.LintProviderProfiles = () => ({
        valid: true,
        supports_openshell_gateway_assertion_source: true,
      });
      methods.ImportProviderProfiles = (request) => {
        calls.push("profile");
        const item = (request.profiles as { profile: Record<string, unknown> }[])[0]!;
        imported = { ...item.profile, scope: "workspace", resource_version: "1" };
        return { imported: true };
      };
      methods.CreateProvider = (request) => {
        calls.push("create");
        created = request;
        const provider = request.provider as Record<string, unknown>;
        return {
          provider: {
            ...provider,
            profile_workspace: workspace,
            metadata: {
              ...(provider.metadata as Record<string, unknown>),
              id: providerId,
              workspace,
              resource_version: "2",
            },
          },
        };
      };
    },
  });
  const provider = new OpenShellPreparedGitProvider(client, {
    workspace,
    workspaceId,
    sandbox: "sandbox",
    executionId: "revision",
    installationId: "41",
    gitOrigin: "https://github.com",
    apiOrigin: "https://api.github.com",
    binaries: ["/usr/bin/git"],
    observedHookPreview: true,
    tokenGrant: { endpoint: tokenEndpoint, audience: bindingId, repository },
  });
  const binding = await provider.bootstrap(t.signal);
  assert.ok(imported && created);
  assert.equal(binding.credentialState, "bootstrap");
  assert.equal(binding.providerId, providerId);
  const [credential] = imported.credentials as Record<string, unknown>[];
  assert.equal(credential?.auth_style, "basic");
  assert.equal(credential?.header_name, "Authorization");
  assert.deepEqual(credential?.token_grant, {
    token_endpoint: tokenEndpoint,
    audience: bindingId,
    grant_type: 3,
    cache_ttl: { seconds: "0", nanos: 0 },
  });
  assert.equal(credential?.env_vars, undefined);
  assert.equal(credential?.stable_placeholder, undefined);
  const sent = created.provider as Record<string, unknown>;
  assert.equal(sent.credentials, undefined);
  assert.equal(sent.credential_expiration_times, undefined);
  assert.deepEqual(imported.binaries, [
    { path: "/usr/lib/git-core/git-remote-http" },
    { path: "/usr/bin/curl" },
  ]);
  const [endpoint] = imported.endpoints as Record<string, unknown>[];
  assert.equal(endpoint?.host, "github.com");
  assert.equal(endpoint?.path, "/example/repo.git/**");
  assert.deepEqual(
    (endpoint?.rules as { allow: { method: string; path: string } }[]).map(({ allow }) => [
      allow.method,
      allow.path,
    ]),
    [
      ["GET", "/example/repo.git/info/refs"],
      ["POST", "/example/repo.git/git-upload-pack"],
      ["GET", "/example/repo.git/oce-observe-request/*/info/refs"],
    ],
  );
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  assert.deepEqual(provider.activateGrant(binding, expiresAt), {
    ...binding,
    expiresAt,
    credentialState: "active",
  });
  await assert.rejects(
    provider.rotate(
      binding,
      async () => assert.fail("grant rotation must not read token material"),
      t.signal,
    ),
    { outcome: "refused" },
  );
  assert.deepEqual(calls, ["profile", "create"]);
});
