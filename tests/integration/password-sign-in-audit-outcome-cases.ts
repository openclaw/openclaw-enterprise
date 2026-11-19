import assert from "node:assert/strict";
import test from "node:test";
import {
  APIError,
  REFUSED,
  assertUnavailable,
  controller,
  email,
  errorOf,
  password,
  signIn,
} from "./password-sign-in-audit-fixture.ts";
import type { Outcome } from "./password-sign-in-audit-fixture.ts";

function controllerWithRecordedOutcomes() {
  const outcomes: Outcome[] = [];
  const { auth, memoryDatabase } = controller({
    accepted: async (userId) => {
      outcomes.push(["accepted", userId]);
    },
    refused: async () => {
      outcomes.push(["refused"]);
    },
  });
  return { auth, memoryDatabase, outcomes };
}

export function registerPasswordSignInOutcomeCases(): void {
  test("a password-only sign-in reports its outcome to the audit seam", async () => {
    const { auth, memoryDatabase, outcomes } = controllerWithRecordedOutcomes();
    const account = await auth.createAccount({ email, password });
    assert.equal((await signIn(auth, { email, password })).status, 200);
    // A wrong password and an unknown email get the same answer, so it names no account.
    for (const guess of [email, "nobody@example.test"]) {
      const refused = await signIn(auth, { email: guess, password: "wrong-password-guess" });
      assert.equal(refused.status, 401);
      assert.deepEqual(errorOf(refused), { code: "UNAUTHENTICATED", message: REFUSED });
    }
    assert.deepEqual(outcomes, [["accepted", account.id], ["refused"], ["refused"]]);
    assert.equal(memoryDatabase.session.length, 1);
  });

  test("a sign-in that fails on its dependency is 503, not an audited or counted refusal", async () => {
    const { auth, memoryDatabase, outcomes } = controllerWithRecordedOutcomes();
    await auth.createAccount({ email, password });
    // Every account read now fails, as it would with the database down.
    Object.defineProperty(memoryDatabase, "user", {
      get() {
        throw new Error("database unavailable");
      },
    });
    // Nothing was refused, so nothing is audited as a refusal and no budget is spent: the
    // email lane admits ten failures, so the eleventh attempt would be 429 if these counted.
    for (let attempt = 0; attempt < 11; attempt += 1) {
      assertUnavailable(await signIn(auth, { email, password: "wrong-password-guess" }));
    }
    assert.deepEqual(outcomes, []);
  });

  test("a sign-in whose audit cannot be written is refused and its session revoked", async () => {
    const { auth, memoryDatabase } = controller({
      accepted: async () => {
        throw new Error("audit unavailable");
      },
      refused: async () => {},
    });
    await auth.createAccount({ email, password });
    const response = await signIn(auth, { email, password });
    assert.equal(response.status, 503, JSON.stringify(response.payload));
    assert.equal(response.headers["set-cookie"], undefined);
    assert.equal(memoryDatabase.session.length, 0);
  });

  for (const status of [500, 503, 599]) {
    test(`a dependency APIError ${status} is unavailable without spending the password budget`, async () => {
      const { auth, memoryDatabase, outcomes } = controllerWithRecordedOutcomes();
      const account = await auth.createAccount({ email, password });
      const users = memoryDatabase.user;
      let unavailable = true;
      Object.defineProperty(memoryDatabase, "user", {
        get() {
          if (unavailable) {
            throw new APIError(status, { message: "synthetic dependency failure" });
          }
          return users;
        },
      });
      // Eleven admitted failures distinguish an outage from the ten-failure email budget.
      for (let attempt = 0; attempt < 11; attempt += 1) {
        const response = await signIn(auth, { email, password });
        assert.equal(response.status, 503);
        assert.equal(errorOf(response).code, "DEPENDENCY_UNAVAILABLE");
        assert.equal(response.headers["set-cookie"], undefined);
      }
      assert.deepEqual(outcomes, []);
      assert.equal(memoryDatabase.session.length, 0);
      unavailable = false;
      assert.equal((await signIn(auth, { email, password })).status, 200);
      assert.deepEqual(outcomes, [["accepted", account.id]]);
    });
  }

  for (const [status, expectedStatus, expectedCode] of [
    [400, 400, "FORBIDDEN"],
    [401, 401, "UNAUTHENTICATED"],
    [409, 409, "RESOURCE_CONFLICT"],
    [429, 429, "RATE_LIMITED"],
    [499, 499, "FORBIDDEN"],
    [399, 401, "UNAUTHENTICATED"],
    [600, 401, "UNAUTHENTICATED"],
    [500.5, 401, "UNAUTHENTICATED"],
    ["500", 401, "UNAUTHENTICATED"],
  ] as const) {
    test(`dependency APIError ${JSON.stringify(status)} preserves its non-5xx classification`, async () => {
      let refusals = 0;
      const { auth, memoryDatabase } = controller({
        accepted: async () => assert.fail("a failed dependency cannot sign in"),
        refused: async () => {
          refusals += 1;
        },
      });
      await auth.createAccount({ email, password });
      Object.defineProperty(memoryDatabase, "user", {
        get() {
          throw new APIError(status, { message: "synthetic dependency failure" });
        },
      });
      const response = await signIn(auth, { email, password });
      assert.equal(response.status, expectedStatus);
      assert.equal(errorOf(response).code, expectedCode);
      assert.equal(response.headers["set-cookie"], undefined);
      assert.equal(refusals, 1);
      assert.equal(memoryDatabase.session.length, 0);
    });
  }
}
