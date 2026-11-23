import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createRepositorySourceCustody } from "../../apps/controller/src/backends/repository-credentials/source-custody.ts";

// The PostgreSQL behaviour of the hold (the row lock against replacement and retirement, the
// server ending an idle hold) is in tests/integration/postgres-repository-source-custody.test.ts.
// These cases pin what the Worker asks of the session and how it reacts to losing it.

class FakeClient extends EventEmitter {
  readonly queries: { text: string; values?: readonly unknown[] }[] = [];
  released: boolean | undefined;
  fail: ((text: string) => Error | undefined) | undefined;
  async query(text: string, values?: readonly unknown[]) {
    this.queries.push({ text, ...(values && { values }) });
    const error = this.fail?.(text);
    if (error) {
      throw error;
    }
    return /FOR SHARE/.test(text)
      ? {
          rows: [
            {
              state: "ready",
              config: { provider_preset: "github", repositories: "fixture/a:write" },
              owned: true,
              installation_id: "installation-a",
              token_service_instance_id: "tsi-a",
            },
          ],
          rowCount: 1,
        }
      : { rows: [], rowCount: 0 };
  }
  release(discard?: boolean) {
    assert.equal(this.released, undefined, "a client is returned once");
    this.released = discard === true;
  }
}

function custody(holdLimitMs?: number) {
  const clients: FakeClient[] = [];
  const source = createRepositorySourceCustody({
    lockPool: {
      async connect() {
        const client = new FakeClient();
        clients.push(client);
        return client;
      },
      async end() {},
    },
    state: {} as never,
    tokenServiceDriverId: "occ",
    tokenService: () => assert.fail("not read"),
    iam: { authorize: async () => assert.fail("not asked") },
    ...(holdLimitMs !== undefined && { holdLimitMs }),
  });
  const ref = { namespaceId: "namespace-a", sourceId: "cs_fixture_token" };
  const lock = async () => {
    const locked = await source.lock(ref);
    assert.ok(locked, "the row is locked");
    return locked;
  };
  return { clients, lock };
}

const settings = (client: FakeClient) => {
  const set = client.queries.find(({ text }) => /set_config\('lock_timeout'/.test(text));
  assert.ok(set, "the hold transaction sets its limits");
  return set;
};

test("a Source hold bounds its lock wait, its statements and its idle time on the session", async () => {
  const { clients, lock } = custody();
  const { hold } = await lock();
  const [client] = clients;
  assert.ok(client);
  assert.deepEqual(
    client.queries.map(({ text }) => text.trim().split(/\s+/)[0]),
    ["BEGIN", "SELECT", "SELECT"],
  );
  const set = settings(client);
  assert.match(set.text, /set_config\('statement_timeout', \$2, true\)/);
  assert.match(set.text, /set_config\('idle_in_transaction_session_timeout', \$3, true\)/);
  assert.deepEqual(set.values, ["2000ms", "5000ms", "60000ms"]);
  assert.equal(hold.held(), true);
  await hold.release();
  assert.equal(hold.held(), false);
  assert.equal(client.queries.at(-1)?.text, "COMMIT");
  assert.equal(client.released, false, "a committed hold returns its connection");
});

test("a Source hold ends when its session is lost, and confirms only on a live session", async () => {
  for (const event of ["error", "end"] as const) {
    const { clients, lock } = custody();
    const { hold } = await lock();
    const [client] = clients;
    assert.ok(client);
    // PostgreSQL ending the idle session reaches the client as an error, then an end.
    client.emit(event, new Error("terminating connection due to idle-in-transaction timeout"));
    assert.equal(hold.held(), false, `${event}: the hold ends with its session`);
    assert.equal(client.released, true, `${event}: the lost connection is discarded`);
    const queries = client.queries.length;
    assert.equal(await hold.confirm(), false);
    await hold.release();
    assert.equal(client.queries.length, queries, `${event}: nothing more is sent on it`);
    assert.equal(client.listenerCount("error"), 0);
    assert.equal(client.listenerCount("end"), 0);
  }

  // A live session confirms with a round trip that leaves it idle only for the rest of the limit.
  {
    const { clients, lock } = custody();
    const { hold } = await lock();
    const [client] = clients;
    assert.ok(client);
    assert.equal(await hold.confirm(), true);
    const confirm = client.queries.at(-1);
    assert.match(
      confirm?.text ?? "",
      /set_config\('idle_in_transaction_session_timeout', \$1, true\)/,
    );
    const remaining = Number(/^(\d+)ms$/.exec(String(confirm?.values?.[0]))?.[1]);
    assert.ok(remaining > 0 && remaining <= 60_000, String(confirm?.values?.[0]));
    assert.equal(hold.held(), true);
    await hold.release();
  }

  // The database already ended the session, but the client has not seen it yet: the round trip
  // fails, and the hold ends before anything is written under it.
  {
    const { clients, lock } = custody();
    const { hold } = await lock();
    const [client] = clients;
    assert.ok(client);
    client.fail = (text) =>
      /idle_in_transaction|COMMIT/.test(text) ? new Error("Connection terminated") : undefined;
    assert.equal(hold.held(), true, "locally the hold still looks held");
    assert.equal(await hold.confirm(), false);
    assert.equal(hold.held(), false);
    assert.equal(client.released, true);
  }
});

test("a Source hold is over at its limit even before its timer runs", async () => {
  const { clients, lock } = custody(25);
  const { hold } = await lock();
  assert.deepEqual(settings(clients[0]!).values, ["2000ms", "5000ms", "25ms"]);
  // A frozen Worker resumes in synchronous code: the timer has not fired, the limit has passed.
  const until = performance.now() + 40;
  while (performance.now() < until) {
    // Spin without yielding to the event loop.
  }
  assert.equal(hold.held(), false);
  assert.equal(await hold.confirm(), false);
  assert.equal(clients[0]!.released, false, "the Worker still commits the hold it ended");
});

test("a Source lock reports an ended lock wait apart from other failures", async () => {
  const clients: FakeClient[] = [];
  const failing = (error: Error) =>
    createRepositorySourceCustody({
      lockPool: {
        async connect() {
          const client = new FakeClient();
          client.fail = (text) => (/FOR SHARE/.test(text) ? error : undefined);
          clients.push(client);
          return client;
        },
        async end() {},
      },
      state: {} as never,
      tokenServiceDriverId: "occ",
      tokenService: () => assert.fail("not read"),
      iam: { authorize: async () => assert.fail("not asked") },
    });
  const ref = { namespaceId: "namespace-a", sourceId: "cs_fixture_token" };
  const waited = Object.assign(new Error("canceling statement due to lock timeout"), {
    code: "55P03",
  });
  assert.equal(await failing(waited).lock(ref), undefined);
  await assert.rejects(failing(new Error("Connection terminated")).lock(ref), /terminated/);
  for (const client of clients) {
    assert.equal(client.queries.at(-1)?.text, "ROLLBACK");
    assert.equal(client.released, true);
  }
});
