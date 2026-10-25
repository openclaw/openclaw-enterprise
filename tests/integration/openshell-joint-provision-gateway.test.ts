import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { OpenShellJointGitIssuer } from "../../apps/controller/src/drivers/credential-gateway/openshell-joint-git-issuer.ts";
import type { OpenShellGitRouteStore } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts";
import { availablePort } from "../helpers/available-port.mjs";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
import { JointGitSupervisorPods } from "../../apps/controller/src/drivers/egress-proxy/openshell-joint-git-provision.ts";
import { jointWorker } from "../helpers/openshell-joint-worker.ts";
import { routeStore } from "../fixtures/openshell-git-route-store.mjs";

test("joint provisioning binds both uncached token grants and refuses replaced Gateway identities", async (t) => {
  const { runtime, peer, provision, binding, endpoint, pod } = await jointWorker(t);
  const captures: unknown[] = [];
  const store = routeStore();
  const recordJoint: NonNullable<OpenShellGitRouteStore["recordJoint"]> = async (
    entry,
    observation,
  ) => {
    assert.equal(await store.owns(entry.revisionId, 1), true);
    captures.push(observation);
    return true;
  };
  const noMaterial = async (): Promise<never> =>
    assert.fail("provisioning must never access credential material");
  await runtime.start(
    { readOpenShellMaterial: noMaterial, authorizeOnlineRequest: noMaterial },
    undefined,
    Object.assign(store, { recordJoint }) as unknown as OpenShellGitRouteStore,
  );

  const result = await provision();
  const wiring = result.proxyWiring;
  assert.ok(wiring && "jointGit" in wiring, "caller receives both observed recipients");
  const spec = peer.sandbox!.spec;
  assert.equal(spec.restart_policy, "SANDBOX_RESTART_POLICY_NEVER");
  const [runtimeName, ...names] = spec.providers;
  assert.equal(names.length, 2);
  assert.equal(peer.profiles.get(peer.providers.get(runtimeName!)!.type)!.credentials, undefined);
  const legs = names.map((providerName, i) => {
    const host = ["github.com", "api.github.com"][i]!;
    const provider = peer.providers.get(providerName)!;
    const label = provider.metadata.labels["openclaw.dev/joint-git-recipient"]!;
    assert.match(label, /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/);
    const profile = peer.profiles.get(provider.type)!;
    assert.deepEqual(
      profile.endpoints?.map((e) => [e.host, e.port, e.path]),
      [[host, 443, "/**"]],
    );
    const credential = profile.credentials![0]!;
    assert.equal(credential.auth_style, i === 0 ? "basic" : "bearer-required");
    assert.deepEqual(credential.token_grant, {
      token_endpoint: endpoint,
      audience: "https://" + host,
      jwt_svid_audience: endpoint,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      grant_type: "PROVIDER_CREDENTIAL_TOKEN_GRANT_TYPE_CLIENT_CREDENTIALS",
      cache_ttl: { seconds: "0", nanos: 0 },
    });
    return {
      host,
      providerName,
      providerId: provider.metadata.id,
      attachmentEpoch: peer.epoch,
    };
  });
  assert.notEqual(legs[0]!.providerId, legs[1]!.providerId);
  const id = binding.grant.grantId;
  const observed = {
    grant: { id, generation: "7", scope: id.split(":").at(-1) },
    runtimeProvider: runtimeName,
    recipients: legs,
  };
  assert.deepEqual(wiring.jointGit, observed);
  assert.equal(captures.length, 2, "desired then observed, never release");
  assert.equal(captures[0], undefined);
  const reconciled = await provision();
  assert.deepEqual(reconciled.proxyWiring, wiring, "same live execution remains adoptable");

  await t.test("Git approval requires the supplier's current execution admission", () => {
    assert.equal(
      spec.policy.network_middlewares["oce-prepared-git"]?.require_execution_admission,
      true,
    );
  });
  await t.test("a joint execution cannot adopt a restartable Sandbox", async () => {
    const never = spec.restart_policy;
    spec.restart_policy = "SANDBOX_RESTART_POLICY_ALWAYS";
    try {
      await assert.rejects(provision(), /joint|execution|agentrevision|restart/i);
    } finally {
      spec.restart_policy = never;
    }
  });
  const [git, api] = names.map((name) => peer.providers.get(name)!);
  git!.metadata.id = legs[1]!.providerId;
  api!.metadata.id = legs[0]!.providerId;
  await assert.rejects(provision(), /joint git recipient is not current/i, "swapped provider IDs");
  git!.metadata.id = legs[0]!.providerId;
  api!.metadata.id = legs[1]!.providerId;
  const key = "openclaw.dev/joint-git-recipient";
  const originalLabel = git!.metadata.labels[key]!;
  git!.metadata.labels[key] = api!.metadata.labels[key]!;
  await assert.rejects(provision(), /joint git recipient is not current/i, "wrong owner label");
  git!.metadata.labels[key] = originalLabel;
  const grant = peer.profiles.get(api!.type)!.credentials![0]!.token_grant;
  delete grant.cache_ttl;
  await assert.rejects(
    provision(),
    /joint git recipient is not current/i,
    "absent TTL permits caching",
  );
  grant.cache_ttl = { seconds: "0", nanos: 0 };
  const originalUid = pod.uid;
  pod.uid = randomUUID();
  await assert.rejects(
    provision(),
    /joint git supervisor is not current/i,
    "same Sandbox, replaced supervisor Pod",
  );
  pod.uid = originalUid;
  peer.replaceEpoch();
  await assert.rejects(
    provision(),
    /joint git execution changed/i,
    "same sandbox ID, new attachment epoch",
  );
  peer.replaceSandbox();
  await assert.rejects(
    provision(),
    /execution is no longer present/i,
    "same sandbox name, new UID",
  );
  assert.equal(captures.length, 2, "no second observation replaced the first");
});

test("joint token issuer releases each approved destination once to its enrolled supervisor", async (t) => {
  const tls = await harnessTlsFixture(t);
  const port = await availablePort();
  const endpoint = "https://localhost:" + port + "/token/git";
  const prefix = "spiffe://fixture.test/supervisors/";
  const box = randomUUID();
  const pod = randomUUID();
  const bundlePath = join(tls.directory, "issuer-test.jwks");
  const key = generateKeyPairSync("ed25519");
  await writeFile(
    bundlePath,
    JSON.stringify({
      keys: [
        { ...key.publicKey.export({ format: "jwk" }), alg: "EdDSA", kid: "test", use: "jwt-svid" },
      ],
    }),
  );
  const issuer = new OpenShellJointGitIssuer(endpoint, {
    bundlePath,
    subjectPrefix: prefix,
    algorithm: "EdDSA",
  });
  const server = await issuer.listen("127.0.0.1", { key: tls.key, cert: tls.cert });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const svid = (uid: string) => {
    const encode = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const claims =
      encode({ kid: "test", alg: "EdDSA" }) +
      "." +
      encode({
        sub: prefix + box + "/pod/" + uid,
        aud: [endpoint],
        exp: Math.floor(Date.now() / 1000) + 120,
      });
    return claims + "." + sign(null, Buffer.from(claims), key.privateKey).toString("base64url");
  };
  const request = (id: string, host: string, assertion: string) =>
    new Promise<{ status: number; data: Record<string, string> }>((ok, bad) => {
      const client = httpsRequest(
        {
          hostname: "127.0.0.1",
          servername: "localhost",
          port,
          path: "/token/git",
          method: "POST",
          ca: tls.caBundle,
          headers: {
            host: "localhost:" + port,
            "x-openshell-request-id": id,
            "content-type": "application/x-www-form-urlencoded",
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (b) => chunks.push(b));
          res.on("end", () =>
            ok({ status: res.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString()) }),
          );
        },
      );
      client.once("error", bad);
      client.end(
        new URLSearchParams({
          grant_type: "client_credentials",
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: assertion,
          audience: "https://" + host,
        }).toString(),
      );
    });
  const token = "synthetic-" + randomUUID();
  let reads = 0;
  let current = true;
  for (const host of ["github.com", "api.github.com"] as const) {
    const requestId = randomUUID();
    const until = Date.now() + 25_000;
    assert.equal(
      issuer.permit({
        sandboxName: "sandbox-test",
        sandboxId: box,
        podUid: pod,
        requestId,
        host,
        until,
        lifetime: t.signal,
        async current() {
          return current;
        },
        async read() {
          reads++;
          return {
            value: token,
            expiresAt: new Date(until).toISOString(),
            scope: "github-installation",
            installationId: "12",
            apiOrigin: "https://api.github.com",
            sessionId: "fixture",
            grantId: "fixture",
            providerInstanceId: "fixture",
            materialVersion: randomUUID(),
            preparationAttemptId: randomUUID(),
          };
        },
      }),
      true,
    );
    const before = reads;
    assert.equal((await request(randomUUID(), host, svid(pod))).status, 403);
    assert.equal((await request(requestId, host, svid(randomUUID()))).status, 403);
    assert.equal(
      (await request(requestId, host === "github.com" ? "api.github.com" : "github.com", svid(pod)))
        .status,
      403,
    );
    current = false;
    assert.equal((await request(requestId, host, svid(pod))).status, 403);
    current = true;
    assert.equal(reads, before);
    const response = await request(requestId, host, svid(pod));
    assert.equal(response.status, 200);
    assert.equal(
      response.data.access_token,
      host === "github.com" ? Buffer.from("x-access-token:" + token).toString("base64") : token,
    );
    assert.equal((await request(requestId, host, svid(pod))).status, 403);
    assert.equal(reads, before + 1);
  }
});

test("one Sandbox's obsolete Pod read cannot revoke another Sandbox or its newly observed supervisor", async (t) => {
  const pods = new JointGitSupervisorPods();
  const read = (namespace: string, box: string, uid?: string) =>
    pods.read(namespace, box, async () => uid, t.signal);
  const a = await read("team", "first", "pod-a");
  const sibling = await read("team", "second", "sibling");
  const otherNamespace = await read("other", "first", "other-pod");
  assert.ok(a && sibling && otherNamespace);
  let release!: (uid: string) => void;
  const late = pods.read(
    "team",
    "first",
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    t.signal,
  );
  const b = await read("team", "first", "pod-b");
  assert.ok(b);
  assert.equal(a.lifetime.aborted, true);
  release("pod-a");
  assert.equal(await late, undefined);
  assert.equal(b.lifetime.aborted, false);
  const confirmed = await read("team", "first", "pod-b");
  assert.ok(confirmed && !confirmed.lifetime.aborted);
  await read("team", "first");
  assert.equal(b.lifetime.aborted, true, "a missing or unready Pod invalidates outstanding uses");
  const recovered = await read("team", "first", "pod-b");
  assert.ok(recovered && !recovered.lifetime.aborted);
  await assert.rejects(
    pods.read(
      "team",
      "first",
      async () => {
        throw new Error("unavailable");
      },
      t.signal,
    ),
    { message: "unavailable" },
  );
  assert.equal(recovered.lifetime.aborted, true);
  assert.equal(sibling.lifetime.aborted, false);
  assert.equal(otherNamespace.lifetime.aborted, false);
});
