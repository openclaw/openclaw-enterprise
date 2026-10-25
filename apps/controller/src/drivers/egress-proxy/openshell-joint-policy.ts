import { createHash } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import type {
  CredentialPolicyReduction,
  CredentialPolicyObservation,
  EgressInstallation,
  JointGrantIdentity,
  JointGitProvision,
  JointPolicyCondition,
  ProxyPlan,
  ProxyRevisionContext,
} from "@openclaw-enterprise/contracts";
import { asRecord, sha256Hex } from "@openclaw-enterprise/utils";
import type { OpenShellSandboxResponse } from "../sandbox/openshell-gateway-client.ts";
import {
  jointWorkspaceProfile,
  openShellExchangeCapabilities,
} from "./openshell-exchange-capabilities.ts";
import { wirePolicy } from "./openshell-wire-policy.ts";

type Fields = Readonly<Record<string, unknown>>;
type Joint = {
  readonly sessionId: string;
  readonly sessionExpiresAt: string;
  readonly processInstanceId: string;
  readonly sourcePolicyHash: string;
  readonly effectivePolicy: Fields;
  readonly recipients: readonly {
    readonly host: string;
    readonly provider_id: string;
    readonly attachment_epoch: string;
    readonly rule_name: string;
    readonly rule_digest: string;
    readonly provider_name: string;
  }[];
  readonly configRevision: string;
  readonly providerEnvRevision: string;
};
const hash = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const uint = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]*$/.test(v);
const nonempty = (s: unknown): s is string => typeof s === "string" && s.length > 0;
const rawKey = (v: unknown) =>
  v instanceof Uint8Array && v.byteLength === 32 ? Buffer.from(v).toString("base64url") : undefined;
const policyEqual = (a: unknown, b: unknown) => same(wirePolicy(a), wirePolicy(b));
const hosts = ["github.com", "api.github.com"] as const;

function recipients(p: Fields): Joint["recipients"] | undefined {
  if (!Array.isArray(p.git) || p.git.length !== 2) {
    return;
  }
  const legs: Joint["recipients"][number][] = [];
  for (const [i, item] of p.git.entries()) {
    const r = asRecord(item);
    if (
      !r ||
      r.host !== hosts[i] ||
      !nonempty(r.provider_name) ||
      !nonempty(r.provider_id) ||
      !nonempty(r.attachment_epoch) ||
      !hash(r.rule_digest) ||
      r.rule_name !== "_provider_" + r.provider_name.replaceAll("-", "_")
    ) {
      return;
    }
    legs.push({
      host: hosts[i]!,
      provider_name: r.provider_name,
      provider_id: r.provider_id,
      attachment_epoch: r.attachment_epoch,
      rule_digest: r.rule_digest,
      rule_name: String(r.rule_name),
    });
  }
  if (legs[0]!.provider_id === legs[1]!.provider_id || legs[0]!.rule_name === legs[1]!.rule_name) {
    return;
  }
  return legs;
}

function hasJointProviders(
  sandbox: OpenShellSandboxResponse,
  plan: ProxyPlan,
  runtime: string | undefined,
  legs: Joint["recipients"],
) {
  return (
    nonempty(runtime) &&
    same(sandbox.spec?.providers, [
      runtime,
      ...(plan.repositoryGit ? legs.map((r) => r.provider_name) : []),
    ])
  );
}

function ownerEvidence(enforcement: EgressInstallation["enforcement"]) {
  const j = enforcement.joint;
  const o = j?.ownerEvidence;
  if (
    !j ||
    !o ||
    !nonempty(o.sessionId) ||
    !uint(o.sessionExpiresAt) ||
    !nonempty(o.processInstanceId) ||
    !hash(o.sourcePolicyHash) ||
    !uint(o.configRevision) ||
    !uint(o.providerEnvRevision)
  ) {
    return;
  }
  const effectivePolicy = asRecord(o.effectivePolicy);
  const legs = recipients({ git: o.recipients });
  if (!effectivePolicy || !legs) {
    return;
  }
  return {
    ...(nonempty(o.runtimeProvider) && { runtimeProvider: o.runtimeProvider }),
    sessionId: o.sessionId,
    sessionExpiresAt: o.sessionExpiresAt,
    processInstanceId: o.processInstanceId,
    sourcePolicyHash: o.sourcePolicyHash,
    configRevision: o.configRevision,
    providerEnvRevision: o.providerEnvRevision,
    effectivePolicy,
    recipients: legs,
    model: j.model,
    git: j.git,
  };
}

// The authenticated Gateway validates the fence signature, successor proof and native
// detach receipts. Pin those same receipts on OCE's durable final observation.
function withdrawalReceipts(reply: Fields | undefined) {
  const fence = asRecord(reply?.fence);
  const f = asRecord(fence?.command);
  const last = asRecord(reply?.last_result);
  const c = asRecord(last?.command);
  if (
    !f ||
    !c ||
    !nonempty(f.operation_id) ||
    f.operation_id !== c.operation_id ||
    fence?.applied !== true ||
    last?.applied !== true ||
    !(fence.receipt instanceof Uint8Array) ||
    fence.receipt.length !== 64 ||
    !same(c.fence_receipt, fence.receipt)
  ) {
    return;
  }
  return {
    operationId: f.operation_id,
    action: c.action,
    predecessorKey: rawKey(f.public_key),
    fenceReceipt: Buffer.from(fence.receipt).toString("base64url"),
    detachReceiptIds: c.detach_receipt_ids ?? [],
  };
}
function identities(
  plan: ProxyPlan,
  process: string,
  sandbox: string,
  legs: Joint["recipients"],
  gitAuthority: JointGitProvision["grant"] | undefined,
) {
  const model = plan.routes[0]?.binding;
  const repo = plan.repositoryGit;
  const git = repo?.bindings[0];
  if (
    !gitAuthority ||
    !uint(gitAuthority.generation) ||
    !nonempty(gitAuthority.scope) ||
    gitAuthority.id !== git?.grant.grantId ||
    !repo ||
    repo.bindings.length !== 1 ||
    git?.profile !== "github-installation" ||
    !model ||
    model.grant.kind !== "workspace_inference" ||
    plan.generation !== 1
  ) {
    return;
  }
  // The prepared Git owner supplies its independent grant version and scope.
  const recipient = [plan.execution.executionId, sandbox, process];
  return {
    model: {
      id: model.binding.id,
      generation: String(model.binding.generation),
      scope: model.grantHash,
      recipient: sha256Hex(JSON.stringify(recipient)),
    },
    git: {
      id: git.grant.grantId,
      generation: gitAuthority.generation,
      scope: gitAuthority.scope,
      recipient: sha256Hex(
        JSON.stringify([
          ...recipient,
          ...legs.map((r) => [r.host, r.provider_id, r.attachment_epoch, r.rule_digest]),
        ]),
      ),
    },
  } satisfies Record<"model" | "git", JointGrantIdentity>;
}

// Source status excludes the provider rules that the authenticated supervisor derives.
// Remove only the two recorded rules and the exact files-only provider's empty rule.
export function jointSourcePolicy(effective: Fields, legs: Joint["recipients"], runtime?: string) {
  const rules = asRecord(effective.network_policies);
  if (!rules) {
    return;
  }
  const generated = new Set(legs.map((r) => r.rule_name));
  if (runtime) {
    const name = "_provider_" + runtime.replaceAll("-", "_");
    if (generated.has(name) || !policyEqual(rules[name], { name })) {
      return;
    }
    generated.add(name);
  }
  return {
    ...effective,
    network_policies: Object.fromEntries(Object.entries(rules).filter(([n]) => !generated.has(n))),
  };
}

/** Readiness is authenticated by the scoped Gateway RPC and its current supervisor.
 * A historical result or a pending command does not authenticate the current key.
 * The OCE-side comparison preserves every source policy field, including auxiliary rules. */
export function readJointEnforcement(
  context: ProxyRevisionContext,
  existing: OpenShellSandboxResponse,
  status: Fields,
  response: Fields | undefined,
  source?: Fields,
  previous?: EgressInstallation,
  provision?: JointGitProvision,
  purpose: "installed" | "prepare-admit" = "installed",
): EgressInstallation["enforcement"] | undefined {
  const cmd = asRecord(response?.current);
  const e = asRecord(cmd?.enforcement);
  const pol = asRecord(cmd?.policy);
  const effective = asRecord(pol?.effective_policy);
  const revision = asRecord(status.revision);
  const key = rawKey(cmd?.public_key);
  const sandbox = existing.id;
  const process = existing.mainProcessInstanceId;
  if (
    (purpose === "installed"
      ? response?.joint_authority_verified !== true
      : response?.joint_authority_verified === true ||
        response?.last_result ||
        response?.fence ||
        previous) ||
    !cmd ||
    !uint(cmd.session_expires_at_unix_seconds) ||
    BigInt(cmd.session_expires_at_unix_seconds) <= BigInt(Math.floor(Date.now() / 1000)) ||
    cmd.action ||
    cmd.operation_id ||
    !pol ||
    !e ||
    !effective ||
    !sandbox ||
    !process ||
    response?.pending ||
    !nonempty(cmd.session_id) ||
    pol.profile !== jointWorkspaceProfile ||
    !hash(pol.model_policy_hash) ||
    !hash(e.policy_hash) ||
    !nonempty(e.instance_id) ||
    e.sandbox_id !== sandbox ||
    e.policy_version !== context.plan.generation ||
    status.active_version !== e.policy_version ||
    revision?.version !== e.policy_version ||
    ![2, "POLICY_STATUS_LOADED"].includes(revision.status as string | number) ||
    !uint(e.config_revision) ||
    !uint(e.provider_env_revision) ||
    !same(e.enforced_capabilities, openShellExchangeCapabilities)
  ) {
    return;
  }
  const legs = recipients(pol);
  if (!legs) {
    return;
  }
  const stored = previous?.enforcement.joint;
  const runtime =
    provision?.runtimeProvider ??
    (previous && ownerEvidence(previous.enforcement)?.runtimeProvider);
  if (
    !previous &&
    (!provision ||
      !same(
        provision.recipients,
        legs.map((r) => ({
          host: r.host,
          providerName: r.provider_name,
          providerId: r.provider_id,
          attachmentEpoch: r.attachment_epoch,
        })),
      ))
  ) {
    return;
  }
  const grants = identities(
    context.revision.egressPlan!,
    process,
    sandbox,
    legs,
    provision?.grant ?? stored?.git,
  );
  if (
    !grants ||
    (purpose === "installed"
      ? !same(cmd.model_grant, grants.model) || !same(cmd.git_grant, grants.git)
      : cmd.model_grant || cmd.git_grant)
  ) {
    return;
  }
  const joint = {
    ...(runtime && { runtimeProvider: runtime }),
    sessionId: cmd.session_id,
    sessionExpiresAt: cmd.session_expires_at_unix_seconds,
    processInstanceId: process,
    ...grants,
    sourcePolicyHash: pol.model_policy_hash,
    effectivePolicy: effective,
    recipients: legs,
    configRevision: e.config_revision,
    providerEnvRevision: e.provider_env_revision,
  };
  const derivedSource = jointSourcePolicy(effective, legs, runtime);
  if (
    !hasJointProviders(existing, context.plan, runtime, legs) ||
    !derivedSource ||
    !asRecord(revision.policy) ||
    !policyEqual(derivedSource, revision.policy)
  ) {
    return;
  }
  if (previous) {
    const recorded = previous.enforcement.joint?.ownerEvidence.withdrawal;
    if (
      context.plan.generation === 1
        ? response?.fence !== undefined
        : !recorded || !same(recorded, withdrawalReceipts(response))
    ) {
      return;
    }
    if (
      !same(joint, ownerEvidence(previous.enforcement)) ||
      e.policy_hash !== previous.enforcement.policyHash ||
      e.instance_id !== previous.enforcement.instanceId ||
      !policyEqual(effective, previous.enforcement.joint?.ownerEvidence.effectivePolicy) ||
      (context.plan.routes.length
        ? response?.credential_installed !== true || previous.enforcement.peerKeyId !== key
        : response?.credential_installed === true || previous.enforcement.peerKeyId !== undefined)
    ) {
      return;
    }
    return previous.enforcement;
  }
  if (
    !source ||
    context.plan.generation !== 1 ||
    response?.fence ||
    !key ||
    response?.credential_installed !== true ||
    !policyEqual(source, revision.policy)
  ) {
    return;
  }
  const sourceRules = asRecord(source.network_policies);
  const rules = asRecord(effective.network_policies);
  if (!rules || !sourceRules) {
    return;
  }
  const gitRules: Record<string, unknown> = {};
  for (const leg of legs) {
    const rule = asRecord(rules[leg.rule_name]);
    if (
      Object.hasOwn(sourceRules, leg.rule_name) ||
      !rule ||
      rule.name !== leg.rule_name ||
      !Array.isArray(rule.endpoints) ||
      rule.endpoints.length !== 1 ||
      !Array.isArray(rule.binaries) ||
      !rule.binaries.length
    ) {
      return;
    }
    const endpoint = asRecord(rule.endpoints[0]);
    // Only the profiled Basic and required Bearer provider rules are possible on the
    // authenticated supplier RPC. Rebuild their complete local transport envelope.
    const binaryPaths = [
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
    ];
    if (
      !nonempty(endpoint?.token_grant_owner) ||
      !/^grant-owner:v1:[a-f0-9]{64}$/.test(endpoint.token_grant_owner)
    ) {
      return;
    }
    const wanted = {
      name: leg.rule_name,
      binaries: binaryPaths.map((path) => ({ path })),
      endpoints: [
        {
          host: leg.host,
          port: 443,
          protocol: "rest",
          path: "/**",
          enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
          access:
            leg.host === "github.com"
              ? "NETWORK_ACCESS_PRESET_READ_WRITE"
              : "NETWORK_ACCESS_PRESET_FULL",
          provider_credentialed: true,
          token_grant_owner: endpoint.token_grant_owner,
        },
      ],
    };
    if (!policyEqual(rule, wanted)) {
      return;
    }
    gitRules[leg.rule_name] = wanted;
  }
  const filesRule = "_provider_" + runtime!.replaceAll("-", "_");
  if (
    Object.hasOwn(sourceRules, filesRule) ||
    !policyEqual(effective, {
      ...source,
      network_policies: { ...sourceRules, ...gitRules, [filesRule]: { name: filesRule } },
    })
  ) {
    return;
  }
  const { model, git, ...owner } = joint;
  return {
    joint: { model, git, ownerEvidence: owner },
    instanceId: e.instance_id,
    authorityScope: "execution",
    policyHash: e.policy_hash,
    configurationId: sha256Hex(
      JSON.stringify([
        cmd.session_id,
        e.policy_hash,
        e.config_revision,
        e.provider_env_revision,
        legs,
      ]),
    ),
    peerKeyId: key,
    repositoryGitRecipient: {
      providerId: legs[0]!.provider_id,
      attachmentEpoch: legs[0]!.attachment_epoch,
      networkInstanceId: e.instance_id,
      processInstanceId: process,
      deliveryProfile: "github_installation",
      authorization: "online-request",
    },
  };
}

export function jointCondition(
  old: EgressInstallation,
  next: ProxyPlan,
): JointPolicyCondition | undefined {
  const joint = ownerEvidence(old.enforcement);
  const key = old.enforcement.peerKeyId;
  if (
    !joint ||
    !key ||
    !old.plan.repositoryGit ||
    next.generation !== old.plan.generation + 1 ||
    !!next.repositoryGit === next.routes.length > 0
  ) {
    return;
  }
  const rules = asRecord(joint.effectivePolicy.network_policies);
  const middlewares = asRecord(joint.effectivePolicy.network_middlewares);
  if (!rules || !middlewares || !joint.recipients.every((r) => Object.hasOwn(rules, r.rule_name))) {
    return;
  }
  const removed = new Set(
    next.repositoryGit
      ? old.plan.routes.map((_r, i) => "oce-egress-" + i)
      : joint.recipients.map((r) => r.rule_name),
  );
  const authority = next.repositoryGit ? "oce-egress" : "oce-prepared-git";
  if (
    !Object.hasOwn(middlewares, authority) ||
    [...removed].some((n) => !Object.hasOwn(rules, n))
  ) {
    return;
  }
  return {
    predecessorKeySha256: createHash("sha256").update(Buffer.from(key, "base64url")).digest("hex"),
    grant: next.repositoryGit ? joint.git : joint.model,
    remainingPolicy: {
      ...joint.effectivePolicy,
      network_policies: Object.fromEntries(Object.entries(rules).filter(([n]) => !removed.has(n))),
      network_middlewares: Object.fromEntries(
        Object.entries(middlewares).filter(([n]) => n !== authority),
      ),
    },
  };
}

export function sameJointPredecessor(current: Fields, old: EgressInstallation) {
  const j = ownerEvidence(old.enforcement);
  const e = asRecord(current.enforcement);
  const p = asRecord(current.policy);
  return (
    !!j &&
    current.session_id === j.sessionId &&
    current.session_expires_at_unix_seconds === j.sessionExpiresAt &&
    BigInt(j.sessionExpiresAt) > BigInt(Math.floor(Date.now() / 1000)) &&
    rawKey(current.public_key) === old.enforcement.peerKeyId &&
    same(current.model_grant, j.model) &&
    same(current.git_grant, j.git) &&
    e?.sandbox_id === old.sandboxId &&
    e.instance_id === old.enforcement.instanceId &&
    e.policy_version === old.plan.generation &&
    e.policy_hash === old.enforcement.policyHash &&
    e.config_revision === j.configRevision &&
    e.provider_env_revision === j.providerEnvRevision &&
    p?.profile === jointWorkspaceProfile &&
    p.model_policy_hash === j.sourcePolicyHash &&
    same(p.git, j.recipients) &&
    policyEqual(p.effective_policy, j.effectivePolicy)
  );
}

export function jointSuccessor(
  reply: Fields | undefined,
  request: CredentialPolicyReduction,
  sandbox: OpenShellSandboxResponse,
  status: Fields,
): CredentialPolicyObservation | undefined {
  const { expected: old, retained, condition } = request;
  const j = ownerEvidence(old.enforcement);
  const current = asRecord(reply?.current);
  const fence = asRecord(reply?.fence);
  const f = asRecord(fence?.command);
  const result = asRecord(reply?.last_result);
  const command = asRecord(result?.command);
  const e = asRecord(current?.enforcement);
  const policy = asRecord(current?.policy);
  const model = retained.repositoryGit === undefined;
  const revision = asRecord(status.revision);
  const remaining = condition?.remainingPolicy;
  const sourcePolicy =
    remaining && j && jointSourcePolicy(remaining, j.recipients, j.runtimeProvider);
  if (
    reply?.joint_authority_verified !== true ||
    !revision ||
    status.active_version !== retained.generation ||
    revision.version !== retained.generation ||
    ![2, "POLICY_STATUS_LOADED"].includes(revision.status as string | number) ||
    !sourcePolicy ||
    !policyEqual(sourcePolicy, revision.policy) ||
    !condition ||
    !same(condition, jointCondition(old, retained)) ||
    !j ||
    BigInt(j.sessionExpiresAt) <= BigInt(Math.floor(Date.now() / 1000)) ||
    !current ||
    !f ||
    !command ||
    current.action ||
    current.operation_id ||
    !e ||
    !policy ||
    reply?.pending ||
    result?.applied !== true ||
    fence?.applied !== true ||
    sandbox.id !== old.sandboxId ||
    sandbox.mainProcessInstanceId !== j.processInstanceId ||
    !hasJointProviders(sandbox, retained, j.runtimeProvider, j.recipients) ||
    f.operation_id !== request.operationId ||
    command.operation_id !== request.operationId ||
    f.action !== (model ? "fence-git" : "fence-model") ||
    command.action !== (model ? "successor" : "retain-git") ||
    !(fence.receipt instanceof Uint8Array) ||
    fence.receipt.length !== 64 ||
    !same(fence.receipt, command.fence_receipt) ||
    ![f, command, current].every(
      (c) =>
        c.session_id === j.sessionId &&
        c.session_expires_at_unix_seconds === j.sessionExpiresAt &&
        same(c.model_grant, j.model) &&
        same(c.git_grant, j.git),
    ) ||
    ![f, command].every((c) => rawKey(c.public_key) === old.enforcement.peerKeyId) ||
    !sameJointPredecessor(
      { ...f, policy: { ...asRecord(f.policy), effective_policy: j.effectivePolicy } },
      old,
    ) ||
    ![asRecord(f.policy), asRecord(command.policy), policy].every(
      (p) =>
        p?.profile === jointWorkspaceProfile &&
        p.model_policy_hash === j.sourcePolicyHash &&
        same(p.git, j.recipients) &&
        policyEqual(p.effective_policy, condition.remainingPolicy),
    ) ||
    !(f.challenge instanceof Uint8Array) ||
    f.challenge.length !== 32 ||
    (model &&
      (!(command.challenge instanceof Uint8Array) ||
        command.challenge.length !== 32 ||
        same(command.challenge, f.challenge))) ||
    !same(command.enforcement, e) ||
    e.sandbox_id !== old.sandboxId ||
    e.instance_id !== old.enforcement.instanceId ||
    e.policy_version !== retained.generation ||
    !hash(e.policy_hash) ||
    e.policy_hash === old.enforcement.policyHash ||
    (model && e.policy_hash !== j.sourcePolicyHash) ||
    !uint(e.config_revision) ||
    !uint(e.provider_env_revision) ||
    !same(e.enforced_capabilities, openShellExchangeCapabilities)
  ) {
    return;
  }
  const key = rawKey(current.public_key);
  const receipts = command.detach_receipt_ids ?? [];
  if (
    !Array.isArray(receipts) ||
    (model
      ? reply?.credential_installed !== true ||
        !key ||
        key === old.enforcement.peerKeyId ||
        rawKey(result.public_key) !== key ||
        !(result.signature instanceof Uint8Array) ||
        result.signature.length !== 64 ||
        receipts.length !== 2 ||
        !receipts.every(nonempty) ||
        new Set(receipts).size !== 2
      : reply?.credential_installed === true || receipts.length !== 0)
  ) {
    return;
  }
  const { peerKeyId: _oldKey, repositoryGitRecipient: git, ...rest } = old.enforcement;
  return {
    operationId: request.operationId,
    condition,
    installation: {
      ...old,
      plan: retained,
      enforcement: {
        ...rest,
        policyHash: e.policy_hash,
        configurationId: sha256Hex(
          JSON.stringify([
            request.operationId,
            e.policy_hash,
            e.config_revision,
            e.provider_env_revision,
          ]),
        ),
        ...(model ? { peerKeyId: key! } : { repositoryGitRecipient: git! }),
        joint: {
          ...old.enforcement.joint!,
          ownerEvidence: {
            ...old.enforcement.joint!.ownerEvidence,
            withdrawal: withdrawalReceipts(reply),
            effectivePolicy: condition.remainingPolicy,
            configRevision: e.config_revision,
            providerEnvRevision: e.provider_env_revision,
          },
        },
      },
    },
  };
}

/** During a fence the authenticated observation supplies no current authority.
 * Only the original, live, unconsumed fence can authorize the next subtraction. */
export function liveJointFence(reply: Fields | undefined, request: CredentialPolicyReduction) {
  const f = asRecord(reply?.fence);
  const cmd = asRecord(f?.command);
  const old = request.expected;
  const j = ownerEvidence(old.enforcement);
  const condition = request.condition;
  if (
    !j ||
    !condition ||
    !same(condition, jointCondition(old, request.retained)) ||
    !cmd ||
    !f ||
    f.applied !== true ||
    !same(f, reply?.last_result) ||
    reply?.pending ||
    reply?.current ||
    reply?.joint_authority_verified === true ||
    !(f.receipt instanceof Uint8Array) ||
    f.receipt.length !== 64 ||
    cmd.operation_id !== request.operationId ||
    cmd.action !== (request.retained.repositoryGit ? "fence-model" : "fence-git") ||
    !(cmd.challenge instanceof Uint8Array) ||
    cmd.challenge.length !== 32 ||
    !policyEqual(asRecord(cmd.policy)?.effective_policy, condition.remainingPolicy) ||
    !sameJointPredecessor(
      { ...cmd, policy: { ...asRecord(cmd.policy), effective_policy: j.effectivePolicy } },
      old,
    )
  ) {
    return;
  }
  return { cmd, receipt: f.receipt, j, condition };
}
