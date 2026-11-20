import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createNarrowOnlineGitStartup,
  narrowOnlineGitJourney,
} from "../helpers/postgres-repository-set-journey.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { openShellProviderName } from "../../apps/controller/src/backends/openshell.ts";
import { harnessEgressEnrollment } from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import type { OpenShellNetworkPolicyRule } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import {
  codexAppServerEnvironment,
  codexManagedRuntimeFiles,
} from "./sandbox-driver-codex-workload-fixture.ts";
import { harnessRuntimeCommand } from "./sandbox-driver-startup-orchestration.ts";
import { fixtureRepository } from "../fixtures/repository-credentials/github.ts";
import { gitCommandBodies } from "../helpers/openshell-online-git-journey.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { standingExecutionPlatform } from "../helpers/postgres-standing-execution.ts";
import { preparedStandingGitPeer } from "../helpers/prepared-standing-git-peer.ts";
import type {
  AgentRevision,
  DriverRegistrationRef,
  SandboxHarnessContext,
} from "../../packages/contracts/src/index.ts";

test(
  "PostgreSQL replays the admitted protected artifact policy in native OpenShell",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const strict = {
      ports: [443],
      protocol: "rest",
      enforcement: "enforce",
      access: "read_only",
    } as const;
    const strictHost = "registry.npmjs.org";
    const optedInHost = "artifacts.example.test";
    const rule = {
      name: "codex-artifacts",
      binaries: [
        {
          path: "/app/node_modules/openclaw/node_modules/.pnpm/@openai+codex@0.164.0-linux-x64/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex",
        },
      ],
      endpoints: [
        { ...strict, host: strictHost },
        { ...strict, host: optedInHost, protectedArtifactAllowEncodedSlash: true },
      ],
    } satisfies OpenShellNetworkPolicyRule;
    const { fixture, revision, registration, replayContext, sandboxWithDefaults, peer, world } =
      await createNarrowOnlineGitStartup(t, import.meta.url, { artifactRules: [rule] });
    // Read the committed row through a fresh OCC state and independently as PostgreSQL JSON.
    const { observerPool } = fixture;
    const { namespaceId, agentId, id } = revision;
    const stored = await new PostgresPlatformState(observerPool).read((view) =>
      view.revisions.findRevision(namespaceId, agentId, id),
    );
    const { rows } = await observerPool.query<{ policy: AgentRevision["sandboxPolicy"] }>(
      "SELECT admitted_spec->'sandbox_policy' AS policy FROM occ.agent_revisions WHERE namespace_id=$1 AND agent_id=$2 AND id=$3",
      [namespaceId, agentId, id],
    );
    assert.ok(stored?.sandboxPolicy && stored.egressPlan);
    assert.deepEqual(stored.sandboxPolicy, revision.sandboxPolicy);
    assert.deepEqual(
      rows.map(({ policy }) => policy),
      [stored.sandboxPolicy],
    );

    // Change current Installation scope to opt in the strict endpoint and remove the old opt-in.
    const sandbox = sandboxWithDefaults([
      {
        ...rule,
        endpoints: [
          { ...strict, host: strictHost, protectedArtifactAllowEncodedSlash: true },
          { ...strict, host: optedInHost },
        ],
      },
    ]);
    const current = sandbox.admitProtectedCodexArtifactPolicy(
      stored.sandboxPolicy.version,
    ).snapshot;
    assert.notDeepEqual(current.defaults, stored.sandboxPolicy.defaults);
    const { proxyWiring, namespace, signal } = await replayContext(stored);
    const auth = stored.harnessAuth;
    assert.equal(auth.method, "credential_source");
    const context: SandboxHarnessContext = {
      namespace,
      signal,
      kubernetes: {},
      revision: stored,
      requirements: {
        loginMode: auth.loginMode,
        image: "codex-runtime@sha256:synthetic",
        command: harnessRuntimeCommand('console.error("fixture")'),
        retainedDirectories: [],
        workspaceMounts: [
          {
            claimName: "replay-workspace",
            subPath: "workspace",
            mountPath: "/home/node/workspace",
            readOnly: false,
          },
        ],
        credentialAttachments: [
          { sourceId: auth.sourceId, ref: openShellProviderName(auth.sourceId) },
        ],
        environment: codexAppServerEnvironment(),
        files: codexManagedRuntimeFiles(
          JSON.stringify({
            kind: "codex",
            selections: {},
            providerTools: "none",
            egressEnrollment: harnessEgressEnrollment(stored.egressPlan),
          }),
        ),
        labels: { "openclaw.dev/revision": id },
        proxyWiring,
      },
    };
    assert.equal(registration.creates(), 0);
    const first = await sandbox.provisionHarness(context);
    const compiled = first.proxyWiring?.configuration.network_policies;
    const expectedEndpoints = [strictHost, optedInHost].map((host) => ({
      host,
      ports: [443],
      protocol: "rest",
      enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
      access: "NETWORK_ACCESS_PRESET_READ_ONLY",
      ...(host === optedInHost && { allow_encoded_slash: true }),
    }));
    assert.deepEqual(compiled, {
      [rule.name]: { name: rule.name, binaries: rule.binaries, endpoints: expectedEndpoints },
    });
    assert.deepEqual(compiled, stored.sandboxPolicy.defaults);
    assert.ok(Object.isFrozen(first.proxyWiring?.configuration));
    assert.deepEqual(registration.createPolicy()?.network_policies, compiled);
    const replayed = await sandbox.provisionHarness(context);
    assert.deepEqual(replayed, first);
    assert.equal(registration.creates(), 1, "same revision adopts its registered Sandbox");

    // An unchanged revision identity cannot authorize a registered Sandbox that lost the bit.
    registration.clearEncodedSlash();
    await assert.rejects(sandbox.provisionHarness(context), {
      diagnosticCode: "OPENSHELL_SANDBOX_OWNERSHIP_MISMATCH",
    });
    assert.equal(registration.creates(), 1, "policy drift cannot register a replacement");
    assert.equal(world.writes, 0);
    assert.equal(peer.gh.issuesOfTokens.length, 0);
    assert.equal(peer.originCalls(), 0);
    t.diagnostic(
      JSON.stringify({
        persisted: rows[0]?.policy?.defaults,
        reconfigured: current.defaults,
        compiled,
        registered: registration.createPolicy()?.network_policies,
        registrations: registration.creates(),
        gitCredentialUpdates: world.writes,
        tokenIssuances: peer.gh.issuesOfTokens.length,
        originCalls: peer.originCalls(),
        driftDiagnostic: "OPENSHELL_SANDBOX_OWNERSHIP_MISMATCH",
      }),
    );
  },
);

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
        recover,
      }) => {
        // The production route and custody joins must preserve an ongoing execution across
        // fresh supervisor evidence. The stop/removal checks below still withdraw that authority.
        await recover();
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
