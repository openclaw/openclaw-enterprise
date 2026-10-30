import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type {
  ComputeDriver,
  ConfigurationDriver,
  SecretDriver,
  RepositoryApprovalScope,
} from "../../packages/contracts/src/index.ts";
import { createPostgresControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import { validateGitHubRepositoryRegistry } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  repositoryApprovalFingerprint,
  OpenClawController,
  PostgresPlatformState,
} from "../../packages/occ/src/index.ts";
import { grantAgentSecretOperate } from "../helpers/postgres-harness-auth.mjs";
import { databaseUrl, requiresPostgres, testPool } from "../helpers/postgres-database.mjs";
import { ensurePostgresAgentBootstrap } from "../helpers/postgres-agent-app.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { createReadyComputeDriver } from "../helpers/development.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { cookieHeaderFromSetCookie, signInToControllerApp } from "../helpers/auth-session.mjs";
import { injectJson } from "../helpers/inject-json.mjs";
import { waitForLockWaiter } from "../helpers/postgres-lock-waits.mjs";
import {
  STANDING_APPROVAL_BINDING_LOCKED,
  STANDING_APPROVAL_NOT_PERMITTED,
  STANDING_APPROVAL_ONE_BINDING,
  STANDING_APPROVAL_POLICY_CHANGED,
  STANDING_APPROVAL_SCOPE_CHANGED,
} from "../helpers/refusal-text.mjs";

const authSecret = "standing-approval-source-test-auth-secret-32";
// Proves registered HTTP/IAM/State behavior. No Compute operation or provider call is executed.
test(
  "registered standing approval persists exact scope and fences removed generations",
  requiresPostgres,
  async (t) => {
    await ensurePostgresAgentBootstrap(t, { label: "standing-approval", authSecret });
    const pool = testPool(t, { connectionString: databaseUrl, max: 6 });
    const state = new PostgresPlatformState(pool);
    const installation = await state.loadInstallation();
    assert.ok(installation);
    const auth = await createPostgresControllerAuth({
      mode: "development",
      installationId: installation.id,
      baseURL: "http://127.0.0.1",
      secret: authSecret,
      pool,
    });
    const iam = new NativeIAMDriver(state, { id: "standing-iam" });
    const configuration = createTestConfigurationDriver({ id: "standing-config" });
    const secrets = createTestSecretDriver({ id: "standing-secret" });
    const compute = createReadyComputeDriver("standing-compute", {
      validateRepositoryCredentials() {},
      validateHarnessAuth() {},
    });
    const namespaceId = `ns_${randomUUID()}`;
    const backendId = "standing-repo";
    const registry = {
      version: 1,
      backendId,
      providerInstanceId: "github-source-test",
      appId: "123",
      githubInstallationId: "456",
      maximumDurationSeconds: 3600,
      allowStandingApprovals: true,
      repositories: [
        {
          repositoryRef: "project",
          repositoryId: "789",
          repository: "example/project",
          namespaces: [
            {
              namespaceId,
              profiles: ["git-write"],
              allowStandingApproval: true,
              transport: "git-only",
              pushRefAllowlist: ["refs/heads/review"],
            },
          ],
        },
      ],
    };
    registry.repositories.push({
      ...registry.repositories[0]!,
      repositoryRef: "project-two",
      repositoryId: "790",
      repository: "example/another",
    });
    let app!: ReturnType<typeof createFastifyApp>;
    let controllerTime: number | undefined;
    async function selectRepo(
      input: unknown,
      eligibility: boolean | "absent" | "registry" = "registry",
    ) {
      if (app) {
        await app.close();
      }
      const controller = new OpenClawController(installation!, {
        state,
        now: () => new Date(controllerTime ?? Date.now()),
        backends: [
          {
            id: backendId,
            type: "github",
            configuration: { registryPath: "/unused/standing.json" },
            drivers: { repo: "standing-repo-driver" },
          },
        ],
      });
      const driver = new GitHubRepositoryPolicy(
        {
          driverId: "standing-repo-driver",
          backendId,
        },
        validateGitHubRepositoryRegistry(input),
        { sessionDurationSeconds: 3600 },
      );
      // Keep scope resolution unchanged while varying the independent policy permission.
      if (eligibility !== "registry") {
        Object.defineProperty(driver, "allowsStandingApproval", {
          value: eligibility === "absent" ? undefined : () => eligibility,
        });
      }
      const computeDriver = {
        ...compute,
        capability: "compute" as const,
        async stopRevision() {},
      } satisfies ComputeDriver;
      const configurationDriver: ConfigurationDriver = {
        ...configuration,
        capability: "configuration",
      };
      const secretDriver: SecretDriver = { ...secrets, capability: "secret" };
      for (const d of [iam, computeDriver, configurationDriver, secretDriver, driver]) {
        controller.registerDriver(d);
        controller.selectDriver(d.capability, d.id);
      }
      app = createFastifyApp({
        controller,
        iamDriver: iam,
        computeDriver,
        configurationDriver,
        secretDriver,
        resolveHarness: resolveApprovedHarness,
        auditSink: state.auditSink,
        auth,
        development: { enabled: false },
      });
    }
    await selectRepo(registry);
    t.after(() => app.close());
    const login = await injectJson(app, "POST", "/api/auth/sign-in/email", {
      body: {
        email: "postgres-admin@openclaw.local",
        password: "postgres-development-password",
      },
    });
    assert.equal(login.statusCode, 200, login.body);
    const cookies = login.headers["set-cookie"];
    const session = {
      origin: "http://127.0.0.1",
      cookie: cookieHeaderFromSetCookie(Array.isArray(cookies) ? cookies : [cookies!]),
    };
    const request = (
      method: "PATCH" | "GET" | "POST",
      url: string,
      payload?: unknown,
      actorSession = session,
    ) => injectJson(app, method, url, { body: payload, session: actorSession });
    // The ready Namespace fixture does not grant standing approval.
    await state.transact((unit) =>
      unit.namespaces.createNamespace({
        id: namespaceId,
        name: namespaceId,
        status: "ready",
        createdAt: new Date().toISOString(),
      }),
    );
    const cfg = await request("POST", `/namespaces/${namespaceId}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("openclaw", "gpt-4.1"),
    });
    assert.equal(cfg.statusCode, 201, cfg.body);
    const configurationId = cfg.json().data.id;
    const secret = await request("POST", `/namespaces/${namespaceId}/secrets`, {
      name: "Standing fixture key",
      value: "synthetic-not-a-provider-key",
    });
    assert.equal(secret.statusCode, 201, secret.body);
    const secretRef = secret.json().data.ref;
    const created = await request("POST", `/namespaces/${namespaceId}/agents`, {
      name: "Approval source",
      harnessAuth: { method: "api_key", source: secretRef },
      configurationId,
      repositoryBindings: [{ repositoryRef: "project", profile: "git-write" }],
    });
    assert.equal(created.statusCode, 201, created.body);
    const agent = created.json().data;
    await grantAgentSecretOperate(pool, agent, secretRef.id);
    const path = `/namespaces/${namespaceId}/agents/${agent.id}`;
    const read = async () => {
      const r = await request("GET", path + "/repository-approvals");
      assert.equal(r.statusCode, 200, r.body);
      return r.json().data;
    };
    assert.deepEqual(await read(), [], "finite binding does not opt into standing approval");
    const proposalResponse = await request("GET", path + "/repository-approval-scopes");
    assert.equal(proposalResponse.statusCode, 200, proposalResponse.body);
    const reviewed = proposalResponse.json().data[0];
    const fingerprintInput = {
      namespaceId,
      agentId: agent.id,
      binding: reviewed.binding,
      scope: reviewed.scope,
    };
    const reordered = {
      ...fingerprintInput,
      scope: Object.fromEntries(
        Object.entries(reviewed.scope as RepositoryApprovalScope).reverse(),
      ),
    };
    assert.equal(
      repositoryApprovalFingerprint(reordered),
      reviewed.scopeFingerprint,
      "JSON member order does not alter reviewed scope",
    );
    assert.throws(
      () =>
        repositoryApprovalFingerprint({
          ...fingerprintInput,
          scope: { ...reviewed.scope, extra: undefined },
        }),
      TypeError,
    );
    const accountRead = await request("GET", "/api/auth/session");
    assert.equal(accountRead.statusCode, 200, accountRead.body);
    const approvers = (await state.loadNativeIAMState()).identities.filter(
      (p) =>
        p.kind === "principal" &&
        p.issuer.endsWith(":better-auth") &&
        p.subject === accountRead.json().data.user.id,
    );
    assert.equal(approvers.length, 1);
    const approvalId = randomUUID();
    const grant = {
      configurationId,
      repositoryStandingApproval: {
        repositoryRef: "project",
        approvalId,
        approved: true,
        duration: "until-removed",
        expectedScopeFingerprint: reviewed.scopeFingerprint,
      },
    };
    const unreviewed = {
      ...grant,
      repositoryStandingApproval: { ...grant.repositoryStandingApproval },
    };
    Object.assign(unreviewed.repositoryStandingApproval, { expectedScopeFingerprint: undefined });
    assert.equal(
      (await request("PATCH", path, unreviewed)).statusCode,
      400,
      "scope review is required",
    );
    for (const eligibility of [false, "absent"] as const) {
      await selectRepo(registry, eligibility);
      const preview = await request("GET", path + "/repository-approval-scopes");
      assert.equal(preview.statusCode, 200, preview.body);
      assert.deepEqual(preview.json().data, [], "a scope alone cannot offer standing approval");
      const denied = await request("PATCH", path, grant);
      assert.equal(denied.statusCode, 409, denied.body);
      assert.equal(denied.json().error.message, STANDING_APPROVAL_NOT_PERMITTED);
      assert.deepEqual(await read(), [], "ineligible save cannot persist approval");
    }
    await selectRepo(registry, true);
    assert.deepEqual(
      (await request("GET", path + "/repository-approval-scopes")).json().data,
      [reviewed],
      "explicit permission restores the identical review scope",
    );
    const widenedBeforeApproval = structuredClone(registry);
    widenedBeforeApproval.repositories[0]!.namespaces[0]!.pushRefAllowlist = ["refs/heads/*"];
    await selectRepo(widenedBeforeApproval);
    const staleReview = await request("PATCH", path, grant);
    assert.equal(staleReview.statusCode, 409, staleReview.body);
    // Each standing approval refusal names its fix instead of "already exists" (finding 2536).
    assert.equal(staleReview.json().error.message, STANDING_APPROVAL_SCOPE_CHANGED);
    assert.deepEqual(
      await read(),
      [],
      "first grant cannot silently accept policy widened after review",
    );
    await selectRepo(registry);
    const absentRemoval = await request("PATCH", path, {
      configurationId,
      repositoryStandingApproval: {
        repositoryRef: "project",
        approvalId,
        approved: false,
        expectedGeneration: 1,
      },
    });
    assert.equal(absentRemoval.statusCode, 404, "absence must never acknowledge removal");
    assert.equal(
      (
        await request("POST", path + `/repository-approvals/${approvalId}/remove`, {
          expectedGeneration: 1,
        })
      ).statusCode,
      404,
    );
    for (const changed of [
      { ...registry, allowStandingApprovals: undefined },
      {
        ...registry,
        repositories: [
          {
            ...registry.repositories[0],
            namespaces: [
              { ...registry.repositories[0]!.namespaces[0]!, allowStandingApproval: undefined },
            ],
          },
        ],
      },
    ]) {
      await selectRepo(JSON.parse(JSON.stringify(changed)));
      // The caller administers the Agent, so policy is a named conflict, not a 404.
      const denied = await request("PATCH", path, grant);
      assert.equal(denied.statusCode, 409, denied.body);
      assert.equal(denied.json().error.code, "RESOURCE_CONFLICT");
      assert.equal(denied.json().error.message, STANDING_APPROVAL_NOT_PERMITTED);
      assert.deepEqual(await read(), []);
    }
    await selectRepo(registry);
    for (const [duration, status] of [
      [undefined, 400],
      ["permanent", 400],
    ] as const) {
      const denied = await request("PATCH", path, {
        ...grant,
        repositoryStandingApproval: { ...grant.repositoryStandingApproval, duration },
      });
      assert.equal(denied.statusCode, status, denied.body);
      assert.deepEqual(await read(), []);
    }
    // The policy writer owns the Namespace row. Let PostgreSQL prove the HTTP mutation
    // is waiting on that row before committing the deny and releasing the request.
    async function denyAdministrationWhileWaiting(
      agentId: string,
      send: () => ReturnType<typeof request>,
    ) {
      const writer = await pool.connect();
      const restrictionId = `restriction_${randomUUID()}`;
      let pending: ReturnType<typeof request> | undefined;
      let committed = false;
      try {
        await writer.query("BEGIN");
        const locked = await writer.query(
          "SELECT pg_backend_pid() AS pid FROM occ.namespaces WHERE id=$1 FOR UPDATE",
          [namespaceId],
        );
        assert.equal(locked.rowCount, 1);
        pending = send();
        await waitForLockWaiter(
          pool,
          locked.rows[0].pid,
          "the HTTP request to wait on our Namespace lock",
          {
            queryLike: "%FROM occ.namespaces%FOR UPDATE%",
            timeoutMs: 10_000,
          },
        );
        // Like an IAM policy write, the admitted session already holds the user row.
        // An account disable taking its normal user lock cannot pass us during that wait.
        await assert.rejects(
          pool.query('SELECT id FROM occ."user" WHERE id=$1 FOR UPDATE NOWAIT', [
            accountRead.json().data.user.id,
          ]),
          { code: "55P03" },
        );
        await writer.query(
          `INSERT INTO occ.iam_restrictions(id,namespace_id,action,resource_kind,resource_id,effect)
           VALUES($1,$2,'administer','agent',$3,'deny')`,
          [restrictionId, namespaceId, agentId],
        );
        await writer.query("COMMIT");
        committed = true;
        const response = await pending;
        assert.equal(response.statusCode, 403, response.body);
        assert.equal(response.json().error.code, "FORBIDDEN");
      } finally {
        if (!committed) {
          await writer.query("ROLLBACK");
        }
        writer.release();
        await pending;
      }
    }
    const granted = await request("PATCH", path, grant);
    assert.equal(granted.statusCode, 200, granted.body);
    const [first] = await read();
    assert.equal(first.id, approvalId);
    assert.equal(first.generation, 1);
    assert.equal(first.approvedBy, approvers[0]!.id);
    assert.equal(first.scopeFingerprint, reviewed.scopeFingerprint);
    assert.ok(!("scope" in first || "binding" in first || "namespaceId" in first));
    assert.equal(first.status, "active");
    assert.match(first.scopeFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(reviewed.scope.appId, "123");
    assert.equal(reviewed.scope.installationId, "456");
    assert.deepEqual(reviewed.scope.pushRefAllowlist, ["refs/heads/review"]);
    assert.equal(reviewed.scope.repositorySelection, "repository");
    assert.deepEqual(reviewed.scope.apiPermissions, { metadata: "read", contents: "write" });
    assert.equal(
      (await request("PATCH", path, grant)).statusCode,
      200,
      "lost ACK retry preserves approval",
    );
    assert.deepEqual(await read(), [first]);
    const secondBinding = { repositoryRef: "project-two", profile: "git-write" };
    const addBinding = await request("PATCH", path, {
      configurationId,
      repositoryBindings: [...agent.repositoryBindings, secondBinding],
    });
    assert.equal(addBinding.statusCode, 409, addBinding.body);
    assert.equal(addBinding.json().error.message, STANDING_APPROVAL_BINDING_LOCKED);
    assert.deepEqual(
      (await request("GET", path)).json().data.repositoryBindings,
      agent.repositoryBindings,
      "adding a second binding rolls back atomically",
    );
    const multi = await request("POST", `/namespaces/${namespaceId}/agents`, {
      name: "Finite multibinding source",
      configurationId,
      repositoryBindings: [...agent.repositoryBindings, secondBinding],
    });
    assert.equal(multi.statusCode, 201, multi.body);
    const multiPath = `/namespaces/${namespaceId}/agents/${multi.json().data.id}`;
    assert.deepEqual(
      (await request("GET", multiPath + "/repository-approval-scopes")).json().data,
      [],
    );
    const multiGrant = await request("PATCH", multiPath, grant);
    assert.equal(multiGrant.statusCode, 409, multiGrant.body);
    assert.equal(multiGrant.json().error.message, STANDING_APPROVAL_ONE_BINDING);
    assert.deepEqual(
      (await request("GET", multiPath + "/repository-approvals")).json().data,
      [],
      "unsupported multibinding cannot acquire active standing approval",
    );
    for (const eligibility of [false, "absent"] as const) {
      await selectRepo(registry, eligibility);
      const denied = await request("POST", path + "/deploy");
      assert.equal(denied.statusCode, 409, denied.body);
      assert.equal(denied.json().error.message, STANDING_APPROVAL_POLICY_CHANGED);
      assert.deepEqual(await read(), [first], "deploy refusal does not rewrite approval");
      assert.deepEqual(
        await state.read((v) => v.revisions.listRevisions(namespaceId, agent.id)),
        [],
        "ineligible deploy cannot admit a revision",
      );
    }
    await selectRepo(registry, true);
    const deployment = await request("POST", path + "/deploy");
    assert.equal(deployment.statusCode, 202, deployment.body);
    const revision = await state.read((v) =>
      v.revisions.findRevision(namespaceId, agent.id, deployment.json().data.id),
    );
    assert.ok(revision?.repositoryCredentials);
    assert.equal(revision.repositoryCredentials.standingApprovalId, first.id);
    assert.equal(revision.repositoryCredentials.standingApprovalGeneration, 1);
    assert.equal(
      revision.repositoryCredentials.standingApprovalScopeFingerprint,
      first.scopeFingerprint,
    );
    const currentGeneration = async () =>
      (
        await pool.query(
          "SELECT occ.repository_standing_approval_is_current($1::jsonb,$2,$3) AS allowed",
          [revision.repositoryCredentials, namespaceId, agent.id],
        )
      ).rows[0].allowed;
    assert.equal(await currentGeneration(), true);
    const openingId = randomUUID();
    await state.transact((u) =>
      u.repositorySessions.createAttempt({
        namespaceId,
        agentId: agent.id,
        revisionId: revision.id,
        repositoryRef: "project",
        admissionId: openingId,
        durationSeconds: 3600,
        deadlineWallMs: revision.repositoryCredentials!.deadlineWallMs,
        createdAt: new Date().toISOString(),
      }),
    );
    const widened = structuredClone(registry);
    widened.repositories[0]!.namespaces[0]!.pushRefAllowlist = ["refs/heads/*"];
    await selectRepo(widened);
    const broaden = await request("PATCH", path, grant);
    assert.equal(broaden.statusCode, 409, broaden.body);
    assert.equal(broaden.json().error.message, STANDING_APPROVAL_SCOPE_CHANGED);
    assert.deepEqual(await read(), [first]);
    // Deploy refuses the approval that no longer matches policy and says how to recover.
    const staleDeploy = await request("POST", path + "/deploy");
    assert.equal(staleDeploy.statusCode, 409, staleDeploy.body);
    assert.equal(staleDeploy.json().error.message, STANDING_APPROVAL_POLICY_CHANGED);
    assert.doesNotMatch(staleDeploy.body, new RegExp(approvalId));
    await selectRepo(registry);
    const savedConfig = configuration.stored({ namespaceId, id: configurationId });
    await configuration.delete({ namespaceId, id: configurationId });
    secrets.setResolveOverride(() => {
      throw new Error("Synthetic Secret unavailable");
    });
    const patchRemoval = await request("PATCH", path, {
      configurationId,
      repositoryStandingApproval: {
        repositoryRef: "project",
        approvalId,
        approved: false,
        expectedGeneration: 1,
      },
    });
    assert.equal(patchRemoval.statusCode, 503, patchRemoval.body);
    assert.equal(await currentGeneration(), true, "failed generic PATCH has not removed authority");
    const exactApproval = { namespaceId, agentId: agent.id, id: approvalId, generation: 1 };
    // An unmet compare-and-set is a conflict. A real rejected write is an outage, not a
    // missing approval; keep its SQLSTATE for diagnostics and leave the authorization unchanged.
    await assert.rejects(
      state.transact((u) =>
        u.repositorySessions.revokeStanding({ ...exactApproval, generation: 3 }, first.createdAt),
      ),
      { name: "ResourceStateConflictError" },
    );
    await assert.rejects(
      state.transact((u) => u.repositorySessions.revokeStanding(exactApproval, "infinity")),
      (error: Error) => {
        assert.equal(error.name, "DependencyUnavailableError");
        assert.equal((error.cause as { code?: string }).code, "23514");
        return true;
      },
    );
    assert.equal(await currentGeneration(), true);
    const remove = () =>
      request("POST", path + `/repository-approvals/${approvalId}/remove`, {
        expectedGeneration: 1,
      });
    // A clock correction cannot postpone withdrawal or backdate it before the grant.
    controllerTime = Date.parse(first.createdAt) - 60_000;
    const removed = await remove();
    controllerTime = undefined;
    assert.equal(removed.statusCode, 204, removed.body);
    assert.equal((await remove()).statusCode, 204, "lost removal ACK is idempotent");
    await configuration.create(savedConfig);
    secrets.setResolveOverride(undefined);
    assert.equal(
      (
        await request("POST", path + `/repository-approvals/${approvalId}/remove`, {
          expectedGeneration: 3,
        })
      ).statusCode,
      409,
      "stale removal cannot advance a terminal generation",
    );
    const [terminal] = await read();
    assert.equal(terminal.generation, 2);
    assert.equal(terminal.revokedAt, first.createdAt);
    assert.equal(terminal.status, "removed");
    assert.equal(
      await state.read((v) =>
        v.repositorySessions.findStandingApproval(namespaceId, agent.id, "project"),
      ),
      undefined,
    );
    assert.equal(
      (await request("PATCH", path, grant)).statusCode,
      409,
      "revoked identity cannot be re-granted",
    );
    assert.equal(
      await currentGeneration(),
      false,
      "removal fences the admitted generation before acknowledgement",
    );
    await assert.rejects(
      state.transact((u) =>
        u.repositorySessions.advanceAttempt({
          admissionId: openingId,
          expectedPhase: "opening",
          phase: "open",
          sessionId: "synthetic-session",
          updatedAt: new Date().toISOString(),
        }),
      ),
      { name: "ScopeViolationError" },
    );
    const next = {
      ...grant,
      repositoryStandingApproval: { ...grant.repositoryStandingApproval, approvalId: randomUUID() },
    };
    assert.equal((await request("PATCH", path, next)).statusCode, 200);
    assert.equal((await read())[1].generation, 3);
    assert.equal(
      await currentGeneration(),
      false,
      "reapproval cannot authorize the old generation",
    );
    const oldRevision = await state.read((v) =>
      v.revisions.findRevision(namespaceId, agent.id, revision.id),
    );
    assert.ok(oldRevision?.repositoryCredentials);
    assert.deepEqual(
      oldRevision.repositoryCredentials,
      revision.repositoryCredentials,
      "reapproval cannot rebind an existing execution",
    );
    assert.notEqual(
      (await read())[1].generation,
      oldRevision.repositoryCredentials.standingApprovalGeneration,
    );
    // Authenticate a real read-only principal, then delegate administration only in another Namespace.
    const readerRole = `role_${randomUUID()}`;
    await pool.query(
      "INSERT INTO occ.iam_roles(id,name,permissions) VALUES($1,'Standing reader',$2::jsonb)",
      [
        readerRole,
        JSON.stringify([
          { action: "read", resourceKind: "agent" },
          { action: "read", resourceKind: "namespace" },
        ]),
      ],
    );
    const credentials = {
      email: `standing-reader-${randomUUID()}@example.test`,
      password: `generated-password-${randomUUID()}`,
    };
    const account = await auth.createAccount({ ...credentials, name: "Standing reader" });
    const readerSeed = auth.principalSeed(account, { grant: "none" });
    await state.appendNativeIAMPrincipal(readerSeed);
    const readerId = readerSeed.principal.id;
    await pool.query(
      "INSERT INTO occ.iam_access_bindings(id,namespace_id,identity_subject_id,role_id) VALUES($1,$2,$3,$4)",
      [`binding_${randomUUID()}`, namespaceId, readerId, readerRole],
    );
    const readerSession = await signInToControllerApp(app, credentials);
    assert.equal((await request("GET", path, undefined, readerSession)).statusCode, 200);
    for (const suffix of ["/repository-approvals", "/repository-approval-scopes"]) {
      assert.equal(
        (await request("GET", path + suffix, undefined, readerSession)).statusCode,
        403,
        "read-only identity cannot read operator approval details",
      );
    }
    const foreignNs = `ns_${randomUUID()}`;
    await state.transact((u) =>
      u.namespaces.createNamespace({
        id: foreignNs,
        name: foreignNs,
        status: "ready",
        createdAt: new Date().toISOString(),
      }),
    );
    const foreignCfg = await request("POST", `/namespaces/${foreignNs}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("openclaw", "gpt-4.1"),
    });
    assert.equal(foreignCfg.statusCode, 201, foreignCfg.body);
    const foreignAgent = await request("POST", `/namespaces/${foreignNs}/agents`, {
      name: "Other team Agent",
      configurationId: foreignCfg.json().data.id,
    });
    assert.equal(foreignAgent.statusCode, 201, foreignAgent.body);
    const operatorRole = `role_${randomUUID()}`;
    await pool.query(
      "INSERT INTO occ.iam_roles(id,namespace_id,name,permissions) VALUES($1,$2,'Standing operator',$3::jsonb)",
      [operatorRole, foreignNs, JSON.stringify([{ action: "administer", resourceKind: "agent" }])],
    );
    await pool.query(
      "INSERT INTO occ.iam_access_bindings(id,namespace_id,identity_subject_id,role_id) VALUES($1,$2,$3,$4)",
      [`binding_${randomUUID()}`, foreignNs, readerId, operatorRole],
    );
    const foreignPath = `/namespaces/${foreignNs}/agents/${foreignAgent.json().data.id}`;
    assert.equal(
      (await request("GET", foreignPath + "/repository-approvals", undefined, readerSession))
        .statusCode,
      200,
    );
    assert.equal(
      (await request("GET", path + "/repository-approvals", undefined, readerSession)).statusCode,
      403,
      "another Namespace's operator cannot inspect this approval",
    );
    assert.equal(
      (
        await request(
          "POST",
          path + `/repository-approvals/${next.repositoryStandingApproval.approvalId}/remove`,
          { expectedGeneration: 3 },
          readerSession,
        )
      ).statusCode,
      403,
    );
    assert.equal((await request("PATCH", path, next, readerSession)).statusCode, 403);
    // Deny the grant permission after the generic PATCH staged a new Configuration.
    const cfg2 = await request("POST", `/namespaces/${namespaceId}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("openclaw", "gpt-4.1"),
    });
    assert.equal(cfg2.statusCode, 201, cfg2.body);
    // Give the grant race its own Agent: the restriction is a real, durable denial.
    const contender = await request("POST", `/namespaces/${namespaceId}/agents`, {
      name: "Standing approval grant contention",
      configurationId,
      repositoryBindings: agent.repositoryBindings,
    });
    assert.equal(contender.statusCode, 201, contender.body);
    const contenderId = contender.json().data.id;
    const contenderPath = `/namespaces/${namespaceId}/agents/${contenderId}`;
    const scope = await request("GET", contenderPath + "/repository-approval-scopes");
    assert.equal(scope.statusCode, 200, scope.body);
    await denyAdministrationWhileWaiting(contenderId, () =>
      request("PATCH", contenderPath, {
        configurationId,
        repositoryStandingApproval: {
          ...grant.repositoryStandingApproval,
          approvalId: randomUUID(),
          expectedScopeFingerprint: scope.json().data[0].scopeFingerprint,
        },
      }),
    );
    assert.deepEqual(
      await state.read((v) => v.repositorySessions.listStandingApprovals(namespaceId, contenderId)),
      [],
      "no grant after the deny committed during the Namespace lock wait",
    );
    const storedApprovals = () =>
      state.read((v) => v.repositorySessions.listStandingApprovals(namespaceId, agent.id));
    const before = await storedApprovals();
    await denyAdministrationWhileWaiting(agent.id, () =>
      request(
        "POST",
        path + `/repository-approvals/${next.repositoryStandingApproval.approvalId}/remove`,
        { expectedGeneration: 3 },
      ),
    );
    assert.deepEqual(await storedApprovals(), before, "the denied removal did not commit");
    const denied = await request("PATCH", path, { ...next, configurationId: cfg2.json().data.id });
    assert.equal(denied.statusCode, 403, denied.body);
    assert.deepEqual(await storedApprovals(), before);
    const after = await request("GET", path);
    assert.equal(
      after.json().data.configurationId,
      configurationId,
      "denied approval rolls back earlier Agent update",
    );
  },
);
