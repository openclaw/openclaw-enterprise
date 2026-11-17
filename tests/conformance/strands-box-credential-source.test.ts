import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type {
  GitHubRequestDecision,
  RepositoryGitRequests,
} from "../../packages/contracts/src/index.ts";
import type { SourceAsk } from "../../deploy/examples/strands-box/driver/control.ts";
import {
  answerAsk,
  sourceAnswer,
} from "../../deploy/examples/strands-box/driver/request-source.ts";
import {
  checkedAnswer,
  CredentialSourceRelay,
  parseSourceRequest,
  SOURCE_MAX_BODY_BYTES,
} from "../../deploy/examples/strands-box/host/credential-source.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

// Stage B: Box's request-time credential source on the host, and the paired Driver's mapping
// of OCE's decision to Box's reply. Every case fails closed; none can skip.

const REQUEST_ID = "0123456789abcdef0123456789abcdef";

function boxRequest(overrides: Record<string, unknown> = {}, target: Record<string, unknown> = {}) {
  return {
    version: 1,
    request_id: REQUEST_ID,
    target: {
      scheme: "https",
      host: "github.com",
      port: 443,
      method: "POST",
      path: "/example/review.git/git-receive-pack",
      query: "",
      ...target,
    },
    headers: [["content-type", "application/x-git-receive-pack-request"]],
    body: Buffer.from("0000").toString("base64"),
    ...overrides,
  };
}

async function sourceFixture(t: TestContext, active = () => true) {
  const directory = await temporaryDirectory(t, "strands-source-");
  const socket = join(directory, "oce.sock");
  const bearer = randomBytes(32).toString("base64url");
  const relay = new CredentialSourceRelay(
    createHash("sha256").update(bearer).digest("hex"),
    active,
  );
  await relay.listen(socket);
  t.after(() => relay.close());
  const ask = (
    document: unknown,
    options: { bearer?: string | undefined; contentType?: string } = {},
  ) =>
    new Promise<{ status: number; body: Record<string, unknown> | undefined }>(
      (resolve, reject) => {
        const text = typeof document === "string" ? document : JSON.stringify(document);
        const presented = "bearer" in options ? options.bearer : bearer;
        const call = request(
          {
            socketPath: socket,
            method: "POST",
            path: "/",
            headers: {
              "content-type": options.contentType ?? "application/json",
              "content-length": Buffer.byteLength(text),
              ...(presented === undefined ? {} : { authorization: `Bearer ${presented}` }),
            },
          },
          (response) => {
            const pieces: Buffer[] = [];
            response.on("data", (piece: Buffer) => pieces.push(piece));
            response.on("end", () => {
              const raw = Buffer.concat(pieces).toString("utf8");
              resolve({
                status: response.statusCode ?? 0,
                body: raw === "" ? undefined : (JSON.parse(raw) as Record<string, unknown>),
              });
            });
          },
        );
        call.on("error", reject);
        call.end(text);
      },
    );
  return { relay, ask, bearer };
}

test("the host's credential source answers only this execution's Box, only for GitHub's two routes", async (t) => {
  const { relay, ask, bearer } = await sourceFixture(t);
  const signal = AbortSignal.timeout(20_000);
  // Wrong, missing or other-execution bearer, or no JSON: nothing reaches the Worker.
  for (const options of [
    { bearer: randomBytes(32).toString("base64url") },
    { bearer: undefined },
    { bearer: `${bearer}x` },
    { contentType: "text/plain" },
  ]) {
    assert.equal((await ask(boxRequest(), options)).status, 401);
  }
  // A document that does not parse: Box reports the source unavailable.
  assert.equal((await ask("{not json")).status, 400);
  // Parsed request IDs get a refusal code Box shows the workload.
  const refused = async (document: unknown) => (await ask(document)).body?.refusal;
  assert.equal(await refused(boxRequest({ version: 2 })), "request_invalid");
  assert.equal(await refused(boxRequest({}, { scheme: "http" })), "request_invalid");
  assert.equal(await refused(boxRequest({ body: "AAA" })), "request_invalid");
  assert.equal(await refused(boxRequest({ headers: [["Authorization", "x"]] })), "request_invalid");
  assert.equal(
    await refused(
      boxRequest({
        headers: [
          ["a", "1"],
          ["a", "2"],
        ],
      }),
    ),
    "request_invalid",
  );
  assert.equal(await refused(boxRequest({}, { host: "gitlab.com" })), "route_unsupported");
  assert.equal(await refused(boxRequest({}, { port: 8443 })), "route_unsupported");
  assert.equal(await refused(boxRequest({}, { method: "PATCH" })), "route_unsupported");
  assert.equal(
    await refused(boxRequest({ body: Buffer.alloc(SOURCE_MAX_BODY_BYTES + 1).toString("base64") })),
    "body_too_large",
  );
  assert.equal(
    (await ask(boxRequest({ body: "A".repeat(SOURCE_MAX_BODY_BYTES * 2) }))).status,
    413,
  );
  assert.deepEqual(await relay.collect(0, signal), []);

  // A valid ask is handed to the Worker once; its answer goes back with Box's request ID.
  const pending = ask(boxRequest());
  const [collected] = await relay.collect(4_000, signal);
  assert.ok(collected);
  assert.equal(collected.requestId, REQUEST_ID);
  assert.equal(collected.bearerSha256, createHash("sha256").update(bearer).digest("hex"));
  assert.equal(collected.target.host, "github.com");
  assert.deepEqual(await relay.collect(0, signal), []);
  assert.equal(relay.answer("unknown", { refusal: "x" }), false);
  const sendBy = Date.now() + 5_000;
  assert.equal(
    relay.answer(collected.askId, { credential: "x-access-token:value", send_by_unix_ms: sendBy }),
    true,
  );
  assert.deepEqual((await pending).body, {
    version: 1,
    request_id: REQUEST_ID,
    credential: "x-access-token:value",
    send_by_unix_ms: sendBy,
  });
  assert.equal(relay.answer(collected.askId, { refusal: "late" }), false);

  // A malformed Worker answer never becomes a value.
  const bad = ask(boxRequest());
  const [second] = await relay.collect(4_000, signal);
  relay.answer(second!.askId, { credential: "value", send_by_unix_ms: Date.now() + 5_000 });
  assert.equal((await bad).body?.refusal, "answer_invalid");
  assert.equal((await bad).body?.credential, undefined);
});

test("the host refuses every ask while the execution is not released, and when the Worker never answers", async (t) => {
  let active = false;
  const { relay, ask } = await sourceFixture(t, () => active);
  const signal = AbortSignal.timeout(20_000);
  assert.equal((await ask(boxRequest())).body?.refusal, "access_withdrawn");
  assert.deepEqual(await relay.collect(0, signal), []);
  active = true;
  // No Worker collects: refused inside Box's timeout, never sent without OCE's answer.
  const started = Date.now();
  const unanswered = await ask(boxRequest());
  assert.equal(unanswered.body?.refusal, "route_not_ready");
  assert.ok(Date.now() - started < 5_000);
  // Collected but never answered: refused the same way.
  const pending = ask(boxRequest());
  assert.equal((await relay.collect(4_000, signal)).length, 1);
  assert.equal((await pending).body?.refusal, "route_not_ready");
  // Closing the source (DELETE or shutdown) refuses what is still waiting and anything later.
  const waiting = ask(boxRequest());
  await relay.collect(4_000, signal);
  relay.close();
  const closed = await waiting.catch(() => undefined);
  assert.equal(closed?.body?.credential, undefined);
});

test("the host passes only a well-formed value for the route's placement", () => {
  const now = Date.now();
  const git = { host: "github.com" } as const;
  const api = { host: "api.github.com" } as const;
  assert.deepEqual(checkedAnswer(git, { refusal: "access_withdrawn" }, now), {
    refusal: "access_withdrawn",
  });
  for (const [target, value] of [
    [git, { refusal: "bad code!" }],
    [git, { refusal: "x".repeat(65) }],
    [git, { refusal: "x", credential: "x-access-token:v", send_by_unix_ms: now + 1_000 }],
    [git, { credential: "v", send_by_unix_ms: now + 1_000 }],
    [git, { credential: "x-access-token:", send_by_unix_ms: now + 1_000 }],
    [api, { credential: "x-access-token:v", send_by_unix_ms: now + 1_000 }],
    [api, { credential: "v v", send_by_unix_ms: now + 1_000 }],
    [api, { credential: "v", send_by_unix_ms: now }],
    [api, { credential: "v", send_by_unix_ms: now + 60_000 }],
    [api, { credential: "v".repeat(4_097), send_by_unix_ms: now + 1_000 }],
    [api, { credential: "v", send_by_unix_ms: String(now + 1_000) }],
    [api, { credential: "v", send_by_unix_ms: now + 1_000, extra: true }],
  ] as const) {
    assert.throws(() => checkedAnswer(target, value, now), /answer_invalid/);
  }
  assert.deepEqual(checkedAnswer(api, { credential: "v", send_by_unix_ms: now + 1_000 }, now), {
    credential: "v",
    send_by_unix_ms: now + 1_000,
  });
  // The parsed ask keeps Box's base64 body untouched for OCE's digest.
  const body = Buffer.from("payload").toString("base64");
  assert.equal(parseSourceRequest(Buffer.from(JSON.stringify(boxRequest({ body })))).body, body);
});

function sourceAsk(overrides: Partial<SourceAsk> = {}): SourceAsk {
  return {
    askId: "ask-1",
    requestId: REQUEST_ID,
    bearerSha256: "b".repeat(64),
    deadlineUnixMs: Date.now() + 4_000,
    target: {
      host: "github.com",
      port: 443,
      method: "POST",
      path: "/example/review.git/git-receive-pack",
      query: "",
    },
    headers: [["content-type", "application/x-git-receive-pack-request"]],
    body: Buffer.from("0000").toString("base64"),
    ...overrides,
  };
}

const ROUTE = { revisionId: "rev_1", fence: 3 } as never;

function allow(
  credential: Extract<GitHubRequestDecision, { kind: "allow" }>["credential"],
  sendBy = new Date(Date.now() + 5_000).toISOString(),
): GitHubRequestDecision {
  return { kind: "allow", operation: "receive-pack", exchangeId: "use-1", sendBy, credential };
}

test("the Driver maps OCE's decision to Box's reply: only an allow for the route's scheme yields a value", () => {
  const now = Date.now();
  const sendBy = new Date(now + 5_000).toISOString();
  const basic = { scheme: "basic", username: "x-access-token", token: "tok" } as const;
  const bearer = { scheme: "bearer", token: "tok" } as const;
  assert.deepEqual(sourceAnswer("github.com", allow(basic, sendBy), now), {
    credential: "x-access-token:tok",
    send_by_unix_ms: Date.parse(sendBy),
  });
  assert.deepEqual(sourceAnswer("api.github.com", allow(bearer, sendBy), now), {
    credential: "tok",
    send_by_unix_ms: Date.parse(sendBy),
  });
  // The wrong scheme for the route, or an expired allow, is refused.
  assert.deepEqual(sourceAnswer("github.com", allow(bearer, sendBy), now), {
    refusal: "credential_mismatch",
  });
  assert.deepEqual(sourceAnswer("api.github.com", allow(basic, sendBy), now), {
    refusal: "credential_mismatch",
  });
  assert.deepEqual(
    sourceAnswer("github.com", allow({ ...basic, username: "other" } as never, sendBy), now),
    { refusal: "credential_mismatch" },
  );
  assert.deepEqual(sourceAnswer("github.com", allow(basic, new Date(now - 1).toISOString()), now), {
    refusal: "route_not_ready",
  });
  assert.deepEqual(sourceAnswer("github.com", allow(basic, "not a date"), now), {
    refusal: "route_not_ready",
  });
  // Today's header shape (no typed credential), or an empty token, never yields a value.
  for (const decision of [
    {
      kind: "allow",
      operation: "receive-pack",
      sendBy,
      inject: { name: "authorization", value: "Basic eA==" },
    },
    { kind: "allow", operation: "receive-pack", sendBy, credential: { ...basic, token: "" } },
  ]) {
    assert.deepEqual(sourceAnswer("github.com", decision as never, now), {
      refusal: "credential_mismatch",
    });
  }
  // A refusal never yields a value, whatever else the decision carries.
  for (const reasonCode of [
    "request_not_allowed",
    "draft_already_opened",
    "access_withdrawn",
    "route_not_ready",
    undefined,
  ] as const) {
    const answer = sourceAnswer("github.com", {
      kind: "refused",
      refusal: "approval_denied",
      exchangeId: "use-2",
      ...(reasonCode === undefined ? {} : { reasonCode }),
      ...({ credential: basic, sendBy } as object),
    } as GitHubRequestDecision);
    assert.deepEqual(answer, { refusal: reasonCode ?? "request_refused" });
  }
});

test("the Driver refuses before asking OCE for a wrong bearer, no route or a past deadline, and asks once otherwise", async () => {
  const calls: Parameters<RepositoryGitRequests["authorize"]>[0][] = [];
  let decision: GitHubRequestDecision | Error = allow({
    scheme: "basic",
    username: "x-access-token",
    token: "tok",
  });
  const requests: RepositoryGitRequests = {
    authorize: async (input) => {
      calls.push(input);
      if (decision instanceof Error) {
        throw decision;
      }
      return decision;
    },
  };
  const context = {
    route: ROUTE,
    bearerSha256: "b".repeat(64),
    requests,
    signal: AbortSignal.timeout(10_000),
  };
  for (const [ask, ctx, refusal] of [
    [sourceAsk({ bearerSha256: "c".repeat(64) }), context, "execution_mismatch"],
    [sourceAsk(), { ...context, bearerSha256: undefined }, "execution_mismatch"],
    [sourceAsk(), { ...context, route: undefined }, "route_not_ready"],
    [sourceAsk({ deadlineUnixMs: Date.now() - 1 }), context, "route_not_ready"],
  ] as const) {
    const { answer, record } = await answerAsk(ask, ctx);
    assert.deepEqual(answer, { refusal });
    assert.equal(record.asked, false);
    assert.equal("credential" in answer, false);
  }
  assert.equal(calls.length, 0);

  const allowed = await answerAsk(sourceAsk(), context);
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.profile, "github_repository");
  assert.equal(call.route, ROUTE);
  assert.equal(call.request.target.host, "github.com");
  assert.equal(Buffer.from(call.request.body).toString(), "0000");
  assert.ok(Date.parse(call.deadlineAt!) <= Date.now() + 4_000);
  assert.equal("authorization" in call, false);
  assert.equal(allowed.record.exchangeId, "use-1");
  assert.equal(allowed.record.outcome, "allow");
  assert.equal(JSON.stringify(allowed.record).includes("tok"), false);
  assert.equal((allowed.answer as { credential: string }).credential, "x-access-token:tok");

  decision = {
    kind: "refused",
    refusal: "approval_denied",
    reasonCode: "request_not_allowed",
    exchangeId: "use-3",
  };
  const refused = await answerAsk(sourceAsk(), context);
  assert.deepEqual(refused.answer, { refusal: "request_not_allowed" });
  assert.equal(refused.record.exchangeId, "use-3");
  assert.equal(refused.record.asked, true);

  decision = new Error("owner unavailable");
  const failed = await answerAsk(sourceAsk(), context);
  assert.deepEqual(failed.answer, { refusal: "route_not_ready" });
  assert.equal(calls.length, 3);
});
