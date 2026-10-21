import assert from "node:assert/strict";
import { deserialize, serialize } from "node:v8";
import { createHash, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { isDeepStrictEqual } from "node:util";
import type {
  Agent,
  Namespace,
  Secret,
  CredentialProviderDefinition,
  PreparedTokenGrant,
  PreparedTokenIssuer,
  PreparedTokenSource,
} from "../../packages/contracts/src/index.ts";
import { TokenService } from "../../apps/controller/src/backends/token-service/service.ts";
import { createTokenPreparation } from "../../apps/controller/src/backends/token-service/preparation.ts";
import type {
  TokenAdmission,
  TokenAttempt,
  TokenFamily,
  TokenPreparationStore,
} from "../../apps/controller/src/backends/token-service/custody.ts";
import { retireToken } from "../../apps/controller/src/backends/token-service/retirement.ts";
import { createWarmTokenReader } from "../../apps/controller/src/backends/token-service/warm-reader.ts";
import { bindRuntimeSource } from "../helpers/postgres-protected-scenarios.mjs";
import { postgresApp } from "../helpers/postgres-egress-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { captureMetadata } from "../helpers/github-metadata-exchange.mjs";
import { staticEgressFixture } from "../helpers/static-egress.mjs";

const ref = { id: "fixture-artifact-lease", generation: 1 };
const origin = "https://artifact.example.test";
function grant(config: Readonly<Record<string, string>>): PreparedTokenGrant {
  assert.equal(config.channel, "build-notes");
  return {
    kind: "prepared_scope",
    isolationId: config.agent_id!,
    scope: { channel: config.channel },
  };
}
const provider: CredentialProviderDefinition = {
  ref,
  schemaVersion: 1,
  sourceType: {
    type: ref.id,
    rotation: "none",
    config: ["channel", "agent_id"].map((name) => ({ name, required: true })),
    secrets: [{ name: "lease_key", required: true }],
  },
  normalizeConfig: (c) => c,
  normalizeGrant: (_models, c) => grant(c!),
  routes(source, binding) {
    const e = source.egress;
    assert(e?.adoption === "prepared" && e.schemaVersion === 4);
    assert.equal(binding.isolationId, e.grant.isolationId);
    assert.deepEqual(binding.grant, e.grant);
    return [
      {
        origin,
        method: "GET",
        path: "/channels/build-notes",
        binding,
        route: binding.binding,
        operationPolicy: ref,
        responsePolicy: ref,
        deadlineMs: 30_000,
      },
    ];
  },
  classify(route, r) {
    return r.method === "GET" && !r.body.length && r.url === origin + route.path
      ? { kind: "prepared_scope", action: "read-channel" }
      : undefined;
  },
  inject: (value) => [["authorization", "Lease " + value]],
  credentialRejected: () => false,
  protectResponse: () => undefined,
};

// The issuer and its bytes are synthetic. OCC admission, current IAM, signed transport, the
// custody row lock and possible-use receipt are real. No Agent or second production issuer.
test(
  "independent prepared lease: cold read, replace, exact transaction, withdrawal and lost issue",
  requiresPostgres,
  async (t) => {
    let service!: TokenService;
    type App = Awaited<ReturnType<typeof postgresApp>>;
    let app!: App;
    let pool!: App["pool"];
    let admitted!: PreparedTokenSource;
    let family!: TokenAdmission;
    // Only this fixture's synthetic bytes live in the temporary table. Both maintenance and the
    // send proof lock this very row. The production GitHub tests exercise its encrypted custody.
    type Attempt = TokenAttempt<TokenAdmission> & {
      retirement?: "retiring" | "retired" | "unknown";
    };
    type Family = Omit<TokenFamily<TokenAdmission>, "attempts"> & { attempts: Attempt[] };
    const store = {
      async readCurrent<T>(id: string, select: (row: Family | undefined) => T) {
        const { rows } = await pool.query("SELECT ledger FROM artifact_custody WHERE id=$1", [id]);
        return select(rows[0] && (deserialize(rows[0].ledger) as Family));
      },
      async transact<T>(
        id: string,
        update: (row: Family, allocateMaterialVersion: () => string) => T,
      ) {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          const { rows } = await c.query(
            "SELECT ledger FROM artifact_custody WHERE id=$1 FOR UPDATE",
            [id],
          );
          const row = deserialize(rows[0].ledger) as Family;
          const previous = row.committed;
          const result = update(row, randomUUID);
          const material = row.committed;
          // Keep cleanup custody on the issuing attempt, even after another lease replaces it.
          if (material && material !== previous) {
            const attempt = row.attempts.find((a) => a.id === material.attemptId)!;
            attempt.candidate = material.bytes;
          }
          await c.query("UPDATE artifact_custody SET ledger=$1,version=$2 WHERE id=$3", [
            serialize(row),
            material?.materialVersion ?? null,
            id,
          ]);
          await c.query("COMMIT");
          return result;
        } catch (error) {
          await c.query("ROLLBACK");
          throw error;
        } finally {
          c.release();
        }
      },
    } satisfies TokenPreparationStore<TokenAdmission>;
    let proofTx: string | undefined;
    const issuerAuthority = "fixture-artifact-issuer";
    const issuer: PreparedTokenIssuer = {
      provider: ref,
      issuerInput: "lease_key",
      issuerAuthority,
      admission: (config) => ({ origin, grant: grant(config), schemaVersion: 4 }),
      sourceFromRoute(route, { sender, resolver }) {
        const { binding } = route;
        if (
          binding.grant.kind !== "prepared_scope" ||
          binding.grant.isolationId !== binding.execution.agentId ||
          binding.isolationId !== binding.execution.agentId ||
          route.origin !== origin ||
          route.method !== "GET" ||
          route.path !== "/channels/build-notes"
        ) {
          return;
        }
        return {
          key: binding.source,
          grant: binding.grant,
          origin,
          schemaVersion: 4,
          adoption: "prepared",
          retention: "none",
          sender,
          resolver,
        };
      },
      async configure(source, secret) {
        assert.equal(secret.name, "provider-key");
        admitted = source;
        const { id: familyId, generation } = source.key.source;
        family = {
          familyId,
          generation,
          inputVersion: "input-1",
          ownerEpoch: 1,
          issuerAuthority,
          grant: {
            ...source.grant,
            id: createHash("sha256").update(JSON.stringify(source.grant)).digest("hex"),
          },
        };
        await pool.query(
          "CREATE TEMP TABLE artifact_custody (id text, source jsonb, authority text, ledger bytea, version text)",
        );
        const initial: Family = {
          admission: family,
          admittedGrantCount: 1,
          enabled: true,
          attempts: [],
        };
        await pool.query(
          "INSERT INTO artifact_custody(id,source,authority,ledger) VALUES ($1,$2,$3,$4)",
          [familyId, source, issuerAuthority, serialize(initial)],
        );
      },
      async readWarm(source) {
        assert.deepEqual(source, admitted);
        const warm = await createWarmTokenReader(store, Date.now).readWarm(family);
        if (warm.kind !== "warm") {
          return;
        }
        const m = warm.material;
        try {
          return {
            value: Buffer.from(m.bytes).toString(),
            family: source.key.source,
            materialId: family.familyId,
            inputVersion: family.inputVersion,
            ownerEpoch: family.ownerEpoch,
            preparationAttemptId: m.attemptId,
            materialVersion: m.materialVersion,
            providerExpiresAt: new Date(m.providerExpiresAt).toISOString(),
            usableUntil: new Date(m.usableUntil).toISOString(),
          };
        } finally {
          m.bytes.fill(0);
        }
      },
      async ready() {
        return (await createWarmTokenReader(store, Date.now).readWarm(family)).kind === "warm";
      },
      async withdraw(source) {
        assert.deepEqual(source, admitted);
        await store.transact(source.key.source.id, (row) => {
          row.enabled = false;
          delete row.committed;
        });
      },
    };
    const options = {
      protectedSourceOnly: true,
      configurePreparedTokens(tokens: TokenService) {
        service = tokens;
        tokens.register(issuer, (tx) => ({
          async current(s, ev, authority, { signal, deadlineAt }) {
            assert(!signal.aborted && Date.parse(deadlineAt) > Date.now());
            assert.equal(ev.kind, "prepared_token");
            assert(isDeepStrictEqual(ev.source, s.key) && ev.grantHash === family.grant.id);
            const { rows } = await tx.query(
              "SELECT pg_current_xact_id()::text AS tx FROM artifact_custody WHERE source=$1 AND authority=$2 AND version=$3 FOR SHARE",
              [s, authority, ev.materialVersion],
            );
            proofTx = (rows[0] as { tx: string } | undefined)?.tx;
            return Boolean(proofTx);
          },
        }));
        assert.equal(
          tokens.issuer({ ...ref, generation: 2 }),
          undefined,
          "another issuer generation cannot adopt this family",
        );
        return provider;
      },
      async appFactory(t: TestContext, opts: Record<string, unknown>) {
        app = await postgresApp(t, { ...opts, poolOptions: { max: 1 } }, undefined);
        pool = app.pool;
        return app;
      },
      async admitSource({
        app,
        agent,
        namespace,
        secret,
        path,
      }: {
        app: Awaited<ReturnType<typeof postgresApp>>;
        agent: Agent;
        namespace: Namespace;
        secret: Secret & { ref: unknown };
        path: string;
      }) {
        const catalog = await app.request("GET", "/installation", {});
        assert.equal(catalog.status, 200);
        assert(
          catalog.data.capabilities.credentialSources.types.some(
            (entry: { type: string }) => entry.type === ref.id,
          ),
          "installed issuer absent from source catalog",
        );
        const created = await app.request("POST", path, {
          body: {
            name: "artifact-feed",
            type: ref.id,
            config: { channel: "build-notes", agent_id: agent.id },
            secrets: { lease_key: secret.ref },
          },
        });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        return bindRuntimeSource(app, namespace, agent, created.data);
      },
    };
    // The existing JS fixture supports both the in-memory console and this PostgreSQL app.
    const f = await staticEgressFixture(
      t,
      options as unknown as Parameters<typeof staticEgressFixture>[1],
    );
    assert("resolve" in f, "the fixture must run revision admission");
    const select = async (change = {}) => {
      const captured = captureMetadata(f, change);
      const { ready, refused } = await f.resolve(captured);
      return {
        captured,
        ready,
        refused,
        authorize: () => f.authorize(f.permitRequest(captured, ready)),
      };
    };
    const revision = f.revision!;
    assert.equal(revision.credentialSources[0].credentialProxyId, f.egress!.id);
    assert.equal(
      (await select({ target: { path: "/channels/private" } })).refused.code,
      f.refusalCode!("DENIED"),
    );
    assert.equal(
      (await select()).refused.code,
      f.refusalCode!("NOT_READY"),
      "cold use cannot prepare material",
    );

    let issues = 0;
    const familyId = family.familyId;
    const retirements: string[] = [];
    const retirementReplyLost = new Error("fixture issuer retirement reply lost");
    const worker = service.ownFamilies({
      async discover(signal) {
        const withdrawn = await app.state.read(({ credentialSources }) =>
          credentialSources.findCredentialWithdrawal(revision.namespaceId, revision.id, familyId),
        );
        if (withdrawn) {
          await issuer.withdraw(admitted, signal);
        }
      },
      retire: () =>
        retireToken(
          {
            takeRetirement: () =>
              store.transact(familyId, (row) => {
                const due = row.attempts.find((a) => !row.enabled && a.candidate && !a.retirement);
                if (due?.candidate) {
                  due.retirement = "retiring";
                  return { id: due.id, admission: due.admission, bytes: due.candidate.slice() };
                }
              }),
            finishRetirement: (id, revoked) =>
              store.transact(familyId, (row) => {
                const attempt = row.attempts.find((a) => a.id === id)!;
                assert.equal(attempt.retirement, "retiring");
                attempt.retirement = revoked ? "retired" : "unknown";
                if (revoked) {
                  delete attempt.candidate;
                }
              }),
          },
          familyId,
          async ({ bytes }) => {
            retirements.push(Buffer.from(bytes).toString());
            if (retirements.length === 2) {
              throw retirementReplyLost;
            }
            return true;
          },
        ),
      async prepare(_signal, run) {
        if (!(await store.readCurrent(familyId, (row) => row?.enabled))) {
          return;
        }
        return run(
          createTokenPreparation({
            admission: family,
            store,
            clock: { wallNow: Date.now, monotonicNow: () => performance.now() },
            renewBeforeMs: 90_000,
            minimumValidityMs: 1_000,
            async issue({ assertIssuing, capture }) {
              await assertIssuing();
              if (++issues === 3) {
                throw new Error("fixture issuer reply lost");
              }
              capture(Buffer.from("fixture-only-" + issues));
              const until = Date.now() + 60_000;
              return { usableUntil: until, providerExpiresAt: until };
            },
          }),
        );
      },
      failed: () => assert.fail("fixture maintenance failed"),
    });
    t.after(() => worker.close());
    assert.equal(await worker.maintain(), "committed");
    const before = await select();
    assert(before.ready);
    assert.equal(await worker.maintain(), "committed");
    const assertDenied = async (
      selection: typeof before,
      reason: "stale_configuration" | "withdrawn",
    ) => {
      assert.equal((await selection.authorize()).refused?.code, f.refusalCode!("DENIED"));
      const { rows } = await pool.query(
        "SELECT authorized_dispatch AS dispatch, outcome FROM occ.egress_send_receipts WHERE use_id=$1",
        [selection.captured.request.context.request_id],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].dispatch, null, "denied use recorded a possible dispatch");
      assert.deepEqual(rows[0].outcome, {
        kind: "refused",
        dispatched: false,
        error: { kind: "denied", code: reason },
      });
    };
    await assertDenied(before, "stale_configuration");
    const next = await select();
    assert((await next.authorize()).allowed);
    const {
      rows: [receipt],
    } = await pool.query(
      "SELECT xmin::text AS tx FROM occ.egress_send_receipts WHERE use_id=$1 AND authorized_dispatch IS NOT NULL",
      [next.captured.request.context.request_id],
    );
    assert(
      proofTx && receipt?.tx === proofTx,
      "current material lock must be in the transaction that committed permission",
    );
    assert.equal(issues, 2, "only preparation may contact this issuer");
    assert.equal(await worker.maintain(), "quarantined");
    assert.equal(await worker.maintain(), "blocked");
    assert.equal(issues, 3, "an ambiguous issuance must not be replayed");

    const held = await select();
    assert(held.ready);
    const withdrawal = await app.controller.withdrawAgentCredentialSource(app.principal.id, {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      credentialSourceId: familyId,
    });
    assert.equal(withdrawal.revisionId, revision.id);
    assert.equal(withdrawal.state, "pending");
    await assertDenied(held, "withdrawn");
    assert.equal(retirements.length, 0, "new use is denied before provider retirement");

    assert.equal(await worker.maintain(), "retired");
    await assert.rejects(worker.maintain(), (error: unknown) => error === retirementReplyLost);
    assert.equal(await worker.maintain(), "idle", "never replay either retirement");
    assert.deepEqual(retirements, ["fixture-only-1", "fixture-only-2"]);
    const custody = await store.readCurrent(familyId, (row) => {
      assert(row && !row.enabled && !row.committed);
      return row.attempts.map(({ state, retirement, candidate }) => [
        retirement ?? state,
        candidate && Buffer.from(candidate).toString(),
      ]);
    });
    assert.deepEqual(custody, [
      ["retired", undefined],
      ["unknown", "fixture-only-2"],
      ["quarantined", undefined],
    ]);
    assert.equal(issues, 3, "withdrawal must not replace a lease or replay the lost issuance");
  },
);
