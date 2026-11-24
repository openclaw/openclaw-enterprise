import assert from "node:assert/strict";
import test from "node:test";
import { directGitLaunchVerifier, traceDirectGitBootstrap } from "../helpers/finite-git-agent.ts";
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

test("direct Git bootstrap reports missing readiness and a mismatched loaded selector", async (t) => {
  const workspace = "acl-diag-private";
  const sandbox = "bootstrap-test";
  const sandboxId = "selected-sandbox-id";
  const scope = {
    workspace,
    workspaceId: "workspace-id",
    sandbox,
    executionId: "revision-1",
    installationId: "42",
    gitOrigin: "https://github.com",
    apiOrigin: "https://api.github.com",
    binaries: ["/usr/bin/git", "/usr/lib/git-core/git-remote-https"],
    nativeGit: "v1",
    repositoryNetworkPolicy: [
      { repository: "fixture/a", access: "read" },
      { repository: "fixture/b", access: "write" },
    ],
    expectedProviders: [],
  } satisfies OpenShellPreparedGitScope;
  let mode:
    | "pending"
    | "widened"
    | "unactivated"
    | "unexpected-path"
    | "extra-write"
    | "foreign-owner"
    | "different-command"
    | "ready" = "pending";
  // One change to what the Gateway reports in the ready state. The supervisor's own
  // Provider report stays READY, so only the policy readback can refuse it.
  let departure: {
    readonly authored?: Record<string, unknown>;
    readonly effective?: Record<string, unknown>;
    readonly config?: Record<string, unknown>;
    readonly activeVersion?: number;
    readonly sandboxId?: string;
    readonly networkProcess?: string;
    readonly admission?: Record<string, unknown>;
  } = {};
  const generation = {
    attachment_epoch: "installed-attachment",
    provider_env_revision: "3",
    config_revision: "4",
    policy_hash: "controlled-policy-hash",
  };
  const filesystem = {
    read_only: ["/usr", "/bin", "/lib", "/lib64", "/etc"],
    read_write: ["/tmp", "/dev/null"],
  };
  const launch = () => ({
    name: sandbox,
    workspace,
    requestId: "owned-create",
    labels: { "openclaw.dev/git-acl-test-run": "run-owner" },
    annotations: {},
    serviceExposures: [],
    spec: {
      template: { image: "fixture-image" },
      command: ["/bin/sh", "-c", "sleep 3600"],
      providers: [binding.provider],
      policy: {
        version: 1,
        filesystem,
        process: { run_as_user: "1000", run_as_group: "1000" },
        network_policies: { [rule.name]: rule, ...departure.authored },
      },
    },
  });
  const policy = () => ({
    ...launch().spec.policy,
    filesystem: {
      read_only: [
        ...filesystem.read_only,
        "/var/log",
        "/proc",
        "/dev/urandom",
        ...(mode === "unexpected-path" ? ["/other"] : []),
      ],
      read_write: [...filesystem.read_write, ...(mode === "extra-write" ? ["/proc"] : [])],
    },
  });
  const { client } = await gitExpiryGateway(t, {
    model: "model",
    workspace,
    sandbox,
    revisionId: scope.executionId,
    deadline: "2030-01-01T00:00:00Z",
    platformProfile: false,
    configure(methods: Record<string, (request: Record<string, unknown>) => unknown>) {
      methods.GetSandboxProviderStatus = () => {
        const now = { seconds: Math.floor(Date.now() / 1000) };
        return {
          status: {
            state:
              mode === "pending"
                ? "PROVIDER_READINESS_STATE_PENDING"
                : "PROVIDER_READINESS_STATE_READY",
            reason:
              mode === "pending"
                ? "PROVIDER_READINESS_REASON_WAITING_FOR_CREDENTIALS"
                : "PROVIDER_READINESS_REASON_UNSPECIFIED",
            receipt: {
              workspace,
              provider: binding.provider,
              desired: {
                sandbox,
                sandbox_id: sandboxId,
                provider_id: binding.providerId,
                provider_resource_version: binding.resourceVersion,
                ...generation,
              },
            },
            observed: {
              ...generation,
              session_id: "installed-session",
              sequence: "1",
              process_instance_id: "installed-process",
              credentials_installed: mode !== "pending",
              policy_active: true,
              launch_environment_installed: true,
            },
            network_instance_id: "installed-network",
            evaluated_time: now,
            observed_time: now,
          },
        };
      };
      methods.GetSandboxPolicyStatus = () => ({
        active_version: departure.activeVersion ?? 2,
        revision: { version: 2, status: 2, policy: policy() },
      });
      methods.GetSandboxConfig = () => {
        const layer = "_provider_" + binding.provider.replaceAll("-", "_");
        return {
          workspace,
          version: 2,
          policy_source: 1,
          configuration_admitted: true,
          configuration_instance_id: "admitted-config",
          policy_validation_failure_mode: "fail_closed",
          provider_attachment_epoch: generation.attachment_epoch,
          provider_env_revision: generation.provider_env_revision,
          config_revision: generation.config_revision,
          policy_hash: generation.policy_hash,
          policy: {
            ...policy(),
            ...departure.effective,
            network_policies: {
              [layer]: { name: layer },
              ...departure.authored,
              [rule.name]: {
                ...rule,
                endpoints: rule.endpoints.map((endpoint) => ({
                  ...endpoint,
                  provider_credentialed: true,
                  ...(mode === "widened" && { path: "/**" }),
                })),
              },
            },
          },
          ...departure.config,
        };
      };
      methods.GetSandbox = () => ({
        sandbox: {
          metadata: {
            id: departure.sandboxId ?? sandboxId,
            name: sandbox,
            workspace,
            labels:
              mode === "foreign-owner"
                ? { "openclaw.dev/git-acl-test-run": "other-owner" }
                : launch().labels,
          },
          // GetSandbox retains the authored creation policy even after stock syncs
          // the baseline-enriched source policy at policy revision 2.
          spec: {
            ...launch().spec,
            provider_attachment_epoch: generation.attachment_epoch,
            ...(mode === "different-command" && { command: ["/bin/false"] }),
          },
          status: {
            main_process_instance_id: departure.networkProcess ?? "installed-network",
            configuration_activated: mode !== "unactivated",
            configuration_admission: {
              state: 2,
              instance_id: "admitted-config",
              policy_version: 2,
              policy_hash: generation.policy_hash,
              provider_env_revision: generation.provider_env_revision,
              config_revision: generation.config_revision,
              ...departure.admission,
            },
          },
        },
      });
    },
  });
  const trace = traceDirectGitBootstrap(client);
  const provider = new OpenShellPreparedGitProvider(trace.client, {
    ...scope,
    managedSandbox: true,
  });
  const binding = await provider.bootstrap(t.signal);
  const rule = compileOpenShellBoundGitRule(
    scope.repositoryNetworkPolicy,
    binding.provider,
    scope.binaries,
  );
  const request = launch();
  const verifier = directGitLaunchVerifier(request);
  // Mutate the caller's object after capture. The verifier remains tied to the
  // original metadata and startup intent.
  request.labels["openclaw.dev/git-acl-test-run"] = "changed-after-capture";
  const observe = () => {
    trace.reset();
    return provider.observe(binding, sandboxId, t.signal, undefined, verifier);
  };

  assert.equal(await observe(), undefined);
  const pending = trace.summary(binding, sandboxId, rule);
  assert.equal(pending.provider?.reason, "PROVIDER_READINESS_REASON_WAITING_FOR_CREDENTIALS");
  assert.equal(pending.reads.getSandboxConfig, "unread");

  mode = "widened";
  assert.equal(await observe(), undefined);
  const widened = trace.summary(binding, sandboxId, rule);
  assert.equal(widened.provider?.ready, true);
  assert.equal(widened.policy?.sourceRuleMatches, true);
  assert.equal(widened.policy?.effectiveRuleMatches, false);
  assert.equal(widened.reads.getSandbox, "unread");
  assert.ok(!JSON.stringify(widened).includes(workspace), "diagnostics include no wire identity");

  mode = "unactivated";
  assert.equal(await observe(), undefined);
  const unactivated = trace.summary(binding, sandboxId, rule);
  assert.equal(unactivated.policy?.effectiveRuleMatches, true);
  assert.equal(unactivated.reads.getSandbox, "returned");
  assert.equal(unactivated.sandbox?.hasActivatedConfiguration, false);

  for (const refusal of [
    "unexpected-path",
    "extra-write",
    "foreign-owner",
    "different-command",
  ] as const) {
    mode = refusal;
    assert.equal(await observe(), undefined, refusal);
    const diagnostic = trace.summary(binding, sandboxId, rule);
    assert.equal(diagnostic.policy?.effectiveRuleMatches, true, refusal);
    assert.equal(diagnostic.reads.getSandbox, "returned", refusal);
  }

  mode = "ready";
  const creationPolicyObserver = new OpenShellPreparedGitProvider(client, scope);
  assert.equal(await creationPolicyObserver.observe(binding, sandboxId, t.signal), undefined);
  const installed = await observe();
  assert.equal(
    installed?.credentialState,
    "bootstrap",
    JSON.stringify(trace.summary(binding, sandboxId, rule)),
  );
  const ready = trace.summary(binding, sandboxId, rule);
  assert.equal(ready.sandbox?.configurationMatches, true);
  assert.equal(ready.sandbox?.launchPolicyMatches, false);

  const observeWith = (next: typeof departure) => {
    departure = next;
    // The launch verifier is bound to the launch that carries the authored rules.
    return provider.observe(
      binding,
      sandboxId,
      t.signal,
      undefined,
      directGitLaunchVerifier(launch()),
    );
  };
  const inspected = {
    host: "sibling.example.test",
    port: 443,
    protocol: "rest",
    rules: [{ allow: { method: "GET", path: "/status" } }],
  };
  const { protocol: _protocol, ...uninspected } = inspected;
  const sibling = { name: "sibling", binaries: [{ path: "/usr/bin/curl" }] };
  const beside = (endpoint: Record<string, unknown>) => ({
    authored: { sibling: { ...sibling, endpoints: [endpoint] } },
  });
  // An inspected literal destination beside the Git rule passes the readback. Each refusal
  // below therefore follows from its one change, not from the presence of a sibling.
  assert.equal((await observeWith(beside(inspected)))?.credentialState, "bootstrap");
  for (const [label, next] of Object.entries({
    // Stock can relay SQL without inspecting the stream, so the route could carry Git.
    "an SQL relay beside the Git rule": beside({ ...inspected, protocol: "sql" }),
    "a sibling without an inspected protocol": beside(uninspected),
    "a sibling that skips TLS termination": beside({
      ...inspected,
      tls: "NETWORK_TLS_MODE_SKIP",
    }),
    "a wildcard sibling host": beside({ ...inspected, host: "*.example.test" }),
    "a second GitHub host": beside({ ...inspected, host: "uploads.github.com" }),
    "a sibling pinned to an address": beside({ ...inspected, allowed_ips: ["192.0.2.1"] }),
    "a sibling that admits uninspected credentials": beside({
      ...inspected,
      allow_uninspected_credentials: true,
    }),
    "an authored rule under a Provider layer name": {
      authored: {
        _provider_authored: { ...sibling, name: "_provider_authored", endpoints: [inspected] },
      },
    },
    "an effective process identity that differs from the source": {
      effective: { process: { run_as_user: "0", run_as_group: "0" } },
    },
    "a Gateway-global policy source": { config: { policy_source: 2 } },
    "a Gateway-global policy version": { config: { global_policy_version: 1 } },
    "an effective config of another policy version": { config: { version: 3 } },
    "a source revision that is not the active one": { activeVersion: 3 },
    "another effective policy hash": { config: { policy_hash: "other-policy-hash" } },
    "another Provider environment revision": { config: { provider_env_revision: "119" } },
    "another Provider attachment": { config: { provider_attachment_epoch: "other" } },
    "a validation mode that does not fail closed": {
      config: { policy_validation_failure_mode: "fail_open" },
    },
    "a replacement Sandbox under the same name": { sandboxId: "replacement-sandbox-id" },
    "another network supervisor process": { networkProcess: "other-network" },
    "an admission of another policy hash": { admission: { policy_hash: "other-policy-hash" } },
  } satisfies Record<string, typeof departure>)) {
    await t.test(`policy readback refuses ${label}`, async () => {
      assert.equal(await observeWith(next), undefined);
    });
  }
  // No refusal is retained: the unchanged ready state passes again.
  assert.equal((await observeWith({}))?.credentialState, "bootstrap");
});

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
  let member = false;
  let anotherProvider: string | undefined;
  let pageToken: string | undefined;
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
      methods.ListWorkspaceMembers = () => ({
        members: member ? [{ principal_subject: "other-writer" }] : [],
      });
      methods.ListSandboxes = () => ({
        sandboxes: [
          { metadata: { id: "sandbox-id", workspace: scope.workspace }, spec: wireSpec },
          {
            metadata: { id: "unrelated", workspace: scope.workspace },
            spec: { providers: anotherProvider ? [anotherProvider] : [] },
          },
        ],
        next_page_token: pageToken,
      });
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
              path: "/fixture/a.git/**",
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
              ],
            },
            {
              host: "github.com",
              port: 443,
              path: "/fixture/b.git/**",
              protocol: "rest",
              enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
              credential_binding: { provider: binding.provider },
              rules: [
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

  const exclusive = () =>
    client.readExclusivePreviewWorkspace(scope.workspace, "sandbox-id", signal, binding.provider);
  assert.equal(await exclusive(), true, "an unrelated Sandbox may coexist");
  anotherProvider = binding.provider;
  assert.equal(await exclusive(), false, "a second attachment refuses material");
  anotherProvider = undefined;
  pageToken = "another-page";
  assert.equal(await exclusive(), false, "a partial inventory cannot establish exclusivity");
  pageToken = undefined;
  member = true;
  assert.equal(await exclusive(), false, "the workspace must have isolated writers");

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
