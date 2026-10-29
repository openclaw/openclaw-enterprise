import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import type {
  AgentRevision,
  ProtectedGitHubRepositoryMaterial,
  ProtectedRepositoryGitAuthority,
  PreparedGitHubRepositoryUseRequest,
  ProxyRevisionContext,
} from "../../packages/contracts/src/index.ts";
import {
  OpenShellGitRuntime,
  protectedOpenShellGitOwner,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { ObservedHookPreview } from "../../apps/controller/src/drivers/egress-proxy/openshell-request-hook-preview.ts";
import {
  createGitHubRepositoryDeliveryResolver,
  resolveGitHubRepositoryBinding,
  validateGitHubRepositoryRegistry,
} from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import { openShellGitRuntimeFixture, registry } from "../helpers/openshell-git-runtime.ts";
import { routeStore } from "../fixtures/openshell-git-route-store.mjs";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
import { availablePort } from "../helpers/available-port.mjs";
import { invoke, token, openShellMiddlewareClient } from "../helpers/openshell-online-wire.mjs";
import { gitCommandBodies } from "../helpers/openshell-online-git-journey.mjs";

function selected() {
  const config = validateGitHubRepositoryRegistry({
    ...registry,
    repositories: registry.repositories.map((r) => ({
      ...r,
      namespaces: [
        {
          namespaceId: "namespace-a",
          profiles: ["github-repository"],
          permissions: { metadata: "read", contents: "write", issues: "write" },
        },
      ],
    })),
  });
  const binding = resolveGitHubRepositoryBinding(config, {
    namespaceId: "namespace-a",
    repositoryRef: "application",
    profile: "github-repository",
  });
  return { binding, resolve: createGitHubRepositoryDeliveryResolver(config) };
}
function context() {
  const { binding, resolve } = selected();
  const f = openShellGitRuntimeFixture({ store: routeStore(), resolveDelivery: resolve });
  const credentials = { ...f.revision.repositoryCredentials!, bindings: [binding] };
  const revision = {
    ...f.revision,
    repositoryCredentials: credentials,
    executionAdmission: { version: 6, mode: "protected" },
    egressPlan: {
      driver: { id: "openshell" },
      execution: { executionId: f.entry.bindingId },
      repositoryGitAuthorization: "request-hook-observed",
      repositoryGit: credentials,
    },
  } as unknown as AgentRevision;
  const config = {
    ...f.runtime.configuration,
    protectedExecution: true as const,
    observedHookPreviewWorkspace: f.sandbox.workspace,
    authority: { ...f.runtime.configuration.authority, audience: "preview" },
  };
  return { f, binding, resolve, revision, config };
}
function credentialOwner(binding: ReturnType<typeof selected>["binding"]) {
  let material: ProtectedGitHubRepositoryMaterial | undefined = {
    ...binding.grant,
    scope: "github-repository",
    installationId: registry.githubInstallationId,
    repository: "example/application",
    value: "synthetic-installation-token",
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    sessionId: "selected-session",
    preparationAttemptId: "selected-attempt",
    materialVersion: "version-one",
    apiOrigin: "https://api.github.com",
  };
  const uses: PreparedGitHubRepositoryUseRequest[] = [];
  let wrongReply = false;
  const unexpected = async (): Promise<never> => {
    throw new Error("wrong authority port");
  };
  const authority: ProtectedRepositoryGitAuthority = {
    readMaterial: unexpected,
    authorize: unexpected,
    online: {
      readMaterial: unexpected,
      authorize: unexpected,
      githubInstallation: { readMaterial: unexpected, authorize: unexpected },
      githubRepository: { readMaterial: unexpected, authorize: unexpected },
    },
    observedHook: { readMaterial: unexpected, authorize: unexpected },
    observedRepositoryHook: {
      readMaterial: async () => material ?? { absent: "withdrawn" },
      authorize: async (request, installed) => {
        if (!material) {
          return { kind: "denied", reason: "access_withdrawn" };
        }
        uses.push(request);
        return {
          kind: "allow",
          scope: request.scope,
          operation: request.operation,
          repositoryId: wrongReply ? "999" : request.repositoryId,
          revisionId: installed.route.revisionId,
          fence: installed.route.fence,
          preparationAttemptId: material.preparationAttemptId,
          materialVersion: material.materialVersion,
          exchangeId: request.exchangeId,
          requestDigestSha256: request.requestDigestSha256,
          replyBy: new Date(
            Math.min(Date.parse(request.deadlineAt), Date.now() + 2000),
          ).toISOString(),
        };
      },
    },
    recipients: {
      observe: async () => undefined,
      beginInstall: async () => undefined,
      confirmInstall: async () => undefined,
    },
  };
  return {
    authority,
    owner: protectedOpenShellGitOwner(authority, true),
    uses,
    setMaterial: (value: typeof material) => {
      material = value;
    },
    material: () => material!,
    wrongReply: (value: boolean) => {
      wrongReply = value;
    },
  };
}

async function bindOwner(
  t: TestContext,
  runtime: OpenShellGitRuntime,
  authority: ProtectedRepositoryGitAuthority,
) {
  const tls = await harnessTlsFixture(t);
  const keys = generateKeyPairSync("ed25519");
  const issuerPublicKeyPath = join(tls.directory, "issuer.pem");
  await writeFile(issuerPublicKeyPath, keys.publicKey.export({ type: "spki", format: "pem" }));
  const port = await availablePort();
  Object.assign(runtime.configuration.authority, {
    host: "127.0.0.1",
    port,
    issuer: "https://gateway.example.test",
    audience: "preview",
    keyId: "gateway-key",
    certificatePath: join(tls.directory, "server.pem"),
    privateKeyPath: join(tls.directory, "server.key"),
    issuerPublicKeyPath,
  });
  const bound = await runtime.bindRepositoryGit(authority);
  t.after(() => bound.close());
  await runtime["running"];
  return { keys, client: openShellMiddlewareClient(t, port, tls.caBundle) };
}

test("selected runtime prepares its own provider and held preview from the real registry delivery", async (t) => {
  const { f, binding, resolve, revision, config } = context();
  const owner = credentialOwner(binding);
  const runtime = new OpenShellGitRuntime(config, resolve);
  const store = routeStore();
  runtime["routes"] = store as unknown as NonNullable<OpenShellGitRuntime["routes"]>;
  await bindOwner(t, runtime, owner.authority);
  f.faults.sandboxMissing = true;
  const prepared = await runtime.prepare(
    revision,
    f.entry.client,
    f.sandbox.workspace,
    f.sandbox.name,
    t.signal,
    ["openai"],
  );
  assert.match(prepared.provider, /^oce-github-repository-/);
  assert.ok(
    prepared.environment.some(
      (e) => e.name === "GIT_CONFIG_KEY_1" && e.value === "credential.https://github.com.helper",
    ),
  );
  assert.ok(!prepared.environment.some((e) => e.name === "OCE_OPENSHELL_GIT_PUSH_REF"));
  const entry = runtime["states"].get(revision.id)!.entry!;
  assert.equal(entry.binding.credentialState, "bootstrap");
  assert.ok(entry.preview);
  assert.equal(runtime.previewReleased(revision.id), false);
  assert.equal(owner.uses.length, 0);
  assert.equal((entry.authorization.delivery as { scope: string }).scope, "github-repository");
  await assert.rejects(
    new OpenShellGitRuntime(
      { ...config, observedHookPreviewWorkspace: undefined } as unknown as typeof config,
      resolve,
    ).prepare(revision, f.entry.client, f.sandbox.workspace, f.sandbox.name, t.signal),
    /explicitly admitted/,
  );
});

for (const scenario of [
  "normal",
  "foreign-material",
  "unacknowledged-release",
  "changed-selection",
] as const) {
  test(`selected runtime held launch and owner lifecycle: ${scenario}`, async (t) => {
    // Controlled gateway/supervisor fixture; the runtime, policy observer, owner adapter and
    // authenticated HTTP authority are production code. This is not installed OpenShell proof.
    const { f, binding, resolve, revision, config } = context();
    Object.assign(f.runtime.configuration, config);
    Object.assign(f.entry, { revision, authorization: resolve(revision) });
    const owner = credentialOwner(binding);
    f.runtime["owner"] = undefined;
    const preview = new ObservedHookPreview(
      f.sandbox.workspace,
      f.entry.bindingId,
      "github_repository",
    );
    f.entry.preview = preview;
    f.store!.rows.get(revision.id).workerInstance = f.runtime["instance"];
    f.entry.continuity = { model: "openai", workload: async () => "original-pods" };
    f.entry.binding = {
      ...f.entry.binding,
      provider: "oce-github-repository-" + "a".repeat(32),
      executionId: revision.id,
    };
    const runtimeProvider = "oce-runtime-" + "a".repeat(16);
    const gitRule = { name: "git", endpoints: [{ host: "github.com", port: 443 }] };
    Object.assign(f.provider, {
      previewNetworkRule: () => gitRule,
      settlePreviewReceipt: async () => true,
    });
    const observe = f.provider.observe;
    f.provider.observe = async (...args) => {
      const result = await observe(...args);
      return (
        result && {
          ...result,
          workspace: f.sandbox.workspace,
          sandbox: f.sandbox.name,
          executionId: revision.id,
          provider: f.entry.binding.provider,
          providerId: f.entry.binding.providerId,
          profileVersion: f.entry.binding.profileVersion,
          providerEnvRevision: f.entry.binding.resourceVersion,
          configRevision: "1",
          policyHash: "original-policy",
        }
      );
    };
    Object.assign(f.sandbox, {
      mainProcessStartedAt: new Date().toISOString(),
      mainProcessInstanceId: f.supervisor.networkInstanceId,
      resourceVersion: "1",
      annotations: { "openclaw.dev/revision-id": revision.id },
      labels: {},
    });
    Object.assign(f.sandbox.spec, {
      policy: { network_policies: {} },
      providers: ["openai", runtimeProvider, f.entry.binding.provider],
      provider_attachment_epoch: f.supervisor.attachmentEpoch,
    });
    const admission = () => ({
      state: 2,
      instance_id: "configuration",
      policy_version: "1",
      policy_hash: "original-policy",
      config_revision: "1",
      provider_env_revision: f.entry.binding.resourceVersion,
    });
    const getSandbox = f.client.getSandbox;
    f.client.getSandbox = async () => ({
      ...(await getSandbox())!,
      configurationAdmission: admission(),
    });
    const getProvider = f.client.getProvider;
    f.client.getProvider = async (workspace, name) =>
      name === "openai"
        ? { id: "model-id", name, workspace, type: "openai", profileWorkspace: "" }
        : getProvider(workspace, name);
    Object.assign(f.client, {
      readExclusivePreviewWorkspace: async () => true,
      getSandboxProviderStatus: async () => {
        const generation = {
          attachmentEpoch: f.supervisor.attachmentEpoch,
          providerEnvRevision: f.entry.binding.resourceVersion,
          configRevision: "1",
          policyHash: "original-policy",
        };
        return {
          state: "PROVIDER_READINESS_STATE_READY",
          completedOperationId: "model-observe",
          receipt: {
            receiptId: "model-observe",
            kind: "PROVIDER_MUTATION_KIND_OBSERVE",
            workspace: f.sandbox.workspace,
            provider: "openai",
            desired: {
              ...generation,
              sandboxId: f.sandbox.id,
              sandbox: f.sandbox.name,
              providerId: "model-id",
              providerResourceVersion: "1",
            },
          },
          observed: {
            ...generation,
            sessionId: f.supervisor.supervisorSessionId,
            sequence: "1",
            processInstanceId: f.supervisor.processInstanceId,
            policyActive: true,
            credentialsInstalled: true,
            launchEnvironmentInstalled: true,
          },
          networkInstanceId: f.supervisor.networkInstanceId,
          observedTime: new Date().toISOString(),
          evaluatedTime: new Date().toISOString(),
        };
      },
      getSandboxConfig: async () => ({
        policy: {
          network_policies: {
            git: gitRule,
            _provider_openai: {
              name: "_provider_openai",
              endpoints: [{ host: "api.openai.com", port: 443 }],
            },
            ["_provider_" + runtimeProvider.replaceAll("-", "_")]: {
              name: "_provider_" + runtimeProvider.replaceAll("-", "_"),
            },
          },
        },
        version: "1",
        workspace: f.sandbox.workspace,
        configuration_instance_id: "configuration",
        policy_source: 1,
        configuration_admitted: true,
        policy_validation_failure_mode: "fail_closed",
        extension_authentication_enabled: true,
        provider_attachment_epoch: f.supervisor.attachmentEpoch,
        policy_hash: "original-policy",
        config_revision: "1",
        provider_env_revision: f.entry.binding.resourceVersion,
        supervisor_middleware_services: [
          {
            name: "oce-prepared-git",
            audience: "preview",
            request_timeout: { seconds: "5" },
            grpc_endpoint: "https://middleware.example.test",
          },
        ],
      }),
    });
    const { client, keys } = await bindOwner(t, f.runtime, owner.authority);
    await f.reconcile();
    assert.ok(preview.recipient);
    assert.equal(f.calls.rotate, 0);
    const startupId = randomUUID();
    assert.equal(
      await f.runtime.observeHeldPreview(revision.id, startupId, t.signal, async (path) => ({
        startupId,
        probePath: path,
        reasonCode: preview.deny(
          {
            ...f.identity,
            target: {
              reportedScheme: "https",
              host: "github.com",
              port: 443,
              method: "GET",
              path,
              query: "service=git-upload-pack",
            },
            headers: [],
            body: new Uint8Array(),
            deadlineAt: new Date(Date.now() + 5000).toISOString(),
          },
          f.sandbox.id,
        ),
      })),
      "held",
    );
    if (scenario === "foreign-material") {
      owner.setMaterial({ ...owner.material(), repositoryId: "999" });
      await f.reconcile();
      assert.equal(f.calls.rotate, 0);
      assert.equal(f.entry.blocked, "material_mismatch");
      assert.equal(await f.lookup(), undefined);
      return;
    }
    await f.reconcile();
    assert.equal(f.calls.rotate, 1);
    assert.ok(
      f.entry.installed,
      JSON.stringify({
        events: f.events,
        blocked: f.entry.blocked,
        pending: f.entry.pending,
        unobserved: f.entry.unobserved,
      }),
    );
    assert.equal(await f.lookup(), undefined, "no request before release acknowledgement");
    if (scenario === "unacknowledged-release") {
      await assert.rejects(
        f.runtime.releasePreview(revision.id, startupId, async () => false),
        /not acknowledged/,
      );
      assert.equal(await f.lookup(), undefined);
      assert.equal(f.entry.blocked, "preview_release_unconfirmed");
      return;
    }
    await f.runtime.releasePreview(revision.id, startupId, async () => true);
    assert.equal(f.runtime.previewReleased(revision.id), true);
    const evidence = await f.runtime.previewEnforcement(
      { revision, plan: revision.egressPlan!, signal: t.signal } as ProxyRevisionContext,
      f.sandbox.id,
    );
    assert.equal(evidence!.repositoryGitRecipient!.deliveryProfile, "github_repository");
    assert.equal(evidence!.repositoryGitRecipient!.authorization, "request-hook-observed");
    const bearer = token(keys, "supervisor", f.sandbox.id, "preview");
    const bodies = await gitCommandBodies(t, "refs/heads/teammate");
    const evaluate = async (host: string, path: string, body: Uint8Array, contentType: string) =>
      invoke(
        client,
        "EvaluateHttpRequest",
        {
          phase: 1,
          middleware_name: "oce-prepared-git",
          context: {
            sandbox_id: f.sandbox.id,
            request_id: randomUUID(),
            workspace: f.sandbox.workspace,
          },
          config: { fields: { binding_id: { stringValue: f.entry.bindingId } } },
          target: { scheme: "https", host, port: 443, method: "POST", path },
          headers: [{ name: "content-type", value: contentType }],
          body,
        },
        bearer,
      );
    assert.equal(
      (
        await evaluate(
          "github.com",
          "/example/application.git/git-receive-pack",
          bodies.push,
          "application/x-git-receive-pack-request",
        )
      ).decision,
      1,
    );
    assert.equal(
      (
        await evaluate(
          "api.github.com",
          "/repos/example/application/issues",
          Buffer.from('{"title":"collaboration"}'),
          "application/json",
        )
      ).decision,
      1,
    );
    assert.equal(
      (
        await evaluate(
          "api.github.com",
          "/graphql",
          Buffer.from('{"query":"query { viewer { login } }"}'),
          "application/json",
        )
      ).decision,
      1,
    );
    assert.ok(
      owner.uses.every(
        (q) =>
          q.scope === "github-repository" &&
          q.repositoryId === binding.grant.repositoryId &&
          q.grantId === binding.grant.grantId,
      ),
    );
    if (scenario === "changed-selection") {
      Object.assign(f.runtime, {
        resolveDelivery: () => ({
          ...resolve(revision),
          binding: { ...binding, grant: { ...binding.grant, grantId: "new-permission-policy" } },
        }),
      });
      assert.equal(await f.lookup(), undefined);
      assert.equal(f.entry.blocked, "grant_changed");
      return;
    }
    owner.wrongReply(true);
    assert.equal(
      (
        await evaluate(
          "api.github.com",
          "/repos/example/application/issues",
          Buffer.from("{}"),
          "application/json",
        )
      ).decision,
      2,
    );
    owner.wrongReply(false);
    owner.setMaterial({
      ...owner.material(),
      materialVersion: "version-two",
      preparationAttemptId: "attempt-two",
    });
    await f.reconcile();
    assert.equal(f.calls.rotate, 2);
    assert.equal((await f.lookup())!.installed.materialVersion, "version-two");
    owner.setMaterial(undefined);
    await f.reconcile();
    assert.equal(await f.lookup(), undefined);
    f.runtime.withdraw(revision.id);
    assert.equal(await f.lookup(), undefined);
    assert.equal(f.runtime.previewReleased(revision.id), false);
  });
}
