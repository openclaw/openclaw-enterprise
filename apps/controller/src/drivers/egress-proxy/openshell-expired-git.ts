import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type {
  OpenShellGatewayClient,
  OpenShellProviderDesiredIdentity,
  OpenShellSandboxProviderStatus,
  OpenShellSandboxResponse,
} from "../sandbox/openshell-gateway-client.ts";
import { OpenShellAdmissionLimitError } from "../sandbox/openshell-gateway-errors.ts";
import type { OpenShellPreparedGitInstalled as Git } from "./openshell-prepared-git-provider.ts";
import type { OpenShellGitExpiry, OpenShellGitRouteStore } from "./openshell-git-route-store.ts";

export type OpenShellGitExpiryResult = "withdrawn" | "pending" | "retire-runtime";
/**
 * Why an expiry pass could not confirm withdrawal, from a fixed set (never error text):
 * nothing failed but the step `check` names is not confirmed yet or moved during the pass
 * (`unconfirmed`, including contradictory identity), the gateway's durable admission limit
 * refused a request (one that never
 * clears points at unresolved admissions in its store), the gateway answered UNAVAILABLE or not
 * at all, a request ran out of time or the pass was aborted (its deadline or the worker
 * stopping), or another request failed, including a route store write. `gateway_unavailable`
 * and `timeout` mean what they mean in `OpenShellGitObservationFailure`.
 */
export type OpenShellGitExpiryFailure =
  "unconfirmed" | "admission_limit" | "gateway_unavailable" | "timeout" | "failed";
/** The steps an expiry pass reports: fixed names that operators can alert on. */
export const OPENSHELL_GIT_EXPIRY_CHECKS = [
  "model-provider",
  "original-launch-and-pods",
  "original-git-provider",
  "attachment-after-send-intent",
  "original-git-installation",
  "before-detach",
  "sandbox-version-moved-before-intent",
  "detach-intent",
  "conditional-detach",
  "repeated-conditional-detach",
  "launch-after-uncertain-detach",
  "launch-after-detach",
  "git-revocation-on-original-supervisor",
  "retained-provider-profiles",
  "model-on-original-supervisor",
  "reduced-generation-moved-across-provider-check",
  "sandbox-version-moved-after-read",
  "record-reduced-generation",
] as const;
export type OpenShellGitExpiryCheck = (typeof OPENSHELL_GIT_EXPIRY_CHECKS)[number];
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
/** The gateway client sanitizes some failures into an error with grpcStatus; others retain
 * gRPC's numeric code. */
function rawGrpcCode(error: unknown): unknown {
  const failure = error as { grpcStatus?: unknown; code?: unknown } | null;
  return failure?.grpcStatus ?? failure?.code;
}
function grpcCode(error: unknown): number {
  return Number(rawGrpcCode(error));
}
function expiryFailure(error: unknown, signal: AbortSignal): OpenShellGitExpiryFailure {
  if (error instanceof OpenShellAdmissionLimitError) {
    return "admission_limit";
  }
  // The gateway client wraps UNAVAILABLE and DEADLINE_EXCEEDED with their grpcStatus; an aborted
  // pass rejects with the signal's own reason.
  const code = grpcCode(error);
  if (signal.aborted || code === 4) {
    return "timeout";
  }
  return code === 14 ? "gateway_unavailable" : "failed";
}
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

/** Preserve the Gateway's RFC 3339 UTC wire precision for observation lease comparisons. */
function timestampNanos(value: string | undefined): bigint | undefined {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value ?? "");
  if (!match) {
    return undefined;
  }
  const millis = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 19) !== match[1]) {
    return undefined;
  }
  return BigInt(millis) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"));
}

/** An exact stock supervisor report. At expiry stock can report the old credentials expired;
 * accept that only before subtracting Git, never as the successful reduced installation. */
function evidence(
  status: OpenShellSandboxProviderStatus,
  git: Git,
  epoch: string,
  name: string,
  id: string,
  options?: {
    old?: boolean;
    receiptId?: string;
    resourceVersion?: string;
    observe?: boolean;
    readStartedAt?: bigint;
  },
): Snapshot | undefined {
  const { receipt: r, observed: o, reason, state } = status;
  const desired = r?.desired;
  const old = options?.old === true;
  const kind = options?.receiptId && !options.observe ? "DETACH" : "OBSERVE";
  const expired =
    old &&
    state === "PROVIDER_READINESS_STATE_WITHHELD" &&
    reason === "PROVIDER_READINESS_REASON_CREDENTIAL_EXPIRED";
  const at = timestampNanos(status.observedTime);
  const evaluated = timestampNanos(status.evaluatedTime);
  const now = BigInt(Date.now()) * 1_000_000n;
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
      at !== undefined &&
      evaluated !== undefined &&
      at <= evaluated &&
      // Stock reports expiry before checking its 15-second supervisor observation lease.
      (!expired ||
        (evaluated - at < 15_000_000_000n &&
          now - at < 30_000_000_000n &&
          at - now < 30_000_000_000n)) &&
      Math.abs(Date.now() - Date.parse(status.evaluatedTime ?? "")) < 30_000,
  );
  // Request time includes transport before evaluation. If that conservative budget
  // is exhausted, obtain a fresh witness without treating the matching identity as unsafe.
  if (
    expired &&
    (options?.readStartedAt === undefined ||
      evaluated - at + (process.hrtime.bigint() - options.readStartedAt) >= 15_000_000_000n)
  ) {
    return undefined;
  }
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
  const readStartedAt = process.hrtime.bigint();
  const status = await client.getSandboxProviderStatus(workspace, sandbox, provider, signal);
  if (
    status.state === "PROVIDER_READINESS_STATE_WITHHELD" &&
    status.reason === "PROVIDER_READINESS_REASON_CREDENTIAL_EXPIRED"
  ) {
    // Stock reports expiry before checking whether this session still owns the live instance.
    // Read after the report: an earlier Sandbox snapshot could miss a replacement accepted since.
    const current = await client.getSandbox({ workspace, name: sandbox }, signal);
    requireIdentity(
      current?.id === git.sandboxId &&
        current.name === sandbox &&
        current.workspace === workspace &&
        [2, "SANDBOX_PHASE_READY"].includes(current.phase as string | number) &&
        current.mainProcessInstanceId === git.networkInstanceId,
    );
  }
  return !!evidence(status, git, git.attachmentEpoch, provider, providerId, {
    old: true,
    resourceVersion: providerResourceVersion,
    readStartedAt,
  });
}

async function modelProvider(client: Client, git: Git, model: string, signal: AbortSignal) {
  const p = await client.getProvider(git.workspace, model, signal);
  requireIdentity(
    p?.id && p.name === model && p.workspace === git.workspace && p.id !== git.providerId,
  );
  return p.id;
}

/** Called while Git is installed and after the Sandbox Driver verified its complete admitted spec.
 * Predecessor evidence preserves launch identity, never credential readiness or authority. */
export async function witnessOpenShellGitLaunch(
  client: Client,
  owner: OpenShellGitContinuity,
  box: OpenShellSandboxResponse,
  git: Git,
  signal: AbortSignal,
  observation:
    | { kind: "predecessor" }
    | { kind: "installation"; completedPreviewReceipt?: string | undefined },
): Promise<string | undefined> {
  const completedPreviewReceipt =
    observation.kind === "installation" ? observation.completedPreviewReceipt : undefined;
  const id = await modelProvider(client, git, owner.model, signal);
  const readStartedAt = process.hrtime.bigint();
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
  const workload = await owner.workload(git.sandboxId, signal);
  if (
    observation.kind === "predecessor" &&
    status.state === "PROVIDER_READINESS_STATE_WITHHELD" &&
    status.reason === "PROVIDER_READINESS_REASON_CREDENTIAL_EXPIRED"
  ) {
    // Check after the report and workload read: the old report cannot identify a replacement.
    const current = await client.getSandbox(
      { workspace: git.workspace, name: git.sandbox },
      signal,
    );
    requireIdentity(
      current?.id === git.sandboxId &&
        current.name === git.sandbox &&
        current.workspace === git.workspace &&
        box.mainProcessInstanceId === git.networkInstanceId &&
        [2, "SANDBOX_PHASE_READY"].includes(current.phase as string | number) &&
        current.mainProcessInstanceId === git.networkInstanceId,
    );
  }
  const model = evidence(status, git, git.attachmentEpoch, owner.model, id, {
    // OpenShell reports expiry for the aggregate environment even when this query
    // names the model provider. Only the recorded predecessor may use that evidence.
    old: observation.kind === "predecessor",
    readStartedAt,
    ...(completedPreviewReceipt && { receiptId: completedPreviewReceipt, observe: true }),
  });
  if (!model || !isDeepStrictEqual(generation(model), generation(git))) {
    return;
  }
  const value = launch(box, git, owner, workload, id);
  requireIdentity(value.present);
  return value.hash;
}

/**
 * The caller has closed issuance and requested disposal of every repository session; it checks
 * their disposal separately. The store has now fenced this route permanently. An intent records
 * one request ID and the Sandbox version it is conditional on, before the first send.
 * A lost reply is reconciled with a fresh OBSERVE of absence, not attributed to our DETACH.
 * An intent that left the provider attached (a crash before the send, or a send that did not
 * answer) is sent again as the same request (finding 2219). Per caller identity and workspace,
 * the gateway admits a request ID at most once: it replays a completed detach, and runs one it
 * never saw under the same version precondition. It answers FAILED_PRECONDITION when it holds
 * the request without a result (possibly still applying), cannot replay it (key rotation, the
 * original Sandbox gone) or got another payload: only a detach then observed in effect settles
 * it, else the runtime retires. A Sandbox version that moved since the intent retires it too.
 */
export async function subtractExpiredOpenShellGit(
  store: Pick<OpenShellGitRouteStore, "beginDetach" | "confirmDetached">,
  saved: OpenShellGitExpiry,
  client: Client,
  owner: OpenShellGitContinuity,
  signal: AbortSignal,
  verifyRetainedProviders: (providers: readonly string[]) => Promise<boolean>,
  report?: (
    outcome: OpenShellGitExpiryResult,
    check: OpenShellGitExpiryCheck,
    failure?: OpenShellGitExpiryFailure,
    grpcStatus?: number,
  ) => void,
): Promise<OpenShellGitExpiryResult> {
  const { observed: git, retainedLaunchHash, detach } = saved;
  const { workspace, sandbox: name, provider, executionId } = git;
  let check: OpenShellGitExpiryCheck = "model-provider";
  const result = (
    outcome: OpenShellGitExpiryResult,
    step = check,
    failure: OpenShellGitExpiryFailure = "unconfirmed",
    grpcStatus?: unknown,
  ) => {
    report?.(
      outcome,
      step,
      outcome === "withdrawn" ? undefined : failure,
      typeof grpcStatus === "number" &&
        Number.isInteger(grpcStatus) &&
        grpcStatus >= 1 &&
        grpcStatus <= 16
        ? grpcStatus
        : undefined,
    );
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
      // A confirmed detach whose provider is attached again, or an intent this request can no
      // longer satisfy, cannot be settled by another send. (A confirmed detach also moved the
      // version; the epoch check is kept as a second guard.)
      if (detach?.epoch || (request && detach?.resourceVersion !== current.version)) {
        return result("retire-runtime", "attachment-after-send-intent");
      }
      check = "original-git-installation";
      const before = await observeOpenShellGitPredecessor(client, git, signal);
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
      if (!request) {
        request = randomUUID();
        if (!(await store.beginDetach(executionId, retainedLaunchHash, request, current.version))) {
          return result("pending", "detach-intent");
        }
      }
      // The same request again when an earlier send did not take effect.
      const repeated = detach?.requestId !== undefined;
      check = repeated ? "repeated-conditional-detach" : "conditional-detach";
      signal.throwIfAborted();
      let sent: Awaited<ReturnType<Client["detachSandboxProvider"]>> | undefined;
      try {
        sent = await client.detachSandboxProvider(workspace, name, provider, signal, {
          requestId: request,
          expectedResourceVersion: current.version,
        });
      } catch (error) {
        if (!repeated || grpcCode(error) !== 9) {
          throw error;
        }
        // The gateway holds the earlier send without a result: it may have applied since. Only
        // the provider read absent now settles it (by OBSERVE below); otherwise retire.
        check = "launch-after-uncertain-detach";
        current = await inspect();
        if (current.present) {
          throw error;
        }
      }
      if (sent !== undefined) {
        requireIdentity(sent.detached === true && sent.receiptId);
        receiptId = sent.receiptId;
        check = "launch-after-detach";
        current = await inspect();
      }
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
    // In particular UNIMPLEMENTED must not become pending.
    return result(
      error instanceof Unsafe || [3, 5, 7, 9, 10, 12, 16].includes(grpcCode(error))
        ? "retire-runtime"
        : "pending",
      check,
      error instanceof Unsafe ? "unconfirmed" : expiryFailure(error, signal),
      rawGrpcCode(error),
    );
  }
}
