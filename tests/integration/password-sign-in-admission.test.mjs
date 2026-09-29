import assert from "node:assert/strict";
import test from "node:test";
import {
  SignInRateLimited,
  passwordFailureAdmission,
} from "../../apps/controller/src/auth/admission.ts";

class WrongPassword extends Error {}

const slow = {
  floorMs: 20,
  maxFloorMs: 80,
  concurrentPerEmail: 2,
  waitingPerEmail: 16,
  occupancy: 1024,
  evaluating: 16,
};

function admission(overrides = {}) {
  const administrators = new Set(overrides.administrators ?? []);
  return passwordFailureAdmission({
    perAddress: 4,
    perEmail: 3,
    slow,
    countsAsFailure: (error) => error instanceof WrongPassword,
    isReserved: async (email) => administrators.has(email),
    ...overrides,
  });
}

const wrong = () => Promise.reject(new WrongPassword("wrong"));
const right = () => Promise.resolve("signed-in");

async function outcome(promise) {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}

async function status(limiter, attempt, work = wrong) {
  const { value, error } = await outcome(limiter.admit(attempt, work));
  if (error === undefined) {
    return value === "signed-in" ? 200 : value;
  }
  if (error instanceof SignInRateLimited) {
    assert.ok(error.retryAfterSeconds >= 1 && error.retryAfterSeconds <= 60);
    return 429;
  }
  if (error instanceof WrongPassword) {
    return 401;
  }
  throw error;
}

test("without a client address only the email lane applies", async () => {
  const limiter = admission();
  for (let index = 0; index < 20; index += 1) {
    assert.equal(await status(limiter, { email: `junk-${index}@example.test` }), 401);
  }
  assert.equal(await status(limiter, { email: "member@example.test" }, right), 200);
  for (let index = 0; index < 3; index += 1) {
    assert.equal(await status(limiter, { email: "member@example.test" }), 401);
  }
  assert.equal(await status(limiter, { email: "member@example.test" }, right), 429);
});

test("refused attempts create no entries, so flooding cannot reset spent budgets", async () => {
  const limiter = admission({ tableCapacity: 8 });
  const target = { clientAddress: "203.0.113.1", email: "member@example.test" };
  for (let index = 0; index < 3; index += 1) {
    assert.equal(await status(limiter, target), 401);
  }
  assert.equal(await status(limiter, target), 429);
  for (let index = 0; index < 4; index += 1) {
    assert.equal(
      await status(limiter, { clientAddress: "203.0.113.2", email: `b-${index}@example.test` }),
      401,
    );
  }
  const flood = await Promise.all(
    Array.from({ length: 200 }, (_, index) =>
      status(limiter, { clientAddress: "203.0.113.2", email: `flood-${index}@example.test` }),
    ),
  );
  assert.deepEqual(new Set(flood), new Set([429]));
  assert.equal(await status(limiter, target), 429);
  assert.equal(
    await status(limiter, { clientAddress: "203.0.113.3", email: "member@example.test" }, right),
    429,
  );
});

test("a full table never evicts spent entries and slows new keys instead of refusing", async () => {
  const limiter = admission({ tableCapacity: 4 });
  // Two addresses each spend one failure on a distinct email: four spent entries.
  for (const index of [1, 2]) {
    assert.equal(
      await status(limiter, {
        clientAddress: `203.0.113.${index}`,
        email: `x-${index}@example.test`,
      }),
      401,
    );
  }
  const started = performance.now();
  assert.equal(
    await status(limiter, { clientAddress: "198.51.100.9", email: "member@example.test" }, right),
    200,
  );
  assert.ok(performance.now() - started >= slow.floorMs - 2, "untracked attempts are paced");
  assert.equal(
    await status(limiter, { clientAddress: "198.51.100.9", email: "member@example.test" }),
    401,
  );
  // The spent entries survived: x-1 still carries its failure toward its budget.
  for (let index = 0; index < 2; index += 1) {
    assert.equal(
      await status(limiter, { clientAddress: "203.0.113.1", email: "x-1@example.test" }),
      401,
    );
  }
  assert.equal(
    await status(limiter, { clientAddress: "203.0.113.1", email: "x-1@example.test" }, right),
    429,
  );
});

test("an administrator is slowed, never refused, and slow guesses are bounded", async () => {
  const email = "admin@example.test";
  const limiter = admission({ administrators: [email] });
  for (let index = 0; index < 3; index += 1) {
    assert.equal(await status(limiter, { clientAddress: `203.0.113.${index}`, email }), 401);
  }
  let running = 0;
  let peak = 0;
  const guess = async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 2));
    running -= 1;
    throw new WrongPassword("wrong");
  };
  const guesses = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      status(limiter, { clientAddress: `203.0.114.${index}`, email }, guess),
    ),
  );
  assert.deepEqual(new Set(guesses), new Set([429]));
  assert.ok(peak <= slow.concurrentPerEmail, `peak ${peak}`);
  const started = performance.now();
  assert.equal(await status(limiter, { clientAddress: "198.51.100.1", email }, right), 200);
  assert.ok(performance.now() - started >= slow.maxFloorMs - 2, "the floor grew to its cap");
});

test("refusals take the growing floor whether or not the email administers", async () => {
  const limiter = admission({ administrators: ["admin@example.test"] });
  const client = "203.0.113.9";
  for (let index = 0; index < 4; index += 1) {
    assert.equal(await status(limiter, { clientAddress: client, email: `f-${index}@x.test` }), 401);
  }
  const expected = [20, 40, 80, 80];
  const emails = ["member@x.test", "admin@example.test", "missing@x.test", "admin@example.test"];
  for (const [index, email] of emails.entries()) {
    const started = performance.now();
    assert.equal(await status(limiter, { clientAddress: client, email }), 429);
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= expected[index] - 2, `refusal ${index}: ${elapsed} ms`);
    assert.ok(elapsed < expected[index] + 60, `refusal ${index}: ${elapsed} ms`);
  }
});

test("a failing administrator lookup surfaces as a dependency error", async () => {
  const outage = new Error("database unavailable");
  const limiter = admission({
    isReserved: async () => {
      throw outage;
    },
  });
  const email = "someone@example.test";
  for (let index = 0; index < 3; index += 1) {
    assert.equal(await status(limiter, { email }), 401);
  }
  const { error } = await outcome(limiter.admit({ email }, right));
  assert.equal(error, outage);
});
