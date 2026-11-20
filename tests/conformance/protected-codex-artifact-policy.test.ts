import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { ConfigurationValidationError } from "../../packages/contracts/src/index.ts";
import type {
  AgentRevision,
  SandboxPolicySnapshot,
  ProxyRevisionContext,
} from "../../packages/contracts/src/index.ts";
import {
  openShellEgressConfiguration,
  OpenShellLegacyEgressProxyDriver,
} from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { openShellProtectedCodexArtifacts } from "../../apps/controller/src/drivers/sandbox/openshell-codex-artifacts.ts";
import { openShellGitRuntimeFixture } from "../helpers/openshell-git-runtime.ts";
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
      integrationMode: "legacy",
      gateway: {},
      kubernetes: {
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
  const npm = { ...endpoint, host: "registry.npmjs.org" };
  const nativeFlag = { ...npm, allow_encoded_slash: true };
  const camelCaseFlag = { ...npm, allowEncodedSlash: true };
  const flagged = { ...endpoint, protectedArtifactAllowEncodedSlash: true as const };
  const namedBinary = { path: native, name: "unexpected" };
  const extraRuleField = { ...original, provider: "unexpected" };
  const cases: Array<[string, OpenShellNetworkPolicyRule]> = [
    ["supplied native flag", { ...original, endpoints: [nativeFlag] }],
    ["supplied camel-case flag", { ...original, endpoints: [camelCaseFlag] }],
    ["extra binary field", { ...original, binaries: [namedBinary] }],
    ["extra rule field", extraRuleField],
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
    ["opt-in on uninspected TLS", { ...original, endpoints: [{ ...flagged, tls: "skip" }] }],
    ["opt-in on write access", { ...original, endpoints: [{ ...flagged, access: "read_write" }] }],
    ["opt-in on another port", { ...original, endpoints: [{ ...flagged, ports: [8443] }] }],
    ["opt-in on a wildcard", { ...original, endpoints: [{ ...flagged, host: "*.example.test" }] }],
    ["another process", { ...original, binaries: [{ path: "/usr/bin/curl" }] }],
    [
      "package registry for a non-Codex executable",
      {
        ...original,
        binaries: [{ path: "/usr/local/bin/node" }],
        endpoints: [{ ...flagged, host: "registry.npmjs.org" }],
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

test("Installation rejects invalid, unselected or conflicting artifact endpoint flags", (t) => {
  const rule = artifact();
  const endpoint = rule.endpoints[0]!;
  const optedIn = {
    ...rule,
    endpoints: [{ ...endpoint, protectedArtifactAllowEncodedSlash: true as const }],
  };
  assert.throws(() => sandbox(t, [optedIn]), ConfigurationValidationError);
  for (const value of [false, "true", 1]) {
    const invalid = {
      ...rule,
      endpoints: [{ ...endpoint, protectedArtifactAllowEncodedSlash: value }],
    };
    assert.throws(
      () => sandbox(t, [invalid as OpenShellNetworkPolicyRule], [rule.name]),
      ConfigurationValidationError,
    );
  }
  const sibling = { ...rule, name: "same-host" };
  assert.throws(
    () => sandbox(t, [optedIn, sibling], [rule.name, sibling.name]),
    ConfigurationValidationError,
  );

  // The same destination can serve both native binaries when they agree on syntax.
  const otherArchitecture = {
    ...optedIn,
    name: sibling.name,
    binaries: [
      {
        path: "/app/node_modules/openclaw/node_modules/.pnpm/@openai+codex@0.164.0-linux-arm64/node_modules/@openai/codex/vendor/aarch64-unknown-linux-musl/bin/codex",
      },
    ],
  };
  const driver = sandbox(t, [optedIn, otherArchitecture], [rule.name, sibling.name]);
  const snapshot = driver.admitProtectedCodexArtifactPolicy(1).snapshot;
  // Replay two valid wire rules that disagree only about parsing on this destination.
  const strict = driver.admitNetworkPolicy([], 1).defaults[sibling.name];
  assert.ok(strict);
  assert.throws(
    () =>
      openShellProtectedCodexArtifacts(
        protectedRevision({
          ...snapshot,
          defaults: { ...snapshot.defaults, [sibling.name]: strict },
        }),
      ),
    ConfigurationValidationError,
  );
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
    compute: { id: "kubernetes", implementation: "kubernetes" },
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

test("protected request-hook Git compilation replays the explicit opt-in and ordinary defaults stay strict", (t) => {
  const original = artifact();
  const mirror = {
    ...original.endpoints[0]!,
    host: "packages.example.test",
    protectedArtifactAllowEncodedSlash: true as const,
  };
  const npm = { ...original.endpoints[0]!, host: "registry.npmjs.org" };
  const selected = { ...original, endpoints: [npm, mirror] };
  const unselected = { ...original, name: "unselected-npm", endpoints: [npm] };
  const driver = sandbox(t, [selected, unselected], [selected.name]);
  const ordinary = driver.admitNetworkPolicy([], 1).defaults;
  const endpoint = {
    host: npm.host,
    ports: [443],
    protocol: "rest",
    enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
    access: "NETWORK_ACCESS_PRESET_READ_ONLY",
  };
  const wireMirror = { ...endpoint, host: mirror.host };
  const legacy = {
    name: selected.name,
    binaries: selected.binaries.map(({ path }) => ({ path })),
    endpoints: [endpoint, wireMirror],
  };
  assert.deepEqual(ordinary, {
    [selected.name]: legacy,
    [unselected.name]: { ...legacy, name: unselected.name, endpoints: [endpoint] },
  });

  const snapshot = driver.admitProtectedCodexArtifactPolicy(1).snapshot;
  assert.deepEqual(driver.admitNetworkPolicy([], 1).defaults, ordinary);
  const flagged = { ...wireMirror, allow_encoded_slash: true };
  assert.deepEqual(snapshot.defaults, {
    [selected.name]: { ...legacy, endpoints: [endpoint, flagged] },
  });
  const savedBytes = JSON.stringify(snapshot);
  const revision = protectedRevision(JSON.parse(savedBytes) as SandboxPolicySnapshot);
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
  assert.equal(JSON.stringify(revision.sandboxPolicy), savedBytes);
  assert.equal(JSON.stringify(compiled.network_policies), JSON.stringify(snapshot.defaults));

  const legacySnapshot = { ...snapshot, defaults: { [selected.name]: legacy } };
  assert.equal(
    JSON.stringify(openShellProtectedCodexArtifacts(protectedRevision(legacySnapshot))),
    JSON.stringify(legacySnapshot.defaults),
  );
  for (const endpoint of [
    { ...flagged, host: "api.github.com" },
    { ...flagged, allow_encoded_slash: false },
    { ...flagged, allow_encoded_slash: "true" },
  ]) {
    assert.throws(
      () =>
        openShellProtectedCodexArtifacts(
          protectedRevision({
            ...snapshot,
            defaults: { [selected.name]: { ...legacy, endpoints: [endpoint] } },
          }),
        ),
      ConfigurationValidationError,
    );
  }
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
  const proxy = new OpenShellLegacyEgressProxyDriver(options, {
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
