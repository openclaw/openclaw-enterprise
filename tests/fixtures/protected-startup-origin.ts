import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { subscribe } from "node:diagnostics_channel";
import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { startOpenShellModelOrigin } from "./openshell-model-origin.ts";

async function main() {
  const emit = (event: Record<string, unknown>) =>
    process.stdout.write(`${JSON.stringify({ ...event, at: Date.now() })}\n`);
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const token = "synthetic-startup-transport";
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  let requests = 0;
  const credentialLabels = new Map([
    ["Bearer sk-openclaw-runtime-probe-synthetic", "origin-key"],
    ["Bearer synthetic-uninjected-placeholder", "placeholder"],
  ]);
  subscribe("http.server.request.start", (message) => {
    const { request } = message as { request: IncomingMessage };
    requests += 1;
    emit({
      event: "wire",
      method: request.method === "POST" ? "POST" : "unexpected",
      target: request.url === "/v1/responses" ? "responses" : "unexpected",
      credential: credentialLabels.get(request.headers.authorization ?? "") ?? "unexpected",
    });
  });
  await startOpenShellModelOrigin({
    host: "127.0.0.1",
    port: 443,
    model: process.env.PROBE_MODEL!,
    bearerDigests: {
      codex: digest("sk-openclaw-runtime-probe-synthetic"),
      openclaw: digest("synthetic-unused-openclaw"),
    },
    turns: [],
    tls: { key: readFileSync("/fixture/key.pem"), cert: readFileSync("/fixture/cert.pem") },
    onObservation: (observation) => {
      emit({
        event: "origin",
        kind: ["unmarked", "rejected"].includes(observation.kind) ? observation.kind : "unexpected",
        status: "status" in observation ? observation.status : null,
      });
    },
  });
  emit({
    event: "listening",
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
  });

  const base = "http://127.0.0.1:4500";
  async function request(path: string, authenticated = true, body?: unknown) {
    return fetch(base + path, {
      headers: {
        ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(2000),
    });
  }
  const path = "/openclaw/runtime/egress-enrollment";
  const deadline = Date.now() + 120_000;
  let challenge;
  while (Date.now() < deadline) {
    try {
      const response = await request(path);
      if (response.status === 200) {
        challenge = await response.json();
        break;
      }
    } catch {
      /* The wrapper has not bound its enrollment listener yet. */
    }
    await setTimeout(100);
  }
  assert.ok(challenge, "the real wrapper must publish its enrollment challenge");
  assert.equal((await request(path, false)).status, 401);
  const installation = {
    sandboxId: "synthetic-sandbox",
    instanceId: "synthetic-instance",
    configurationId: "synthetic-configuration",
    peerKeyId: "synthetic-peer",
  };
  const expiresAt = Date.now() + 30_000;
  const signature = sign(
    null,
    Buffer.from(JSON.stringify([challenge, installation, expiresAt])),
    privateKey,
  ).toString("base64url");
  const release = { challenge, installation, expiresAt, signature };
  assert.equal((await request(path, true, { ...release, signature: "A".repeat(86) })).status, 409);
  // Snapshot arrivals immediately before dispatch; release can start the probe before POST returns.
  const requestsBeforeRelease = requests;
  assert.equal(requestsBeforeRelease, 0, "no model arrival observed before release dispatch");
  assert.equal((await request(path, true, release)).status, 200);
  emit({
    event: "release",
    unauthorized: 401,
    invalidSignature: 409,
    accepted: 200,
    requestsBeforeRelease,
  });

  // The fixture signs a controlled release; it does not install an execution or redeem a grant.
  // Observe the real transport interface. A held failure has the wrapper's JSON;
  // successful startup hands this port to native Codex's HTTP authentication.
  function upgrade(authenticated: boolean): Promise<number> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(base, {
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": Buffer.alloc(16, 1).toString("base64"),
          ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
        },
      });
      request.setTimeout(2000, () => request.destroy(new Error("upgrade timeout")));
      request.on("error", reject);
      request.on("upgrade", (response, socket) => {
        socket.destroy();
        resolve(response.statusCode!);
      });
      request.on("response", (response) => {
        response.resume();
        resolve(response.statusCode!);
      });
      request.end();
    });
  }
  let last = "";
  for (;;) {
    try {
      const response = await request("/openclaw/runtime/status");
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      const unauthorized = await request("/openclaw/runtime/status", false);
      await unauthorized.text();
      const observation = {
        event: "transport",
        status: response.status,
        unauthorized: unauthorized.status,
        failure: body?.runtimeFailure
          ? {
              check: body.runtimeFailure.check === "model-probe" ? "model-probe" : "unexpected",
              code:
                body.runtimeFailure.code === "AUTHENTICATION_FAILED"
                  ? "AUTHENTICATION_FAILED"
                  : "unexpected",
            }
          : null,
        ...(response.status === 400 && !body?.runtimeFailure
          ? {
              authenticatedUpgrade: await upgrade(true),
              unauthenticatedUpgrade: await upgrade(false),
            }
          : {}),
      };
      const key = JSON.stringify(observation);
      if (key !== last) {
        emit(observation);
        last = key;
      }
    } catch {
      /* Enrollment closes before the next transport listener binds. */
    }
    await setTimeout(100);
  }
}

await main().catch(() => {
  process.stdout.write('{"event":"fixture-failed"}\n');
  process.exitCode = 1;
  process.exit(1);
});
