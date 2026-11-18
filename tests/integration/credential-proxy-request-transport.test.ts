import { postgresApp } from "../helpers/postgres-egress-app.mjs";
import type { OpenClawController } from "../../packages/occ/src/index.ts";
import { staticEgressAdmissionFixture, staticEgressFixture } from "../helpers/static-egress.mjs";
import { openShellModelRequestPolicy } from "../../apps/controller/src/drivers/sandbox/openshell-model-request-policy.ts";
import { openShellProfileEndpoint } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import {
  createGitHubRepositoryDeliveryResolver,
  validateGitHubRepositoryRegistry,
} from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
import {
  OpenShellGitRuntime,
  openShellRepositoryAccess,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type {
  CredentialProxyDriver,
  CredentialProviderDefinition,
  RequestCredentialInput,
} from "../../packages/contracts/src/index.ts";
import { installEgressAuthority } from "../../apps/controller/src/composition/egress-authority.ts";
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
} from "../helpers/available-port.ts";
import { harnessTlsFixture } from "../helpers/harness-tls.ts";
import { invoke, openShellMiddlewareClient, token } from "../helpers/openshell-online-wire.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { requestCredentialFixture } from "../helpers/request-credential-fixture.ts";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.ts";
import { waitFor } from "../helpers/qa-wait.ts";

const { SignJWT } = createRequire(new URL("../../apps/controller/package.json", import.meta.url))(
  "jose",
);

test(
  "signed model request middleware redeems once through TLS after startup release (PostgreSQL)",
  { ...requiresPostgres, timeout: 90_000 },
  async (t) => {
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
    const bindExchange: NonNullable<CredentialProxyDriver["bindExchange"]> = (createProxy) =>
      bindOpenShellExchange(authority, fixture.installation.sender, createProxy, {
        registrationName: "model-authority",
        tokenGrant: {
          endpoint: tokenEndpoint,
          port: grantPort.port,
          trustDomain: "fixture.test",
          bundlePath,
        },
      });
    const fixture = await requestCredentialFixture(t, {
      credentialProxyCapacity: { operations: 2, authenticatingOperations: 1, sandboxOperations: 2 },
      bindExchange,
    });
    const { f } = fixture;
    // Production and development composition expose a restricted exchange facade to the
    // selected Driver. Exercise that facade before sending any real TLS request.
    const binding = await installEgressAuthority(f.controller, fixture.owner);
    assert.ok(binding);
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

    const late = fixture.request();
    const committed = fixture.pauseNextApprovalCommit("after");
    const cancel = new AbortController();
    const rpc = invoke(client, "EvaluateHttpRequest", wire(late), signed, {
      signal: cancel.signal,
    });
    const canceled = assert.rejects(rpc, { code: 1 });
    const beforeCancellation = f.secretReads;
    try {
      await committed.reached;
      cancel.abort();
      await canceled;
      assert.equal((await redeem(late)).status, 403);
    } finally {
      committed.release();
    }
    assert.equal((await evaluate(late)).decision, 2);
    assert.equal((await redeem(late)).status, 403);
    assert.equal(f.secretReads, beforeCancellation);

    const uncertain = fixture.request();
    const activation = fixture.pauseNextApprovalCommit("activation-unknown");
    const outcome = assert.rejects(evaluate(uncertain), { code: 14 });
    try {
      await activation.reached;
    } finally {
      activation.release();
    }
    await outcome;
    assert.equal((await redeem(uncertain)).status, 200, "a committed decision may be redeemable");
    assert.equal((await redeem(uncertain)).status, 403);
    assert.equal((await evaluate(uncertain)).decision, 2, "unknown activation cannot be replayed");

    // A slow wall clock must not extend the database lease in the HTTP TTL. Hold a
    // real Secret read so returning the original monotonic budget would also fail.
    const shortLease = fixture.request();
    const shortPeer = await new SignJWT({
      caller_kind: "supervisor",
      sandbox_id: fixture.installation.sandboxId,
    })
      .setProtectedHeader({ alg: "EdDSA", typ: "openshell-ext+jwt", kid: authority.keyId })
      .setIssuer(authority.issuer)
      .setSubject(`spiffe://openshell/sandbox/${fixture.installation.sandboxId}`)
      .setAudience(authority.audience)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 10)
      .setJti(randomUUID())
      .sign(issuerKeys.privateKey);
    assert.equal((await evaluate(shortLease, `Bearer ${shortPeer}`)).decision, 1);
    const assertion = await svid();
    const lease = await f.pool.query(
      "SELECT extract(epoch FROM (expires_at - clock_timestamp())) * 1000 AS remaining FROM occ.request_credential_approvals WHERE recipient_id = $1 AND request_id = $2",
      [shortLease.recipient.id, shortLease.requestId],
    );
    const pausedRead = f.pauseNextSecretRead();
    const wallClock = Date.now;
    const started = performance.now();
    const skewedClock = t.mock.method(Date, "now", () => wallClock() - 10_000);
    try {
      const pendingGrant = redeem(shortLease, Promise.resolve(assertion));
      await pausedRead.reached;
      await delay(2200);
      pausedRead.release();
      const grant = await pendingGrant;
      assert.equal(grant.status, 200);
      // The server rounds before transmission. Allow the one-second boundary
      // crossed in transit, while the held read still exceeds that allowance.
      const remaining = Math.ceil(
        (Number(lease.rows[0].remaining) - (performance.now() - started)) / 1000,
      );
      assert.ok(Number(grant.body.expires_in) > 0);
      assert.ok(
        Number(grant.body.expires_in) <= remaining,
        "HTTP TTL excludes clock skew and elapsed resolver work",
      );
    } finally {
      pausedRead.release();
      skewedClock.mock.restore();
    }

    // An incomplete HTTPS body must leave the only authentication slot available.
    async function incompleteGrant() {
      const pending = httpsRequest(tokenEndpoint, {
        method: "POST",
        ca: tls.caBundle,
        family: 4,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      const closed = new Promise<void>((resolve) => pending.once("close", resolve));
      pending.on("error", () => {});
      t.after(() => pending.destroy());
      await new Promise<void>((resolve, reject) =>
        pending.write("client_assertion=", (error) => (error ? reject(error) : resolve())),
      );
      return { pending, closed };
    }
    const { pending, closed } = await incompleteGrant();
    const capacityInput = fixture.request();
    assert.equal((await evaluate(capacityInput)).decision, 1);
    assert.equal((await redeem(capacityInput)).status, 200);
    assert.equal(pending.destroyed, false);
    assert.equal(
      await Promise.race([closed.then(() => true), delay(8_000, false, { ref: false })]),
      true,
      "the authority closes an incomplete body at its read deadline",
    );
    const interrupted = await incompleteGrant();
    interrupted.pending.destroy();
    await interrupted.closed;

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

test(
  "credential source HTTP creation and protection readback follow installed policy and exact registrations (PostgreSQL)",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const fixture = await requestCredentialFixture(t, {
      verifyAdmissionPolicy: true,
      retainStrictBeforePolicy: true,
      includeLegacy: true,
    });
    const { f, owner, retainedStrict, revision } = fixture;
    const path = `/namespaces/${f.namespace.id}/credential-sources`;
    assert.ok(retainedStrict);
    const ordinary = await f.request("GET", `${path}/${f.legacySource.id}`);
    assert.equal(ordinary.status, 200, JSON.stringify(ordinary.body));
    assert.equal(
      ordinary.data.egress,
      undefined,
      "ordinary Gateway source has no protected profile",
    );
    assert.equal(retainedStrict.egress?.protection, "exact-dispatch", "strict create response");
    assert.equal(f.source.egress.protection, "request-time", "omitted-profile create response");
    assert.equal(revision.egressPlan?.authorization, "online-request", "Codex stays protected");
    const strict = await f.request("GET", `${path}/${retainedStrict.id}`);
    const online = await f.request("GET", `${path}/${f.source.id}`);
    assert.equal(strict.status, 200, JSON.stringify(strict.body));
    assert.equal(
      strict.data.egress.protection,
      "exact-dispatch",
      "new default cannot rewrite an existing source",
    );
    assert.equal(online.status, 200, JSON.stringify(online.body));
    assert.equal(online.data.egress.protection, "request-time");
    assert.deepEqual(Object.keys(online.data.egress).sort(), [
      "adoption",
      "protection",
      "retention",
    ]);

    // The request-time profile is available for new sources, not a silent conversion
    // of an ordinary Gateway source through the legacy strict-adoption operation.
    const legacyPath = `${path}/${f.legacySource.id}`;
    const legacyBefore = (await f.request("GET", legacyPath)).data;
    const retainedBefore = await f.controller.transact((unit) =>
      unit.credentialSources.findCredentialSource(f.namespace.id, f.legacySource.id),
    );
    assert.equal(
      await f.controller.transact((unit) =>
        unit.credentialSources.hasReferences(f.namespace.id, f.legacySource.id),
      ),
      false,
    );
    const gatewayBefore = [...f.gatewayEffects];
    const adoptionReads = f.countSecretReads();
    const adoption = await f.request("PATCH", legacyPath, {
      body: { adoption: "live", authorityScope: "execution" },
    });
    assert.equal(adoption.status, 409, JSON.stringify(adoption.body));
    assert.equal(adoption.body.error.code, "RESOURCE_CONFLICT");
    assert.match(adoption.body.error.message, /retired new uses/);
    assert.equal(f.countSecretReads(), adoptionReads);
    assert.deepEqual((await f.request("GET", legacyPath)).data, legacyBefore);
    assert.deepEqual(
      await f.controller.transact((unit) =>
        unit.credentialSources.findCredentialSource(f.namespace.id, f.legacySource.id),
      ),
      retainedBefore,
    );
    assert.deepEqual(f.gatewayEffects, gatewayBefore);

    // Missing or duplicate exact registrations cannot silently become strict, and reads remain usable.
    const providers = owner.require("credential_proxy").sourceControl
      .providers as CredentialProviderDefinition[];
    const chosen = providers[0]!;
    const collision = {
      ...chosen,
      sourceType: { ...chosen.sourceType, type: "different-source-type" },
    };
    const refuseCollision = async (name: string) => {
      const reads = f.countSecretReads();
      const response = await f.request("POST", path, {
        body: {
          name,
          type: "openai",
          config: { authorized_base_url: f.modelProvider.baseUrl },
          secrets: { api_key: f.secret.ref },
        },
      });
      assert.equal(response.status, 409, JSON.stringify(response.body));
      assert.equal(f.countSecretReads(), reads);
      const rows = await f.pool.query(
        "SELECT id FROM occ.credential_sources WHERE namespace_id=$1 AND name=$2",
        [f.namespace.id, name],
      );
      assert.equal(rows.rowCount, 0);
    };
    providers.push(collision);
    try {
      await refuseCollision("duplicate-provider-identity");
      const catalog = await f.request("GET", `/namespaces/${f.namespace.id}/agent-capabilities`);
      assert.equal(
        catalog.data.capabilities.credentialSources.types.some(
          (type: { type: string }) => type.type === "openai",
        ),
        false,
      );
    } finally {
      providers.pop();
    }
    const control = owner.require("credential_proxy").requestTimeCredentials!;
    const assertAvailable = control.assertAvailable;
    let collisionInserted = false;
    control.assertAvailable = async (signal) => {
      await assertAvailable.call(control, signal);
      providers.push(collision);
      collisionInserted = true;
    };
    try {
      await refuseCollision("raced-provider-identity");
      assert.equal(collisionInserted, true);
    } finally {
      control.assertAvailable = assertAvailable;
      if (providers.at(-1) === collision) providers.pop();
    }
    const requestProvider = providers.shift()!;
    try {
      const missing = await f.request("GET", `${path}/${f.source.id}`);
      const listed = await f.request("GET", path);
      assert.equal(missing.status, 200, JSON.stringify(missing.body));
      assert.equal(missing.data.egress.protection, "unavailable");
      assert.equal(listed.status, 200, JSON.stringify(listed.body));
      assert.equal(
        listed.data.find((entry: { id: string }) => entry.id === f.source.id).egress.protection,
        "unavailable",
      );
      providers.unshift(requestProvider, requestProvider);
      const ambiguous = await f.request("GET", `${path}/${f.source.id}`);
      assert.equal(ambiguous.status, 200, JSON.stringify(ambiguous.body));
      assert.equal(ambiguous.data.egress.protection, "unavailable");
    } finally {
      while (providers[0] === requestProvider) {
        providers.shift();
      }
      providers.unshift(requestProvider);
    }
  },
);

test(
  "model-only request admission uses the registered request profile without strict capabilities",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    // The real Proxy Driver reads request-only registration over the TLS gRPC fixture.
    // API admission must not also demand the strict execution-exchange capabilities.
    const f = await staticEgressFixture(t, {
      admitRevision: false,
      requestCredentials: true,
      appFactory: postgresApp,
    });
    const controller: OpenClawController = f.controller;
    const catalog = await f.request("GET", `/namespaces/${f.namespace.id}/agent-capabilities`);
    assert.equal(catalog.status, 200);
    assert.equal(
      catalog.data.capabilities.credentialSources.types.some(
        (entry: { type: string }) => entry.type === "openai",
      ),
      true,
    );
    const storedSource = await controller.transact((unit) =>
      unit.credentialSources.findCredentialSource(f.namespace.id, f.source.id),
    );
    assert.deepEqual(storedSource?.egress?.key.provider, {
      id: "openai-online-request",
      generation: 1,
    });
    const path = `/namespaces/${f.namespace.id}/agents/${f.agent.id}/deploy`;
    const admitted = await f.request("POST", path);
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    const revision = await controller.transact((unit) =>
      unit.revisions.findRevision(f.namespace.id, f.agent.id, admitted.data.id),
    );
    assert.ok(revision?.egressPlan);
    assert.deepEqual(revision.executionAdmission, { mode: "protected", version: 8 });
    assert.equal(revision.egressPlan.authorization, "online-request");
    assert.equal(revision.egressPlan.repositoryGit, undefined);

    // Without full request-time model configuration, the bundled strict provider remains retired.
    const strictFixture = await staticEgressAdmissionFixture(t, { appFactory: postgresApp });
    const reads = strictFixture.countSecretReads();
    const strict = await strictFixture.request(
      "POST",
      `/namespaces/${strictFixture.namespace.id}/credential-sources`,
      {
        body: {
          name: "strict-still-refused",
          type: "openai",
          config: { authorized_base_url: strictFixture.modelProvider.baseUrl },
          secrets: { api_key: strictFixture.secret.ref },
        },
      },
    );
    assert.equal(strict.status, 409, JSON.stringify(strict.body));
    assert.equal(strict.body.error.code, "RESOURCE_CONFLICT");
    assert.equal(strictFixture.countSecretReads(), reads);

    // Request admission still requires the live registered middleware.
    f.observed.available = false;
    const staleCatalog = await f.request("GET", `/namespaces/${f.namespace.id}/agent-capabilities`);
    assert.equal(
      staleCatalog.data.capabilities.credentialSources.types.some(
        (entry: { type: string }) => entry.type === "openai",
      ),
      true,
      "catalog discovery does not contact the live enforcement transport",
    );
    const beforeUnavailable = f.countSecretReads();
    const unavailableSource = await f.request(
      "POST",
      `/namespaces/${f.namespace.id}/credential-sources`,
      {
        body: {
          name: "unavailable-default",
          type: "openai",
          config: { authorized_base_url: f.modelProvider.baseUrl },
          secrets: { api_key: f.secret.ref },
        },
      },
    );
    assert.equal(unavailableSource.status, 503, JSON.stringify(unavailableSource.body));
    assert.equal(f.countSecretReads(), beforeUnavailable);
    const unavailable = await f.request("POST", path);
    assert.equal(unavailable.status, 503, JSON.stringify(unavailable.body));
  },
);

test(
  "API-admitted model and Git revision requires its original worker (PostgreSQL)",
  { ...requiresPostgres, timeout: 90_000 },
  async (t) => {
    const backendId = "restart-github";
    const f = await staticEgressFixture(t, {
      admitRevision: false,
      requestCredentials: true,
      appFactory: (context, options, database) =>
        postgresApp(
          context,
          {
            ...options,
            backends: [
              {
                id: backendId,
                type: "github",
                configuration: { registryPath: "/unused/restart-registry.json" },
                drivers: { repo: backendId },
              },
            ],
          },
          database,
        ),
    });
    assert.ok("credentialProxy" in f);
    const controller: OpenClawController = f.controller;
    const registry = validateGitHubRepositoryRegistry(
      {
        version: 1,
        backendId,
        providerInstanceId: "restart-fixture",
        appId: "123",
        githubInstallationId: "456",
        maximumDurationSeconds: 600,
        repositories: [
          {
            repositoryRef: "selected",
            repositoryId: "789",
            repository: "example/selected",
            namespaces: [
              {
                namespaceId: f.namespace.id,
                profiles: ["github-repository"],
                permissions: { metadata: "read", contents: "write" },
              },
            ],
          },
        ],
      },
      backendId,
    );
    const repo = new GitHubRepositoryPolicy({ driverId: backendId, backendId }, registry, {
      sessionDurationSeconds: 600,
    });
    controller.registerDriver(repo);
    controller.selectDriver(repo.capability, repo.id);
    const git = new OpenShellGitRuntime(
      {
        registrationName: "git-fixture",
        authority: {
          host: "127.0.0.1",
          port: 8445,
          certificatePath: "/unused/restart-certificate",
          privateKeyPath: "/unused/restart-key",
          issuerPublicKeyPath: "/unused/restart-issuer",
          issuer: "https://gateway.example.test",
          audience: "git-fixture",
          keyId: "fixture",
        },
      },
      createGitHubRepositoryDeliveryResolver(registry),
    );
    t.after(() => git.close());
    const access = openShellRepositoryAccess(git, () => undefined);
    Object.assign(f.sandboxDriver, { repositoryAccess: access });
    const compute = controller.selectedDriver("compute");
    const placement = createTestKubernetesComputeDriver(compute.id, {
      gatewayRuntime: true,
      sandboxDriver: f.sandboxDriver,
    });
    Object.assign(compute, {
      validateRepositoryCredentials: placement.validateRepositoryCredentials.bind(placement),
    });
    const sourceControl = f.credentialProxy.sourceControl;
    // Model registration is observed over the Gateway RPC fixture. Supply
    // the Git sender's separate capability observation at its Driver boundary.
    const selected: CredentialProxyDriver["sourceControl"] = {
      ...sourceControl,
      async assertAvailable(signal, profile) {
        if (profile === "github_repository") {
          signal.throwIfAborted();
          return { profile, authorization: "online-request" };
        }
        return sourceControl.assertAvailable(signal, profile);
      },
    };
    Object.assign(f.credentialProxy, { sourceControl: selected });

    const agentPath = `/namespaces/${f.namespace.id}/agents/${f.agent.id}`;
    const binding = { repositoryRef: "selected", profile: "github-repository" };
    const saved = await f.request("PATCH", agentPath, {
      body: { configurationId: f.agent.configurationId, repositoryBindings: [binding] },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const deployed = await f.request("POST", `${agentPath}/deploy`);
    assert.equal(deployed.status, 202, JSON.stringify(deployed.body));
    const revision = await controller.transact((unit) =>
      unit.revisions.findRevision(f.namespace.id, f.agent.id, deployed.data.id),
    );
    assert.ok(revision?.egressPlan);
    assert.deepEqual(revision.executionAdmission, { mode: "protected", version: 9 });
    assert.equal(revision.egressPlan.authorization, "online-request");
    assert.equal(revision.egressPlan.routes.length, 1);
    assert.equal(revision.egressPlan.repositoryGitAuthorization, "online-request");
    assert.deepEqual(revision.egressPlan.repositoryGit, revision.repositoryCredentials);
    assert.equal(revision.repositoryCredentials?.bindings[0]?.repositoryRef, binding.repositoryRef);
    assert.equal(
      await git.repositoryWorkerRestartDisposition(revision, t.signal),
      "original-worker-required",
    );
  },
);

test(
  "model request installation survives a material epoch change but fences policy and recipient drift",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const f = await staticEgressFixture(t, {
      admitRevision: false,
      requestCredentials: true,
      appFactory: postgresApp,
    });
    assert.ok("credentialProxy" in f);
    const controller: OpenClawController = f.controller;
    const metadata = await f.deployAgent(f.namespace.id, f.agent.id);
    const revision = await controller.transact((unit) =>
      unit.revisions.findRevision(f.namespace.id, f.agent.id, metadata.id),
    );
    assert.ok(revision?.egressPlan);
    const context = {
      namespace: f.runtimeNamespace,
      revision,
      plan: revision.egressPlan,
      signal: t.signal,
    };
    const prepared = await f.credentialProxy.configureRevision(context);
    assert.equal(f.egressOptions.authorityScope, "execution");
    const egressOptions = { ...f.egressOptions, authorityScope: "execution" as const };
    const expected = openShellModelRequestPolicy(context.plan, egressOptions, revision);
    assert.ok(expected);
    const numericOrigin = {
      ...context.plan,
      routes: context.plan.routes.map((route, index) =>
        index === 0 ? { ...route, origin: "https://192.0.2.1" } : route,
      ),
    };
    assert.throws(
      () => openShellModelRequestPolicy(numericOrigin, egressOptions, revision),
      /HTTPS DNS origin/,
      "numeric destinations fail during policy selection instead of producing an unusable route",
    );
    const ref = f.sandboxDriver.harnessResource(context);
    const workspace = f.runtimeNamespace.name;
    await f.gatewayClient.importProviderProfile(
      workspace,
      { ...expected.provider.profile, annotations: {} },
      t.signal,
    );
    await f.gatewayClient.createProvider(
      {
        workspace,
        name: expected.provider.name,
        type: expected.provider.profile.id,
        credentials: {},
        config: {},
        labels: {
          "app.kubernetes.io/managed-by": "openclaw-enterprise",
          "openclaw.dev/namespace-id": revision.namespaceId,
          "openclaw.dev/agent-id": revision.agentId,
          "openclaw.dev/revision-id": revision.id,
        },
      },
      t.signal,
    );
    // These are controlled Gateway protocol observations. The real Driver qualifies
    // them; this case does not claim installed supervisor or Git renewal execution.
    const sandboxObservation = {
      id: "model-sandbox",
      name: ref.resourceName,
      workspace,
      annotations: {
        "openclaw.dev/namespace-id": revision.namespaceId,
        "openclaw.dev/agent-id": revision.agentId,
        "openclaw.dev/revision-id": revision.id,
      },
    };
    const sandboxSpec = {
      providers: [
        expected.provider.name,
        "oce-runtime-" + createHash("sha256").update(revision.id).digest("hex").slice(0, 16),
      ],
    };
    const materialEpoch: { provider_env_revision?: string } = { provider_env_revision: "10" };
    const admission = {
      ...materialEpoch,
      instance_id: "configuration-instance",
      state: 2,
      policy_version: 1,
      policy_hash: "a".repeat(64),
      config_revision: "7",
    };
    const sandboxStatus = {
      configuration_activated: true,
      configuration_admission: admission,
      main_process_instance_id: "process-instance",
    };
    const rule = "_provider_" + expected.provider.name.replaceAll("-", "_");
    const networkPolicies = prepared.configuration.network_policies;
    assert.ok(networkPolicies && typeof networkPolicies === "object");
    const policy: Record<string, unknown> = {
      ...structuredClone(prepared.configuration),
      network_policies: {
        ...networkPolicies,
        [rule]: {
          name: rule,
          binaries: expected.provider.profile.binaries.map((path) => ({ path })),
          endpoints: expected.provider.profile.endpoints.map((endpoint) => ({
            ...openShellProfileEndpoint(endpoint),
            provider_credentialed: true,
            token_grant_owner: "grant-owner:v1:" + "1".repeat(64),
          })),
        },
      },
    };
    const config = {
      ...materialEpoch,
      workspace,
      version: 1,
      policy_hash: admission.policy_hash,
      config_revision: "7",
      configuration_instance_id: admission.instance_id,
      configuration_admitted: true,
      provider_attachment_epoch: "original-attachment",
      policy_source: 1,
      policy_validation_failure_mode: "fail_closed",
      extension_authentication_enabled: true,
      supervisor_middleware_services: [
        {
          name: "oce-authority",
          audience: "oce-authority",
          grpc_endpoint: expected.registration.grpcEndpoint,
          binding_policy: 2,
          bindings: [1],
        },
      ],
      policy,
    };
    Object.assign(f.observed, {
      sandbox: sandboxObservation,
      sandboxSpec,
      sandboxStatus,
      policy: prepared.configuration,
      policyHash: admission.policy_hash,
      config,
    });
    // Contradictory or absent initial versions must never become the saved witness.
    admission.policy_version = 2;
    assert.equal(await f.credentialProxy.wiringStatus(context, prepared), undefined);
    Reflect.deleteProperty(admission, "policy_version");
    assert.equal(await f.credentialProxy.wiringStatus(context, prepared), undefined);
    admission.policy_version = 1;
    const [registration] = config.supervisor_middleware_services;
    assert.ok(registration);
    const trustedEndpoint = registration.grpc_endpoint;
    registration.grpc_endpoint = "https://unrelated-authority.example.test:9444";
    await assert.rejects(
      f.credentialProxy.wiringStatus(context, prepared),
      /required authenticated model request middleware/,
    );
    registration.grpc_endpoint = trustedEndpoint;
    const installation = await f.credentialProxy.wiringStatus(context, prepared);
    assert.ok(installation, "the Driver must first qualify the observed installation");
    const requestCredentials = f.credentialProxy.requestTimeCredentials;
    assert.ok(requestCredentials);
    const verify = () =>
      requestCredentials.verifyRequestInstallation(context, installation, {
        id: installation.sandboxId,
        context: workspace,
      });
    assert.equal(await verify(), true);
    registration.grpc_endpoint = "https://unrelated-authority.example.test:9444";
    await assert.rejects(verify(), /required authenticated model request middleware/);
    registration.grpc_endpoint = trustedEndpoint;
    // Protobuf maps have no stable wire order. Repeated real-client decodes must
    // preserve the installation when only the order of the provider labels changes.
    const provider = f.providers.get(expected.provider.name);
    provider.metadata.labels = Object.fromEntries(
      Object.entries(provider.metadata.labels).reverse(),
    );
    assert.equal(await verify(), true, "label order does not change the model recipient");
    provider.metadata.labels["openclaw.dev/agent-id"] = "another-agent";
    assert.equal(await verify(), false, "a different label value still invalidates ownership");
    provider.metadata.labels["openclaw.dev/agent-id"] = revision.agentId;
    // A provider material refresh advances both observations without replacing the
    // process, admitted policy or model profile. Its old epoch is not a policy fence.
    admission.provider_env_revision = "11";
    config.provider_env_revision = "11";
    assert.equal(
      await verify(),
      true,
      "a completed material refresh preserves model authorization",
    );

    // The stock uint64 fingerprint has no reserved zero. Proto3 omits that scalar,
    // so two canonical zero observations remain a valid acknowledged epoch.
    delete admission.provider_env_revision;
    delete config.provider_env_revision;
    assert.equal(await verify(), true, "canonical proto3 zero remains a valid material epoch");
    admission.provider_env_revision = "11";
    config.provider_env_revision = "12";
    assert.equal(await verify(), false, "an unacknowledged material epoch still fails closed");
    config.provider_env_revision = "11";
    config.provider_attachment_epoch = "replacement-attachment";
    assert.equal(await verify(), false);
    config.provider_attachment_epoch = "original-attachment";
    sandboxStatus.main_process_instance_id = "replacement-process";
    assert.equal(await verify(), false);
    sandboxStatus.main_process_instance_id = "process-instance";
    admission.instance_id = config.configuration_instance_id = "replacement-configuration";
    assert.equal(await verify(), false);
    admission.instance_id = config.configuration_instance_id = "configuration-instance";
    admission.policy_hash = config.policy_hash = "b".repeat(64);
    assert.equal(await verify(), false);
    admission.policy_hash = config.policy_hash = "a".repeat(64);
    config.policy.filesystem = { read_write: ["/"] };
    assert.equal(await verify(), false, "effective policy content remains fenced");
    delete config.policy.filesystem;
    const profile = f.profiles.get(expected.provider.profile.id);
    profile.credentials[0].token_grant.audience = "different-binding";
    await assert.rejects(verify, /zero-cache model token grant/);
  },
);

test(
  "online Responses source refuses unsupported Harness before revision or external effects (PostgreSQL)",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const f = await staticEgressFixture(t, {
      admitRevision: false,
      requestCredentials: true,
      sandboxUserNamespaces: false,
      offerStrictCapabilities: true,
      appFactory: postgresApp,
    });
    const controller: OpenClawController = f.controller;
    const root = `/namespaces/${f.namespace.id}`;
    const configuration = await f.createConfiguration(f.namespace.id, {
      agents: {
        defaults: {
          model: { primary: "openai/fixture-model" },
          models: { "openai/fixture-model": { agentRuntime: { id: "openclaw" } } },
        },
      },
    });
    const create = async (name: string, protectedSource: boolean) => {
      const result = await f.request("POST", `${root}/agents`, {
        body: {
          name,
          configurationId: configuration.id,
          executionMode: "dedicated",
          ...(protectedSource
            ? {
                harnessAuth: { method: "credential_source", sourceId: f.source.id },
                credentialSources: [{ sourceId: f.source.id }],
              }
            : { harnessAuth: { method: "runtime" } }),
        },
      });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      if (protectedSource) {
        const grant = await f.request("POST", `${root}/iam/access-bindings`, {
          body: {
            subjectKind: "identity",
            subjectId: result.data.servicePrincipalId,
            roleId: f.grant.roleId,
            resourceKind: "credential_source",
            resourceId: f.source.id,
          },
        });
        assert.equal(grant.status, 201, JSON.stringify(grant.body));
      }
      return result.data;
    };
    const unsupported = await create("unsupported-openclaw", true);
    const ordinary = await create("ordinary-openclaw", false);
    const effects = {
      secret: f.countSecretReads(),
      gateway: f.gatewayRequests.length,
      provider: f.providerRequests.length,
    };
    const rejected = await f.request("POST", `${root}/agents/${unsupported.id}/deploy`);
    assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
    assert.match(rejected.body.error.message, /dedicated Codex.*Responses/i);
    assert.deepEqual(
      await controller.transact((unit) =>
        unit.revisions.listRevisions(f.namespace.id, unsupported.id),
      ),
      [],
    );
    assert.deepEqual(
      {
        secret: f.countSecretReads(),
        gateway: f.gatewayRequests.length,
        provider: f.providerRequests.length,
      },
      effects,
      "refusal must precede Secret reads, Proxy registration checks and provider traffic",
    );

    // The restriction is specific to the online source, not to OpenClaw or Codex generally.
    const healthy = await f.request("POST", `${root}/agents/${ordinary.id}/deploy`);
    assert.equal(healthy.status, 202, JSON.stringify(healthy.body));
    const codex = await f.request("POST", `${root}/agents/${f.agent.id}/deploy`);
    assert.equal(codex.status, 202, JSON.stringify(codex.body));
  },
);
