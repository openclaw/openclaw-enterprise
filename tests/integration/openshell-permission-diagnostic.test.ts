import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ActivationFailedError } from "../../packages/occ/src/errors.ts";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { selfSigned } from "../helpers/certificates.mjs";
import { observeOpenShellPermissionRefusal } from "../helpers/openshell-permission-diagnostic.ts";
import { temporaryDirectorySync } from "../helpers/temporary-directory.mjs";
import { completeSandboxRevision } from "./sandbox-driver-revision-fixture.ts";

const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const { WebSocketServer } = createRequire(controllerRequire.resolve("@kubernetes/client-node"))(
  "ws",
);
const bearer = "diagnostic-fixture-transport-token";
const sensitive = "PRIVATE-RESPONSE-MARKER";
const revisionId = "rev_00000000-0000-4000-8000-000000000003";
const deniedRequirements = {
  allowedSandboxModes: ["workspace-write"],
  allowedPermissionProfiles: { ":danger-full-access": true },
  allowedApprovalsReviewers: ["user"],
  allowedApprovalPolicies: ["on-request"],
  additionalDeveloperInstructions: sensitive,
};
interface Message {
  id?: number;
  method?: string;
  params?: Record<string, unknown> | null;
}
interface Peer {
  send(value: string | Buffer): void;
  terminate(): void;
  pause(): void;
  resume(): void;
  on(event: "message", handler: (data: Buffer) => void): void;
}
type Scenario =
  | "wrong-profile"
  | "wrong-reviewer"
  | "wrong-approval"
  | "wrong-legacy-mode"
  | "unknown-profile"
  | "missing-profile"
  | "persistent"
  | "missing-approval"
  | "init-missing"
  | "auth-api-key"
  | "auth-token"
  | "both-envelope"
  | "null-error"
  | "fractional-error"
  | "approval"
  | "trailing-approval"
  | "binary"
  | "single-oversize"
  | "aggregate-oversize"
  | "cancelled"
  | "timeout"
  | "stubborn-close"
  | "classified-cancelled";
interface Options {
  serving?: boolean;
  scenario?: Scenario;
  rpcCode?: number;
  tls?: "valid" | "wrong-identity";
  writer?: "throw" | "reject" | "stall";
  approvalPolicies?: unknown;
}

function startReply() {
  return {
    thread: {
      id: "019b217e-1234-7000-8000-123456789abc",
      sessionId: sensitive,
      cliVersion: "0.164.0",
      createdAt: 1,
      updatedAt: 1,
      cwd: "/workspace",
      ephemeral: true,
      modelProvider: "openai",
      preview: sensitive,
      projectId: null,
      source: "appServer",
      status: { type: "idle" },
      turns: [],
    },
    cwd: "/workspace",
    model: "fixture-model",
    modelProvider: "openai",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    activePermissionProfile: { id: ":danger-full-access", extends: sensitive },
  };
}

// Only service discovery and the remote protocol are controlled. The actual
// Driver classifies readiness before the fixture observes its failure. This is
// wire/Driver proof, not native entitlement or installed-cluster qualification.
async function fixture(t: TestContext, options: Options = {}) {
  const directory = options.tls
    ? temporaryDirectorySync(t, "permission-diagnostic-tls-")
    : undefined;
  const certificate = directory ? await selfSigned(directory) : undefined;
  const wrongCertificate =
    directory && options.tls === "wrong-identity"
      ? await selfSigned(directory, {
          name: "wrong",
          commonName: "wrong.example.test",
          subjectAltName: "DNS:wrong.example.test",
        })
      : undefined;
  const peers = new WebSocketServer({ noServer: true });
  let changeCertificate = () => {};
  const secureServer = certificate
    ? createSecureServer({ key: certificate.key, cert: certificate.cert })
    : undefined;
  const server = secureServer ?? createServer();
  if (wrongCertificate && secureServer) {
    changeCertificate = () =>
      secureServer.setSecureContext({ key: wrongCertificate.key, cert: wrongCertificate.cert });
  }
  server.on("request", (_request, response) => response.writeHead(404).end());
  const requests: Message[][] = [];
  const receipts: Record<string, unknown>[] = [];
  const originalErrors: unknown[] = [];
  const abort = new AbortController();
  const responseTimers = new Set<ReturnType<typeof setTimeout>>();
  const pausedPeers: Peer[] = [];
  server.on("upgrade", (request, socket, head) => {
    assert.equal(request.headers.host, "codex.example.test:9443");
    assert.equal(request.headers.authorization, `Bearer ${bearer}`);
    const messages: Message[] = [];
    requests.push(messages);
    const diagnostic = requests.length === 2;
    peers.handleUpgrade(request, socket, head, (peer: Peer) => {
      peers.emit("connection", peer);
      peer.on("message", (data: Buffer) => {
        const message = JSON.parse(data.toString()) as Message;
        messages.push(message);
        const result = (value: unknown) => {
          const send = () => peer.send(JSON.stringify({ id: message.id, result: value }));
          if (diagnostic && options.scenario === "timeout" && message.method !== "thread/start") {
            // Three separate one-second replies consume the same overall RPC
            // budget; the final stalled request must not restart that budget.
            const timer = setTimeout(() => {
              responseTimers.delete(timer);
              send();
            }, 1_000);
            responseTimers.add(timer);
          } else {
            send();
          }
        };
        if (message.method === "initialize") {
          result(
            diagnostic && options.scenario === "init-missing"
              ? { userAgent: "codex/0.164.0" }
              : {
                  userAgent: "codex/0.164.0",
                  codexHome: `/${sensitive}`,
                  platformFamily: "unix",
                  platformOs: "linux",
                },
          );
        } else if (message.method === "configRequirements/read") {
          if (diagnostic) {
            assert.equal(message.params, null);
          }
          result({
            requirements: options.serving
              ? null
              : {
                  ...deniedRequirements,
                  ...(Object.hasOwn(options, "approvalPolicies")
                    ? { allowedApprovalPolicies: options.approvalPolicies }
                    : {}),
                },
          });
          if (!diagnostic) {
            changeCertificate();
          }
        } else if (message.method === "getAuthStatus") {
          result({
            authMethod:
              diagnostic && options.scenario === "auth-api-key" ? "apiKey" : "personalAccessToken",
            authToken: diagnostic && options.scenario === "auth-token" ? sensitive : null,
            requiresOpenaiAuth: true,
            account: sensitive,
          });
        } else if (message.method === "thread/start") {
          const reply: Record<string, unknown> = startReply();
          const thread = reply.thread as Record<string, unknown>;
          if (options.rpcCode !== undefined) {
            peer.send(
              JSON.stringify({
                id: message.id,
                error: { code: options.rpcCode, message: sensitive },
              }),
            );
            return;
          }
          switch (options.scenario) {
            case "wrong-profile":
              reply.activePermissionProfile = { id: ":workspace" };
              break;
            case "wrong-reviewer":
              reply.approvalsReviewer = "auto_review";
              break;
            case "wrong-approval":
              reply.approvalPolicy = "never";
              break;
            case "wrong-legacy-mode":
              reply.sandbox = {
                type: "workspaceWrite",
                writableRoots: [],
                networkAccess: false,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false,
              };
              break;
            case "unknown-profile":
              reply.activePermissionProfile = null;
              break;
            case "missing-profile":
              delete reply.activePermissionProfile;
              break;
            case "persistent":
              thread.ephemeral = false;
              break;
            case "missing-approval":
              delete reply.approvalPolicy;
              break;
            case "both-envelope":
              peer.send(
                JSON.stringify({
                  id: message.id,
                  result: reply,
                  error: { code: -32000, message: sensitive },
                }),
              );
              return;
            case "null-error":
              peer.send(JSON.stringify({ id: message.id, error: null }));
              return;
            case "fractional-error":
              peer.send(
                JSON.stringify({ id: message.id, error: { code: 1.5, message: sensitive } }),
              );
              return;
            case "approval":
              peer.send(
                JSON.stringify({
                  id: 901,
                  method: "item/commandExecution/requestApproval",
                  params: { command: sensitive },
                }),
              );
              return;
            case "trailing-approval":
              // Queue both frames in one socket turn, before the client's awaited
              // final reply can commit an observation.
              result(reply);
              peer.send(
                JSON.stringify({
                  id: 901,
                  method: "item/commandExecution/requestApproval",
                  params: { command: sensitive },
                }),
              );
              return;
            case "binary":
              peer.send(Buffer.from(JSON.stringify({ id: message.id, result: reply })));
              return;
            case "single-oversize":
              peer.send(JSON.stringify({ method: "notice", params: "x".repeat(1024 * 1024) }));
              return;
            case "aggregate-oversize":
              for (let n = 0; n < 5; n++) {
                peer.send(JSON.stringify({ method: "notice", params: "x".repeat(256 * 1024) }));
              }
              return;
            case "cancelled":
              abort.abort(new Error(sensitive));
              return;
            case "timeout":
              return;
          }
          result(reply);
          if (options.scenario === "stubborn-close") {
            peer.pause();
            pausedPeers.push(peer);
          }
        }
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const protocol = certificate ? "https" : "http";
  const endpoint = `${protocol}://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const serviceUrl = `${protocol}://codex.example.test:9443/`;
  const client = new GrpcOpenShellGatewayClient({
    endpoint,
    requestTimeoutMs: 1_000,
    ...(certificate ? { rootCertificatePath: certificate.certPath } : {}),
  });
  t.after(async () => {
    for (const timer of responseTimers) {
      clearTimeout(timer);
    }
    client.close();
    for (const peer of peers.clients as Set<Peer>) {
      peer.terminate();
    }
    await new Promise<void>((resolve) => peers.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  let observedServiceUrl: string | undefined;
  client.getService = async (_workspace, sandbox, name) => {
    observedServiceUrl = serviceUrl;
    return {
      sandbox,
      name,
      targetPort: 8080,
      authorizationMode: "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH",
      url: serviceUrl,
      advertisedUrl: serviceUrl,
    };
  };
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
            endpoints: [{ host: "api.openai.com", ports: [443] }],
            binaries: [{ path: "/app/bin/model-client" }],
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
  const attempted = new Set<string>();
  const namespace = {
    id: "ns_00000000-0000-4000-8000-000000000001",
    name: "tenant-auth",
    status: "ready" as const,
    createdAt: "2026-11-11T00:00:00.000Z",
  };
  const revision = completeSandboxRevision(
    {
      id: revisionId,
      namespaceId: namespace.id,
      agentId: "agt_00000000-0000-4000-8000-000000000003",
      sandboxDriverId: driver.id,
      harness: { id: "codex", mode: "dedicated", version: "0.164.0" },
    },
    {
      method: "credential_source",
      loginMode: "codex_pat",
      sourceId: "cs_00000000-0000-4000-8000-000000000001",
      credentialGatewayId: "openshell-credentials",
      sourceType: "codex-pat",
    },
  );
  return {
    requests,
    receipts,
    attempted,
    originalErrors,
    abort,
    read(requirePat = true) {
      const context: Parameters<OpenShellSandboxDriver["harnessStatus"]>[0] = {
        namespace,
        kubernetes: undefined,
        revision: requirePat ? revision : { ...revision, harnessAuth: { method: "runtime" } },
        requirements: {
          loginMode: requirePat ? "codex_pat" : "runtime",
          image: "runtime@sha256:" + "a".repeat(64),
          command: ["codex", "app-server"],
          workspaceMounts: [],
          environment: [{ name: "APP_SERVER_PORT", value: "8080" }],
          files: [],
          credentialAttachments: [],
          labels: {},
        },
        transportToken: bearer,
        signal: abort.signal,
      };
      return observeOpenShellPermissionRefusal(
        async () => {
          try {
            return await driver.harnessStatus(context);
          } catch (error) {
            originalErrors.push(error);
            if (options.scenario === "classified-cancelled") {
              abort.abort(new Error(sensitive));
            }
            throw error;
          }
        },
        {
          endpoint,
          revisionId,
          cwd: "/workspace",
          model: "fixture-model",
          attempted,
          serviceUrl: () => observedServiceUrl,
          bearer,
          signal: abort.signal,
          requirePat,
          ...(certificate
            ? { rootCertificate: Buffer.from(certificate.cert + (wrongCertificate?.cert ?? "")) }
            : {}),
          write: (receipt) => {
            receipts.push(receipt as Record<string, unknown>);
            if (options.writer === "throw") {
              throw new Error("diagnostic destination unavailable");
            }
            if (options.writer === "reject") {
              return Promise.reject(new Error("diagnostic destination unavailable"));
            }
            if (options.writer === "stall") {
              return new Promise<void>(() => {});
            }
          },
        },
      );
    },
    async assertClosed() {
      // A deliberately uncooperative peer resumes only after the diagnostic
      // has returned, allowing its side to observe the client's forced close.
      for (const peer of pausedPeers) {
        peer.resume();
      }
      const deadline = Date.now() + 2_000;
      while (peers.clients.size !== 0 && Date.now() < deadline) {
        await delay(10);
      }
      assert.equal(peers.clients.size, 0, "every completed observation releases its connection");
    },
  };
}

async function assertRefusal(f: Awaited<ReturnType<typeof fixture>>, requirePat = true) {
  await assert.rejects(f.read(requirePat), (error: unknown) => {
    assert.ok(error instanceof ActivationFailedError);
    assert.equal(error.code, "RUNTIME_CODEX_PERMISSION_POLICY_INCOMPATIBLE");
    assert.deepEqual(error.permissionDenials, ["sandbox-mode-denied"]);
    assert.ok(
      f.originalErrors.includes(error),
      "rethrow the identical error from the actual Driver",
    );
    return true;
  });
}
function receipt(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal(f.receipts.length, 1);
  const value = f.receipts[0];
  assert.ok(value);
  assert.ok(!JSON.stringify(value).includes(sensitive));
  assert.ok(!JSON.stringify(value).includes(bearer));
  return value;
}
function assertNoTurnOrApprovalResponse(requests: Message[][]) {
  for (const message of requests.flat()) {
    assert.ok(
      [
        "initialize",
        "initialized",
        "configRequirements/read",
        "getAuthStatus",
        "thread/start",
      ].includes(message.method ?? ""),
    );
    if (message.method === "getAuthStatus") {
      assert.deepEqual(message.params, { includeToken: false, refreshToken: false });
    }
  }
}

test("a confirmed diagnostic grant preserves the actual Driver refusal and redacts the complete receipt", async (t) => {
  const f = await fixture(t);
  await assertRefusal(f);
  assert.deepEqual(receipt(f), {
    revisionId,
    outcome: "accepted",
    phase: "thread/start",
    cleanup: "closed",
    requirements: {
      present: true,
      modeAllowed: false,
      profileAllowed: true,
      reviewerAllowed: true,
      approvalAllowed: true,
    },
    authenticatedPat: true,
    grant: {
      sandbox: "dangerFullAccess",
      reviewer: "user",
      onRequestApproval: true,
      requestedProfile: true,
      ephemeral: true,
    },
  });
  const diagnostic = f.requests[1];
  assert.ok(diagnostic);
  assert.deepEqual(
    diagnostic.map((m) => m.method),
    ["initialize", "initialized", "configRequirements/read", "getAuthStatus", "thread/start"],
  );
  assert.deepEqual(diagnostic.find((m) => m.method === "thread/start")?.params, {
    cwd: "/workspace",
    model: "fixture-model",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    permissions: ":danger-full-access",
    ephemeral: true,
  });
  await assertRefusal(f);
  assert.equal(f.requests.length, 3);
  assert.equal(f.receipts.length, 1);
  assert.deepEqual([...f.attempted], [revisionId]);
  assertNoTurnOrApprovalResponse(f.requests);
  await f.assertClosed();
});

test("non-PAT refusals and serving PAT Drivers do not trigger diagnostics", async (t) => {
  const nonPat = await fixture(t);
  await assertRefusal(nonPat, false);
  assert.equal(nonPat.receipts.length, 0);
  assert.equal(nonPat.attempted.size, 0);
  assert.equal(nonPat.requests.length, 1);
  await nonPat.assertClosed();
  const serving = await fixture(t, { serving: true });
  assert.deepEqual(await serving.read(), { state: "serving" });
  assert.equal(serving.receipts.length, 0);
  assert.equal(serving.attempted.size, 0);
  assertNoTurnOrApprovalResponse(serving.requests);
  await serving.assertClosed();
});

for (const [scenario, outcome] of [
  ["wrong-profile", "mismatch"],
  ["wrong-reviewer", "mismatch"],
  ["wrong-approval", "mismatch"],
  ["wrong-legacy-mode", "mismatch"],
  ["persistent", "mismatch"],
  ["unknown-profile", "unconfirmed"],
  ["missing-profile", "unconfirmed"],
  ["missing-approval", "invalid-response"],
  ["init-missing", "invalid-response"],
  ["auth-api-key", "invalid-response"],
  ["auth-token", "invalid-response"],
  ["both-envelope", "invalid-response"],
  ["null-error", "invalid-response"],
  ["fractional-error", "invalid-response"],
  ["approval", "unexpected-request"],
  ["trailing-approval", "unexpected-request"],
  ["binary", "invalid-response"],
  ["single-oversize", "oversized"],
  ["aggregate-oversize", "oversized"],
  ["cancelled", "cancelled"],
  ["timeout", "timeout"],
] as const) {
  test(`diagnostic ${scenario} retains the classified failure`, { timeout: 15_000 }, async (t) => {
    const f = await fixture(t, { scenario });
    const started = Date.now();
    await assertRefusal(f);
    if (scenario === "timeout") {
      assert.ok(Date.now() - started < 12_000, "one shared deadline includes earlier replies");
    }
    const value = receipt(f);
    assert.equal(value.outcome, outcome);
    assert.ok(["closed", "terminated"].includes(String(value.cleanup)));
    if (scenario.startsWith("auth-")) {
      assert.equal(value.authenticatedPat, false);
      assert.ok(!f.requests.flat().some((m) => m.method === "thread/start"));
    }
    if (scenario === "init-missing") {
      assert.deepEqual(
        f.requests[1]?.map((m) => m.method),
        ["initialize"],
      );
    }
    assertNoTurnOrApprovalResponse(f.requests);
    await f.assertClosed();
  });
}

for (const [code, outcome] of [
  [-32700, "protocol-error"],
  [-32600, "protocol-error"],
  [-32601, "protocol-error"],
  [-32602, "protocol-error"],
  [-32603, "server-error"],
  [-32000, "rpc-error"],
] as const) {
  test(`diagnostic RPC code ${code} is ${outcome}, not evidence of policy refusal`, async (t) => {
    const f = await fixture(t, { rpcCode: code });
    await assertRefusal(f);
    assert.equal(receipt(f).outcome, outcome);
    await f.assertClosed();
  });
}

for (const tls of ["valid", "wrong-identity"] as const) {
  test(`diagnostic TLS ${tls} authenticates the endpoint before sending its bearer`, async (t) => {
    // For the negative case, rotate to another trusted certificate after the
    // real readiness read. Its SAN excludes the endpoint, so no second upgrade
    // (and therefore no diagnostic bearer) may reach the server.
    const f = await fixture(t, { tls });
    await assertRefusal(f);
    assert.equal(receipt(f).outcome, tls === "valid" ? "accepted" : "unavailable");
    assert.equal(f.requests.length, tls === "valid" ? 2 : 1);
    assertNoTurnOrApprovalResponse(f.requests);
    await f.assertClosed();
  });
}

for (const writer of ["throw", "reject", "stall"] as const) {
  test(
    `diagnostic writer ${writer} cannot replace the Driver refusal`,
    { timeout: 5_000 },
    async (t) => {
      const f = await fixture(t, { writer });
      await assertRefusal(f);
      await assertRefusal(f);
      assert.equal(f.receipts.length, 1);
      assert.equal(f.requests.length, 3);
      await f.assertClosed();
    },
  );
}

test("a pre-existing cancellation stays cancellation and never opens a diagnostic", async (t) => {
  const f = await fixture(t);
  const reason = new Error("caller already stopped");
  f.abort.abort(reason);
  await assert.rejects(f.read(), (error) => error === reason);
  assert.equal(f.receipts.length, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.attempted.size, 0);
});

for (const [name, approvalPolicies, expected] of [
  ["absent", undefined, null],
  ["only-never", ["never"], false],
  [
    "granular",
    [{ granular: { mcp_elicitations: false, rules: false, sandbox_approval: false } }],
    false,
  ],
] as const) {
  test(`diagnostic records ${name} approval requirements without their content`, async (t) => {
    const f = await fixture(t, { approvalPolicies });
    await assertRefusal(f);
    const requirements = receipt(f).requirements as Record<string, unknown>;
    assert.equal(requirements.approvalAllowed, expected);
    await f.assertClosed();
  });
}

test("cancellation after Driver classification retains its failure without opening another connection", async (t) => {
  const f = await fixture(t, { scenario: "classified-cancelled" });
  await assertRefusal(f);
  assert.deepEqual(receipt(f), {
    revisionId,
    outcome: "cancelled",
    phase: "connect",
    cleanup: "not-opened",
  });
  assert.equal(f.requests.length, 1);
  await f.assertClosed();
});

test(
  "a peer that ignores close is terminated within the diagnostic cleanup budget",
  { timeout: 5_000 },
  async (t) => {
    const f = await fixture(t, { scenario: "stubborn-close" });
    await assertRefusal(f);
    const value = receipt(f);
    assert.equal(value.outcome, "accepted");
    assert.equal(value.cleanup, "terminated");
    await f.assertClosed();
  },
);
