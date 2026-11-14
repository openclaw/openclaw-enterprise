import assert from "node:assert/strict";
import test from "node:test";
import { tenantRequest as request } from "../helpers/tenant-reader-app.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { authenticatedHeaders, cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import { bootstrap, createFixture, field, responseError } from "./occ-api-security-fixture.ts";

export function registerAuthenticationCases() {
  test("authentication routes refuse NUL characters and unpaired surrogates", async () => {
    // The /api/auth/* routes sit outside the OCC API routes; PostgreSQL answered 5xx there.
    const fixture = await createFixture();
    await bootstrap(fixture);
    const nul = "a NUL character";
    const surrogate = "an unpaired UTF-16 surrogate";
    const account = { email: "unstorable@example.test", password: "unstorable-password" };
    const cases: ReadonlyArray<
      readonly [
        method: string,
        pathname: string,
        body: unknown,
        context: string,
        path: string,
        problem: string,
      ]
    > = [
      [
        "POST",
        "/api/auth/accounts",
        { ...account, email: "nul\u0000@example.test" },
        "body",
        "/email",
        nul,
      ],
      [
        "POST",
        "/api/auth/accounts",
        { ...account, name: "Lone \ud800" },
        "body",
        "/name",
        surrogate,
      ],
      [
        "POST",
        "/api/auth/service-keys",
        { servicePrincipalId: "sp\u0000", name: "key" },
        "body",
        "/servicePrincipalId",
        nul,
      ],
      ["DELETE", "/api/auth/service-keys/key%00x", undefined, "params", "/keyId", nul],
      ["GET", "/api/auth/accounts/user%00x", undefined, "params", "/userId", nul],
      ["POST", "/api/auth/accounts/user%00x/enrol", undefined, "params", "/userId", nul],
      [
        "POST",
        "/api/auth/accounts/user%00x/disable",
        { expectedVersion: 1 },
        "params",
        "/userId",
        nul,
      ],
      [
        "POST",
        "/api/auth/accounts/user/methods/m%00x/detach",
        { expectedVersion: 1 },
        "params",
        "/methodId",
        nul,
      ],
      [
        "POST",
        "/api/auth/recovery",
        { userId: "user\ud800", expectedCurrentUserId: "user", expectedVersion: 1 },
        "body",
        "/userId",
        surrogate,
      ],
    ];
    const before = fixture.auditSink.events.length;
    for (const [method, pathname, body, context, path, problem] of cases) {
      const result = await request(fixture.app, pathname, {
        method,
        ...(body === undefined ? {} : { body }),
      });
      assert.equal(result.response.status, 400, `${method} ${pathname}`);
      // The same code, message and field pointer as the OCC API routes: since #1441 the
      // /api/auth/* error schema keeps validation details.
      assert.deepEqual(responseError(result.payload), {
        code: "INVALID_REQUEST",
        message: `The request does not match the operation contract: ${context} ${path} contains ${problem}.`,
        details: [{ path, code: problem === nul ? "INVALID_FORMAT" : "INVALID_VALUE" }],
      });
    }
    assert.equal(fixture.auditSink.events.length, before);
  });

  test("account creation preserves hashed passwords through HTTP sign-in and session inspection", async (t) => {
    const fixture = await createFixture();
    await bootstrap(fixture);
    const app = fixture.createApp(fixture.administrator, {}, (options) =>
      createFastifyApp({
        ...options,
        // In-memory persistence only; admission, IAM, account preparation, hashing and
        // session handling are the real owners. Hosted PostgreSQL proves the transaction.
        provisionAuthAccount: async (seed, event, prepared) => {
          await fixture.auth.writePreparedAccount(prepared);
          fixture.state.identities.push(seed.principal);
          await fixture.auditSink.append(event);
        },
      }),
    );
    t.after(() => app.close());
    const origin = fixture.app.defaultSession.origin;
    const host = new URL(origin).host;
    const headers = { host, ...authenticatedHeaders(fixture.app.defaultSession) };
    const email = "http-password-compatible@example.test";
    const password = "account-password-\u0000-\ud800-\ufffd";
    const create = (
      body: { email: string; password: string | number },
      suppliedHeaders: Record<string, string> = headers,
    ) =>
      app.inject({
        method: "POST",
        url: "/api/auth/accounts",
        headers: suppliedHeaders,
        payload: body,
      });
    assert.equal((await create({ email, password }, { host, origin })).statusCode, 401);
    assert.equal(
      (await create({ email, password }, { ...headers, origin: "https://foreign.example" }))
        .statusCode,
      403,
    );
    for (const invalidPassword of [123, "short"]) {
      assert.equal((await create({ email, password: invalidPassword })).statusCode, 400);
    }
    const created = await create({ email, password });
    assert.equal(created.statusCode, 201, created.body);
    const signedIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { host, origin },
      payload: { email, password },
    });
    assert.equal(signedIn.statusCode, 200, signedIn.body);
    const cookie = cookieHeaderFromSetCookie(signedIn.headers["set-cookie"]);
    assert.ok(cookie);
    const session = await app.inject({ url: "/api/auth/session", headers: { host, cookie } });
    assert.equal(session.statusCode, 200, session.body);
    const user = field(field(session.json<unknown>(), "data"), "user");
    assert.equal(field(user, "id"), field(field(created.json<unknown>(), "data"), "id"));
  });
}
