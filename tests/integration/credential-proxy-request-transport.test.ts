import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import type { RequestCredentialInput } from "../../packages/contracts/src/index.ts";
import { bindOpenShellExchange } from "../../apps/controller/src/drivers/egress-proxy/openshell-exchange-binding.ts";
import {
  COMPUTE_RELEASE_PUBLIC_KEY,
  computeReleasePublicKey,
  harnessEgressEnrollment,
  signComputeExecutionRelease,
} from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import {
  HARNESS_EGRESS_ENROLLMENT_HELPER,
  HARNESS_EGRESS_ENROLLMENT_PATH,
} from "../../apps/controller/src/drivers/compute/harness-egress-enrollment.ts";
import {
  bindReservedPortInProcess,
  reservePort,
  reservedPortArgs,
} from "../helpers/available-port.mjs";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
import { invoke, openShellMiddlewareClient, token } from "../helpers/openshell-online-wire.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { requestCredentialFixture } from "../helpers/request-credential-fixture.ts";
import { waitFor } from "../helpers/qa-utils.mjs";

const { SignJWT } = createRequire(new URL("../../apps/controller/package.json", import.meta.url))(
  "jose",
);

test(
  "signed model request middleware redeems once through TLS after startup release (PostgreSQL)",
  { ...requiresPostgres, timeout: 90_000 },
  async (t) => {
    const fixture = await requestCredentialFixture(t, {
      credentialProxyCapacity: { operations: 2, authenticatingOperations: 1, sandboxOperations: 2 },
    });
    const { f } = fixture;
    const tls = await harnessTlsFixture(t);
    const issuerKeys = generateKeyPairSync("ed25519");
    const svidKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const genericKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const untypedKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const issuerPublicKeyPath = join(tls.directory, "issuer.pem");
    const bundlePath = join(tls.directory, "jwt-bundle.json");
    await writeFile(
      issuerPublicKeyPath,
      issuerKeys.publicKey.export({ type: "spki", format: "pem" }),
    );
    await writeFile(
      bundlePath,
      JSON.stringify({
        keys: [
          { ...svidKeys.publicKey.export({ format: "jwk" }), kid: "svid-key", use: "jwt-svid" },
        ],
      }),
    );
    const grpcPort = await reservePort();
    const grantPort = await reservePort();
    t.after(grpcPort.release);
    t.after(grantPort.release);
    await bindReservedPortInProcess(grpcPort);
    await bindReservedPortInProcess(grantPort);
    const tokenEndpoint = `https://localhost:${grantPort.port}/token`;
    const authority = {
      host: "127.0.0.1",
      port: grpcPort.port,
      issuer: "https://gateway.example.test",
      audience: "model-authorizer",
      keyId: "gateway-key",
      certificatePath: tls.certPath,
      privateKeyPath: tls.keyPath,
      issuerPublicKeyPath,
    };
    const binding = await bindOpenShellExchange(
      authority,
      fixture.installation.sender,
      (identity) => f.controller.createCredentialProxy(identity),
      {
        registrationName: "model-authority",
        tokenGrant: {
          endpoint: tokenEndpoint,
          port: grantPort.port,
          trustDomain: "fixture.test",
          bundlePath,
        },
      },
    );
    t.after(() => binding.close());
    await grpcPort.release();
    await grantPort.release();
    const client = openShellMiddlewareClient(t, grpcPort.port, tls.caBundle);
    const signed = token(
      issuerKeys,
      "supervisor",
      fixture.installation.sandboxId,
      authority.audience,
    );
    const gateway = token(issuerKeys, "gateway", undefined, authority.audience);
    const wire = (input: RequestCredentialInput) => ({
      phase: 1,
      middleware_name: "model-authority",
      context: {
        request_id: input.requestId,
        sandbox_id: input.recipient.id,
        workspace: f.namespace.name,
      },
      config: {
        fields: Object.fromEntries(
          Object.entries({
            binding_id: input.bindingId,
            namespace_id: input.execution.namespaceId,
            agent_id: input.execution.agentId,
            revision_id: input.execution.revisionId,
          }).map(([name, value]) => [name, { stringValue: value }]),
        ),
      },
      target: { ...input.http.target, scheme: input.http.target.reportedScheme },
      headers: input.http.headers.map(([name, value]) => ({ name, value })),
      body: input.http.body,
    });
    const evaluate = (input: RequestCredentialInput, bearer = signed, changes = {}) =>
      invoke(client, "EvaluateHttpRequest", { ...wire(input), ...changes }, bearer);
    const svid = (
      recipient = fixture.installation.sandboxId,
      audience = tokenEndpoint,
      key = svidKeys.privateKey,
      kid = "svid-key",
    ) =>
      new SignJWT({})
        .setProtectedHeader({ alg: "ES256", kid })
        .setSubject(`spiffe://fixture.test/openshell/sandbox/${recipient}`)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime("2m")
        .sign(key);
    const redeem = async (input: RequestCredentialInput, assertion = svid()) => {
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: await assertion,
        audience: input.bindingId,
      }).toString();
      return new Promise<{
        status: number;
        body: Record<string, unknown>;
        cache: string | undefined;
      }>((resolve, reject) => {
        const req = httpsRequest(
          tokenEndpoint,
          {
            method: "POST",
            ca: tls.caBundle,
            family: 4,
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "x-openshell-request-id": input.requestId,
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
              resolve({
                status: response.statusCode!,
                body: JSON.parse(Buffer.concat(chunks).toString()),
                cache: response.headers["cache-control"],
              }),
            );
            response.on("error", reject);
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    };

    // The generated launcher consumes the real admitted v8 plan. This is startup/signature
    // proof with a controlled external observer, not a packaged Codex or installed OpenShell test.
    const launchPort = await reservePort({ host: "0.0.0.0" });
    t.after(launchPort.release);
    const transportToken = "synthetic-startup-transport";
    const releaseKeys = generateKeyPairSync("ed25519");
    const launch = join(tls.directory, "startup.cjs");
    await writeFile(
      launch,
      `const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);\n${HARNESS_EGRESS_ENROLLMENT_HELPER}\nwaitForHarnessEgressEnrollment(${JSON.stringify(harnessEgressEnrollment(fixture.installation.plan))}).then(() => process.stdout.write("released\\n"), () => {process.exitCode = 1;});`,
    );
    const child = spawn(process.execPath, [...reservedPortArgs(launchPort), launch], {
      env: {
        APP_TOKEN_SHA: createHash("sha256").update(transportToken).digest("hex"),
        APP_SERVER_PORT: String(launchPort.port),
        OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID: fixture.revision.id,
        [COMPUTE_RELEASE_PUBLIC_KEY]: computeReleasePublicKey(releaseKeys.privateKey),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exited;
      }
    });
    let output = "";
    child.stdout.on("data", (data: Buffer) => {
      output += data;
    });
    const launchUrl = `http://127.0.0.1:${launchPort.port}${HARNESS_EGRESS_ENROLLMENT_PATH}`;
    const challenge = await waitFor(
      "online model startup challenge",
      async () => {
        try {
          const result = await fetch(launchUrl, {
            headers: { authorization: `Bearer ${transportToken}` },
          });
          return result.status === 200 ? await result.json() : undefined;
        } catch {
          return undefined;
        }
      },
      10000,
      { interval: 20 },
    );
    await launchPort.release();
    assert.equal(challenge.authorization, "online-request");
    assert.equal(output, "");
    const release = signComputeExecutionRelease(
      releaseKeys.privateKey,
      challenge.startupId,
      fixture.installation,
    );
    assert.equal(Object.hasOwn(release.installation, "peerKeyId"), false);
    const postRelease = (body: unknown) =>
      fetch(launchUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${transportToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal(
      (
        await postRelease({
          ...release,
          challenge: { ...release.challenge, authorization: undefined },
        })
      ).status,
      409,
    );
    assert.equal((await postRelease(release)).status, 200);
    assert.equal((await exited)[0], 0);
    assert.equal(output, "released\n");

    const input = fixture.request();
    const reads = f.secretReads;
    assert.equal((await evaluate(input, gateway)).decision, 2);
    assert.equal(
      (await evaluate(input, signed, { target: { ...wire(input).target, host: "192.0.2.1" } }))
        .decision,
      2,
      "the request hook refuses an IPv4 model destination",
    );
    assert.equal(
      (
        await evaluate(input, signed, {
          config: { fields: { binding_id: { stringValue: input.bindingId } } },
        })
      ).decision,
      2,
    );
    assert.equal((await redeem(input)).status, 403, "no approval means no material");
    assert.equal(f.secretReads, reads);
    assert.equal((await evaluate(input)).decision, 1);
    assert.equal(
      f.secretReads,
      reads,
      "the authorization RPC does not release or read key material",
    );
    assert.equal((await redeem(input, svid(randomUUID()))).status, 403);
    assert.equal((await redeem(input, svid(undefined, "wrong-audience"))).status, 401);
    // A mixed SPIFFE bundle does not make generic signing keys workload identity authorities.
    await writeFile(
      bundlePath,
      JSON.stringify({
        keys: [
          { ...svidKeys.publicKey.export({ format: "jwk" }), kid: "svid-key", use: "jwt-svid" },
          { ...genericKeys.publicKey.export({ format: "jwk" }), kid: "generic-key", use: "sig" },
          { ...untypedKeys.publicKey.export({ format: "jwk" }), kid: "untyped-key" },
        ],
      }),
    );
    for (const [key, kid] of [
      [genericKeys.privateKey, "generic-key"],
      [untypedKeys.privateKey, "untyped-key"],
    ] as const) {
      assert.equal((await redeem(input, svid(undefined, undefined, key, kid))).status, 401);
      assert.equal(f.secretReads, reads, "non-SVID keys never reach credential resolution");
    }
    const result = await redeem(input);
    assert.equal(result.status, 200);
    assert.equal(result.body.access_token, "synthetic-key-initial");
    assert.equal(result.body.token_type, "Bearer");
    assert.ok(Number(result.body.expires_in) > 0 && Number(result.body.expires_in) <= 30);
    assert.equal(result.cache, "no-store");
    assert.equal((await redeem(input)).status, 403, "an approval is single use");
    assert.equal((await evaluate(input)).decision, 2, "a consumed ID cannot be approved again");

    // An incomplete request occupies the authentication lease before any bundle or signature
    // work. The HTTPS and gRPC listeners share that same configured process budget.
    const pending = httpsRequest(tokenEndpoint, {
      method: "POST",
      ca: tls.caBundle,
      family: 4,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const pendingClosed = new Promise<void>((resolve) => pending.once("close", resolve));
    pending.on("error", () => {});
    t.after(() => pending.destroy());
    pending.write("client_assertion=");
    const capacityInput = fixture.request();
    await waitFor(
      "shared pre-authentication capacity",
      async () => (await redeem(capacityInput, Promise.resolve("invalid"))).status === 503,
      5000,
      { interval: 20 },
    );
    assert.equal((await evaluate(capacityInput)).decision, 2);
    const beforeCapacityRelease = f.secretReads;
    pending.destroy();
    await pendingClosed;
    await waitFor(
      "authentication capacity recovery",
      async () => (await redeem(capacityInput, Promise.resolve("invalid"))).status === 401,
      5000,
      { interval: 20 },
    );
    assert.equal(f.secretReads, beforeCapacityRelease);
    assert.equal((await evaluate(capacityInput)).decision, 1);
    assert.equal((await redeem(capacityInput)).status, 200);

    // Key rotation is observed without provider recreation; removing a trust key takes effect
    // on the next HTTPS request and never reaches the Secret reader.
    const update = await f.request(
      "PATCH",
      `/namespaces/${f.namespace.id}/secrets/${f.secret.id}`,
      { body: { value: "synthetic-key-rotated" } },
    );
    assert.equal(update.status, 200);
    const next = fixture.request();
    assert.equal((await evaluate(next)).decision, 1);
    const beforeTrustRemoval = f.secretReads;
    await writeFile(bundlePath, JSON.stringify({ keys: [] }));
    assert.equal((await redeem(next)).status, 503);
    assert.equal(f.secretReads, beforeTrustRemoval);
    await writeFile(
      bundlePath,
      JSON.stringify({
        keys: [
          { ...svidKeys.publicKey.export({ format: "jwk" }), kid: "svid-key", use: "jwt-svid" },
        ],
      }),
    );
    assert.equal((await redeem(next)).body.access_token, "synthetic-key-rotated");
  },
);
