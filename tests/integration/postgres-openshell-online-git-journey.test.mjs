import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fixture, prepare } from "../fixtures/prepared-repository-git.mjs";
import { fixtureRepository } from "../fixtures/repository-credentials/github.mjs";
import { gitCommandBodies } from "../helpers/openshell-online-git-journey.mjs";
import { openShellOnlineGitWire } from "../helpers/openshell-online-git-wire.mjs";
import { invoke, token } from "../helpers/openshell-online-wire.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

test(
  "OCE signed TLS Git authorization composes with PostgreSQL admission and material withdrawal",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const f = await fixture(t, { draftPull: true, dnsIssuer: true });
    assert.equal(
      typeof f.owner.authorizeOpenShellRequest,
      "function",
      "the prepared Git owner must expose its durable OpenShell authorization method",
    );
    await prepare(f);
    // Fixture-owned provider custody only: the existing use operation supplies the
    // issued token once. This does not prove OpenShell delivery or installation.
    const held = await f.owner.use(f.request());
    assert.equal(await f.providerStatus(held.value), 200);
    const installed = {
      preparationAttemptId: held.preparationAttemptId,
      materialVersion: held.materialVersion,
    };
    const sandboxId = `fixture-sandbox-${randomUUID()}`;
    const bindingId = `fixture-binding-${randomUUID()}`;
    const workspace = "fixture-workspace";
    const pushRef = f.request().pushRef;
    const bodies = await gitCommandBodies(t, pushRef);
    // This trusted mapping is fixture-owned, not runtime admission evidence. Stock
    // sender identity, mandatory routing and original wire bytes remain unproved.
    let mapping = {
      sandboxId,
      bindingId,
      workspace,
      executionId: `fixture-execution-${randomUUID()}`,
      sessionId: f.sessionId,
      ...f.binding.grant,
      repository: fixtureRepository,
      pushRef,
      pullRequestBase: "main",
      apiOrigin: f.gh.origin.replace("127.0.0.1", "localhost"),
      installed,
    };
    const registrationName = "fixture-online-git";
    const { client, keys } = await openShellOnlineGitWire(t, {
      budgetMs: 4000,
      registrationName,
      lookupBinding: async (identity) =>
        identity.sandboxId === sandboxId &&
        identity.bindingId === bindingId &&
        identity.workspace === workspace
          ? mapping
          : undefined,
      approve: (request, expected, signal) =>
        f.owner.authorizeOpenShellRequest(request, expected, signal),
    });
    const receipts = async () =>
      (
        await f.pool.query(
          `SELECT exchange_id, admission_id, attempt_id, material_version,
                  operation, request_digest_sha256
           FROM occ.prepared_repository_git_uses WHERE admission_id=$1 ORDER BY exchange_id`,
          [f.admissionId],
        )
      ).rows;
    assert.equal((await receipts()).length, 1, "initial fixture custody already records one use");
    const evaluate = async (
      input,
      operation,
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
        return;
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
        admission_id: f.admissionId,
        attempt_id: installed.preparationAttemptId,
        material_version: installed.materialVersion,
        operation,
      });
    };
    // Targets are inspected protocol data only. There is no downstream dispatcher;
    // an ALLOW and its receipt prove possible use, never successful sending.
    const target = (method, suffix, query = "") => ({
      scheme: "https",
      host: "github.com",
      port: 443,
      method,
      path: `/${fixtureRepository}.git/${suffix}`,
      query,
    });
    const discovery = (service) => ({
      target: target("GET", "info/refs", `service=git-${service}`),
    });
    const command = (service, body) => ({
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
    await f.withdraw();
    assert.equal(await f.providerStatus(held.value), 200);
    await evaluate(discovery("upload-pack"), undefined, sandboxId, "access_withdrawn");
    assert.equal(await f.providerStatus(held.value), 200);
    assert.equal(f.gh.issuesOfTokens.length, 1);
    assert.deepEqual(f.gh.errors, []);
    t.diagnostic(
      "OCE authority and durable state only; no installed sender or provider dispatch claimed.",
    );
  },
);
