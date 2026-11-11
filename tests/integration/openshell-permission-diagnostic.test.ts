import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { selfSigned } from "../helpers/certificates.mjs";
import { temporaryDirectorySync } from "../helpers/temporary-directory.mjs";
import { withOpenShellPermissionDiagnostic } from "../helpers/openshell-permission-diagnostic.ts";

const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const { WebSocketServer } = createRequire(controllerRequire.resolve("@kubernetes/client-node"))(
  "ws",
);
const bearer = "diagnostic-fixture-transport-token";
const sensitive = "PRIVATE-RESPONSE-MARKER";
const refusal = { state: "permission-refused", permissionDenials: ["sandbox-mode-denied"] };
const deniedRequirements = {
  allowedSandboxModes: ["workspace-write"],
  additionalDeveloperInstructions: sensitive,
};
type Failure = "rpc-refused" | "unexpected-request" | "timeout" | "cancelled";
interface Message {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}
interface Peer {
  send(value: string): void;
  terminate(): void;
  on(event: "message", handler: (data: Buffer) => void): void;
}
interface Receipt {
  outcome: string;
  cleanup: string;
  grant?: {
    sandbox: string;
    reviewer: string;
    onRequestApproval: boolean;
    requestedProfile: boolean;
  };
}

// This peer controls only the native protocol. Readiness classification, routing,
// WebSocket transport, and the diagnostic wrapper are the actual implementations.
// These tests do not claim native Codex entitlement or installed-cluster proof.
async function fixture(
  t: TestContext,
  options: { serving?: boolean; failure?: Failure; tls?: boolean; writeThrows?: boolean } = {},
) {
  const certificate = options.tls
    ? await selfSigned(temporaryDirectorySync(t, "permission-diagnostic-tls-"))
    : undefined;
  const peers = new WebSocketServer({ noServer: true });
  const server = certificate
    ? createSecureServer({ key: certificate.key, cert: certificate.cert })
    : createServer();
  server.on("request", (_request, response) => response.writeHead(404).end());
  const requests: Message[][] = [];
  const receipts: Receipt[] = [];
  const signal = new AbortController();
  server.on("upgrade", (request, socket, head) => {
    assert.equal(request.headers.host, "codex.example.test:9443");
    assert.equal(request.headers.authorization, `Bearer ${bearer}`);
    const messages: Message[] = [];
    requests.push(messages);
    peers.handleUpgrade(request, socket, head, (peer: Peer) => {
      peers.emit("connection", peer);
      peer.on("message", (data: Buffer) => {
        const message = JSON.parse(data.toString()) as Message;
        messages.push(message);
        const result = (value: unknown) =>
          peer.send(JSON.stringify({ id: message.id, result: value }));
        switch (message.method) {
          case "initialize":
            result({ userAgent: "codex/0.164.0", codexHome: sensitive });
            break;
          case "initialized":
            break;
          case "configRequirements/read":
            result({ requirements: options.serving ? null : deniedRequirements });
            break;
          case "getAuthStatus":
            result({
              authMethod: "personalAccessToken",
              authToken: null,
              requiresOpenaiAuth: true,
              account: sensitive,
            });
            break;
          case "thread/start":
            if (options.failure === "rpc-refused") {
              peer.send(
                JSON.stringify({ id: message.id, error: { code: -32600, message: sensitive } }),
              );
            } else if (options.failure === "unexpected-request") {
              peer.send(
                JSON.stringify({
                  id: 901,
                  method: "item/commandExecution/requestApproval",
                  params: { command: sensitive },
                }),
              );
            } else if (options.failure === "cancelled") {
              signal.abort(new Error(sensitive));
            } else if (options.failure !== "timeout") {
              result({
                thread: { id: sensitive, turns: [{ text: sensitive }] },
                approvalPolicy: "on-request",
                approvalsReviewer: "user",
                sandbox: { type: "dangerFullAccess" },
                activePermissionProfile: { id: ":danger-full-access", extends: sensitive },
                instructionSources: [sensitive],
              });
            }
            break;
          default:
            // Any accidental turn or approval response is retained for the final
            // protocol assertions, and cannot silently make this peer succeed.
            result({});
        }
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const protocol = certificate ? "https" : "http";
  const endpoint = `${protocol}://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new GrpcOpenShellGatewayClient({
    endpoint,
    requestTimeoutMs: 1_000,
    ...(certificate ? { rootCertificatePath: certificate.certPath } : {}),
  });
  t.after(async () => {
    await client.close();
    for (const peer of peers.clients as Set<Peer>) {
      peer.terminate();
    }
    await new Promise<void>((resolve) => peers.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const attempted = new Set<string>();
  const wrapped = withOpenShellPermissionDiagnostic(client, {
    endpoint,
    revisionId: "diagnostic-revision",
    cwd: "/workspace",
    model: "fixture-model",
    attempted,
    ...(certificate ? { rootCertificate: Buffer.from(certificate.cert) } : {}),
    write: (receipt) => {
      receipts.push(receipt as Receipt);
      if (options.writeThrows) {
        throw new Error("diagnostic destination unavailable");
      }
    },
  });
  return {
    requests,
    receipts,
    attempted,
    read: (requirePat = true) =>
      wrapped.serviceCodexReadinessStatus(
        `${protocol}://codex.example.test:9443/`,
        bearer,
        requirePat,
        signal.signal,
      ),
    async assertClosed() {
      const deadline = Date.now() + 2_000;
      while (peers.clients.size !== 0 && Date.now() < deadline) {
        await delay(10);
      }
      assert.equal(peers.clients.size, 0, "each completed read must release its connection");
    },
  };
}

function assertNoTurnOrApprovalResponse(requests: Message[][]) {
  for (const messages of requests) {
    for (const message of messages) {
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
}

test("a native grant is diagnostic evidence and never overrides the real readiness refusal", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.read(), refusal);
  assert.equal(f.receipts.length, 1);
  const receipt = f.receipts[0];
  assert.ok(receipt);
  assert.equal(receipt.outcome, "accepted");
  assert.deepEqual(receipt.grant, {
    sandbox: "dangerFullAccess",
    reviewer: "user",
    onRequestApproval: true,
    requestedProfile: true,
  });
  assert.ok(!JSON.stringify(f.receipts).includes(sensitive));
  assert.ok(!JSON.stringify(f.receipts).includes(bearer));
  assert.equal(f.requests.length, 2);
  const diagnosticRequests = f.requests[1];
  assert.ok(diagnosticRequests);
  assert.deepEqual(
    diagnosticRequests.map((message) => message.method),
    ["initialize", "initialized", "configRequirements/read", "getAuthStatus", "thread/start"],
  );
  assert.deepEqual(
    diagnosticRequests.find((message) => message.method === "thread/start")?.params,
    {
      cwd: "/workspace",
      model: "fixture-model",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      permissions: ":danger-full-access",
      ephemeral: true,
    },
  );
  // A worker may observe the same refusal repeatedly; evidence must not create
  // a new diagnostic thread each time or suppress the original refusal.
  assert.deepEqual(await f.read(), refusal);
  assert.equal(f.receipts.length, 1);
  assert.equal(f.requests.length, 3);
  assert.deepEqual([...f.attempted], ["diagnostic-revision"]);
  assertNoTurnOrApprovalResponse(f.requests);
  await f.assertClosed();
});

test("non-PAT refusals and healthy PAT readiness do not create diagnostic threads", async (t) => {
  const nonPat = await fixture(t);
  assert.deepEqual(await nonPat.read(false), refusal);
  assert.equal(nonPat.receipts.length, 0);
  assert.equal(nonPat.attempted.size, 0);
  assert.equal(nonPat.requests.length, 1);
  await nonPat.assertClosed();
  const serving = await fixture(t, { serving: true });
  assert.equal(await serving.read(), "serving");
  assert.equal(serving.receipts.length, 0);
  assert.equal(serving.attempted.size, 0);
  assert.equal(serving.requests.length, 1);
  assertNoTurnOrApprovalResponse(serving.requests);
  await serving.assertClosed();
});

for (const failure of ["rpc-refused", "unexpected-request", "cancelled", "timeout"] as const) {
  test(
    `diagnostic ${failure} preserves refusal and closes its connection`,
    { timeout: 15_000 },
    async (t) => {
      const f = await fixture(t, { failure });
      assert.deepEqual(await f.read(), refusal);
      assert.equal(f.receipts.length, 1);
      const receipt = f.receipts[0];
      assert.ok(receipt);
      assert.equal(receipt.outcome, failure);
      assert.ok(["closed", "terminated"].includes(receipt.cleanup));
      assert.ok(!JSON.stringify(f.receipts).includes(sensitive));
      assertNoTurnOrApprovalResponse(f.requests);
      await f.assertClosed();
    },
  );
}

test("diagnostic TLS verifies the control endpoint while routing to the advertised service host", async (t) => {
  // The certificate includes only localhost/127.0.0.1, not the service host.
  // Verifying TLS against the advertised Host would reject this valid route.
  const f = await fixture(t, { tls: true });
  assert.deepEqual(await f.read(), refusal);
  assert.equal(f.receipts.length, 1);
  const receipt = f.receipts[0];
  assert.ok(receipt);
  assert.equal(receipt.outcome, "accepted");
  assert.equal(f.requests.length, 2);
  assertNoTurnOrApprovalResponse(f.requests);
  await f.assertClosed();
});

test("an unavailable diagnostic output destination cannot replace the readiness refusal", async (t) => {
  const f = await fixture(t, { writeThrows: true });
  assert.deepEqual(await f.read(), refusal);
  assert.deepEqual(await f.read(), refusal);
  assert.equal(f.receipts.length, 1, "failed evidence writes must not repeatedly create threads");
  assertNoTurnOrApprovalResponse(f.requests);
  await f.assertClosed();
});
