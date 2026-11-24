import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createRepositorySourceCustody } from "../../apps/controller/src/backends/repository-credentials/source-custody.ts";
import { startWorkerRepositorySourceCustody } from "../../apps/controller/src/worker/repository-source-custody.ts";

type WorkerSourceOptions = Parameters<typeof startWorkerRepositorySourceCustody>[0];

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
  return { clients, lock, source, ref };
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
  // The deadline and the Provider can release the same hold while COMMIT is in flight.
  await Promise.all([hold.release(), hold.release()]);
  assert.equal(clients[0]!.queries.filter(({ text }) => text === "COMMIT").length, 1);
  assert.equal(hold.held(), false);
  assert.equal(client.queries.at(-1)?.text, "COMMIT");
  assert.equal(client.released, false, "a committed hold returns its connection");
});

test("a Source lock gives the caller's transaction the hold limit before it takes the row", async () => {
  // The native store reads the loan inside its own transaction, which holds the Namespace row
  // that replacement and retirement lock first: a frozen Worker must not keep it past the hold.
  for (const holdLimitMs of [undefined, 1500]) {
    const { clients, source, ref } = custody(holdLimitMs);
    const steps: string[] = [];
    const locked = await source.lock(ref, {
      async limitIdle(ms) {
        steps.push(`limit ${ms}`);
        assert.equal(clients.length, 0, "the caller is limited before the hold is taken");
      },
    });
    assert.ok(locked?.source);
    assert.deepEqual(steps, [`limit ${holdLimitMs ?? 60_000}`]);
    await locked.hold.release();
  }
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

test("the Worker builds Source custody only when a registration names a Source", async () => {
  const registration = (credentialSource?: string) => ({
    repositoryRef: "fixture",
    repositoryId: "73",
    repository: "fixture/a",
    namespaces: [
      {
        namespaceId: "team",
        profiles: ["github-repository" as const],
        nativeGit: "v1" as const,
        ...(credentialSource !== undefined && { credentialSource }),
      },
    ],
  });
  const registry = (credentialSource?: string) =>
    ({
      version: 1,
      backendId: "github",
      providerInstanceId: "github-instance",
      appId: "1",
      githubInstallationId: "2",
      maximumDurationSeconds: 3600,
      repositories: [registration(credentialSource)],
    }) as unknown as WorkerSourceOptions["registry"];
  const built: string[] = [];
  const pool = { end: async () => {} } as unknown as Awaited<
    ReturnType<WorkerSourceOptions["createLockPool"]>
  >;
  const start = (selected: Partial<WorkerSourceOptions>) =>
    startWorkerRepositorySourceCustody({
      registry: registry(),
      tokenService: { id: "occ" } as WorkerSourceOptions["tokenService"],
      secrets: {} as WorkerSourceOptions["secrets"],
      createLockPool: async () => (built.push("lock pool"), pool),
      createState: () =>
        (built.push("state"), {}) as ReturnType<WorkerSourceOptions["createState"]>,
      createIAMDriver: () => (
        built.push("IAM driver"),
        {} as ReturnType<WorkerSourceOptions["createIAMDriver"]>
      ),
      ...selected,
    });
  // TokenService and installation Secrets selected, no registration names a Source.
  assert.equal(await start({}), undefined);
  assert.equal(await start({ registry: undefined }), undefined);
  assert.deepEqual(built, [], "an App-only install constructs no Source machinery");
  // A Source without TokenService or installation Secrets has no custody to read.
  assert.equal(await start({ registry: registry("cs_one"), tokenService: undefined }), undefined);
  assert.equal(await start({ registry: registry("cs_one"), secrets: undefined }), undefined);
  assert.deepEqual(built, []);
  const source = await start({ registry: registry("cs_one") });
  assert.ok(source?.custody);
  assert.equal(source.lockPool, pool);
  assert.deepEqual(built, ["state", "IAM driver", "lock pool"]);
});
