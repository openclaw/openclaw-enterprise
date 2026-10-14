import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createCliSignIn } from "../../apps/controller/src/auth/cli-sign-in.ts";

function makeService(store) {
  return createCliSignIn({
    store,
    settings: { enabled: true, maxLifetimeSeconds: 900 },
    clientAddressOf: (request) => request.address,
    browserSession: async (request) => ({
      userId: request.user,
      id: "browser-session",
      expiresAt: new Date(Date.now() + 60_000),
    }),
  });
}

async function invoke(
  service,
  method,
  user = "person-a",
  address = "192.0.2.1",
  userCode = "BCDF-GHJK",
) {
  const request = {
    id: "request",
    headers: {},
    user,
    address,
    body: { userCode, decision: "deny" },
  };
  const reply = {
    header() {
      return this;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    },
  };
  await service[method](request, reply);
  return reply;
}

async function promptly(result) {
  let timer;
  try {
    return await Promise.race([
      result,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("admission did not settle")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("CLI code lookup and decision reserve the shared budget before persistence", async () => {
  const waiters = [];
  const hold = () => new Promise((resolve) => waiters.push(resolve));
  const service = makeService({ lookup: hold, decide: hold });
  const pending = ["lookup", "decide", "lookup", "decide", "lookup"].map((method) =>
    invoke(service, method),
  );
  await setImmediate();
  assert.equal(waiters.length, 5);
  const sameAccount = invoke(service, "lookup", "person-a", "192.0.2.2");
  const sameAddress = invoke(service, "decide", "person-b", "192.0.2.1");
  const unrelated = invoke(service, "lookup", "person-b", "192.0.2.2");
  await setImmediate();
  try {
    // Only the unrelated account and address may reach persistence while the first five wait.
    assert.equal(waiters.length, 6);
    assert.equal((await promptly(sameAccount)).statusCode, 429);
    assert.equal((await promptly(sameAddress)).statusCode, 429);
  } finally {
    for (const release of waiters) {
      release(undefined);
    }
    await Promise.all([...pending, sameAccount, sameAddress, unrelated]);
  }
  assert.equal((await invoke(service, "lookup")).statusCode, 429);
});

test("successful CLI code lookups do not spend the wrong-code budget", async () => {
  let found = true;
  const record = {
    clientLabel: "local",
    requesterAddress: "192.0.2.1",
    expiresAt: new Date(Date.now() + 60_000),
  };
  const service = makeService({ lookup: async () => (found ? record : undefined) });
  for (let i = 0; i < 8; i += 1) {
    assert.equal((await invoke(service, "lookup")).statusCode, 200);
  }
  found = false;
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await invoke(service, "lookup")).statusCode, 404);
  }
  assert.equal((await invoke(service, "lookup")).statusCode, 429);
});

test("a failed CLI code lookup releases its reservation", async () => {
  let unavailable = true;
  const record = {
    clientLabel: "local",
    requesterAddress: "192.0.2.1",
    expiresAt: new Date(Date.now() + 60_000),
  };
  const service = makeService({
    async lookup() {
      if (unavailable) {
        throw new Error("store unavailable");
      }
      return record;
    },
  });
  for (let i = 0; i < 8; i += 1) {
    assert.equal((await invoke(service, "lookup")).statusCode, 503);
  }
  unavailable = false;
  assert.equal((await invoke(service, "lookup")).statusCode, 200);
});

test("malformed CLI codes spend budget without reaching persistence", async () => {
  let calls = 0;
  const service = makeService({
    lookup: async () => {
      calls += 1;
    },
  });
  for (let i = 0; i < 5; i += 1) {
    assert.equal(
      (await invoke(service, "lookup", "person-a", "192.0.2.1", "invalid")).statusCode,
      404,
    );
  }
  assert.equal(
    (await invoke(service, "lookup", "person-a", "192.0.2.1", "invalid")).statusCode,
    429,
  );
  assert.equal(calls, 0);
});

test("pending CLI code checks remain reserved across a budget window", async () => {
  const original = Object.getOwnPropertyDescriptor(performance, "now");
  let now = 0;
  Object.defineProperty(performance, "now", { configurable: true, value: () => now });
  const waiters = [];
  let hold = true;
  const service = makeService({
    lookup: () => (hold ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()),
  });
  const pending = Array.from({ length: 5 }, () => invoke(service, "lookup"));
  try {
    await setImmediate();
    assert.equal(waiters.length, 5);
    now = 61_000;
    assert.equal((await promptly(invoke(service, "lookup"))).statusCode, 429);
    for (const release of waiters) {
      release(undefined);
    }
    await Promise.all(pending);
    hold = false;
    assert.equal((await invoke(service, "lookup")).statusCode, 429);
    now = 122_000;
    assert.equal((await invoke(service, "lookup")).statusCode, 404);
  } finally {
    for (const release of waiters) {
      release(undefined);
    }
    await Promise.all(pending);
    if (original === undefined) {
      delete performance.now;
    } else {
      Object.defineProperty(performance, "now", original);
    }
  }
});
