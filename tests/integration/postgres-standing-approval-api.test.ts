import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type {
  ComputeDriver,
  ConfigurationDriver,
  SecretDriver,
  RepositoryApprovalScope,
  RepositoryRevisionState,
  RepositoryPolicyDriver,
  GitHubRepositoryCredentialBackendDefinition,
} from "../../packages/contracts/src/index.ts";
import { createPostgresControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import {
  composeRepositoryPolicy,
  repositoryPolicyOwner,
} from "../../apps/controller/src/composition/repository-credentials/policy.ts";
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
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
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
// Proves registered HTTP/IAM/State behavior with controlled Compute credential preparation.
// No external provider or runtime operation is executed.
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
    const repositoryTopology = createTestKubernetesComputeDriver("standing-compute", {
      repositoryCredentials: true,
    });
    const compute = createReadyComputeDriver("standing-compute", {
      validateRepositoryCredentials() {},
      validateRepositoryCredentialSupport:
        repositoryTopology.validateRepositoryCredentialSupport.bind(repositoryTopology),
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
    let selectedPolicy!: RepositoryPolicyDriver;
    let app!: ReturnType<typeof createFastifyApp>;
    let controllerTime: number | undefined;
    async function selectRepo(
      input: unknown,
      eligibility: boolean | "absent" | "registry" = "registry",
      setup: {
        bundled?: boolean;
        adaptPolicy?: ((policy: GitHubRepositoryPolicy) => RepositoryPolicyDriver) | undefined;
        runtimeCredentials?: Pick<
          ComputeDriver,
          | "requiresAgentRuntimeCredentials"
          | "getAgentRuntimeCredentialStatus"
          | "provisionAgentRuntimeCredentials"
        >;
      } = {},
    ) {
      if (app) {
        await app.close();
      }
      const backend: GitHubRepositoryCredentialBackendDefinition = {
        id: backendId,
        type: "github",
        configuration: { registryPath: "/unused/standing.json" },
        drivers: { repo: "standing-repo-driver" },
      };
      const composed = composeRepositoryPolicy(
        repositoryPolicyOwner({
          backend,
          selection: {
            id: "standing-repo-driver",
            implementation: "github",
            configuration: {},
          },
        }),
        validateGitHubRepositoryRegistry(input),
        3600,
      );
      const options = {
        state,
        now: () => new Date(controllerTime ?? Date.now()),
        backends: [backend],
      };
      const controller = setup.bundled
        ? OpenClawController.forInstallation(installation!, options, composed.repositoryAdmission)
        : new OpenClawController(installation!, options);
      const driver = setup.adaptPolicy?.(composed.repositoryPolicy) ?? composed.repositoryPolicy;
      selectedPolicy = driver;
      // Keep scope resolution unchanged while varying the independent policy permission.
      if (eligibility !== "registry") {
        Object.defineProperty(driver, "allowsStandingApproval", {
          value: eligibility === "absent" ? undefined : () => eligibility,
        });
      }
      const computeDriver = {
        ...compute,
        ...setup.runtimeCredentials,
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
      return { controller, options, repositoryAdmission: composed.repositoryAdmission };
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

    await t.test(
      "finite repository picker uses the bound catalog without standing permission",
      async (t) => {
        const { allowStandingApprovals: _standingOptIn, ...finiteRegistry } = registry;
        const expected = [
          {
            repositoryRef: "project",
            displayName: "example/project",
            allowedProfiles: ["git-write"],
          },
          {
            repositoryRef: "project-two",
            displayName: "example/another",
            allowedProfiles: ["git-write"],
          },
        ];
        const pickerPath = `/namespaces/${namespaceId}/agents/repository-options`;
        for (const bundled of [false, true]) {
          const { controller } = await selectRepo(finiteRegistry, "registry", { bundled });
          const policy = selectedPolicy;
          assert.ok(policy instanceof GitHubRepositoryPolicy);
          // The legacy route must delegate to the same catalog. The bundled route must
          // work even when the old Driver method refuses every call.
          const legacy = t.mock.method(
            policy,
            "listOptions",
            bundled
              ? async () => {
                  throw new Error("legacy list must not run");
                }
              : policy.listOptions.bind(policy),
          );
          const listCatalog = policy.listCatalog.bind(policy);
          const catalog = t.mock.method(policy, "listCatalog");
          const standing = t.mock.method(policy, "allowsStandingApproval", () => {
            throw new Error("finite listing must not consult standing permission");
          });
          const listed = await request("GET", pickerPath);
          assert.equal(listed.statusCode, 200, listed.body);
          assert.deepEqual(listed.json().data, expected);
          assert.equal(legacy.mock.callCount(), bundled ? 0 : 1);
          assert.equal(catalog.mock.callCount(), 1);
          assert.equal(standing.mock.callCount(), 0);
          if (bundled) {
            let replacementCalls = 0;
            const replacement: RepositoryPolicyDriver = {
              id: "unbound-picker",
              capability: "repo",
              implementation: "custom-picker",
              async listOptions() {
                replacementCalls++;
                return { options: expected };
              },
              resolve: (input) => policy.resolve(input),
            };
            controller.registerDriver(replacement);
            const entered = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            catalog.mock.mockImplementationOnce(async (input) => {
              const result = await listCatalog(input);
              entered.resolve();
              await release.promise;
              return result;
            });
            const pending = request("GET", pickerPath);
            try {
              await Promise.race([
                entered.promise,
                pending.then(() =>
                  assert.fail("listing ended before the bound catalog was called"),
                ),
              ]);
              controller.selectDriver("repo", replacement.id);
            } finally {
              release.resolve();
            }
            const stale = await pending;
            assert.equal(stale.statusCode, 503, stale.body);
            assert.equal(stale.json().data, undefined, "no options from the former policy");
            assert.equal(catalog.mock.callCount(), 2);

            const denied = await request("GET", pickerPath);
            assert.equal(denied.statusCode, 503, denied.body);
            assert.equal(denied.json().error.code, "DEPENDENCY_UNAVAILABLE");
            assert.equal(denied.json().data, undefined);
            assert.equal(replacementCalls, 0);
            assert.equal(
              catalog.mock.callCount(),
              2,
              "wrong owner cannot invoke the bound catalog",
            );
          }
          standing.mock.restore();
          catalog.mock.restore();
          legacy.mock.restore();
        }
        // Ordinary registration still dispatches to the selected in-process extension.
        let customCalls = 0;
        const customOptions = [
          {
            repositoryRef: "custom",
            displayName: "Custom repository",
            allowedProfiles: ["git-read"],
          },
        ];
        await selectRepo(finiteRegistry, "registry", {
          adaptPolicy: (policy) => ({
            id: policy.id,
            capability: "repo",
            implementation: "custom-picker",
            async listOptions() {
              customCalls++;
              return { options: customOptions };
            },
            resolve: (input) => policy.resolve(input),
          }),
        });
        const custom = await request("GET", pickerPath);
        assert.equal(custom.statusCode, 200, custom.body);
        assert.deepEqual(custom.json().data, customOptions);
        assert.equal(customCalls, 1);
      },
    );

    await t.test("bundled repository saves resolve once through the bound owner", async (t) => {
      await selectRepo(registry, "registry", { bundled: true });
      const policy = selectedPolicy;
      assert.ok(policy instanceof GitHubRepositoryPolicy);
      const bound = t.mock.method(policy, "resolveBindings");
      const legacy = t.mock.method(policy, "resolve");
      const bindings = [{ repositoryRef: "project", profile: "git-write" }];
      const created = await request("POST", `/namespaces/${namespaceId}/agents`, {
        name: "Bound repository save",
        harnessAuth: { method: "api_key", source: secretRef },
        configurationId,
        repositoryBindings: bindings,
      });
      assert.equal(created.statusCode, 201, created.body);
      const savePath = `/namespaces/${namespaceId}/agents/${created.json().data.id}`;
      assert.equal(bound.mock.callCount(), 1);
      assert.equal(legacy.mock.callCount(), 0);
      assert.deepEqual(bound.mock.calls[0]?.arguments, [{ namespaceId, bindings }]);
      assert.deepEqual((await request("GET", savePath)).json().data.repositoryBindings, bindings);

      const access = {
        defaultProfile: "git-write",
        repositories: [{ repositoryRef: "project-two" }],
      };
      const patched = await request("PATCH", savePath, {
        configurationId,
        repositoryAccess: access,
      });
      assert.equal(patched.statusCode, 200, patched.body);
      const inherited = [{ repositoryRef: "project-two", profile: "git-write" }];
      assert.equal(bound.mock.callCount(), 2);
      assert.equal(legacy.mock.callCount(), 0);
      assert.deepEqual(bound.mock.calls[1]?.arguments, [{ namespaceId, bindings: inherited }]);
      const saved = (await request("GET", savePath)).json().data;
      assert.deepEqual(saved.repositoryBindings, inherited);
      assert.deepEqual(saved.repositoryAccess, access);

      const unchanged = await request("PATCH", savePath, { configurationId });
      assert.equal(unchanged.statusCode, 200, unchanged.body);
      assert.equal(bound.mock.callCount(), 2, "PATCH without repository fields does not resolve");
      assert.equal(legacy.mock.callCount(), 0);

      const beforeRefusal = (await request("GET", savePath)).json().data;
      // The actual bound policy refuses an unapproved profile; do not synthesize its error.
      const denied = await request("PATCH", savePath, {
        configurationId,
        repositoryBindings: [{ repositoryRef: "project-two", profile: "git-read" }],
      });
      assert.equal(denied.statusCode, 400, denied.body);
      assert.equal(bound.mock.callCount(), 3);
      assert.equal(legacy.mock.callCount(), 0);
      const afterRefusal = (await request("GET", savePath)).json().data;
      assert.deepEqual(afterRefusal, beforeRefusal, "policy refusal persists no Agent change");
      bound.mock.restore();
      legacy.mock.restore();
    });

    await t.test(
      "fresh Installation admission bypasses the legacy resolver and preserves finite grants",
      async (t) => {
        controllerTime = Date.now();
        let baseline: RepositoryRevisionState | undefined;
        for (const route of ["legacy", "bundled", "custom"] as const) {
          let calls = 0;
          let refuse = false;
          const { controller, options, repositoryAdmission } = await selectRepo(
            registry,
            "registry",
            {
              bundled: route === "bundled",
              adaptPolicy:
                route === "custom"
                  ? (policy) => ({
                      id: policy.id,
                      capability: "repo",
                      implementation: "custom-finite-policy",
                      listOptions: (input) => policy.listOptions(input),
                      resolve(input) {
                        calls++;
                        if (refuse) {
                          throw new Error("custom policy refusal");
                        }
                        const result = policy.resolve(input);
                        return {
                          ...result,
                          sessionDurationSeconds: 47,
                          bindings: result.bindings.map((binding) => ({
                            ...binding,
                            grant: { ...binding.grant, grantId: "custom-finite-grant" },
                          })),
                        };
                      },
                    })
                  : undefined,
            },
          );
          if (route === "bundled") {
            assert.throws(
              () => OpenClawController.forInstallation(installation!, options, undefined),
              /explicit repository admission owner/,
            );
            assert.throws(
              () =>
                OpenClawController.forInstallation(installation!, options, {
                  ...repositoryAdmission,
                  backendId: "unconfigured-backend",
                }),
              /exact owning Backend/,
            );
          }
          const created = await request("POST", `/namespaces/${namespaceId}/agents`, {
            name: `Finite ${route}`,
            harnessAuth: { method: "api_key", source: secretRef },
            configurationId,
            repositoryBindings: [{ repositoryRef: "project", profile: "git-write" }],
          });
          assert.equal(created.statusCode, 201, created.body);
          const finiteAgent = created.json().data;
          await grantAgentSecretOperate(pool, finiteAgent, secretRef.id);
          const finitePath = `/namespaces/${namespaceId}/agents/${finiteAgent.id}`;
          assert.deepEqual(
            await state.read((v) =>
              v.repositorySessions.listStandingApprovals(namespaceId, finiteAgent.id),
            ),
            [],
          );
          const policy = selectedPolicy;
          const original = policy.resolve.bind(policy);
          const spy =
            route === "custom"
              ? undefined
              : t.mock.method(policy, "resolve", (input: Parameters<typeof policy.resolve>[0]) => {
                  calls++;
                  return original(input);
                });
          const boundResolver =
            route === "bundled" && policy instanceof GitHubRepositoryPolicy
              ? t.mock.method(policy, "resolveBindings")
              : undefined;
          calls = 0;
          // Count only deployment admission; Agent save is checked separately above.
          const deployed = await request("POST", finitePath + "/deploy");
          assert.equal(deployed.statusCode, 202, deployed.body);
          const revision = await state.read((v) =>
            v.revisions.findRevision(namespaceId, finiteAgent.id, deployed.json().data.id),
          );
          const snapshot = revision?.repositoryCredentials;
          assert.ok(snapshot);
          assert.equal(calls, route === "bundled" ? 0 : 1);
          assert.equal(snapshot.standingApprovalId, undefined);
          if (route === "legacy") {
            baseline = snapshot;
            assert.equal(snapshot.deadlineWallMs, controllerTime + 3600_000);
            assert.deepEqual(snapshot.driver, { id: policy.id, implementation: "github" });
          } else if (route === "bundled") {
            assert.deepEqual(snapshot, baseline, "same exact owner, finite grant and deadline");
            assert.ok(boundResolver);
            assert.equal(
              boundResolver.mock.callCount(),
              1,
              "bound resolver admits the finite Agent",
            );
            let replacementCalls = 0;
            const replacement: RepositoryPolicyDriver = {
              id: "unbound-repo",
              capability: "repo",
              implementation: "unbound-policy",
              async listOptions() {
                return { options: [] };
              },
              resolve() {
                replacementCalls++;
                throw new Error("unbound owner must not run");
              },
            };
            controller.registerDriver(replacement);
            controller.selectDriver("repo", replacement.id);
            const deploy = t.mock.method(controller, "deployAgentWithAuthorization");
            const denied = await request("POST", finitePath + "/deploy");
            assert.equal(denied.statusCode, 503, denied.body);
            assert.equal(denied.json().error.code, "DEPENDENCY_UNAVAILABLE");
            assert.equal(deploy.mock.callCount(), 1);
            const deployment = deploy.mock.calls[0]?.result;
            assert.ok(deployment);
            await assert.rejects(deployment, {
              name: "DependencyUnavailableError",
              message: "The bound repository admission owner is not selected.",
            });
            assert.equal(
              boundResolver.mock.callCount(),
              1,
              "wrong owner cannot invoke the bound resolver",
            );
            assert.equal(
              replacementCalls,
              0,
              "a different selection cannot replace the bound owner",
            );
            assert.equal(
              (await state.read((v) => v.revisions.listRevisions(namespaceId, finiteAgent.id)))
                .length,
              1,
            );
          } else {
            assert.equal(snapshot.bindings[0]?.grant.grantId, "custom-finite-grant");
            assert.equal(snapshot.deadlineWallMs, controllerTime + 47_000);
            refuse = true;
            const denied = await request("POST", finitePath + "/deploy");
            assert.equal(denied.statusCode, 409, denied.body);
            assert.equal(calls, 2, "the in-process extension still decides refusal");
            assert.equal(
              (await state.read((v) => v.revisions.listRevisions(namespaceId, finiteAgent.id)))
                .length,
              1,
            );
          }
          boundResolver?.mock.restore();
          spy?.mock.restore();
        }
      },
    );
    controllerTime = undefined;
    await selectRepo(registry);
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
    await t.test(
      "bundled standing preview and approval save use the exact bound owner",
      async (t) => {
        const created = await request("POST", `/namespaces/${namespaceId}/agents`, {
          name: "Bound standing approval",
          configurationId,
          repositoryBindings: agent.repositoryBindings,
        });
        assert.equal(created.statusCode, 201, created.body);
        const boundAgent = created.json().data;
        const boundPath = `/namespaces/${namespaceId}/agents/${boundAgent.id}`;
        const expected = {
          ...reviewed,
          scopeFingerprint: repositoryApprovalFingerprint({
            ...fingerprintInput,
            agentId: boundAgent.id,
          }),
        };
        // Approval-only PATCH must not pick up a resolution from ordinary settings save.
        const approval = {
          configurationId,
          repositoryStandingApproval: {
            ...grant.repositoryStandingApproval,
            approvalId: randomUUID(),
            expectedScopeFingerprint: expected.scopeFingerprint,
          },
        };
        const widened = structuredClone(registry);
        widened.repositories[0]!.namespaces[0]!.pushRefAllowlist = ["refs/heads/*"];
        try {
          for (const control of ["bound-veto", "same-id-scope"] as const) {
            const { repositoryAdmission } = await selectRepo(
              control === "bound-veto" ? registry : widened,
              control === "bound-veto" ? false : "registry",
              {
                bundled: true,
                ...(control === "same-id-scope"
                  ? {
                      // Preserve every real policy decision behind a different selected object.
                      adaptPolicy: (policy: GitHubRepositoryPolicy) =>
                        new Proxy(policy, {
                          get(target, property) {
                            const value = Reflect.get(target, property, target);
                            return typeof value === "function" ? value.bind(target) : value;
                          },
                        }),
                    }
                  : {}),
              },
            );
            if (control === "same-id-scope") {
              assert.notEqual(selectedPolicy, repositoryAdmission.policy);
              assert.equal(selectedPolicy.id, repositoryAdmission.policy.id);
            }
            const adapter = t.mock.method(selectedPolicy, "resolve");
            try {
              const preview = await request("GET", boundPath + "/repository-approval-scopes");
              assert.equal(preview.statusCode, 200, preview.body);
              if (control === "bound-veto") {
                assert.deepEqual(preview.json().data, []);
              } else {
                assert.notEqual(preview.json().data[0].scopeFingerprint, expected.scopeFingerprint);
              }
              const denied = await request("PATCH", boundPath, approval);
              assert.equal(denied.statusCode, 409, denied.body);
              assert.equal(
                denied.json().error.message,
                control === "bound-veto"
                  ? STANDING_APPROVAL_NOT_PERMITTED
                  : STANDING_APPROVAL_SCOPE_CHANGED,
              );
              assert.equal(adapter.mock.callCount(), control === "same-id-scope" ? 2 : 0);
              assert.deepEqual(
                await state.read((v) =>
                  v.repositorySessions.listStandingApprovals(namespaceId, boundAgent.id),
                ),
                [],
              );
            } finally {
              adapter.mock.restore();
            }
          }
          await selectRepo(registry, "registry", { bundled: true });
          const policy = selectedPolicy;
          assert.ok(policy instanceof GitHubRepositoryPolicy);
          const bound = t.mock.method(policy, "resolveBindings");
          const adapter = t.mock.method(policy, "resolve");
          try {
            const preview = await request("GET", boundPath + "/repository-approval-scopes");
            assert.equal(preview.statusCode, 200, preview.body);
            assert.deepEqual(preview.json().data, [expected]);
            assert.equal(bound.mock.callCount(), 1);
            assert.equal(adapter.mock.callCount(), 0);
            assert.deepEqual(bound.mock.calls[0]?.arguments, [
              { namespaceId, bindings: agent.repositoryBindings },
            ]);
            const saved = await request("PATCH", boundPath, approval);
            assert.equal(saved.statusCode, 200, saved.body);
            assert.equal(bound.mock.callCount(), 2, "approval-only PATCH resolves exactly once");
            assert.equal(adapter.mock.callCount(), 0);
            assert.deepEqual(bound.mock.calls[1]?.arguments, bound.mock.calls[0]?.arguments);
            const stored = await state.read((v) =>
              v.repositorySessions.listStandingApprovals(namespaceId, boundAgent.id),
            );
            assert.equal(stored.length, 1);
            assert.equal(stored[0]!.id, approval.repositoryStandingApproval.approvalId);
            assert.equal(stored[0]!.scopeFingerprint, expected.scopeFingerprint);
            assert.deepEqual(stored[0]!.scope, expected.scope);
            assert.deepEqual(stored[0]!.binding, expected.binding);
          } finally {
            bound.mock.restore();
            adapter.mock.restore();
          }
        } finally {
          await selectRepo(registry);
        }
      },
    );
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
    await t.test(
      "deploy rejects a grant that changes during standing approval recheck",
      async (t) => {
        const policy = selectedPolicy;
        const resolve = policy.resolve.bind(policy);
        let resolutions = 0;
        // Simulate a grant rotation between the two policy resolutions.
        t.mock.method(policy, "resolve", (input: Parameters<typeof policy.resolve>[0]) => {
          const result = resolve(input);
          if (++resolutions === 1) {
            return result;
          }
          return {
            ...result,
            bindings: result.bindings.map((binding) => ({
              ...binding,
              grant: { ...binding.grant, grantId: "rotated-grant" },
            })),
          };
        });
        const revisionIds = () =>
          state.read(async (v) =>
            (await v.revisions.listRevisions(namespaceId, agent.id)).map(({ id }) => id),
          );
        const approvals = () =>
          state.read((v) => v.repositorySessions.listStandingApprovals(namespaceId, agent.id));
        const beforeRevisionIds = await revisionIds();
        const beforeApprovals = await approvals();
        const denied = await request("POST", path + "/deploy");
        assert.equal(resolutions, 2);
        assert.equal(denied.statusCode, 409, denied.body);
        assert.equal(denied.json().error.message, STANDING_APPROVAL_POLICY_CHANGED);
        assert.deepEqual(await revisionIds(), beforeRevisionIds, "no revision was admitted");
        assert.deepEqual(await approvals(), beforeApprovals, "approval remains intact");
      },
    );
    await t.test("bundled admission retains the late standing veto", async (t) => {
      // Only this new Agent starts without transport credentials. Historical Agents
      // remain configured so the control does not invent a credential-loss refusal.
      let unconfiguredAgentId: string | undefined;
      const statusCalls: string[] = [];
      const provisionCalls: string[] = [];
      await selectRepo(registry, "registry", {
        bundled: true,
        runtimeCredentials: {
          requiresAgentRuntimeCredentials: true,
          async getAgentRuntimeCredentialStatus({ agent }) {
            statusCalls.push(agent.id);
            return { transportConfigured: agent.id !== unconfiguredAgentId };
          },
          async provisionAgentRuntimeCredentials({ agent }) {
            provisionCalls.push(agent.id);
            unconfiguredAgentId = undefined;
            return { transportConfigured: true };
          },
        },
      });
      const positive = await request("POST", `/namespaces/${namespaceId}/agents`, {
        name: "Finite preparation control",
        harnessAuth: { method: "api_key", source: secretRef },
        configurationId,
        repositoryBindings: [{ repositoryRef: "project", profile: "git-write" }],
      });
      assert.equal(positive.statusCode, 201, positive.body);
      const finiteAgent = positive.json().data;
      await grantAgentSecretOperate(pool, finiteAgent, secretRef.id);
      unconfiguredAgentId = finiteAgent.id;
      statusCalls.length = 0;
      provisionCalls.length = 0;
      const deployed = await request(
        "POST",
        `/namespaces/${namespaceId}/agents/${finiteAgent.id}/deploy`,
      );
      assert.equal(deployed.statusCode, 202, deployed.body);
      assert.deepEqual(statusCalls, [finiteAgent.id]);
      assert.deepEqual(provisionCalls, [finiteAgent.id]);
      const workKey = `agent_revision:${deployed.json().data.id}:reconcile`;
      const positiveWork = await state.read((v) => v.operations.findWork(workKey));
      assert.ok(positiveWork, "successful admission enqueues real PostgreSQL reconcile work");
      const operations = () =>
        state.read(async (v) =>
          (await v.operations.list()).filter((operation) => operation.namespaceId === namespaceId),
        );
      const beforeOperations = await operations();
      assert.ok(
        beforeOperations.some(
          (operation) =>
            operation.kind === "agent_revision" && operation.resourceId === deployed.json().data.id,
        ),
      );
      const policy = selectedPolicy;
      assert.ok(policy instanceof GitHubRepositoryPolicy);
      const original = policy.resolveBindings.bind(policy);
      let resolutions = 0;
      let permitted = true;
      t.mock.method(policy, "allowsStandingApproval", () => permitted);
      const legacy = t.mock.method(policy, "resolve");
      const bound = t.mock.method(
        policy,
        "resolveBindings",
        (input: Parameters<typeof policy.resolveBindings>[0]) => {
          // Initial admission succeeds; revoke permission on the resolution after
          // approval lookup, whether called directly or through the legacy adapter.
          if (++resolutions === 2) {
            permitted = false;
          }
          return original(input);
        },
      );
      const before = await state.read((v) => v.revisions.listRevisions(namespaceId, agent.id));
      const beforeWork = await state.read((v) =>
        Promise.all(
          before.map((revision) =>
            v.operations.findWork(`agent_revision:${revision.id}:reconcile`),
          ),
        ),
      );
      statusCalls.length = 0;
      provisionCalls.length = 0;
      const denied = await request("POST", path + "/deploy");
      assert.deepEqual(statusCalls, [], "late veto precedes credential status inspection");
      assert.deepEqual(provisionCalls, [], "late veto precedes credential provisioning");
      assert.deepEqual(await operations(), beforeOperations, "no work added in this Namespace");
      assert.deepEqual(
        await state.read((v) =>
          Promise.all(
            before.map((revision) =>
              v.operations.findWork(`agent_revision:${revision.id}:reconcile`),
            ),
          ),
        ),
        beforeWork,
        "existing Agent work is unchanged",
      );
      assert.deepEqual(await state.read((v) => v.operations.findWork(workKey)), positiveWork);
      assert.equal(denied.statusCode, 409, denied.body);
      assert.equal(denied.json().error.message, STANDING_APPROVAL_POLICY_CHANGED);
      assert.deepEqual(
        await state.read((v) => v.revisions.listRevisions(namespaceId, agent.id)),
        before,
      );
      assert.deepEqual(await read(), [first]);
      assert.equal(bound.mock.callCount(), 2, "initial admission and post-approval resolution");
      assert.equal(
        legacy.mock.callCount(),
        0,
        "bundled standing recheck must not use legacy resolve",
      );
    });
    await selectRepo(registry, true);
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
