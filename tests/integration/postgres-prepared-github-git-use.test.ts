import type {
  AgentRevision,
  PreparedGitHubUseRequest,
} from "../../packages/contracts/src/index.ts";
import { authorizePreparedGitSend } from "../../apps/controller/src/drivers/repo/github/credentials/warm-use.ts";
import { createSystemClock } from "../../apps/controller/src/drivers/repo/credentials/clock.ts";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createPublicKey, randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { writeFile } from "node:fs/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import { get } from "node:https";
import { join } from "node:path";
import test from "node:test";
import { TokenService } from "../../apps/controller/src/backends/token-service/service.ts";
import type { Clock } from "../../apps/controller/src/drivers/repo/credentials/backend-contracts.ts";
import { clockBehind } from "../helpers/prepared-standing-git-peer.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { socketDirectory } from "../helpers/socket-directory.mjs";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import {
  admitProtectedVersion,
  disposeBrokerSession,
  disposeProtectedSession,
  fixture,
  prepare,
  startProtectedOwner,
} from "../fixtures/prepared-repository-git.mjs";
import {
  fixtureInstallationId,
  fixtureRepository,
  fixtureRepositoryId,
  startGitHubFixture,
} from "../fixtures/repository-credentials/github.mjs";

test(
  "the worker's prepared owner measures a token's remaining validity by the system clock",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    // The worker starts the owner without a clock. GitHub answers with a 100 s token: by the
    // system clock 40 s remain after the 60 s skew allowance, less than the 60 s minimum, so the
    // owner keeps the token only to retire it. An owner whose wall clock reads 50 s behind (the
    // seam the standing Git transfer test uses) finds 90 s and installs it. Only the clock
    // differs, so the refusal proves that the default clock is the system clock.
    const attempts = async (ownerClock?: Clock) => {
      const f = await fixture(t, { tokenLifetimeMs: 100_000, ownerClock });
      await prepare(f);
      return (
        await f.pool.query(
          "SELECT state, custody FROM occ.prepared_github_attempts WHERE source_id=$1",
          [f.familyId],
        )
      ).rows;
    };
    assert.deepEqual(await attempts(undefined), [{ state: "quarantined", custody: "retire" }]);
    assert.deepEqual(await attempts(clockBehind(50_000)), [
      { state: "committed", custody: "current" },
    ]);
  },
);

test(
  "native sender quarantines wrong-repository material across restart and only its issuer retires it",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    // Both cases use the same grant scope and sender path with separate fixture sockets.
    // A correctly scoped token proves the sender can succeed; each denial needs its own reply.
    for (const wrongRepository of [false, true]) {
      await t.test(wrongRepository ? "wrong repository" : "correct repository", async (t) => {
        const f = await fixture(t);
        const repository = wrongRepository ? "neighbour/other-project" : fixtureRepository;
        let markIssued!: () => void;
        const issued = new Promise<void>((resolve) => (markIssued = resolve));
        let releaseIssuer!: () => void;
        const deliver = new Promise<void>((resolve) => (releaseIssuer = resolve));
        let token = "";
        const issuerOptions = {
          clock: createControlledClock(),
          repository,
          issueResponseGate() {
            markIssued();
            return deliver;
          },
          tokenResponse(packet: {
            token: string;
            repositories: { id: number; full_name: string }[];
          }) {
            assert.equal(packet.repositories[0]?.full_name, repository);
            assert.equal(String(packet.repositories[0]?.id), String(fixtureRepositoryId));
            token = packet.token;
            return wrongRepository
              ? {
                  ...packet,
                  repositories: [
                    { ...packet.repositories[0], id: Number(fixtureRepositoryId) + 97 },
                  ],
                }
              : packet;
          },
        };
        const gh = await startGitHubFixture(t, issuerOptions);
        assert.equal(new URL(gh.origin).hostname, "127.0.0.1");
        // These deliberate provider probes witness token validity independently of business sends.
        const providerStatus = (authorization = `Bearer ${token}`) =>
          new Promise<number | undefined>((resolve, reject) => {
            assert.ok(token.length > 0, "the issuer returned an identifiable token");
            get(
              `${gh.origin}/repos/${repository}`,
              {
                ca: gh.tls.ca,
                headers: { authorization },
                signal: t.signal,
              },
              (response) => {
                response.resume().once("end", () => resolve(response.statusCode));
              },
            ).once("error", reject);
          });
        const sockets = await socketDirectory(t, "quarantine-", {
          longest: "prepared-git-use.sock",
        });
        const startSender = async () => {
          const owner = await f.startOwner({
            apiOrigin: gh.origin,
            ca: gh.tls.ca,
            controlSocket: join(sockets, "control.sock"),
          });
          // startOwner also registers cleanup; an explicit restart must close once.
          const close = owner.close.bind(owner);
          let closing: Promise<void> | undefined;
          owner.close = () => (closing ??= close());
          return owner;
        };
        const clock = createSystemClock();
        const request = f.request() as PreparedGitHubUseRequest;
        const { exchangeId: _exchangeId, deadlineAt: _deadlineAt, ...use } = request;
        const useSocket = join(sockets, "prepared-git-use.sock");
        const send = () =>
          authorizePreparedGitSend(
            useSocket,
            clock,
            use,
            {},
            { signal: t.signal, deadlineMonoMs: clock.monotonicNow() + 10_000 },
          );
        const denied = async () => {
          const sendScope = new AsyncLocalStorage<boolean>();
          const responses = channel("http.client.response.finish");
          const statuses: (number | undefined)[] = [];
          const observe = (message: unknown) => {
            const { request, response } = message as {
              request: ClientRequest & { socketPath?: string };
              response: IncomingMessage;
            };
            if (
              sendScope.getStore() === true &&
              request.method === "POST" &&
              request.path === "/v1/prepared-git/use" &&
              request.socketPath === useSocket
            ) {
              statuses.push(response.statusCode);
            }
          };
          responses.subscribe(observe);
          try {
            await assert.rejects(sendScope.run(true, send), /prepared-git-unavailable/);
            assert.deepEqual(statuses, [503], "the owner must reply to this denied send");
          } finally {
            responses.unsubscribe(observe);
          }
          const { rows } = await f.pool.query(
            "SELECT exchange_id FROM occ.prepared_repository_git_uses WHERE admission_id=$1",
            [f.admissionId],
          );
          assert.equal(rows.length, 0, "no business send was admitted");
        };
        const state = async () => {
          const { rows } = await f.pool.query(
            `SELECT id, admission, state, custody, material_version, usable_until,
             sealed, current_user FROM occ.prepared_github_attempts WHERE source_id=$1`,
            [f.familyId],
          );
          assert.equal(rows.length, 1);
          assert.equal(rows[0].current_user, "occ_app");
          assert.equal(rows[0].admission.familyId, f.familyId);
          assert.equal(rows[0].admission.grant.id, f.binding.grant.grantId);
          assert.equal(rows[0].admission.grant.repository, fixtureRepository);
          return rows[0];
        };
        const owner = await startSender();
        const pending = owner.maintain();
        let inFlight: { id: string; admission: unknown } | undefined;
        try {
          await Promise.race([
            issued,
            pending.then(() => {
              throw new Error("worker finished without reaching issuer");
            }),
          ]);
          const during = await state();
          assert.equal(during.state, "issuing");
          assert.equal(during.custody, "intent");
          assert.equal(during.material_version, null);
          assert.equal(during.sealed, null);
          inFlight = during;
          await denied();
        } finally {
          releaseIssuer();
          await pending;
        }
        assert.equal(await providerStatus(), 200, "the token is live at its actual repository");
        if (!wrongRepository) {
          const prepared = await send();
          assert.ok("headers" in prepared);
          assert.equal(typeof prepared.headers.authorization === "string", true);
          prepared.assertSendStart();
          assert.equal(
            await providerStatus(prepared.headers.authorization),
            200,
            "the actual native sender authorization must authenticate at the issuer",
          );
          assert.throws(() => prepared.assertSendStart(), /prepared-git-send-expired/);
          await f.withdraw();
          await owner.maintain();
          assert.equal(await providerStatus(), 401);
          assert.equal(gh.issuesOfTokens.length, 1);
          assert.deepEqual(gh.errors, []);
          return;
        }

        const saved = await state();
        assert.ok(inFlight);
        assert.equal(saved.id, inFlight.id);
        assert.deepEqual(saved.admission, inFlight.admission);
        assert.equal(saved.state, "quarantined");
        assert.equal(saved.custody, "retire");
        assert.equal(saved.material_version, null);
        assert.equal(saved.usable_until, null);
        assert.ok(Buffer.isBuffer(saved.sealed));
        assert.equal(saved.sealed.includes(Buffer.from(token)), false);
        await denied();
        await owner.close();
        const fresh = await startSender();
        assert.equal(
          JSON.stringify(await state()) === JSON.stringify(saved),
          true,
          "restart must preserve the same attempt, admission and sealed candidate",
        );
        await denied();

        const calls = gh.trace.length;
        await f.owner.maintain();
        assert.equal(f.gh.trace.length, 0, "foreign issuer must not retire or replace material");
        assert.equal(gh.trace.length, calls);
        assert.equal(JSON.stringify(await state()) === JSON.stringify(saved), true);
        await fresh.maintain();
        assert.equal(await providerStatus(), 401);
        await denied();
        const ended = await state();
        assert.equal(ended.id, saved.id);
        assert.equal(ended.state, "quarantined");
        assert.equal(ended.custody, "revoked");
        assert.equal(ended.material_version, null);
        assert.equal(ended.sealed, null);
        await fresh.maintain();
        await denied();
        assert.equal(JSON.stringify(await state()) === JSON.stringify(ended), true);
        assert.equal(gh.issuesOfTokens.length, 1);
        assert.deepEqual(
          gh.trace.map(({ method, tokenIndex }) => [method, tokenIndex]),
          [
            ["POST", undefined],
            ["GET", 1],
            ["DELETE", 1],
            ["GET", 1],
          ],
        );
        assert.deepEqual(gh.errors, []);
      });
    }
  },
);

// Refusal must come from the durable admission guard, before any issuer or retirement call.
async function assertUseGuarded(f: Awaited<ReturnType<typeof fixture>>) {
  const calls = f.gh.trace.length;
  await assert.rejects(f.owner.use(f.request()), /custody transaction did not complete \(guard\)/);
  assert.equal(f.gh.trace.length, calls, "denied use contacted the provider");
}

test(
  "protocol-3 native material has no trial ports and explicit use commits exactly one receipt",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    await prepare(f);
    const { rows: sessions } = await f.pool.query(
      "SELECT broker_protocol FROM occ.repository_session_attempts WHERE admission_id=$1",
      [f.admissionId],
    );
    assert.deepEqual(sessions, [{ broker_protocol: 3 }]);
    const { rows: prepared } = await f.pool.query(
      "SELECT id, material_version, admission FROM occ.prepared_github_attempts WHERE source_id=$1 AND custody='current' AND sealed IS NOT NULL",
      [f.familyId],
    );
    assert.equal(prepared.length, 1, "a real issued token must exist before testing the surface");
    // Both checks fail on the old owner even though its installation selects native Git.
    assert.equal("readOpenShellMaterial" in f.owner, false);
    assert.equal("authorizeOpenShellRequest" in f.owner, false);
    const uses = () =>
      f.pool.query(
        "SELECT exchange_id, admission_id, attempt_id, material_version, operation, request_digest_sha256 FROM occ.prepared_repository_git_uses WHERE admission_id=$1",
        [f.admissionId],
      );
    assert.deepEqual((await uses()).rows, []);
    // A selected protected owner cannot turn the bare native receipt into recipient custody.
    const protectedOwner = await startProtectedOwner(f);
    const authority = protectedOwner.protectedGit!;
    const route = { revisionId: f.revision.id, fence: 1, observed: {} };
    assert.deepEqual(await authority.readMaterial(route, t.signal), { absent: "unprepared" });
    assert.deepEqual(await authority.online.readMaterial(route, t.signal), {
      absent: "unprepared",
    });
    assert.deepEqual((await uses()).rows, []);
    const request = f.request();
    const used = await f.owner.use(request);
    assert.ok("value" in used);
    assert.equal(used.exchangeId, request.exchangeId);
    assert.equal(used.preparationAttemptId, prepared[0].id);
    assert.equal(used.materialVersion, prepared[0].material_version);
    assert.equal(prepared[0].admission.grant.id, f.binding.grant.grantId);
    assert.equal(prepared[0].admission.grant.repositoryId, f.binding.grant.repositoryId);
    assert.deepEqual((await uses()).rows, [
      {
        exchange_id: request.exchangeId,
        admission_id: f.admissionId,
        attempt_id: used.preparationAttemptId,
        material_version: used.materialVersion,
        operation: request.operation,
        request_digest_sha256: request.requestDigestSha256,
      },
    ]);
    assert.equal(await f.providerStatus(used.value), 200);
    await assert.rejects(f.owner.use(request), /23505/);
    assert.equal((await uses()).rowCount, 1, "replay cannot commit another possible use");
  },
);

test(
  "prepared Git use binds durable admission, exact ref, session and one exchange before retirement",
  {
    ...requiresPostgres,
    timeout: 60_000,
  },
  async (t) => {
    const f = await fixture(t);
    const familyRows = () =>
      f.pool.query("SELECT enabled FROM occ.prepared_github_families WHERE source_id=$1", [
        f.familyId,
      ]);
    assert.deepEqual((await familyRows()).rows, []);
    await assertUseGuarded(f);
    assert.equal(f.gh.issuesOfTokens.length, 0);
    assert.deepEqual((await familyRows()).rows, [], "cold use must not enroll a family");

    await prepare(f);
    const request = f.request({ operation: "receive-pack" });
    const beforeUse = f.gh.trace.length;
    const used = await f.owner.use(request);
    assert.ok("value" in used);
    assert.equal(used.exchangeId, request.exchangeId);
    assert.equal(typeof used.value, "string");
    assert.ok(used.value.length > 0);
    assert.ok(used.preparationAttemptId);
    assert.ok(used.materialVersion);
    const receipt = (
      await f.pool.query(
        `SELECT admission_id, attempt_id, material_version, operation, request_digest_sha256
       FROM occ.prepared_repository_git_uses WHERE exchange_id=$1`,
        [request.exchangeId],
      )
    ).rows;
    assert.deepEqual(receipt, [
      {
        admission_id: f.admissionId,
        attempt_id: used.preparationAttemptId,
        material_version: used.materialVersion,
        operation: request.operation,
        request_digest_sha256: request.requestDigestSha256,
      },
    ]);
    const material = (
      await f.pool.query("SELECT sealed FROM occ.prepared_github_attempts WHERE id=$1", [
        used.preparationAttemptId,
      ])
    ).rows[0];
    assert.ok(material.sealed instanceof Uint8Array);
    assert.equal(
      material.sealed.includes(Buffer.from(used.value)),
      false,
      "custody must not persist plaintext bearer",
    );
    const sendStartBy = Date.parse(used.sendStartBy);
    assert.ok(sendStartBy > Date.now() && sendStartBy <= Date.parse(request.deadlineAt));
    assert.equal(f.gh.trace.length, beforeUse, "warm use must not contact the issuer");

    for (const [name, rejected, code] of [
      ["cross ref", f.request({ operation: "receive-pack", pushRef: "refs/heads/other" }), "guard"],
      ["cross session", f.request({ sessionId: `session-${randomUUID()}` }), "guard"],
      ["duplicate exchange", request, "23505"],
    ] as const) {
      await t.test(name, async () =>
        assert.rejects(f.owner.use(rejected), {
          message: `Prepared GitHub custody transaction did not complete (${code}).`,
        }),
      );
    }
    assert.equal(f.gh.trace.length, beforeUse, "denials must not issue or retire provider tokens");
    assert.equal(
      await f.providerStatus(used.value),
      200,
      "returned material is an actual issued token",
    );

    // Closing the authoritative attempt denies immediately, before the periodic worker runs.
    await f.withdraw();
    await assertUseGuarded(f);
    await f.owner.maintain();
    assert.equal(await f.providerStatus(used.value), 401, "withdrawal retires the provider token");
    assert.equal(f.gh.issuesOfTokens.length, 1, "withdrawal must never replace the token");
    assert.deepEqual(f.gh.errors, []);
  },
);

for (const outcome of ["refused", "lost"]) {
  test(
    "prepared Git retirement with a " + outcome + " response never restores use or repeats",
    { ...requiresPostgres, timeout: 60_000 },
    async (t) => {
      const f = await fixture(t);
      await prepare(f);
      const used = await f.owner.use(f.request());
      assert.ok("value" in used);
      await f.withdraw();
      if (outcome === "refused") {
        f.gh.setRevokeStatus(503);
      } else {
        // GitHub commits DELETE, then drops its response. The owner cannot confirm revocation.
        f.gh.disconnectAfterMutation("DELETE", "/installation/token");
      }
      const revocations = () =>
        f.gh.trace.filter(
          (entry) => entry.method === "DELETE" && entry.target === "/installation/token",
        ).length;
      await assert.rejects(f.owner.maintain(), {
        message: /provider-unavailable|revocation is unconfirmed/,
      });
      const retained = () =>
        f.pool.query(
          "SELECT custody, sealed IS NOT NULL AS retained FROM occ.prepared_github_attempts WHERE id=$1",
          [used.preparationAttemptId],
        );
      assert.deepEqual((await retained()).rows, [{ custody: "unknown", retained: true }]);
      assert.equal(revocations(), 1, "the original retirement attempted one provider revoke");
      assert.equal(await f.providerStatus(used.value), outcome === "refused" ? 200 : 401);
      await assertUseGuarded(f);
      await f.owner.maintain();
      assert.deepEqual((await retained()).rows, [{ custody: "unknown", retained: true }]);
      assert.equal(revocations(), 1, "an unconfirmed revocation is never replayed");
      await assertUseGuarded(f);
      assert.equal(
        f.gh.issuesOfTokens.length,
        1,
        "ambiguous retirement cannot authorize replacement issuance",
      );
      assert.deepEqual(f.gh.errors, []);
    },
  );
}

for (const change of ["repository binding withdrawn", "revision superseded", "session expired"]) {
  test(
    "prepared Git refuses the same open broker session after " + change,
    requiresPostgres,
    async (t) => {
      const f = await fixture(t, change === "session expired" ? { sessionLifetimeMs: 4200 } : {});
      await prepare(f);
      const installed = await f.owner.use(f.request());
      assert.ok("value" in installed);
      const { agent, revision, sessionId } = f;
      if (change === "session expired") {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, f.deadlineWallMs + 25 - Date.now())),
        );
      } else {
        await f.state.transact(async (unit) => {
          if (change === "revision superseded") {
            const id = "rev_" + randomUUID();
            await unit.revisions.createRevision({ ...revision, id, revision: 2 } as AgentRevision);
            assert.ok(
              await unit.agents.compareAndSetActiveRevision(
                agent.namespaceId,
                agent.id,
                revision.id,
                id,
              ),
            );
          } else {
            // The State update made by PATCH Agent with its existing configurationId and repositoryBindings: [].
            // Do not close the broker, redeploy, or wait for background reconciliation to obtain this denial.
            const updated = await unit.agents.updateConfiguration(
              agent.namespaceId,
              agent.id,
              agent.configurationId,
              undefined,
              undefined,
              undefined,
              undefined,
              [],
            );
            assert.ok(updated);
            assert.equal(updated.activeRevisionId, revision.id);
            assert.deepEqual(updated.repositoryBindings ?? [], []);
          }
        });
      }
      await assertUseGuarded(f);
      assert.equal(
        await f.providerStatus(installed.value),
        200,
        "the online denial precedes provider retirement",
      );
      const receipt = await f.pool.query(
        "SELECT state FROM occ.repository_broker_receipts WHERE session_id=$1",
        [sessionId],
      );
      assert.equal(receipt.rows[0].state, "active");
      await f.owner.maintain();
      await assertUseGuarded(f);
      const family = await f.pool.query(
        "SELECT enabled FROM occ.prepared_github_families WHERE source_id=$1",
        [f.familyId],
      );
      assert.equal(
        family.rows[0].enabled,
        false,
        "withdrawal must fence the old family, not re-arm it",
      );
    },
  );
}

test(
  "discovery retires a replaced version's family from an earlier issuer authority without revoking it elsewhere",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    // Finding 2150: after the registry moved to another GitHub App origin or CA, the previous
    // authority's family for a replaced version stayed enabled with its token current forever.
    // Discovery under the new authority now retires it; revocation still never sends a token
    // to an authority other than the one that issued it, so the operator is told instead.
    const f = await fixture(t, { dnsIssuer: true });
    await prepare(f);
    const used = await f.owner.use(f.request());
    assert.ok("value" in used);
    const reports: Record<string, unknown>[] = [];
    // The same fixture provider under another origin spelling: another issuer authority.
    const next = await f.startOwner({
      apiOrigin: f.gh.origin,
      report: (code: string, context: Record<string, unknown>) =>
        reports.push({ code, ...context }),
    });
    const state = async () =>
      (
        await f.pool.query(
          `SELECT f.enabled, a.custody, a.sealed IS NOT NULL AS sealed
           FROM occ.prepared_github_families f JOIN occ.prepared_github_attempts a USING (source_id)
           WHERE f.source_id=$1`,
          [f.familyId],
        )
      ).rows;
    // While the version is live, its earlier-authority family is left alone: it cannot be
    // used under the new authority, and an overlapping earlier worker may still serve it.
    await next.maintain();
    assert.deepEqual(await state(), [{ enabled: true, custody: "current", sealed: true }]);
    assert.deepEqual(reports, []);
    const issued = f.gh.issuesOfTokens.length;
    // A new version replaces it.
    await f.state.transact(async (unit) => {
      const id = "rev_" + randomUUID();
      await unit.revisions.createRevision({ ...f.revision, id, revision: 2 } as AgentRevision);
      assert.ok(
        await unit.agents.compareAndSetActiveRevision(
          f.agent.namespaceId,
          f.agent.id,
          f.revision.id,
          id,
        ),
      );
    });
    const before = f.gh.trace.length;
    await next.maintain();
    assert.deepEqual(await state(), [{ enabled: false, custody: "retire", sealed: true }]);
    const {
      rows: [{ provider_expires_at: expires }],
    } = await f.pool.query(
      "SELECT provider_expires_at FROM occ.prepared_github_attempts WHERE id=$1",
      [used.preparationAttemptId],
    );
    assert.deepEqual(reports, [
      {
        code: "PREPARED_GITHUB_RETIRED_UNREVOKED",
        reason: "issuer_authority_changed",
        namespaceId: f.agent.namespaceId,
        revisionId: f.revision.id,
        repositoryRef: f.binding.repositoryRef,
        providerExpiresAt: expires.toISOString(),
      },
    ]);
    assert.equal(f.gh.trace.length, before, "the new authority never sends the old token");
    // Reported once: a later pass finds nothing new to retire and still sends nothing.
    await next.maintain();
    assert.equal(reports.length, 1);
    assert.equal(f.gh.trace.length, before);
    assert.equal(await f.providerStatus(used.value), 200, "retired, not revoked");
    // The issuing authority, if it comes back, revokes it as usual.
    await f.owner.maintain();
    assert.equal(await f.providerStatus(used.value), 401);
    assert.deepEqual(await state(), [{ enabled: false, custody: "revoked", sealed: false }]);
    assert.equal(f.gh.issuesOfTokens.length, issued, "retirement never issues");
    assert.deepEqual(f.gh.errors, []);
  },
);

test(
  "a worker whose App key goes bad after startup names the refusal in its maintenance report",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    // A rotated Secret with an unusable key used to log only PREPARED_GITHUB_MAINTENANCE_FAILED
    // on each pass. The pass now reports the startup refusal's code and fixed reason.
    const f = await fixture(t);
    const directory = await temporaryDirectory(t, "pgit-key-");
    const privateKeyPath = join(directory, "rotated.pem");
    await writeFile(privateKeyPath, f.gh.privateKey.export({ type: "pkcs8", format: "pem" }), {
      mode: 0o600,
    });
    // The real maintenance loop, started by hand once the key is replaced.
    let loop: ReturnType<TokenService["ownFamilies"]>;
    const tokenService = new (class extends TokenService {
      override ownFamilies(families: Parameters<TokenService["ownFamilies"]>[0]) {
        return (loop = super.ownFamilies(families));
      }
    })();
    const reports: Record<string, unknown>[] = [];
    let reported!: () => void;
    const firstReport = new Promise<void>((resolve) => (reported = resolve));
    await f.startOwner({
      privateKeyPath,
      tokenService,
      startWorker: false,
      report: (code: string, context: Record<string, unknown>) => {
        reports.push({ code, ...context });
        reported();
      },
    });
    // A public key cannot sign. The admitted session still needs a token, so the pass reads it.
    await writeFile(
      privateKeyPath,
      createPublicKey(f.gh.privateKey).export({ type: "spki", format: "pem" }),
    );
    loop!.start();
    // A pass that finds no source yet retries after 5 s; the test timeout bounds the wait.
    await firstReport;
    assert.deepEqual(reports[0], {
      code: "PREPARED_GITHUB_APP_KEY_INVALID",
      reason: "app_key_unparsable",
    });
    assert.equal(f.gh.issuesOfTokens.length, 0, "an unusable key never reaches the issuer");
    assert.deepEqual(f.gh.errors, []);
  },
);

for (const outcome of ["refused", "response lost"]) {
  test(
    "a new protected version gets Git material once its predecessor's " +
      outcome +
      " issuance has settled",
    { ...requiresPostgres, timeout: 60_000 },
    async (t) => {
      // Findings 2207/2208: an issue attempt that never settled hid every later session of the
      // Agent for the same repository, so the runbook recovery (fix the App key, deploy a new
      // version) waited at REPOSITORY_GIT_MATERIAL_PENDING forever.
      const f = await fixture(t);
      await disposeBrokerSession(f);
      const owner = await startProtectedOwner(f);
      const first = await admitProtectedVersion(f);
      if (outcome === "refused") {
        // A rejected App key: GitHub answers 401 and mints nothing.
        f.gh.setIssueStatus(401);
      } else {
        // GitHub mints the token, then its answer is lost.
        f.gh.disconnectAfterMutation(
          "POST",
          `/app/installations/${fixtureInstallationId}/access_tokens`,
        );
      }
      await owner.maintain();
      const attempts = async (familyId: string) =>
        (
          await f.pool.query(
            "SELECT state, custody FROM occ.prepared_github_attempts WHERE source_id=$1",
            [familyId],
          )
        ).rows;
      // Only a complete refusal with no token is terminal at once. A lost answer stays uncertain.
      assert.deepEqual(await attempts(first.familyId), [
        { state: "quarantined", custody: outcome === "refused" ? "not_issued" : "intent" },
      ]);
      const issued = outcome === "refused" ? 0 : 1;
      assert.equal(f.gh.issuesOfTokens.length, issued);
      f.gh.setIssueStatus(201);

      // The operator restores the key and deploys a new version; the old session ends.
      const second = await admitProtectedVersion(f, first.revision);
      await disposeProtectedSession(f, first);
      const read = () => owner.protectedGit.readMaterial(second.route, t.signal);
      if (outcome === "response lost") {
        // The lost token may be live for GitHub's maximum lifetime: the successor waits.
        await owner.maintain();
        assert.deepEqual(await read(), { absent: "unprepared" });
        assert.equal(f.gh.issuesOfTokens.length, issued);
        // Stand for the elapsed time: just inside the bound, it still waits.
        const age = (minutes: number) =>
          f.pool.query(
            "UPDATE occ.prepared_github_attempts SET started_at=clock_timestamp()-$2*interval '1 minute' WHERE source_id=$1",
            [first.familyId, minutes],
          );
        await age(71);
        await owner.maintain();
        assert.deepEqual(await read(), { absent: "unprepared" });
        // The one-minute dispatch window, ten minutes for GitHub to accept the attempt's JWT, one
        // hour of token life and the one-minute skew have passed: no token from it can be valid.
        await age(73);
      }
      await owner.maintain();
      assert.equal(f.gh.issuesOfTokens.length, issued + 1);
      const material = await read();
      assert.ok(material && "value" in material, "the successor received material");
      assert.equal(await f.providerStatus(material.value), 200);
      // The predecessor's attempt keeps its recorded outcome; settlement is never a rewrite.
      assert.deepEqual(await attempts(first.familyId), [
        { state: "quarantined", custody: outcome === "refused" ? "not_issued" : "intent" },
      ]);
      assert.deepEqual(f.gh.errors, []);
    },
  );
}

test(
  "native draft settlement uses its original receipt once after withdrawal without new authority",
  requiresPostgres,
  async (t) => {
    const f = await fixture(t, { draftPull: true, draftPullLimit: "none" });
    await prepare(f);
    const {
      exchangeId: _exchangeId,
      deadlineAt: _deadlineAt,
      ...use
    } = f.request({
      operation: "create-draft-pull",
      pull: {
        operationId: randomUUID(),
        apiOrigin: f.gh.origin,
        repository: f.registry.repositories[0]!.repository,
        head: "prepared-fixture",
        base: "main",
      },
    }) as import("../../packages/contracts/src/index.ts").PreparedGitHubUseRequest;
    const clock = createSystemClock();
    const prepared = await authorizePreparedGitSend(
      f.useSocketPath,
      clock,
      use,
      {},
      {
        signal: t.signal,
        deadlineMonoMs: clock.monotonicNow() + 10_000,
      },
    );
    assert.ok("settle" in prepared && prepared.settle);
    const receipts = () =>
      f.pool.query(
        "SELECT receipt_id,outcome,settled_at FROM occ.prepared_repository_draft_pulls WHERE grant_id=$1",
        [f.binding.grant.grantId],
      );
    const original = (await receipts()).rows;
    assert.equal(original.length, 1);
    assert.equal(original[0].outcome, "outcome_unknown");
    assert.equal(original[0].settled_at, null);
    // The operator's protected online opt-out never widens a native grant's one-draft allowance.
    const another = await f.owner.use(
      f.request({
        operation: "create-draft-pull",
        pull: { ...use.pull!, operationId: randomUUID() },
      }),
    );
    assert.ok("kind" in another && another.kind === "recorded");
    assert.equal(another.status, 409);
    assert.deepEqual((await receipts()).rows, original);
    await f.withdraw();
    const before = f.gh.trace.length;
    await prepared.settle("not-submitted");
    const settled = (await receipts()).rows;
    assert.equal(settled.length, 1);
    assert.equal(settled[0].receipt_id, original[0].receipt_id);
    assert.equal(settled[0].outcome, "not-submitted");
    assert.ok(settled[0].settled_at);
    await assert.rejects(prepared.settle("outcome_unknown"), /prepared-git-unavailable/);
    assert.deepEqual((await receipts()).rows, settled);
    await assertUseGuarded(f);
    assert.equal(
      f.gh.trace.length,
      before,
      "settlement and refusal release no authority to a provider",
    );
    assert.equal(
      (
        await f.pool.query("SELECT FROM occ.prepared_repository_git_uses WHERE admission_id=$1", [
          f.admissionId,
        ])
      ).rowCount,
      1,
    );
  },
);
