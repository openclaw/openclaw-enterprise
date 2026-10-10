import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { getEventListeners } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createSecureServer } from "node:http2";
import test from "node:test";
import {
  GrpcOpenShellGatewayClient,
  OpenShellAdmissionLimitError,
  OpenShellRequestReplayRefusedError,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import {
  openShellProviderName,
  openShellWorkspaceName,
} from "../../apps/controller/src/backends/openshell.ts";
import { TransientDependencyError } from "../../packages/occ/src/index.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/errors.ts";

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

function bindWireServer(server) {
  return new Promise((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );
}

test("OpenShell HTTP origins keep port 80 in native gRPC connections", async (t) => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.3-pre.2-wire.proto"),
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

test("OpenShell client serializes v0.1.3-pre.2 create-time service exposure", async () => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.3-pre.2-wire.proto"),
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
        assert.equal(
          error.message,
          "OpenShell CreateSandbox failed with gRPC status 3: sandbox spec rejected by the Kubernetes driver",
        );
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
    join(import.meta.dirname, "../fixtures/openshell-v0.1.3-pre.2-wire.proto"),
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
  };
  const server = new grpc.Server();
  server.addService(OpenShell.service, {
    DeleteSandbox(call, callback) {
      deletes.push(call.request.name);
      const scenario = scenarios[call.request.name];
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
    join(import.meta.dirname, "../fixtures/openshell-v0.1.3-pre.2-wire.proto"),
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
  });
  const port = await bindWireServer(server);
  const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
  const signal = AbortSignal.timeout(2_000);
  try {
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

test("OpenShell client reports a refused CreateSandbox request_id from its ErrorInfo reason", async () => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.3-pre.2-wire.proto"),
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
    join(import.meta.dirname, "../fixtures/openshell-v0.1.3-pre.2-wire.proto"),
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

test("OpenShell client serializes v0.1.3-pre.2 credential providers, profiles, and attachment status", async () => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.3-pre.2-wire.proto"),
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

    // Raw header placement uses the same pinned wire fields as Bearer placement.
    await client.importProviderProfile(
      "tenant-workspace",
      {
        id: "oce-openai-header",
        displayName: "OpenAI-compatible raw header",
        category: "PROVIDER_PROFILE_CATEGORY_INFERENCE",
        credentials: [
          {
            name: "api_key",
            envVars: ["OPENAI_API_KEY"],
            required: true,
            authStyle: "header",
            headerName: "x-api-key",
          },
        ],
        endpoints: [{ host: "models.example.test", port: 443, protocol: "rest", path: "/v1/**" }],
        binaries: ["/app/bin/codex"],
        inferenceCapable: true,
        annotations: {},
      },
      AbortSignal.timeout(2_000),
    );
    assert.deepEqual(requests.profiles[1].profiles[0].profile.credentials, [
      {
        name: "api_key",
        env_vars: ["OPENAI_API_KEY"],
        required: true,
        auth_style: "header",
        header_name: "x-api-key",
      },
    ]);

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
    { name: "wrong-ip", san: "IP:127.0.0.2", bind: "127.0.0.1", host: "127.0.0.1" },
    // A name certificate does not vouch for an IP endpoint, even one that resolves there.
    { name: "name-for-ip", san: "DNS:localhost", bind: "127.0.0.1", host: "127.0.0.1" },
  ];
  for (const { name, san, bind, host, sni, needsIpv6 } of cases) {
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
          rootCertificatePath: certPath,
          requestTimeoutMs: 5_000,
        });
        t.after(() => client.close());
        const signal = AbortSignal.timeout(10_000);
        if (sni !== undefined) {
          await client.health(signal);
          assert.deepEqual(seen, [["sni", sni], health]);
          return;
        }
        await assert.rejects(client.health(signal), (error) => {
          assert.ok(error instanceof DependencyUnavailableError, String(error));
          assert.equal(error.grpcStatus, grpc.status.UNAVAILABLE);
          return true;
        });
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
    await assert.rejects(client(other.certPath).health(AbortSignal.timeout(10_000)), (error) => {
      assert.ok(error instanceof DependencyUnavailableError, String(error));
      assert.equal(error.grpcStatus, grpc.status.UNAVAILABLE);
      return true;
    });
    assert.deepEqual(
      seen.filter(([kind]) => kind === "request"),
      [health],
      "an untrusting client never reaches the gateway over the trusting client's connection",
    );
  });
});

test("OpenShell client cancels an in-flight provider request", async () => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.3-pre.2-wire.proto"),
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

test("OpenShell client reads v0.1.3-pre.2 sandbox logs with nanosecond times", async () => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.3-pre.2-wire.proto"),
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
    assert.equal(requests.length, 1);
  } finally {
    client.close();
    await new Promise((resolve) => server.tryShutdown(resolve));
  }
});

test("OpenShell client serializes v0.1.3-pre.2 provider updates and detach receipts", async () => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.3-pre.2-wire.proto"),
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
    assert.deepEqual(detached, { receiptId: "receipt-detach" });
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
    join(import.meta.dirname, "../fixtures/openshell-v0.1.3-pre.2-wire.proto"),
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
        client: { clientForNamespace: () => client },
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
    // Once the Sandbox no longer lists it, or no longer exists, a recheck mutates nothing.
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
    ]);
  } finally {
    client.close();
    await new Promise((resolve) => server.tryShutdown(resolve));
  }
});

test("OpenShell client serializes v0.1.3-pre.2 gateway-owned refresh", async () => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.3-pre.2-wire.proto"),
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
