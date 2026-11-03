import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { TLSSocket } from "node:tls";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import type {
  AttemptContext,
  CredentialRef,
  DriverCustody,
  RepositoryBackend,
  RepositoryBackendFactory,
} from "../../apps/controller/src/drivers/repo/credentials/backend-contracts.ts";
import type { GitHubStaticTokenOwner } from "../../apps/controller/src/drivers/repo/github/credentials/types.ts";
import { githubTokenConfigurationData } from "../fixtures/repository-credentials/builders.mjs";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import { createTlsMaterial, listen } from "../fixtures/repository-credentials/process.mjs";
import { createTestResourceScope } from "../fixtures/repository-credentials/resources.mjs";
import { appModule } from "../fixtures/repository-credentials/runtime.mjs";
import {
  createLoopbackServiceConfiguration,
  gatewayRequest,
} from "../fixtures/repository-credentials/service.mjs";
import {
  createGitHubTokenServiceFactory,
  startServiceListeners,
} from "../fixtures/repository-credentials/service-resources.mjs";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

test("an owned exchange keeps its original lease through replacement and an injected standing callback fences the first write", async (t) => {
  const resources = createTestResourceScope(t);
  const clock = createControlledClock();
  const config = await createLoopbackServiceConfiguration(resources, { credentialMarginMs: 100 });
  const tls = await createTlsMaterial(resources);
  const tokens = [`github_pat_${"a".repeat(36)}`, `github_pat_${"b".repeat(36)}`];
  const expected = tokens.map((token) => digest(`Bearer ${token}`));
  const observed: string[] = [];
  const replacementEntered = Promise.withResolvers<void>();
  const releaseReplacement = Promise.withResolvers<void>();
  resources.after(() => releaseReplacement.resolve());
  const origin = await listen(
    resources,
    createServer(tls, async (request, response) => {
      const authorization = digest(request.headers.authorization ?? "");
      observed.push(authorization);
      if (authorization === expected[1]) {
        replacementEntered.resolve();
        await releaseReplacement.promise;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: 73, full_name: "fixture/repository" }));
    }),
  );
  const [{ createGitHubDriverFactory }, { createGitHubStaticTokenOwner }] = await Promise.all([
    appModule("drivers/repo/github/credentials/factory"),
    appModule("drivers/repo/github/credentials/static-token"),
  ]);
  const owners: GitHubStaticTokenOwner[] = tokens.map((token) =>
    createGitHubStaticTokenOwner({ token: Buffer.from(token) }),
  );
  resources.after(() => owners.forEach((owner) => owner.close()));
  let selected = owners[0]!;
  const authority: GitHubStaticTokenOwner = {
    kind: "github-token",
    tokenClass: selected.tokenClass,
    withToken: (consume) => selected.withToken(consume),
    close: () => owners.forEach((owner) => owner.close()),
  };
  const realFactory: RepositoryBackendFactory = createGitHubDriverFactory({
    configuration: githubTokenConfigurationData({ leaseSeconds: 900 }),
    authority,
    gatewayOrigin: config.gateway.publicOrigin,
    limits: config.limits,
    clock,
    trustedEndpoints: { apiOrigin: origin, gitOrigin: origin, ca: tls.ca },
  });
  const refs: CredentialRef[] = [];
  const copies: Uint8Array[] = [];
  let custody: DriverCustody | undefined;
  let withdrawn = false;
  let withdrawOnAuthentication = false;
  const factory: RepositoryBackendFactory = {
    ...realFactory,
    create(input) {
      custody = input.custody;
      const backend = realFactory.create(input);
      return {
        ...backend,
        async acquire(...args) {
          const outcome = await backend.acquire(...args);
          if (outcome.kind === "acquired") {
            refs.push(outcome.credential);
          }
          return outcome;
        },
        prepareAuthentication: ((ref, plan) => {
          const authenticate = backend.prepareAuthentication(ref, plan);
          return (bytes, send) => {
            copies.push(bytes);
            if (withdrawOnAuthentication) {
              withdrawn = true;
            }
            return authenticate(bytes, send);
          };
        }) satisfies RepositoryBackend["prepareAuthentication"],
      };
    },
  };
  const { service, listeners } = await startServiceListeners(resources, {
    config,
    factory,
    clock,
    tls,
    upstreamOrigins: [origin],
    providerQueue: undefined,
    log: undefined,
  });
  const originalPaused = Promise.withResolvers<void>();
  const resumeOriginal = Promise.withResolvers<void>();
  resources.after(() => resumeOriginal.resolve());
  let pauseNextStanding = false;
  const opened = service.open({ durationSeconds: 3600, profile: "git-read" }, async () => {
    if (withdrawn) {
      throw new Error("standing-withdrawn");
    }
    if (pauseNextStanding) {
      pauseNextStanding = false;
      originalPaused.resolve();
      await resumeOriginal.promise;
    }
  });
  const fixture = { config, opened, listeners, tls };
  const request = () => gatewayRequest(fixture, "/repos/fixture/repository");
  assert.equal((await request()).status, 200);
  await clock.advance(599_850);
  pauseNextStanding = true;
  const original = request();
  await originalPaused.promise;
  selected = owners[1]!;
  await clock.advance(100);
  const replacement = request();
  await replacementEntered.promise;
  assert.equal(refs.length, 2);
  assert.notEqual(refs[0], refs[1]);
  assert.equal(service.status(opened.session.sessionId).activeUses, 2);

  // A detached caller holding either live ref has no authentication reader, and
  // a fabricated retirement attempt cannot turn the ref into access bytes.
  assert.equal(Reflect.get(custody!, "withAccess"), undefined);
  for (const ref of refs) {
    await assert.rejects(
      custody!.withRetirement({ action: "retire" } as AttemptContext, ref, async () => {
        assert.fail("detached credential access");
      }),
      /FOREIGN_ATTEMPT/,
    );
  }
  releaseReplacement.resolve();
  assert.equal((await replacement).status, 200);
  resumeOriginal.resolve();
  assert.equal((await original).status, 200);
  assert.deepEqual(observed, [expected[0], expected[1], expected[0]]);
  assert.ok(copies.every((copy) => copy.every((byte) => byte === 0)));

  withdrawOnAuthentication = true;
  assert.equal((await request()).status, 503);
  assert.equal(observed.length, 3, "withdrawal must send zero origin requests");
  assert.ok(copies.every((copy) => copy.every((byte) => byte === 0)));
});

const firstWriteCases = [
  { name: "standing denial prevents eager Expect headers", mode: "standing-denied" },
  { name: "authentication rejection closes a pending dispatch", mode: "authentication-rejected" },
  { name: "a confirmed TLS close before the first write is not dispatched", mode: "peer-closed" },
  { name: "authentication rejection after the first write remains uncertain", mode: "written" },
  {
    name: "observed owned-session expiry fences the first write after clock rollback",
    mode: "observed-expiry",
  },
] as const;

for (const { name, mode } of firstWriteCases) {
  test(name, async (t) => {
    const resources = createTestResourceScope(t);
    const clock = createControlledClock();
    const config = await createLoopbackServiceConfiguration(resources);
    const tls = await createTlsMaterial(resources);
    const connected = Promise.withResolvers<TLSSocket>();
    const received = Promise.withResolvers<ServerResponse>();
    const paused = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const rejected = Promise.withResolvers<void>();
    const requests: string[] = [];
    const onRequest = (request: IncomingMessage, response: ServerResponse) => {
      requests.push(request.headers.expect ?? "");
      received.resolve(response);
      if (mode !== "written") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: 73, full_name: "fixture/repository" }));
      }
    };
    const server = createServer(tls, onRequest);
    server.on("checkContinue", onRequest);
    server.once("secureConnection", (socket) => connected.resolve(socket));
    const origin = await listen(resources, server);
    const backendFactory: RepositoryBackendFactory = await createGitHubTokenServiceFactory(
      resources,
      {
        config,
        clock,
        token: `github_pat_${"c".repeat(36)}`,
        trustedEndpoints: { apiOrigin: origin, gitOrigin: origin, ca: tls.ca },
      },
    );
    let authenticating = false;
    let cleanupActions = 0;
    const factory: RepositoryBackendFactory = {
      ...backendFactory,
      create(input) {
        const backend = backendFactory.create(input);
        return {
          ...backend,
          retire(...args) {
            cleanupActions++;
            return backend.retire(...args);
          },
          finalize(...args) {
            cleanupActions++;
            return backend.finalize(...args);
          },
          prepareAuthentication: ((ref, plan) => {
            const authenticate = backend.prepareAuthentication(ref, plan);
            return (bytes, send) => {
              authenticating = true;
              return authenticate(bytes, async (request) => {
                const sending = send({
                  ...request,
                  headers: { ...request.headers, ExPeCt: "100-continue" },
                });
                if (mode === "authentication-rejected" || mode === "written") {
                  void sending.catch(() => {});
                  await (mode === "written" ? received.promise : paused.promise);
                  rejected.resolve();
                  throw new Error("authentication-failed");
                }
                return sending;
              });
            };
          }) satisfies RepositoryBackend["prepareAuthentication"],
        };
      },
    };
    const { service, listeners } = await startServiceListeners(resources, {
      config,
      factory,
      clock,
      tls,
      upstreamOrigins: [origin],
      providerQueue: undefined,
      log: undefined,
    });
    let disposals = 0;
    service.observeDisposal(() => disposals++);
    resources.after(() => resume.resolve());
    const opened = service.open({ durationSeconds: 3600, profile: "git-read" }, async () => {
      if (authenticating) {
        paused.resolve();
        await resume.promise;
        if (mode === "standing-denied") {
          throw new Error("standing-withdrawn");
        }
      }
    });
    const response = gatewayRequest(
      { config, opened, listeners, tls },
      "/repos/fixture/repository",
    );
    void response.catch(() => {});
    await paused.promise;
    const socket = await connected.promise;
    if (mode === "observed-expiry") {
      // TLS is established and the credential is held, but the first HTTP write is still gated.
      await clock.advance(1, 3_601_000);
      const client = new UnixRepositoryCredentialControlClient({
        controlSocket: config.gateway.controlSocket,
      });
      assert.equal(
        (await client.status(opened.session.sessionId, AbortSignal.timeout(5_000)))?.state,
        "CLOSED",
      );
      assert.equal(cleanupActions, 0, "status must not initiate credential cleanup");
      assert.equal(disposals, 0, "status must not publish disposal");
      await clock.advance(1, -3_599_000);
    } else if (mode === "standing-denied") {
      // Keep the gate closed long enough for an eager HTTP header write to reach the peer.
      await delay(50);
      assert.deepEqual(requests, []);
    } else if (mode === "authentication-rejected") {
      await rejected.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
    } else if (mode === "peer-closed") {
      const closed = once(socket, "close");
      socket.end();
      await closed;
    }
    resume.resolve();
    if (mode === "written") {
      const upstreamResponse = await received.promise;
      await rejected.promise;
      upstreamResponse.destroy();
      assert.equal((await response).status, 502);
      assert.deepEqual(requests, [""], "one request was written without the reserved Expect field");
    } else if (mode === "observed-expiry") {
      const outcome = await response.then(
        () => undefined,
        (error: unknown) => error,
      );
      assert.deepEqual(requests, [], "an expired owned session must send no origin HTTP request");
      assert.ok(outcome instanceof Error);
      assert.equal((outcome as NodeJS.ErrnoException).code, "ECONNRESET");
    } else {
      assert.equal((await response).status, 503);
      assert.deepEqual(requests, [], "a refused exchange must write no upstream HTTP request");
    }
  });
}
