import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { getEventListeners, once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createSecureServer } from "node:http2";
import { createServer as createHttpsServer, get as httpsGet } from "node:https";
import test from "node:test";
import {
  GrpcOpenShellGatewayClient,
  OpenShellAdmissionLimitError,
  OpenShellRequestReplayRefusedError,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OpenShellGatewayFailure } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-errors.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import {
  openShellProviderName,
  openShellWorkspaceName,
} from "../../apps/controller/src/backends/openshell.ts";
import { TransientDependencyError } from "../../packages/occ/src/index.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/errors.ts";
import { createManagedWorkloadExec } from "../helpers/egress-managed-workload-exec.mjs";
import { createCustodyTransitions } from "../helpers/egress-supplier-custody-transitions.mjs";
import { agentClients } from "../helpers/egress-custody-observations.mjs";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const grpc = require("@grpc/grpc-js");
const loader = require("@grpc/proto-loader");
// An independent encoder for google.rpc.Status details, as tonic-types writes them.
const protobuf = createRequire(require.resolve("@grpc/proto-loader"))("protobufjs");
const rpcStatus = protobuf.parse(
  `
  syntax = "proto3";
  package google.rpc;
  message Any { string type_url = 1; bytes value = 2; }
  message Status { int32 code = 1; string message = 2; repeated Any details = 3; }
  message ErrorInfo { string reason = 1; string domain = 2; map<string, string> metadata = 3; }
  message RetryInfo { int64 seconds = 1; }
`,
  { keepCase: true },
).root;

function bindWireServer(server, credentials = grpc.ServerCredentials.createInsecure()) {
  return new Promise((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", credentials, (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );
}

test("OpenShell policy updates preserve static and L7 constraints and carry fixed scoped CAS receipts", async (t) => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
    {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: false,
      oneofs: true,
    },
  );
  const OpenShell = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
  // These restrictions must survive decode/re-encode when a network grant is added.
  const policy = {
    version: 1,
    filesystem: { read_only: ["/usr"], read_write: ["/tmp"] },
    process: { run_as_user: "1000", run_as_group: "1000" },
    network_policies: {
      api: {
        name: "api",
        binaries: [{ path: "/usr/bin/python3.11" }],
        endpoints: [
          {
            host: "example.org",
            ports: [443],
            protocol: "rest",
            tls: "NETWORK_TLS_MODE_SKIP",
            enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
            rules: [{ allow: { method: "GET", path: "/status" } }],
            allowed_ips: ["93.184.216.0/24"],
          },
        ],
      },
    },
  };
  const calls = [];
  const server = new grpc.Server();
  server.addService(OpenShell.service, {
    GetSandbox(call, callback) {
      callback(null, {
        sandbox: {
          metadata: {
            name: call.request.name,
            workspace: call.request.workspace_scope.workspace,
            resource_version: "9007199254740993",
          },
          spec: { policy },
        },
      });
    },
    GetSandboxPolicyStatus(call, callback) {
      calls.push(["status", call.request]);
      callback(null, {
        revision: { version: 7, status: "POLICY_STATUS_LOADED", policy },
        active_version: 7,
      });
    },
    UpdateConfig(call, callback) {
      calls.push(["update", call.request]);
      callback(null, { version: 8 });
    },
    GetDraftPolicy(call, callback) {
      calls.push(["draft", call.request]);
      callback(null, {
        draft_version: "19",
        chunks: [
          {
            id: "draft-1",
            status: "pending",
            hit_count: 6,
            proposed_rule: policy.network_policies.api,
          },
        ],
      });
    },
  });
  const port = await bindWireServer(server);
  const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
  t.after(async () => {
    client.close();
    await new Promise((resolve) => server.tryShutdown(resolve));
  });
  const target = { workspace: "exact-workspace", sandbox: "exact-sandbox" };
  const observed = await client.getSandbox(
    { name: target.sandbox, workspace: target.workspace },
    AbortSignal.timeout(2000),
  );
  assert.equal(
    observed.resourceVersion,
    "9007199254740993",
    "sandbox CAS survives without JavaScript numeric rounding",
  );
  const status = await client.getPolicyStatus(target, AbortSignal.timeout(2000));
  assert.equal(status.activeVersion, 7);
  assert.equal(status.state, "POLICY_STATUS_LOADED");
  assert.deepEqual(
    status.policy.network_policies.api.endpoints[0].rules,
    policy.network_policies.api.endpoints[0].rules,
  );
  assert.deepEqual(status.policy.network_policies.api.endpoints[0].allowed_ips, [
    "93.184.216.0/24",
  ]);
  const update = {
    ...target,
    policy: status.policy,
    expectedResourceVersion: "9007199254740993",
    requestId: "79962864-9cdc-4b12-9561-218b42d004b2",
  };
  await client.updatePolicy(update, AbortSignal.timeout(2000));
  await client.updatePolicy(update, AbortSignal.timeout(2000));
  assert.deepEqual(
    calls[1][1],
    calls[2][1],
    "a retry must keep the original CAS version and idempotency UUID",
  );
  assert.equal(calls[1][1].expected_resource_version, update.expectedResourceVersion);
  assert.equal(calls[1][1].request_id, update.requestId);
  assert.deepEqual(calls[1][1].policy, status.policy);
  const drafts = await client.getPolicyDrafts(target, AbortSignal.timeout(2000));
  assert.equal(drafts.version, "19");
  assert.equal(drafts.chunks[0].hit_count, 6);
  assert.deepEqual(
    drafts.chunks[0].proposed_rule.endpoints[0].rules,
    policy.network_policies.api.endpoints[0].rules,
  );
  for (const [, request] of calls) {
    assert.equal(request.sandbox, target.sandbox);
    assert.equal(request.workspace_scope.workspace, target.workspace);
    assert.equal(request.global, undefined, "Agent operations never select global policy");
  }
  await assert.rejects(
    client.updatePolicy({ ...update, expectedResourceVersion: "0" }, AbortSignal.timeout(2000)),
    /nonzero/,
  );
  assert.equal(calls.length, 4, "unsafe CAS is refused before provider dispatch");
});
test(
  "OpenShell private initialization streams stdin and settles only on a complete exit",
  { timeout: 10_000 },
  async (t) => {
    const proto = await loader.load(
      join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
      { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
    );
    const OpenShell = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
    const requests = [];
    const started = Promise.withResolvers();
    const cancelled = Promise.withResolvers();
    const privateOutput = "synthetic private document must never enter errors";
    const server = new grpc.Server();
    server.addService(OpenShell.service, {
      ExecSandbox(call) {
        requests.push(call.request);
        if (call.request.sandbox === "cancel") {
          call.once("cancelled", () => cancelled.resolve());
          started.resolve();
          return;
        }
        call.write({ stdout: { data: Buffer.from(privateOutput) } });
        call.write({ stderr: { data: Buffer.from(privateOutput) } });
        if (call.request.sandbox === "missing-exit") {
          call.end();
          return;
        }
        if (call.request.sandbox === "transport-error") {
          // The process exit is insufficient: a terminal RPC failure must still fail the call.
          call.write({ exit: { exit_code: 0 } }, () => {
            call.emit("error", { code: grpc.status.UNAVAILABLE, details: privateOutput });
          });
          return;
        }
        call.write({ exit: { exit_code: call.request.sandbox === "nonzero" ? 23 : 0 } });
        if (call.request.sandbox === "duplicate-exit") {
          call.write({ exit: { exit_code: 0 } });
        }
        call.end();
      },
    });
    const port = await bindWireServer(server);
    const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
    t.after(() => {
      client.close();
      server.forceShutdown();
    });
    const request = {
      workspace: "initialization-workspace",
      sandbox: "success",
      command: [
        "/usr/bin/flock",
        "/sandbox/initialize.lock",
        "/usr/local/bin/node",
        "-e",
        "fixed writer",
      ],
      environment: { WORKSPACE: "/sandbox/workspace" },
      stdin: JSON.stringify({ files: { "AGENTS.md": "Synthetic private initial instructions" } }),
      timeoutSeconds: 30,
    };
    assert.equal(await client.execSandbox(request, AbortSignal.timeout(3_000)), 0);
    assert.deepEqual(requests[0], {
      workspace_scope: { workspace: request.workspace, selection: "workspace" },
      sandbox: request.sandbox,
      command: request.command,
      environment: request.environment,
      stdin: Buffer.from(request.stdin),
      execution_timeout: { seconds: "30", nanos: 0 },
      tty: false,
      no_login_shell: true,
    });
    assert.equal(
      await client.execSandbox({ ...request, sandbox: "nonzero" }, AbortSignal.timeout(3_000)),
      23,
    );
    for (const sandbox of ["missing-exit", "duplicate-exit", "transport-error"]) {
      await assert.rejects(
        client.execSandbox({ ...request, sandbox }, AbortSignal.timeout(3_000)),
        (error) =>
          !error.message.includes(privateOutput) &&
          (sandbox === "transport-error"
            ? error.grpcStatus === grpc.status.UNAVAILABLE
            : /exit status/.test(error.message)),
      );
    }
    const abort = new AbortController();
    const pending = client.execSandbox({ ...request, sandbox: "cancel" }, abort.signal);
    const rejected = assert.rejects(pending, (error) => error.grpcStatus === grpc.status.CANCELLED);
    await started.promise;
    abort.abort();
    await rejected;
    await cancelled.promise;
    assert.equal(getEventListeners(abort.signal, "abort").length, 0);
    const admitted = requests.length;
    await assert.rejects(
      client.execSandbox({ ...request, stdin: "é".repeat(200_001) }, AbortSignal.timeout(3_000)),
      /execution limits/,
    );
    assert.equal(requests.length, admitted, "oversized UTF-8 payloads never reach the gateway");
  },
);

test("OpenShell HTTP origins keep port 80 in native gRPC connections", async (t) => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
    { keepCase: true, enums: String },
  );
  const OpenShell = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
  const server = new grpc.Server();
  let healthCalls = 0;
  server.addService(OpenShell.service, {
    Health(_call, callback) {
      healthCalls += 1;
      callback(null, { status: "SERVICE_STATUS_HEALTHY" });
    },
  });
  const port = await bindWireServer(server);
  const targets = [];
  const sockets = new Set();
  const proxy = createServer();
  const track = (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    return socket;
  };
  // A real CONNECT tunnel avoids privileged listening ports. It accepts only
  // the configured authorities and forwards their actual gRPC bytes to the peer.
  proxy.on("connect", (request, socket, head) => {
    targets.push(request.url);
    track(socket);
    if (!["gateway.example.test:80", "gateway.example.test:7777"].includes(request.url)) {
      socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const upstream = track(
      connect(port, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) {
          upstream.write(head);
        }
        socket.pipe(upstream);
        upstream.pipe(socket);
      }),
    );
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  });
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => server.tryShutdown(resolve));
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const program = `
    import { OpenShellGateway } from ${JSON.stringify(new URL("../../apps/controller/src/backends/openshell.ts", import.meta.url).href)};
    const gateway = new OpenShellGateway(JSON.parse(process.argv[1]));
    try {
      await gateway.clientForNamespace("tenant-workspace").health(AbortSignal.timeout(2000));
      process.stdout.write("healthy\\n");
    } finally { gateway.close(); }
  `;
  for (const [configuration, target] of [
    [{ endpoint: "gateway.example.test:80" }, "gateway.example.test:80"],
    [{ endpoint: "http://gateway.example.test:80" }, "gateway.example.test:80"],
    [{ endpoint: "http://gateway.example.test" }, "gateway.example.test:80"],
    [{ serviceName: "gateway.example.test", scheme: "http", port: 80 }, "gateway.example.test:80"],
    [{ endpoint: "http://gateway.example.test:7777" }, "gateway.example.test:7777"],
  ]) {
    const before = targets.length;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        program,
        JSON.stringify({ ...configuration, requestTimeoutMs: 1000 }),
      ],
      {
        env: { PATH: process.env.PATH, grpc_proxy: `http://127.0.0.1:${proxy.address().port}` },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      assert.equal(await closed, 0, stderr);
      assert.equal(stdout, "healthy\n");
      assert.deepEqual(targets.slice(before), [target]);
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
      await closed;
    }
  }
  assert.equal(healthCalls, 5);
});

test("OpenShell client serializes v0.1.5 create-time service exposure", async () => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
    { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
  );
  const OpenShell = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
  const createRequests = [];
  const getRequests = [];
  const serviceRequests = [];
  const deleteRequests = [];
  const server = new grpc.Server();

  // Decode with the independently pinned upstream fixture so a production proto
  // field or enum renumbering cannot make both ends agree on an incompatible wire shape.
  server.addService(OpenShell.service, {
    CreateSandbox(call, callback) {
      createRequests.push(call.request);
      if (call.request.name === "sandbox-wire-invalid") {
        callback({
          code: grpc.status.INVALID_ARGUMENT,
          details: "sandbox spec rejected\nby the Kubernetes driver",
        });
        return;
      }
      const omitServiceUrls = call.request.name !== "sandbox-wire";
      callback(null, {
        sandbox: {
          metadata: {
            id: "sandbox-id",
            name: call.request.name,
            workspace: call.request.workspace_scope.workspace,
            labels: call.request.labels,
          },
        },
        ...(omitServiceUrls
          ? {}
          : {
              service_urls: {
                "": `http://tenant-workspace--${call.request.name}.openshell.localhost:8080/`,
              },
            }),
      });
    },
    GetSandbox(call, callback) {
      getRequests.push(call.request);
      const created = createRequests.find(({ name }) => name === call.request.name);
      if (created === undefined) {
        callback({ code: grpc.status.NOT_FOUND });
        return;
      }
      callback(null, {
        sandbox: {
          metadata: {
            id: "sandbox-id",
            name: created.name,
            workspace: created.workspace_scope.workspace,
            labels: created.labels,
            annotations: created.annotations,
          },
          spec: created.spec,
        },
      });
    },
    GetService(call, callback) {
      serviceRequests.push(call.request);
      callback(null, {
        endpoint: {
          sandbox: call.request.sandbox,
          name: call.request.name,
          target_port: 18_790,
          authorization_mode: "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH",
        },
        url: `http://tenant-workspace--${call.request.sandbox}.openshell.localhost:8080/`,
      });
    },
    DeleteSandbox(call, callback) {
      deleteRequests.push(call.request);
      callback(null, { outcome: "DELETION_OUTCOME_COMPLETED", sandbox_id: "sandbox-id" });
    },
  });
  const port = await bindWireServer(server);
  const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });

  try {
    const request = {
      name: "sandbox-wire",
      workspace: "tenant-workspace",
      requestId: "7dfed2b8-8cef-4513-ab04-020baf3ccbf3",
      labels: { owner: "openclaw" },
      annotations: {},
      serviceExposures: [
        { service: "", targetPort: 18_790, authorizationMode: "bearer_passthrough" },
      ],
      spec: {
        policy: {
          network_policies: {
            model: {
              name: "model",
              binaries: [{ path: "/app/bin/model-client" }],
              endpoints: [
                {
                  host: "api.openai.com",
                  ports: [443],
                  protocol: "rest",
                  tls: "NETWORK_TLS_MODE_SKIP",
                  enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
                  access: "NETWORK_ACCESS_PRESET_FULL",
                  path: "/node",
                  websocket_credential_rewrite: true,
                  credential_binding: { provider: "oce-runtime-example" },
                },
              ],
            },
          },
        },
        restart_policy: "SANDBOX_RESTART_POLICY_ALWAYS",
      },
    };
    const created = await client.createSandbox(request, AbortSignal.timeout(2_000));
    const observed = await client.getSandbox(
      { name: request.name, workspace: request.workspace },
      AbortSignal.timeout(2_000),
    );
    const service = await client.getService(
      request.workspace,
      request.name,
      "",
      AbortSignal.timeout(2_000),
    );
    await client.deleteSandbox(
      { name: request.name, workspace: request.workspace },
      AbortSignal.timeout(2_000),
    );

    assert.equal(created.workspace, "tenant-workspace");
    assert.deepEqual(created.serviceUrls, {
      "": `http://tenant-workspace--${request.name}.openshell.localhost:${port}/`,
    });
    assert.deepEqual(observed.annotations, request.annotations);
    assert.deepEqual(observed.spec, request.spec);
    assert.equal(service.targetPort, 18_790);
    assert.equal(service.authorizationMode, "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH");
    assert.equal(
      service.advertisedUrl,
      `http://tenant-workspace--${request.name}.openshell.localhost:8080/`,
    );
    assert.equal(
      service.url,
      `http://tenant-workspace--${request.name}.openshell.localhost:${port}/`,
    );
    assert.deepEqual(createRequests[0].workspace_scope, {
      workspace: "tenant-workspace",
      selection: "workspace",
    });
    assert.deepEqual(deleteRequests[0].workspace_scope, {
      workspace: "tenant-workspace",
      selection: "workspace",
    });
    assert.deepEqual(getRequests[0].workspace_scope, {
      workspace: "tenant-workspace",
      selection: "workspace",
    });
    assert.deepEqual(serviceRequests[0], {
      sandbox: request.name,
      name: "",
      workspace_scope: { workspace: "tenant-workspace", selection: "workspace" },
    });
    assert.equal(createRequests[0].request_id, request.requestId);
    assert.deepEqual(createRequests[0].service_exposures, [
      {
        service: "",
        target_port: 18_790,
        authorization_mode: "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH",
      },
    ]);
    assert.deepEqual(createRequests[0].spec.policy.network_policies.model.endpoints[0], {
      host: "api.openai.com",
      ports: [443],
      protocol: "rest",
      tls: "NETWORK_TLS_MODE_SKIP",
      enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
      access: "NETWORK_ACCESS_PRESET_FULL",
      path: "/node",
      websocket_credential_rewrite: true,
      credential_binding: { provider: "oce-runtime-example" },
    });
    // Field 15 of the pinned gateway's SandboxSpec (finding 1029).
    assert.equal(createRequests[0].spec.restart_policy, "SANDBOX_RESTART_POLICY_ALWAYS");
    assert.deepEqual(createRequests[0].spec.policy.network_policies.model.binaries, [
      { path: "/app/bin/model-client" },
    ]);

    const outboundOnly = await client.createSandbox(
      { ...request, name: "sandbox-wire-outbound-only", serviceExposures: [] },
      AbortSignal.timeout(2_000),
    );
    assert.deepEqual(outboundOnly.serviceUrls, {});
    assert.deepEqual(createRequests[1].service_exposures ?? [], []);

    await assert.rejects(
      client.createSandbox(
        { ...request, name: "sandbox-wire-invalid" },
        AbortSignal.timeout(2_000),
      ),
      (error) => {
        assert.ok(error instanceof DependencyUnavailableError);
        assert.equal(error.grpcStatus, grpc.status.INVALID_ARGUMENT);
        assert.equal(error.code, undefined);
        assert.equal(error.message, "OpenShell CreateSandbox failed with gRPC status 3.");
        assert.deepEqual(error.requestDiagnostic, {
          method: "CreateSandbox",
          grpcStatus: grpc.status.INVALID_ARGUMENT,
          validationCategory: "UNKNOWN",
        });
        return true;
      },
    );

    await assert.rejects(
      client.createSandbox(
        { ...request, name: "sandbox-wire-missing-service-url" },
        AbortSignal.timeout(2_000),
      ),
      /OpenShell CreateSandbox returned no service URL map/,
    );
  } finally {
    client.close();
    await new Promise((resolve) => server.tryShutdown(resolve));
  }
});

test("OpenShell client reports a Sandbox deleted only once OpenShell confirms it", async () => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
    { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
  );
  const OpenShell = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
  const deletes = [];
  const gets = [];
  // Per Sandbox name: how DeleteSandbox answers, and what GetSandbox reports afterwards.
  const scenarios = {
    // Finding 857: OpenShell answers only after the Sandbox Pod's termination grace,
    // which outlasts the ordinary request deadline.
    "sandbox-slow": { delayMs: 1_500, outcome: "DELETION_OUTCOME_COMPLETED" },
    "sandbox-accepted": { outcome: "DELETION_OUTCOME_ACCEPTED", presentFor: 2 },
    "sandbox-no-outcome": { presentFor: 1 },
    "sandbox-replaced": { outcome: "DELETION_OUTCOME_ACCEPTED", replacedBy: "sandbox-id-2" },
    // Without the targeted ID only absence by name counts, so even a replacement holds the
    // wait until the bound.
    "sandbox-stuck": {
      outcome: "DELETION_OUTCOME_ACCEPTED",
      unnamed: true,
      replacedBy: "sandbox-id-2",
    },
    // NOT_FOUND: OpenShell answers it for a Sandbox this identity may not see as for one that
    // is gone (finding 1676), so it confirms nothing and the caller decides with GetWorkspace.
    "sandbox-missing": { notFound: true },
  };
  const server = new grpc.Server();
  server.addService(OpenShell.service, {
    DeleteSandbox(call, callback) {
      deletes.push(call.request.name);
      const scenario = scenarios[call.request.name];
      if (scenario.notFound) {
        callback({ code: grpc.status.NOT_FOUND, details: "sandbox not found" });
        return;
      }
      setTimeout(
        () =>
          callback(null, {
            ...(scenario.outcome === undefined ? {} : { outcome: scenario.outcome }),
            ...(scenario.unnamed ? {} : { sandbox_id: "sandbox-id-1" }),
          }),
        scenario.delayMs ?? 0,
      );
    },
    GetSandbox(call, callback) {
      gets.push(call.request.name);
      const scenario = scenarios[call.request.name];
      const seen = gets.filter((name) => name === call.request.name).length;
      if (scenario.replacedBy === undefined && seen > scenario.presentFor) {
        callback({ code: grpc.status.NOT_FOUND });
        return;
      }
      callback(null, {
        sandbox: {
          metadata: {
            id: scenario.replacedBy ?? "sandbox-id-1",
            name: call.request.name,
            workspace: call.request.workspace_scope.workspace,
          },
        },
      });
    },
  });
  const port = await bindWireServer(server);
  const client = new GrpcOpenShellGatewayClient({
    endpoint: `127.0.0.1:${port}`,
    requestTimeoutMs: 1_000,
    sandboxDeleteTimeoutMs: 3_000,
  });
  const remove = (name) =>
    client.deleteSandbox({ name, workspace: "tenant-workspace" }, AbortSignal.timeout(10_000));

  try {
    await remove("sandbox-slow");
    assert.deepEqual(gets, []);

    await remove("sandbox-accepted");
    assert.deepEqual(gets, ["sandbox-accepted", "sandbox-accepted", "sandbox-accepted"]);

    await remove("sandbox-no-outcome");
    assert.equal(gets.filter((name) => name === "sandbox-no-outcome").length, 2);

    await remove("sandbox-replaced");
    assert.equal(gets.filter((name) => name === "sandbox-replaced").length, 1);

    const started = Date.now();
    await assert.rejects(remove("sandbox-stuck"), (error) => {
      assert.ok(error instanceof DependencyUnavailableError);
      assert.match(error.message, /did not finish it within 3 s/);
      return true;
    });
    assert.ok(Date.now() - started < 5_000);
    await assert.rejects(remove("sandbox-missing"), (error) => {
      assert.ok(error instanceof OpenShellGatewayFailure, String(error));
      assert.match(
        error.message,
        /DeleteSandbox did not find the Sandbox, so the deletion is unconfirmed/,
      );
      // The code the worker's sweep logs apart from a failure (finding 1696).
      assert.equal(error.code, "SANDBOX_DELETION_UNCONFIRMED");
      assert.equal(error.cause?.code, grpc.status.NOT_FOUND);
      return true;
    });
    assert.equal(gets.includes("sandbox-missing"), false);
    assert.deepEqual(deletes, Object.keys(scenarios));

    const aborted = new AbortController();
    const cancelled = client.deleteSandbox(
      { name: "sandbox-stuck", workspace: "tenant-workspace" },
      aborted.signal,
    );
    setTimeout(() => aborted.abort(new Error("cancelled by test")), 700);
    await assert.rejects(cancelled, /cancelled by test/);
  } finally {
    client.close();
    await new Promise((resolve) => server.tryShutdown(resolve));
  }
});

test("OpenShell client reads an existing Sandbox and its service endpoint", async () => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
    { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
  );
  const OpenShell = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
  const requests = [];
  const notFound = (callback) =>
    callback(Object.assign(new Error("not found"), { code: grpc.status.NOT_FOUND }));
  const server = new grpc.Server();
  server.addService(OpenShell.service, {
    GetSandbox(call, callback) {
      requests.push(["GetSandbox", call.request]);
      if (call.request.name !== "sandbox-wire") {
        notFound(callback);
        return;
      }
      callback(null, {
        sandbox: {
          metadata: {
            id: "sandbox-id",
            name: call.request.name,
            workspace: call.request.workspace_scope.workspace,
            labels: { owner: "openclaw" },
            annotations: { "openclaw.dev/revision-id": "rev_wire" },
          },
        },
      });
    },
    GetService(call, callback) {
      requests.push(["GetService", call.request]);
      if (call.request.sandbox !== "sandbox-wire") {
        notFound(callback);
        return;
      }
      callback(null, {
        endpoint: { sandbox: call.request.sandbox, name: call.request.name, target_port: 18_790 },
        url: "http://tenant-workspace--sandbox-wire.openshell.localhost:8080/",
      });
    },
    // Per Sandbox name: how DeleteService answers (finding 1657).
    DeleteService(call, callback) {
      requests.push(["DeleteService", call.request]);
      const outcomes = {
        "sandbox-wire": { outcome: "DELETION_OUTCOME_COMPLETED" },
        "sandbox-absent": { outcome: "DELETION_OUTCOME_ALREADY_ABSENT" },
        "sandbox-accepted": { outcome: "DELETION_OUTCOME_ACCEPTED" },
        "sandbox-silent": {},
      };
      const answer = outcomes[call.request.sandbox];
      if (answer === undefined) {
        notFound(callback);
        return;
      }
      callback(null, answer);
    },
  });
  const port = await bindWireServer(server);
  const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
  const signal = AbortSignal.timeout(2_000);
  try {
    // A service is gone on COMPLETED or ALREADY_ABSENT only; an accepted or unstated outcome
    // is not a confirmation, so the exposure is reported as still present. Neither is
    // NOT_FOUND: OpenShell answers it for a Sandbox this identity may not see as for one that
    // is gone (finding 1670), so the caller confirms with a read it can trust.
    for (const sandbox of ["sandbox-wire", "sandbox-absent"]) {
      await client.deleteService("tenant-workspace", sandbox, "", signal);
    }
    for (const sandbox of ["sandbox-accepted", "sandbox-silent"]) {
      await assert.rejects(
        client.deleteService("tenant-workspace", sandbox, "", signal),
        /DeleteService did not confirm deletion/,
      );
    }
    await assert.rejects(
      client.deleteService("tenant-workspace", "sandbox-missing", "", signal),
      (error) => {
        assert.match(
          error.message,
          /DeleteService did not find the Sandbox, so the deletion is unconfirmed/,
        );
        assert.equal(error.code, "SANDBOX_DELETION_UNCONFIRMED");
        return true;
      },
    );
    const deletions = requests.filter(([method]) => method === "DeleteService");
    assert.equal(deletions.length, 5);
    // The delete is idempotent by itself: no request_id, so no durable admission per pass.
    assert.deepEqual(deletions[0][1], {
      sandbox: "sandbox-wire",
      name: "",
      workspace_scope: { workspace: "tenant-workspace", selection: "workspace" },
      allow_missing: true,
    });
    requests.length = 0;
    const sandbox = await client.getSandbox(
      { name: "sandbox-wire", workspace: "tenant-workspace" },
      signal,
    );
    assert.equal(sandbox.name, "sandbox-wire");
    assert.equal(sandbox.workspace, "tenant-workspace");
    assert.deepEqual(sandbox.annotations, { "openclaw.dev/revision-id": "rev_wire" });
    assert.deepEqual(sandbox.serviceUrls, {});
    assert.equal(
      await client.getSandbox({ name: "missing", workspace: "tenant-workspace" }, signal),
      undefined,
    );
    assert.equal(
      await client.getServiceUrl(
        { sandbox: "sandbox-wire", workspace: "tenant-workspace", service: "" },
        signal,
      ),
      `http://tenant-workspace--sandbox-wire.openshell.localhost:${port}/`,
    );
    assert.equal(
      await client.getServiceUrl(
        { sandbox: "missing", workspace: "tenant-workspace", service: "" },
        signal,
      ),
      undefined,
    );
    assert.deepEqual(requests[0], [
      "GetSandbox",
      {
        name: "sandbox-wire",
        workspace_scope: { workspace: "tenant-workspace", selection: "workspace" },
      },
    ]);
    assert.deepEqual(requests[2], [
      "GetService",
      {
        sandbox: "sandbox-wire",
        name: "",
        workspace_scope: { workspace: "tenant-workspace", selection: "workspace" },
      },
    ]);
  } finally {
    client.close();
    await new Promise((resolve) => server.tryShutdown(resolve));
  }
});

test("OpenShell client reads the pinned gateway's Harness restart state from GetSandbox", async () => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
    { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
  );
  const OpenShell = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
  // SandboxStatus fields 6, 9 and 14 as the gateway sets them (finding 1043).
  const statuses = {
    "sandbox-restarting": { phase: "SANDBOX_PHASE_STARTING", exit_code: 137, restart_count: 4 },
    "sandbox-exited-zero": { phase: "SANDBOX_PHASE_STARTING", exit_code: 0, restart_count: 1 },
    "sandbox-first-start": { phase: "SANDBOX_PHASE_STARTING" },
    "sandbox-recovered": { phase: "SANDBOX_PHASE_READY", restart_count: 3 },
  };
  const server = new grpc.Server();
  server.addService(OpenShell.service, {
    GetSandbox(call, callback) {
      callback(null, {
        sandbox: {
          metadata: { id: "sandbox-id", name: call.request.name, workspace: "tenant-workspace" },
          status: statuses[call.request.name],
        },
      });
    },
  });
  const port = await bindWireServer(server);
  const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
  const signal = AbortSignal.timeout(2_000);
  try {
    const read = async (name) => {
      const { phase, exitCode, restartCount } = await client.getSandbox(
        { name, workspace: "tenant-workspace" },
        signal,
      );
      return { phase, exitCode, restartCount };
    };
    assert.deepEqual(await read("sandbox-restarting"), {
      phase: "SANDBOX_PHASE_STARTING",
      exitCode: 137,
      restartCount: 4,
    });
    // `exit_code` is a proto3 optional: a clean exit is present as 0, not absent.
    assert.deepEqual(await read("sandbox-exited-zero"), {
      phase: "SANDBOX_PHASE_STARTING",
      exitCode: 0,
      restartCount: 1,
    });
    assert.deepEqual(await read("sandbox-first-start"), {
      phase: "SANDBOX_PHASE_STARTING",
      exitCode: undefined,
      restartCount: undefined,
    });
    assert.deepEqual(await read("sandbox-recovered"), {
      phase: "SANDBOX_PHASE_READY",
      exitCode: undefined,
      restartCount: 3,
    });
  } finally {
    client.close();
    await new Promise((resolve) => server.tryShutdown(resolve));
  }
});

test("OpenShell client reports a refused CreateSandbox request_id from its ErrorInfo reason", async () => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
    { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
  );
  const OpenShell = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
  const any = (type, message) => ({
    type_url: `type.googleapis.com/google.rpc.${type}`,
    value: rpcStatus.lookupType(`google.rpc.${type}`).encode(message).finish(),
  });
  const failure = (
    reason,
    domain = "openshell.nvidia.com",
    code = grpc.status.FAILED_PRECONDITION,
  ) => {
    const metadata = new grpc.Metadata();
    const Status = rpcStatus.lookupType("google.rpc.Status");
    metadata.set(
      "grpc-status-details-bin",
      Buffer.from(
        Status.encode(
          Status.fromObject({
            code,
            message: `refused ${reason}`,
            details: [
              any("RetryInfo", { seconds: 5 }),
              any("ErrorInfo", { reason, domain, metadata: { recovery: "none" } }),
            ],
          }),
        ).finish(),
      ),
    );
    return { code: grpc.status.FAILED_PRECONDITION, details: `refused ${reason}`, metadata };
  };
  const server = new grpc.Server();
  server.addService(OpenShell.service, {
    CreateSandbox(call, callback) {
      const [reason, domain, code] = call.request.name.split("|");
      callback(
        reason === "PLAIN"
          ? { code: grpc.status.FAILED_PRECONDITION, details: "provider 'x' not found" }
          : failure(reason, domain || undefined, code === undefined ? undefined : Number(code)),
      );
    },
  });
  const port = await bindWireServer(server);
  const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
  const create = (name) =>
    client.createSandbox(
      {
        name,
        workspace: "tenant-workspace",
        requestId: "7dfed2b8-8cef-4513-ab04-020baf3ccbf3",
        labels: {},
        annotations: {},
        spec: {},
        serviceExposures: [],
      },
      AbortSignal.timeout(2_000),
    );
  try {
    for (const reason of [
      "REQUEST_OUTCOME_UNCERTAIN",
      "REQUEST_ID_PAYLOAD_MISMATCH",
      "REQUEST_REPLAY_UNAVAILABLE",
    ]) {
      await assert.rejects(create(reason), (error) => {
        assert.ok(error instanceof OpenShellRequestReplayRefusedError);
        assert.equal(error.reason, reason);
        assert.match(error.message, new RegExp(`refused ${reason}`));
        return true;
      });
    }
    // Only OpenShell's own replay reasons are refusals; anything else is the handler's error.
    for (const name of [
      "REQUEST_OUTCOME_UNCERTAIN|example.com",
      // The details envelope must carry the same status code.
      `REQUEST_OUTCOME_UNCERTAIN||${grpc.status.ABORTED}`,
      "SANDBOX_INVALID",
      "PLAIN",
    ]) {
      await assert.rejects(create(name), (error) => {
        assert.ok(!(error instanceof OpenShellRequestReplayRefusedError));
        assert.equal(error.code, grpc.status.FAILED_PRECONDITION);
        return true;
      });
    }
  } finally {
    client.close();
    await new Promise((resolve) => server.tryShutdown(resolve));
  }
});

test("OpenShell client holds only the durable admission limit as a transient dependency", async () => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
    { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
  );
  const OpenShell = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
  // The pinned gateway's exact refusal once a caller holds 1000 durable admissions.
  const limit =
    "caller has reached the durable mutation admission limit; unresolved requests require reconciliation";
  const refuse = (details, callback) => callback({ code: grpc.status.RESOURCE_EXHAUSTED, details });
  const server = new grpc.Server();
  server.addService(OpenShell.service, {
    CreateSandbox: (call, callback) => refuse(call.request.name, callback),
    CreateProvider: (call, callback) => refuse(call.request.provider.metadata.name, callback),
  });
  const port = await bindWireServer(server);
  const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
  const create = (name) =>
    client.createSandbox(
      {
        name,
        workspace: "tenant-workspace",
        requestId: "7dfed2b8-8cef-4513-ab04-020baf3ccbf3",
        labels: {},
        annotations: {},
        spec: {},
        serviceExposures: [],
      },
      AbortSignal.timeout(2_000),
    );
  try {
    // The limit clears only as completed admissions age out (24 h) or an operator
    // reconciles unresolved ones, so the worker must hold the revision pending until the
    // deployment deadline instead of spending its attempt budget on quick retries.
    for (const refused of [
      create(limit),
      client.createProvider(
        { name: limit, type: "openai", workspace: "tenant-workspace", labels: {}, credentials: {} },
        AbortSignal.timeout(2_000),
      ),
    ]) {
      await assert.rejects(refused, (error) => {
        assert.ok(error instanceof OpenShellAdmissionLimitError, String(error));
        assert.ok(error instanceof TransientDependencyError);
        assert.equal(error.dependency, "sandbox_admission");
        assert.equal(error.code, "SANDBOX_ADMISSION_LIMIT_REACHED");
        assert.match(error.message, /limit of 1000 durable request admissions.*then redeploy/);
        assert.equal(error.cause.code, grpc.status.RESOURCE_EXHAUSTED);
        return true;
      });
    }
    // OpenShell's other RESOURCE_EXHAUSTED refusals stay the raw gRPC error, which the
    // worker classifies as an ordinary retryable failure.
    for (const details of [
      "gRPC rate limit exceeded",
      "mutation admission workers are busy; no work was started by this call",
    ]) {
      await assert.rejects(create(details), (error) => {
        assert.ok(!(error instanceof TransientDependencyError), String(error));
        assert.equal(error.code, grpc.status.RESOURCE_EXHAUSTED);
        assert.equal(error.details, details);
        return true;
      });
    }
  } finally {
    client.close();
    await new Promise((resolve) => server.tryShutdown(resolve));
  }
});

test("OpenShell client serializes v0.1.5 credential providers, profiles, and attachment status", async () => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
    { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
  );
  const OpenShell = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
  const requests = { profiles: [], providers: [], sandboxes: [], statuses: [] };
  const server = new grpc.Server();

  // The upstream oracle decodes every request, so a renumbered credential, endpoint path, or
  // provider attachment field fails here instead of silently dropping an injected credential.
  server.addService(OpenShell.service, {
    ImportProviderProfiles(call, callback) {
      requests.profiles.push(call.request);
      callback(null, {
        imported: true,
        profiles: call.request.profiles.map((item) => item.profile),
      });
    },
    CreateProvider(call, callback) {
      requests.providers.push(call.request);
      // Echo the credential so the assertion below proves the client, not this stub, redacts it.
      callback(null, { provider: call.request.provider });
    },
    CreateSandbox(call, callback) {
      requests.sandboxes.push(call.request);
      callback(null, {
        sandbox: { metadata: { name: call.request.name, labels: {} } },
        service_urls: {
          "": `http://tenant-workspace--${call.request.name}.openshell.localhost:8080/`,
        },
      });
    },
    GetSandboxProviderStatus(call, callback) {
      requests.statuses.push(call.request);
      callback(null, {
        status: {
          state: "PROVIDER_READINESS_STATE_READY",
          reason: "PROVIDER_READINESS_REASON_UNSPECIFIED",
        },
      });
    },
  });
  const port = await bindWireServer(server);
  const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });

  try {
    // Client initialization yields; cancel before it can dispatch the mutation.
    const abort = new AbortController();
    const pending = client.createProvider(
      {
        workspace: "tenant-workspace",
        name: "cancelled-source",
        type: "oce-openai",
        labels: {},
        credentials: { OPENAI_API_KEY: "wire-test-value" },
        credentialExpirationTimes: {
          OPENAI_API_KEY: "2026-10-01T18:00:00.123Z",
        },
      },
      abort.signal,
    );
    abort.abort(new Error("cancelled during setup"));
    await assert.rejects(pending, /cancelled during setup/);
    assert.equal(requests.providers.length, 0);

    await client.importProviderProfile(
      "tenant-workspace",
      {
        id: "oce-openai",
        displayName: "OpenAI",
        category: "PROVIDER_PROFILE_CATEGORY_INFERENCE",
        credentials: [
          {
            name: "api_key",
            envVars: ["OPENAI_API_KEY"],
            required: true,
            authStyle: "bearer",
            headerName: "authorization",
          },
        ],
        files: [
          {
            path: "runtime.json",
            content: "{{config.runtime_json}}",
            environmentVariable: "OPENCLAW_PLUGIN_RUNTIME_MANIFEST",
          },
        ],
        endpoints: [{ host: "api.openai.com", port: 443, protocol: "rest", path: "/v1/**" }],
        binaries: ["/app/bin/codex"],
        inferenceCapable: true,
        annotations: { "openclaw.dev/profile-digest": "digest" },
      },
      AbortSignal.timeout(2_000),
    );
    const provider = await client.createProvider(
      {
        workspace: "tenant-workspace",
        name: "oce-cs-000000000000000000000000",
        type: "oce-openai",
        labels: { "openclaw.dev/credential-source-id": "cs_example" },
        credentials: { OPENAI_API_KEY: "wire-test-value" },
        credentialExpirationTimes: {
          OPENAI_API_KEY: "2026-10-01T18:00:00.123Z",
        },
        config: { runtime_json: '{"kind":"codex","selections":{}}' },
      },
      AbortSignal.timeout(2_000),
    );
    await client.createSandbox(
      {
        name: "sandbox-wire",
        workspace: "tenant-workspace",
        requestId: "7dfed2b8-8cef-4513-ab04-020baf3ccbf3",
        labels: {},
        annotations: {},
        serviceExposures: [],
        spec: { providers: ["oce-cs-000000000000000000000000"] },
      },
      AbortSignal.timeout(2_000),
    );
    const status = await client.getSandboxProviderStatus(
      "tenant-workspace",
      "sandbox-wire",
      "oce-cs-000000000000000000000000",
      AbortSignal.timeout(2_000),
    );

    const [profileImport] = requests.profiles;
    assert.deepEqual(profileImport.workspace_scope, {
      workspace: "tenant-workspace",
      selection: "workspace",
    });
    assert.deepEqual(profileImport.profiles[0].profile.credentials, [
      {
        name: "api_key",
        env_vars: ["OPENAI_API_KEY"],
        required: true,
        auth_style: "bearer",
        header_name: "authorization",
      },
    ]);
    assert.deepEqual(profileImport.profiles[0].profile.files, [
      {
        path: "runtime.json",
        content: "{{config.runtime_json}}",
        env_var: "OPENCLAW_PLUGIN_RUNTIME_MANIFEST",
      },
    ]);
    assert.deepEqual(profileImport.profiles[0].profile.endpoints, [
      {
        host: "api.openai.com",
        port: 443,
        protocol: "rest",
        path: "/v1/**",
        enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
        access: "NETWORK_ACCESS_PRESET_READ_WRITE",
      },
    ]);
    assert.deepEqual(profileImport.profiles[0].profile.binaries, [{ path: "/app/bin/codex" }]);
    assert.equal(profileImport.profiles[0].profile.category, "PROVIDER_PROFILE_CATEGORY_INFERENCE");
    // Provider credentials are keyed by the environment variable the supervisor injects.
    assert.deepEqual(requests.providers[0].provider.credentials, {
      OPENAI_API_KEY: "wire-test-value",
    });
    assert.deepEqual(requests.providers[0].provider.credential_expiration_times, {
      OPENAI_API_KEY: { seconds: "1790877600", nanos: 123_000_000 },
    });
    assert.equal(requests.providers[0].provider.type, "oce-openai");
    assert.deepEqual(requests.providers[0].provider.config, {
      runtime_json: '{"kind":"codex","selections":{}}',
    });
    assert.deepEqual(provider.config, {
      runtime_json: '{"kind":"codex","selections":{}}',
    });
    // The profile lives in the provider's workspace, not in platform scope.
    assert.equal(requests.providers[0].provider.profile_workspace, "tenant-workspace");
    assert.equal(
      requests.providers[0].provider.metadata.labels["openclaw.dev/credential-source-id"],
      "cs_example",
    );
    // The client never copies credential material out of a gateway response.
    assert.equal(JSON.stringify(provider).includes("wire-test-value"), false);
    assert.deepEqual(requests.sandboxes[0].spec.providers, ["oce-cs-000000000000000000000000"]);
    assert.equal(requests.statuses[0].sandbox, "sandbox-wire");
    assert.equal(requests.statuses[0].provider, "oce-cs-000000000000000000000000");
    assert.deepEqual(status, {
      state: "PROVIDER_READINESS_STATE_READY",
      reason: "PROVIDER_READINESS_REASON_UNSPECIFIED",
    });
  } finally {
    client.close();
    await new Promise((resolve) => server.tryShutdown(resolve));
  }
});

test("OpenShell client retries setup after a failed first connection", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openshell-client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rootCertificatePath = join(directory, "ca.pem");
  // Nothing listens here; once setup succeeds the call fails on the transport.
  const client = new GrpcOpenShellGatewayClient({
    endpoint: "https://127.0.0.1:1",
    rootCertificatePath,
    requestTimeoutMs: 1_000,
  });
  const signal = new AbortController().signal;
  try {
    await assert.rejects(client.health(signal), { code: "ENOENT" });
    await writeFile(
      rootCertificatePath,
      "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n",
    );
    await assert.rejects(client.health(signal), (error) => {
      assert.ok(error instanceof DependencyUnavailableError);
      assert.equal(error.grpcStatus, grpc.status.UNAVAILABLE);
      return true;
    });
  } finally {
    client.close();
  }
});

// Findings 2040 and 2042: only a gateway that did not answer (grpc-js reached nothing at its
// address, or lost the connection under the call) is a Sandbox gateway outage, which a revision
// pass waits out instead of spending its attempt budget. It stays a DependencyUnavailableError
// (HTTP 503, other work's retries), keeps its gRPC status, and never carries the gateway's text.
// An UNAVAILABLE the gateway answers itself (at the pinned OpenShell: resource admission's
// Kubernetes 403/401/TLS errors, credential driver errors) and every other failure keep the
// ordinary class, so they spend the attempt budget and fail within it.
test("OpenShell client names only an unanswered gateway request a Sandbox gateway outage", async (t) => {
  // The class the worker's revision pass waits on.
  const { SandboxGatewayUnavailableError } = await import("../../packages/occ/src/index.ts");
  const { constants: http2Constants, createServer: createH2cServer } = await import("node:http2");
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
    { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
  );
  const OpenShell = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
  // The pinned gateway's resource admission answer to a Kubernetes 403.
  const refusal =
    "gateway is forbidden from reading metadata for Secret tenant/model (Kubernetes 403); check gateway RBAC";
  const answers = [
    grpc.status.UNAVAILABLE,
    grpc.status.INTERNAL,
    grpc.status.DEADLINE_EXCEEDED,
    grpc.status.UNKNOWN,
  ];
  const server = new grpc.Server();
  server.addService(OpenShell.service, {
    Health: (_call, callback) => callback({ code: answers.shift(), details: refusal }),
    CreateSandbox: (_call, callback) =>
      callback({ code: grpc.status.UNAVAILABLE, details: refusal }),
    ExecSandbox: (call) => call.emit("error", { code: grpc.status.UNAVAILABLE, details: refusal }),
  });
  const port = await bindWireServer(server);
  const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
  // A gateway scaled to zero: nothing listens at its address.
  const stopped = new GrpcOpenShellGatewayClient({
    endpoint: "127.0.0.1:1",
    requestTimeoutMs: 2_000,
  });
  t.after(async () => {
    client.close();
    stopped.close();
    await new Promise((resolve) => server.tryShutdown(resolve));
  });
  const sandbox = {
    name: "outage",
    workspace: "tenant-workspace",
    requestId: "0b0f7c43-3c55-4a8a-9d1c-b3f3a0b1d1c9",
    labels: {},
    annotations: {},
    spec: {},
    serviceExposures: [],
  };
  const exec = {
    workspace: "tenant-workspace",
    sandbox: "outage",
    command: ["/bin/true"],
    environment: {},
    stdin: "",
    timeoutSeconds: 5,
  };
  const outage = (error) => {
    assert.ok(error instanceof SandboxGatewayUnavailableError, String(error));
    assert.ok(error instanceof DependencyUnavailableError);
    assert.ok(!(error instanceof TransientDependencyError));
    assert.equal(error.grpcStatus, grpc.status.UNAVAILABLE);
    return true;
  };
  const answered = (code) => (error) => {
    assert.ok(error instanceof DependencyUnavailableError, String(error));
    assert.ok(!(error instanceof SandboxGatewayUnavailableError), String(error));
    assert.equal(error.grpcStatus, code);
    assert.equal(error.message.includes(refusal), false);
    return true;
  };

  // The gateway answered UNAVAILABLE with its reason: an ordinary failed request.
  await assert.rejects(
    client.health(AbortSignal.timeout(2_000)),
    answered(grpc.status.UNAVAILABLE),
  );
  for (const code of [grpc.status.INTERNAL, grpc.status.DEADLINE_EXCEEDED, grpc.status.UNKNOWN]) {
    await assert.rejects(client.health(AbortSignal.timeout(2_000)), answered(code));
  }
  // CreateSandbox keeps closed diagnostics (finding 2040): the gateway's reason stays out of
  // the message, which HTTP dependency logging also emits.
  await assert.rejects(client.createSandbox(sandbox, AbortSignal.timeout(2_000)), (error) => {
    assert.ok(error instanceof DependencyUnavailableError, String(error));
    assert.ok(!(error instanceof SandboxGatewayUnavailableError), String(error));
    assert.equal(error.grpcStatus, grpc.status.UNAVAILABLE);
    assert.equal(
      error.message,
      `OpenShell CreateSandbox failed with gRPC status ${grpc.status.UNAVAILABLE}.`,
    );
    assert.equal(error.message.includes(refusal), false);
    return true;
  });
  await assert.rejects(
    client.execSandbox(exec, AbortSignal.timeout(2_000)),
    answered(grpc.status.UNAVAILABLE),
  );

  // Nothing listens at the gateway's address.
  await assert.rejects(stopped.health(AbortSignal.timeout(3_000)), outage);
  await assert.rejects(stopped.createSandbox(sandbox, AbortSignal.timeout(3_000)), outage);
  await assert.rejects(stopped.execSandbox(exec, AbortSignal.timeout(3_000)), outage);

  // The gateway process goes away under a call it received: the connection drops.
  const received = Promise.withResolvers();
  const connections = [];
  const dropping = createH2cServer();
  dropping.on("connection", (socket) => connections.push(socket));
  dropping.on("stream", () => received.resolve());
  await new Promise((resolve) => dropping.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => dropping.close(resolve)));
  const dropped = new GrpcOpenShellGatewayClient({
    endpoint: `127.0.0.1:${dropping.address().port}`,
  });
  t.after(() => dropped.close());
  const inFlight = dropped.health(AbortSignal.timeout(5_000));
  await received.promise;
  for (const socket of connections) {
    socket.destroy();
  }
  await assert.rejects(inFlight, outage);

  // The gateway refuses every stream before handling it, as while it shuts down.
  const refusing = createH2cServer();
  refusing.on("stream", (stream) => {
    stream.on("error", () => {});
    stream.close(http2Constants.NGHTTP2_REFUSED_STREAM);
  });
  await new Promise((resolve) => refusing.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => refusing.close(resolve)));
  const refused = new GrpcOpenShellGatewayClient({
    endpoint: `127.0.0.1:${refusing.address().port}`,
  });
  t.after(() => refused.close());
  await assert.rejects(refused.health(AbortSignal.timeout(5_000)), outage);
});

function selfSignedCertificate(directory, name, subjectAltName) {
  const keyPath = join(directory, `${name}.key`);
  const certPath = join(directory, `${name}.crt`);
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=openshell-gateway",
      "-addext",
      `subjectAltName=${subjectAltName}`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr || generated.error?.message);
  return { keyPath, certPath };
}

// A TLS gRPC listener that answers Health and records the SNI of every connection
// and the path of every request it receives.
async function tlsHealthGateway(keyPath, certPath, bind, seen) {
  const gateway = createSecureServer({
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
  });
  gateway.on("secureConnection", (socket) => seen.push(["sni", socket.servername]));
  gateway.on("stream", (stream, headers) => {
    seen.push(["request", headers[":path"]]);
    stream.respond(
      { ":status": 200, "content-type": "application/grpc" },
      { waitForTrailers: true },
    );
    stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
    // HealthResponse { status: SERVICE_STATUS_HEALTHY } in one uncompressed gRPC frame.
    stream.end(Buffer.from([0, 0, 0, 0, 2, 0x08, 0x01]));
  });
  await new Promise((resolve, reject) => {
    gateway.once("error", reject);
    gateway.listen(0, bind, resolve);
  });
  return gateway;
}

test("OpenShell client verifies a TLS gateway at an IP endpoint against that IP and sends no SNI", async (t) => {
  const { SandboxGatewayUnavailableError } = await import("../../packages/occ/src/index.ts");
  const directory = await mkdtemp(join(tmpdir(), "openshell-grpc-tls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // IPv6 loopback is optional on CI hosts; without it the IPv6 cases are skipped.
  // The probe only binds, so it needs no certificate.
  const probe = createSecureServer();
  const ipv6 = await new Promise((resolve) => {
    probe.once("error", () => resolve(false));
    probe.listen(0, "::1", () => probe.close(() => resolve(true)));
  });
  const health = ["request", "/openshell.v1.OpenShell/Health"];
  const cases = [
    // A DNS endpoint is sent as SNI and verified by name, as before.
    { name: "dns", san: "DNS:localhost", bind: "localhost", host: "localhost", sni: "localhost" },
    // TLS forbids an IP in SNI: the certificate must carry the endpoint IP itself.
    { name: "ipv4", san: "IP:127.0.0.1", bind: "127.0.0.1", host: "127.0.0.1", sni: false },
    { name: "ipv6", san: "IP:::1", bind: "::1", host: "[::1]", sni: false, needsIpv6: true },
    // A hex IPv6 literal (IPv4-mapped, so it reaches the IPv4 loopback listener).
    {
      name: "ipv6-hex",
      san: "IP:::ffff:7f00:1",
      bind: "127.0.0.1",
      host: "[::ffff:7f00:1]",
      sni: false,
      needsIpv6: true,
    },
    // A gateway certificate the client's CA does not vouch for: a configuration error, not an
    // outage, so it fails within the attempt budget (finding 2042). The dual-stack listener takes
    // every address localhost resolves to, so no refused address hides the certificate error
    // (grpc-js reports only the last address's error).
    {
      name: "untrusted-dns",
      san: "DNS:localhost",
      bind: "::",
      host: "localhost",
      untrusted: true,
      needsIpv6: true,
    },
    { name: "wrong-ip", san: "IP:127.0.0.2", bind: "127.0.0.1", host: "127.0.0.1" },
    // A name certificate does not vouch for an IP endpoint, even one that resolves there.
    { name: "name-for-ip", san: "DNS:localhost", bind: "127.0.0.1", host: "127.0.0.1" },
  ];
  // A gateway that answers through a certificate the client does not trust never answered it, but
  // waiting cannot fix that: it is an ordinary failed request, not a Sandbox gateway outage.
  const untrusted = (error) => {
    assert.ok(error instanceof DependencyUnavailableError, String(error));
    assert.ok(!(error instanceof SandboxGatewayUnavailableError), String(error));
    assert.equal(error.grpcStatus, grpc.status.UNAVAILABLE);
    return true;
  };
  const otherAuthority = selfSignedCertificate(directory, "other-authority", "DNS:localhost");
  for (const { name, san, bind, host, sni, needsIpv6, untrusted: distrusted } of cases) {
    await t.test(
      name,
      { skip: needsIpv6 && !ipv6 && "IPv6 loopback ::1 is unavailable" },
      async (t) => {
        const { keyPath, certPath } = selfSignedCertificate(directory, name, san);
        const seen = [];
        const gateway = await tlsHealthGateway(keyPath, certPath, bind, seen);
        t.after(() => new Promise((resolve) => gateway.close(resolve)));
        const client = new GrpcOpenShellGatewayClient({
          endpoint: `https://${host}:${gateway.address().port}`,
          rootCertificatePath: distrusted ? otherAuthority.certPath : certPath,
          requestTimeoutMs: 5_000,
        });
        t.after(() => client.close());
        const signal = AbortSignal.timeout(10_000);
        if (sni !== undefined) {
          await client.health(signal);
          assert.deepEqual(seen, [["sni", sni], health]);
          return;
        }
        await assert.rejects(client.health(signal), untrusted);
        assert.deepEqual(
          seen.filter(([kind]) => kind === "request"),
          [],
          "an unverified listener never receives a request",
        );
      },
    );
  }
  // Clients of one IP endpoint never share a verified connection: a client that does not
  // trust the gateway's certificate still fails while a trusting client is connected.
  await t.test("untrusted-beside-trusted", async (t) => {
    const { keyPath, certPath } = selfSignedCertificate(directory, "shared", "IP:127.0.0.1");
    const other = selfSignedCertificate(directory, "other", "IP:127.0.0.1");
    const seen = [];
    const gateway = await tlsHealthGateway(keyPath, certPath, "127.0.0.1", seen);
    t.after(() => new Promise((resolve) => gateway.close(resolve)));
    const endpoint = `https://127.0.0.1:${gateway.address().port}`;
    const client = (rootCertificatePath) => {
      const created = new GrpcOpenShellGatewayClient({
        endpoint,
        rootCertificatePath,
        requestTimeoutMs: 5_000,
      });
      t.after(() => created.close());
      return created;
    };
    await client(certPath).health(AbortSignal.timeout(10_000));
    await assert.rejects(client(other.certPath).health(AbortSignal.timeout(10_000)), untrusted);
    assert.deepEqual(
      seen.filter(([kind]) => kind === "request"),
      [health],
      "an untrusting client never reaches the gateway over the trusting client's connection",
    );
  });
});

// Exercise the real grpc-js connector with signed client certificates. This proves
// transport identity and isolation, not the supplier's application authorization.
function signedClientCertificate(directory, name, ca) {
  const keyPath = join(directory, `${name}.key`);
  const certPath = join(directory, `${name}.crt`);
  const csrPath = join(directory, `${name}.csr`);
  for (const args of [
    [
      "req",
      "-new",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      csrPath,
      "-subj",
      "/CN=openshell-client/OU=openshell-user",
    ],
    [
      "x509",
      "-req",
      "-in",
      csrPath,
      "-CA",
      ca.certPath,
      "-CAkey",
      ca.keyPath,
      "-set_serial",
      "2",
      "-days",
      "1",
      "-out",
      certPath,
    ],
  ]) {
    const generated = spawnSync("openssl", args, { encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr || generated.error?.message);
  }
  return { mode: "mtls", certificatePath: certPath, privateKeyPath: keyPath };
}

async function mutualTls(t) {
  const directory = await mkdtemp(join(tmpdir(), "openshell-mtls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const identity = selfSignedCertificate(directory, "server", "DNS:localhost,IP:127.0.0.1");
  const authority = selfSignedCertificate(directory, "client-ca", "DNS:client-ca.invalid");
  const auth = signedClientCertificate(directory, "client", authority);
  const tls = {
    key: readFileSync(identity.keyPath),
    cert: readFileSync(identity.certPath),
    ca: readFileSync(authority.certPath),
  };
  return { tls, auth, rootCertificatePath: identity.certPath, directory };
}

test("OpenShell mTLS authenticates DNS and IP channels and refuses missing or foreign identities", async (t) => {
  const { tls, auth, rootCertificatePath, directory } = await mutualTls(t);
  const foreignCA = selfSignedCertificate(directory, "foreign-ca", "DNS:foreign.invalid");
  const foreign = signedClientCertificate(directory, "foreign", foreignCA);
  const seen = [];
  const server = createSecureServer({
    ...tls,
    requestCert: true,
    rejectUnauthorized: true,
  });
  server.on("stream", (stream, headers) => {
    const socket = stream.session.socket;
    seen.push({
      authorized: socket.authorized,
      subject: socket.getPeerCertificate().subject,
      sni: socket.servername,
      authorization: headers.authorization,
    });
    stream.respond(
      { ":status": 200, "content-type": "application/grpc" },
      { waitForTrailers: true },
    );
    stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
    stream.end(Buffer.from([0, 0, 0, 0, 2, 0x08, 0x01]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (const host of ["localhost", "127.0.0.1"]) {
    await t.test(host, async (t) => {
      const makeClient = (clientAuth, trustedServer = rootCertificatePath) => {
        const client = new GrpcOpenShellGatewayClient({
          endpoint: `https://${host}:${server.address().port}`,
          rootCertificatePath: trustedServer,
          auth: clientAuth,
          requestTimeoutMs: 1_000,
        });
        t.after(() => client.close());
        return client;
      };
      await makeClient(auth).health(AbortSignal.timeout(5_000));
      assert.equal(seen.at(-1).authorized, true);
      assert.equal(seen.at(-1).subject.CN, "openshell-client");
      assert.equal(seen.at(-1).subject.OU, "openshell-user");
      assert.equal(seen.at(-1).sni, host === "localhost" ? "localhost" : false);
      assert.equal(seen.at(-1).authorization, undefined);
      const count = seen.length;
      // None may reuse the authenticated channel of the successful client.
      for (const rejected of [
        makeClient(undefined),
        makeClient(foreign),
        makeClient(auth, foreignCA.certPath),
      ]) {
        await assert.rejects(
          rejected.health(AbortSignal.timeout(5_000)),
          DependencyUnavailableError,
        );
      }
      assert.equal(seen.length, count, "unverified peers never reach an RPC");
      await assert.rejects(
        makeClient({ ...auth, privateKeyPath: join(directory, "missing.key") }).health(
          AbortSignal.timeout(5_000),
        ),
        { code: "ENOENT" },
      );
    });
  }
  assert.throws(
    () => new GrpcOpenShellGatewayClient({ endpoint: "http://127.0.0.1:1", auth }),
    /mTLS requires an HTTPS/,
  );
  assert.throws(
    () =>
      new GrpcOpenShellGatewayClient({
        endpoint: "https://127.0.0.1:1",
        auth: { ...auth, certificatePath: "relative.crt" },
      }),
    /paths must be absolute/,
  );
});

test("OpenShell service transport never sends the administrator mTLS identity", async (t) => {
  const { tls, auth, rootCertificatePath } = await mutualTls(t);
  const listen = async (options, handler) => {
    const server = createHttpsServer({ ...tls, ...options }, handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return server;
  };
  const serviceDocument = (server) => {
    const client = new GrpcOpenShellGatewayClient({
      endpoint: `https://127.0.0.1:${server.address().port}`,
      rootCertificatePath,
      auth,
    });
    t.after(() => client.close());
    return client.getServiceDocument(
      "https://harness.example.invalid",
      "/status",
      "scoped-service-token",
      AbortSignal.timeout(5_000),
    );
  };

  // First prove that this listener requests and accepts the administrator certificate.
  const peers = [];
  const strict = await listen(
    { requestCert: true, rejectUnauthorized: true },
    (request, response) => {
      peers.push(request.socket.getPeerCertificate().subject.CN);
      response.writeHead(204).end();
    },
  );
  const status = await new Promise((resolve, reject) => {
    const request = httpsGet(
      {
        host: "127.0.0.1",
        port: strict.address().port,
        ca: tls.cert,
        cert: readFileSync(auth.certificatePath),
        key: readFileSync(auth.privateKeyPath),
        agent: false,
        signal: AbortSignal.timeout(5_000),
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.once("error", reject);
  });
  assert.equal(status, 204);
  assert.deepEqual(peers, ["openshell-client"]);

  // On the service path the same listener must see a missing certificate, not just
  // an arbitrary connection failure. Sending the administrator identity would succeed.
  const rejected = once(strict, "tlsClientError", { signal: AbortSignal.timeout(5_000) });
  const [[error]] = await Promise.all([
    rejected,
    assert.rejects(serviceDocument(strict), DependencyUnavailableError),
  ]);
  assert.equal(error.code, "ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE");
  assert.equal(peers.length, 1, "the service request never reached an authenticated socket");

  const requests = [];
  const service = await listen({}, (request, response) => {
    requests.push(request.headers.authorization);
    response.writeHead(200, { "content-type": "application/json" }).end('{"ready":true}');
  });
  assert.deepEqual(await serviceDocument(service), { status: 200, json: { ready: true } });
  assert.deepEqual(requests, ["Bearer scoped-service-token"]);
});

test("OpenShell client cancels an in-flight provider request", async () => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
    { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
  );
  const OpenShell = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
  const received = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  const server = new grpc.Server();
  server.addService(OpenShell.service, {
    CreateProvider(call, callback) {
      call.once("cancelled", () => {
        cancelled.resolve();
        callback({ code: grpc.status.CANCELLED, message: "cancelled by client" });
      });
      received.resolve(call.request);
    },
  });
  const port = await bindWireServer(server);
  const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
  const abort = new AbortController();
  const reason = new Error("cancelled in flight");
  const within = async (promise, description) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${description} timed out`)), 2_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const result = client
      .createProvider(
        {
          workspace: "tenant-workspace",
          name: "cancelled-source",
          type: "oce-openai",
          labels: {},
          credentials: { OPENAI_API_KEY: "wire-test-value" },
        },
        abort.signal,
      )
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    const request = await within(received.promise, "provider receipt");
    assert.equal(request.provider.metadata.name, "cancelled-source");
    abort.abort(reason);
    const [outcome] = await within(
      Promise.all([result, cancelled.promise]),
      "provider cancellation",
    );
    assert.equal(outcome.error, reason);
  } finally {
    abort.abort();
    client.close();
    server.forceShutdown();
  }
});

test("OpenShell client closes cancellation races around provider dispatch", async (t) => {
  const provider = {
    workspace: "tenant-workspace",
    name: "cancelled-source",
    type: "oce-openai",
    labels: {},
    credentials: { OPENAI_API_KEY: "wire-test-value" },
  };
  const prepare = (onMetadata, onInvoke) => {
    let calls = 0;
    const grpc = {
      Metadata: class {
        constructor() {
          onMetadata();
        }
      },
      status: { ALREADY_EXISTS: 6 },
    };
    const transport = {
      CreateProvider(_request, _headers, _options, callback) {
        calls++;
        onInvoke();
        queueMicrotask(() =>
          callback(null, {
            provider: { metadata: { name: provider.name, labels: {} }, type: provider.type },
          }),
        );
        return { cancel() {} };
      },
      close() {},
    };
    const client = new GrpcOpenShellGatewayClient({ endpoint: "http://127.0.0.1:1" });
    return { client, grpc, transport, calls: () => calls };
  };

  await t.test("an abort during client initialization prevents metadata preparation", async () => {
    const abort = new AbortController();
    let metadataCalls = 0;
    const fake = prepare(
      () => metadataCalls++,
      () => {},
    );
    let release;
    fake.client.client = new Promise((resolve) => {
      release = resolve;
    });
    const pending = fake.client.createProvider(provider, abort.signal);
    abort.abort(new Error("cancelled during initialization"));
    release({ grpc: fake.grpc, client: fake.transport });
    await assert.rejects(pending, /cancelled during initialization/);
    assert.equal(metadataCalls, 0);
    assert.equal(fake.calls(), 0);
    fake.client.close();
  });

  await t.test("an abort during metadata preparation prevents dispatch", async () => {
    const abort = new AbortController();
    const fake = prepare(
      () => abort.abort(new Error("cancelled during metadata")),
      () => {},
    );
    fake.client.client = Promise.resolve({ grpc: fake.grpc, client: fake.transport });
    await assert.rejects(
      fake.client.createProvider(provider, abort.signal),
      /cancelled during metadata/,
    );
    assert.equal(fake.calls(), 0);
    assert.equal(getEventListeners(abort.signal, "abort").length, 0);
    fake.client.close();
  });

  await t.test("a synchronous transport failure removes its abort listener", async () => {
    const abort = new AbortController();
    const fake = prepare(
      () => {},
      () => {
        throw new Error("transport failed");
      },
    );
    fake.client.client = Promise.resolve({ grpc: fake.grpc, client: fake.transport });
    // A failure without a gRPC status keeps only its class, never the library's text.
    await assert.rejects(
      fake.client.createProvider(provider, abort.signal),
      (error) => error.message === "OpenShell CreateProvider failed: Error",
    );
    assert.equal(getEventListeners(abort.signal, "abort").length, 0);
    fake.client.close();
  });
});

test("OpenShell client reads v0.1.5 sandbox logs with nanosecond times", async () => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
    { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
  );
  const OpenShell = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
  const requests = [];
  const metadata = [];
  const server = new grpc.Server();
  server.addService(OpenShell.service, {
    GetSandboxLogs(call, callback) {
      requests.push(call.request);
      metadata.push(call.metadata.get("authorization"));
      callback(null, {
        logs: [
          {
            sandbox_id: "sandbox-object-id",
            event_time: { seconds: "1790000000", nanos: 123_456_789 },
            level: "OCSF",
            target: "ocsf",
            message: "NET:OPEN [INFO] ALLOWED curl(7) -> api.example.com:443",
            source: "sandbox",
            fields: { dst_host: "api.example.com" },
          },
          { sandbox_id: "sandbox-object-id", level: "INFO", message: "no time" },
        ],
        buffer_total: 7,
      });
    },
  });
  const port = await bindWireServer(server);
  const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
  try {
    const response = await client.getSandboxLogs(
      {
        workspace: "tenant-workspace",
        sandbox: "sb-0123",
        lines: 200,
        sinceTime: "2026-09-21T14:13:20.5Z",
      },
      AbortSignal.timeout(2_000),
    );
    assert.deepEqual(requests[0], {
      sandbox: "sb-0123",
      lines: 200,
      since_time: {
        seconds: String(Date.parse("2026-09-21T14:13:20Z") / 1000),
        nanos: 500_000_000,
      },
      workspace_scope: { workspace: "tenant-workspace", selection: "workspace" },
    });
    assert.deepEqual(metadata[0], []);
    assert.equal(response.bufferTotal, 7);
    assert.deepEqual(response.lines[0], {
      sandboxId: "sandbox-object-id",
      time: "2026-09-21T14:13:20.123456789Z",
      level: "OCSF",
      target: "ocsf",
      message: "NET:OPEN [INFO] ALLOWED curl(7) -> api.example.com:443",
      source: "sandbox",
      fields: { dst_host: "api.example.com" },
    });
    assert.equal(response.lines[1].time, null);
    assert.equal(response.lines[1].source, "");

    await assert.rejects(
      client.getSandboxLogs(
        { workspace: "tenant-workspace", sandbox: "sb-0123", lines: 0 },
        AbortSignal.timeout(2_000),
      ),
      /line count must be 1 to 2000/,
    );
    await assert.rejects(
      client.getSandboxLogs(
        { workspace: "tenant-workspace", sandbox: "sb-0123", lines: 5, sinceTime: "yesterday" },
        AbortSignal.timeout(2_000),
      ),
      /RFC 3339/,
    );
    await assert.rejects(
      client.getSandboxLogs(
        {
          workspace: "tenant-workspace",
          sandbox: "sb-0123",
          lines: 5,
          sinceTime: "2026-02-30T11:59:00Z",
        },
        AbortSignal.timeout(2_000),
      ),
      /RFC 3339/,
    );
    assert.equal(requests.length, 1);
  } finally {
    client.close();
    await new Promise((resolve) => server.tryShutdown(resolve));
  }
});

function pinnedService(fixture = "openshell-v0.1.5-wire.proto") {
  const definition = loader.loadSync(join(import.meta.dirname, "../fixtures", fixture), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
  });
  return grpc.loadPackageDefinition(definition).openshell.v1.OpenShell.service;
}

test("installed custody observer follows the supplier's structured push shape through GetSandboxLogs", async (t) => {
  const workspace = "tenant-workspace";
  const sandbox = "selected-enrolled-sandbox";
  const sandboxId = "immutable-sandbox-id";
  const supervisor = {
    metadata: {
      uid: "supervisor-uid",
      namespace: workspace,
      labels: {
        "openshell.ai/sandbox-id": sandboxId,
        "openshell.ai/boundary-role": "supervisor",
      },
    },
    status: { containerStatuses: [{ containerID: "supervisor-container-id", restartCount: 0 }] },
  };
  // Shape produced by the Rust LogPushLayer, with source and sandbox ID set by
  // the gateway. Exercise real protobuf and the production client's mapped fields.
  const id = "0199f07b-a105-7001-8900-0123456789ab";
  const entry = (event, changes, requestId = id) => ({
    sandbox_id: sandboxId,
    source: "sandbox",
    level: "INFO",
    target: "openshell_supervisor_network::l7::rest::credentials",
    message: "Protected response custody transition",
    event_time: { seconds: "1790000000", nanos: 123_000_000 },
    fields: { request_id: requestId, response_custody_event: event },
    ...changes,
  });
  const initial = entry(null, {
    source: "gateway",
    target: "ocsf",
    message: "startup",
    fields: {},
  });
  let reply;
  const server = new grpc.Server();
  server.addService(pinnedService(), {
    GetSandboxLogs(call, callback) {
      assert.deepEqual(call.request, {
        sandbox,
        workspace_scope: { workspace, selection: "workspace" },
        lines: 2000,
      });
      const response = reply();
      if (response === undefined) {
        return; // Deliberately leave this read pending until the observer cancels it.
      }
      const [logs, buffer_total = logs.length] = response;
      callback(null, { logs, buffer_total });
    },
  });
  const port = await bindWireServer(server);
  const gatewayClient = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
  t.after(() => {
    gatewayClient.close();
    server.forceShutdown();
  });
  const start = async (deliveryTimeoutMs = 3000) => {
    reply = () => [[initial]];
    const custody = createCustodyTransitions(
      {
        gatewayClient,
        workspace,
        sandbox,
        sandboxId,
        supervisor,
        readSupervisor: async () => supervisor,
      },
      { deliveryTimeoutMs, pollIntervalMs: 5 },
    );
    return { custody, before: await custody.snapshot() };
  };
  await t.test(
    "partial batch at origin hold then terminal batch through FIN, same operation",
    async () => {
      const { custody, before } = await start();
      const events = ["resolve_accepted", "permit_accepted"];
      let n = 0;
      reply = () => [[initial, ...events.slice(0, n++).map((event) => entry(event))]];
      assert.equal(await custody.expectAfter(before, events), id);
      events.push("response_released");
      assert.equal(await custody.expectAfter(before, events), id);
    },
  );
  const denied = ["resolve_refused", "no_permit", "response_blocked"];
  const lines = denied.map((event) => entry(event));
  await t.test(
    "negative requires affirmative no_permit, not silence or a missing prefix",
    async () => {
      const { custody, before } = await start(250);
      await assert.rejects(
        custody.expectAfter(before, denied),
        /unobservable before delivery deadline/,
      );
      reply = () => [[initial, ...lines.slice(1)]];
      await assert.rejects(custody.expectAfter(before, denied), /missing, or ambiguous/);
      // Use a fresh observer; the damaged sequence above cannot be repaired by polling.
      const fresh = await start();
      reply = () => [[initial, ...lines]];
      assert.equal(await fresh.custody.expectAfter(fresh.before, denied), id);
    },
  );
  await t.test(
    "delivery deadline during an in-flight log read is explicitly unobservable",
    async () => {
      const { custody, before } = await start(150);
      reply = () => undefined;
      await assert.rejects(custody.expectAfter(before, denied), (error) => {
        assert.match(
          error.message,
          /unobservable before delivery deadline.*GetSandboxLogs read timed out/,
        );
        assert.equal(error.cause.name, "TimeoutError");
        return true;
      });
    },
  );
  for (const [name, logs, error, bufferTotal] of [
    [
      "foreign source",
      [initial, entry(denied[0], { source: "gateway" })],
      /not the selected supervisor INFO/,
    ],
    [
      "foreign target",
      [initial, entry(denied[0], { target: "other" })],
      /not the selected supervisor INFO/,
    ],
    ["foreign sandbox", [initial, entry(denied[0], { sandbox_id: "other" })], /foreign Sandbox/],
    [
      "invalid request ID",
      [initial, entry(denied[0], {}, "malformed")],
      /malformed supplier custody/,
    ],
    ["unknown transition", [initial, entry("future_transition")], /malformed supplier custody/],
    [
      "mixed request IDs",
      [initial, lines[0], entry(denied[1], {}, id.replace(/ab$/, "cd"))],
      /missing, or ambiguous/,
    ],
    ["lost baseline", lines, /supplier log prefix changed/],
    ["full ring could conceal loss", Array(2000).fill(initial), /incomplete supplier log ring/],
    ["ambiguous or truncated ring", [initial, ...lines], /incomplete supplier log ring/, 2000],
  ]) {
    await t.test("reject " + name, async () => {
      const { custody, before } = await start();
      reply = () => [logs, bufferTotal];
      await assert.rejects(custody.expectAfter(before, denied), error);
    });
  }
});

test("OpenShell client refuses a sandbox log response over its 4 MiB receive limit", async () => {
  // OpenShell does not bound a log line, and OCC buffers the whole read before it
  // withholds oversized lines. The receive limit is that read's memory bound.
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
    { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
  );
  const OpenShell = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
  const server = new grpc.Server({ "grpc.max_send_message_length": 16 * 1024 * 1024 });
  server.addService(OpenShell.service, {
    GetSandboxLogs(call, callback) {
      // Each line carries a 1 MiB message: three fit in 4 MiB, four do not.
      callback(null, {
        logs: Array.from({ length: call.request.lines }, (_, index) => ({
          sandbox_id: "sandbox-object-id",
          level: "INFO",
          message: `${index}`.padEnd(1024 * 1024, "x"),
        })),
        buffer_total: call.request.lines,
      });
    },
  });
  const port = await bindWireServer(server);
  const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
  const read = (lines) =>
    client.getSandboxLogs(
      { workspace: "tenant-workspace", sandbox: "sb-0123", lines },
      AbortSignal.timeout(10_000),
    );
  try {
    const fitting = await read(3);
    assert.equal(fitting.lines.length, 3);
    assert.equal(fitting.lines[2].message.length, 1024 * 1024);
    await assert.rejects(read(4), (error) => {
      assert.equal(error.code, grpc.status.RESOURCE_EXHAUSTED);
      return true;
    });
  } finally {
    client.close();
    await new Promise((resolve) => server.tryShutdown(resolve));
  }
});

test("OpenShell client serializes v0.1.5 provider updates and detach receipts", async () => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
    { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
  );
  const OpenShell = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
  const requests = { updates: [], detaches: [], statuses: [] };
  const server = new grpc.Server();
  server.addService(OpenShell.service, {
    UpdateProvider(call, callback) {
      requests.updates.push(call.request);
      const config = call.request.provider.config;
      callback(null, {
        provider: {
          metadata: {
            name: call.request.provider.metadata.name,
            labels: { "app.kubernetes.io/managed-by": "openclaw-enterprise" },
            resource_version: "8",
          },
          type: config === undefined ? "oce-openai" : "oce-codex-runtime",
          ...(config === undefined ? {} : { config }),
        },
      });
    },
    DetachSandboxProvider(call, callback) {
      requests.detaches.push(call.request);
      callback(null, {
        detached: true,
        receipt: { receipt_id: "receipt-detach", kind: "PROVIDER_MUTATION_KIND_DETACH" },
      });
    },
    GetSandboxProviderStatus(call, callback) {
      requests.statuses.push(call.request);
      callback(null, {
        status: {
          receipt: { receipt_id: call.request.receipt_id },
          state: "PROVIDER_READINESS_STATE_REVOKED",
          reason: "PROVIDER_READINESS_REASON_UNSPECIFIED",
        },
      });
    },
  });
  const port = await bindWireServer(server);
  const client = new GrpcOpenShellGatewayClient({
    endpoint: `http://127.0.0.1:${port}`,
    auth: { mode: "unauthenticated" },
  });
  try {
    const updated = await client.updateProviderConfig(
      "tenant-workspace",
      "oce-runtime-0000000000000000",
      { node_setup_json: '{"bootstrapToken":"renewed"}' },
      "7",
      AbortSignal.timeout(2_000),
    );
    await client.updateProviderCredentials(
      "tenant-workspace",
      "oce-cs-000000000000000000000000",
      { OPENAI_API_KEY: "wire-rotated-value" },
      AbortSignal.timeout(2_000),
      { OPENAI_API_KEY: "2026-10-01T18:00:00Z" },
    );
    const detached = await client.detachSandboxProvider(
      "tenant-workspace",
      "sandbox-wire",
      "oce-cs-000000000000000000000000",
      AbortSignal.timeout(2_000),
      { expectedResourceVersion: "17", requestId: "expiry-detach-wire" },
    );
    const status = await client.getSandboxProviderStatus(
      "tenant-workspace",
      "sandbox-wire",
      "oce-cs-000000000000000000000000",
      AbortSignal.timeout(2_000),
      detached.receiptId,
    );

    // Config reconciliation fences the exact provider version and merges only
    // the renewed setup field.
    const [configUpdate, credentialUpdate] = requests.updates;
    assert.equal(configUpdate.workspace_scope.workspace, "tenant-workspace");
    assert.equal(configUpdate.provider.metadata.name, "oce-runtime-0000000000000000");
    assert.equal(configUpdate.provider.metadata.resource_version, "7");
    assert.deepEqual(configUpdate.provider.config, {
      node_setup_json: '{"bootstrapToken":"renewed"}',
    });
    assert.match(configUpdate.request_id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(updated, {
      name: "oce-runtime-0000000000000000",
      type: "oce-codex-runtime",
      labels: { "app.kubernetes.io/managed-by": "openclaw-enterprise" },
      config: { node_setup_json: '{"bootstrapToken":"renewed"}' },
      resourceVersion: "8",
    });
    // Credential rotation retains the existing merge-only request.
    assert.equal(credentialUpdate.workspace_scope.workspace, "tenant-workspace");
    assert.equal(credentialUpdate.provider.metadata.name, "oce-cs-000000000000000000000000");
    assert.deepEqual(credentialUpdate.provider.credentials, {
      OPENAI_API_KEY: "wire-rotated-value",
    });
    assert.deepEqual(credentialUpdate.credential_expiration_times, {
      OPENAI_API_KEY: { seconds: "1790877600", nanos: 0 },
    });
    assert.match(credentialUpdate.request_id, /^[0-9a-f-]{36}$/);
    // Detach names the exact Sandbox and provider; status then follows the detach receipt.
    assert.equal(requests.detaches[0].workspace_scope.workspace, "tenant-workspace");
    assert.equal(requests.detaches[0].sandbox, "sandbox-wire");
    assert.equal(requests.detaches[0].provider, "oce-cs-000000000000000000000000");
    assert.equal(requests.detaches[0].expected_resource_version, "17");
    assert.equal(requests.detaches[0].request_id, "expiry-detach-wire");
    assert.deepEqual(detached, { receiptId: "receipt-detach", detached: true });
    assert.equal(requests.statuses[0].receipt_id, "receipt-detach");
    assert.equal(status.state, "PROVIDER_READINESS_STATE_REVOKED");
    // An empty value would leave the old credential in place, so the client refuses it.
    await assert.rejects(
      client.updateProviderCredentials(
        "tenant-workspace",
        "oce-cs-000000000000000000000000",
        { OPENAI_API_KEY: "" },
        AbortSignal.timeout(2_000),
      ),
      /must be nonempty/,
    );
  } finally {
    client.close();
    await new Promise((resolve) => server.tryShutdown(resolve));
  }
});

test("OpenShell gateway rechecks a revoked source through the Sandbox's provider list", async () => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
    { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
  );
  const OpenShell = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
  const sourceId = "cs_recheck";
  const provider = openShellProviderName(sourceId);
  const namespace = { id: "ns_recheck", name: "tenant-workspace" };
  const workspace = openShellWorkspaceName(namespace);
  // The provider names each Sandbox lists; a missing entry is a Sandbox that does not exist.
  const sandboxes = new Map([
    ["os-listed", ["operator-static", provider]],
    ["os-detached", ["operator-static"]],
    // An empty repeated field is not encoded, so the client sees no providers list at all.
    ["os-bare", []],
  ]);
  const calls = [];
  const server = new grpc.Server();
  server.addService(OpenShell.service, {
    GetSandbox(call, callback) {
      calls.push(["GetSandbox", call.request.name]);
      // Sandbox names are scoped to the Namespace's workspace: another workspace has none.
      const providers =
        call.request.workspace_scope?.workspace === workspace
          ? sandboxes.get(call.request.name)
          : undefined;
      if (providers === undefined) {
        callback(Object.assign(new Error("not found"), { code: grpc.status.NOT_FOUND }));
        return;
      }
      callback(null, {
        sandbox: { metadata: { name: call.request.name }, spec: { providers } },
      });
    },
    DetachSandboxProvider(call, callback) {
      calls.push(["DetachSandboxProvider", call.request.sandbox, call.request.provider]);
      const providers = sandboxes.get(call.request.sandbox);
      sandboxes.set(
        call.request.sandbox,
        providers.filter((name) => name !== call.request.provider),
      );
      callback(null, { detached: true, receipt: { receipt_id: "receipt-recheck" } });
    },
    GetSandboxProviderStatus(call, callback) {
      calls.push(["GetSandboxProviderStatus", call.request.sandbox, call.request.receipt_id]);
      callback(null, {
        status: {
          receipt: { receipt_id: call.request.receipt_id },
          state: "PROVIDER_READINESS_STATE_PENDING",
          reason: "PROVIDER_READINESS_REASON_WAITING_FOR_SUPERVISOR",
        },
      });
    },
    // A missing Sandbox is absent only once the Workspace read passes (finding 1676).
    GetWorkspace(call, callback) {
      calls.push(["GetWorkspace", call.request.name]);
      callback(null, {
        workspace: {
          metadata: { name: call.request.name },
          status: { phase: "WORKSPACE_PHASE_ACTIVE" },
        },
      });
    },
  });
  const port = await bindWireServer(server);
  const client = new GrpcOpenShellGatewayClient({
    endpoint: `http://127.0.0.1:${port}`,
    auth: { mode: "unauthenticated" },
  });
  const gateway = new OpenShellCredentialGatewayDriver(
    { binaries: ["/usr/local/bin/codex"] },
    {
      backend: {
        drivers: { credential_gateway: "credential-gateway-openshell" },
        client: { clientForNamespace: () => client, placement: () => undefined },
      },
    },
  );
  const recheck = (resourceName) =>
    gateway.withdraw({
      namespace,
      revision: { id: "rev_recheck" },
      sandbox: { resourceName },
      sourceId,
      signal: AbortSignal.timeout(2_000),
      recheck: true,
    });
  try {
    // A Sandbox that lists the provider again, as after a late create, is detached once more;
    // the fresh receipt is not yet confirmed.
    assert.deepEqual(await recheck("os-listed"), {
      sourceId,
      state: "pending",
      reason: "PROVIDER_READINESS_REASON_WAITING_FOR_SUPERVISOR",
    });
    assert.deepEqual(sandboxes.get("os-listed"), ["operator-static"]);
    // Once the Sandbox no longer lists it, or no longer exists, a recheck mutates nothing; a
    // missing Sandbox is absent only after GetWorkspace and a second GetSandbox (finding 1692).
    assert.deepEqual(await recheck("os-listed"), { sourceId, state: "revoked" });
    assert.deepEqual(await recheck("os-detached"), { sourceId, state: "revoked" });
    assert.deepEqual(await recheck("os-bare"), { sourceId, state: "revoked" });
    assert.deepEqual(await recheck("os-missing"), { sourceId, state: "absent" });
    assert.deepEqual(calls, [
      ["GetSandbox", "os-listed"],
      ["DetachSandboxProvider", "os-listed", provider],
      ["GetSandboxProviderStatus", "os-listed", "receipt-recheck"],
      ["GetSandbox", "os-listed"],
      ["GetSandbox", "os-detached"],
      ["GetSandbox", "os-bare"],
      ["GetSandbox", "os-missing"],
      ["GetWorkspace", workspace],
      ["GetSandbox", "os-missing"],
    ]);
  } finally {
    client.close();
    await new Promise((resolve) => server.tryShutdown(resolve));
  }
});

test("OpenShell client serializes v0.1.5 gateway-owned refresh", async () => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
    { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
  );
  const OpenShell = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
  const requests = { profiles: [], configures: [], rotations: [], statuses: [], deletes: [] };
  const minted = {
    provider: "oce-cs-000000000000000000000000",
    credential_key: "TOOLS_TOKEN",
    strategy: "PROVIDER_CREDENTIAL_REFRESH_STRATEGY_OAUTH2_CLIENT_CREDENTIALS",
    status: "refreshed",
    expiration_time: { seconds: "1790881200", nanos: 0 },
    next_refresh_time: { seconds: "1790880900", nanos: 0 },
    last_refresh_time: { seconds: "1790877600", nanos: 5 },
  };
  const server = new grpc.Server();
  // The upstream oracle decodes every request, so a renumbered refresh field fails here rather
  // than configuring a provider whose token endpoint or material OpenShell never sees.
  server.addService(OpenShell.service, {
    ImportProviderProfiles(call, callback) {
      requests.profiles.push(call.request);
      callback(null, {
        imported: true,
        profiles: call.request.profiles.map((item) => item.profile),
      });
    },
    ConfigureProviderRefresh(call, callback) {
      requests.configures.push(call.request);
      callback(null, { status: { ...minted, status: "configured" } });
    },
    RotateProviderCredential(call, callback) {
      requests.rotations.push(call.request);
      callback(null, { status: minted });
    },
    GetProviderRefreshStatus(call, callback) {
      requests.statuses.push(call.request);
      if (call.request.provider !== minted.provider) {
        callback({ code: grpc.status.NOT_FOUND, details: "provider not found" });
        return;
      }
      callback(null, {
        credentials: [
          { ...minted, credential_key: "OTHER_TOKEN", status: "error" },
          {
            ...minted,
            status: "reauthorization_required",
            recovery_action: "PROVIDER_CREDENTIAL_REFRESH_RECOVERY_ACTION_REAUTHORIZE",
            failure_code: "oauth_invalid_grant",
          },
        ],
      });
    },
    DeleteProviderRefresh(call, callback) {
      requests.deletes.push(call.request);
      callback(null, { outcome: "DELETION_OUTCOME_ALREADY_ABSENT" });
    },
  });
  const port = await bindWireServer(server);
  const client = new GrpcOpenShellGatewayClient({
    endpoint: `http://127.0.0.1:${port}`,
    auth: { mode: "unauthenticated" },
  });
  const signal = () => AbortSignal.timeout(2_000);
  try {
    await client.importProviderProfile(
      "tenant-workspace",
      {
        id: minted.provider,
        displayName: "OAuth2 (wire)",
        category: "PROVIDER_PROFILE_CATEGORY_OTHER",
        credentials: [
          {
            name: "access_token",
            envVars: ["TOOLS_TOKEN"],
            required: true,
            authStyle: "bearer",
            headerName: "authorization",
            refresh: {
              strategy: minted.strategy,
              tokenUrl: "https://issuer.example.test/token",
              scopes: [],
              material: [
                { name: "client_id", required: true, secret: false },
                { name: "client_secret", required: true, secret: true },
              ],
            },
          },
        ],
        endpoints: [{ host: "tools.example.test", port: 443, protocol: "rest", path: "/**" }],
        binaries: ["/usr/bin/curl"],
        inferenceCapable: false,
        annotations: {},
      },
      signal(),
    );
    const configured = await client.configureProviderRefresh(
      {
        workspace: "tenant-workspace",
        provider: minted.provider,
        credentialKey: "TOOLS_TOKEN",
        strategy: minted.strategy,
        material: { client_id: "occ-tools", client_secret: "wire-client-secret" },
        requestId: "6b1f9b8e-2c4f-5a7d-9e3b-0c1d2e3f4a5b",
      },
      signal(),
    );
    const rotated = await client.rotateProviderCredential(
      "tenant-workspace",
      minted.provider,
      "TOOLS_TOKEN",
      "7c2a0c9f-3d5a-5b8e-af4c-1d2e3f4a5b6c",
      signal(),
    );
    const status = await client.getProviderRefreshStatus(
      "tenant-workspace",
      minted.provider,
      "TOOLS_TOKEN",
      signal(),
    );
    const missing = await client.getProviderRefreshStatus(
      "tenant-workspace",
      "oce-cs-missing",
      "TOOLS_TOKEN",
      signal(),
    );
    await client.deleteProviderRefresh(
      "tenant-workspace",
      minted.provider,
      "TOOLS_TOKEN",
      signal(),
    );

    // The token endpoint and material declarations travel only in the profile.
    const [credential] = requests.profiles[0].profiles[0].profile.credentials;
    assert.deepEqual(credential.refresh, {
      strategy: minted.strategy,
      token_url: "https://issuer.example.test/token",
      material: [
        { name: "client_id", required: true, secret: false },
        { name: "client_secret", required: true, secret: true },
      ],
    });
    const [configure] = requests.configures;
    assert.equal(configure.workspace_scope.workspace, "tenant-workspace");
    assert.equal(configure.provider, minted.provider);
    assert.equal(configure.credential_key, "TOOLS_TOKEN");
    assert.equal(configure.strategy, minted.strategy);
    assert.deepEqual(configure.material, {
      client_id: "occ-tools",
      client_secret: "wire-client-secret",
    });
    assert.equal(configure.request_id, "6b1f9b8e-2c4f-5a7d-9e3b-0c1d2e3f4a5b");
    assert.deepEqual(configured, {
      status: "configured",
      expirationTime: "2026-10-01T19:00:00.000000000Z",
      nextRefreshTime: "2026-10-01T18:55:00.000000000Z",
      lastRefreshTime: "2026-10-01T18:00:00.000000005Z",
    });
    assert.equal(requests.rotations[0].credential_key, "TOOLS_TOKEN");
    assert.equal(requests.rotations[0].request_id, "7c2a0c9f-3d5a-5b8e-af4c-1d2e3f4a5b6c");
    assert.equal(rotated.status, "refreshed");
    // Status selects the exact credential key and keeps only the safe recovery fields.
    assert.deepEqual(status, {
      status: "reauthorization_required",
      expirationTime: "2026-10-01T19:00:00.000000000Z",
      nextRefreshTime: "2026-10-01T18:55:00.000000000Z",
      lastRefreshTime: "2026-10-01T18:00:00.000000005Z",
      recoveryAction: "PROVIDER_CREDENTIAL_REFRESH_RECOVERY_ACTION_REAUTHORIZE",
      failureCode: "oauth_invalid_grant",
    });
    assert.equal(missing, undefined);
    assert.equal(requests.deletes[0].allow_missing, true);
    assert.equal(requests.deletes[0].credential_key, "TOOLS_TOKEN");
    assert.match(requests.deletes[0].request_id, /^[0-9a-f-]{36}$/);
  } finally {
    client.close();
    await new Promise((resolve) => server.tryShutdown(resolve));
  }
});

test("installed workload clients select the enrolled Sandbox at authenticated ExecSandbox; a lost Exit is not replayed", async (t) => {
  const { tls, auth, rootCertificatePath } = await mutualTls(t);
  // Record the real clients' mTLS RPCs, independently of any kubectl or cluster.
  // Only an installed run can establish that the supplier launched the filtered child.
  const { GetSandbox } = pinnedService();
  const { ExecSandbox } = pinnedService("openshell-workload-exec.proto");
  const binding = { sandboxName: "managed-reader", sandboxId: "enrolled-id" };
  const workspace = "managed-workspace";
  const launches = [];
  const phases = [];
  let selectedId = binding.sandboxId;
  let loseExit = false;
  const server = new grpc.Server();
  server.addService(
    { GetSandbox, ExecSandbox },
    {
      GetSandbox({ request }, callback) {
        callback(null, {
          sandbox: {
            metadata: {
              id: selectedId,
              name: request.name,
              workspace: request.workspace_scope.workspace,
            },
          },
        });
      },
      ExecSandbox(call) {
        const { request } = call;
        const dispatch = phases.find((entry) => entry.requestId === request.request_id);
        launches.push({ request, dispatch });
        call.write({ stdout: { data: Buffer.from("recipient") } });
        call.write({ stderr: { data: Buffer.from("diagnostic") } });
        call.write({ stdout: { data: Buffer.from("-bytes") } });
        if (!loseExit) {
          call.write({ exit: {} });
        }
        call.end();
      },
    },
  );
  const credentials = grpc.ServerCredentials.createSsl(
    tls.ca,
    [{ cert_chain: tls.cert, private_key: tls.key }],
    true,
  );
  const port = await bindWireServer(server, credentials);
  t.after(() => server.forceShutdown());
  const backend = {
    endpoint: `https://127.0.0.1:${port}`,
    rootCertificatePath,
    auth,
  };
  const gatewayClient = new GrpcOpenShellGatewayClient(backend);
  t.after(() => gatewayClient.close());
  const execWorkload = createManagedWorkloadExec(t, {
    backend,
    workspace,
    gatewayClient,
    checkpoint: (phase, details) => phases.push({ phase, ...details }),
  });
  const inAgent = async (...command) => {
    const { stdout, stderr, exitCode } = await execWorkload(binding, command);
    assert.equal(exitCode, 0);
    assert.equal(stderr.toString(), "diagnostic");
    return stdout.toString();
  };
  const target = "https://provider.test/repos/fixture/repository";
  const { curl, throughFin } = agentClients({ inAgent }, new URL(target).origin);
  assert.deepEqual(await Promise.all([curl(), throughFin()]), [
    "recipient-bytes",
    "recipient-bytes",
  ]);

  assert.deepEqual(launches.map(({ request }) => request.command[0]).sort(), ["curl", "node"]);
  for (const { request, dispatch } of launches) {
    assert.equal(request.sandbox, binding.sandboxName);
    assert.equal(request.workspace_scope.workspace, workspace);
    assert.equal(request.command.at(-1), target, "ordinary argv, not a shell command string");
    assert.equal(request.no_login_shell, true);
    assert.equal(request.execution_timeout.seconds, "120");
    assert.equal(
      dispatch.phase,
      "managed-workload-exec-dispatch-unknown",
      "persisted before launch",
    );
    assert.equal(dispatch.sandboxId, binding.sandboxId);
  }
  assert.notEqual(launches[0].dispatch.requestId, launches[1].dispatch.requestId);

  loseExit = true;
  await assert.rejects(curl(), /Unconfirmed managed workload exec/);
  assert.equal(
    launches.length,
    3,
    "even clean gRPC completion cannot cause a missing Exit to be retried",
  );
  assert.equal(phases.at(-1).phase, "managed-workload-exec-unconfirmed");
  assert.equal(phases.at(-1).requestId, launches[2].dispatch.requestId);

  selectedId = "replaced-id";
  await assert.rejects(curl(), /supplier Sandbox replaced/);
  assert.equal(launches.length, 3, "an old enrolled recipient never silently switches Sandbox");
});
