import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { request } from "node:https";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import test, { type TestContext } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { deserialize, serialize } from "node:v8";
import type {
  Agent,
  Namespace,
  Secret,
  CredentialProviderDefinition,
  PreparedTokenGrant,
  PreparedTokenIssuer,
  PreparedTokenSource,
  PreparedGitHubEgressSource,
  SecretDriver,
} from "../../packages/contracts/src/index.ts";
import type { readPreparedGitHubMetadata } from "../../packages/occ/src/index.ts";
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
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { githubMetadataProvider } from "../../apps/controller/src/drivers/egress-proxy/github-metadata.ts";
import type { GitHubPreparationAdmission } from "../../apps/controller/src/drivers/repo/github/credentials/prepared-contracts.ts";
import { PostgresPreparedGitHubLifecycle } from "../../apps/controller/src/drivers/repo/github/credentials/prepared-lifecycle.ts";
import { PreparedGitHubPostgres } from "../../apps/controller/src/drivers/repo/github/credentials/prepared-postgres.ts";
import {
  EgressSendReceipts,
  type SendAttempt,
} from "../../packages/occ/src/egress-send-receipts.ts";
import { bindRuntimeSource } from "../helpers/postgres-protected-scenarios.mjs";
import { postgresApp } from "../helpers/postgres-egress-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import {
  captureMetadata,
  dispatchMetadata,
  raceMaintenance,
} from "../helpers/github-metadata-exchange.mjs";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.mjs";
import { staticEgressFixture } from "../helpers/static-egress.mjs";
import { temporaryDirectory } from "../fixtures/repository-credentials/process.mjs";
import {
  startGitHubFixture,
  fixtureAppId,
  fixtureInstallationId,
  fixtureRepositoryId,
  fixtureRepository,
} from "../fixtures/repository-credentials/github.mjs";

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

// Unlike the synthetic independent issuer above, this case uses the production GitHub
// lifecycle and encrypted PostgreSQL custody. Only upstream issuance and trusted rejection
// classification are fixtures; source admission, signed dispatch and receipt commits are real.
test(
  "rejected fresh GitHub material recovers once across separate owners without replay",
  requiresPostgres,
  async (t) => {
    const directory = await temporaryDirectory(t, "prepared-rejection-");
    const key = join(directory, "custody.key");
    const custodyKey = randomBytes(32);
    await writeFile(key, custodyKey, { mode: 0o600 });
    // The JavaScript fixture forwards these issuer options to its protocol implementation.
    const startIssuer: (
      context: TestContext,
      options: object,
    ) => ReturnType<typeof startGitHubFixture> = startGitHubFixture;
    const gh = await startIssuer(t, {
      tokenLifetimeMs: 45 * 60_000,
    });
    let lifecycle!: PostgresPreparedGitHubLifecycle;
    let tokens!: TokenService;
    let secretDriver!: SecretDriver;
    let source!: PreparedGitHubEgressSource;
    let app!: Awaited<ReturnType<typeof postgresApp>>;
    let trustedRejection = false;
    const createOwner = (tokens?: TokenService) =>
      new PostgresPreparedGitHubLifecycle(key, secretDriver, gh.origin, gh.tls.ca, tokens);
    const options = {
      secretValue: gh.privateKey.export({ format: "pem", type: "pkcs8" }),
      protectedSourceOnly: true,
      // Substitute only the independent trusted classification, never infer it from a 401.
      configurePreparedTokens: () => ({
        ...githubMetadataProvider,
        credentialRejected: () => trustedRejection,
      }),
      createPreparedGitHub(opts: { secretDriver: SecretDriver; tokenService: TokenService }) {
        secretDriver = opts.secretDriver;
        tokens = opts.tokenService;
        lifecycle = createOwner(tokens);
        return lifecycle;
      },
      async appFactory(context: TestContext, opts: Record<string, unknown>) {
        app = await postgresApp(context, opts, undefined);
        await lifecycle.connect(app.pool);
        t.after(() => lifecycle.close());
        return app;
      },
      async admitSource({
        app: platform,
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
        const created = await platform.request("POST", path, {
          body: {
            type: "github-app-metadata",
            name: "rejected-repository",
            config: {
              authority: "execution",
              app_id: fixtureAppId,
              installation_id: fixtureInstallationId,
              repository_id: fixtureRepositoryId,
              repository: fixtureRepository,
              agent_id: agent.id,
            },
            secrets: { private_key: secret.ref },
          },
        });
        assert.equal(created.status, 201);
        const saved = await platform.state.read((unit) =>
          unit.credentialSources.findCredentialSource(namespace.id, created.data.id),
        );
        assert(saved?.egress?.adoption === "prepared" && saved.egress.schemaVersion === 2);
        source = saved.egress as PreparedGitHubEgressSource;
        return bindRuntimeSource(platform, namespace, agent, created.data);
      },
    };
    const f = await staticEgressFixture(
      t,
      options as unknown as Parameters<typeof staticEgressFixture>[1],
    );
    assert("resolve" in f);
    const window = () => ({
      signal: t.signal,
      deadlineAt: new Date(Date.now() + 20_000).toISOString(),
    });
    const due = () =>
      app.pool.query(
        "UPDATE occ.prepared_github_families SET next_check_at=clock_timestamp() WHERE source_id=$1",
        [source.key.source.id],
      );
    assert.equal(await lifecycle.maintain(t.signal), "committed");
    await t.test("prepared metadata exposes only its selected columns", async () => {
      // A caller must not be able to specialize the reader's persisted admission.
      type FabricatedReader = (
        ...args: Parameters<typeof readPreparedGitHubMetadata>
      ) => Promise<{ admission: GitHubPreparationAdmission & { fabricated: string } } | undefined>;
      const row = await new PreparedGitHubPostgres(
        app.pool,
        custodyKey,
        lifecycle.issuerAuthority,
      ).metadata(source);
      assert(row);
      // An exhaustive key set rejects types that promise unselected attempt fields.
      const columns: Record<keyof typeof row, true> = {
        admission: true,
        id: true,
        material_version: true,
        provider_expires_at: true,
        usable_until: true,
      };
      assert.deepEqual(Object.keys(row).sort(), Object.keys(columns).sort());
      const admission: typeof readPreparedGitHubMetadata extends FabricatedReader
        ? never
        : GitHubPreparationAdmission = row.admission;
      assert.equal(admission.grant.installationId, fixtureInstallationId);
    });
    const compute = new KubernetesComputeDriver(
      {
        ...conformanceKubernetesOptions({
          gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
          runtime: undefined,
        }),
        authentication: { mode: "inCluster" },
        servicePrincipalCredentials: { mode: "disabled" },
      },
      { preparedTokens: tokens },
    );
    const retained = Reflect.get(compute, "preparedTokens") as {
      issuer(
        provider: PreparedTokenIssuer["provider"],
      ): Pick<PreparedTokenIssuer, "sourceFromRoute" | "ready"> | undefined;
    };
    assert.deepEqual(Reflect.ownKeys(retained), ["issuer"]);
    assert.ok(Object.isFrozen(retained) && Object.getPrototypeOf(retained) === null);
    assert.equal(
      retained.issuer({ ...lifecycle.provider, generation: lifecycle.provider.generation + 1 }),
      undefined,
    );
    const handle = retained.issuer(lifecycle.provider);
    assert.ok(handle && Object.isFrozen(handle) && Object.getPrototypeOf(handle) === null);
    assert.deepEqual(Reflect.ownKeys(handle).sort(), ["ready", "sourceFromRoute"]);
    // Installed methods can carry their owner's context; exposing a bound copy would retain it.
    const decorated = Object.create(lifecycle, {
      provider: { value: { ...lifecycle.provider, id: "fixture-decorated-readiness" } },
    }) as PreparedTokenIssuer;
    const checkReady: PreparedTokenIssuer["ready"] = async function (
      this: PreparedTokenIssuer,
      _input,
      signal,
    ) {
      assert.equal(this, decorated);
      return !signal.aborted;
    };
    Object.setPrototypeOf(
      checkReady,
      Object.assign(Object.create(Function.prototype), { owner: lifecycle }),
    );
    Object.defineProperty(checkReady, "bind", { value: undefined });
    Object.defineProperty(decorated, "ready", { value: checkReady });
    tokens.register(decorated);
    const decoratedHandle = retained.issuer(decorated.provider);
    assert.ok(decoratedHandle && (await decoratedHandle.ready(source, t.signal)));
    assert.equal(Reflect.has(decoratedHandle.ready, "owner"), false);

    const readsBeforeReadiness = f.secretReads;
    assert.equal(await handle.ready(source, t.signal), true);
    assert.equal(await handle.ready(source, AbortSignal.abort()), false);
    assert.equal(f.secretReads, readsBeforeReadiness);
    assert.equal(gh.issuesOfTokens.length, 1, "readiness cannot issue inline");
    const old = await lifecycle.readWarm(source, window());
    assert(old && Date.parse(old.usableUntil) > Date.now() + 40 * 60_000);
    const dispatched = async (revoke = false) => {
      const captured = captureMetadata(f);
      const { ready } = await f.resolve(captured);
      assert(ready);
      if (revoke) {
        // Provider revocation leaves local expiry unchanged.
        const response = await new Promise<IncomingMessage>((resolve, reject) =>
          request(
            new URL("/installation/token", gh.origin),
            {
              method: "DELETE",
              ca: gh.tls.ca,
              headers: Object.fromEntries(
                ready.credential_headers.map(({ name, value }: { name: string; value: string }) => [
                  name,
                  value,
                ]),
              ),
            },
            resolve,
          )
            .once("error", reject)
            .end(),
        );
        await buffer(response);
        assert.equal(response.statusCode, 204);
      }
      assert.deepEqual(await dispatchMetadata(f, gh, captured, ready, false, 401), {
        blocked: true,
      });
      const { rows } = await app.pool.query(
        "SELECT binding FROM occ.egress_send_receipts WHERE use_id=$1",
        [captured.request.context.request_id],
      );
      assert.equal(rows.length, 1);
      return rows[0].binding as SendAttempt;
    };
    const late = await dispatched(true);
    assert.equal(await lifecycle.ready(source, t.signal), true, "a bare 401 cannot fence material");
    trustedRejection = true;
    const first = await dispatched();
    assert.equal(await lifecycle.ready(source, t.signal), false);
    assert.equal(await lifecycle.readWarm(source, window()), undefined);
    assert.equal((await f.resolve(captureMetadata(f))).ready, undefined);
    assert.equal(gh.issuesOfTokens.length, 1, "feedback and reads cannot mint inline");

    const restarted = createOwner();
    const competitor = createOwner();
    for (const owner of [restarted, competitor]) {
      await owner.connect(app.pool);
      t.after(() => owner.close());
    }
    // Advance only the polling schedule, not token validity. Separate owners must coalesce
    // against the same durable family even though the rejected token is still fresh.
    await due();
    // Revocations of the rejected token: the test's own revocation of `late`, then retirement.
    const [{ index: rejected }] = gh.issuesOfTokens;
    const revocations = (index = rejected) =>
      gh.trace.filter(
        ({ method, target, tokenIndex }) =>
          method === "DELETE" && target === "/installation/token" && tokenIndex === index,
      ).length;
    assert.equal(revocations(), 1);
    // The commit moves the rejected token into retirement custody. A loser whose pass reaches
    // its retirement step after that commit retires it (`retired`); otherwise the next pass does.
    const [loser] = await raceMaintenance([restarted, competitor], t.signal);
    assert(loser === "idle" || loser === "retired", `unexpected losing pass: ${loser}`);
    assert.equal(revocations(), loser === "retired" ? 2 : 1);
    const replacement = await restarted.readWarm(source, window());
    assert(replacement);
    assert.notEqual(replacement.materialVersion, old.materialVersion);
    assert.equal(gh.issuesOfTokens.length, 2);
    const restartedReceipts = new EgressSendReceipts(app.state);
    assert.equal(await restartedReceipts.reject(first.sender, first, first.material), "fenced");
    assert.equal(await restartedReceipts.reject(late.sender, late, late.material), "fenced");
    await due();
    assert.equal(await restarted.maintain(t.signal), "ready");
    assert.equal(revocations(), 2, "exactly one pass retires the rejected token");
    assert.equal(
      (await restarted.readWarm(source, window()))?.materialVersion,
      replacement.materialVersion,
    );
    assert.equal(
      gh.issuesOfTokens.length,
      2,
      "late predecessor rejection cannot replace the successor",
    );
    // Recovery must not dispatch another business request.
    assert.equal(
      gh.trace.filter(
        (call) => call.method === "GET" && call.target === `/repos/${fixtureRepository}`,
      ).length,
      2,
    );
    assert.equal(revocations(gh.issuesOfTokens[1]!.index), 0, "never retire the replacement");
    const next = await dispatched(true);
    gh.disconnectAfterMutation("POST", `/app/installations/${fixtureInstallationId}/access_tokens`);
    await due();
    assert.equal(await restarted.maintain(t.signal), "quarantined");
    assert.equal(gh.issuesOfTokens.length, 3, "the provider issued before losing its response");
    await restartedReceipts.reject(next.sender, next, next.material);
    await due();
    assert.equal(await competitor.maintain(t.signal), "blocked");
    assert.equal(gh.issuesOfTokens.length, 3, "rejection cannot replay uncertain issuance");
    assert.equal(await competitor.readWarm(source, window()), undefined);
    assert.equal(revocations(), 2, "later passes never replay the rejected token's retirement");
    assert.deepEqual(gh.errors, []);
  },
);
