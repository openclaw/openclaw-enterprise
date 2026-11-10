import assert from "node:assert/strict";
import { randomUUID, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import test, { type TestContext } from "node:test";
import {
  narrowOnlineGitJourney,
  selectedGrantGitJourney,
  selectedReadGitJourney,
} from "../helpers/postgres-repository-set-journey.ts";
import { startGitSmartHttpFixture } from "../fixtures/repository-credentials/git.mjs";
import { fixtureRepository } from "../fixtures/repository-credentials/github.mjs";
import {
  cleanEnvironment,
  listen,
  run as runProcess,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";
import { gitCommandBodies } from "../helpers/openshell-online-git-journey.mjs";
import { stockGhPullPreview } from "../helpers/stock-gh-preview.mjs";
import { deferred } from "../helpers/deferred.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { standingExecutionPlatform } from "../helpers/postgres-standing-execution.ts";
import { preparedStandingGitPeer } from "../helpers/prepared-standing-git-peer.ts";
import {
  resolveGitHubRepositoryBinding,
  resolveSelectedRepositoryScope,
} from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
import type { OpenShellProviderProfile } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type { DriverRegistrationRef } from "../../packages/contracts/src/index.ts";

const run: (
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: ReturnType<typeof cleanEnvironment>;
    allowFailure?: boolean;
    signal?: AbortSignal;
  },
) => ReturnType<typeof runProcess> = runProcess;

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

type GrantJourney = Parameters<Parameters<typeof selectedGrantGitJourney>[2]>[0];

function signedGitRedemption(
  authority: GrantJourney["grant"],
  sandboxId: string,
  bindingId: string,
  providerId: string,
) {
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
  return { assertion, grant };
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
        const { providerId } = original.installed.route.observed as { providerId: string };
        const { assertion, grant } = signedGitRedemption(
          authority,
          sandboxId,
          bindingId,
          providerId,
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
          (await grant(discovery.requestId, assertion(sandboxId, providerId, "wrong-key"))).status,
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

// Native Git drives discovery and receive-pack. The controlled sender only forwards a request
// after the production middleware and the signed HTTPS grant listener both authorize it.
const startOrigin: (
  t: Parameters<typeof startGitSmartHttpFixture>[0],
  options: object,
) => ReturnType<typeof startGitSmartHttpFixture> = startGitSmartHttpFixture;

for (const [contents, set] of [
  ["read", false],
  ["write", false],
  ["read", true],
  ["write", true],
] as const) {
  test(
    set
      ? `selected repository set authorizes native Git ${contents}`
      : `selected ${contents} grant bounds ordinary Git push`,
    { ...requiresPostgres, timeout: 90_000 },
    async (t) => {
      await selectedGrantGitJourney(
        t,
        import.meta.url,
        async ({
          runtime,
          revision,
          workspace,
          sandboxId,
          peer,
          grant: authority,
          evaluateRequest,
          finishIssuance,
          removeBinding,
        }) => {
          const bindingId = revision.egressPlan!.execution.executionId;
          const route = await runtime.lookup(
            { sandboxId, bindingId, requestId: randomUUID(), workspace },
            t.signal,
          );
          assert.ok(route?.installed.route);
          const { providerId } = route.installed.route.observed as { providerId: string };
          const { assertion, grant } = signedGitRedemption(
            authority,
            sandboxId,
            bindingId,
            providerId,
          );
          const outside = "fixture/unselected";
          const secondRepository = "fixture/second";
          const origins = new Map([[fixtureRepository, peer.origin]]);
          if (set) {
            for (const repository of [secondRepository, outside]) {
              origins.set(
                repository,
                await startOrigin(t, {
                  repository,
                  tls: peer.origin.tls,
                  authorize: peer.gh.authorize,
                }),
              );
            }
            const installed: OpenShellProviderProfile | undefined = runtime["states"].get(
              revision.id,
            )?.entry?.provider["profile"];
            assert.ok(installed);
            assert.equal(installed.endpoints.length, 1);
            const [endpoint] = installed.endpoints;
            assert.equal(endpoint?.host, "github.com");
            const expectedPaths = [fixtureRepository, secondRepository].flatMap((repository) => [
              `/${repository}.git/info/refs`,
              `/${repository}.git/git-upload-pack`,
              ...(contents === "write" ? [`/${repository}.git/git-receive-pack`] : []),
            ]);
            assert.deepEqual(
              endpoint?.rules?.map(({ allow }) => allow.path),
              [...expectedPaths, `/${fixtureRepository}.git/oce-observe-request/*/info/refs`],
            );
          }
          const calls = () =>
            [...origins.values()].reduce((total, origin) => total + origin.traffic().requests, 0);
          const refusals: string[] = [];
          const errors: unknown[] = [];
          const peerUrl = (
            await listen(
              t,
              createServer((incoming, outgoing) => {
                void (async () => {
                  assert.equal(
                    incoming.headers.authorization,
                    undefined,
                    "Git never receives the provider token",
                  );
                  const target = new URL(incoming.url!, "https://github.com");
                  const body = await buffer(incoming);
                  const request = peer.input(bindingId, sandboxId, false, workspace);
                  const hidden = new Set([
                    "authorization",
                    "connection",
                    "host",
                    "content-length",
                    "transfer-encoding",
                  ]);
                  const headers = Object.entries(incoming.headers).flatMap(([name, value]) =>
                    hidden.has(name) || value === undefined
                      ? []
                      : (Array.isArray(value) ? value : [value]).map((entry) => ({
                          name,
                          value: entry,
                        })),
                  );
                  const verdict = await evaluateRequest({
                    ...request,
                    target: {
                      ...request.target,
                      method: incoming.method,
                      path: target.pathname,
                      query: target.search.slice(1),
                    },
                    body,
                    headers,
                  });
                  const { status, value } = await grant(request.context.request_id, assertion());
                  if (verdict.decision !== 1) {
                    assert.equal(status, 403, "a denied request cannot redeem");
                    assert.equal(value, undefined);
                    refusals.push(target.pathname);
                    outgoing.writeHead(403).end();
                    return;
                  }
                  assert.equal(status, 200);
                  assert.ok(value);
                  const origin = [...origins].find(([repository]) =>
                    target.pathname.startsWith(`/${repository}.git/`),
                  )?.[1];
                  assert.ok(origin, "a permitted request must match a selected origin");
                  await new Promise<void>((resolve, reject) => {
                    const upstream = peer.installationTransport.httpsRequest(
                      origin.origin,
                      {
                        path: target.pathname + target.search,
                        method: incoming.method,
                        ca: origin.tls.ca,
                        headers: {
                          ...Object.fromEntries(
                            headers.map(({ name, value: entry }) => [name, entry]),
                          ),
                          authorization:
                            "Basic " + Buffer.from("x-access-token:" + value).toString("base64"),
                          "content-length": body.length,
                        },
                      },
                      (response) => {
                        outgoing.writeHead(response.statusCode!, response.headers);
                        response.pipe(outgoing);
                        response.once("end", resolve);
                        response.once("error", reject);
                      },
                    );
                    upstream.once("error", reject);
                    upstream.end(body);
                  });
                })().catch((error: unknown) => {
                  errors.push(error);
                  outgoing.destroy();
                });
              }),
            )
          ).replace("https:", "http:");
          const cwd = await temporaryDirectory(t, "selected-grant-native-push-");
          const env = cleanEnvironment({ HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null" });
          const git = (args: string[], allowFailure = false) =>
            run(
              "git",
              [
                "-c",
                `url.${peerUrl}/.insteadOf=https://github.com/`,
                "-c",
                "credential.helper=",
                "-c",
                "http.followRedirects=false",
                ...args,
              ],
              { cwd, env, allowFailure, signal: t.signal },
            );
          await git(["init", "--initial-branch=main"]);
          await git(["config", "user.name", "Repository fixture"]);
          await git(["config", "user.email", "fixture@example.test"]);
          const commit = async (value: string) => {
            await writeFile(join(cwd, "result.txt"), value);
            await git(["add", "result.txt"]);
            await git(["commit", "-m", value]);
            return (await git(["rev-parse", "HEAD"])).stdout.trim();
          };
          const first = await commit("first");
          const ref = "refs/heads/selected-grant-push";
          const push = (repository: string, allowFailure = false) =>
            git(["push", `https://github.com/${repository}.git`, `HEAD:${ref}`], allowFailure);
          finishIssuance();
          const before = calls();
          const read = (repository: string, allowFailure = false) =>
            git(
              ["ls-remote", `https://github.com/${repository}.git`, "refs/heads/main"],
              allowFailure,
            );
          assert.equal(peer.gh.issuesOfTokens.length, 0, "the installed route starts cold");
          if (set) {
            assert.notEqual((await read(outside, true)).code, 0);
            assert.equal(refusals.pop(), `/${outside}.git/info/refs`);
            assert.equal(calls(), before);
            assert.equal(peer.gh.issuesOfTokens.length, 0);
          }
          if (contents === "read") {
            assert.notEqual((await push(fixtureRepository, true)).code, 0);
            assert.deepEqual(refusals, [`/${fixtureRepository}.git/info/refs`]);
            assert.equal(calls(), before);
            assert.equal(peer.gh.issuesOfTokens.length, 0);
            if (set) {
              assert.notEqual((await push(secondRepository, true)).code, 0);
              assert.equal(calls(), before);
              assert.equal(peer.gh.issuesOfTokens.length, 0);
              for (const repository of [fixtureRepository, secondRepository]) {
                const sha = await origins.get(repository)!.ref("main");
                assert.equal((await read(repository)).stdout.trim(), `${sha}	refs/heads/main`);
              }
              assert.equal(peer.gh.issuesOfTokens.length, 1);
              assert.deepEqual(peer.gh.issuesOfTokens[0].repositoryIds, [73, 74]);
              assert.deepEqual(peer.gh.issuesOfTokens[0].permissions, {
                contents: "read",
                metadata: "read",
              });
            }
          } else {
            assert.notEqual((await push(outside, true)).code, 0);
            assert.deepEqual(refusals, [`/${outside}.git/info/refs`]);
            assert.equal(calls(), before);
            assert.equal(peer.gh.issuesOfTokens.length, 0);
            await push(fixtureRepository);
            assert.equal(
              await peer.origin.ref(ref),
              first,
              "read back the actual ref at the provider",
            );
            assert.equal(peer.gh.issuesOfTokens.length, 1);
            assert.deepEqual(peer.gh.issuesOfTokens[0].repositoryIds, set ? [73, 74] : [73]);
            assert.deepEqual(peer.gh.issuesOfTokens[0].permissions, {
              metadata: "read",
              contents: "write",
            });
            assert.ok(
              peer.origin.trace.some(
                ({ path, method }) =>
                  method === "POST" && path === `/${fixtureRepository}.git/git-receive-pack`,
              ),
            );
            const second = await commit("second");
            await push(fixtureRepository);
            assert.equal(await peer.origin.ref(ref), second);
            assert.equal(peer.gh.issuesOfTokens.length, 1, "a second push reuses the issued token");
            let pendingRequestId: string | undefined;
            if (set) {
              await push(secondRepository);
              assert.equal(await origins.get(secondRepository)!.ref(ref), second);
              const afterSelected = calls();
              assert.notEqual((await push(outside, true)).code, 0);
              assert.equal(calls(), afterSelected);
              assert.equal(peer.gh.issuesOfTokens.length, 1);
              const pending = peer.input(bindingId, sandboxId, false, workspace);
              pending.target.path = `/${secondRepository}.git/info/refs`;
              assert.equal((await evaluateRequest(pending)).decision, 1);
              pendingRequestId = pending.context.request_id;
            }
            await commit("after withdrawal");
            await removeBinding(set ? "A" : undefined);
            const afterWrite = calls();
            if (pendingRequestId) {
              assert.equal((await grant(pendingRequestId, assertion())).status, 403);
              assert.notEqual((await push(secondRepository, true)).code, 0);
              assert.equal(await origins.get(secondRepository)!.ref(ref), second);
            }
            assert.notEqual((await push(fixtureRepository, true)).code, 0);
            assert.equal(refusals.at(-1), `/${fixtureRepository}.git/info/refs`);
            assert.equal(
              await peer.origin.ref(ref),
              second,
              "withdrawal leaves the last authorized push unchanged",
            );
            assert.equal(calls(), afterWrite);
            assert.equal(peer.gh.issuesOfTokens.length, 1);
          }
          if (set) {
            assert.equal(origins.get(outside)!.traffic().requests, 0);
            const mixedRegistry = {
              ...peer.registry,
              repositories: peer.registry.repositories.map((repository) =>
                repository.repositoryRef === "B"
                  ? {
                      ...repository,
                      namespaces: repository.namespaces.map((policy) => ({
                        ...policy,
                        permissions: {
                          metadata: "read",
                          contents: contents === "read" ? "write" : "read",
                        },
                      })),
                    }
                  : repository,
              ),
            };
            const members = ["A", "B"].map((repositoryRef) =>
              resolveGitHubRepositoryBinding(mixedRegistry, {
                namespaceId: revision.namespaceId,
                repositoryRef,
              }),
            );
            assert.throws(
              () => resolveSelectedRepositoryScope(mixedRegistry, revision.namespaceId, members),
              { message: "selected-repository-permissions-differ" },
            );
          }
          assert.deepEqual(errors, []);
        },
        { contents, ...(set && { set: true }) },
      );
    },
  );
}

test(
  "stock gh creates a draft and edits its title through the scoped API grant",
  {
    ...requiresPostgres,
    skip:
      requiresPostgres.skip ||
      (!process.env.OCC_TEST_STOCK_GH && "Set OCC_TEST_STOCK_GH to the pinned runtime gh binary."),
    timeout: 90_000,
  },
  async (t) => {
    await selectedGrantGitJourney(
      t,
      import.meta.url,
      async (journey) => {
        const {
          runtime,
          revision,
          workspace,
          sandboxId,
          peer,
          grant: authority,
          evaluateRequest,
          finishIssuance,
          removeBinding,
        } = journey;
        const bindingId = revision.egressPlan!.execution.executionId;
        const installed = await runtime.lookup(
          { sandboxId, bindingId, requestId: randomUUID(), workspace },
          t.signal,
        );
        const observed = installed?.installed.route?.observed as
          | {
              providerId: string;
              pullApi: { providerId: string };
            }
          | undefined;
        assert.ok(observed);
        assert.notEqual(observed.providerId, observed.pullApi.providerId);
        const native = signedGitRedemption(authority, sandboxId, bindingId, observed.providerId);
        const api = signedGitRedemption(
          authority,
          sandboxId,
          bindingId,
          observed.pullApi.providerId,
        );
        const input = () => peer.input(bindingId, sandboxId, false, workspace);
        const evaluateApi = async (body: Buffer, headers: { name: string; value: string }[]) => {
          const request = input();
          const verdict = await evaluateRequest({
            ...request,
            target: {
              scheme: "https",
              host: "api.github.com",
              port: 443,
              method: "POST",
              path: "/graphql",
              query: "",
            },
            body,
            headers,
          });
          return { verdict, requestId: request.context.request_id };
        };
        assert.deepEqual(peer.gh.issuesOfTokens, []);
        finishIssuance();
        const git = input();
        assert.equal((await evaluateRequest(git)).decision, 1);
        const gitToken = await native.grant(git.context.request_id, native.assertion());
        assert.equal(gitToken.status, 200);
        assert.ok(gitToken.value);
        const capture = JSON.parse(
          await readFile(
            new URL("../fixtures/gh-pr-create-edit-2.103.2.json", import.meta.url),
            "utf8",
          ),
        );
        const discovery = capture[0].body;
        const createRequest = capture[2].body;
        const headers = [{ name: "content-type", value: "application/json" }];
        const [owner, name] = fixtureRepository.split("/");
        const coldWrite = await evaluateApi(
          Buffer.from(
            JSON.stringify({
              ...createRequest,
              variables: { input: { ...createRequest.variables.input, repositoryId: "R_fixture" } },
            }),
          ),
          headers,
        );
        assert.equal(
          coldWrite.verdict.decision,
          2,
          "a cold write requires prior approved discovery",
        );
        assert.equal(
          peer.gh.trace.some((row) => row.operation === "pullWriteTarget"),
          false,
        );
        assert.equal(peer.gh.issuesOfTokens.length, 1);
        let apiToken: string | undefined;
        let warm = false;
        const cli = await stockGhPullPreview(t, {
          executable: process.env.OCC_TEST_STOCK_GH!,
          provider: peer.gh,
          authorize: async (body: Buffer, headers: { name: string; value: string }[]) => {
            const { verdict, requestId } = await evaluateApi(body, headers);
            if (verdict.decision !== 1) {
              return { decision: verdict.decision, value: undefined };
            }
            if (!apiToken) {
              assert.equal((await native.grant(requestId, native.assertion())).status, 403);
            }
            if (!warm) {
              const response = await api.grant(requestId, api.assertion());
              assert.equal(response.status, 200);
              assert.ok(response.value);
              apiToken = response.value;
            }
            assert.ok(apiToken);
            return { decision: 1, value: apiToken };
          },
        });
        const command = [
          "pr",
          "create",
          "--repo",
          fixtureRepository,
          "--head",
          "fixture/branch",
          "--base",
          "main",
          "--draft",
          "--title",
          "Original title",
          "--body",
          "Draft body",
        ];
        const create = await cli.invoke(command);
        assert.equal(create.stdout.trim(), "https://github.com/" + fixtureRepository + "/pull/1");
        assert.equal(peer.gh.pulls.get(1).draft, true);
        assert.ok(apiToken);
        assert.notEqual(apiToken, gitToken.value);
        assert.deepEqual(
          peer.gh.issuesOfTokens.map(({ permissions, repositoryIds }) => ({
            permissions,
            repositoryIds,
          })),
          [
            { permissions: { metadata: "read", contents: "write" }, repositoryIds: [73] },
            { permissions: { metadata: "read", pull_requests: "write" }, repositoryIds: [73] },
          ],
        );
        warm = true;
        const other = peer.gh.seedPull("Other original title", "another-contributor");
        await cli.invoke([
          "pr",
          "edit",
          "1",
          "--repo",
          fixtureRepository,
          "--title",
          "Updated original title",
        ]);
        await cli.invoke([
          "pr",
          "edit",
          String(other.number),
          "--repo",
          fixtureRepository,
          "--title",
          "Updated collaborator title",
        ]);
        assert.equal(peer.gh.pulls.get(1).title, "Updated original title");
        assert.equal(peer.gh.pulls.get(other.number).title, "Updated collaborator title");
        const count = (operation: string) =>
          peer.gh.trace.filter((row) => row.operation === operation).length;
        assert.equal(count("createPullRequest"), 1);
        assert.equal(count("updatePullRequest"), 2);
        assert.equal(count("pullWriteTarget"), 3);
        const edit = cli.requests.find(({ body }) =>
          body.query.includes("mutation PullRequestUpdate"),
        );
        assert.ok(edit);
        const foreign = {
          ...edit.body,
          variables: { input: { pullRequestId: "PR_OTHER_REPOSITORY", title: "Foreign" } },
        };
        const denied = await evaluateApi(Buffer.from(JSON.stringify(foreign)), headers);
        assert.equal(denied.verdict.decision, 2);
        assert.equal(count("pullWriteTarget"), 4, "one internal resource read");
        assert.equal(count("updatePullRequest"), 2, "foreign node reached no forwarded mutation");

        const beforeWithdrawal = await evaluateApi(
          Buffer.from(JSON.stringify({ ...discovery, variables: { owner, name } })),
          headers,
        );
        assert.equal(beforeWithdrawal.verdict.decision, 1);
        const entered = deferred();
        const proceed = deferred();
        peer.gh.holdPullWriteTarget(async () => {
          entered.resolve();
          await proceed.promise;
        });
        const pendingWrite = evaluateApi(Buffer.from(JSON.stringify(edit.body)), headers);
        await entered.promise;
        try {
          await removeBinding();
        } finally {
          proceed.resolve();
          peer.gh.holdPullWriteTarget(undefined);
        }
        assert.equal(
          (await pendingWrite).verdict.decision,
          2,
          "withdrawal during the trusted read must deny at the final live check",
        );
        const after = await cli.invoke(
          ["pr", "edit", "1", "--repo", fixtureRepository, "--title", "Refused"],
          true,
        );
        assert.notEqual(after.code, 0);
        assert.equal((await evaluateRequest(input())).decision, 2);
        assert.equal(
          (await api.grant(beforeWithdrawal.requestId, api.assertion())).status,
          403,
          "redemption of the earlier API approval must also recheck withdrawal",
        );
        assert.equal(count("updatePullRequest"), 2);
        assert.equal(count("pullWriteTarget"), 5);
        assert.equal(peer.gh.pulls.get(1).title, "Updated original title");
        const custody = async () =>
          (
            await journey.pool.query(
              `SELECT (a.source_id LIKE '%:pull-api') AS api, a.custody, a.sealed IS NULL AS erased
           FROM occ.prepared_github_attempts a
           JOIN occ.prepared_github_families f USING (source_id)
           WHERE f.source #>> '{session,revisionId}'=$1 ORDER BY api`,
              [revision.id],
            )
          ).rows;
        await peer.prepared.maintain();
        await peer.prepared.maintain();
        assert.deepEqual(await custody(), [
          { api: false, custody: "revoked", erased: true },
          { api: true, custody: "revoked", erased: true },
        ]);
        assert.equal(peer.gh.issuesOfTokens.length, 2);
      },
      { contents: "write", pullPreview: true },
    );
  },
);

test(
  "an uncertain API mint stays quarantined across issuer rotation and does not take Git custody",
  {
    ...requiresPostgres,
    skip:
      requiresPostgres.skip ||
      (!process.env.OCC_TEST_STOCK_GH && "Run with the stock CLI preview lane."),
    timeout: 90_000,
  },
  async (t) => {
    await selectedGrantGitJourney(
      t,
      import.meta.url,
      async ({
        runtime,
        revision,
        workspace,
        sandboxId,
        peer,
        grant: authority,
        evaluateRequest,
        finishIssuance,
        pool,
      }) => {
        const bindingId = revision.egressPlan!.execution.executionId;
        const route = await runtime.lookup(
          { sandboxId, bindingId, requestId: randomUUID(), workspace },
          t.signal,
        );
        const observed = route?.installed.route?.observed as {
          providerId: string;
          pullApi: { providerId: string };
        };
        assert.ok(observed?.pullApi.providerId);
        const native = signedGitRedemption(authority, sandboxId, bindingId, observed.providerId);
        const api = signedGitRedemption(
          authority,
          sandboxId,
          bindingId,
          observed.pullApi.providerId,
        );
        const input = () => peer.input(bindingId, sandboxId, false, workspace);
        const fixture = JSON.parse(
          await readFile(
            new URL("../fixtures/gh-pr-create-edit-2.103.2.json", import.meta.url),
            "utf8",
          ),
        );
        const discovery = fixture[0].body;
        const [owner, name] = fixtureRepository.split("/");
        const approveApi = async () => {
          const request = input();
          assert.equal(
            (
              await evaluateRequest({
                ...request,
                target: {
                  scheme: "https",
                  host: "api.github.com",
                  port: 443,
                  method: "POST",
                  path: "/graphql",
                },
                headers: [{ name: "content-type", value: "application/json" }],
                body: Buffer.from(JSON.stringify({ ...discovery, variables: { owner, name } })),
              })
            ).decision,
            1,
          );
          return request.context.request_id;
        };
        finishIssuance();
        const git = input();
        assert.equal((await evaluateRequest(git)).decision, 1);
        assert.equal((await native.grant(git.context.request_id, native.assertion())).status, 200);

        const issuerRequest = peer.gh.trace.find(({ target }) => target.endsWith("/access_tokens"));
        assert.ok(issuerRequest);
        peer.gh.disconnectAfterMutation("POST", issuerRequest.target);
        assert.equal((await api.grant(await approveApi(), api.assertion())).status, 403);
        assert.equal(
          peer.gh.issuesOfTokens.length,
          2,
          "GitHub minted before the response was lost",
        );

        const read = async () =>
          (
            await pool.query(
              `SELECT (f.source_id LIKE '%:pull-api') AS api, a.state, a.custody,
          (f.admission->>'ownerEpoch')::integer AS epoch
         FROM occ.prepared_github_attempts a JOIN occ.prepared_github_families f USING (source_id)
         WHERE f.source #>> '{session,revisionId}'=$1 ORDER BY api`,
              [revision.id],
            )
          ).rows;
        const before = await read();
        assert.deepEqual(
          before.map(({ api, state, epoch }) => ({ api, state, epoch })),
          [
            { api: false, state: "committed", epoch: 1 },
            { api: true, state: "quarantined", epoch: 1 },
          ],
        );
        const warmGit = input();
        assert.equal((await evaluateRequest(warmGit)).decision, 1);
        assert.equal(
          (await native.grant(warmGit.context.request_id, native.assertion())).status,
          200,
        );

        await peer.rotateAppKey();
        await peer.prepared.maintain();
        const after = await read();
        assert.deepEqual(
          after.map(({ api, state, epoch }) => ({ api, state, epoch })),
          [
            { api: false, state: "committed", epoch: 2 },
            { api: true, state: "quarantined", epoch: 2 },
          ],
        );
        assert.notEqual(after[0].custody, "current");
        assert.equal((await api.grant(await approveApi(), api.assertion())).status, 403);
        assert.equal(peer.gh.issuesOfTokens.length, 2, "unknown API issuance does not retry");
      },
      { contents: "write", pullPreview: true },
    );
  },
);
