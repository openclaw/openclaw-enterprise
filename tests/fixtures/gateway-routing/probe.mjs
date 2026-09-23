import assert from "node:assert/strict";
import { GatewayClient, GatewayClientRequestError } from "@openclaw/gateway-client";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  X509Certificate,
} from "node:crypto";
import { connect as connectTls } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function connectGateway({ url, apiKey, extraHeaders = {}, native = {} }) {
  let resolveHello;
  let rejectHello;
  const connected = new Promise((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });
  const client = new GatewayClient({
    url,
    clientName: "gateway-client",
    mode: "backend",
    role: "operator",
    scopes: [],
    deviceIdentity: null,
    ...native,
    edgeAuthHeaders: {
      ...(apiKey === undefined ? {} : { "x-api-key": apiKey }),
      ...extraHeaders,
    },
    onHelloOk: resolveHello,
    onConnectError: rejectHello,
  });
  const timer = setTimeout(() => rejectHello(new Error("gateway hello timed out")), 15_000);
  client.start();
  try {
    return { client, hello: await connected };
  } catch (error) {
    client.stop();
    await client.stopAndWait?.({ timeoutMs: 1_000 }).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function certificate(url) {
  const endpoint = new URL(url);
  return await new Promise((resolve, reject) => {
    const socket = connectTls({
      host: endpoint.hostname,
      port: Number(endpoint.port || "443"),
      servername: endpoint.hostname,
      rejectUnauthorized: true,
    });
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(15_000, () => fail(new Error("TLS certificate probe timed out")));
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      const peer = socket.getPeerCertificate(true);
      socket.end();
      if (!(peer.raw instanceof Buffer)) {
        reject(new Error("TLS certificate probe did not return a raw peer certificate"));
        return;
      }
      const parsed = new X509Certificate(peer.raw);
      resolve({ serialNumber: parsed.serialNumber, issuer: parsed.issuer });
    });
  });
}

async function modelTurn({ url, apiKey, expectedMarker, timeoutMs = 240_000 }) {
  const prompt = "What is the configured workspace marker? Reply with only that marker.";
  const sessionKey = `agent:main:workspace-proof-${randomUUID()}`;
  const signal = AbortSignal.timeout(timeoutMs);
  const { client, hello } = await connectGateway({ url, apiKey });
  try {
    if (hello.auth?.role !== "operator" || !hello.auth.scopes.includes("operator.admin")) {
      throw new Error("trusted-proxy gateway authentication did not grant operator.admin");
    }
    if (hello.auth.deviceToken !== undefined) {
      throw new Error("trusted-proxy gateway issued an unexpected device token");
    }
    await client.request(
      "chat.send",
      { sessionKey, idempotencyKey: randomUUID(), message: prompt },
      { signal, timeoutMs: 30_000 },
    );
    while (!signal.aborted) {
      const history = await client.request(
        "chat.history",
        { sessionKey, limit: 20 },
        { signal, timeoutMs: 10_000 },
      );
      for (const message of history.messages ?? []) {
        if (message.role !== "assistant") {
          continue;
        }
        if (message.stopReason === "error") {
          throw new Error("the provider-backed native turn failed");
        }
        const content =
          typeof message.content === "string"
            ? message.content
            : (message.content ?? [])
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n");
        if (content.includes(expectedMarker)) {
          return { sessionKey, content, deviceTokenIssued: false };
        }
      }
      await delay(300, undefined, { signal });
    }
    throw new Error("the fresh native session did not consume the workspace instruction");
  } finally {
    client.stop();
    await client.stopAndWait?.({ timeoutMs: 1_000 }).catch(() => undefined);
  }
}

async function requestGatewayHello({ onConnected = async (_client, hello) => hello, ...options }) {
  const { client, hello } = await connectGateway(options);
  try {
    return await onConnected(client, hello);
  } finally {
    client.stop();
    await client.stopAndWait?.({ timeoutMs: 1_000 }).catch(() => undefined);
  }
}

async function assertNativeNodeRouteAuthentication({
  url,
  apiKey,
  gatewayIdentity,
  gatewayIdentityHeader,
}) {
  // This fixture is mounted at /app/apps/controller/gateway-probe.mjs.
  const { createGatewayNodeEnrollment } = await import("./src/gateway/node-enrollment-client.ts");
  const enrollment = createGatewayNodeEnrollment(async () => apiKey);
  const nodeUrl = `${url}/node`;
  // Use the published client contract and an ephemeral Ed25519 identity. The
  // real native Gateway owns token issuance, signature verification and pairing.
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublicKey = publicKey.export({ format: "jwk" }).x;
  const deviceIdentity = {
    deviceId: createHash("sha256").update(Buffer.from(rawPublicKey, "base64url")).digest("hex"),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
  const native = {
    clientName: "node-host",
    mode: "node",
    role: "node",
    scopes: [],
    caps: ["file"],
    commands: [
      "file.fetch",
      "file.stat",
      "file.write",
      "file.create",
      "dir.list",
      "workspace.memory",
      "workspace.skills",
    ],
    deviceIdentity,
    hostDeps: {
      signDevicePayload: (pem, payload) =>
        sign(null, Buffer.from(payload), pem).toString("base64url"),
      publicKeyRawBase64UrlFromPem: (pem) => createPublicKey(pem).export({ format: "jwk" }).x,
    },
  };
  // Reaching native authentication without an API key proves the route policy
  // overrides Envoy's Gateway policy; forged headers must not grant its identity.
  for (const extraHeaders of [
    {},
    {
      [gatewayIdentityHeader]: gatewayIdentity,
      "x-api-key": apiKey,
      "x-openclaw-scopes": "operator.admin",
      "x-real-ip": "127.0.0.1",
      "x-forwarded-for": "127.0.0.1",
      forwarded: "for=127.0.0.1",
      "tailscale-user-login": "spoofed@example.test",
    },
  ]) {
    await assert.rejects(
      () => requestGatewayHello({ url: nodeUrl, extraHeaders, native }),
      (error) => {
        assert.ok(error instanceof GatewayClientRequestError);
        assert.equal(error.details?.authReason, "trusted_proxy_user_missing");
        return true;
      },
    );
  }
  const setup = await enrollment.createSetup(url, nodeUrl, AbortSignal.timeout(15_000));
  const payload = JSON.parse(Buffer.from(setup.setupCode, "base64url").toString("utf8"));
  assert.equal(payload.url, nodeUrl);
  assert.equal(typeof payload.bootstrapToken, "string");
  try {
    const hello = await requestGatewayHello({
      url: nodeUrl,
      native: { ...native, bootstrapToken: payload.bootstrapToken, preferBootstrapToken: true },
      onConnected: async (_client, hello) => {
        assert.deepEqual(
          await enrollment.observeSetup(url, setup.setupId, AbortSignal.timeout(15_000)),
          { deviceId: deviceIdentity.deviceId, connected: true },
          "Compute must observe the paired identity and its admitted file commands",
        );
        return hello;
      },
    });
    assert.equal(hello.auth?.role, "node");
    assert.deepEqual(hello.auth.scopes, []);
    assert.equal(typeof hello.auth.deviceToken, "string");
    // A connected node without streaming input creation cannot serve uploads.
    // Keep the same approved identity so only its live command surface changes.
    await requestGatewayHello({
      url: nodeUrl,
      native: {
        ...native,
        commands: native.commands.filter((command) => command !== "file.create"),
        deviceToken: hello.auth.deviceToken,
      },
      onConnected: async () => {
        assert.equal(
          await enrollment.isConnected(url, deviceIdentity.deviceId, AbortSignal.timeout(15_000)),
          false,
          "Compute must not mark a node ready when attachment upload is unavailable",
        );
      },
    });
    const reconnected = await requestGatewayHello({
      url: nodeUrl,
      native: { ...native, deviceToken: hello.auth.deviceToken },
      onConnected: async (_client, hello) => {
        assert.equal(
          await enrollment.isConnected(url, deviceIdentity.deviceId, AbortSignal.timeout(15_000)),
          true,
          "the saved identity is ready after all required file commands return",
        );
        return hello;
      },
    });
    assert.equal(reconnected.auth?.role, "node");
    assert.deepEqual(reconnected.auth.scopes, []);
    await assert.rejects(
      () =>
        requestGatewayHello({
          url: nodeUrl,
          native: {
            ...native,
            clientName: "gateway-client",
            mode: "backend",
            role: "operator",
            scopes: ["operator.admin"],
            deviceToken: hello.auth.deviceToken,
          },
        }),
      GatewayClientRequestError,
    );
  } finally {
    await requestGatewayHello({
      url,
      apiKey,
      onConnected: (client) =>
        client.request(
          "device.pair.remove",
          { deviceId: deviceIdentity.deviceId },
          { timeoutMs: 15_000 },
        ),
    });
  }
}

const input = await readInput();
let result;
switch (input.action) {
  case "certificate":
    result = await certificate(input.url);
    break;
  case "hello": {
    const { client, hello } = await connectGateway(input);
    result = { auth: hello.auth };
    client.stop();
    await client.stopAndWait?.({ timeoutMs: 1_000 }).catch(() => undefined);
    break;
  }
  case "node-authentication":
    await assertNativeNodeRouteAuthentication(input);
    result = { ok: true };
    break;
  case "model-turn":
    result = await modelTurn(input);
    break;
  default:
    throw new Error(`unsupported gateway probe action: ${input.action}`);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
