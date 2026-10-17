import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import {
  DependencyUnavailableError,
  NotImplementedError,
  ResourceConflictError,
  simulatePolicy,
} from "../../packages/occ/src/index.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const grpc = require("@grpc/grpc-js");
const loader = require("@grpc/proto-loader");
const HASH = "ab".repeat(32);
const FINGERPRINT = "18446744073709551601";

// Independent field numbers from the provider contract, rather than the production
// proto under test. This peer verifies serialization and response projection only;
// it does not implement or simulate the provider's matching algorithm.
const WIRE = `syntax = "proto3";
package openshell.v1;
service OpenShell {
  rpc GetSandbox(GetSandboxRequest) returns (SandboxResponse);
  rpc GetSandboxConfig(GetSandboxConfigRequest) returns (GetSandboxConfigResponse);
  rpc EvaluateSandboxNetworkPolicy(EvaluateSandboxNetworkPolicyRequest) returns (EvaluateSandboxNetworkPolicyResponse);
}
message WorkspaceSelector { string workspace = 1; }
message GetSandboxRequest { string name = 1; WorkspaceSelector workspace_scope = 2; }
message Metadata { string id = 1; string name = 2; map<string,string> labels = 4; map<string,string> annotations = 6; string workspace = 7; }
message Sandbox { Metadata metadata = 1; SandboxStatus status = 3; }
message SandboxStatus { int32 phase = 6; ConfigurationAdmission configuration_admission = 11; }
message ConfigurationAdmission { string instance_id = 1; int32 state = 2; uint32 policy_version = 3; string policy_hash = 4; uint64 config_revision = 5; uint64 provider_env_revision = 6; }
message SandboxResponse { Sandbox sandbox = 1; }
message GetSandboxConfigRequest { string name = 1; WorkspaceSelector workspace_scope = 3; }
message GetSandboxConfigResponse { SandboxPolicy policy = 1; uint32 version = 2; string policy_hash = 3; uint64 config_revision = 5; int32 policy_source = 6; uint32 global_policy_version = 7; uint64 provider_env_revision = 8; string workspace = 10; bool configuration_admitted = 13; string configuration_instance_id = 15; }
message SandboxPolicy { uint32 version = 1; map<string,NetworkPolicyRule> network_policies = 5; }
message NetworkPolicyRule { string name = 1; repeated NetworkEndpoint endpoints = 2; repeated NetworkBinary binaries = 3; }
message NetworkBinary { string path = 1; }
message NetworkEndpoint { string host = 1; uint32 port = 2; string protocol = 3; int32 tls = 4; int32 enforcement = 5; int32 access = 6; repeated L7Rule rules = 7; repeated string allowed_ips = 8; repeated uint32 ports = 9; repeated L7DenyRule deny_rules = 10; bool allow_encoded_slash = 11; string path = 15; bool provider_credentialed = 26; }
message L7Rule { L7Allow allow = 1; }
message L7Allow { string method = 1; string path = 2; map<string,L7QueryMatcher> query = 4; }
message L7DenyRule { string method = 1; string path = 2; }
message L7QueryMatcher { string glob = 1; repeated string any = 2; }
message SandboxHttpPolicyInput { string method = 1; string path = 2; string query = 3; }
message EvaluateSandboxNetworkPolicyRequest { WorkspaceSelector workspace_scope = 1; string name = 2; string host = 3; uint32 port = 4; string binary_path = 5; string binary_sha256 = 6; repeated string ancestors = 7; repeated string cmdline_paths = 8; SandboxHttpPolicyInput http = 9; string expected_policy_hash = 10; }
message SandboxNetworkPolicyRuleTrace { string rule = 1; bool matched = 2; string reason = 3; bool endpoint_matched = 4; bool binary_matched = 5; bool builtin = 6; }
message SandboxNetworkPolicyEvaluationStage { string id = 1; string decision = 2; string reason = 3; }
message EvaluateSandboxNetworkPolicyResponse { string policy_hash = 1; uint32 policy_version = 2; uint64 config_revision = 3; string policy_source = 4; bool loaded = 5; string decision = 6; string reason = 7; repeated SandboxNetworkPolicyRuleTrace rules = 8; repeated SandboxNetworkPolicyEvaluationStage stages = 9; repeated string unevaluated_checks = 10; uint32 global_policy_version = 11; }
`;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-policy-wire-"));
  const path = join(directory, "upstream.proto");
  await writeFile(path, WIRE);
  const definition = await loader.load(path, { keepCase: true, longs: String });
  const service = grpc.loadPackageDefinition(definition).openshell.v1.OpenShell;
  const server = new grpc.Server();
  const namespace = { id: "nsp-policy", name: "tenant-policy" };
  const revision = {
    id: "rev-policy",
    agentId: "agt-policy",
    namespaceId: namespace.id,
    sandboxDriverId: "openshell-sandbox",
    harness: { id: "codex", mode: "dedicated" },
  };
  const canary = ["ghp", randomUUID().replaceAll("-", "")].join("_");
  const state = {
    phase: 2,
    ownership: revision.id,
    configReads: 0,
    evaluationRequests: [],
    error: undefined,
    admission: {
      instance_id: "runtime-policy",
      state: 2,
      policy_version: 4,
      policy_hash: HASH,
      config_revision: FINGERPRINT,
      provider_env_revision: "9007199254740993",
    },
    config: {
      version: 4,
      policy_hash: HASH,
      config_revision: FINGERPRINT,
      policy_source: 2,
      global_policy_version: 8,
      provider_env_revision: "9007199254740993",
      configuration_admitted: true,
      configuration_instance_id: "runtime-policy",
      policy: {
        version: 1,
        network_policies: {
          web: {
            name: "Web access",
            binaries: [{ path: "/usr/bin/curl" }],
            endpoints: [
              {
                host: "api.example.test",
                ports: [443, 8443],
                protocol: "rest",
                tls: 2,
                enforcement: 1,
                path: "/repos/**",
                rules: [
                  {
                    allow: { method: "GET", path: "/repos/**", query: { token: { glob: canary } } },
                  },
                ],
                deny_rules: [{ method: "DELETE", path: "/repos/**" }],
                allowed_ips: ["192.0.2.0/24"],
                allow_encoded_slash: true,
              },
            ],
          },
          _provider_model: {
            name: "Model access",
            binaries: [{ path: "/app/model" }],
            endpoints: [{ host: "model.example.test", port: 443, provider_credentialed: true }],
          },
        },
      },
    },
    result: {
      policy_hash: HASH,
      policy_version: 4,
      config_revision: FINGERPRINT,
      policy_source: "global",
      loaded: false,
      decision: "audit",
      reason: "The L7 denial is audited.",
      rules: [
        {
          rule: "web",
          matched: true,
          reason: "Destination and binary matched.",
          endpoint_matched: true,
          binary_matched: true,
        },
      ],
      stages: [
        { id: "network", decision: "allowed", reason: "Named rule matched." },
        { id: "http", decision: "audit", reason: "A deny rule matched in audit mode." },
      ],
      unevaluated_checks: ["DNS and resolved-IP safety were not exercised."],
    },
  };
  server.addService(service.service, {
    GetSandbox(call, callback) {
      callback(null, {
        sandbox: {
          metadata: {
            id: "provider-sandbox",
            name: call.request.name,
            workspace: call.request.workspace_scope.workspace,
            labels: {
              "openclaw.dev/agent": revision.agentId,
              "openclaw.dev/revision": state.ownership,
            },
            annotations: {
              "openclaw.dev/namespace-id": namespace.id,
              "openclaw.dev/agent-id": revision.agentId,
              "openclaw.dev/revision-id": state.ownership,
            },
          },
          status: { phase: state.phase, configuration_admission: state.admission },
        },
      });
    },
    GetSandboxConfig(call, callback) {
      state.configReads++;
      callback(null, { ...state.config, workspace: call.request.workspace_scope.workspace });
    },
    EvaluateSandboxNetworkPolicy(call, callback) {
      state.evaluationRequests.push(call.request);
      callback(state.error ?? null, state.error ? undefined : state.result);
    },
  });
  const port = await new Promise((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, port) =>
      error ? reject(error) : resolve(port),
    ),
  );
  const client = new GrpcOpenShellGatewayClient({
    endpoint: `http://127.0.0.1:${port}`,
    requestTimeoutMs: 2000,
  });
  const driver = new OpenShellSandboxDriver(
    {
      gateway: { workspaceMode: "operator" },
      kubernetes: {
        runtimeClassName: "openshell-sandbox",
        serviceAccount: { mode: "gatewayConfigured" },
        sandboxDataMount: {
          subPath: "workspace",
          mountPath: "/sandbox/enterprise",
          readOnly: false,
        },
      },
      policy: {
        process: { runAsUser: "10001", runAsGroup: "10001" },
        networkPolicies: [
          {
            name: "configured",
            binaries: [{ path: "/usr/bin/curl" }],
            endpoints: [{ host: "configured.example.test", ports: [443] }],
          },
        ],
      },
    },
    {
      id: "openshell-sandbox",
      implementation: "openshell",
      backend: {
        id: "openshell",
        drivers: { sandbox: "openshell-sandbox" },
        client: new OpenShellGateway(
          { serviceName: "openshell-gateway" },
          { gatewayClient: client },
        ),
      },
    },
  );
  t.after(async () => {
    client.close();
    await new Promise((resolve) => server.tryShutdown(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const context = { namespace, revision, signal: AbortSignal.timeout(10000) };
  const request = {
    host: "api.example.test",
    port: 443,
    binaryPath: "/usr/bin/curl",
    expectedPolicyHash: HASH,
  };
  return { driver, state, context, request, canary };
}

test("network inspector preserves effective global/provider conditions and exact applied identity", async (t) => {
  const { driver, state, context, canary } = await fixture(t);
  const policy = await driver.describeNetworkPolicy(context);
  assert.equal(policy.identity.source, "global");
  assert.equal(policy.identity.globalVersion, 8);
  assert.equal(policy.identity.configRevision, FINGERPRINT);
  assert.equal(policy.identity.providerEnvRevision, "9007199254740993");
  assert.equal(policy.admission.state, "applied");
  const web = policy.rules.find(({ id }) => id === "policy:web");
  assert.deepEqual(web.configuration.endpoints[0].deny_rules, [
    { method: "DELETE", path: "/repos/**" },
  ]);
  assert.deepEqual(web.configuration.endpoints[0].allowed_ips, ["192.0.2.0/24"]);
  assert.equal(web.configuration.endpoints[0].allow_encoded_slash, true);
  assert.ok(
    web.configuration.endpoints[0].rules[0].allow.query.token.glob.startsWith("[redacted:"),
  );
  assert.equal(JSON.stringify(policy).includes(canary), false);
  const provider = policy.rules.find(({ origin }) => origin === "provider");
  assert.deepEqual(provider.destinations[0].ports, [443]);
  assert.equal(provider.destinations[0].tls, "automatic");
  assert.equal(provider.destinations[0].enforcement, "audit");
  assert.equal(provider.destinations[0].access, undefined);
  assert.equal(policy.rules.find(({ origin }) => origin === "builtin").name, "Default deny");
  // A matching base version cannot prove application of changed effective provider/global inputs.
  state.admission.provider_env_revision = "9007199254740992";
  assert.equal((await driver.describeNetworkPolicy(context)).admission.state, "pending");
  state.admission.provider_env_revision = state.config.provider_env_revision;
  state.admission.state = 3;
  state.config.configuration_admitted = false;
  assert.equal((await driver.describeNetworkPolicy(context)).admission.state, "rejected");
});

test("authored simulation is independent of the provider's effective global policy", async (t) => {
  const { driver, state, context } = await fixture(t);
  const policy = await driver.describePolicySimulation(context);
  assert.equal(policy.source, "driver_configuration");
  assert.deepEqual(
    policy.rules.map(({ name }) => name),
    ["configured"],
  );
  assert.equal(state.configReads, 0);
  assert.equal(
    simulatePolicy(policy, {
      kind: "network",
      host: "configured.example.test",
      port: 443,
      binaryPath: "/usr/bin/curl",
      expectedSimulationHash: HASH,
    }).decision,
    "allow",
  );
  assert.match(policy.unevaluatedChecks.join(" "), /current.*global.*provider/iu);
  await assert.rejects(
    driver.describePolicySimulation({
      ...context,
      revision: { ...context.revision, namespaceId: "another-namespace" },
    }),
    DependencyUnavailableError,
  );
  await assert.rejects(
    driver.describePolicySimulation({ ...context, signal: AbortSignal.abort() }),
    { name: "AbortError" },
  );
});

test("network inspection and evaluation refuse a Sandbox owned by another revision", async (t) => {
  const { driver, state, context, request } = await fixture(t);
  state.ownership = "rev-someone-else";
  await assert.rejects(driver.describeNetworkPolicy(context), DependencyUnavailableError);
  await assert.rejects(driver.evaluateNetworkPolicy(context, request), DependencyUnavailableError);
  assert.equal(state.configReads, 0);
  assert.equal(state.evaluationRequests.length, 0);
});

test("stopped Sandbox admission cannot report a policy currently applied", async (t) => {
  const { driver, state, context } = await fixture(t);
  assert.equal((await driver.describeNetworkPolicy(context)).admission.state, "applied");
  // OpenShell retains accepted admission when the runtime stops. The unchanged
  // tuple proves its last acceptance, not application in a running Sandbox.
  state.phase = 7;
  assert.equal((await driver.describeNetworkPolicy(context)).admission.state, "unknown");
});

test("native evaluation keeps hypothetical identity, repeated query values and audit boundaries", async (t) => {
  const { driver, state, context, request } = await fixture(t);
  const result = await driver.evaluateNetworkPolicy(context, {
    ...request,
    binarySha256: "cd".repeat(32),
    ancestors: ["/app/runner"],
    cmdlinePaths: ["/app/task.mjs"],
    http: { method: "DELETE", path: "/repos/example", query: { tag: ["a&b", "c=d"] } },
  });
  const native = state.evaluationRequests[0];
  assert.equal(native.binary_path, "/usr/bin/curl");
  assert.equal(native.binary_sha256, "cd".repeat(32));
  assert.deepEqual(native.ancestors, ["/app/runner"]);
  assert.deepEqual(native.cmdline_paths, ["/app/task.mjs"]);
  assert.equal(native.http.method, "DELETE");
  assert.equal(native.http.path, "/repos/example");
  assert.deepEqual(new URLSearchParams(native.http.query).getAll("tag"), ["a&b", "c=d"]);
  assert.equal(native.expected_policy_hash, HASH);
  assert.equal(result.policyHash, HASH);
  assert.equal(result.applied, false);
  assert.equal(result.decision, "audit");
  assert.deepEqual(result.rules, [
    { id: "policy:web", matched: true, reason: "Destination and binary matched." },
  ]);
  assert.deepEqual(
    result.stages.map(({ decision }) => decision),
    ["allow", "audit"],
  );
  assert.match(result.unevaluatedChecks[0], /DNS/);
});

test("unsupported, stale and denied provider evaluation errors remain explicit and credential-free", async (t) => {
  const { driver, state, context, request, canary } = await fixture(t);
  for (const [code, type] of [
    [grpc.status.UNIMPLEMENTED, NotImplementedError],
    [grpc.status.FAILED_PRECONDITION, ResourceConflictError],
    [grpc.status.PERMISSION_DENIED, DependencyUnavailableError],
  ]) {
    state.error = { code, details: `private diagnostic token=${canary}` };
    await assert.rejects(driver.evaluateNetworkPolicy(context, request), (error) => {
      assert.ok(error instanceof type);
      assert.equal(error.message.includes(canary), false);
      assert.equal(error.message.includes("private diagnostic"), false);
      return true;
    });
  }
});

test("native default denial remains distinct from an authored policy named default-deny", async (t) => {
  const { driver, state, context, request } = await fixture(t);
  state.config.policy.network_policies["default-deny"] = {
    ...state.config.policy.network_policies.web,
    name: "default-deny",
  };
  state.result.decision = "denied";
  state.result.rules = [
    { rule: "default-deny", matched: false, reason: "Named rule did not match.", builtin: false },
    {
      rule: "default-deny",
      matched: true,
      reason: "No eligible named policy matched.",
      builtin: true,
    },
  ];
  const inventory = await driver.describeNetworkPolicy(context);
  const result = await driver.evaluateNetworkPolicy(context, request);
  assert.equal(inventory.rules.find(({ id }) => id === "policy:default-deny").origin, "configured");
  assert.equal(inventory.rules.find(({ id }) => id === "builtin:default-deny").origin, "builtin");
  assert.deepEqual(
    result.rules.map(({ id, matched }) => [id, matched]),
    [
      ["policy:default-deny", false],
      ["builtin:default-deny", true],
    ],
  );
});

test("malformed provider traces fail rather than inventing a policy outcome", async (t) => {
  const { driver, state, context, request } = await fixture(t);
  state.result.decision = "unrecognised";
  await assert.rejects(driver.evaluateNetworkPolicy(context, request), DependencyUnavailableError);
  state.result.decision = "allowed";
  state.result.rules = [{ rule: "unexpected-built-in", builtin: true, matched: true }];
  await assert.rejects(driver.evaluateNetworkPolicy(context, request), DependencyUnavailableError);
});
