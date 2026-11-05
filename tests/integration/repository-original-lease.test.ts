import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { channel } from "node:diagnostics_channel";
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import test from "node:test";
import type { TLSSocket } from "node:tls";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import type {
  AttemptContext,
  CredentialRef,
  DriverCustody,
  RepositoryBackend,
  RepositoryBackendFactory,
} from "../../apps/controller/src/drivers/repo/credentials/backend-contracts.ts";
import { createCredentialService } from "../../apps/controller/src/drivers/repo/credentials/service.ts";
import { startListeners } from "../../apps/controller/src/drivers/repo/credentials/server.ts";
import type { DispatchGate } from "../../apps/controller/src/drivers/repo/credentials/internal-contracts.ts";
import { within } from "../helpers/wait-for.mjs";
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

test(
  "an owned exchange keeps its original lease through replacement",
  { timeout: 30_000 },
  async (t) => {
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
          await within(releaseReplacement.promise, "releaseReplacement");
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
    const originalPaused = Promise.withResolvers<void>();
    const resumeOriginal = Promise.withResolvers<void>();
    let pauseNextAuthentication = false;
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
            return async (bytes, send) => {
              copies.push(bytes);
              if (pauseNextAuthentication) {
                pauseNextAuthentication = false;
                originalPaused.resolve();
                await within(resumeOriginal.promise, "resume original authentication");
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
      log: undefined,
    });
    resources.after(() => {
      resumeOriginal.resolve();
      releaseReplacement.resolve();
    });
    const opened = service.open({ durationSeconds: 3600, profile: "git-read" });
    const fixture = { config, opened, listeners, tls };
    const request = () => gatewayRequest(fixture, "/repos/fixture/repository");
    assert.equal((await request()).status, 200);
    await clock.advance(599_850);
    pauseNextAuthentication = true;
    const original = request();
    void original.catch(() => {});
    await within(originalPaused.promise, "originalPaused");
    selected = owners[1]!;
    await clock.advance(100);
    const replacement = request();
    void replacement.catch(() => {});
    await within(replacementEntered.promise, "replacementEntered");
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
    assert.equal(copies.length, 3);
    assert.ok(copies.every((copy) => copy.every((byte) => byte === 0)));
    t.diagnostic(
      "overlapping leases=2; origin token order=original,replacement,original; zeroized copies=3",
    );
  },
);

const firstWriteCases = [
  { name: "authentication rejection closes a pending dispatch", mode: "authentication-rejected" },
  { name: "a confirmed TLS close before the first write is not dispatched", mode: "peer-closed" },
  { name: "authentication rejection after the first write remains uncertain", mode: "written" },
  {
    name: "observed owned-session expiry fences the first write after clock rollback",
    mode: "observed-expiry",
  },
] as const;

for (const { name, mode } of firstWriteCases) {
  test(name, { timeout: 30_000 }, async (t) => {
    const resources = createTestResourceScope(t);
    const clock = createControlledClock();
    const config = await createLoopbackServiceConfiguration(resources);
    const tls = await createTlsMaterial(resources);
    const connected = Promise.withResolvers<TLSSocket>();
    const received = Promise.withResolvers<ServerResponse>();
    const paused = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const rejected = Promise.withResolvers<void>();
    const gateResult = Promise.withResolvers<
      { kind: "returned"; value: unknown } | { kind: "threw"; error: unknown }
    >();
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
    let verifiedTls = 0;
    let upstreamRequest: ClientRequest | undefined;
    let upstreamSocket: TLSSocket | undefined;
    const created = channel("http.client.request.created");
    const observe = (event: unknown) => {
      const { request } = event as { request: ClientRequest };
      request.once("socket", (socket: TLSSocket) => {
        socket.once("secureConnect", () => {
          if (socket.remotePort === Number(new URL(origin).port)) {
            assert.equal(socket.authorized, true);
            assert.equal(request.headersSent, false);
            verifiedTls++;
            upstreamRequest = request;
            upstreamSocket = socket;
          }
        });
      });
    };
    created.subscribe(observe);
    resources.after(() => created.unsubscribe(observe));
    const backendFactory: RepositoryBackendFactory = await createGitHubTokenServiceFactory(
      resources,
      {
        config,
        clock,
        token: `github_pat_${"c".repeat(36)}`,
        trustedEndpoints: { apiOrigin: origin, gitOrigin: origin, ca: tls.ca },
      },
    );
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
              return authenticate(bytes, async (request) => {
                const sending = send({
                  ...request,
                  headers: { ...request.headers, ExPeCt: "100-continue" },
                });
                if (mode === "authentication-rejected" || mode === "written") {
                  void sending.catch(() => {});
                  await within<unknown>(
                    mode === "written" ? received.promise : paused.promise,
                    "authentication rejection boundary",
                  );
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
    const service = createCredentialService({ config, factory, clock });
    // Delay only the existing first-write gate. The real sender establishes TLS,
    // and the real lifecycle gate still owns every admission check and the write.
    const listeners = await startListeners({
      config,
      factory,
      clock,
      tls,
      trustedUpstreamOrigins: new Set([origin]),
      upstreamCa: tls.ca,
      service: {
        ...service,
        execute(ref, send, requestDigest) {
          return service.execute(
            ref,
            (request, context) =>
              send(request, {
                ...context,
                gate: {
                  ...context.gate,
                  dispatch: (async (stop, open, assertReady) => {
                    paused.resolve();
                    await within(resume.promise, "resume first-write gate");
                    try {
                      const value = await context.gate.dispatch(stop, open, assertReady);
                      gateResult.resolve({ kind: "returned", value });
                      return value;
                    } catch (error) {
                      gateResult.resolve({ kind: "threw", error });
                      throw error;
                    }
                  }) satisfies DispatchGate["dispatch"],
                },
              }),
            requestDigest,
          );
        },
      },
    });
    resources.after(() => listeners.close());
    resources.after(async () => {
      const summary = await within(service.shutdown(1000), "service shutdown");
      assert.equal(summary.graceExpired, false);
      assert.equal(summary.disposedSessions, summary.closedSessions);
      assert.equal(summary.pendingActions, 0);
      assert.equal(summary.pendingCredentials, 0);
      assert.equal(summary.pendingAuxiliary, 0);
    });
    resources.after(() => listeners.stopAdmission());
    resources.after(() => resume.resolve());
    let disposals = 0;
    service.observeDisposal(() => disposals++);
    const opened = service.open({ durationSeconds: 3600, profile: "git-read" });
    const response = gatewayRequest(
      { config, opened, listeners, tls },
      "/repos/fixture/repository",
    );
    void response.catch(() => {});
    await within(paused.promise, "paused");
    const socket = await within(connected.promise, "connected");
    assert.equal(verifiedTls, 1);
    assert.equal(upstreamRequest?.headersSent, false);
    assert.deepEqual(requests, [], "the paused sender must not write eager Expect headers");
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
    } else if (mode === "authentication-rejected") {
      await within(rejected.promise, "rejected");
      await new Promise<void>((resolve) => setImmediate(resolve));
    } else if (mode === "peer-closed") {
      const closed = once(socket, "close");
      const clientClosed = once(upstreamSocket!, "close");
      socket.end();
      await within(closed, "confirmed peer TLS close");
      await within(clientClosed, "confirmed sender TLS close");
      assert.equal(upstreamSocket!.destroyed, true);
    }
    assert.equal(upstreamRequest?.headersSent, false);
    resume.resolve();
    if (mode === "authentication-rejected") {
      // The gateway can finish before the resumed gate refuses the pending write.
      const outcome = await within(gateResult.promise, "resumed real gate result");
      assert.ok(outcome.kind === "threw");
      assert.ok(outcome.error instanceof Error);
      assert.equal(outcome.error.message, "DISPATCH_CLOSED");
      assert.equal(upstreamRequest!.headersSent, false);
    }
    if (mode === "written") {
      const upstreamResponse = await within(received.promise, "received");
      await within(rejected.promise, "rejected");
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
    t.diagnostic(`mode=${mode}; verified TLS=${verifiedTls}; origin requests=${requests.length}`);
  });
}
