import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer, request } from "node:https";
import { createServer as portReservation } from "node:net";
import { buffer } from "node:stream/consumers";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpenShellJointGitIssuer } from "../../apps/controller/src/drivers/credential-gateway/openshell-joint-git-issuer.ts";
import { openShellOnlineGitWire } from "./openshell-online-git-wire.mjs";
import { invoke, token } from "./openshell-online-wire.mjs";
import { startGitSmartHttpFixture } from "../fixtures/repository-credentials/git.mjs";
import {
  cleanEnvironment,
  createTlsMaterial,
  listen,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";

export function exchange(url, ca, method, headers, body) {
  return new Promise((ok, bad) =>
    request(
      url,
      {
        method,
        ca,
        servername: "localhost",
        agent: false,
        headers,
        signal: AbortSignal.timeout(5000),
      },
      async (res) => {
        try {
          ok({ status: res.statusCode, bytes: await buffer(res), headers: res.headers });
        } catch (e) {
          bad(e);
        }
      },
    )
      .on("error", bad)
      .end(body),
  );
}
export async function freePort() {
  const reservation = portReservation();
  await new Promise((ok) => reservation.listen(0, "127.0.0.1", ok));
  const port = reservation.address().port;
  await new Promise((ok) => reservation.close(ok));
  return port;
}
export function redeem(endpoint, tls, id, host, assertion, extra = {}) {
  const form = new URLSearchParams({
    client_assertion: assertion,
    grant_type: "client_credentials",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    audience: "https://" + host,
  });
  return exchange(
    endpoint,
    tls.ca,
    "POST",
    { "content-type": "application/x-www-form-urlencoded", "x-openshell-request-id": id, ...extra },
    form.toString(),
  );
}

export async function exerciseGitTokenGrant(
  t,
  { f, binding, installation, authorize, read, current, withdraw },
) {
  const tls = await createTlsMaterial(t);
  const dir = await temporaryDirectory(t);
  const endpoint = "https://127.0.0.1:" + (await freePort()) + "/token/git";
  const keys = generateKeyPairSync("ed25519");
  const bundlePath = join(dir, "bundle.json");
  const bundle = {
    keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "current", use: "jwt-svid" }],
  };
  await writeFile(bundlePath, JSON.stringify(bundle));
  const prefix = "spiffe://test.example/sandbox/";
  const issuer = new OpenShellJointGitIssuer(endpoint, {
    bundlePath,
    subjectPrefix: prefix,
    algorithm: "EdDSA",
  });
  const receiver = await issuer.listen("127.0.0.1", tls);
  t.after(() => {
    receiver.closeAllConnections();
    receiver.close();
  });
  const { sandboxId, plan } = installation;
  const podUid = randomUUID();
  const lifetime = new AbortController();
  let reads = 0;
  let pauseRead;
  const svid = (pod = podUid) => {
    const enc = (x) => Buffer.from(JSON.stringify(x)).toString("base64url");
    const msg =
      enc({ alg: "EdDSA", kid: "current" }) +
      "." +
      enc({
        aud: endpoint,
        sub: prefix + sandboxId + "/pod/" + pod,
        exp: Math.floor(Date.now() / 1000) + 90,
      });
    return msg + "." + sign(null, Buffer.from(msg), keys.privateKey).toString("base64url");
  };
  const wire = await openShellOnlineGitWire(t, {
    registrationName: "joint-git",
    budgetMs: 3000,
    lookupBinding: async (identity) => ({ ...binding, ...identity }),
    authorizeOnlineRequest: (q, _installed, signal) => authorize(q, signal),
    permit: async (identity, host, _bound, until) =>
      issuer.permit({
        ...identity,
        podUid,
        host,
        until,
        lifetime: lifetime.signal,
        current: async (signal) => !lifetime.signal.aborted && (await current(signal)),
        read: async (signal) => {
          reads++;
          const result = await read(signal);
          if (pauseRead) {
            await pauseRead();
          }
          return result && "value" in result ? result : undefined;
        },
      }),
  });
  const signed = async (host, method, target, body, contentType, id = randomUUID()) => {
    const url = new URL("https://" + host + target);
    const result = await invoke(
      wire.client,
      "EvaluateHttpRequest",
      {
        phase: 1,
        middleware_name: "joint-git",
        context: { workspace: "workspace", request_id: id, sandbox_id: sandboxId },
        config: { fields: { binding_id: { stringValue: plan.execution.executionId } } },
        target: {
          scheme: "https",
          port: 443,
          host,
          method,
          path: url.pathname,
          query: url.search.slice(1),
        },
        ...(body?.length && { body }),
        headers: contentType ? [{ name: "content-type", value: contentType }] : [],
      },
      token(wire.keys, "supervisor", sandboxId),
    );
    return { decision: result.decision, id, reason: result.reason_code };
  };
  const origin = await startGitSmartHttpFixture(t, {
    tls,
    authorize: (authorization) =>
      authorization?.startsWith("Basic ") && f.gh.authorize(authorization, "git"),
  });
  const probe = await signed("api.github.com", "GET", "/repos/fixture/repository");
  assert.equal(probe.decision, 1, probe.reason);
  for (const [id, host, assertion, headers] of [
    [probe.id, "github.com", svid(), {}],
    [probe.id, "api.github.com", svid(randomUUID()), {}],
    [randomUUID(), "api.github.com", svid(), {}],
    [probe.id, "api.github.com", svid(), { host: "wrong.invalid" }],
  ]) {
    assert.equal((await redeem(endpoint, tls, id, host, assertion, headers)).status, 403);
  }
  assert.equal(reads, 0);
  const app = await redeem(endpoint, tls, probe.id, "api.github.com", svid());
  assert.equal(app.status, 200);
  assert.equal(app.headers["cache-control"], "no-store");
  const api = await exchange(f.gh.origin + "/repos/fixture/repository", tls.ca, "GET", {
    authorization: "Bearer " + JSON.parse(app.bytes).access_token,
  });
  assert.equal(api.status, 200);
  assert.equal((await redeem(endpoint, tls, probe.id, "api.github.com", svid())).status, 403);
  assert.equal(reads, 1);
  assert.equal(
    (
      await signed(
        "api.github.com",
        "GET",
        "/repos/fixture/repository",
        undefined,
        undefined,
        probe.id,
      )
    ).decision,
    2,
  );

  const proxy = createServer(tls, async (req, res) => {
    try {
      assert.equal(req.headers.authorization, undefined);
      const body = await buffer(req);
      const host = "github.com";
      const decision = await signed(host, req.method, req.url, body, req.headers["content-type"]);
      if (decision.decision !== 1) {
        res.writeHead(403).end();
        return;
      }
      const release = await redeem(endpoint, tls, decision.id, host, svid());
      if (release.status !== 200) {
        res.writeHead(403).end();
        return;
      }
      const headers = {
        authorization: "Basic " + JSON.parse(release.bytes).access_token,
        ...(body.length && {
          "content-length": body.length,
          "content-type": req.headers["content-type"],
        }),
      };
      const sent = await exchange(origin.origin + req.url, tls.ca, req.method, headers, body);
      res.writeHead(sent.status, { "content-type": sent.headers["content-type"] }).end(sent.bytes);
    } catch {
      res.writeHead(500).end();
    }
  });
  const ingress = await listen(t, proxy);
  const cwd = await temporaryDirectory(t);
  const env = cleanEnvironment({ GIT_SSL_CAINFO: tls.certFile });
  await run("git", ["init", "-q", cwd], { env });
  const oid = await origin.addCommit();
  assert.notEqual(
    (await run("git", ["cat-file", "-e", oid], { cwd, env, allowFailure: true })).code,
    0,
  );
  await run("git", ["fetch", "--quiet", ingress + "/fixture/repository.git", "main"], { cwd, env });
  assert.equal((await run("git", ["rev-parse", "FETCH_HEAD"], { cwd, env })).stdout.trim(), oid);
  assert.ok(origin.trace.some((q) => q.path.endsWith("git-upload-pack")));
  const before = origin.traffic();
  const count = reads;
  const forged = await signed("api.github.com", "POST", "/app/installations/41/access_tokens");
  assert.equal(forged.decision, 2);
  assert.equal(reads, count);
  const held = await signed("api.github.com", "GET", "/repos/fixture/repository");
  assert.equal(held.decision, 1);
  const entered = Promise.withResolvers();
  const finished = Promise.withResolvers();
  pauseRead = async () => {
    entered.resolve();
    await finished.promise;
  };
  const replacing = redeem(endpoint, tls, held.id, "api.github.com", svid());
  await entered.promise;
  await writeFile(bundlePath, '{"keys":[]}');
  finished.resolve();
  assert.equal((await replacing).status, 403);
  await writeFile(bundlePath, JSON.stringify(bundle));
  pauseRead = undefined;
  assert.equal((await redeem(endpoint, tls, held.id, "api.github.com", svid())).status, 403);
  const pre = await signed("api.github.com", "GET", "/repos/fixture/repository");
  assert.equal(pre.decision, 1);
  const readsAtWithdrawal = reads;
  await withdraw();
  const revoked = await redeem(endpoint, tls, pre.id, "api.github.com", svid());
  assert.equal(revoked.status, 403);
  assert.equal(reads, readsAtWithdrawal);
  lifetime.abort();
  assert.equal((await signed("api.github.com", "GET", "/repos/fixture/repository")).decision, 2);
  assert.deepEqual(origin.traffic(), before);
  const receipt = await f.pool.query(
    "SELECT count(*)::int n FROM occ.prepared_repository_git_uses WHERE exchange_id=$1",
    [probe.id],
  );
  assert.equal(receipt.rows[0].n, 1);
}
