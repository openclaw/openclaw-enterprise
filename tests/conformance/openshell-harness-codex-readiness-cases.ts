import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { createServer as createTcpServer, Socket } from "node:net";
import test from "node:test";
import type { TLSSocket } from "node:tls";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellServiceTransportError } from "../../apps/controller/src/drivers/sandbox/openshell-service-transport.ts";
import type {
  AgentRevision,
  SandboxHarnessStatusContext,
} from "../../packages/contracts/src/index.ts";
import {
  ActivationFailedError,
  type CodexPermissionDenial,
} from "../../packages/occ/src/errors.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { completeSandboxRevision } from "../integration/sandbox-driver-revision-fixture.ts";
import { selfSigned } from "../helpers/certificates.mjs";
import { providerEndpointFixture } from "../fixtures/kubernetes-provider-endpoint.mjs";
import { temporaryDirectorySync } from "../helpers/temporary-directory.ts";
import {
  close,
  listen,
  loadWebSocketPeer,
  upgradedSocket,
  writeUpgrade,
} from "./openshell-harness-service-transport-cases.ts";

// Negative fixtures intentionally send missing or invalid policy/auth fields.
type RequirementsReply = {
  allowedSandboxModes?: (string | boolean)[];
  allowedPermissionProfiles?: Record<string, boolean | string>;
  allowedApprovalsReviewers?: string[];
  additionalDeveloperInstructions?: string;
  modelProviders?: Record<string, { name: string }>;
};

type AuthReply = {
  authMethod: string | null;
  authToken?: string | null;
  requiresOpenaiAuth?: boolean;
  extra?: string;
};

const initialized = {
  userAgent: "codex/0.164.0",
  codexHome: "/synthetic",
  platformFamily: "unix",
  platformOs: "linux",
};

type RpcResult =
  typeof initialized | { requirements: RequirementsReply | null | undefined } | AuthReply;

type ReadinessRequest =
  | { method: "initialize" | "configRequirements/read"; id: number }
  | { method: "initialized" }
  | {
      method: "getAuthStatus";
      id: number;
      params: { includeToken: boolean; refreshToken: boolean };
    };

function readRequest(data: Buffer | ArrayBuffer | Buffer[]): ReadinessRequest {
  assert.ok(Buffer.isBuffer(data), "expected a JSON-RPC text message");
  const parsed: unknown = JSON.parse(data.toString());
  const request = asRecord(parsed);
  assert.ok(request);
  const { method, id } = request;
  if (method === "initialized") {
    assert.equal(id, undefined);
    return { method };
  }
  assert.ok(typeof id === "number" && Number.isSafeInteger(id));
  if (method === "initialize" || method === "configRequirements/read") {
    return { method, id };
  }
  assert.ok(method === "getAuthStatus", "unexpected readiness RPC method");
  const params = asRecord(request.params);
  assert.ok(
    typeof params?.includeToken === "boolean" && typeof params.refreshToken === "boolean",
    "expected auth status request flags",
  );
  return {
    method,
    id,
    params: { includeToken: params.includeToken, refreshToken: params.refreshToken },
  };
}

export function registerOpenShellCodexReadinessCases(token: string, serviceUrl: string): void {
  test("OpenShell PAT readiness requires the serving process's authentication through its exact service", async (t) => {
    const { WebSocket, WebSocketServer } = loadWebSocketPeer();
    const directory = temporaryDirectorySync(t, "openshell-pat-status-");
    const certificate = await selfSigned(directory);
    const peers = new WebSocketServer({ noServer: true });
    const requests: ReadinessRequest[] = [];
    let answer: AuthReply = { authMethod: null, authToken: null, requiresOpenaiAuth: true };
    let hold = false;
    let requirements: RequirementsReply | null | undefined = null;
    let advertisedPort = 9443;
    let transportToken = token;
    let targetPort = 8080;
    const negotiated: TLSSocket["alpnProtocol"][] = [];
    const pending = new EventEmitter<{ "auth-held": [peer: InstanceType<typeof WebSocket>] }>();
    let plainRequests = 0;
    const gateway = createSecureServer(
      { key: certificate.key, cert: certificate.cert, ALPNProtocols: ["h2", "http/1.1"] },
      (_request, response) => {
        plainRequests += 1;
        response.writeHead(404).end();
      },
    );
    gateway.on("secureConnection", (socket) => negotiated.push(socket.alpnProtocol));
    gateway.on("upgrade", (request, socket, head) => {
      assert.equal(request.headers.host, `codex.example.test:${advertisedPort}`);
      assert.equal(request.headers.authorization, `Bearer ${transportToken}`);
      assert.ok(socket instanceof Socket);
      peers.handleUpgrade(request, socket, head, (peer) => {
        peers.emit("connection", peer, request);
        peer.on("message", (data) => {
          const message = readRequest(data);
          requests.push(message);
          if (message.method === "initialize") {
            peer.send(
              JSON.stringify({
                id: message.id,
                result: initialized,
              }),
            );
          } else if (message.method === "configRequirements/read") {
            peer.send(JSON.stringify({ id: message.id, result: { requirements } }));
          } else if (message.method === "getAuthStatus") {
            if (hold) {
              pending.emit("auth-held", peer);
            } else {
              peer.send(JSON.stringify({ id: message.id, result: answer }));
            }
          }
        });
      });
    });
    const port = await listen(gateway);
    t.after(async () => {
      for (const peer of peers.clients) {
        peer.terminate();
      }
      await new Promise<void>((resolve) => peers.close(() => resolve()));
      await close(gateway);
    });
    const client = new GrpcOpenShellGatewayClient({
      endpoint: `https://127.0.0.1:${port}`,
      rootCertificatePath: certificate.certPath,
      requestTimeoutMs: 1_000,
    });
    t.after(() => client.close());
    const untrusted = new GrpcOpenShellGatewayClient({
      endpoint: `https://127.0.0.1:${port}`,
      requestTimeoutMs: 1_000,
    });
    t.after(() => untrusted.close());
    assert.equal(
      await untrusted.serviceCodexReadinessStatus(
        "https://codex.example.test:9443/",
        token,
        true,
        AbortSignal.timeout(5_000),
      ),
      "unavailable",
    );
    assert.equal(requests.length, 0, "an untrusted peer must receive no RPC");
    // Only service discovery is controlled. The actual Driver, TLS routing, bearer,
    // WebSocket codec and native JSON-RPC exchange determine readiness.
    client.getService = async (_workspace, sandbox, name) => ({
      sandbox,
      name,
      targetPort,
      authorizationMode: "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH",
      url: `https://codex.example.test:${advertisedPort}/`,
      advertisedUrl: `https://codex.example.test:${advertisedPort}/`,
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
          process: { runAsUser: "1000", runAsGroup: "1000" },
          networkPolicies: [
            {
              name: "model-egress",
              endpoints: [{ host: "chatgpt.com", ports: [443] }],
              binaries: [{ path: "/app/bin/model-client" }],
            },
          ],
        },
      },
      {
        id: "sandbox-provider",
        implementation: "openshell",
        backend: {
          id: "openshell",
          drivers: { sandbox: "sandbox-provider" },
          client: new OpenShellGateway(
            { serviceName: "openshell-gateway" },
            { gatewayClient: client },
          ),
        },
      },
    );
    const namespace = {
      id: "ns_00000000-0000-4000-8000-000000000001",
      name: "tenant-auth",
      status: "ready",
      createdAt: "2026-09-23T00:00:00.000Z",
    } satisfies SandboxHarnessStatusContext["namespace"];
    const harnessAuth = {
      method: "credential_source",
      loginMode: "codex_pat",
      sourceId: "cs_00000000-0000-4000-8000-000000000001",
      credentialGatewayId: "openshell-credentials",
      sourceType: "codex-pat",
    } satisfies AgentRevision["harnessAuth"];
    const context: SandboxHarnessStatusContext = {
      namespace,
      revision: completeSandboxRevision(
        {
          id: "rev_00000000-0000-4000-8000-000000000003",
          agentId: "agt_00000000-0000-4000-8000-000000000003",
          namespaceId: namespace.id,
          sandboxDriverId: driver.id,
          harness: { id: "codex", mode: "dedicated", version: "0.164.0" },
        },
        harnessAuth,
      ),
      requirements: {
        loginMode: harnessAuth.loginMode,
        image: "fixture-codex:0.164.0",
        command: ["codex", "app-server"],
        workspaceMounts: [],
        environment: [{ name: "APP_SERVER_PORT", value: "8080" }],
        files: [],
        credentialAttachments: [],
        labels: {},
      },
      kubernetes: undefined,
      transportToken: token,
      signal: AbortSignal.timeout(15_000),
    };
    // The released process can initialize while PAT hydration has failed. Neither
    // null auth nor a different/malformed credential status may activate that revision.
    for (const status of [
      answer,
      { ...answer, authMethod: "apiKey" },
      { ...answer, extra: "x".repeat(20_000) },
      { authMethod: "personalAccessToken" },
      { ...answer, authMethod: "personalAccessToken", authToken: "unexpected" },
    ]) {
      answer = status;
      const observed = await driver.harnessStatus(context);
      assert.equal(negotiated.at(-1), "http/1.1", "service upgrades require HTTP/1.1");
      assert.deepEqual(observed, { state: "starting" });
    }
    answer = { authMethod: "personalAccessToken", authToken: null, requiresOpenaiAuth: true };
    assert.deepEqual(await driver.harnessStatus(context), { state: "serving" });
    // Native requirements include complete managed instructions. A legitimate
    // policy larger than the small status budget must still reach PAT readiness.
    requirements = {
      allowedSandboxModes: ["read-only", "workspace-write", "danger-full-access"],
      additionalDeveloperInstructions: "Native managed instruction. ".repeat(1_000),
    };
    assert.deepEqual(await driver.harnessStatus(context), { state: "serving" });
    // The policy allowance must not enlarge the authentication/status budget.
    answer = { ...answer, extra: "x".repeat(20_000) };
    assert.deepEqual(await driver.harnessStatus(context), { state: "starting" });
    delete answer.extra;
    // Size takes priority even if a complete policy also denies the required sandbox mode.
    requirements = {
      allowedSandboxModes: ["read-only"],
      modelProviders: { managed: { name: "x".repeat(1024 * 1024) } },
    };
    const beforeOversized = requests.length;
    await assert.rejects(driver.harnessStatus(context), {
      code: "RUNTIME_CODEX_REQUIREMENTS_TOO_LARGE",
    });
    assert.ok(!requests.slice(beforeOversized).some(({ method }) => method === "getAuthStatus"));
    // Size alone is not enough to classify malformed or incomplete policy evidence.
    requirements = { ...requirements, allowedSandboxModes: [true] };
    assert.deepEqual(await driver.harnessStatus(context), { state: "starting" });
    requirements = { modelProviders: { managed: { name: "x".repeat(2 * 1024 * 1024) } } };
    assert.deepEqual(await driver.harnessStatus(context), { state: "starting" });
    const apiKeyContext: SandboxHarnessStatusContext = {
      ...context,
      requirements: { ...context.requirements, loginMode: "api_key" },
      revision: {
        ...context.revision,
        harnessAuth: {
          ...harnessAuth,
          loginMode: "api_key",
          sourceType: "openai",
        },
      },
    };
    // A valid reply can independently deny each requirement or deny several at once.
    const incompatiblePolicies: [
      SandboxHarnessStatusContext,
      RequirementsReply,
      CodexPermissionDenial[],
    ][] = [
      [
        context,
        {
          allowedSandboxModes: ["read-only", "workspace-write"],
          allowedPermissionProfiles: { ":danger-full-access": true },
        },
        ["sandbox-mode-denied"],
      ],
      [context, { allowedPermissionProfiles: { ":workspace": true } }, ["named-profile-denied"]],
      [context, { allowedApprovalsReviewers: ["auto_review"] }, ["reviewer-denied"]],
      [
        apiKeyContext,
        {
          allowedSandboxModes: [],
          allowedPermissionProfiles: { ":danger-full-access": false },
          allowedApprovalsReviewers: ["guardian_subagent"],
          additionalDeveloperInstructions: "SYNTHETIC_POLICY_TEXT_MUST_STAY_PRIVATE",
        },
        ["sandbox-mode-denied", "named-profile-denied", "reviewer-denied"],
      ],
    ];
    for (const [target, policy, denials] of incompatiblePolicies) {
      requirements = policy;
      await assert.rejects(driver.harnessStatus(target), (error) => {
        assert.ok(error instanceof ActivationFailedError);
        assert.equal(error.code, "RUNTIME_CODEX_PERMISSION_POLICY_INCOMPATIBLE");
        assert.deepEqual(error.permissionDenials, denials);
        assert.doesNotMatch(
          `${error.message}\n${JSON.stringify(error)}`,
          /SYNTHETIC_POLICY_TEXT_MUST_STAY_PRIVATE/,
        );
        return true;
      });
    }
    for (const policy of [
      undefined,
      { allowedSandboxModes: [true] },
      { allowedSandboxModes: ["danger-full-access", "unrecognized"] },
      { allowedApprovalsReviewers: ["user", "unrecognized"] },
      { allowedApprovalsReviewers: ["unrecognized"] },
      {
        allowedSandboxModes: [],
        allowedPermissionProfiles: { ":danger-full-access": "false" },
      },
    ]) {
      requirements = policy;
      assert.deepEqual(await driver.harnessStatus(context), { state: "starting" });
    }
    requirements = { allowedSandboxModes: ["danger-full-access"] };
    const beforeNonPat = requests.length;
    assert.deepEqual(await driver.harnessStatus(apiKeyContext), { state: "serving" });
    assert.ok(!requests.slice(beforeNonPat).some(({ method }) => method === "getAuthStatus"));
    requirements = null;
    // A valid backend service port must not inherit Fetch's browser-only port blocklist.
    // The real TLS endpoint remains on its ephemeral port; advertised Host selects the service.
    advertisedPort = 10080;
    assert.deepEqual(await driver.harnessStatus(context), { state: "serving" });
    assert.equal(plainRequests, 0, "an upgraded Harness must not receive a plain status request");
    assert.equal(requests.filter(({ method }) => method === "getAuthStatus").length, 9);
    assert.ok(
      requests
        .filter((request) => request.method === "getAuthStatus")
        .every(({ params }) => params.includeToken === false && params.refreshToken === false),
    );

    // Compose the real Compute readiness caller with the real Sandbox and TLS
    // service transport. Kubernetes/provisioning remain the existing in-memory
    // fixture; the controlled JSON-RPC peer supplies policy data.
    const {
      sandbox,
      prepare,
      activate,
      setGatewayServing,
      setSetupAvailable,
      observePods,
      pod,
      writes,
    } = providerEndpointFixture();
    assert.ok(sandbox);
    sandbox.harnessStatus = driver.harnessStatus.bind(driver);
    await prepare();
    setGatewayServing();
    setSetupAvailable(true);
    observePods([pod("ready")]);
    transportToken = "test-transport";
    targetPort = 18_790;
    requirements = { allowedSandboxModes: ["read-only"] };
    await assert.rejects(prepare(), {
      code: "RUNTIME_CODEX_PERMISSION_POLICY_INCOMPATIBLE",
      permissionDenials: ["sandbox-mode-denied"],
    });
    requirements = null;
    assert.equal((await prepare()).ready, true);
    // A policy change after preparation must block Gateway replacement as well.
    requirements = { allowedSandboxModes: ["read-only"] };
    const beforeActivation = writes.length;
    await assert.rejects(activate(), {
      code: "RUNTIME_CODEX_PERMISSION_POLICY_INCOMPATIBLE",
      permissionDenials: ["sandbox-mode-denied"],
    });
    assert.equal(writes.length, beforeActivation);
    transportToken = token;
    targetPort = 8080;
    requirements = null;

    // A connected but unresponsive process must retain the existing bounded read
    // and caller cancellation semantics, without spending a model request.
    hold = true;
    await assert.rejects(
      driver.harnessStatus(context),
      (error) =>
        error instanceof Error &&
        error.cause instanceof OpenShellServiceTransportError &&
        error.cause.reason === "timeout",
    );
    const cancelled = new AbortController();
    const reason = new Error("cancelled readiness");
    const received: Promise<readonly unknown[]> = once(pending, "auth-held", {
      signal: AbortSignal.timeout(3_000),
    });
    const reading = driver.harnessStatus({ ...context, signal: cancelled.signal });
    const rejected = assert.rejects(reading, (error) => error === reason);
    const [peer] = await Promise.race([
      received,
      rejected.then(() => {
        throw new Error("read settled before the held authentication request");
      }),
    ]);
    assert.ok(peer instanceof WebSocket, "expected the upgraded authentication peer");
    const closed: Promise<readonly unknown[]> = once(peer, "close", { signal: context.signal });
    cancelled.abort(reason);
    await rejected;
    const [code] = await closed;
    assert.equal(code, 1000);
  });

  // A completed read must not retain a detached upgraded socket when the peer never
  // acknowledges Close. Exercise success, deadline and cancellation through real TCP.
  test("OpenShell PAT status closes unresponsive upgraded peers within its cleanup bound", async (t) => {
    const { Receiver, Sender } = loadWebSocketPeer();
    for (const outcome of ["serving", "timeout", "cancelled"]) {
      await t.test(outcome, async (t) => {
        const gateway = createServer();
        const sockets = new Set<Socket>();
        const cancelled = new AbortController();
        const reason = new Error("cancelled after authentication request");
        let closeCode: number | undefined;
        let closeReceivedAt: number | undefined;
        gateway.on("upgrade", (request, socket, head) => {
          assert.ok(socket instanceof Socket);
          sockets.add(socket);
          writeUpgrade(request, socket, "write");
          const receiver = new Receiver({ isServer: true });
          const sender = new Sender(socket);
          const reply = (id: number, result: RpcResult) =>
            sender.send(
              JSON.stringify({ id, result }),
              { binary: false, mask: false, compress: false, fin: true },
              () => {},
            );
          receiver.on("message", (data) => {
            const message = readRequest(data);
            if (message.method === "initialize") {
              reply(message.id, initialized);
            } else if (message.method === "configRequirements/read") {
              reply(message.id, { requirements: null });
            } else if (message.method === "getAuthStatus") {
              if (outcome === "serving") {
                reply(message.id, {
                  authMethod: "personalAccessToken",
                  authToken: null,
                  requiresOpenaiAuth: true,
                });
              } else if (outcome === "cancelled") {
                cancelled.abort(reason);
              }
            }
          });
          receiver.on("conclude", (code) => {
            closeCode = code;
            closeReceivedAt = performance.now();
            // Intentionally neither acknowledge Close nor end TCP.
          });
          if (head.length > 0) {
            receiver.write(head);
          }
          socket.pipe(receiver);
        });
        const port = await listen(gateway);
        t.after(async () => {
          for (const socket of sockets) {
            socket.destroy();
          }
          await close(gateway);
        });
        const client = new GrpcOpenShellGatewayClient({
          endpoint: `http://127.0.0.1:${port}`,
          requestTimeoutMs: 1_000,
        });
        t.after(() => client.close());
        const deadline = AbortSignal.timeout(4_000);
        let endedAt: number | undefined;
        const ended = upgradedSocket(gateway, deadline).then((socket) =>
          once(socket, "end", { signal: deadline }).then(() => {
            endedAt = performance.now();
          }),
        );
        const started = performance.now();
        const reading = client.serviceCodexReadinessStatus(
          serviceUrl,
          token,
          true,
          outcome === "cancelled" ? cancelled.signal : deadline,
        );
        const verified =
          outcome === "serving"
            ? reading.then((status) => {
                assert.equal(status, "serving");
                assert.equal(endedAt, undefined, "read result must precede cleanup");
              })
            : assert.rejects(reading, (error) =>
                outcome === "cancelled"
                  ? error === reason
                  : error instanceof OpenShellServiceTransportError && error.reason === "timeout",
              );
        await Promise.all([verified, ended]);
        assert.equal(closeCode, 1000);
        assert.ok(
          endedAt !== undefined && closeReceivedAt !== undefined,
          "expected both close timestamps",
        );
        assert.ok(endedAt - started >= 950, "normal Close must get its cleanup interval");
        assert.ok(endedAt - closeReceivedAt < 1_500, "detached socket exceeded cleanup deadline");
      });
    }
  });

  test("OpenShell PAT cancellation releases a connection stalled before TLS completes", async (t) => {
    const sockets = new Set<Socket>();
    const cancelled = new AbortController();
    const reason = new Error("cancelled during TLS negotiation");
    const gateway = createTcpServer((socket) => {
      sockets.add(socket);
      // Receive the real ClientHello but never finish negotiation. Cancellation must
      // use the configured bound rather than the connector's longer default timeout.
      socket.once("data", () => cancelled.abort(reason));
      socket.resume();
    });
    const port = await listen(gateway);
    t.after(async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await close(gateway);
    });
    const client = new GrpcOpenShellGatewayClient({
      endpoint: `https://127.0.0.1:${port}`,
      requestTimeoutMs: 1_000,
    });
    t.after(() => client.close());
    const deadline = AbortSignal.timeout(2_000);
    const ended = (async () => {
      const [socket]: readonly unknown[] = await once(gateway, "connection", { signal: deadline });
      assert.ok(socket instanceof Socket, "expected a TCP connection");
      await once(socket, "end", { signal: deadline });
    })();
    const rejected = assert.rejects(
      client.serviceCodexReadinessStatus(serviceUrl, token, true, cancelled.signal),
      (error) => error === reason,
    );
    await Promise.all([rejected, ended]);
  });
}
