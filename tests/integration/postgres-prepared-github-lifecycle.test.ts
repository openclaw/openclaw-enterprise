import assert from "node:assert/strict";
import { createServer, get } from "node:https";
import test from "node:test";
import type { SendAttempt } from "../../packages/occ/src/egress-send-receipts.ts";
import type {
  PreparedTokenEvidence,
  PreparedTokenRef,
  PreparedTokenSelection,
  TokenResolveOptions,
} from "../../packages/contracts/src/index.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import {
  fixtureInstallationId,
  fixtureRepositoryId,
  fixtureRepository,
} from "../fixtures/repository-credentials/github.mjs";
import { TokenService } from "../../apps/controller/src/backends/token-service/service.ts";
import { waitUntil } from "../helpers/wait-for.mjs";
import {
  captureMetadata,
  callFixture,
  dispatchMetadata,
  listenOnNewOrigin,
  readPreparedEvidence,
  raceMaintenance,
  wireTime,
  record,
} from "./postgres-prepared-github-wire.ts";
import {
  preparedLifecycleFixture,
  findPreparedSource,
} from "./postgres-prepared-github-fixture.ts";
import {
  assertPreparedDispatchConstraints,
  checkSendDeadlines,
  selectSend,
  checkCurrentProof,
} from "./postgres-prepared-github-send-cases.ts";
import {
  connectedRepository,
  mockPgQuery,
  useCheckedOutClient,
  containsSealedRow,
  observeTransaction,
} from "./postgres-prepared-github-observation.ts";
import { registerSettlementCases } from "./postgres-prepared-github-settlement-cases.ts";

test(
  "authorized GitHub proxy requests mint the registered grant and share one replacement",
  requiresPostgres,
  async (t) => {
    let hold: { started: boolean; release: PromiseWithResolvers<void> };
    const fixture = await preparedLifecycleFixture(t, {
      tokenLifetimeMs: 3 * 60_000,
      async beforeIssueResponse() {
        if (hold) {
          hold.started = true;
          await hold.release.promise;
        }
      },
    });
    const { f, gh, tokens, source, createOwner, registerSource, tokenRegistration } = fixture;
    const { reference } = tokenRegistration;
    assert.equal(tokenRegistration.kind, "github_app_installation");
    assert.deepEqual(reference, { kind: "github_app_installation", key: source.key });
    const readsBeforeRefusal = f.secretReads;
    const registration = { source, secret: fixture.issuer };
    for (const [invalid, message] of [
      [registration, /unknown token registration kind/i],
      [{ ...registration, kind: "prepared_source" }, /provider does not support this token kind/],
      [
        { ...registration, kind: "oauth_refresh_token" },
        /requires an account, approved template and grant/,
      ],
    ] as const) {
      const register: (input: never, signal: AbortSignal) => Promise<PreparedTokenRef> =
        tokens.register.bind(tokens);
      const pending: unknown = callFixture(register, tokens, [invalid, t.signal]);
      assert.ok(pending instanceof Promise);
      await assert.rejects(pending, { message });
    }
    assert.equal(
      f.secretReads,
      readsBeforeRefusal,
      "an untagged or mismatched registration cannot open the signing key",
    );

    const refuseOtherKinds = async () => {
      const dispatch = t.mock.method(fixture.lifecycle, "resolve");
      const accountReads = t.mock.method(f.state, "read");
      try {
        const options = {
          signal: t.signal,
          deadlineAt: new Date(Date.now() + 20_000).toISOString(),
          minimumValidityMs: 1_000,
        };
        for (const invalid of [
          source.key,
          { ...reference, kind: "prepared_source" },
          { ...reference, kind: "oauth_refresh_token" },
        ]) {
          const resolve: (
            input: never,
            options: TokenResolveOptions,
          ) => Promise<PreparedTokenSelection | undefined> = tokens.resolve.bind(tokens);
          const selection: unknown = await callFixture(resolve, tokens, [invalid, options]);
          assert.equal(selection, undefined);
        }
        assert.equal(
          accountReads.mock.callCount(),
          0,
          "a relabeled GitHub handle cannot read an OAuth account",
        );
        assert.equal(
          dispatch.mock.callCount(),
          0,
          "mismatched or untagged handles cannot reach the GitHub issuer",
        );
      } finally {
        dispatch.mock.restore();
        accountReads.mock.restore();
      }
    };
    await refuseOtherKinds();
    const unrelated = await registerSource("unrelated-due-family");
    assert.equal(gh.issuesOfTokens.length, 0, "registration alone sends nothing to GitHub");

    const otherTokens = new TokenService();
    const otherOwner = createOwner(gh.origin, otherTokens);
    await otherOwner.connect(f.pool);
    t.after(() => otherOwner.close());
    // B observes cold before A commits. Its later claim must reuse A's three-minute
    // token, even though that token is already inside the ten-minute renewal window.
    const beforeClaim = Promise.withResolvers<void>();
    const resumeClaim = Promise.withResolvers<void>();
    const repo = connectedRepository(otherOwner);
    const claim = repo.claim.bind(repo);
    const gatedClaim = t.mock.method(
      repo,
      "claim",
      async (...args: Parameters<typeof claim>) => {
        beforeClaim.resolve();
        await resumeClaim.promise;
        return claim(...args);
      },
      { times: 1 },
    );
    const lateClaim = otherTokens.resolve(reference, {
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      minimumValidityMs: 20_000,
      signal: t.signal,
    });
    await Promise.race([
      beforeClaim.promise,
      lateClaim.then(() => {
        throw new Error("peer did not reach its cold claim");
      }),
    ]);
    const request = captureMetadata(f);
    let resolved: Awaited<ReturnType<typeof f.resolve>>;
    try {
      resolved = await f.resolve(request);
    } finally {
      resumeClaim.resolve();
      gatedClaim.mock.restore();
    }
    const { ready } = resolved;
    assert.ok(ready, "an authorized cold proxy request gets a token without a maintenance pass");
    const selected = readPreparedEvidence(ready.evidence);
    assert.equal(selected.family.id, source.key.source.id);
    const resolvedToken = await lateClaim;
    assert.ok(resolvedToken?.accessToken);
    assert.equal(resolvedToken.materialVersion, selected.materialVersion);
    assert.equal(selected.providerExpiresAt, resolvedToken.expiresAt);
    assert.equal(JSON.stringify(selected).includes(resolvedToken.accessToken), false);
    assert.deepEqual(
      gh.issuesOfTokens.map((issue) => {
        assert.ok(issue.repositoryIds !== "installation");
        return { repositoryIds: issue.repositoryIds.map(String), permissions: issue.permissions };
      }),
      [{ repositoryIds: [String(fixtureRepositoryId)], permissions: { metadata: "read" } }],
    );
    await dispatchMetadata(f, gh, request, ready);
    await refuseOtherKinds();
    const {
      rows: [receipt],
    } = await f.pool.query<{ binding: SendAttempt }>(
      "SELECT binding, authorized_dispatch FROM occ.egress_send_receipts WHERE use_id=$1",
      [request.request.context.request_id],
    );
    assert.ok(receipt?.binding.material?.kind === "prepared_github");
    assert.equal(receipt.binding.material.providerExpiresAt, resolvedToken.expiresAt);
    assert.equal(
      JSON.stringify(receipt).includes(resolvedToken.accessToken),
      false,
      "the durable receipt contains no token bytes",
    );
    const warm = captureMetadata(f);
    const second = await f.resolve(warm);
    assert.ok(second.ready);
    assert.equal(
      readPreparedEvidence(second.ready.evidence).materialVersion,
      selected.materialVersion,
    );
    await dispatchMetadata(f, gh, warm, second.ready);
    assert.equal(gh.issuesOfTokens.length, 1);

    // Only the stored material lifetime has advanced. The token is still valid at GitHub.
    const ageToken = async (version: string) => {
      const aged = await f.pool.query<Record<string, unknown>>(
        "UPDATE occ.prepared_github_attempts SET usable_until=clock_timestamp()+interval '10 seconds' WHERE source_id=$1 AND material_version=$2",
        [source.key.source.id, version],
      );
      assert.equal(aged.rowCount, 1);
    };
    await ageToken(selected.materialVersion);
    const expired = captureMetadata(f);
    expired.deadline = wireTime(Date.now() - 1_000);
    assert.ok((await f.resolve(expired)).refused);
    assert.equal(gh.issuesOfTokens.length, 1, "an expired request cannot start issuance");

    // A caller with sufficient remaining life gets the current value while renewal runs.
    // A cancelled longer-lived caller must not cancel that shared issuance.
    hold = { started: false, release: Promise.withResolvers<void>() };
    const leaving = new AbortController();
    const lifetime = {
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      minimumValidityMs: 20_000,
    };
    await f.pool.query<Record<string, unknown>>(
      "UPDATE occ.prepared_github_families SET next_check_at=clock_timestamp() WHERE source_id=$1",
      [source.key.source.id],
    );
    const sufficient = await tokens.resolve(reference, {
      ...lifetime,
      minimumValidityMs: 1_000,
      signal: t.signal,
    });
    assert.equal(sufficient?.materialVersion, selected.materialVersion);
    await waitUntil("the due warm grant starts early renewal", () => hold.started);
    const first = tokens.resolve(reference, { ...lifetime, signal: leaving.signal });
    const leavingResult = first.catch((error: unknown) => {
      if (!(error instanceof Error) || error.name !== "AbortError") {
        throw error;
      }
      return undefined;
    });
    const other = () => otherTokens.resolve(reference, { ...lifetime, signal: t.signal });
    let proxyResult: ReturnType<typeof f.resolve>;
    let otherResult: ReturnType<typeof other>;
    const replacementRequest = captureMetadata(f);
    try {
      const peerClaim = t.mock.method(repo, "claim");
      proxyResult = f.resolve(replacementRequest);
      otherResult = other();
      await waitUntil(
        "the second owner tried to claim the same family",
        () => peerClaim.mock.callCount() > 0,
      );
      const contender = peerClaim.mock.calls[0];
      assert.ok(contender);
      assert.equal(await contender.result, undefined);
      peerClaim.mock.restore();
      leaving.abort();
      assert.equal(await leavingResult, undefined, "a cancelled caller receives no credential");
    } finally {
      hold.release.resolve();
    }
    const [{ ready: replacement }, fromPeer] = await Promise.all([proxyResult, otherResult]);
    assert.ok(replacement);
    assert.ok(fromPeer);
    const newVersion = readPreparedEvidence(replacement.evidence).materialVersion;
    assert.notEqual(newVersion, selected.materialVersion);
    assert.equal(fromPeer.materialVersion, newVersion);
    await dispatchMetadata(f, gh, replacementRequest, replacement);
    assert.equal(gh.issuesOfTokens.length, 2);
    const selectedBeforeLoss = captureMetadata(f);
    const snapshot = await f.resolve(selectedBeforeLoss);
    assert.ok(snapshot.ready);
    // The third issuance has already reached GitHub when IAM revokes this Agent's use.
    // The response to the original signed request must withhold every credential header.
    const upstreamReads = () =>
      gh.trace.filter(
        ({ method, target }) => method === "GET" && target === `/repos/${fixtureRepository}`,
      ).length;
    const sent = upstreamReads();
    await ageToken(newVersion);
    hold = { started: false, release: Promise.withResolvers<void>() };
    const inFlight = f.resolve(captureMetadata(f));
    try {
      await waitUntil("GitHub accepted the authorized renewal", () => hold.started);
      await f.revoke();
    } finally {
      hold.release.resolve();
    }
    const refused = await inFlight;
    assert.ok(refused.refused);
    assert.equal(refused.ready, undefined);
    assert.ok((await f.authorize(f.permitRequest(selectedBeforeLoss, snapshot.ready))).refused);
    assert.ok((await f.resolve(captureMetadata(f))).refused);
    assert.equal(upstreamReads(), sent, "the upstream received no request after IAM loss");

    // Withdrawal also fences later direct resolution of the same registration by a peer.
    await fixture.lifecycle.withdraw(source, t.signal);
    assert.equal(await other(), undefined);
    assert.equal(gh.issuesOfTokens.length, 3);
    assert.equal(
      (
        await f.pool.query<Record<string, unknown>>(
          "SELECT 1 FROM occ.prepared_github_attempts WHERE source_id=$1",
          [unrelated],
        )
      ).rowCount,
      0,
    );
    const unused = await findPreparedSource(f.state, f.namespace.id, unrelated);
    await fixture.lifecycle.withdraw(unused, t.signal);
  },
);

test(
  "PostgreSQL prepared custody: source consent, proactive renewal, restart, issuer rotation and withdrawal",
  requiresPostgres,
  async (t) => {
    let invalidScope = false;
    const prepared = await preparedLifecycleFixture(t, {
      tokenLifetimeMs: 45 * 60_000,
      tokenResponse: (packet) => (invalidScope ? { ...packet, repositories: [] } : packet),
    });
    const { gh, f, lifecycle, issuer, secretValue, createOwner, registerSource } = prepared;
    let { source } = prepared;
    const signal = new AbortController().signal;
    const readWindow = () => ({ signal, deadlineAt: new Date(Date.now() + 20_000).toISOString() });
    const firstReads = f.secretReads;
    assert.equal(await lifecycle.ready(source, signal), false);
    assert.equal(await lifecycle["readWarm"](source, readWindow()), undefined);
    assert.equal(f.secretReads, firstReads, "cold request read the issuer Secret");
    assert.equal(
      gh.issuesOfTokens.length,
      0,
      "source registration or cold access issued at provider",
    );

    // Two workers race over a real family. Only the durable claim holder reaches the issuer.
    const competitor = createOwner();
    await competitor.connect(f.pool);
    // The family is cold, so the loser has nothing to retire.
    const losers = await raceMaintenance([lifecycle, competitor], signal);
    await competitor.close();
    assert.deepEqual(losers, ["idle"]);
    const old = await lifecycle["readWarm"](source, readWindow());
    assert.ok(old);
    assert.equal(old.ownerEpoch, 1);
    assert.deepEqual(gh.issuesOfTokens[0]?.permissions, { metadata: "read" });
    // Use OCE's actual signed exchange owner, not a second fixture acceptance or a unary sender.
    const captured = captureMetadata(f);
    const { ready } = await f.resolve(captured);
    assert.ok(ready, "signed resolve must select the prepared family");
    const evidence = readPreparedEvidence(ready.evidence);
    const proveCurrent = (selected: PreparedTokenEvidence) =>
      f.state.transact((unit) =>
        unit.preparedTokenProof.current(source, selected, lifecycle.issuerAuthority, readWindow()),
      );
    assert.equal(await proveCurrent(evidence), true);
    await checkCurrentProof(t, prepared, old, evidence, readWindow, proveCurrent);
    await t.test(
      "signed PostgreSQL dispatch uses one shared connection for current material proof",
      async () => {
        assert.equal(f.pool.options.max, 1);
        const safe = await dispatchMetadata(f, gh, captured, ready);
        assert.equal(
          safe.body.toString(),
          JSON.stringify({ id: Number(fixtureRepositoryId), full_name: fixtureRepository }),
        );
      },
    );
    await t.test("PostgreSQL enforces the prepared material and reply association", async () => {
      await assertPreparedDispatchConstraints(f.pool, captured.request.context.request_id);
    });
    const assertPoolIdle = async () => {
      assert.equal((await f.pool.query<{ ok: number }>("SELECT 1 AS ok")).rows[0]?.ok, 1);
      assert.equal(f.pool.waitingCount, 0);
      assert.equal(f.pool.idleCount, 1);
    };
    await t.test("concurrent signed checks drain the shared single-connection pool", async () => {
      const requests = [captureMetadata(f), captureMetadata(f), captureMetadata(f)];
      const selections = await Promise.all(requests.map((request) => f.resolve(request)));
      const decisions = await Promise.all(
        requests.map((request, i) => {
          const ready = selections[i]?.ready;
          assert.ok(ready);
          return f.authorize(f.permitRequest(request, ready));
        }),
      );
      assert.ok(decisions.every((decision) => decision.allowed));
      await assertPoolIdle();
    });
    await checkSendDeadlines(t, prepared, old, readWindow, assertPoolIdle);
    const selectPreparedSend = (captured?: ReturnType<typeof captureMetadata>) =>
      selectSend(f, captured);
    const status = (value: string) =>
      new Promise<number | undefined>((resolve, reject: (error: unknown) => void) => {
        get(
          `${gh.origin}/repos/${fixtureRepository}`,
          { ca: gh.tls.ca, headers: { authorization: "Bearer " + value } },
          (res) => {
            res.resume();
            res.once("end", () => resolve(res.statusCode));
          },
        ).once("error", reject);
      });
    assert.equal(
      await status(old.accessToken),
      200,
      "actual token must be accepted for the exact metadata read",
    );
    const {
      rows: [sealedRow],
    } = await f.pool.query<{ sealed: Buffer }>(
      "SELECT sealed FROM occ.prepared_github_attempts WHERE material_version=$1",
      [old.materialVersion],
    );
    assert.equal(
      sealedRow?.sealed.includes(Buffer.from(old.accessToken)),
      false,
      "database stored bearer in plaintext",
    );

    // A new lifecycle instance has only the custody mount and PostgreSQL; warm access neither reads the root nor issues.
    let fresh = createOwner();
    await fresh.connect(f.pool);
    t.after(() => fresh.close());
    const beforeRestartRead = f.secretReads;
    assert.equal(await fresh.ready(source, signal), true);
    assert.equal(
      (await fresh["readWarm"](source, readWindow()))?.materialVersion,
      old.materialVersion,
    );
    assert.equal(f.secretReads, beforeRestartRead);
    assert.equal(gh.issuesOfTokens.length, 1);
    const due = (sourceId = source.key.source.id) =>
      f.pool.query<Record<string, unknown>>(
        "UPDATE occ.prepared_github_families SET next_check_at=now() WHERE source_id=$1",
        [sourceId],
      );
    const displaced = await selectPreparedSend();
    let renewed: PreparedTokenSelection | undefined;
    await t.test(
      "renewal after committed metadata cannot open replacement for the old request",
      async (t) => {
        const repo = connectedRepository(lifecycle);
        const metadata = repo.metadata.bind(repo);
        const selected = Promise.withResolvers<Awaited<ReturnType<typeof metadata>>>();
        const resume = Promise.withResolvers<void>();
        const open = t.mock.method(repo, "open");
        let projected = false;
        t.mock.method(
          repo,
          "metadata",
          async (...args: Parameters<typeof metadata>) => {
            const result = await metadata(...args); // The real metadata transaction has committed.
            selected.resolve(result);
            await resume.promise;
            return result;
          },
          { times: 1 },
        );
        observeTransaction(t, repo, async (client, sql, args) => {
          const result = await client.query(sql, args);
          if (sql.includes("END AS sealed")) {
            projected ||= containsSealedRow(result.rows);
          }
          return result;
        });
        const pending = lifecycle["readWarm"](source, readWindow());
        try {
          const selection = await Promise.race([
            selected.promise,
            pending.then(() => {
              throw new Error("request ended before selecting metadata");
            }),
          ]);
          assert.ok(selection);
          assert.equal(selection.material_version, old.materialVersion);
          // Advance the existing material into its renewal window only now, after the
          // request selected its metadata. Earlier send checks exercise a stable warm grant.
          await f.pool.query<Record<string, unknown>>(
            "UPDATE occ.prepared_github_attempts SET usable_until=clock_timestamp()+interval '8 minutes' WHERE material_version=$1",
            [old.materialVersion],
          );
          await due();
          type Report = Parameters<Parameters<typeof fresh.startWorker>[0]>;
          const reports: Report[0][] = [];
          const diagnostics: { code: Report[0]; context: Report[1] }[] = [];
          fresh.startWorker(
            (code: Report[0], context: Report[1], severity: Report[2] = "error") => {
              if (severity === "error") {
                reports.push(code);
              } else {
                diagnostics.push({ code, context });
              }
            },
          );
          // Observe only the ledger. No request or readiness call drives this proactive renewal.
          await waitUntil(
            "the background loop to proactively renew",
            async () => {
              const {
                rows: [count],
              } = await f.pool.query<{ changed: boolean }>(
                "SELECT count(*)=1 AS changed FROM occ.prepared_github_attempts WHERE custody='current' AND source_id=$1 AND material_version <> $2",
                [source.key.source.id, old.materialVersion],
              );
              assert.ok(count);
              return count.changed;
            },
            { timeoutMs: 15_000, intervalMs: 50 },
          );
          await fresh.close();
          fresh = createOwner();
          await fresh.connect(f.pool);
          assert.deepEqual(reports, []);
          renewed = await fresh["readWarm"](source, readWindow());
          assert.ok(renewed);
          // Correlate the background report with actual encrypted PostgreSQL publication.
          assert.equal(diagnostics.length, 1);
          const entry = diagnostics[0];
          assert.ok(entry);
          assert.equal(entry.code, "PREPARED_GITHUB_ISSUANCE_DIAGNOSTIC");
          const diagnostic = entry.context;
          assert.ok(record(diagnostic));
          const {
            rows: [attempt],
          } = await f.pool.query<{ id: string }>(
            "SELECT id FROM occ.prepared_github_attempts WHERE source_id=$1 AND material_version=$2",
            [source.key.source.id, renewed.materialVersion],
          );
          assert.equal(diagnostic.attemptId, attempt?.id);
          assert.equal(diagnostic.httpStatus, 201);
          assert.equal(diagnostic.responseComplete, true);
          assert.equal(diagnostic.requestEndCalled, true);
          assert.equal(diagnostic.candidateIdentified, true);
          assert.equal(diagnostic.validationKind, "validated");
          assert.equal(diagnostic.publication, "committed");
          assert.equal(diagnostic.clockTolerance, true);
          assert.equal(diagnostic.firstFailureStage, undefined);
          for (const secret of [
            old.accessToken,
            renewed.accessToken,
            String(secretValue),
            "PRIVATE KEY",
          ]) {
            assert.equal(JSON.stringify(diagnostics).includes(secret), false);
          }
          assert.notEqual(renewed.materialVersion, old.materialVersion);
          const issues = gh.issuesOfTokens.length;
          const reads = f.secretReads;
          resume.resolve();
          const result = await pending;
          assert.equal(result, undefined, "the old custody read cannot select a replacement");
          assert.deepEqual(
            { projected, opens: open.mock.callCount() },
            { projected: false, opens: 0 },
            "old selection must neither project nor open the replacement",
          );
          const next = await f.resolve(captureMetadata(f));
          assert.ok(next.ready, "a new request can select the replacement");
          assert.equal(
            readPreparedEvidence(next.ready.evidence).materialVersion,
            renewed.materialVersion,
          );
          assert.equal(open.mock.callCount(), 1);
          assert.equal(gh.issuesOfTokens.length, issues, "requests must not issue");
          assert.equal(f.secretReads, reads, "requests must not read issuer Secret");
        } finally {
          resume.resolve();
          await pending;
        }
      },
    );
    // B is reachable with the same trusted CA and would falsely acknowledge A's revocation.
    // Record only whether a credential arrived. A client must not rely on B rejecting A's token.
    let credentialRequestsAtB = 0;
    const originB = await listenOnNewOrigin(t, () =>
      createServer(gh.tls, (req, res) => {
        if (req.headers.authorization) {
          credentialRequestsAtB++;
        }
        res.writeHead(204).end();
      }),
    );
    const probeB = await new Promise<number | undefined>(
      (resolve, reject: (error: unknown) => void) => {
        get(originB, { ca: gh.tls.ca }, (res) => {
          res.resume();
          resolve(res.statusCode);
        }).once("error", reject);
      },
    );
    assert.equal(probeB, 204);
    const restartedAtB = createOwner(originB);
    await restartedAtB.connect(f.pool);
    t.after(() => restartedAtB.close());
    const pendingRetirements = async () =>
      (
        await f.pool.query<{ id: string; state: string; envelope: string }>(
          `SELECT id, state, encode(sha256(sealed), 'hex') AS envelope FROM occ.prepared_github_attempts
           WHERE source_id=$1 AND custody='retire' ORDER BY id`,
          [source.key.source.id],
        )
      ).rows;
    await t.test(
      "worker restart at B cannot disclose or settle A's routine retirement",
      async () => {
        const pendingAtA = await pendingRetirements();
        assert.deepEqual(
          pendingAtA.map((r) => r.state),
          ["committed"],
        );
        const attemptsAtA = gh.trace.length;
        const checksAtB = await restartedAtB.maintain(signal);
        assert.equal(credentialRequestsAtB, 0, "B received a credential from A");
        assert.equal(checksAtB, "issuer-mismatch");
        assert.equal(gh.trace.length, attemptsAtA, "stored origin must not redirect a worker to A");
        assert.deepEqual(
          await pendingRetirements(),
          pendingAtA,
          "custody or outcome changed under B",
        );
        assert.equal(await restartedAtB.ready(source, signal), false);
        assert.equal(Boolean(await restartedAtB["readWarm"](source, readWindow())), false);
        assert.equal(await status(old.accessToken), 200, "A still accepts the displaced token");
      },
    );
    await t.test(
      "before-send refuses displaced material and accepts renewed material",
      async () => {
        assert.equal((await displaced.authorize()).refused?.code, f.refusalCode("DENIED"));
        const selected = await selectPreparedSend();
        assert.ok((await selected.authorize()).allowed);
      },
    );
    await fresh.maintain(signal); // Drains the displaced token. GitHub confirms DELETE independently.
    assert.equal(await status(old.accessToken), 401);
    assert.ok(renewed);
    assert.equal(await status(renewed.accessToken), 200);

    await t.test("before-send refuses a rejected prepared selection", async () => {
      const selected = await selectPreparedSend();
      await f.state.transact((unit) =>
        unit.credentialSources.rejectEgressMaterial(readPreparedEvidence(selected.evidence)),
      );
      assert.equal((await selected.authorize()).refused?.code, f.refusalCode("DENIED"));
    });
    // A genuine update advances the authoritative issuer resourceVersion even with identical PEM.
    const changed = await f.request("PATCH", `/namespaces/${f.namespace.id}/secrets/${issuer.id}`, {
      body: { value: secretValue },
    });
    assert.equal(changed.status, 200);
    await due();
    assert.equal(await fresh.maintain(signal), "committed");
    const rotated = await fresh["readWarm"](source, readWindow());
    assert.ok(rotated);
    assert.equal(rotated.ownerEpoch, 2);
    assert.notEqual(rotated.inputVersion, old.inputVersion);
    assert.equal(await status(rotated.accessToken), 200);
    // A issued a real token, but its response cannot qualify the token for use. Withdrawal
    // under B must preserve that exceptional cleanup candidate and A's now-displaced current token.
    const withdrawn = await selectPreparedSend();
    invalidScope = true;
    await f.pool.query<Record<string, unknown>>(
      "UPDATE occ.prepared_github_attempts SET usable_until=clock_timestamp()+interval '8 minutes' WHERE material_version=$1",
      [rotated.materialVersion],
    );
    await due();
    assert.equal(await fresh.maintain(signal), "quarantined");
    invalidScope = false;
    await t.test(
      "API restart at B cannot disclose A's quarantined issuance during withdrawal",
      async () => {
        const pending = await pendingRetirements();
        assert.deepEqual(
          pending.map((r) => r.state),
          ["quarantined"],
        );
        const attemptsAtA = gh.trace.length;
        await assert.rejects(restartedAtB.withdraw(source, signal), {
          name: "CredentialTokenUnsettledError",
        });
        assert.equal(credentialRequestsAtB, 0, "B received A's exceptional pending credential");
        assert.equal(gh.trace.length, attemptsAtA);
        const kept = await pendingRetirements();
        assert.deepEqual(kept.map((r) => r.state).sort(), ["committed", "quarantined"]);
        assert.deepEqual(
          kept.find((r) => r.id === pending[0]?.id),
          pending[0],
        );
        assert.equal(
          gh.tokenState().filter((r) => !r.revoked).length,
          2,
          "A still owns both live tokens",
        );
      },
    );
    await t.test("before-send refuses a withdrawn prepared family", async () => {
      assert.equal((await withdrawn.authorize()).refused?.code, f.refusalCode("DENIED"));
      await assertPoolIdle();
    });
    await fresh.withdraw(source, signal);
    assert.equal(
      gh.tokenState().every((r) => r.revoked),
      true,
      "only A can confirm both retirements",
    );
    assert.deepEqual(await pendingRetirements(), []);
    assert.equal(await fresh.ready(source, signal), false);
    assert.equal(await fresh["readWarm"](source, readWindow()), undefined);
    assert.equal(
      await status(rotated.accessToken),
      401,
      "withdrawal must revoke the actual provider credential",
    );
    // Lose the response *after* the synthetic provider owns the token. A different worker must
    // observe the durable quarantine, never issue again, and never claim remote revocation.
    const lostSource = await registerSource("prepared-lost-response");
    const lost = await findPreparedSource(f.state, f.namespace.id, lostSource);
    const issuedBefore = gh.issuesOfTokens.length;
    gh.disconnectAfterMutation("POST", `/app/installations/${fixtureInstallationId}/access_tokens`);
    assert.equal(await fresh.maintain(signal), "quarantined");
    assert.equal(
      gh.issuesOfTokens.length,
      issuedBefore + 1,
      "provider must have issued before disconnect",
    );
    source = lost;
    await due();
    assert.equal(
      await lifecycle.maintain(signal),
      "blocked",
      "must not replay the uncertain issuance",
    );
    assert.equal(gh.issuesOfTokens.length, issuedBefore + 1);
    assert.equal(await lifecycle["readWarm"](lost, readWindow()), undefined);
    await assert.rejects(lifecycle.withdraw(lost, signal), {
      name: "CredentialTokenUnsettledError",
    });
    await t.test("a lost retirement commit receipt clears the unreceived candidate", async (t) => {
      // An out-of-scope issuance leaves a real cleanup candidate for the next worker pass.
      await registerSource("prepared-lost-retirement-commit");
      invalidScope = true;
      assert.equal(await fresh.maintain(signal), "quarantined");

      // Let PostgreSQL commit the claim, then lose its acknowledgment at the client boundary.
      // Observe the exact buffer open() returned, without copying or printing its contents.
      const open = t.mock.method(connectedRepository(fresh), "open");
      const client = await f.pool.connect();
      let bytes: Buffer | undefined;
      mockPgQuery(t, client, async (sql, args, query) => {
        const result = await query(sql, args);
        // The pass first commits its Agent discovery on this connection, which the one-connection
        // pool hands back to the retirement claim; lose only the claim's acknowledgment.
        if (sql === "COMMIT" && open.mock.callCount()) {
          const opened = open.mock.calls[0]?.result;
          assert.ok(Buffer.isBuffer(opened));
          bytes = opened;
          assert.ok(
            bytes.some((byte) => byte !== 0),
            "claim must have opened live bytes",
          );
          throw Object.assign(new Error("commit acknowledgment lost"), { code: "08007" });
        }
        return result;
      });
      useCheckedOutClient(t, f.pool, client);
      const providerCalls = gh.trace.length;
      await assert.rejects(
        fresh.maintain(signal),
        /custody transaction did not complete \(08007\)/,
      );
      assert.equal(gh.trace.length, providerCalls, "an uncertain claim must not reach the issuer");
      assert.ok(bytes);
      assert.ok(
        bytes.every((byte) => byte === 0),
        "unreceived retirement bytes were not cleared",
      );
    });
    for (const custody of ["current", "retire"]) {
      await t.test(`publication rollback clears ${custody} bytes`, async (t) => {
        const sourceId = await registerSource(`prepared-rollback-${custody}`);
        invalidScope = custody === "retire";
        t.after(() => {
          invalidScope = false;
        });

        const repo = connectedRepository(fresh);
        const seal: (typeof repo)["seal"] = repo["seal"].bind(repo);
        let candidate: Uint8Array | undefined;
        let publication:
          | { custody: unknown; sealed: boolean; live: boolean | undefined; rows: number | null }
          | undefined;
        t.mock.method(
          repo,
          "seal",
          (bytes: Uint8Array, ...args: [Parameters<typeof seal>[1], string]) => {
            candidate = bytes; // Retain the repository-owned buffer, never a copy or diagnostic.
            return seal(bytes, ...args);
          },
        );
        observeTransaction(t, repo, async (client, sql, args) => {
          const result = await client.query(sql, args);
          if (sql.includes("SET state=$2,custody=$3")) {
            // The real write succeeded. Abort PostgreSQL before COMMIT, then inspect
            // only metadata outside the transaction's sanitized error boundary.
            publication = {
              custody: args?.[2],
              sealed: args?.[3] != null,
              live: candidate?.some((byte) => byte !== 0),
              rows: result.rowCount,
            };
            await client.query("SELECT 1/0");
          }
          return result;
        });
        const issues = gh.issuesOfTokens.length;
        assert.equal(await fresh.maintain(signal), "quarantined");
        const clearedAtReturn = candidate?.every((byte) => byte === 0);
        assert.deepEqual(publication, { custody, sealed: true, live: true, rows: 1 });
        assert.equal(gh.issuesOfTokens.length, issues + 1);
        const { rows } = await f.pool.query<{ state: string; custody: string; sealed: boolean }>(
          "SELECT state,custody,sealed IS NOT NULL AS sealed FROM occ.prepared_github_attempts WHERE source_id=$1",
          [sourceId],
        );
        assert.deepEqual(rows, [{ state: "issuing", custody: "intent", sealed: false }]);

        // The durable intent blocks another issuance even after the family becomes due.
        await due(sourceId);
        assert.equal(await fresh.maintain(signal), "blocked");
        assert.equal(gh.issuesOfTokens.length, issues + 1);
        assert.equal(
          clearedAtReturn,
          true,
          "publication returned without clearing its draft bytes",
        );
      });
    }
    assert.deepEqual(gh.errors, []);
  },
);

registerSettlementCases();
