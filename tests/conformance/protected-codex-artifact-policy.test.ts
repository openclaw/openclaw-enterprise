import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { ConfigurationValidationError } from "../../packages/contracts/src/index.ts";
import type {
  AgentRevision,
  ComputeServiceAccess,
  SandboxPolicySnapshot,
  ProxyRevisionContext,
} from "../../packages/contracts/src/index.ts";
import {
  openShellEgressConfiguration,
  OpenShellCredentialProxyDriver,
} from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { openShellProtectedCodexArtifacts } from "../../apps/controller/src/drivers/sandbox/openshell-codex-artifacts.ts";
import { openShellGitRuntimeFixture } from "../helpers/openshell-git-runtime.ts";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type { OpenShellNetworkPolicyRule } from "../../apps/controller/src/drivers/sandbox/openshell.ts";

const native =
  "/app/node_modules/openclaw/node_modules/.pnpm/@openai+codex@0.164.0-linux-x64/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex";

function artifact(): OpenShellNetworkPolicyRule {
  return {
    name: "codex-plugin-artifacts",
    binaries: [{ path: native }],
    endpoints: [
      {
        host: "sdmntprsouthcentralus.oaiusercontent.com",
        ports: [443],
        protocol: "rest",
        enforcement: "enforce",
        access: "read_only",
      },
    ],
  };
}

function newBackend() {
  return createOpenShellBackend({
    id: "artifact-backend",
    type: "openshell",
    configuration: { endpoint: "http://127.0.0.1:9", insecureTransport: "network-policy" },
    drivers: {
      sandbox: "artifact-sandbox",
      credential_gateway: "artifact-credentials",
      credential_proxy: "artifact-sandbox",
    },
  });
}

function sandbox(
  t: TestContext,
  rules: readonly OpenShellNetworkPolicyRule[],
  names?: readonly string[],
  backend = newBackend(),
) {
  t.after(() => backend.client.close());
  return new OpenShellSandboxDriver(
    {
      gateway: { workspaceMode: "operator" },
      kubernetes: {
        runtimeClassName: "openshell-sandbox",
        userNamespaces: false,
        serviceAccount: { mode: "gatewayConfigured" },
        sandboxDataMount: {
          subPath: "workspace",
          mountPath: "/sandbox/enterprise",
          readOnly: false,
        },
      },
      policy: {
        process: { runAsUser: "1000", runAsGroup: "1000" },
        networkPolicies: rules,
        ...(names === undefined ? {} : { codexArtifactRuleNames: names }),
      },
    },
    { id: "artifact-sandbox", backend },
  );
}

test("protected Codex admission carries only the explicitly declared credential-free artifact rule", (t) => {
  const selected = artifact();
  const ambient: OpenShellNetworkPolicyRule = {
    name: "ambient-model",
    binaries: [{ path: "/usr/bin/node" }],
    endpoints: [{ host: "api.openai.com", ports: [443], tls: "skip", access: "full" }],
  };
  const unselected = { ...artifact(), name: "unselected-artifact" };
  const driver = sandbox(t, [selected, ambient, unselected], [selected.name]);
  const admission = driver.admitProtectedCodexArtifactPolicy(7);
  assert.equal(admission.purpose, "protected-codex-artifacts");
  assert.deepEqual(admission.declaredRuleNames, [selected.name]);
  const snapshot = admission.snapshot;
  assert.deepEqual(snapshot, {
    driverId: "artifact-sandbox",
    implementation: "openshell",
    version: 7,
    additions: [],
    defaults: {
      "codex-plugin-artifacts": {
        name: selected.name,
        binaries: [{ path: native }],
        endpoints: [
          {
            host: "sdmntprsouthcentralus.oaiusercontent.com",
            ports: [443],
            protocol: "rest",
            enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
            access: "NETWORK_ACCESS_PRESET_READ_ONLY",
          },
        ],
      },
    },
  });
});

test("qualified-looking ambient defaults grant no protected artifact access without declaration", (t) => {
  assert.deepEqual(
    sandbox(t, [artifact()]).admitProtectedCodexArtifactPolicy(1).snapshot.defaults,
    {},
  );
});

test("artifact qualification refuses routes that widen destination, process, write or TLS authority", async (t) => {
  const original = artifact();
  const endpoint = original.endpoints[0]!;
  const cases: Array<[string, OpenShellNetworkPolicyRule]> = [
    ["wildcard", { ...original, endpoints: [{ ...endpoint, host: "*.oaiusercontent.com" }] }],
    ["IP", { ...original, endpoints: [{ ...endpoint, host: "198.18.0.5" }] }],
    ["numeric address alias", { ...original, endpoints: [{ ...endpoint, host: "0x7f.0.0.1" }] }],
    ["repository host", { ...original, endpoints: [{ ...endpoint, host: "github.com" }] }],
    ["another port", { ...original, endpoints: [{ ...endpoint, ports: [8443] }] }],
    ["uninspected TLS", { ...original, endpoints: [{ ...endpoint, tls: "skip" }] }],
    [
      "unsupported explicit termination",
      { ...original, endpoints: [{ ...endpoint, tls: "terminate" }] },
    ],
    ["audit only", { ...original, endpoints: [{ ...endpoint, enforcement: "audit" }] }],
    ["write access", { ...original, endpoints: [{ ...endpoint, access: "read_write" }] }],
    ["another process", { ...original, binaries: [{ path: "/usr/bin/curl" }] }],
    [
      "package registry for a non-Codex executable",
      {
        ...original,
        binaries: [{ path: "/usr/local/bin/node" }],
        endpoints: [{ ...endpoint, host: "registry.npmjs.org" }],
      },
    ],
  ];
  for (const [name, rule] of cases) {
    await t.test(name, (context) => {
      assert.throws(
        () => sandbox(context, [rule], [rule.name]).admitProtectedCodexArtifactPolicy(1),
        ConfigurationValidationError,
      );
    });
  }
});

test("artifact declaration rejects unknown and duplicate rule names instead of importing defaults", async (t) => {
  for (const names of [["missing"], [artifact().name, artifact().name]]) {
    await t.test(names.length === 1 ? "unknown" : "duplicate", (context) => {
      assert.throws(
        () => sandbox(context, [artifact()], names).admitProtectedCodexArtifactPolicy(1),
        ConfigurationValidationError,
      );
    });
  }
});

function protectedRevision(snapshot: SandboxPolicySnapshot): AgentRevision {
  const repository = openShellGitRuntimeFixture().revision.repositoryCredentials!;
  const execution = {
    installationId: "ins_artifact",
    namespaceId: "ns_artifact",
    agentId: "agt_artifact",
    servicePrincipalId: "spr_artifact",
    revisionId: "rev_artifact",
    executionId: "rev_artifact",
  };
  return {
    id: execution.revisionId,
    namespaceId: execution.namespaceId,
    agentId: execution.agentId,
    revision: 1,
    backendId: null,
    configurationId: "cfg_artifact",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: createHarnessConfiguration("codex", "fixture"),
    gatewayManagedMode: false,
    harness: { id: "codex", version: "1.0.0", mode: "dedicated", overrides: {}, configuration: {} },
    compute: {
      id: "kubernetes",
      implementation: "kubernetes",
      ...(snapshot.serviceAccess === undefined ? {} : { serviceAccess: snapshot.serviceAccess }),
    },
    sandboxDriverId: snapshot.driverId,
    sandboxPolicy: snapshot,
    repositoryCredentials: repository,
    harnessAuth: { method: "runtime" },
    servicePrincipalId: execution.servicePrincipalId,
    createdAt: new Date().toISOString(),
    executionAdmission: { version: 7, mode: "protected" },
    egressPlan: {
      id: "artifact-plan",
      generation: 1,
      execution,
      sandboxDriverId: snapshot.driverId,
      egressDriverId: snapshot.driverId,
      driver: {
        id: snapshot.driverId,
        implementation: "openshell",
        configurationId: "a".repeat(64),
      },
      policyReductionVersion: 2,
      repositoryGit: repository,
      repositoryGitAuthorization: "request-hook-observed",
      routes: [],
    },
  };
}

test("protected Git compilation carries the complete frozen artifact map without ambient defaults", (t) => {
  const snapshot = sandbox(t, [artifact()], [artifact().name]).admitProtectedCodexArtifactPolicy(
    1,
  ).snapshot;
  const revision = protectedRevision(snapshot);
  const compiled = openShellEgressConfiguration(
    revision.egressPlan!,
    {
      middlewareName: "artifact-exchange",
      repositoryMiddlewareName: "oce-prepared-git",
      authorityScope: "execution",
    },
    revision,
  );
  assert.deepEqual(compiled.network_policies, snapshot.defaults);
  assert.equal(Object.hasOwn(compiled, "providers"), false);
  const absent = { ...revision };
  delete absent.sandboxPolicy;
  assert.deepEqual(openShellProtectedCodexArtifacts(absent), {});
});

test("rehydrated artifact authority refuses an invalid scope, identity, additions or credential field", async (t) => {
  const snapshot = sandbox(t, [artifact()], [artifact().name]).admitProtectedCodexArtifactPolicy(
    1,
  ).snapshot;
  const revision = protectedRevision(snapshot);
  const withoutRepository = { ...revision };
  delete withoutRepository.repositoryCredentials;
  const cases: Array<[string, AgentRevision]> = [
    ["unprotected", { ...revision, executionAdmission: { version: 2, mode: "unprotected" } }],
    ["embedded", { ...revision, harness: { ...revision.harness, mode: "embedded" } }],
    ["missing repository", withoutRepository],
    [
      "empty repository scope",
      { ...revision, repositoryCredentials: { ...revision.repositoryCredentials!, bindings: [] } },
    ],
    [
      "different plan Sandbox",
      { ...revision, egressPlan: { ...revision.egressPlan!, sandboxDriverId: "another-driver" } },
    ],
    ["foreign Driver", { ...revision, sandboxPolicy: { ...snapshot, driverId: "another-driver" } }],
    [
      "Agent additions",
      {
        ...revision,
        sandboxPolicy: {
          ...snapshot,
          additions: [
            {
              id: "extra",
              binary: "/usr/bin/curl",
              host: "example.org",
              ports: [{ from: 443, to: 443 }],
            },
          ],
        },
      },
    ],
    [
      "credential-bearing rule",
      {
        ...revision,
        sandboxPolicy: {
          ...snapshot,
          defaults: {
            [artifact().name]: {
              ...(snapshot.defaults[artifact().name] as object),
              credentialAlias: "forbidden",
            },
          },
        },
      },
    ],
  ];
  for (const [name, candidate] of cases) {
    await t.test(name, () =>
      assert.throws(
        () => openShellProtectedCodexArtifacts(candidate),
        ConfigurationValidationError,
      ),
    );
  }
});

test("paired observation rejects changed, missing or extra artifact rules before querying the enforcing peer", async (t) => {
  const backend = newBackend();
  const driver = sandbox(t, [artifact()], [artifact().name], backend);
  const revision = protectedRevision(driver.admitProtectedCodexArtifactPolicy(1).snapshot);
  const options = {
    middlewareName: "artifact-exchange",
    repositoryMiddlewareName: "oce-prepared-git",
    authorityScope: "execution" as const,
  };
  const proxy = new OpenShellCredentialProxyDriver(options, {
    id: driver.id,
    backend,
    sandbox: driver,
  });
  const context: ProxyRevisionContext = {
    namespace: {
      id: revision.namespaceId,
      name: "artifact",
      status: "ready",
      createdAt: revision.createdAt,
    },
    revision,
    plan: revision.egressPlan!,
    signal: new AbortController().signal,
  };
  const configuration = openShellEgressConfiguration(context.plan, options, revision);
  const rules = revision.sandboxPolicy!.defaults;
  // These are valid read-only wire rules; only their authority differs from the frozen map.
  const changedRule = {
    name: artifact().name,
    binaries: [{ path: native }],
    endpoints: [
      {
        host: "changed.example.test",
        ports: [443],
        protocol: "rest",
        enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
        access: "NETWORK_ACCESS_PRESET_READ_ONLY",
      },
    ],
  };
  for (const [name, network_policies] of [
    ["missing", {}],
    ["extra", { ...rules, undeclared: { ...changedRule, name: "undeclared" } }],
    [
      "altered",
      {
        ...rules,
        [artifact().name]: changedRule,
      },
    ],
  ] as const) {
    await t.test(name, async () => {
      await assert.rejects(
        proxy.wiringStatus(context, {
          plan: context.plan,
          configuration: { ...configuration, network_policies },
        }),
        /changed protected egress routes/,
      );
    });
  }
  await t.test("foreign auxiliary process", async () => {
    await assert.rejects(
      proxy.wiringStatus(context, {
        plan: context.plan,
        configuration: {
          ...configuration,
          network_policies: {
            ...rules,
            "workspace-node-enrollment": {
              name: "workspace-node-enrollment",
              binaries: [{ path: "/usr/bin/curl" }],
              endpoints: [
                {
                  host: "gateway.example.test",
                  ports: [443],
                  tls: "NETWORK_TLS_MODE_SKIP",
                  enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
                },
              ],
            },
          },
        },
      }),
      /bounded shape/,
    );
  });
  await assert.rejects(
    driver.applyNetworkPolicy(context, {
      snapshot: revision.sandboxPolicy!,
      expectedProviderVersion: "1",
      operationId: "artifact-apply",
    }),
    /unavailable for protected execution/,
  );
});

test("paired OpenShell compilers compose inspected public reads separately from frozen artifacts and reject changed descriptors", async (t) => {
  const tls = await harnessTlsFixture(t);
  const service: ComputeServiceAccess = {
    id: "public-github-read",
    driverId: "kubernetes",
    implementation: "kubernetes",
    endpoint: "https://10.96.0.55:8080",
    configuration: {
      policy: { mode: "repositories", repositories: ["example/library"] },
      peer: { namespace: "reader", podLabels: { app: "public-reader" } },
      authorizationConfigMapName: "reader-authorizations",
      installationId: "ins_artifact",
      caBundle: tls.caBundle,
    },
  };
  const driver = sandbox(t, [artifact()], [artifact().name]);
  const admission = driver.admitProtectedNetworkPolicy(3, [service]);
  assert.equal(admission.purpose, "protected-network");
  assert.deepEqual(admission.declaredRuleNames, [artifact().name, "public-github-read"]);
  assert.deepEqual(admission.snapshot.serviceAccess, [service]);
  assert.deepEqual(Object.keys(admission.snapshot.defaults), [artifact().name]);
  const revision = protectedRevision(admission.snapshot);
  const options = {
    middlewareName: "exchange",
    repositoryMiddlewareName: "oce-prepared-git",
    authorityScope: "execution" as const,
  };
  const compile = (candidate: AgentRevision) =>
    openShellEgressConfiguration(candidate.egressPlan!, options, candidate);
  const compiled = compile(revision);
  const rules = compiled.network_policies as Record<
    string,
    { endpoints: Record<string, unknown>[] }
  >;
  assert.deepEqual(rules["public-github-read"], {
    name: "public-github-read",
    binaries: [
      "/usr/bin/node",
      "/usr/local/bin/node",
      "/usr/bin/curl",
      "/usr/bin/git",
      "/usr/lib/git-core/git-remote-https",
      "/usr/lib/git-core/git-remote-http",
      "/usr/libexec/git-core/git-remote-https",
      "/usr/libexec/git-core/git-remote-http",
    ].map((path) => ({ path })),
    endpoints: [
      {
        host: "10.96.0.55",
        ports: [8080],
        allowed_ips: ["10.96.0.55"],
        protocol: "rest",
        enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
        credential_binding: { provider: "oce-runtime-8774ba4feb359bde" },
        rules: [
          { allow: { method: "GET", path: "/repos/**" } },
          { allow: { method: "GET", path: "/git/**/info/refs" } },
          { allow: { method: "POST", path: "/git/**/git-upload-pack" } },
        ],
      },
    ],
  });
  for (const changed of [
    { ...service, id: "unknown-service" },
    { ...service, endpoint: "http://10.96.0.55:8080" },
    { ...service, endpoint: "https://reader:8080" },
    { ...service, endpoint: "https://10.96.0.55:8080/elsewhere" },
    { ...service, configuration: { ...service.configuration, token: "untrusted" } },
    {
      ...service,
      configuration: {
        ...service.configuration,
        policy: { mode: "repositories", repositories: [] },
      },
    },
    {
      ...service,
      configuration: {
        ...service.configuration,
        policy: { mode: "repositories", repositories: ["Example/Library"] },
      },
    },
    {
      ...service,
      configuration: { ...service.configuration, peer: { namespace: "reader", podLabels: {} } },
    },
    { ...service, configuration: { ...service.configuration, caBundle: "not a CA" } },
  ]) {
    assert.throws(
      () => driver.admitProtectedNetworkPolicy(3, [changed]),
      ConfigurationValidationError,
    );
    assert.throws(
      () =>
        compile({
          ...revision,
          sandboxPolicy: { ...admission.snapshot, serviceAccess: [changed] },
        }),
      ConfigurationValidationError,
    );
  }
  assert.throws(
    () => compile({ ...revision, compute: { ...revision.compute, id: "other-compute" } }),
    ConfigurationValidationError,
  );
  const ordinary = driver.admitNetworkPolicy([], 3, undefined, { serviceAccess: [service] });
  assert.deepEqual(ordinary.serviceAccess, [service]);
  assert.throws(
    () =>
      driver.admitNetworkPolicy([], 3, undefined, {
        serviceAccess: [{ ...service, endpoint: "https://127.0.0.1:8080" }],
      }),
    ConfigurationValidationError,
  );
});

function serviceOnlyRevision(snapshot: SandboxPolicySnapshot): AgentRevision {
  const { repositoryCredentials: _credentials, ...revision } = protectedRevision(snapshot);
  const {
    repositoryGit: _repository,
    repositoryGitAuthorization: _authorization,
    ...plan
  } = revision.egressPlan!;
  return { ...revision, egressPlan: plan };
}

test("protected public-reader-only compilation preserves default deny and independently governed routes", async (t) => {
  const tls = await harnessTlsFixture(t);
  const service: ComputeServiceAccess = {
    id: "public-github-read",
    driverId: "kubernetes",
    implementation: "kubernetes",
    endpoint: "https://10.96.0.55:8080",
    configuration: {
      policy: { mode: "all" },
      peer: { namespace: "reader", podLabels: { app: "reader" } },
      authorizationConfigMapName: "reader-authorizations",
      installationId: "ins_artifact",
      caBundle: tls.caBundle,
    },
  };
  const driver = sandbox(t, [artifact()], []);
  const snapshot = driver.admitProtectedNetworkPolicy(4, [service]).snapshot;
  const revision = serviceOnlyRevision(snapshot);
  const options = { middlewareName: "service-exchange", authorityScope: "execution" as const };
  const compile = (candidate: AgentRevision) =>
    openShellEgressConfiguration(candidate.egressPlan!, options, candidate);
  assert.deepEqual(openShellProtectedCodexArtifacts(revision), {});
  const compiled = compile(revision);
  const networks = compiled.network_policies as Record<
    string,
    { endpoints: Record<string, unknown>[] }
  >;
  assert.deepEqual(Object.keys(networks), ["public-github-read"]);
  assert.deepEqual(networks["public-github-read"]!.endpoints, [
    {
      host: "10.96.0.55",
      ports: [8080],
      allowed_ips: ["10.96.0.55"],
      protocol: "rest",
      enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
      credential_binding: { provider: "oce-runtime-8774ba4feb359bde" },
      rules: [
        { allow: { method: "GET", path: "/repos/**" } },
        { allow: { method: "GET", path: "/git/**/info/refs" } },
        { allow: { method: "POST", path: "/git/**/git-upload-pack" } },
      ],
    },
  ]);
  assert.deepEqual(compiled.network_middlewares, {
    "oce-egress": {
      name: "oce-egress",
      middleware: "service-exchange",
      on_error: "fail_closed",
      endpoints: { include: ["deny-egress.invalid"] },
      credential_authority: true,
      execution_authority: true,
    },
  });
  const ref = { id: "governed", generation: 1 };
  const route = {
    route: ref,
    binding: {
      binding: ref,
      execution: revision.egressPlan!.execution,
      source: {
        installationId: "ins_artifact",
        namespaceId: revision.namespaceId,
        source: ref,
        backend: ref,
        provider: ref,
      },
      grant: { kind: "inference" as const, models: ["fixture"], providerTools: "none" as const },
      grantHash: "a".repeat(64),
      isolationId: "isolated",
    },
    origin: "https://model.example.test",
    path: "/v1/responses",
    method: "POST" as const,
    operationPolicy: ref,
    responsePolicy: ref,
    deadlineMs: 30000,
  };
  const governed = compile({
    ...revision,
    egressPlan: { ...revision.egressPlan!, routes: [route] },
  });
  assert.deepEqual((governed.network_policies as Record<string, unknown>)["oce-egress-0"], {
    name: "oce-egress-0",
    binaries: [{ path: "/**" }],
    endpoints: [
      {
        host: "model.example.test",
        ports: [443],
        protocol: "rest",
        enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
        access: "NETWORK_ACCESS_PRESET_FULL",
        path: "/v1/responses",
      },
    ],
  });
  assert.deepEqual(
    (governed.network_middlewares as Record<string, { endpoints: unknown }>)["oce-egress"]!
      .endpoints,
    { include: ["model.example.test"] },
  );
  assert.throws(
    () =>
      compile({
        ...revision,
        egressPlan: { ...revision.egressPlan!, routes: [{ ...route, origin: service.endpoint }] },
      }),
    /overlap/,
  );
  for (const candidate of [
    {
      ...revision,
      sandboxPolicy: {
        ...snapshot,
        defaults: {},
        additions: [
          {
            id: "free",
            binary: "/usr/bin/node",
            host: "elsewhere.test",
            ports: [{ from: 443, to: 443 }],
          },
        ],
      },
    },
    {
      ...revision,
      sandboxPolicy: {
        ...snapshot,
        defaults: sandbox(t, [artifact()], [artifact().name]).admitProtectedCodexArtifactPolicy(4)
          .snapshot.defaults,
      },
    },
    { ...revision, compute: { ...revision.compute, serviceAccess: undefined } },
    {
      ...revision,
      egressPlan: {
        ...revision.egressPlan!,
        execution: { ...revision.egressPlan!.execution, installationId: "ins_other" },
      },
    },
    { ...revision, sandboxPolicy: { ...snapshot, driverId: "foreign" } },
  ]) {
    assert.throws(() => compile(candidate as AgentRevision), ConfigurationValidationError);
  }
  const old = serviceOnlyRevision(driver.admitProtectedCodexArtifactPolicy(4).snapshot);
  assert.throws(() => compile(old), ConfigurationValidationError);
});
