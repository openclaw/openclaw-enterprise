import assert from "node:assert/strict";
import { randomUUID, sign } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { buffer } from "node:stream/consumers";
import test from "node:test";
import {
  narrowOnlineGitJourney,
  selectedReadGitJourney,
} from "../helpers/postgres-repository-set-journey.ts";
import { fixtureRepository } from "../fixtures/repository-credentials/github.mjs";
import { gitCommandBodies } from "../helpers/openshell-online-git-journey.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { standingExecutionPlatform } from "../helpers/postgres-standing-execution.ts";
import { preparedStandingGitPeer } from "../helpers/prepared-standing-git-peer.ts";
import { runOpenShellPlaceholderWire } from "../helpers/postgres-openshell-placeholder-wire.ts";
import type { DriverRegistrationRef } from "../../packages/contracts/src/index.ts";

const openShellWireBinary = process.env.OCC_TEST_OPENSHELL_PLACEHOLDER_WIRE_BINARY;
if (openShellWireBinary !== undefined) {
  test(
    "OpenShell inspected Git fetch redeems the active grant and refuses withdrawal",
    {
      timeout: 90_000,
    },
    (t) => runOpenShellPlaceholderWire(t, import.meta.url, openShellWireBinary),
  );
}

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

for (const { name, withdrawWhileIssuing } of [
  {
    name: "cold Git HTTPS grant mints only on authenticated redemption and refuses withdrawal",
    withdrawWhileIssuing: false,
  },
  {
    name: "cold Git HTTPS grant refuses token release after withdrawal during issuance",
    withdrawWhileIssuing: true,
  },
]) {
  test(name, { ...requiresPostgres, timeout: 90_000 }, async (t) => {
    await selectedReadGitJourney(
      t,
      import.meta.url,
      async ({
        runtime,
        peer,
        launch,
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
        const credentialKey = "installation_token";
        const assertion = (
          recipient = sandboxId,
          provider = observed.providerId,
          key = credentialKey,
        ) => {
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
        assert.ok(
          launch.environment.every(({ name }) => name !== "GITHUB_TOKEN"),
          "OCE supplies no provider token in the Harness launch environment",
        );
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
                 SELECT 'repository-git:' || admission_id FROM occ.repository_session_attempts
                 WHERE revision_id=$1
               )`,
              [revision.id],
            )
          ).rows,
          [{ custody: "revoked", erased: true }],
          "the original worker retires its own material after withdrawal",
        );
      },
    );
  });
}

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
