import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type {
  OpenShellGatewayClient,
  OpenShellProviderDesiredIdentity,
  OpenShellSandboxProviderStatus,
  OpenShellSandboxResponse,
} from "../sandbox/openshell-gateway-client.ts";
import type { OpenShellPreparedGitInstalled as Git } from "./openshell-prepared-git-provider.ts";
import type { OpenShellGitExpiry, OpenShellGitRouteStore } from "./openshell-git-route-store.ts";

export type OpenShellGitExpiryResult = "withdrawn" | "pending" | "retire-runtime";
type Client = Pick<
  OpenShellGatewayClient,
  "getSandbox" | "getProvider" | "getSandboxProviderStatus" | "detachSandboxProvider"
>;

/** The Sandbox Driver supplies the admitted model attachment and reads the actual supervisor Pod. */
export interface OpenShellGitContinuity {
  readonly model: string;
  readonly workload: (sandboxId: string, signal: AbortSignal) => Promise<string | undefined>;
}

const positive = /^[1-9]\d*$/u;
const unspecified = "PROVIDER_READINESS_REASON_UNSPECIFIED";
class Unsafe extends Error {}
function requireIdentity(condition: unknown): asserts condition {
  if (!condition) {
    throw new Unsafe("OpenShell cannot retain this execution after Git expiry.");
  }
}

/** Hash only, never persist the Sandbox spec or Pod. Preserve array order and every other provider. */
function launch(
  box: OpenShellSandboxResponse,
  git: Git,
  owner: OpenShellGitContinuity,
  workload: string | undefined,
  modelId: string,
) {
  const { providers, provider_attachment_epoch: epoch, ...spec } = box.spec ?? {};
  requireIdentity(
    git.credentialState === "active" &&
      git.executionId &&
      git.sandboxId &&
      box.id === git.sandboxId &&
      box.name === git.sandbox &&
      box.workspace === git.workspace &&
      box.annotations["openclaw.dev/revision-id"] === git.executionId &&
      !!workload &&
      !!epoch &&
      [2, "SANDBOX_PHASE_READY"].includes(box.phase as string | number) &&
      (box.restartCount ?? 0) === 0 &&
      [1, "SANDBOX_RESTART_POLICY_NEVER"].includes(spec.restart_policy as string | number) &&
      positive.test(box.resourceVersion ?? "") &&
      !!modelId &&
      modelId !== git.providerId &&
      Array.isArray(providers) &&
      providers.includes(owner.model) &&
      owner.model !== git.provider &&
      providers.every((p) => typeof p === "string" && !!p) &&
      new Set(providers).size === providers.length,
  );
  const present = providers.includes(git.provider);
  requireIdentity(present === (epoch === git.attachmentEpoch));
  const retained = { ...spec, providers: providers.filter((p) => p !== git.provider) };
  const hash = createHash("sha256")
    .update(
      JSON.stringify(
        [
          workload,
          box.id,
          box.name,
          box.workspace,
          box.labels,
          box.annotations,
          retained,
          owner.model,
          modelId,
        ],
        (_, v: unknown) =>
          v && typeof v === "object" && !Array.isArray(v)
            ? Object.fromEntries(
                Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a === b ? 0 : 1)),
              )
            : v,
      ),
    )
    .digest("hex");
  return {
    hash,
    present,
    epoch: String(epoch),
    version: box.resourceVersion!,
    retainedProviders: retained.providers,
  };
}

type Snapshot = Pick<
  OpenShellProviderDesiredIdentity,
  "attachmentEpoch" | "configRevision" | "policyHash" | "providerEnvRevision"
>;
const generation = (s: Snapshot) => [
  s.attachmentEpoch,
  s.configRevision,
  s.policyHash,
  s.providerEnvRevision,
];

/** An exact stock supervisor report. At expiry stock can report the old credentials expired;
 * accept that only before subtracting Git, never as the successful reduced installation. */
function evidence(
  status: OpenShellSandboxProviderStatus,
  git: Git,
  epoch: string,
  name: string,
  id: string,
  options?: { old?: boolean; receiptId?: string; resourceVersion?: string; observe?: boolean },
): Snapshot | undefined {
  const { receipt: r, observed: o, reason, state } = status;
  const desired = r?.desired;
  const old = options?.old === true;
  const kind = options?.receiptId && !options.observe ? "DETACH" : "OBSERVE";
  const expired =
    old &&
    state === "PROVIDER_READINESS_STATE_FAILED" &&
    reason === "PROVIDER_READINESS_REASON_CREDENTIAL_EXPIRED";
  const at = Date.parse(status.observedTime ?? "");
  const evaluated = Date.parse(status.evaluatedTime ?? "");
  requireIdentity(
    r?.workspace === git.workspace &&
      r.provider === name &&
      !!r.receiptId &&
      (!options?.receiptId || r.receiptId === options.receiptId) &&
      r.kind === "PROVIDER_MUTATION_KIND_" + kind &&
      desired?.sandboxId === git.sandboxId &&
      desired.sandbox === git.sandbox &&
      desired.providerId === id &&
      desired.attachmentEpoch === epoch &&
      (id
        ? positive.test(desired.providerResourceVersion) &&
          (!options?.resourceVersion || options.resourceVersion === desired.providerResourceVersion)
        : ["", "0"].includes(desired.providerResourceVersion)) &&
      positive.test(desired.providerEnvRevision) &&
      positive.test(desired.configRevision) &&
      !!desired.policyHash &&
      (!old || isDeepStrictEqual(generation(desired), generation(git))),
  );
  // During a reload the old observation can name the previous snapshot. Never use a pending
  // report as completion; a different live session or process, however, cannot be our witness.
  if (o) {
    requireIdentity(
      o.sessionId === git.supervisorSessionId &&
        !!o.sessionId &&
        (!o.processInstanceId || o.processInstanceId === git.processInstanceId) &&
        status.networkInstanceId === git.networkInstanceId &&
        !!status.networkInstanceId,
    );
  }
  if (["PROVIDER_READINESS_STATE_PERSISTED", "PROVIDER_READINESS_STATE_PENDING"].includes(state)) {
    return undefined;
  }
  requireIdentity(
    (expired ||
      (state === "PROVIDER_READINESS_STATE_" + (id ? "READY" : "REVOKED") &&
        (!reason || reason === unspecified))) &&
      !!o?.sessionId &&
      !!o.processInstanceId &&
      positive.test(o.sequence) &&
      o.policyActive &&
      (expired ||
        (o.credentialsInstalled &&
          o.launchEnvironmentInstalled &&
          (!o.reason || o.reason === unspecified))) &&
      isDeepStrictEqual(generation(o), generation(desired)) &&
      Number.isFinite(at) &&
      at <= evaluated &&
      Math.abs(Date.now() - evaluated) < 30_000,
  );
  return desired;
}

/** Identity of exactly the last installed generation, including stock's explicit expiration.
 * This is evidence for standing succession, never evidence that a credential may be used. */
export async function observeOpenShellGitPredecessor(
  client: Client,
  git: Git,
  signal: AbortSignal,
) {
  const { workspace, sandbox, provider, providerId, providerResourceVersion } = git;
  const status = await client.getSandboxProviderStatus(workspace, sandbox, provider, signal);
  return !!evidence(status, git, git.attachmentEpoch, provider, providerId, {
    old: true,
    resourceVersion: providerResourceVersion,
  });
}

async function modelProvider(client: Client, git: Git, model: string, signal: AbortSignal) {
  const p = await client.getProvider(git.workspace, model, signal);
  requireIdentity(
    p?.id && p.name === model && p.workspace === git.workspace && p.id !== git.providerId,
  );
  return p.id;
}

/** Called while Git is installed and after the Sandbox Driver verified its complete admitted spec. */
export async function witnessOpenShellGitLaunch(
  client: Client,
  owner: OpenShellGitContinuity,
  box: OpenShellSandboxResponse,
  git: Git,
  signal: AbortSignal,
  completedPreviewReceipt?: string,
): Promise<string | undefined> {
  const id = await modelProvider(client, git, owner.model, signal);
  const status = await client.getSandboxProviderStatus(
    git.workspace,
    git.sandbox,
    owner.model,
    signal,
    completedPreviewReceipt,
  );
  if (
    completedPreviewReceipt !== undefined &&
    status.completedOperationId !== completedPreviewReceipt
  ) {
    return;
  }
  const model = evidence(
    status,
    git,
    git.attachmentEpoch,
    owner.model,
    id,
    completedPreviewReceipt === undefined
      ? undefined
      : { receiptId: completedPreviewReceipt, observe: true },
  );
  if (!model || !isDeepStrictEqual(generation(model), generation(git))) {
    return;
  }
  const value = launch(box, git, owner, await owner.workload(git.sandboxId, signal), id);
  requireIdentity(value.present);
  return value.hash;
}

/**
 * The caller has closed issuance and requested disposal of every repository session; it checks
 * their disposal separately. The store has now fenced this route permanently. An intent buys exactly one conditional send, even if we crash before it.
 * A lost reply is reconciled with a fresh OBSERVE of absence, not attributed to our DETACH.
 */
export async function subtractExpiredOpenShellGit(
  store: Pick<OpenShellGitRouteStore, "beginDetach" | "confirmDetached">,
  saved: OpenShellGitExpiry,
  client: Client,
  owner: OpenShellGitContinuity,
  signal: AbortSignal,
  verifyRetainedProviders: (providers: readonly string[]) => Promise<boolean>,
  report?: (outcome: OpenShellGitExpiryResult, check: string) => void,
): Promise<OpenShellGitExpiryResult> {
  const { observed: git, retainedLaunchHash, detach } = saved;
  const { workspace, sandbox: name, provider, executionId } = git;
  let check = "model-provider";
  const result = (outcome: OpenShellGitExpiryResult, step = check) => {
    report?.(outcome, step);
    return outcome;
  };
  try {
    const id = await modelProvider(client, git, owner.model, signal);
    const inspect = async () => {
      const box = await client.getSandbox({ name, workspace }, signal);
      requireIdentity(box); // not found, including a hidden Sandbox, is never withdrawal
      const value = launch(box, git, owner, await owner.workload(git.sandboxId, signal), id);
      requireIdentity(retainedLaunchHash === value.hash);
      return value;
    };
    check = "original-launch-and-pods";
    let current = await inspect();
    check = "original-git-provider";
    // An absent provider object also gives an empty desired provider id. Keep the object and prove
    // that the attachment disappeared instead, with the exact original provider still identifiable.
    const object = await client.getProvider(workspace, provider, signal);
    requireIdentity(
      object?.id === git.providerId &&
        object.name === provider &&
        object.workspace === workspace &&
        object.profileWorkspace === workspace &&
        object.resourceVersion === git.providerResourceVersion,
    );
    const status = (p: string, receipt?: string) =>
      client.getSandboxProviderStatus(workspace, name, p, signal, receipt);
    let receiptId: string | undefined;
    let request = detach?.requestId;
    if (current.present) {
      // If the send outcome is unknown and the provider still appears attached, do not replay.
      if (request) {
        return result(detach?.epoch ? "retire-runtime" : "pending", "attachment-after-send-intent");
      }
      check = "original-git-installation";
      const before = evidence(
        await status(provider),
        git,
        current.epoch,
        provider,
        git.providerId,
        { old: true, resourceVersion: git.providerResourceVersion },
      );
      if (!before) {
        return result("pending");
      }
      check = "before-detach";
      const { version, ...next } = await inspect();
      const { version: expected, ...previous } = current;
      requireIdentity(isDeepStrictEqual(previous, next));
      if (version !== expected) {
        return result("pending", "sandbox-version-moved-before-intent");
      }
      signal.throwIfAborted();
      request = randomUUID();
      if (!(await store.beginDetach(executionId, retainedLaunchHash, request, current.version))) {
        return result("pending", "detach-intent");
      }
      check = "conditional-detach";
      signal.throwIfAborted();
      const sent = await client.detachSandboxProvider(workspace, name, provider, signal, {
        requestId: request,
        expectedResourceVersion: current.version,
      });
      requireIdentity(sent?.detached === true && sent.receiptId);
      receiptId = sent.receiptId;
      check = "launch-after-detach";
      current = await inspect();
    }
    requireIdentity(
      !current.present && request && (!detach?.epoch || detach.epoch === current.epoch),
    );
    const { epoch } = current;
    // A pending stock response already has a receipt. Follow that receipt, including an
    // OBSERVE receipt for absence after response loss. Never send another detach to poll it.
    const read = async (provider: string, providerId: string, receiptId?: string) => {
      let receipt = receiptId;
      const observe = !receipt;
      for (let attempt = 0; attempt < 4; attempt++) {
        const s = await status(provider, receipt);
        const exact = evidence(s, git, epoch, provider, providerId, {
          observe,
          ...(receipt && { receiptId: receipt }),
        });
        if (exact) {
          return exact;
        }
        receipt = s.receipt!.receiptId!;
        await delay(250 * 2 ** attempt, undefined, { signal });
      }
    };
    check = "git-revocation-on-original-supervisor";
    const revoked = await read(provider, "", receiptId);
    if (!revoked) {
      return result("pending");
    }
    // A retained profile can gain Git access without changing its provider's resource version.
    // Read those profiles between the two supervisor reports, on every pass including recovery.
    check = "retained-provider-profiles";
    requireIdentity(await verifyRetainedProviders(current.retainedProviders));
    check = "model-on-original-supervisor";
    const ready = await read(owner.model, id);
    if (!ready) {
      return result("pending");
    }
    if (!isDeepStrictEqual(generation(ready), generation(revoked))) {
      // A legitimate model rotation can cross the profile reads. Observe one stable generation.
      return result("pending", "reduced-generation-moved-across-provider-check");
    }
    const { version, ...next } = await inspect();
    const { version: expected, ...previous } = current;
    requireIdentity(isDeepStrictEqual(previous, next));
    if (version !== expected) {
      return result("pending", "sandbox-version-moved-after-read");
    }
    check = "record-reduced-generation";
    signal.throwIfAborted();
    return (await store.confirmDetached(executionId, retainedLaunchHash, request, epoch))
      ? result("withdrawn")
      : result("retire-runtime");
  } catch (error) {
    // Permission, failed precondition, unsupported, missing or contradictory evidence cannot
    // authorize retention. Transport loss after our durable fence is an observation to repeat.
    // The gateway client sanitizes some failures into an error with grpcStatus; others
    // retain gRPC's numeric code. In particular UNIMPLEMENTED must not become pending.
    const failure = error as { grpcStatus?: number; code?: number } | null;
    const code = failure?.grpcStatus ?? failure?.code;
    return error instanceof Unsafe || [3, 5, 7, 9, 10, 12, 16].includes(Number(code))
      ? result("retire-runtime")
      : result("pending");
  }
}
