import assert from "node:assert/strict";
import { verify } from "node:crypto";
import { createServer } from "node:https";
import test from "node:test";
import { sharedRsaKeyPair } from "../fixtures/repository-credentials/shared-keys.mjs";
import { createGitHubKeyOwner } from "../../apps/controller/src/drivers/repo/github/credentials/material.ts";
import { createGitHubPreparationOwner } from "../../apps/controller/src/drivers/repo/github/credentials/prepared-owner.ts";
import { createGitHubWarmReader } from "../../apps/controller/src/drivers/repo/github/credentials/prepared-reader.ts";
import { retirePreparedGitHubToken } from "../../apps/controller/src/drivers/repo/github/credentials/prepared-retirement.ts";
import { preparationIssuerAuthority } from "../../apps/controller/src/drivers/repo/github/credentials/grants.ts";
import { createGitHubRepositoryGrant } from "../../apps/controller/src/drivers/repo/github/credentials/repository-grant.ts";
import { validateGitHubRepositoryRegistry } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import type {
  GitHubPreparationAdmission,
  GitHubPreparationStore,
} from "../../apps/controller/src/drivers/repo/github/credentials/prepared-contracts.ts";
import { createPreparedStore } from "../fixtures/repository-credentials/github/prepared-store.mjs";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import { createTlsMaterial, listen } from "../fixtures/repository-credentials/process.mjs";

test(
  "private repository grant preserves issue, renewal and retirement scope",
  { timeout: 30_000 },
  async (t) => {
    const expectedPermissions = {
      metadata: "read",
      contents: "write",
      issues: "write",
      actions: "write",
      workflows: "write",
    };
    const repositories = [
      { id: 101, full_name: "fixture/a" },
      { id: 202, full_name: "fixture/b" },
    ];
    // Registry identity is reused, not its legacy profile's permission semantics. Public selection
    // of the new scope is deliberately not wired until the Driver contract submission is verified.
    const registry = validateGitHubRepositoryRegistry({
      version: 1,
      backendId: "github",
      providerInstanceId: "provider",
      appId: "1",
      githubInstallationId: "2",
      maximumDurationSeconds: 3600,
      repositories: repositories.map((repo, index) => ({
        repositoryRef: index ? "B" : "A",
        repositoryId: String(repo.id),
        repository: repo.full_name,
        namespaces: [{ namespaceId: "team", profiles: ["git-read"] }],
      })),
    });
    const selection = { repositoryRef: "A", repositoryId: "101" };
    const identity = { id: "grant", isolationId: "revision" };
    const grant = createGitHubRepositoryGrant(registry, selection, identity, expectedPermissions);
    assert.ok(Object.isFrozen(grant.permissions));
    assert.throws(
      () =>
        createGitHubRepositoryGrant(
          registry,
          { ...selection, repositoryId: "202" },
          identity,
          expectedPermissions,
        ),
      /selection-changed/,
    );
    const keys = sharedRsaKeyPair("repo-collaboration");
    const clock = createControlledClock();
    const tls = await createTlsMaterial(t);
    const issued: { repository_ids: number[]; permissions: Record<string, string> }[] = [];
    let replyMode = "valid";
    const revoked: string[] = [];
    const origin = await listen(
      t,
      createServer(tls, async (req, res) => {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
        }
        if (req.url === "/app/installations/2/access_tokens") {
          assert.equal(req.method, "POST");
          const jwt = req.headers.authorization!.replace(/^Bearer /, "");
          const [header, payload, signature] = jwt.split(".");
          assert.ok(
            verify(
              "sha256",
              Buffer.from(`${header}.${payload}`),
              keys.publicKey,
              Buffer.from(signature!, "base64url"),
            ),
          );
          assert.equal(JSON.parse(Buffer.from(payload!, "base64url").toString()).iss, "1");
          const scope = JSON.parse(body);
          issued.push(scope);
          const selected = scope.repository_ids ?? repositories.map((r) => r.id);
          const token = `synthetic-issued-${issued.length}`;
          res.writeHead(201).end(
            JSON.stringify({
              token,
              expires_at: new Date(clock.wallNow() + 3_600_000).toISOString(),
              permissions:
                replyMode === "organization-permission"
                  ? { ...scope.permissions, members: "read" }
                  : replyMode === "missing-permissions"
                    ? undefined
                    : scope.permissions,
              repository_selection:
                replyMode === "missing-selection"
                  ? undefined
                  : replyMode === "all-selection"
                    ? "all"
                    : "selected",
              repositories:
                replyMode === "widened"
                  ? repositories
                  : replyMode === "wrong-repository"
                    ? [repositories[1]]
                    : replyMode === "missing-repositories"
                      ? undefined
                      : repositories.filter((r) => selected.includes(r.id)),
            }),
          );
          return;
        }
        if (req.method === "DELETE" && req.url === "/installation/token") {
          revoked.push((req.headers.authorization ?? "").replace(/^Bearer /, ""));
          res.writeHead(204).end();
          return;
        }
        res.writeHead(404).end();
      }),
    );
    const admission: GitHubPreparationAdmission = {
      familyId: "repository-collaboration-family",
      generation: 1,
      ownerEpoch: 1,
      inputVersion: "key-1",
      issuerAuthority: preparationIssuerAuthority(origin, tls.ca),
      grant,
    };
    const database = createPreparedStore(admission);
    const store = database.connect() as GitHubPreparationStore;
    const reader = createGitHubWarmReader(store, clock.wallNow);
    const signingKey = createGitHubKeyOwner({ privateKey: keys.privateKey, appId: "1", clock });
    t.after(() => signingKey.close());
    const owner = (selectedStore = store) =>
      createGitHubPreparationOwner({
        admission: JSON.parse(JSON.stringify(admission)),
        store: selectedStore,
        clock,
        apiOrigin: origin,
        ca: tls.ca,
        renewBeforeMs: 120_000,
        minimumValidityMs: 10_000,
        getKey: async () => signingKey,
      });
    const bounds = () => ({ signal: t.signal, deadlineMonoMs: clock.monotonicNow() + 30_000 });
    for (const attempt of ["first", "renewal"]) {
      replyMode = attempt === "renewal" ? "missing-selection" : "valid";
      assert.equal(await owner().run(attempt, bounds()), "committed");
      assert.deepEqual(issued.at(-1), { repository_ids: [101], permissions: expectedPermissions });
      const warm = await reader.readWarm(admission);
      assert.equal(warm.kind, "warm");
      if (warm.kind !== "warm") {
        throw new Error("missing prepared token");
      }
      await store.readCurrent(admission.familyId, (row) => {
        assert.deepEqual(row?.committed?.admission.grant, grant);
      });
      for (const changed of [
        { ...grant, repositoryId: "202" },
        { ...grant, permissions: { ...grant.permissions, issues: "read" } },
        { ...grant, profile: "github-installation" as const },
      ]) {
        assert.equal((await reader.readWarm({ ...admission, grant: changed })).kind, "not_ready");
      }
      warm.material.bytes.fill(0);
      await clock.advance(3_480_000);
    }
    // A provider response that broadens A to A+B must remain in custody, never become usable.
    replyMode = "widened";
    assert.equal(await owner().run("widened-renewal", bounds()), "quarantined");
    await store.readCurrent(admission.familyId, (row) => {
      assert.equal(row?.committed?.attemptId === "widened-renewal", false);
      assert.equal(row?.attempts.at(-1)?.state, "quarantined");
    });
    assert.equal(issued.length, 3);
    const candidate = Buffer.from("synthetic-issued-3");
    const settlements: boolean[] = [];
    const retirement = {
      async takeRetirement() {
        return { id: "widened-renewal", admission, bytes: candidate };
      },
      async finishRetirement(_id: string, ok: boolean) {
        settlements.push(ok);
      },
    };
    assert.equal(
      await retirePreparedGitHubToken(
        retirement,
        admission.familyId,
        t.signal,
        origin,
        tls.ca,
        clock,
      ),
      "retired",
    );
    assert.deepEqual(revoked, ["synthetic-issued-3"]);
    assert.deepEqual(settlements, [true]);
    assert.ok(candidate.every((byte) => byte === 0));
    const mismatch = {
      ...retirement,
      async takeRetirement() {
        return {
          id: "wrong-origin",
          admission: { ...admission, issuerAuthority: "https://wrong.invalid" },
          bytes: Buffer.from("synthetic-issued-2"),
        };
      },
    };
    await assert.rejects(
      retirePreparedGitHubToken(mismatch, admission.familyId, t.signal, origin, tls.ca, clock),
      /issuer-authority-mismatch/,
    );
    assert.equal(revoked.length, 1);
    assert.deepEqual(settlements, [true, false]);
    for (const mode of [
      "organization-permission",
      "missing-permissions",
      "all-selection",
      "wrong-repository",
      "missing-repositories",
    ]) {
      replyMode = mode;
      const isolated = createPreparedStore(admission).connect() as GitHubPreparationStore;
      assert.equal(await owner(isolated).run(mode, bounds()), "quarantined", mode);
      assert.equal(
        (await createGitHubWarmReader(isolated, clock.wallNow).readWarm(admission)).kind,
        "not_ready",
        mode,
      );
    }
    const sent = issued.length;
    for (const permissions of [
      {},
      { metadata: "read", members: "read" },
      { metadata: "read", organization_administration: "write" },
      { metadata: "read", enterprise_administration: "write" },
      { metadata: "read", repository_creation: "write" },
      { metadata: "read", installation: "write" },
      { metadata: "read", contents: "admin" },
    ]) {
      assert.throws(
        () =>
          createGitHubPreparationOwner({
            admission: { ...admission, grant: { ...grant, permissions } },
            store,
            clock,
            apiOrigin: origin,
            ca: tls.ca,
            renewBeforeMs: 120_000,
            minimumValidityMs: 10_000,
            getKey: async () => {
              throw new Error("invalid grant reached signer");
            },
          }),
        /invalid-github-repository-grant/,
      );
    }
    assert.equal(issued.length, sent);
  },
);
