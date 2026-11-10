import assert from "node:assert/strict";
import { randomUUID, sign } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { buffer } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import {
  narrowOnlineGitJourney,
  selectedReadGitJourney,
  selectedReadGitTwoWorkerJourney,
  type SelectedReadJourney,
} from "../helpers/postgres-repository-set-journey.ts";
import { fixtureRepository } from "../fixtures/repository-credentials/github.mjs";
import { gitCommandBodies } from "../helpers/openshell-online-git-journey.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { standingExecutionPlatform } from "../helpers/postgres-standing-execution.ts";
import { preparedStandingGitPeer } from "../helpers/prepared-standing-git-peer.ts";
import type { DriverRegistrationRef } from "../../packages/contracts/src/index.ts";

type GitUseReceipt = {
  exchange_id: string;
  admission_id: string;
  attempt_id: string;
  material_version: string;
  operation: string;
  request_digest_sha256: string;
  send_start_by: Date | null;
  authorization_reply_by: Date;
};
type DraftClaim = Pick<
  GitUseReceipt,
  "request_digest_sha256" | "admission_id" | "attempt_id" | "material_version"
> & { receipt_id: string; outcome: string };

function signedGrantClient(
  {
    sandboxId,
    revision,
    grant: authority,
  }: Pick<SelectedReadJourney, "sandboxId" | "revision" | "grant">,
  providerId: string,
) {
  const bindingId = revision.egressPlan!.execution.executionId;
  const credentialKey = "installation_token";
  const assertion = (recipient = sandboxId, provider = providerId, key = credentialKey) => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({
        alg: "EdDSA",
        kid: "git-grant",
        typ: "openshell-provider-assertion+jwt",
      }),
    ).toString("base64url");
    const claims = Buffer.from(
      JSON.stringify({
        iss: authority.issuer,
        aud: authority.endpoint,
        sub: `openshell-sandbox:${recipient}`,
        sandbox_id: recipient,
        caller_kind: "supervisor",
        provider_id: provider,
        credential_key: key,
        iat: now,
        exp: now + 60,
        jti: randomUUID(),
      }),
    ).toString("base64url");
    const input = `${header}.${claims}`;
    return `${input}.${sign(null, Buffer.from(input), authority.keys.privateKey).toString("base64url")}`;
  };
  const grant = (requestId: string, clientAssertion: string, resource = bindingId) =>
    new Promise<{ status: number; value: string | undefined }>((resolve, reject) => {
      const form = new URLSearchParams({
        grant_type: "client_credentials",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: clientAssertion,
        audience: resource,
      }).toString();
      const req = httpsRequest(
        {
          hostname: "127.0.0.1",
          servername: "localhost",
          port: authority.port,
          path: "/token",
          method: "POST",
          ca: authority.ca,
          agent: false,
          signal: AbortSignal.timeout(5000),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "content-length": Buffer.byteLength(form),
            "x-openshell-request-id": requestId,
          },
        },
        async (response) => {
          try {
            const result = JSON.parse((await buffer(response)).toString()) as {
              access_token?: string;
            };
            resolve({ status: response.statusCode!, value: result.access_token });
          } catch (error) {
            reject(error);
          }
        },
      );
      req.on("error", reject);
      req.end(form);
    });
  return { assertion, grant, bindingId };
}

function signedColdGitJourney(shared: boolean, withdrawWhileIssuing = false) {
  return async (t: TestContext) => {
    await selectedReadGitJourney(
      t,
      import.meta.url,
      async ({
        runtime,
        peer,
        pool,
        workspace,
        sandboxId,
        revision,
        removeBinding,
        grant: authority,
        evaluateRequest,
        waitForIssuance,
        finishIssuance,
      }) => {
        const bindingId = revision.egressPlan!.execution.executionId;
        const original = await runtime.lookup(
          { sandboxId, bindingId, requestId: randomUUID(), workspace },
          t.signal,
        );
        assert.ok(original?.installed.route);
        assert.deepEqual(
          (
            await pool.query(
              `SELECT observed->>'credentialState' AS state, preparation_attempt_id, material_version
               FROM occ.credential_deliveries WHERE revision_id=$1`,
              [revision.id],
            )
          ).rows,
          [{ state: "active", preparation_attempt_id: null, material_version: null }],
        );
        const observed = original.installed.route.observed as { providerId: string };
        const { assertion, grant } = signedGrantClient(
          { sandboxId, revision, grant: authority },
          observed.providerId,
        );
        const approve = async (upload: boolean, requestedRepository = fixtureRepository) => {
          const request = peer.input(bindingId, sandboxId, upload, workspace);
          request.target.path = request.target.path.replace(fixtureRepository, requestedRepository);
          const decision = await evaluateRequest(request);
          return { requestId: request.context.request_id, decision: decision.decision };
        };
        const receipts = async () =>
          (
            await pool.query<{ operation: string }>(
              `SELECT operation FROM occ.prepared_repository_git_uses u
           JOIN occ.repository_session_attempts s USING (admission_id)
           WHERE s.revision_id=$1 ORDER BY authorization_reply_by`,
              [revision.id],
            )
          ).rows.map(({ operation }) => operation);
        const issuance = peer.gh.issuesOfTokens.length;
        assert.equal(issuance, 0, "the selected route starts before any installation token exists");
        const foreignRepository = await approve(false, "fixture/unselected");
        assert.equal(foreignRepository.decision, 2);
        assert.equal((await grant(foreignRepository.requestId, assertion())).status, 403);
        const discovery = await approve(false);
        assert.equal(discovery.decision, 1);
        assert.deepEqual(
          await receipts(),
          [],
          "inspection does not disclose or spend the credential",
        );
        assert.equal((await grant(discovery.requestId, assertion("foreign-sandbox"))).status, 403);
        assert.equal(
          (await grant(discovery.requestId, assertion(sandboxId, "wrong-provider"))).status,
          403,
        );
        assert.equal(
          (await grant(discovery.requestId, assertion(sandboxId, observed.providerId, "wrong-key")))
            .status,
          403,
        );
        assert.equal((await grant(discovery.requestId, assertion(), "wrong-binding")).status, 403);
        assert.equal(peer.gh.issuesOfTokens.length, 0, "authorization and bad grants never mint");
        const signedGrant = assertion();
        const originBeforeIssuance = peer.originCalls();
        const redemption = grant(discovery.requestId, signedGrant);
        try {
          await waitForIssuance();
          assert.deepEqual(await receipts(), [], "held issuer has not released material");
          if (withdrawWhileIssuing) {
            await removeBinding();
          }
        } finally {
          finishIssuance();
        }
        const allowed = await redemption;
        if (withdrawWhileIssuing) {
          assert.deepEqual(allowed, { status: 403, value: undefined });
          assert.equal(
            peer.gh.issuesOfTokens.length,
            1,
            "the controlled provider completed its issue",
          );
          assert.deepEqual(await receipts(), [], "no use is recorded after withdrawal");
          assert.equal(
            peer.originCalls(),
            originBeforeIssuance,
            "no Git traffic reached the origin",
          );
          assert.equal((await grant(discovery.requestId, assertion())).status, 403);
          return;
        }
        assert.equal(allowed.status, 200);
        assert.ok(allowed.value);
        assert.equal(peer.gh.issuesOfTokens.length, 1);
        assert.deepEqual(peer.gh.issuesOfTokens[0].repositoryIds, [73]);
        assert.deepEqual(peer.gh.issuesOfTokens[0].permissions, {
          metadata: "read",
          contents: "read",
        });
        assert.equal((await peer.send(allowed.value, false)).status, 200);
        assert.deepEqual(await receipts(), ["advertise-upload-pack"]);
        assert.equal((await grant(discovery.requestId, signedGrant)).status, 403);
        const another = await approve(true);
        assert.equal(another.decision, 1);
        assert.equal(
          (await grant(another.requestId, signedGrant)).status,
          403,
          "a new request cannot reuse a signed JTI",
        );
        const fetch = await approve(true);
        assert.equal(fetch.decision, 1);
        const fetched = await grant(fetch.requestId, assertion());
        assert.equal(fetched.status, 200);
        assert.ok(fetched.value);
        assert.equal((await peer.send(fetched.value, true)).status, 200);
        const before = await receipts();
        assert.deepEqual(before, ["advertise-upload-pack", "upload-pack"]);

        if (!shared) {
          // Rotation must still fence a warm token, while maintenance cannot mint its successor.
          await peer.rotateAppKey();
          await peer.prepared.maintain();
          assert.deepEqual(
            (
              await pool.query(
                `SELECT custody FROM occ.prepared_github_attempts
           WHERE source_id IN (SELECT 'repository-git:' || admission_id
             FROM occ.repository_session_attempts WHERE revision_id=$1)`,
                [revision.id],
              )
            ).rows,
            [{ custody: "retire" }],
          );
          assert.equal(peer.gh.issuesOfTokens.length, 1, "rotation does not prewarm a replacement");
        } else {
          const state = await pool.query<{ family_id: string; custody: string }>(
            `SELECT m.family_id, a.custody FROM occ.prepared_github_shared_members m
           JOIN occ.repository_session_attempts s USING (admission_id)
           JOIN occ.prepared_github_attempts a ON a.source_id=m.family_id
           WHERE s.revision_id=$1`,
            [revision.id],
          );
          assert.equal(state.rowCount, 1);
          assert.match(state.rows[0]!.family_id, /^repository-git-shared:[0-9a-f]{64}$/);
          assert.equal(state.rows[0]!.custody, "current");
        }
        const pending = await approve(true);
        assert.equal(pending.decision, 1);
        const traffic = peer.originCalls();
        await removeBinding();
        const {
          rows: [approval],
        } = await pool.query<{ expires_at: Date }>(
          "SELECT expires_at FROM occ.request_credential_approvals WHERE request_id=$1",
          [pending.requestId],
        );
        assert.ok(
          approval && approval.expires_at.getTime() > Date.now() + 1000,
          "withdrawal is tested before the approval expires",
        );
        assert.equal((await grant(pending.requestId, assertion())).status, 403);
        assert.deepEqual(await receipts(), before);
        assert.equal(peer.originCalls(), traffic);
        assert.equal(
          peer.gh.issuesOfTokens.length,
          1,
          "later redemptions reuse the committed token and withdrawal prevents issuance",
        );
        await peer.prepared.maintain();
        assert.deepEqual(
          (
            await pool.query(
              `SELECT custody, sealed IS NULL AS erased FROM occ.prepared_github_attempts
           WHERE source_id IN (
             ${
               shared
                 ? `SELECT m.family_id FROM occ.prepared_github_shared_members m
                  JOIN occ.repository_session_attempts s USING (admission_id)
                  WHERE s.revision_id=$1`
                 : `SELECT 'repository-git:' || admission_id FROM occ.repository_session_attempts
                  WHERE revision_id=$1`
             }
           )`,
              [revision.id],
            )
          ).rows,
          [{ custody: "revoked", erased: true }],
          "the original worker retires its own material after withdrawal",
        );
      },
      shared ? true : undefined,
    );
  };
}
test(
  "two independently bound Git Workers share one mint without sharing request authority",
  { ...requiresPostgres, timeout: 90_000 },
  async (t) => {
    const contentions = new Map<string, () => void>();
    const expectContention = (requestId: string) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      contentions.set(requestId, resolve);
      return async () => {
        try {
          await Promise.race([
            promise,
            delay(1500, undefined, { ref: false }).then(() => {
              throw new Error("The signed request did not observe PostgreSQL quota contention.");
            }),
          ]);
        } finally {
          contentions.delete(requestId);
        }
      };
    };
    const exercise = async (first: SelectedReadJourney, second: SelectedReadJourney) => {
      async function client(journey: SelectedReadJourney) {
        const { pool, peer, revision, runtime, sandboxId, workspace } = journey;
        const bindingId = revision.egressPlan!.execution.executionId;
        const route = await runtime.lookup(
          { sandboxId, bindingId, requestId: randomUUID(), workspace },
          t.signal,
        );
        assert.ok(route?.installed.route);
        const { providerId } = route.installed.route.observed as { providerId: string };
        const approval = async (upload = false) => {
          const input = peer.input(bindingId, sandboxId, upload, workspace);
          const decision = await journey.evaluateRequest(input);
          assert.equal(decision.decision, 1, decision.reason_code);
          return input.context.request_id;
        };
        const delivery = async () => {
          const { rows } = await pool.query<{ worker_instance: string; fence: number }>(
            "SELECT worker_instance, fence FROM occ.credential_deliveries WHERE revision_id=$1",
            [revision.id],
          );
          assert.equal(rows.length, 1);
          return rows[0]!;
        };
        return { ...signedGrantClient(journey, providerId), approval, providerId, delivery };
      }

      const a = await client(first);
      const b = await client(second);
      const originalA = await a.delivery();
      const originalB = await b.delivery();
      assert.notEqual(originalA.worker_instance, originalB.worker_instance);
      assert.notEqual(first.revision.agentId, second.revision.agentId);
      assert.notEqual(first.sandboxId, second.sandboxId);
      assert.notEqual(first.grant.endpoint, second.grant.endpoint);
      assert.notEqual(first.pool, second.pool);
      assert.equal(first.revision.namespaceId, second.revision.namespaceId);
      assert.equal(first.peer.gh.issuesOfTokens.length, 0);

      async function holdQuota<T>(exercise: () => Promise<T>) {
        const owner = await first.pool.connect();
        try {
          await owner.query("BEGIN");
          await owner.query("SELECT pg_advisory_xact_lock(1868785008, 0)");
          return await exercise();
        } finally {
          try {
            await owner.query("ROLLBACK");
          } finally {
            owner.release(true);
          }
        }
      }
      const approvals = async (...ids: string[]) =>
        (
          await first.pool.query<{ request_id: string; recipient_id: string; consumed: boolean }>(
            `SELECT request_id, recipient_id, consumed FROM occ.request_credential_approvals
         WHERE request_id = ANY($1::text[]) ORDER BY request_id`,
            [ids],
          )
        ).rows;
      const expired = second.peer.input(b.bindingId, second.sandboxId, false, second.workspace);
      await holdQuota(async () => {
        const sawContention = expectContention(expired.context.request_id);
        const refusal = second.evaluateRequest(expired, 300).then(
          ({ decision }) => assert.equal(decision, 2),
          (error: { code: number }) =>
            assert.equal(error.code, 4, "original gRPC deadline elapsed"),
        );
        await sawContention();
        await refusal;
      });
      assert.deepEqual(await approvals(expired.context.request_id), []);
      assert.deepEqual(await b.grant(expired.context.request_id, b.assertion()), {
        status: 403,
        value: undefined,
      });

      const inputA = first.peer.input(a.bindingId, first.sandboxId, false, first.workspace);
      const inputB = second.peer.input(b.bindingId, second.sandboxId, false, second.workspace);
      const requestA = inputA.context.request_id;
      const requestB = inputB.context.request_id;
      const waiting = await holdQuota(async () => {
        const sawA = expectContention(requestA);
        const sawB = expectContention(requestB);
        const decisions = [first.evaluateRequest(inputA), second.evaluateRequest(inputB)];
        await Promise.all([sawA(), sawB()]);
        assert.deepEqual(await approvals(requestA, requestB), [], "contention precedes any write");
        return decisions;
      });
      const [decisionA, decisionB] = await Promise.all(waiting);
      assert.equal(decisionA!.decision, 1, decisionA!.reason_code);
      assert.equal(decisionB!.decision, 1, decisionB!.reason_code);
      const committed = await approvals(requestA, requestB);
      assert.deepEqual(
        new Map(committed.map((row) => [row.request_id, row.recipient_id])),
        new Map([
          [requestA, first.sandboxId],
          [requestB, second.sandboxId],
        ]),
      );
      assert.equal(committed.length, 2);
      assert.ok(committed.every((row) => !row.consumed));
      assert.equal(
        (await first.evaluateRequest(inputA)).decision,
        2,
        "duplicate request stays denied",
      );
      assert.deepEqual(await approvals(requestA, requestB), committed);
      // Use the trusted fixture signer's JWT for B's exact endpoint. A's recipient,
      // binding and request ID are otherwise correct. B cannot redeem A's approval.
      const wrongOwner = b.assertion(first.sandboxId, a.providerId);
      assert.deepEqual(await b.grant(requestA, wrongOwner, a.bindingId), {
        status: 403,
        value: undefined,
      });
      const {
        rows: [approvalA],
      } = await first.pool.query<{ consumed: boolean }>(
        "SELECT consumed FROM occ.request_credential_approvals WHERE recipient_id=$1 AND request_id=$2",
        [first.sandboxId, requestA],
      );
      assert.equal(approvalA?.consumed, false);
      assert.equal(first.peer.gh.issuesOfTokens.length, 0);

      const [tokenA, tokenB] = await Promise.all([
        a.grant(requestA, a.assertion()),
        b.grant(requestB, b.assertion()),
        first.waitForIssuance().finally(first.finishIssuance),
      ]);
      assert.equal(tokenA.status, 200);
      assert.equal(tokenB.status, 200);
      assert.ok(tokenA.value && tokenA.value === tokenB.value, "both recipients use one token");
      assert.equal(first.peer.gh.issuesOfTokens.length, 1);
      assert.equal((await first.peer.send(tokenA.value, false)).status, 200);
      assert.equal((await second.peer.send(tokenB.value, false)).status, 200);

      const { rows: receipts } = await first.pool.query<{
        revision_id: string;
        admission_id: string;
        material_version: string;
        family_id: string;
      }>(
        `SELECT s.revision_id, s.admission_id, u.material_version, m.family_id
       FROM occ.prepared_repository_git_uses u
       JOIN occ.repository_session_attempts s USING (admission_id)
       JOIN occ.prepared_github_shared_members m USING (admission_id)
       WHERE s.revision_id = ANY($1::text[])`,
        [[first.revision.id, second.revision.id]],
      );
      assert.deepEqual(
        new Set(receipts.map((row) => row.revision_id)),
        new Set([first.revision.id, second.revision.id]),
      );
      assert.equal(receipts.length, 2);
      assert.equal(new Set(receipts.map((row) => row.admission_id)).size, 2);
      assert.equal(new Set(receipts.map((row) => row.family_id)).size, 1);
      assert.equal(new Set(receipts.map((row) => row.material_version)).size, 1);

      assert.deepEqual(await a.delivery(), originalA);
      const withdrawnRequest = await a.approval();
      const withdrawing = first.peer.input(a.bindingId, first.sandboxId, true, first.workspace);
      const withdrawingId = withdrawing.context.request_id;
      const withdrawal = await holdQuota(async () => {
        const sawContention = expectContention(withdrawingId);
        let answered = false;
        const decision = first.evaluateRequest(withdrawing).finally(() => (answered = true));
        await sawContention();
        // Withdrawal commits while the original authorization waits outside its transaction.
        await first.removeBinding();
        assert.equal(
          answered,
          false,
          "withdrawal commits while the original request is still live",
        );
        return { decision };
      });
      assert.equal((await withdrawal.decision).decision, 2);
      assert.deepEqual(await approvals(withdrawingId), [], "retry rereads the withdrawn grant");
      assert.deepEqual(await a.grant(withdrawingId, a.assertion()), {
        status: 403,
        value: undefined,
      });
      assert.deepEqual(await a.grant(withdrawnRequest, a.assertion()), {
        status: 403,
        value: undefined,
      });
      await first.peer.prepared.maintain();
      const retained = await b.grant(await b.approval(true), b.assertion());
      assert.equal(retained.status, 200);
      assert.ok(retained.value && retained.value === tokenB.value, "B keeps the eligible token");
      const fetch = await second.peer.send(retained.value, true);
      assert.equal(fetch.status, 200);
      assert.ok(fetch.bytes.includes("PACK"));
      assert.equal(first.peer.gh.issuesOfTokens.length, 1);
      assert.deepEqual(await b.delivery(), originalB);
    };
    await selectedReadGitTwoWorkerJourney(t, import.meta.url, exercise, (id, outcome) => {
      if (outcome === "contended") {
        contentions.get(id)?.();
      }
    });
  },
);

test(
  "cold Git HTTPS grant mints only on authenticated redemption and refuses withdrawal",
  { ...requiresPostgres, timeout: 90_000 },
  signedColdGitJourney(false),
);
test(
  "cold Git HTTPS grant refuses token release after withdrawal during issuance",
  { ...requiresPostgres, timeout: 90_000 },
  signedColdGitJourney(false, true),
);
test(
  "Git HTTPS redemption reuses a committed shared-family token and denies withdrawal while warm",
  { ...requiresPostgres, timeout: 90_000 },
  signedColdGitJourney(true),
);
test(
  "shared Git HTTPS redemption refuses token release after withdrawal during issuance",
  { ...requiresPostgres, timeout: 90_000 },
  signedColdGitJourney(true, true),
);

for (const { name, action, expectedDenial } of [
  {
    name: "OCE signed TLS Git authorization: stopping the Agent denies a fresh signed Git request",
    action: "stop",
    expectedDenial: "access_withdrawn",
  },
  {
    name: "OCE signed TLS Git authorization: removing the repository binding denies a fresh signed Git request",
    action: "removeBinding",
    expectedDenial: "access_withdrawn",
  },
]) {
  test(name, { ...requiresPostgres, timeout: 90_000 }, async (t) => {
    await narrowOnlineGitJourney(
      t,
      import.meta.url,
      async ({
        pool,
        peer,
        sandboxId,
        pushRef,
        grantId,
        installed,
        evaluate: signedEvaluate,
        withLookupFault,
        heldCredentialStatus,
        admissionId,
        removeBinding,
        withdraw,
      }) => {
        assert.equal(await heldCredentialStatus(), 200);
        const receipts = async () =>
          (
            await pool.query<GitUseReceipt>(
              `SELECT exchange_id, admission_id, attempt_id, material_version,
                  operation, request_digest_sha256, send_start_by, authorization_reply_by
           FROM occ.prepared_repository_git_uses WHERE admission_id=$1 ORDER BY exchange_id`,
              [admissionId],
            )
          ).rows;
        assert.equal((await receipts()).length, 0, "delivery does not spend an online use");
        const evaluate = async (
          input: Parameters<typeof signedEvaluate>[0],
          operation: string | undefined,
          signedSandbox = sandboxId,
          reason = "online_authorization_denied",
        ) => {
          const before = await receipts();
          const issued = peer.gh.issuesOfTokens.length;
          const sent = peer.originCalls() + peer.gh.trace.length;
          const result = await signedEvaluate(input, signedSandbox);
          assert.deepEqual(
            result,
            operation ? { decision: 1 } : { decision: 2, reason_code: reason },
          );
          const after = await receipts();
          assert.equal(peer.gh.issuesOfTokens.length, issued, "authorization never issues a token");
          assert.equal(
            peer.originCalls() + peer.gh.trace.length,
            sent,
            "authorization never sends or replays a provider request",
          );
          if (!operation) {
            assert.deepEqual(after, before, "denial must not add a durable possible-use receipt");
            return;
          }
          const added = after.filter(
            (row) => !before.some((prior) => prior.exchange_id === row.exchange_id),
          );
          assert.equal(after.length, before.length + 1);
          assert.equal(added.length, 1);
          assert.ok(added[0]);
          const {
            exchange_id,
            request_digest_sha256,
            send_start_by,
            authorization_reply_by,
            ...scope
          } = added[0];
          assert.equal(send_start_by, null);
          assert.ok(authorization_reply_by);
          assert.ok(exchange_id);
          assert.match(request_digest_sha256, /^[0-9a-f]{64}$/);
          assert.deepEqual(scope, {
            admission_id: admissionId,
            attempt_id: installed.preparationAttemptId,
            material_version: installed.materialVersion,
            operation,
          });
          return added[0];
        };
        // Targets are inspected protocol data only. There is no downstream dispatcher;
        // an ALLOW and its receipt prove possible use, never successful sending.
        const target = (method: string, suffix: string, query = "") => ({
          scheme: "https",
          host: "github.com",
          port: 443,
          method,
          path: `/${fixtureRepository}.git/${suffix}`,
          query,
        });
        const discovery = (service: string) => ({
          target: target("GET", "info/refs", `service=git-${service}`),
        });
        const command = (service: string, body: Buffer) => ({
          target: target("POST", `git-${service}`),
          headers: [{ name: "content-type", value: `application/x-git-${service}-request` }],
          body,
        });
        const checkWithdrawal = async () => {
          // Each action gets a freshly admitted Agent with a still-selected binding.
          // A fresh signed allow proves the route is usable immediately before mutation.
          assert.equal(await heldCredentialStatus(), 200);
          await evaluate(discovery("upload-pack"), "advertise-upload-pack");
          if (action === "stop") {
            await withdraw();
          } else {
            await removeBinding();
          }
          await evaluate(discovery("upload-pack"), undefined, sandboxId, expectedDenial);
          assert.equal(await heldCredentialStatus(), 200);
          assert.equal(peer.gh.issuesOfTokens.length, 1);
          assert.deepEqual(peer.gh.errors, []);
        };
        if (action === "removeBinding") {
          await checkWithdrawal();
          return;
        }
        const bodies = await gitCommandBodies(t, pushRef);
        await evaluate(discovery("upload-pack"), "advertise-upload-pack");
        await evaluate(command("upload-pack", bodies.fetch), "upload-pack");
        await evaluate(discovery("receive-pack"), "advertise-receive-pack");
        // Each refusal names what the Agent can do (finding 2149): a mixed-ref push is not allowed.
        await evaluate(
          command("receive-pack", bodies.mixed),
          undefined,
          sandboxId,
          "request_not_allowed",
        );
        await evaluate(command("receive-pack", bodies.push), "receive-pack");
        await evaluate(discovery("upload-pack"), undefined, `unknown-sandbox-${randomUUID()}`);
        await withLookupFault("material", async () => {
          await evaluate(discovery("upload-pack"), undefined, sandboxId, "route_not_ready");
        });
        await evaluate(discovery("upload-pack"), "advertise-upload-pack");

        // Authorize exactly one draft, but do not send it. An unobserved result is
        // deliberately unresolved; another request, even with a new RPC id, must not receive an allow.
        const draftTarget = new URL(
          "/repos/" + fixtureRepository + "/pulls",
          "https://api.github.com",
        );
        const draft = {
          target: {
            scheme: "https",
            host: draftTarget.hostname,
            port: Number(draftTarget.port || 443),
            method: "POST",
            path: draftTarget.pathname,
          },
          headers: [{ name: "content-type", value: "application/json" }],
          body: Buffer.from(
            JSON.stringify({
              title: "Review the owned change",
              head: pushRef.slice("refs/heads/".length),
              base: "main",
              body: "",
              draft: true,
              maintainer_can_modify: false,
            }),
          ),
        };
        const draftUse = await evaluate(draft, "create-draft-pull");
        assert.ok(draftUse);
        const draftClaims = async () =>
          (
            await pool.query<DraftClaim>(
              `SELECT receipt_id, request_digest_sha256, admission_id, attempt_id,
                  material_version, outcome
           FROM occ.prepared_repository_draft_pulls WHERE grant_id=$1`,
              [grantId],
            )
          ).rows;
        const claims = await draftClaims();
        assert.equal(claims.length, 1);
        const claim = claims[0];
        assert.ok(claim);
        // The spent allowance must belong to this exact authorized use.
        assert.equal(claim.receipt_id, draftUse.exchange_id);
        assert.equal(claim.request_digest_sha256, draftUse.request_digest_sha256);
        assert.equal(claim.admission_id, draftUse.admission_id);
        assert.equal(claim.attempt_id, draftUse.attempt_id);
        assert.equal(claim.material_version, draftUse.material_version);
        assert.equal(claim.outcome, "outcome_unknown");
        // The refusal names the spent draft (finding 2147).
        await evaluate(draft, undefined, sandboxId, "draft_already_opened");
        assert.deepEqual(
          await draftClaims(),
          claims,
          "denial must preserve the original draft claim",
        );

        await checkWithdrawal();
        // A stopped Agent leaves a real retirement obligation. Another fixture must
        // not try to decrypt it with that fixture's independently generated custody key.
        const familyId = "repository-git:" + admissionId;
        const { rows: families } = await pool.query<{ driver: DriverRegistrationRef }>(
          `SELECT source #> '{session,credentialProxyExecution,driver}' AS driver
           FROM occ.prepared_github_families WHERE source_id=$1`,
          [familyId],
        );
        assert.equal(families.length, 1);
        await t.test("another fixture cannot inherit a stopped Agent's custody", async (later) => {
          const next = await standingExecutionPlatform(later, import.meta.url);
          const other = await preparedStandingGitPeer(later, next.observerPool, next.namespace.id, {
            driver: families[0]!.driver,
          });
          await other.prepared.maintain();
          assert.equal(
            (await next.observerPool.query("SELECT count(*) FROM occ.prepared_github_families"))
              .rows[0].count,
            "0",
          );
        });
        // The original owner still retires its token through the provider; isolation
        // must not replace retirement with deletion or weaken its custody checks.
        await peer.prepared.maintain();
        assert.deepEqual(
          (
            await pool.query(
              "SELECT custody, sealed IS NULL AS erased FROM occ.prepared_github_attempts WHERE source_id=$1",
              [familyId],
            )
          ).rows,
          [{ custody: "revoked", erased: true }],
        );
        t.diagnostic(
          "OCE authority and durable state only; no installed sender or provider dispatch claimed.",
        );
      },
    );
  });
}

test(
  "OCE signed TLS Git authorization admits a Git-only branch pattern and refuses other destinations",
  { ...requiresPostgres, timeout: 90_000 },
  async (t) => {
    await narrowOnlineGitJourney(
      t,
      import.meta.url,
      async ({ pool, admissionId, evaluate, pushRef }) => {
        assert.equal(pushRef, "refs/heads/review/*");
        const receipts = async () =>
          (
            await pool.query<{ operation: string }>(
              "SELECT operation FROM occ.prepared_repository_git_uses WHERE admission_id=$1 ORDER BY operation",
              [admissionId],
            )
          ).rows;
        const target = (method: string, suffix: string, query = "") => ({
          scheme: "https",
          host: "github.com",
          port: 443,
          method,
          path: `/${fixtureRepository}.git/${suffix}`,
          query,
        });
        // Real admission and runtime lookup deliver the registry's pattern unchanged to
        // the TLS authorizer. A pattern is policy; each pushed destination is a concrete ref.
        const allowed = await gitCommandBodies(t, "refs/heads/review/change");
        const main = await gitCommandBodies(t, "refs/heads/main");
        const command = (service: string, body: Buffer) => ({
          target: target("POST", `git-${service}`),
          headers: [{ name: "content-type", value: `application/x-git-${service}-request` }],
          body,
        });
        assert.deepEqual(await receipts(), []);
        assert.deepEqual(
          await evaluate({ target: target("GET", "info/refs", "service=git-upload-pack") }),
          { decision: 1 },
        );
        assert.deepEqual(await evaluate(command("upload-pack", allowed.fetch)), { decision: 1 });
        assert.deepEqual(await evaluate(command("receive-pack", allowed.push)), { decision: 1 });
        const approved = await receipts();
        assert.deepEqual(approved, [
          { operation: "advertise-upload-pack" },
          { operation: "receive-pack" },
          { operation: "upload-pack" },
        ]);
        // Denied pushes never spend a possible-use receipt, even when one update is allowed.
        for (const body of [main.push, allowed.mixed]) {
          assert.deepEqual(await evaluate(command("receive-pack", body)), {
            decision: 2,
            reason_code: "request_not_allowed",
          });
          assert.deepEqual(await receipts(), approved);
        }
        t.diagnostic(
          "Real runtime lookup, signed TLS authorization and PostgreSQL receipts; no provider dispatch.",
        );
      },
      { draftPull: false, pushRef: "refs/heads/review/*" },
    );
  },
);
