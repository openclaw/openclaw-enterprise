import {
  egressAssociationInstallation,
  type AcceptedEgressAssociation,
} from "../../packages/contracts/src/index.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { databaseUrl, withPool } from "./postgres-database.mjs";
import { requestId } from "./static-egress.mjs";
import { isDeepStrictEqual } from "node:util";
import { request as httpsRequest } from "node:https";
import { buffer } from "node:stream/consumers";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { asRecord } from "../../packages/utils/src/index.ts";
import type {
  ProxyPlan,
  ProxyRevisionContext,
  SandboxDriver,
} from "../../packages/contracts/src/index.ts";
import {
  InstalledDriver,
  PostgresPlatformState,
  type PostgresPool,
  reduceCredentialPolicy,
  revisionPolicyEffects,
} from "../../packages/occ/src/index.ts";
import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import {
  OpenShellCredentialProxyDriver,
  openShellEgressConfiguration,
} from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import type {
  OpenShellGatewayClient,
  OpenShellSandboxProviderStatus,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { openShellExchangeCapabilities } from "../../apps/controller/src/drivers/egress-proxy/openshell-exchange-capabilities.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { ProtectedExecutionDriver } from "../../apps/controller/src/drivers/compute/protected-execution-driver.ts";

type Fields = Record<string, unknown>;
const digest = (v: string) => createHash("sha256").update(v).digest("hex");

/** The peer supplies decoded responses; the production Driver, revision store, effects,
 * reduction service, and settled-installation reader make every OCE decision. */
export async function jointPolicyJourney(input: {
  controller: OpenClawController;
  reads: () => number;
  originRequests: () => number;
  state: PostgresPlatformState;
  context: ProxyRevisionContext;
  plan: ProxyPlan;
  sandbox: SandboxDriver;
  client: OpenShellGatewayClient;
  priorActive: string;
  remove: "git" | "model";
  lost?: boolean;
}) {
  const { state, sandbox, remove } = input;
  const options = {
    middlewareName: "codex-workspace-pat-with-git-v2",
    repositoryMiddlewareName: "fixture-repository",
    authorityScope: "execution",
  } as const;
  const revisionId = "rev_" + randomUUID();
  const execution = { ...input.plan.execution, revisionId, executionId: revisionId };
  const grant = {
    id: input.plan.repositoryGit!.bindings[0]!.grant.grantId,
    generation: "7",
    scope: digest("installation-scope"),
  };
  const key = randomBytes(32);
  const successorKey = randomBytes(32);
  const boxId = randomUUID();
  const process = randomUUID();
  const instance = randomUUID();
  const runtime = "oce-runtime-1234567890abcdef";
  const files = "_provider_" + runtime.replaceAll("-", "_");
  const legs = ["github.com", "api.github.com"].map((host, i) => ({
    host,
    provider_name: "p" + i,
    rule_name: "_provider_p" + i,
    provider_id: "provider-" + i,
    attachment_epoch: "initial",
    rule_digest: digest(host),
  }));
  const provision = {
    runtimeProvider: runtime,
    grant,
    recipients: legs.map((r) => ({
      host: r.host,
      providerName: r.provider_name,
      providerId: r.provider_id,
      attachmentEpoch: r.attachment_epoch,
    })),
  };
  let providers = [runtime, ...legs.map((r) => r.provider_name)];
  let reportedProviders: string[] | undefined;
  const conflictingProviders = () =>
    remove === "git"
      ? [...providers, legs[0]!.provider_name]
      : providers.filter((p) => p !== legs[1]!.provider_name);
  type Conflict = "session key" | "provider revision" | "attachment epoch";
  let conflict: Conflict | undefined;
  const conflicts: Conflict[] =
    remove === "git"
      ? ["attachment epoch"]
      : ["session key", "provider revision", "attachment epoch"];
  let resource = 1;
  let epoch = "initial";
  let version = 1;
  let source: Fields = {};
  let reply: Fields = {};
  let verified = false;
  const effects: string[] = [];
  const receipts = new Map<string, OpenShellSandboxProviderStatus>();
  const enforcement = () => ({
    instance_id: instance,
    sandbox_id: boxId,
    policy_version: version,
    policy_hash: remove === "git" && version === 2 ? digest("model") : digest("policy-" + version),
    config_revision: String(version),
    provider_env_revision: remove === "git" && version === 2 ? "3" : "1",
    enforced_capabilities: openShellExchangeCapabilities,
  });
  const reg = (name: string, identity: string, caps: readonly string[]) => ({
    configured_name: name,
    implementation_name: identity,
    implementation_version: "1",
    protocol_major: 1,
    kind: 4,
    required_capabilities: caps,
    supported_capabilities: caps,
  });
  const client = new Proxy(input.client, {
    get(target, prop) {
      const value = Reflect.get(overrides, prop) ?? Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const overrides: Partial<OpenShellGatewayClient> = {
    async getGatewayInfo() {
      return {
        extensions: [
          reg(options.middlewareName, "oce/static-egress", openShellExchangeCapabilities),
          reg(options.repositoryMiddlewareName, "oce/online-request-authorization", [
            "openshell.supervisor-middleware.contract",
          ]),
        ],
      };
    },
    async getSandbox() {
      return {
        id: boxId,
        name: "box",
        resourceVersion: String(resource),
        mainProcessInstanceId: process,
        annotations: {
          "openclaw.dev/namespace-id": execution.namespaceId,
          "openclaw.dev/agent-id": execution.agentId,
          "openclaw.dev/revision-id": revisionId,
        },
        labels: {},
        serviceUrls: {},
        spec: {
          providers: reportedProviders ?? providers,
          provider_attachment_epoch: conflict === "attachment epoch" ? "other-epoch" : epoch,
        },
      };
    },
    async getSandboxPolicyStatus() {
      return { active_version: version, revision: { status: 2, version, policy: source } };
    },
    async advanceJointReduction(_w, _n, cmd) {
      if (!cmd) {
        const current = asRecord(reply.current);
        if (current && conflict === "session key") {
          return { ...reply, current: { ...current, public_key: successorKey } };
        }
        if (current && conflict === "provider revision") {
          const last = asRecord(reply.last_result)!;
          const command = asRecord(last.command)!;
          const enforcement = { ...asRecord(current.enforcement), provider_env_revision: "123" };
          return {
            ...reply,
            current: { ...current, enforcement },
            last_result: { ...last, command: { ...command, enforcement } },
          };
        }
        return reply;
      }
      effects.push(String(cmd.action));
      switch (cmd.action) {
        case "admit": {
          assert.equal(reply.last_result, undefined);
          const { action: _a, ...current } = cmd;
          reply = {
            current,
            last_result: { command: cmd, applied: true },
            credential_installed: true,
            joint_authority_verified: true,
          };
          break;
        }
        case "fence-git":
        case "fence-model": {
          assert.equal(verified, true);
          const result = {
            command: { ...cmd, challenge: randomBytes(32) },
            applied: true,
            receipt: randomBytes(64),
          };
          reply = { fence: result, last_result: result };
          break;
        }
        case "successor":
        case "retain-git": {
          const fence = asRecord(reply.fence)!;
          assert.deepEqual(cmd.fence_receipt, fence.receipt);
          assert.deepEqual(cmd.detach_receipt_ids, [...receipts.keys()]);
          assert.equal(version, 2);
          assert.equal(cmd.challenge, undefined);
          const {
            action: _a,
            operation_id: _o,
            detach_receipt_ids: _d,
            fence_receipt: _r,
            ...other
          } = cmd;
          // The separate GetSandbox read contradicts this applied supervisor result.
          reportedProviders = conflictingProviders();
          const model = cmd.action === "successor";
          const current = {
            ...other,
            public_key: model ? successorKey : key,
            enforcement: enforcement(),
          };
          const last = {
            command: {
              ...cmd,
              enforcement: enforcement(),
              ...(model && { challenge: randomBytes(32) }),
            },
            applied: true,
            ...(model && { public_key: successorKey, signature: randomBytes(64) }),
          };
          reply = {
            fence,
            last_result: last,
            current,
            credential_installed: model,
            joint_authority_verified: true,
          };
          break;
        }
        default:
          assert.fail("unexpected joint mutation");
      }
      return {};
    },
    async detachSandboxProvider(workspace, _name, provider, _signal, conditional) {
      assert.equal(conditional?.expectedResourceVersion, String(resource));
      assert.ok(providers.includes(provider));
      effects.push("detach:" + provider);
      const old = epoch;
      epoch = randomUUID();
      resource++;
      const id = randomUUID();
      const leg = legs.find((r) => r.provider_name === provider)!;
      receipts.set(id, {
        state: "PROVIDER_READINESS_STATE_READY",
        receipt: {
          provider,
          workspace,
          receiptId: id,
          kind: "PROVIDER_MUTATION_KIND_DETACH",
          mutationId: epoch,
          detachedFrom: { sandboxId: boxId, providerId: leg.provider_id, attachmentEpoch: old },
          desired: {
            sandboxId: boxId,
            sandbox: "box",
            attachmentEpoch: epoch,
            providerId: "",
            providerResourceVersion: "0",
            providerEnvRevision: "2",
            configRevision: "2",
            policyHash: digest(provider),
          },
        },
      });
      providers = providers.filter((p) => p !== provider);
      if (input.lost) {
        throw Error("detach acknowledgement lost");
      }
      return { detached: true, receiptId: id };
    },
    async getSandboxProviderStatus(_w, _n, _p, _signal, id) {
      return receipts.get(id!)!;
    },
    async updatePolicy(req) {
      assert.equal(req.expectedResourceVersion, String(resource));
      effects.push("policy");
      source = req.policy;
      version++;
      resource++;
    },
  };
  const backend = createOpenShellBackend(
    {
      type: "openshell",
      id: "openshell-test",
      drivers: {
        sandbox: sandbox.id,
        credential_gateway: "fixture-credentials",
        credential_proxy: input.plan.egressDriverId,
      },
      configuration: { endpoint: "https://localhost:1" },
    },
    { gatewayClient: client },
  );
  const make = () => {
    const driver = new OpenShellCredentialProxyDriver(options, {
      id: input.plan.egressDriverId,
      backend,
      sandbox,
      exchangeAuthority: {
        host: "127.0.0.1",
        port: 1,
        certificatePath: "fixture",
        privateKeyPath: "fixture",
        issuerPublicKeyPath: "fixture",
        issuer: "fixture",
        audience: "fixture",
        keyId: "fixture",
      },
      bindRepositoryGit: async () => {
        throw Error("unused fixture port");
      },
    });
    return new InstalledDriver(
      { id: sandbox.id, implementation: "openshell", configuration: options },
      { capabilities: { sandbox, credential_proxy: driver } },
      { sandbox: sandbox.id, credential_proxy: driver.id },
    );
  };
  const owner = make();
  const plan = {
    ...input.plan,
    driver: owner.ref,
    execution,
    routes: input.plan.routes.map((r) => ({ ...r, binding: { ...r.binding, execution } })),
  };
  const { namespaceId, agentId } = execution;
  const revision = {
    ...input.context.revision,
    id: revisionId,
    revision: input.context.revision.revision + (input.lost ? 3 : remove === "git" ? 1 : 2),
    executionAdmission: { version: 8, mode: "protected" } as const,
    egressPlan: plan,
    repositoryCredentials: plan.repositoryGit!,
  };
  const ctx = {
    ...input.context,
    revision,
    plan,
    policyEffects: revisionPolicyEffects(state, namespaceId, revisionId),
    currentGitGrant: () => grant,
    jointAdmissionCurrent: async (g: typeof grant) =>
      g.id === grant.id && g.scope === grant.scope && g.generation === grant.generation,
  };
  const binding = plan.repositoryGit!.bindings[0]!;
  const admissionId = randomUUID();
  const createdAt = new Date().toISOString();
  const sourceId = plan.routes[0]!.binding.source.source.id;
  await state.transact(async (u) => {
    await u.agents.updateConfiguration(
      namespaceId,
      agentId,
      revision.configurationId,
      undefined,
      undefined,
      undefined,
      undefined,
      [{ repositoryRef: binding.repositoryRef, profile: binding.profile }],
    );
    await u.revisions.createRevision(revision);
    assert.ok(
      await u.agents.compareAndSetActiveRevision(
        namespaceId,
        agentId,
        input.priorActive,
        revisionId,
      ),
    );
    await u.repositorySessions.createAttempt({
      namespaceId,
      agentId,
      revisionId,
      admissionId,
      repositoryRef: binding.repositoryRef,
      durationSeconds: 60,
      deadlineWallMs: plan.repositoryGit!.deadlineWallMs,
      createdAt,
      brokerProtocol: 2,
    });
    await u.repositorySessions.advanceAttempt({
      admissionId,
      expectedPhase: "opening",
      phase: "open",
      sessionId: randomUUID(),
      updatedAt: createdAt,
    });
  });
  source = { ...openShellEgressConfiguration(plan, options), process: { run_as_user: "fixture" } };
  const binaries = [
    "/usr/bin/git",
    "/usr/lib/git-core/git-remote-https",
    "/usr/lib/git-core/git-remote-http",
    "/usr/libexec/git-core/git-remote-https",
    "/usr/libexec/git-core/git-remote-http",
    "/usr/bin/curl",
    "/usr/local/bin/node",
    "/usr/bin/node",
    "/usr/bin/gh",
    "/usr/local/bin/gh",
  ].map((path) => ({ path }));
  const providerRules = Object.fromEntries(
    legs.map((r, i) => [
      r.rule_name,
      {
        name: r.rule_name,
        binaries,
        endpoints: [
          {
            host: r.host,
            port: 443,
            protocol: "rest",
            path: "/**",
            enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
            access: i ? "NETWORK_ACCESS_PRESET_FULL" : "NETWORK_ACCESS_PRESET_READ_WRITE",
            provider_credentialed: true,
            token_grant_owner: "grant-owner:v1:" + digest(r.host),
          },
        ],
      },
    ]),
  );
  const policy = {
    profile: options.middlewareName,
    model_policy_hash: digest("model"),
    git: legs,
    effective_policy: {
      ...source,
      network_policies: {
        ...asRecord(source.network_policies),
        ...providerRules,
        [files]: { name: files },
      },
    },
  };
  reply = {
    credential_installed: true,
    current: {
      session_id: "session",
      session_expires_at_unix_seconds: String(Math.floor(Date.now() / 1000) + 3600),
      public_key: key,
      enforcement: enforcement(),
      policy,
    },
  };
  const wiring = { plan, configuration: source, jointGit: provision };
  // The Git profile selects a single TLS port. Extra ports in the compiled rule
  // must not acquire an admission even when the singular port is still correct.
  const recipientEndpoint = providerRules[legs[0]!.rule_name]!.endpoints[0]!;
  Object.assign(recipientEndpoint, { ports: [443, 8443] });
  assert.equal(await owner.require("credential_proxy").wiringStatus(ctx, wiring), undefined);
  assert.deepEqual(effects, []);
  Reflect.deleteProperty(recipientEndpoint, "ports");
  assert.equal(await owner.require("credential_proxy").wiringStatus(ctx, wiring), undefined);
  assert.deepEqual(effects, ["admit"]);
  const installed = await new ProtectedExecutionDriver(make()).observe(ctx, wiring);
  assert.ok(
    installed,
    "must adopt the original confirmed admission after restarting the controller",
  );
  await state.transact(async (u) => {
    await u.credentialSources.recordEgressInstallation(installed);
    if (remove === "git") {
      await u.repositorySessions.advanceAttempt({
        admissionId,
        expectedPhase: "open",
        phase: "closing",
        updatedAt: createdAt,
      });
      await u.repositorySessions.advanceAttempt({
        admissionId,
        expectedPhase: "closing",
        phase: "disposed",
        updatedAt: createdAt,
      });
    } else {
      await u.credentialSources.requestCredentialWithdrawal({
        namespaceId,
        agentId,
        revisionId,
        credentialSourceId: sourceId,
        requestedBy: revision.servicePrincipalId,
        state: "pending",
        requestedAt: createdAt,
      });
    }
  });
  verified = true;
  const reduce = () =>
    withPool(databaseUrl, async (pool: PostgresPool) => {
      const cold = new PostgresPlatformState(pool);
      return reduceCredentialPolicy(
        cold,
        make(),
        { ...ctx, policyEffects: revisionPolicyEffects(cold, namespaceId, revisionId) },
        remove === "git" ? undefined : sourceId,
      );
    });
  if (input.lost) {
    await assert.rejects(reduce(), /acknowledgement lost/);
    assert.equal(await reduce(), "pending");
    assert.deepEqual(effects, ["admit", "fence-git", "detach:p0"]);
    assert.equal(
      (
        await state.read((u) =>
          u.credentialSources.findRevisionEgressInstallation(namespaceId, revisionId),
        )
      )?.plan.generation,
      1,
    );
    return revisionId;
  }
  const expectedEffects =
    remove === "git"
      ? ["admit", "fence-git", "detach:p0", "detach:p1", "policy", "successor"]
      : ["admit", "fence-model", "policy", "retain-git"];
  for (let step = 0; step < expectedEffects.length && !reportedProviders; step++) {
    assert.equal(await reduce(), "pending", "contradictory Sandbox attachments cannot settle");
  }
  assert.deepEqual(effects, expectedEffects);
  assert.equal(await reduce(), "pending");
  await state.read(async (u) => {
    const saved = await u.credentialSources.findRevisionEgressInstallation(namespaceId, revisionId);
    const reductions = await u.credentialSources.listCredentialPolicyReductions(
      namespaceId,
      revisionId,
    );
    assert.equal(saved?.plan.generation, 1);
    assert.equal(reductions.length, 1);
    assert.equal(reductions[0]!.observed, undefined);
  });
  reportedProviders = undefined;
  for (conflict of conflicts) {
    assert.equal(await reduce(), "pending", "conflicting " + conflict + " cannot settle");
    await state.read(async (u) => {
      const saved = await u.credentialSources.findRevisionEgressInstallation(
        namespaceId,
        revisionId,
      );
      assert.equal(saved?.plan.generation, 1);
      const [operation] = await u.credentialSources.listCredentialPolicyReductions(
        namespaceId,
        revisionId,
      );
      assert.ok(operation);
      assert.equal(operation.observed, undefined);
    });
  }
  conflict = undefined;
  assert.equal(await reduce(), "withdrawn");
  assert.deepEqual(effects, expectedEffects, "a cold observer must not repeat a mutation");
  const saved = await state.read((u) =>
    u.credentialSources.findRevisionEgressInstallation(namespaceId, revisionId),
  );
  assert.ok(saved);
  assert.equal(saved.plan.generation, 2);
  const check = () =>
    owner.require("credential_proxy").verifyInstallation({ ...ctx, plan: saved.plan }, saved);
  assert.equal(await check(), true);
  for (conflict of conflicts) {
    assert.equal(await check(), false, "ordinary use must reject a conflicting " + conflict);
    assert.equal(
      await reduce(),
      "pending",
      "a cold observer must reject a conflicting " + conflict,
    );
  }
  conflict = undefined;
  assert.equal(await check(), true);
  assert.equal(await reduce(), "withdrawn");
  assert.deepEqual(effects, expectedEffects);
  const app = new OpenClawController(input.controller.installation, {
    state,
    driverConfigurations: [
      {
        capability: "sandbox",
        driverId: sandbox.id,
        implementation: "openshell",
        definition: OpenShellSandboxDriver,
      },
    ],
  });
  for (const cap of ["iam", "secret", "compute"] as const) {
    const driver = input.controller.selectedDriver(cap);
    app.registerDriver(driver);
    app.selectDriver(cap, driver.id);
  }
  app.installDriver(owner, ["sandbox", "credential_proxy"]);
  const expiresAt = new Date(Date.now() + 60000).toISOString();
  const exchangeId = randomUUID();
  const peerToken = randomUUID();
  const associations = new Map<string, AcceptedEgressAssociation>();
  const exchange = app.createCredentialProxy({
    async verify(token) {
      return token === peerToken
        ? {
            sender: saved.sender,
            sandboxId: boxId,
            instanceId: instance,
            peerKeyId: successorKey.toString("base64url"),
            exchangeId,
            expiresAt,
          }
        : undefined;
    },
    capture(use) {
      const association = {
        execution: use.route.binding.execution,
        installation: egressAssociationInstallation(use.installation),
        exchangeId,
        custodyId: randomUUID(),
        responseId: randomUUID(),
      };
      associations.set(use.id, association);
      return association;
    },
    owns(association, use) {
      return isDeepStrictEqual(associations.get(use.id), association);
    },
  });
  const request = () => ({
    id: requestId(),
    method: "POST",
    url: "https://chatgpt.com/backend-api/codex/responses",
    headers: [
      ["content-type", "application/json"],
      ["chatgpt-account-id", "synthetic-workspace"],
    ] as [string, string][],
    body: Buffer.from(
      JSON.stringify({ model: "fixture-model", input: "retained conversation", store: false }),
    ),
    deadlineAt: new Date(Date.now() + 20000).toISOString(),
    verifiedExecutionPolicyHash: saved.enforcement.policyHash,
  });
  if (remove === "git") {
    const resolve = async (req: ReturnType<typeof request>) => {
      const result = await exchange.resolve(peerToken, boxId, req, ctx.signal);
      assert.ok(result.kind === "ready", "the retained model turn must obtain a fresh credential");
      return result;
    };
    const send = async (
      req: ReturnType<typeof request>,
      resolved: Awaited<ReturnType<typeof resolve>>,
    ) => {
      const decision = await exchange.authorizeSend(
        peerToken,
        boxId,
        req.id,
        resolved.handle,
        resolved.evidence,
        resolved.injectionDigest,
        req.deadlineAt,
        ctx.signal,
      );
      if (decision.kind === "refused") {
        return undefined;
      }
      return new Promise<Buffer>((resolve, reject) => {
        const post = httpsRequest(
          req.url,
          { method: "POST", headers: Object.fromEntries([...req.headers, ...resolved.headers]) },
          async (r) => {
            try {
              resolve(await buffer(r));
            } catch (e) {
              reject(e);
            }
          },
        );
        post.on("error", reject).end(req.body);
      });
    };
    const before = input.originRequests();
    const interrupted = request();
    const ready = await resolve(interrupted);
    conflict = "attachment epoch";
    assert.equal((await exchange.resolve(peerToken, boxId, request(), ctx.signal)).kind, "refused");
    assert.equal(await send(interrupted, ready), undefined);
    assert.equal(input.originRequests(), before);
    conflict = undefined;
    const req = request();
    const resolved = await resolve(req);
    const response = await send(req, resolved);
    assert.ok(response);
    assert.equal(input.originRequests(), before + 1);
    assert.equal(await exchange.beginResponse(peerToken, boxId, req.id), resolved.handle);
    assert.equal(
      (
        await exchange.protectResponse(
          resolved.handle,
          {
            status: 200,
            headers: [["content-type", "application/json"]],
            body: response,
            trailers: [],
          },
          ctx.signal,
        )
      )?.status,
      200,
    );
  }
  reportedProviders = conflictingProviders();
  assert.equal(await check(), false);
  assert.equal(await reduce(), "pending", "a settled receipt cannot override current attachments");
  const readsBefore = input.reads();
  assert.equal((await exchange.resolve(peerToken, boxId, request(), ctx.signal)).kind, "refused");
  assert.equal(input.reads(), readsBefore);
  assert.deepEqual(effects, expectedEffects);
  reportedProviders = undefined;
  source = { ...source, process: { run_as_user: "conflicting-user" } };
  const before = input.reads();
  assert.equal((await exchange.resolve(peerToken, boxId, request(), ctx.signal)).kind, "refused");
  assert.equal(input.reads(), before, "a failed use must never reach the credential");
  assert.equal(
    await check(),
    false,
    "use must reconcile the independently loaded source after settlement",
  );
  assert.equal(await reduce(), "pending", "settlement must reject the same contradiction");
  return revisionId;
}
