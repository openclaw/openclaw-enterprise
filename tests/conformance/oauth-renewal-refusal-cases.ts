import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import test from "node:test";

import type { OAuthGrantStore } from "../../apps/controller/src/backends/token-service/oauth-connection.ts";
import type {
  OAuthConnectionClient,
  OAuthConnectionGrant,
  OAuthConnectionRegistration,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { listen } from "../helpers/listen.ts";
import type { createTestSecretDriver } from "../helpers/secret-driver.ts";

type TestSecretDriver = ReturnType<typeof createTestSecretDriver>;

interface RenewalRefusalFixtures {
  oauthCustody(): Promise<{
    driver: TestSecretDriver;
    custody: Awaited<ReturnType<OAuthGrantStore["reserve"]>>;
    service: OAuthGrantStore;
    worker: OAuthGrantStore;
  }>;
  connectionGrant(issuer: string): OAuthConnectionRegistration & OAuthConnectionGrant;
}

async function readRefreshForm(request: IncomingMessage): Promise<URLSearchParams> {
  const body: AsyncIterable<unknown, unknown, undefined> = request;
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    assert.ok(Buffer.isBuffer(chunk), "Expected raw issuer request bytes");
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export function registerOAuthRenewalRefusalCases({
  oauthCustody,
  connectionGrant,
}: RenewalRefusalFixtures): void {
  test("OAuth renewal retries cancellation before dispatch and quarantines a lost issuer reply", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T00:00:00Z") });
    const requests: URLSearchParams[] = [];
    const server = createServer(async (req) => {
      requests.push(await readRefreshForm(req));
      // The issuer received the grant, but the worker cannot know whether it rotated.
      req.socket.destroy();
    });
    const port = await listen(t, server);
    const grant = connectionGrant("http://127.0.0.1:" + port);
    const { driver, custody, service, worker } = await oauthCustody();
    const resolveClient = async (): Promise<OAuthConnectionClient> => ({
      registration: grant,
      readSecret: async () => assert.fail("public clients have no secret"),
    });
    await service.storeInitialGrant(custody, grant, t.signal);
    const accepted = (await service.observe(custody, t.signal, 0)).token;
    assert.ok(accepted);
    t.mock.timers.setTime(Date.parse(accepted.nextRefreshAt));
    const stop = new AbortController();
    const swap = driver.compareAndSwap.bind(driver);
    // The control plane cancels while the Secret Driver is committing the intent.
    t.mock.method(
      driver,
      "compareAndSwap",
      async (...args: Parameters<TestSecretDriver["compareAndSwap"]>) => {
        stop.abort(new Error("Worker stopped during the custody claim."));
        return swap(...args);
      },
      { times: 1 },
    );
    await assert.rejects(worker.renew(custody, stop.signal, resolveClient), {
      message: "Worker stopped during the custody claim.",
    });
    assert.equal(requests.length, 0);
    assert.deepEqual((await service.observe(custody, t.signal, 0)).token, accepted);

    const failed = await worker.renew(custody, t.signal, resolveClient);
    assert.equal(failed.failureCode, "refresh_outcome_unknown");
    assert.deepEqual(await service.renew(custody, t.signal, resolveClient), failed);
    assert.deepEqual(
      requests.map((body) => body.get("refresh_token")),
      [grant.refreshToken],
    );
  });

  test("client authentication can recover with the same grant and a repaired registration", async (t) => {
    const currentSecret = randomUUID();
    let storedSecret = randomUUID();
    let revoked = false;
    let requests = 0;
    const server = createServer(async (req, res) => {
      const form = await readRefreshForm(req);
      requests++;
      assert.equal(req.url, "/token");
      assert.equal(form.get("grant_type"), "refresh_token");
      assert.ok(form.get("refresh_token") === grant.refreshToken);
      assert.equal(form.get("client_id"), "test-client");
      assert.equal(req.headers.authorization, undefined);
      res.setHeader("Content-Type", "application/json");
      if (form.get("client_secret") !== currentSecret) {
        res.writeHead(401);
        res.end(
          JSON.stringify({ error: requests === 1 ? "invalid_client" : "unauthorized_client" }),
        );
      } else if (revoked) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid_grant" }));
      } else {
        res.writeHead(200);
        res.end(
          JSON.stringify({ access_token: randomUUID(), token_type: "Bearer", expires_in: 120 }),
        );
      }
    });
    const port = await listen(t, server);
    const grant: OAuthConnectionRegistration & OAuthConnectionGrant = {
      ...connectionGrant("http://127.0.0.1:" + port),
      tokenEndpointAuthMethod: "client_secret_post",
    };
    const { custody, driver, service, worker } = await oauthCustody();
    await service.storeInitialGrant(custody, grant, t.signal);
    const accepted = (await service.observe(custody, t.signal, 0)).token;
    assert.ok(accepted);
    const { version } = accepted;
    const readSecret = t.mock.fn(async () => storedSecret);
    const resolveClient = async (): Promise<OAuthConnectionClient> => ({
      registration: grant,
      readSecret,
    });
    // A registration store outage keeps the same upstream grant. Re-observing the old SQL due
    // version after interruption must recover the persisted retry without making another read.
    const unavailable = t.mock.fn(async () => {
      throw new Error("Registration credentials unavailable");
    });
    const down = await service.renew(
      custody,
      t.signal,
      async () => ({ registration: grant, readSecret: unavailable }),
      version,
    );
    assert.equal(down.failureCode, "client_unavailable");
    assert.equal(down.recoveryAction, "retry");
    assert.ok(down.schedule);
    assert.ok(Date.parse(down.schedule.nextRefreshAt) > Date.now());
    assert.notEqual(down.schedule.version, version);
    const previousDue = await worker.renew(
      custody,
      t.signal,
      async () => ({ registration: grant, readSecret: unavailable }),
      version,
    );
    assert.deepEqual(previousDue, down);
    assert.equal(unavailable.mock.callCount(), 1);
    assert.equal(requests, 0);
    // Source metadata, not private token custody, chooses the registered client and endpoint.
    const retryMaterial = driver.valueFor(custody.secret);
    assert.ok(retryMaterial);
    const record = asRecord(JSON.parse(retryMaterial));
    assert.ok(record);
    await driver.update(
      custody.secret,
      JSON.stringify({
        ...record,
        oauthClientId: "another-registration",
        tokenUrl: grant.tokenUrl + "/unapproved",
        resource: "https://unapproved.test",
      }),
    );
    const refused = await service.renew(custody, t.signal, resolveClient, down.schedule.version);
    assert.equal(refused.state, "failed");
    assert.equal(refused.failureCode, "client_refused");
    assert.equal(refused.recoveryAction, "fix_configuration");
    assert.ok(refused.schedule?.nextRefreshAt);
    assert.equal((await service.observe(custody, t.signal, 0)).token, undefined);
    const refusedAgain = await worker.renew(
      custody,
      t.signal,
      resolveClient,
      refused.schedule.version,
    );
    assert.equal(refusedAgain.failureCode, "client_refused");
    assert.equal(refusedAgain.recoveryAction, "fix_configuration");
    assert.ok(refusedAgain.schedule);
    storedSecret = currentSecret;
    assert.equal(
      (await worker.renew(custody, t.signal, resolveClient, refusedAgain.schedule.version)).state,
      "ready",
    );
    const renewedMaterial = driver.valueFor(custody.secret);
    assert.ok(renewedMaterial);
    assert.ok(!renewedMaterial.includes(currentSecret));
    // A definitive grant refusal is terminal, even with a working client credential.
    revoked = true;
    const renewed = (await worker.observe(custody, t.signal, 0)).token;
    assert.ok(renewed);
    const result = await worker.renew(custody, t.signal, resolveClient, renewed.version);
    assert.equal(result.failureCode, "grant_refused");
    assert.equal(result.recoveryAction, "reauthorize");
    assert.deepEqual(await service.renew(custody, t.signal, resolveClient, version), result);
    assert.equal(requests, 4);
  });
}
