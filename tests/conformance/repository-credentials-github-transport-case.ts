import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { prepareProviderScope } from "../../apps/controller/src/drivers/repo/github/access/provider-transport/request-options.ts";
import { createGitHubKeyOwner } from "../../apps/controller/src/drivers/repo/github/access/material.ts";
import { startGitHubFixture } from "../fixtures/repository-credentials/github.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import {
  createProviderTransport,
  type ProviderAttempt,
} from "../../apps/controller/src/drivers/repo/github/access/provider-transport.ts";
import type { ProviderObservation } from "../../apps/controller/src/drivers/repo/github/access/provider-diagnostics.ts";

type Grant = Parameters<typeof prepareProviderScope>[1];
const parseJson: (text: string) => unknown = JSON.parse;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fixtureToken(body: Buffer): string {
  const packet = parseJson(body.toString());
  assert.ok(record(packet) && typeof packet.token === "string", "provider response has a token");
  return packet.token;
}

export async function providerTransportCase(t: TestContext) {
  const clock = createControlledClock();
  const { origin, tls, privateKey, issuesOfTokens, tokenState, errors } = await startGitHubFixture(
    t,
    {
      clock,
    },
  );
  const ca = tls.ca;
  const key = createGitHubKeyOwner({ privateKey, appId: "12345", clock });
  t.after(() => key.close());
  const scope = {
    id: "grant",
    isolationId: "revision",
    appId: "12345",
    installationId: "41",
    repositoryId: "73",
    repository: "fixture/repository",
    profile: "git-read" as "git-read" | "git-full",
  } satisfies Grant;
  for (const { name, origin: invalidOrigin } of [
    { name: "plaintext origin", origin: "http://localhost" },
    { name: "origin with user info", origin: "https://user@example.test" },
    { name: "origin with path", origin: `${origin}/path` },
  ]) {
    await t.test(`refuses ${name}`, () => {
      assert.throws(
        () => createProviderTransport(ca, clock, prepareProviderScope(invalidOrigin, scope)),
        {
          message: "invalid-provider-origin",
        },
      );
    });
  }
  for (const { name, installationId } of [
    { name: "network path", installationId: "//other.example" },
    { name: "absolute URL", installationId: "https://other.example" },
    { name: "parent traversal", installationId: "41/../42" },
    { name: "query", installationId: "41?x=1" },
  ]) {
    await t.test(`refuses installation ${name}`, () => {
      assert.throws(
        () =>
          createProviderTransport(
            ca,
            clock,
            prepareProviderScope(origin, {
              ...scope,
              installationId,
            }),
          ),
        { message: "invalid-provider-scope" },
      );
    });
  }
  const invalidScope = { message: "invalid-provider-scope" };
  for (const { name, changes, refusal } of [
    {
      name: "unsafe repository integer",
      changes: { repositoryId: "9007199254740992" },
      refusal: invalidScope,
    },
    { name: "numeric repository ID", changes: { repositoryId: 73 }, refusal: invalidScope },
    { name: "numeric installation ID", changes: { installationId: 41 }, refusal: invalidScope },
    {
      name: "prototype profile",
      changes: { profile: "__proto__" },
      refusal: { message: "unsupported-profile" },
    },
  ]) {
    await t.test(`refuses ${name}`, () => {
      assert.throws(
        () =>
          createProviderTransport(
            ca,
            clock,
            // @ts-expect-error Exercise malformed wire configuration at the runtime validator.
            prepareProviderScope(origin, { ...scope, ...changes }),
          ),
        refusal,
      );
    });
  }
  let installationReads = 0;
  const transportScope = {
    ...scope,
    get installationId() {
      return ++installationReads === 1 ? "41" : "42";
    },
  };
  const transport = createProviderTransport(
    ca,
    clock,
    prepareProviderScope(origin, transportScope),
  );
  assert.equal(installationReads, 1);
  assert.deepEqual(Object.keys(transport).sort(), ["issue", "revoke"]);
  assert.ok(Object.isFrozen(transport));
  // A later caller cannot replace the URL, request body, or admitted permission map.
  transportScope.repositoryId = "74";
  transportScope.profile = "git-full";
  let dispatches = 0;
  let observations = 0;
  const attempt = (action: "acquire" | "retire"): ProviderAttempt & { action: typeof action } => ({
    action,
    deadlineMonoMs: clock.monotonicNow() + 30000,
    signal: new AbortController().signal,
    assertAdmitted() {},
    observeDispatch() {
      dispatches++;
    },
  });
  const observeResponse = () => {
    observations++;
  };
  for (const { name, authorization } of [
    { name: "header injection", authorization: "unsafe\r\nHeader: value" },
    { name: "empty authorization", authorization: "" },
    { name: "authorization object", authorization: { path: "//other.example" } },
  ]) {
    await t.test(`refuses ${name} before dispatch`, async () => {
      await assert.rejects(
        // @ts-expect-error Deliberately send a non-string authorization alongside malformed strings.
        transport.issue(authorization, attempt("acquire"), () => {}, observeResponse),
        /provider-unavailable/,
      );
    });
  }
  assert.equal(dispatches, 0);
  assert.equal(issuesOfTokens.length, 0);
  let borrowed: Buffer | undefined;
  let capturedResponse: { status: number; body: Buffer } | undefined;
  await key.withJwt((jwt, assertCurrent) =>
    transport.issue(jwt, attempt("acquire"), assertCurrent, (response) => {
      observeResponse();
      borrowed = response.body;
      capturedResponse = { status: response.status, body: Buffer.from(response.body) };
    }),
  );
  assert.ok(borrowed);
  assert.ok(
    borrowed.every((byte) => byte === 0),
    "transport cleared the borrowed body",
  );
  assert.equal(observations, 1);
  assert.ok(capturedResponse);
  assert.equal(capturedResponse.status, 201);
  const token = fixtureToken(capturedResponse.body);
  capturedResponse.body.fill(0);
  const [issued] = issuesOfTokens;
  assert.ok(issued, "provider observed an issuance request");
  assert.deepEqual(issued.repositoryIds, [73]);
  assert.deepEqual(issued.permissions, {
    metadata: "read",
    contents: "read",
    issues: "read",
    pull_requests: "read",
    checks: "read",
    statuses: "read",
  });
  assert.equal(await transport.revoke(token, attempt("retire")), true);
  assert.equal(dispatches, 2);
  const [firstToken] = tokenState();
  assert.ok(firstToken);
  assert.equal(firstToken.revoked, true);

  for (const failure of [
    "consumer throws",
    "cancel after capture",
    "thenable result",
    "late rejection",
    "decorated late rejection",
  ]) {
    await t.test(failure, async () => {
      const controller = new AbortController();
      const diagnostics: ProviderObservation[] = [];
      let captured: string | undefined;
      let body: Buffer | undefined;
      let consumes = 0;
      let thenCalls = 0;
      const asynchronous = failure.includes("late rejection")
        ? Promise.withResolvers<undefined>()
        : undefined;
      if (failure === "decorated late rejection") {
        assert.ok(asynchronous);
        Object.assign(asynchronous.promise, {
          providerExpiresAt: clock.wallNow() + 60000,
          usableUntil: clock.wallNow() + 30000,
        });
      }
      const issuing = key.withJwt((jwt, assertCurrent) =>
        transport.issue(
          jwt,
          { ...attempt("acquire"), signal: controller.signal },
          assertCurrent,
          // @ts-expect-error Deliberately return a thenable or Promise from the synchronous consumer.
          (response) => {
            consumes++;
            body = response.body;
            captured = fixtureToken(body);
            if (failure === "consumer throws") {
              throw new Error("fixture consumer failure");
            }
            if (failure === "thenable result") {
              return {
                then() {
                  thenCalls++;
                },
              };
            }
            if (asynchronous) {
              return asynchronous.promise;
            }
            // A captured credential survives cancellation, but the verdict must not return.
            controller.abort();
            return undefined;
          },
          (observation) => diagnostics.push(observation),
        ),
      );
      await assert.rejects(issuing, /provider-unavailable/);
      if (asynchronous) {
        // No test-side rejection handler: node:test must report any escaped rejection.
        asynchronous.reject(new Error("late callback rejection"));
        await new Promise(setImmediate);
      }
      assert.equal(consumes, 1);
      assert.equal(thenCalls, 0, "transport must not invoke arbitrary thenables");
      assert.ok(body);
      assert.ok(body.every((byte) => byte === 0));
      assert.equal(
        diagnostics.find((entry) => entry.error)?.error,
        failure === "cancel after capture" ? "cancelled" : "observer-error",
      );
      assert.ok(captured);
      assert.equal(await transport.revoke(captured, attempt("retire")), true);
    });
  }
  assert.equal(dispatches, 12, "one issue and retirement per token, with no retry");
  assert.equal(issuesOfTokens.length, 6);
  const retired = tokenState();
  assert.equal(retired.length, 6);
  assert.ok(retired.every((token) => token.revoked));

  assert.equal(clock.pendingTimers(), 0);
  assert.deepEqual(errors, []);
}
