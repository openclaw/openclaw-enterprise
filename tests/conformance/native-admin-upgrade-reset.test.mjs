import assert from "node:assert/strict";
import { createRequire } from "node:module";
import net from "node:net";
import test from "node:test";
import { deriveNativeAdminHost } from "../../apps/controller/src/gateway/native-admin.ts";
import { createNativeAdminAccess } from "../../apps/controller/src/http/native-admin.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const Fastify = require("fastify");

test("a client reset during native-admin upgrade admission does not crash", async () => {
  const crashes = [];
  const onUncaught = (error) => {
    crashes.push(error);
  };
  process.on("uncaughtException", onUncaught);
  const app = Fastify({ logger: false });
  createNativeAdminAccess({
    app,
    installationId: "inst_native_admin_upgrade",
    publicOrigin: undefined,
    factory: {
      create() {
        return {};
      },
    },
    getController() {
      return undefined;
    },
    selectedIAMDriver() {
      throw new Error("unused");
    },
    getContext() {
      return undefined;
    },
    getAdmission() {
      return undefined;
    },
    auth: {
      admissionVerifier: {
        verify() {
          return new Promise(() => {});
        },
      },
    },
    nativeAdmin: { enabled: false, domain: "agents.example.test" },
    nativeAdminGatewayApiKey: undefined,
    webSocketLeaseIntervalMs: undefined,
    auditSink: { async append() {} },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  try {
    await new Promise((resolve, reject) => {
      const socket = net.connect(address.port, "127.0.0.1");
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write(
          "GET / HTTP/1.1\r\nHost: agent-a.agents.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        );
        setTimeout(() => {
          socket.resetAndDestroy();
          setTimeout(resolve, 300);
        }, 80);
      });
    });
    assert.deepEqual(crashes, []);
  } finally {
    process.off("uncaughtException", onUncaught);
    await app.close();
  }
});

test("a client reset during a pending native-admin denial still records the denial", async () => {
  const installationId = "inst_native_admin_upgrade";
  const agent = { id: "agent_a", namespaceId: "ns_a" };
  const domain = "agents.example.com";
  const host = deriveNativeAdminHost(installationId, agent, domain);
  const audits = [];
  let rejectAdmission = () => {};
  let admissionEntered = false;
  const admissionGate = new Promise((_resolve, reject) => {
    rejectAdmission = reject;
  });
  const crashes = [];
  const onUncaught = (error) => {
    crashes.push(error);
  };
  process.on("uncaughtException", onUncaught);
  const app = Fastify({ logger: false });
  createNativeAdminAccess({
    app,
    installationId,
    publicOrigin: "https://console.example.com",
    factory: {
      create(input) {
        return input;
      },
    },
    getController() {
      return {
        async resolveAgentReference(predicate) {
          return predicate(agent) ? agent : undefined;
        },
        getAdministerableActiveAgentRevision() {
          admissionEntered = true;
          return admissionGate;
        },
      };
    },
    selectedIAMDriver() {
      return {
        id: "iam_test",
        async lookupIdentity() {
          return {
            kind: "principal",
            id: "actor_1",
            issuer: "https://issuer.example",
            subject: "user-1",
          };
        },
      };
    },
    getContext() {
      return undefined;
    },
    getAdmission() {
      return undefined;
    },
    auth: {
      sharedCookieDomain: "example.com",
      admissionVerifier: {
        async verify() {
          return {
            method: "session",
            decisionId: "dec_1",
            admittedScope: { installationId },
            externalIdentity: { issuer: "https://issuer.example", subject: "user-1" },
            session: {
              id: "sess_1",
              userId: "user-1",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          };
        },
      },
    },
    nativeAdmin: { enabled: true, domain, sharedCookieDomain: "example.com" },
    nativeAdminGatewayApiKey: "gateway-test-key",
    webSocketLeaseIntervalMs: undefined,
    auditSink: {
      async append(event) {
        audits.push(event);
      },
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  try {
    await new Promise((resolve, reject) => {
      const socket = net.connect(address.port, "127.0.0.1");
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write(
          `GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
        );
        const waitUntil = Date.now() + 1000;
        const waitForAdmission = () => {
          if (admissionEntered || Date.now() > waitUntil) {
            socket.resetAndDestroy();
            setTimeout(resolve, 50);
            return;
          }
          setTimeout(waitForAdmission, 10);
        };
        setTimeout(waitForAdmission, 20);
      });
    });
    const denied = new Error("The exact platform operation was not authorized.");
    denied.name = "AuthorizationDeniedError";
    denied.authorization = {
      action: "openclaw.agents.native_admin.proxy.authorize",
      resource: { kind: "agent", id: agent.id, namespaceId: agent.namespaceId },
    };
    rejectAdmission(denied);
    const auditDeadline = Date.now() + 1000;
    while (audits.length === 0 && Date.now() < auditDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(admissionEntered, true);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].kind, "authorization_denial");
    assert.equal(audits[0].actor.principalId, "actor_1");
    assert.equal(audits[0].outcome, "denied");
    assert.equal(audits[0].details.nativeAdmin.reason, "authorization_denied");
    assert.equal(audits[0].details.nativeAdmin.host, host);
    assert.deepEqual(crashes, []);
  } finally {
    process.off("uncaughtException", onUncaught);
    await app.close();
  }
});
