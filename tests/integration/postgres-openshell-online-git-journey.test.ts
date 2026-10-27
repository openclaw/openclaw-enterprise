import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fixture, startProtectedOwner } from "../fixtures/prepared-repository-git.mjs";
import { preparedProtectedGit } from "../helpers/prepared-protected-git.ts";
import { setTimeout as delay } from "node:timers/promises";
import type {
  OpenShellOnlineGitBinding,
  OpenShellOnlineGitAuthorityOptions,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-online-git-authority.ts";
import { fixtureRepository } from "../fixtures/repository-credentials/github.mjs";
import { gitCommandBodies } from "../helpers/openshell-online-git-journey.mjs";
import { openShellOnlineGitWire } from "../helpers/openshell-online-git-wire.mjs";
import { invoke, token } from "../helpers/openshell-online-wire.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

test(
  "protected signed TLS Git authorization binds committed receipts, late replies and withdrawal",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const f = await preparedProtectedGit(t, { draftPull: true, dnsIssuer: true });
    // Inspect the entire Agent history, including disposed admissions and receipts.
    // A native session that was opened and then hidden by cleanup must fail this check.
    const assertProtectedHistory = async () => {
      const history = await f.pool.query(
        `SELECT a.admission_id, a.broker_protocol, r.state AS receipt_state
         FROM occ.repository_session_attempts a
         LEFT JOIN occ.repository_broker_receipts r USING (admission_id)
         WHERE a.namespace_id=$1 AND a.agent_id=$2`,
        [f.revision.namespaceId, f.agent.id],
      );
      assert.deepEqual(history.rows, [
        {
          admission_id: f.version.admissionId,
          broker_protocol: 2,
          receipt_state: null,
        },
      ]);
    };
    const sockets = async (directories: Iterable<string>) => {
      const found: string[] = [];
      for (const directory of directories) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isSocket()) {
            found.push(join(directory, entry.name));
          }
        }
      }
      return found.sort();
    };
    const assertNoNativeSockets = async () => {
      assert.deepEqual(
        await sockets(f.ownerDirectories),
        [],
        "protected owners must not open native sockets in any owned directory",
      );
    };
    await assertProtectedHistory();
    await assertNoNativeSockets();
    // A separate native Agent proves the filesystem check sees its live use socket.
    const native = await fixture(t);
    assert.deepEqual(await sockets(native.ownerDirectories), [native.useSocketPath]);
    const held = f.material;
    assert.equal(held.sessionId, f.version.sessionId);
    for (const key of ["providerInstanceId", "repositoryId", "grantId"] as const) {
      assert.equal(held[key], f.binding.grant[key]);
    }
    assert.equal(held.repository, fixtureRepository);
    assert.equal(held.pushRef, f.request().pushRef);
    assert.equal(held.pullRequestBase, "main");
    assert.equal(held.apiOrigin, f.gh.origin.replace("127.0.0.1", "localhost"));
    assert.ok(
      Date.parse(held.expiresAt) > Date.now() && Date.parse(held.expiresAt) <= f.deadlineWallMs,
    );
    assert.equal(await f.providerStatus(held.value), 200);
    const installed = f.installed;
    const beforeRead = f.gh.trace.length;
    assert.deepEqual(await f.authority.readMaterial(f.version.route, t.signal), held);
    await assert.rejects(f.authority.readMaterial(f.version.route, AbortSignal.abort()), {
      name: "AbortError",
    });
    assert.deepEqual(
      await f.authority.readMaterial(
        { ...f.version.route, revisionId: "rev_" + randomUUID() },
        t.signal,
      ),
      { absent: "withdrawn" },
    );
    assert.equal(f.gh.trace.length, beforeRead, "fenced reads neither issue nor retire");
    const sandboxId = f.version.observed.sandboxId;
    const bindingId = f.version.executionId;
    const workspace = f.version.observed.workspace;
    const pushRef = f.request().pushRef;
    const bodies = await gitCommandBodies(t, pushRef);
    // Bind the signed identity to the controlled released recipient. This does not
    // prove stock sender enforcement or mandatory routing.
    let mapping: OpenShellOnlineGitBinding = {
      sandboxId,
      bindingId,
      workspace,
      executionId: f.version.revisionId,
      sessionId: f.version.sessionId,
      ...f.binding.grant,
      repository: fixtureRepository,
      pushRef,
      pullRequestBase: "main",
      apiOrigin: f.gh.origin.replace("127.0.0.1", "localhost"),
      installed,
    };
    const registrationName = "fixture-online-git";
    let late = false;
    let lateRpcLive = false;
    let lateRequest: Parameters<typeof f.authority.authorize>[0] | undefined;
    const options: Pick<
      OpenShellOnlineGitAuthorityOptions,
      "lookupBinding" | "authorizeOnlineRequest"
    > = {
      lookupBinding: async (identity) =>
        identity.sandboxId === sandboxId &&
        identity.bindingId === bindingId &&
        identity.workspace === workspace
          ? mapping
          : undefined,
      authorizeOnlineRequest: async (request, expected, signal) => {
        assert.ok(!("scope" in request));
        assert.ok(expected.route);
        const result = await f.authority.authorize(
          request,
          { ...expected, route: expected.route },
          signal,
        );
        if (late) {
          lateRequest = request;
          assert.equal(result.kind, "allow", "the database must commit before delaying its reply");
          if (result.kind === "allow") {
            await delay(Math.max(0, Date.parse(result.replyBy) - Date.now() + 10));
            lateRpcLive = !signal.aborted;
          }
        }
        return result;
      },
    };
    const { client, keys } = await openShellOnlineGitWire(t, {
      ...options,
      budgetMs: 4000,
      registrationName,
    });
    const receipts = async () =>
      (
        await f.pool.query(
          `SELECT exchange_id, admission_id, attempt_id, material_version,
                  operation, request_digest_sha256
           FROM occ.prepared_repository_git_uses WHERE admission_id=$1 ORDER BY exchange_id`,
          [f.version.admissionId],
        )
      ).rows;
    assert.equal((await receipts()).length, 0, "fenced installation records no request use");
    const evaluate = async (
      input: object,
      operation: string | undefined,
      signedSandbox = sandboxId,
      reason = "online_authorization_denied",
    ) => {
      const before = await receipts();
      const result = await invoke(
        client,
        "EvaluateHttpRequest",
        {
          phase: 1,
          middleware_name: registrationName,
          context: {
            request_id: randomUUID(),
            sandbox_id: signedSandbox,
            workspace,
          },
          config: { fields: { binding_id: { stringValue: bindingId } } },
          ...input,
        },
        token(keys, "supervisor", signedSandbox),
      );
      assert.deepEqual(result, operation ? { decision: 1 } : { decision: 2, reason_code: reason });
      const after = await receipts();
      if (operation === "create-draft-pull") {
        const { rows } = await f.pool.query(
          "SELECT outcome FROM occ.prepared_repository_draft_pulls WHERE grant_id=$1",
          [mapping.grantId],
        );
        assert.deepEqual(rows, [{ outcome: "outcome_unknown" }]);
      }
      if (!operation) {
        assert.deepEqual(after, before, "denial must not add a durable possible-use receipt");
        return;
      }
      const added = after.filter(
        (row) => !before.some((prior) => prior.exchange_id === row.exchange_id),
      );
      assert.equal(after.length, before.length + 1);
      assert.equal(added.length, 1);
      const { exchange_id, request_digest_sha256, ...scope } = added[0];
      assert.ok(exchange_id);
      assert.match(request_digest_sha256, /^[0-9a-f]{64}$/);
      assert.deepEqual(scope, {
        admission_id: f.version.admissionId,
        attempt_id: installed.preparationAttemptId,
        material_version: installed.materialVersion,
        operation,
      });
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
    mapping = { ...mapping, installed: { ...installed, materialVersion: randomUUID() } };
    await evaluate(discovery("upload-pack"), undefined, sandboxId, "route_not_ready");
    mapping = { ...mapping, installed };
    await evaluate(discovery("upload-pack"), "advertise-upload-pack");

    // Authorize exactly one draft, but do not send it. An unobserved result is
    // deliberately unresolved; another request, even with a new RPC id, must not receive an allow.
    const draftTarget = new URL("/repos/" + fixtureRepository + "/pulls", mapping.apiOrigin);
    const draft = {
      target: {
        scheme: "https",
        host: draftTarget.hostname,
        port: Number(draftTarget.port),
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
    await evaluate(draft, "create-draft-pull");
    // The refusal names the spent draft (finding 2147).
    await evaluate(draft, undefined, sandboxId, "draft_already_opened");

    // Withdraw the real admission without running retirement. The real TLS App
    // fixture still accepts its issued token before AND after a fresh request with signed identity.
    // Delay a genuine committed allow past its material bound while its authenticated RPC
    // remains live. The final callback must deny without erasing or replaying that use.
    await f.pool.query(
      "UPDATE occ.prepared_github_attempts SET usable_until=clock_timestamp()+interval '700 milliseconds' WHERE id=$1",
      [held.preparationAttemptId],
    );
    late = true;
    const beforeLate = await receipts();
    const lateResult = await invoke(
      client,
      "EvaluateHttpRequest",
      {
        phase: 1,
        middleware_name: registrationName,
        context: { request_id: randomUUID(), sandbox_id: sandboxId, workspace },
        config: { fields: { binding_id: { stringValue: bindingId } } },
        ...discovery("upload-pack"),
      },
      token(keys, "supervisor", sandboxId),
    );
    assert.deepEqual(lateResult, { decision: 2, reason_code: "online_authorization_denied" });
    assert.equal(
      lateRpcLive,
      true,
      "the material deadline elapsed while the authenticated RPC remained live",
    );
    const afterLate = await receipts();
    const committedLate = afterLate.filter(
      (row) => !beforeLate.some((prior) => prior.exchange_id === row.exchange_id),
    );
    assert.equal(committedLate.length, 1);
    assert.equal(committedLate[0].attempt_id, held.preparationAttemptId);
    assert.equal(committedLate[0].material_version, held.materialVersion);
    assert.equal(committedLate[0].operation, "advertise-upload-pack");
    assert.ok(lateRequest);
    assert.equal(committedLate[0].exchange_id, lateRequest.exchangeId);
    assert.equal(committedLate[0].request_digest_sha256, lateRequest.requestDigestSha256);
    assert.equal(committedLate[0].admission_id, f.version.admissionId);
    assert.deepEqual(await f.authority.authorize(lateRequest, installed, t.signal), {
      kind: "denied",
      reason: "unavailable",
    });
    assert.deepEqual(await receipts(), afterLate, "a late committed decision cannot be replayed");
    late = false;
    await f.state.transact((u) =>
      u.repositorySessions.advanceAttempt({
        admissionId: f.version.admissionId,
        expectedPhase: "open",
        phase: "closing",
        updatedAt: new Date().toISOString(),
      }),
    );
    assert.equal(await f.providerStatus(held.value), 200);
    await evaluate(discovery("upload-pack"), undefined, sandboxId, "access_withdrawn");
    assert.equal(await f.providerStatus(held.value), 200);
    assert.equal(f.gh.issuesOfTokens.length, 1);
    assert.deepEqual(f.gh.errors, []);
    await assertProtectedHistory();
    await assertNoNativeSockets();
    t.diagnostic(
      "OCE authority and durable state only; no installed sender or provider dispatch claimed.",
    );
  },
);

for (const loseCommitAcknowledgment of [false, true]) {
  test(
    `protected online draft preserves one unknown receipt${loseCommitAcknowledgment ? " after a lost commit acknowledgment" : ""}`,
    { ...requiresPostgres, timeout: 60_000 },
    async (t) => {
      const f = await preparedProtectedGit(t, { draftPull: true });
      // Only the client's COMMIT acknowledgment is faulted; the real database commits.
      // This is not proof of a physical PostgreSQL connection outage.
      let lose = loseCommitAcknowledgment;
      const pool = {
        async connect() {
          const client = await f.pool.connect();
          return {
            async query(sql: string, values?: unknown[]) {
              const result = await client.query(sql, values);
              if (sql === "COMMIT" && lose) {
                lose = false;
                throw Object.assign(new Error("commit acknowledgment lost"), { code: "08007" });
              }
              return result;
            },
            release: (discard?: boolean) => client.release(discard),
          };
        },
      };
      const owner = await startProtectedOwner(f, { pool });
      const authority = owner.protectedGit!.online;
      const request = f.request({
        operation: "create-draft-pull",
        pull: {
          operationId: randomUUID(),
          apiOrigin: f.gh.origin,
          repository: f.material.repository,
          head: f.material.pushRef.slice("refs/heads/".length),
          base: "main",
        },
      });
      assert.deepEqual(
        await authority.authorize(
          request,
          {
            ...f.installed,
            materialVersion: randomUUID(),
          },
          t.signal,
        ),
        { kind: "denied", reason: "unavailable" },
      );
      // A rejected transaction must not consume the injected acknowledgment failure.
      assert.equal(lose, loseCommitAcknowledgment);
      const result = await authority.authorize(request, f.installed, t.signal);
      assert.equal(result.kind, loseCommitAcknowledgment ? "denied" : "allow");
      const rows = () =>
        f.pool.query(
          "SELECT receipt_id,attempt_id,material_version,outcome,settled_at,projection FROM occ.prepared_repository_draft_pulls WHERE grant_id=$1",
          [request.grantId],
        );
      assert.deepEqual((await rows()).rows, [
        {
          receipt_id: request.exchangeId,
          attempt_id: f.material.preparationAttemptId,
          material_version: f.material.materialVersion,
          outcome: "outcome_unknown",
          settled_at: null,
          projection: null,
        },
      ]);
      for (const retry of [
        request,
        { ...request, exchangeId: randomUUID() },
        {
          ...request,
          exchangeId: randomUUID(),
          pull: { ...request.pull!, operationId: randomUUID() },
        },
      ]) {
        assert.deepEqual(await authority.authorize(retry, f.installed, t.signal), {
          kind: "denied",
          reason: "draft_already_opened",
        });
      }
      assert.equal((await rows()).rowCount, 1);
      const uses = await f.pool.query(
        "SELECT exchange_id FROM occ.prepared_repository_git_uses WHERE admission_id=$1",
        [f.version.admissionId],
      );
      assert.deepEqual(uses.rows, [{ exchange_id: request.exchangeId }]);
    },
  );
}

test(
  "protected online pins material and records every unlimited draft without widening scope",
  requiresPostgres,
  async (t) => {
    const f = await preparedProtectedGit(t, { draftPull: true, draftPullLimit: "none" });
    const draft = () =>
      f.request({
        operation: "create-draft-pull",
        pull: {
          operationId: randomUUID(),
          apiOrigin: f.gh.origin,
          repository: f.material.repository,
          head: f.material.pushRef.slice("refs/heads/".length),
          base: "main",
        },
      });
    const first = draft();
    const second = draft();
    for (const request of [first, second]) {
      const result = await f.authority.authorize(request, f.installed, t.signal);
      assert.equal(result.kind, "allow");
      assert.equal("exchangeId" in result && result.exchangeId, request.exchangeId);
    }
    const unavailable = { kind: "denied", reason: "unavailable" };
    assert.deepEqual(await f.authority.authorize(second, f.installed, t.signal), unavailable);
    for (const changes of [
      { materialVersion: randomUUID() },
      { preparationAttemptId: randomUUID() },
      { route: { ...f.installed.route, fence: f.installed.route.fence + 1 } },
    ]) {
      assert.deepEqual(
        await f.authority.authorize(draft(), { ...f.installed, ...changes }, t.signal),
        unavailable,
      );
    }
    for (const changes of [
      { pushRef: "refs/heads/forbidden" },
      { repositoryId: "other-repository" },
      { providerInstanceId: "other-provider" },
      { grantId: "other-grant" },
      { deadlineAt: new Date(Date.now() - 1).toISOString() },
      { deadlineAt: new Date(Date.now() + 60_000).toISOString() },
    ]) {
      assert.deepEqual(
        await f.authority.authorize(f.request(changes), f.installed, t.signal),
        unavailable,
      );
    }
    const originalDraft = draft();
    const wrongBase = { ...originalDraft, pull: { ...originalDraft.pull!, base: "release" } };
    assert.deepEqual(await f.authority.authorize(wrongBase, f.installed, t.signal), unavailable);
    assert.deepEqual(
      await f.authority.authorize(f.request(), f.installed, AbortSignal.abort()),
      unavailable,
    );
    const { rows } = await f.pool.query(
      "SELECT exchange_id FROM occ.prepared_repository_git_uses WHERE admission_id=$1 ORDER BY exchange_id",
      [f.version.admissionId],
    );
    assert.deepEqual(
      rows.map((row) => row.exchange_id),
      [first.exchangeId, second.exchangeId].sort(),
    );
    assert.equal(
      (
        await f.pool.query("SELECT FROM occ.prepared_repository_draft_pulls WHERE grant_id=$1", [
          first.grantId,
        ])
      ).rowCount,
      0,
    );
  },
);

test(
  "protected online rejects superseded and expired material before provider retirement",
  requiresPostgres,
  async (t) => {
    const f = await preparedProtectedGit(t);
    const { material, installed, authority } = f;
    await f.pool.query(
      "UPDATE occ.prepared_github_attempts SET usable_until=clock_timestamp()+interval '5 minutes' WHERE id=$1",
      [material.preparationAttemptId],
    );
    assert.equal((await authority.authorize(f.request(), installed, t.signal)).kind, "allow");
    await f.pool.query(
      "UPDATE occ.prepared_github_families SET next_check_at=clock_timestamp() WHERE source_id=$1",
      [f.version.familyId],
    );
    await f.owner.maintain();
    const replacement = await authority.readMaterial(f.version.route, t.signal);
    assert.ok(replacement && "value" in replacement);
    assert.notEqual(replacement.preparationAttemptId, material.preparationAttemptId);
    assert.notEqual(replacement.materialVersion, material.materialVersion);
    const unavailable = { kind: "denied", reason: "unavailable" };
    assert.deepEqual(await authority.authorize(f.request(), installed, t.signal), unavailable);
    await f.pool.query(
      "UPDATE occ.credential_deliveries SET preparation_attempt_id=$2,material_version=$3 WHERE revision_id=$1",
      [f.version.revisionId, replacement.preparationAttemptId, replacement.materialVersion],
    );
    const current = {
      route: f.version.route,
      preparationAttemptId: replacement.preparationAttemptId,
      materialVersion: replacement.materialVersion,
    };
    assert.equal((await authority.authorize(f.request(), current, t.signal)).kind, "allow");
    assert.equal(await f.providerStatus(material.value), 200);
    await f.pool.query(
      "UPDATE occ.prepared_github_attempts SET usable_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [replacement.preparationAttemptId],
    );
    assert.deepEqual(await authority.authorize(f.request(), current, t.signal), unavailable);
    assert.deepEqual(await authority.readMaterial(f.version.route, t.signal), {
      absent: "unprepared",
    });
  },
);
