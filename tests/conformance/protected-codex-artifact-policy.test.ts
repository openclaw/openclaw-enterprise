import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { ConfigurationValidationError } from "../../packages/contracts/src/index.ts";
import type {
  AgentRevision,
  CredentialProxyDriver,
  SandboxDriver,
  SandboxPolicySnapshot,
  ProxyRevisionContext,
} from "../../packages/contracts/src/index.ts";
import {
  openShellEgressConfiguration,
  OpenShellCredentialProxyDriver,
} from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { openShellExchangeCapabilities } from "../../apps/controller/src/drivers/egress-proxy/openshell-exchange-capabilities.ts";
import { openShellProtectedCodexArtifacts } from "../../apps/controller/src/drivers/sandbox/openshell-codex-artifacts.ts";
import { openShellGitRuntimeFixture } from "../helpers/openshell-git-runtime.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type { OpenShellNetworkPolicyRule } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type { OpenShellSandboxDeleteRequest } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

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

test("ordinary OpenShell policy observation cannot confirm a protected revision", async (t) => {
  const backend = newBackend();
  const driver = sandbox(t, [artifact()], [artifact().name], backend);
  const snapshot = driver.admitProtectedCodexArtifactPolicy(1).snapshot;
  const revision = protectedRevision(snapshot);
  const namespace = {
    id: revision.namespaceId,
    name: "artifact",
    status: "ready" as const,
    createdAt: revision.createdAt,
  };
  const context = { namespace, revision, signal: AbortSignal.timeout(2_000) };
  const policy = { network_policies: snapshot.defaults };
  const client = backend.client.clientForNamespace(namespace.name);
  const target = t.mock.method(
    client,
    "getSandbox",
    async ({ name, workspace }: OpenShellSandboxDeleteRequest) => ({
      name,
      workspace,
      resourceVersion: "9",
      labels: {},
      annotations: {
        "openclaw.dev/namespace-id": namespace.id,
        "openclaw.dev/agent-id": revision.agentId,
        "openclaw.dev/revision-id": revision.id,
      },
      spec: { policy },
      serviceUrls: {},
    }),
  );
  const status = t.mock.fn(async () => ({
    version: 7,
    activeVersion: 7,
    state: "POLICY_STATUS_LOADED",
    policy,
  }));
  client.getPolicyStatus = status;

  const ordinaryRevision = {
    ...revision,
    executionAdmission: { version: 2, mode: "unprotected" } as const,
  };
  delete ordinaryRevision.egressPlan;
  assert.deepEqual(
    await driver.observeNetworkPolicy({ ...context, revision: ordinaryRevision }, snapshot),
    { resourceVersion: "9", policyVersion: "7", state: "applied", matches: true },
  );
  assert.equal(target.mock.callCount(), 1);
  assert.equal(status.mock.callCount(), 1);

  await assert.rejects(
    driver.observeNetworkPolicy(context, snapshot),
    /Live policy observation is unavailable for protected execution/,
  );
  assert.equal(target.mock.callCount(), 1, "protected observation never reads the Sandbox");
  assert.equal(status.mock.callCount(), 1, "protected observation never queries ordinary status");
});

test("OpenShell confirms only the same owned Sandbox and leaves live protected downloads unavailable", async (t) => {
  const backend = newBackend();
  const driver = sandbox(t, [artifact()], [artifact().name], backend);
  const revision = protectedRevision(driver.admitProtectedCodexArtifactPolicy(1).snapshot);
  const options = { middlewareName: "artifact-exchange", authorityScope: "execution" } as const;
  const proxy = new OpenShellCredentialProxyDriver(options, {
    id: driver.id,
    backend,
    sandbox: driver,
  });
  assert.equal((driver as SandboxDriver).protectedDownloadPolicy, undefined);
  assert.equal((proxy as CredentialProxyDriver).protectedDownloadPolicy, undefined);

  // This fixture uses the existing protected supervisor path without a Git recipient.
  const plan = { ...revision.egressPlan! };
  delete plan.repositoryGit;
  delete plan.repositoryGitAuthorization;
  const namespace = {
    id: revision.namespaceId,
    name: "artifact",
    status: "ready" as const,
    createdAt: revision.createdAt,
  };
  const runtimeRevision = { ...revision, egressPlan: plan };
  delete runtimeRevision.repositoryCredentials;
  delete runtimeRevision.sandboxPolicy;
  const context = {
    namespace,
    revision: runtimeRevision,
    plan,
    signal: AbortSignal.timeout(5_000),
  };
  const configuration = openShellEgressConfiguration(plan, options, context.revision);
  const policy = { ...configuration, filesystem: { read_only: ["/usr"] } };
  const client = backend.client.clientForNamespace(namespace.name);
  const discovery = backend.client.clientForNamespace("");
  discovery.getGatewayInfo = async () => ({
    extensions: [
      {
        configured_name: options.middlewareName,
        kind: "EXTENSION_KIND_SUPERVISOR_MIDDLEWARE",
        protocol_major: 1,
        supported_capabilities: [...openShellExchangeCapabilities],
        required_capabilities: [...openShellExchangeCapabilities],
      },
    ],
  });
  const hash = "a".repeat(64);
  const boxId = "sandbox-original";
  const evidence = {
    sandbox_id: boxId,
    instance_id: "8b6023fe-c1c7-4c6f-8c0f-a4b8596d2437",
    policy_version: plan.generation,
    policy_hash: hash,
    enforced_capabilities: [...openShellExchangeCapabilities],
  };
  let sandboxId: string | undefined = boxId;
  let resourceVersion: string | undefined = "9";
  let replacement = false;
  let metadataChurn = false;
  let instanceId = evidence.instance_id;
  let observedStatus = false;
  client.getSandbox = async ({ name, workspace }) => {
    const id = observedStatus && replacement ? "sandbox-successor" : sandboxId;
    const cas = observedStatus && metadataChurn ? "10" : resourceVersion;
    return {
      ...(id === undefined ? {} : { id }),
      ...(cas === undefined ? {} : { resourceVersion: cas }),
      name,
      workspace,
      labels: {},
      annotations: {
        "openclaw.dev/namespace-id": namespace.id,
        "openclaw.dev/agent-id": revision.agentId,
        "openclaw.dev/revision-id": revision.id,
      },
      serviceUrls: {},
    };
  };
  client.getSandboxPolicyStatus = async () => {
    observedStatus = true;
    return {
      active_version: plan.generation,
      revision: {
        version: plan.generation,
        status: "POLICY_STATUS_LOADED",
        policy_hash: hash,
        policy,
      },
      loaded_policy_observation: {
        source_policy_hash: hash,
        effective_policy: policy,
        enforcement: { ...evidence, instance_id: instanceId },
        registered_exchange_public_key: Buffer.alloc(32, 1),
      },
    };
  };
  const installed = await proxy.wiringStatus(context, { plan, configuration: policy });
  assert.ok(installed);
  assert.equal(installed.enforcement.policyHash, hash);
  assert.equal(installed.sandboxId, boxId);
  assert.equal(await proxy.verifyInstallation(context, installed), true);

  instanceId = "8b6023fe-c1c7-4c6f-8c0f-a4b8596d2438";
  assert.equal(
    await proxy.verifyInstallation(context, installed),
    false,
    "a new supervisor invalidates the old witness",
  );
  instanceId = evidence.instance_id;
  await t.test("replacement with the same CAS invalidates confirmation", async () => {
    observedStatus = false;
    replacement = true;
    assert.equal(await proxy.verifyInstallation(context, installed), false);
    replacement = false;
  });
  await t.test("metadata-only CAS churn requires a stable later observation", async () => {
    observedStatus = false;
    metadataChurn = true;
    assert.equal(await proxy.verifyInstallation(context, installed), false);
    metadataChurn = false;
    resourceVersion = "10";
    assert.equal(await proxy.verifyInstallation(context, installed), true);
  });
  for (const [label, cas] of [
    ["omitted", undefined],
    ["zero", "0"],
    ["invalid", "18446744073709551616"],
  ] as const) {
    await t.test(`${label} CAS cannot confirm the same Sandbox`, async () => {
      resourceVersion = cas;
      assert.equal(await proxy.wiringStatus(context, { plan, configuration: policy }), undefined);
      assert.equal(await proxy.verifyInstallation(context, installed), false);
    });
  }
  resourceVersion = "10";
  await t.test("missing immutable identity cannot confirm installation", async () => {
    sandboxId = undefined;
    assert.equal(await proxy.wiringStatus(context, { plan, configuration: policy }), undefined);
    assert.equal(await proxy.verifyInstallation(context, installed), false);
  });
});

test("stable Sandbox identity and CAS preserve the protected Git recipient witness", async (t) => {
  const backend = newBackend();
  const driver = sandbox(t, [artifact()], [artifact().name], backend);
  const revision = protectedRevision(driver.admitProtectedCodexArtifactPolicy(1).snapshot);
  const plan = { ...revision.egressPlan!, repositoryGitAuthorization: "online-request" } as const;
  const namespace = {
    id: revision.namespaceId,
    name: "artifact",
    status: "ready" as const,
    createdAt: revision.createdAt,
  };
  const context = {
    namespace,
    revision: { ...revision, egressPlan: plan },
    plan,
    signal: t.signal,
  };
  const options = {
    middlewareName: "artifact-exchange",
    repositoryMiddlewareName: "prepared-git",
    authorityScope: "execution",
  } as const;
  const sandboxId = "protected-git-sandbox";
  const witness = {
    instanceId: "git-network",
    policyHash: "b".repeat(64),
    authorityScope: "execution",
    configurationId: "c".repeat(64),
    repositoryGitRecipient: {
      providerId: "git-provider",
      attachmentEpoch: "git-epoch",
      processInstanceId: "git-process",
      networkInstanceId: "git-network",
      authorization: "online-request",
    },
  } as const;
  const observe = t.mock.fn(async (_context: ProxyRevisionContext, id: string) =>
    id === sandboxId ? witness : undefined,
  );
  const proxy = new OpenShellCredentialProxyDriver(options, {
    id: driver.id,
    backend,
    sandbox: driver,
    mandatoryEnforcement: observe,
  });
  const configuration = openShellEgressConfiguration(plan, options, context.revision);
  const client = backend.client.clientForNamespace(namespace.name);
  backend.client.clientForNamespace("").getGatewayInfo = async () => ({
    extensions: [
      {
        configured_name: options.repositoryMiddlewareName,
        kind: "EXTENSION_KIND_SUPERVISOR_MIDDLEWARE",
        protocol_major: 1,
      },
    ],
  });
  client.getSandbox = async ({ name, workspace }) => ({
    id: sandboxId,
    name,
    workspace,
    resourceVersion: "18446744073709551615",
    labels: {},
    annotations: {
      "openclaw.dev/namespace-id": namespace.id,
      "openclaw.dev/agent-id": revision.agentId,
      "openclaw.dev/revision-id": revision.id,
    },
    serviceUrls: {},
  });
  client.getSandboxPolicyStatus = async () => ({
    active_version: plan.generation,
    revision: {
      version: plan.generation,
      status: "POLICY_STATUS_LOADED",
      policy: configuration,
    },
  });

  // The selected Git runtime is the witness producer. Exercise the real Proxy's
  // installation and revalidation without substituting its observation decisions.
  const installed = await proxy.wiringStatus(context, { plan, configuration });
  assert.ok(installed);
  assert.deepEqual(installed.enforcement.repositoryGitRecipient, witness.repositoryGitRecipient);
  assert.equal(await proxy.verifyInstallation(context, installed), true);
  assert.equal(observe.mock.callCount(), 2);
});
