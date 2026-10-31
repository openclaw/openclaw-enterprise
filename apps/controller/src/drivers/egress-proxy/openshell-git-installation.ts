import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AgentRevision } from "@openclaw-enterprise/contracts";
import {
  DependencyUnavailableError,
  SandboxGatewayUnavailableError,
  TransientDependencyError,
} from "@openclaw-enterprise/occ";
import type {
  OpenShellGatewayClient,
  OpenShellSandboxResponse,
} from "../sandbox/openshell-gateway-client.ts";
import { witnessOpenShellGitLaunch, type OpenShellGitContinuity } from "./openshell-expired-git.ts";
import type {
  OpenShellPreparedGitBinding,
  OpenShellPreparedGitInstalled,
  OpenShellPreparedGitProvider,
} from "./openshell-prepared-git-provider.ts";
import {
  previewPolicyAndRecipient,
  type ObservedHookPreview,
} from "./openshell-request-hook-preview.ts";

/**
 * Why a revision's Git route is closed for good. The entry stays as a tombstone until a new
 * revision: the installation no longer verifies, a provider write's outcome is unknown, the
 * worker withdrew it, or another worker adopted it (`worker_replaced`: this worker's fence
 * is stale, finding 2128). Never a failed read (see OpenShellGitObservationFailure).
 */
export type OpenShellGitRouteBlockReason =
  | "repository_expired"
  | "withdrawn"
  | "bootstrap_failed"
  | "execution_replaced"
  | "supervisor_replaced"
  | "worker_replaced"
  | "sandbox_mismatch"
  | "grant_changed"
  | "material_mismatch"
  | "preview_install_unverified"
  | "preview_release_unconfirmed"
  | "provider_missing"
  | "provider_overlap"
  | "write_unknown"
  | "write_refused"
  | "gateway_unauthorized"
  | "unknown";

/**
 * Why the installation could not be observed this time: the gateway did not answer, another
 * gateway request failed, the read ran out of time, or the material store did not answer. The
 * route stays closed, nothing is written or replayed, and the worker observes again with a
 * bounded backoff (finding 2136).
 */
export type OpenShellGitObservationFailure =
  "gateway_unavailable" | "gateway_request_failed" | "timeout" | "read_failed";

export interface OpenShellGitObservationEntry {
  readonly revision: Readonly<AgentRevision>;
  readonly client: OpenShellGatewayClient;
  readonly provider: OpenShellPreparedGitProvider;
  readonly otherProviders: readonly string[];
  binding: OpenShellPreparedGitBinding;
  readonly preview?: ObservedHookPreview;
  verify?: (sandbox: OpenShellSandboxResponse) => void;
  sandboxId?: string;
  continuity?: OpenShellGitContinuity;
  retainedLaunchHash?: string;
  /** The last observation that verified; the next one must read as the same installation. */
  supervisor?: OpenShellPreparedGitInstalled;
  /** A new supervisor session was adopted for the same process; reported once installed. */
  reconnected?: { readonly since: number } | undefined;
  /** Since when observe() has answered the verified installation while the provider
   * environment waits for the supervisor (finding 2146); reported once it overstays. */
  environmentLag?: { readonly since: number; reported?: true } | undefined;
  /** The route has been open at least once: a later install is a restoration. */
  opened?: true | undefined;
  installed?: OpenShellPreparedGitInstalled | undefined;
  /** When an installed route was last closed by a failed read; reported once it is restored. */
  closedAt?: number | undefined;
  /** The persisted observation has not been verified in this process yet: the first read
   * compares the full installation identity, whatever the session. */
  unverified?: true | undefined;
}

interface OpenShellGitObservationOptions {
  readonly adopt?: boolean;
  readonly predecessor?: boolean;
  readonly configuration: {
    readonly registrationName: string;
    readonly authority: { readonly audience: string };
  };
  readonly verifyFence: () => Promise<void>;
  readonly reportEnvironmentLag: () => void;
}

// A supervisor installs a moved provider environment on its next settings poll, seconds later.
// Past this, the verified installation is no longer taken as current: the route waits.
const ENVIRONMENT_LAG_LIMIT_MS = 60_000;

/** One of the runtime's own verifications failed: the installation no longer verifies. */
export class OpenShellGitRouteError extends Error {
  readonly reason: OpenShellGitRouteBlockReason;

  constructor(reason: OpenShellGitRouteBlockReason, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OpenShellGitRouteError";
    this.reason = reason;
  }
}

/** A read did not produce evidence. It says nothing about the installation. */
export class OpenShellGitObservationError extends Error {
  readonly failure: OpenShellGitObservationFailure;

  constructor(failure: OpenShellGitObservationFailure, cause: unknown) {
    super(`OpenShell Git installation could not be observed: ${failure}.`, { cause });
    this.name = "OpenShellGitObservationError";
    this.failure = failure;
  }
}

export function classifyOpenShellGitObservationFailure(
  error: unknown,
  signal: AbortSignal,
): OpenShellGitObservationFailure | undefined {
  if (error instanceof OpenShellGitObservationError) {
    return error.failure;
  }
  if (error instanceof SandboxGatewayUnavailableError) {
    return "gateway_unavailable";
  }
  if (error instanceof DependencyUnavailableError || error instanceof TransientDependencyError) {
    return "gateway_request_failed";
  }
  if (
    signal.aborted ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  ) {
    return "timeout";
  }
  return undefined;
}

// gRPC PERMISSION_DENIED and UNAUTHENTICATED: the gateway answered and refused this worker's
// identity. Never retried (owner rule: retry network and timeouts, never an auth failure).
const GRPC_PERMISSION_DENIED = 7;
const GRPC_UNAUTHENTICATED = 16;

function refusedIdentity(error: unknown): boolean {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return code === GRPC_PERMISSION_DENIED || code === GRPC_UNAUTHENTICATED;
}

/** Runs a read. A failure that is not one of the runtime's own verifications is unavailable
 * evidence (the provider's observe() treats its reads the same way), never a verdict. */
export async function readOpenShellGitEvidence<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof OpenShellGitRouteError || error instanceof OpenShellGitObservationError) {
      throw error;
    }
    if (refusedIdentity(error)) {
      throw new OpenShellGitRouteError(
        "gateway_unauthorized",
        "OpenShell Git gateway refused the worker's identity.",
      );
    }
    throw new OpenShellGitObservationError(
      classifyOpenShellGitObservationFailure(error, signal) ?? "read_failed",
      error,
    );
  }
}

/**
 * Whether a request's observation reads as the installation the route admitted. The provider
 * environment revision is Sandbox-wide: it moves when another provider attached to the Sandbox
 * changes, as a sibling Agent's deploy does (finding 2146), while observe() pins this provider's
 * own id, resource version and profile version. The worker's next reconcile adopts it.
 */
export function sameOpenShellGitInstallation(
  observed: OpenShellPreparedGitInstalled,
  installed: OpenShellPreparedGitInstalled | undefined,
): boolean {
  if (installed === undefined) {
    return false;
  }
  const { providerEnvRevision: _observed, ...identity } = observed;
  const { providerEnvRevision: _installed, ...admitted } = installed;
  return isDeepStrictEqual(identity, admitted);
}

export function openShellGitExecutionIdentity(observed: OpenShellPreparedGitInstalled) {
  const { workspace, sandboxId, executionId, processInstanceId, networkInstanceId } = observed;
  const identity = [workspace, sandboxId, executionId, processInstanceId, networkInstanceId];
  return {
    executionId,
    fingerprint: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
  };
}

/**
 * github.com and every name under it: besides the route's own github.com and api.github.com,
 * GitHub serves repository content and accepts GitHub credentials on other front ends there
 * (ssh.github.com:443, codeload.github.com, uploads.github.com), which would skip the
 * middleware (finding 2148). A wildcard over github.com's parent (`*.com`) counts too.
 * githubusercontent.com is not covered: the route sends nothing there.
 */
export function overlapsOpenShellGitHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  if (!/^(?:\*\.)?[a-z0-9.-]+$/.test(normalized)) {
    return true;
  }
  return (
    normalized === "github.com" ||
    normalized.endsWith(".github.com") ||
    (normalized.startsWith("*.") && "github.com".endsWith(normalized.slice(1)))
  );
}

/**
 * Provider endpoints keep the name check only: an IP-addressed endpoint, such as a self-hosted
 * model server, is common there, and this check is against a provider that names the Git hosts
 * or carries a GitHub token.
 */
export async function checkOpenShellGitProviders(
  client: OpenShellGatewayClient,
  workspace: string,
  providers: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  for (const name of providers) {
    const provider = await client.getProvider(workspace, name, signal);
    if (!provider) {
      throw new OpenShellGitRouteError(
        "provider_missing",
        "OpenShell inference provider is unavailable.",
      );
    }
    // Stock permits a profile in this Workspace, or an empty profile_workspace selecting
    // the platform profile. A same-named Workspace profile cannot stand in for that read.
    const profileWorkspace = provider.profileWorkspace || null;
    if (profileWorkspace !== null && profileWorkspace !== workspace) {
      throw new OpenShellGitRouteError(
        "provider_overlap",
        "OpenShell Git cannot verify a credential provider bound to another Workspace's profile.",
      );
    }
    const profile = await client.getProviderProfile(profileWorkspace, provider.type, signal);
    const definition = profile?.definition;
    const endpoints = definition?.endpoints;
    const credentials = definition?.credentials;
    if (
      !definition ||
      !Array.isArray(endpoints) ||
      !Array.isArray(credentials) ||
      endpoints.some((value) =>
        overlapsOpenShellGitHost(String((value as Record<string, unknown>).host ?? "")),
      ) ||
      credentials.some((value) =>
        ((value as Record<string, unknown>).env_vars as string[] | undefined)?.includes(
          "GITHUB_TOKEN",
        ),
      )
    ) {
      throw new OpenShellGitRouteError(
        "provider_overlap",
        "OpenShell Git cannot share an unverified or overlapping credential provider.",
      );
    }
  }
}

/**
 * One verified read of the installation. Only the worker's own reconcile pass adopts a new
 * supervisor session (`adopt`); a request's lookup verifies against the reference and never
 * moves it, so late answers from concurrent reads cannot move it backwards.
 */
export async function observeOpenShellGitInstallation(
  entry: OpenShellGitObservationEntry,
  signal: AbortSignal,
  {
    adopt = false,
    predecessor = false,
    configuration,
    verifyFence,
    reportEnvironmentLag,
  }: OpenShellGitObservationOptions,
): Promise<OpenShellPreparedGitInstalled | undefined> {
  await readOpenShellGitEvidence(
    () =>
      checkOpenShellGitProviders(
        entry.client,
        entry.binding.workspace,
        entry.otherProviders,
        signal,
      ),
    signal,
  );
  const sandbox = await readOpenShellGitEvidence(
    () =>
      entry.client.getSandbox(
        { workspace: entry.binding.workspace, name: entry.binding.sandbox },
        signal,
      ),
    signal,
  );
  if (!sandbox?.id || !entry.verify) {
    return;
  }
  if (![2, "SANDBOX_PHASE_READY"].includes(sandbox.phase as string | number)) {
    return;
  }
  try {
    entry.verify(sandbox);
  } catch (error) {
    throw new OpenShellGitRouteError(
      "sandbox_mismatch",
      "OpenShell Git sandbox no longer matches its admitted content.",
      error,
    );
  }
  if (
    (sandbox.restartCount ?? 0) !== 0 ||
    ![1, "SANDBOX_RESTART_POLICY_NEVER"].includes(
      sandbox.spec?.restart_policy as string | number,
    ) ||
    (entry.sandboxId && entry.sandboxId !== sandbox.id)
  ) {
    throw new OpenShellGitRouteError("execution_replaced", "OpenShell Git execution was replaced.");
  }
  entry.sandboxId = sandbox.id;
  // observe() answers undefined, never throws, for a read it could not complete. It is handed
  // the installation admitted when the read began; a concurrent close cannot swap it.
  const admitted = entry.installed;
  if (
    predecessor &&
    !entry.preview &&
    entry.opened &&
    entry.revision.repositoryCredentials?.standingApprovalId &&
    entry.supervisor?.sandboxId === sandbox.id &&
    entry.binding.credentialState === "active" &&
    Date.parse(entry.binding.expiresAt) <= Date.now()
  ) {
    // Identity only. Lookup and the post-rotation installation check never take this path.
    const last = entry.supervisor;
    if (await entry.provider.observePredecessor(entry.binding, last, signal)) {
      if (adopt) {
        entry.unverified = undefined;
      }
      return last;
    }
    return;
  }
  // Only the route owner advances its receipt, after the Sandbox has the expected identity.
  // Verification (including the separate read below) queries only an already-terminal receipt.
  if (
    adopt &&
    entry.preview &&
    !(await entry.provider.settlePreviewReceipt(entry.binding, signal))
  ) {
    return;
  }
  let observed = await entry.provider.observe(
    entry.binding,
    sandbox.id,
    signal,
    entry.preview ? undefined : admitted,
  );
  if (entry.preview && observed) {
    const preview = entry.preview;
    // The original worker may advance its fence by reserving a rotation. Recheck
    // that exact lease; a restarted preview is closed by prepare(), never adopted.
    await verifyFence();
    if (
      !entry.continuity ||
      !sandbox.mainProcessStartedAt ||
      Date.parse(sandbox.mainProcessStartedAt) < preview.opened - 5000 ||
      Date.parse(sandbox.mainProcessStartedAt) > Date.now() + 5000
    ) {
      return;
    }
    const recipient = await previewPolicyAndRecipient({
      ...(preview.mandatory && { mandatory: true }),
      client: entry.client,
      sandbox,
      observed,
      registration: configuration.registrationName,
      audience: configuration.authority.audience,
      gitRule: entry.provider.previewNetworkRule(),
      modelProvider: entry.continuity.model,
      workload: entry.continuity.workload,
      signal,
    });
    if (!recipient) {
      return;
    }
    if (!preview.recipient && observed.credentialState === "bootstrap" && adopt) {
      preview.recipient = recipient;
      preview.bootstrapRevision = observed.providerEnvRevision;
    }
    if (
      preview.recipient !== recipient ||
      (observed.credentialState === "active"
        ? !preview.hook || observed.providerEnvRevision === preview.bootstrapRevision
        : observed.providerEnvRevision !== preview.bootstrapRevision)
    ) {
      throw new OpenShellGitRouteError(
        "supervisor_replaced",
        "Observed Git recipient or policy changed.",
      );
    }
    if (preview.hook && !preview.mandatory) {
      observed = Object.freeze({ ...observed, observedHook: preview.hook });
    }
  }
  if (!observed) {
    return;
  }
  if (observed === admitted) {
    // Only the provider environment moved and the supervisor has not installed it yet: the
    // verified installation stands, for a bounded time (finding 2146).
    const lag = (entry.environmentLag ??= { since: performance.now() });
    if (performance.now() - lag.since > ENVIRONMENT_LAG_LIMIT_MS) {
      // Reported as a restoration once the supervisor installs it.
      entry.closedAt ??= performance.now();
      if (!lag.reported) {
        lag.reported = true;
        reportEnvironmentLag();
      }
      return;
    }
  } else {
    entry.environmentLag = undefined;
  }
  const previous = entry.supervisor;
  if (previous === undefined) {
    if (adopt) {
      entry.supervisor = observed;
    }
    return observed;
  }
  if (
    observed.processInstanceId !== previous.processInstanceId ||
    observed.networkInstanceId !== previous.networkInstanceId
  ) {
    throw new OpenShellGitRouteError(
      "supervisor_replaced",
      "OpenShell Git supervisor was replaced.",
    );
  }
  if (observed.supervisorSessionId !== previous.supervisorSessionId || entry.unverified) {
    // The supervisor holds a new control session, or this is the first read of a route
    // re-adopted from its persisted observation after a worker restart (finding 2128),
    // which has no in-process continuity at all and is verified the same way in full.
    // A replaced Gateway Pod gives every running Sandbox a new control session at once
    // (the same supervisor process reconnects), so a redeploy of the whole fleet is not
    // required: the new session is adopted when the verified observation is the same
    // installation as before. Its identity must read
    // exactly as before: the Sandbox (id, name, workspace), the execution, the provider
    // (id, profile version, attachment epoch) and the supervisor's process and network
    // instance ids. Its generation (provider resource version and env revision, config
    // revision, policy hash, credential state) is verified by observe() against the
    // Gateway's own receipt and the provider version this worker last wrote, not against
    // the previous read: a credential rotation moves it, and its verifying read often lags
    // the write by seconds, so a stale snapshot would close healthy routes on every Gateway
    // restart that overlaps a rotation. Any other difference is a replaced supervisor
    // (finding 2136).
    //
    // Stated limit (owner decision 2026-10-20): in OpenShell 0.1.4 (`5a7728c3`) both
    // instance ids are asserted by the supervisor, not attested by the Gateway. The
    // network instance id is the supervisor's own SupervisorHello instance id
    // (crates/openshell-server/src/grpc/provider_readiness.rs; generated sandbox-side in
    // crates/openshell-supervisor-process/src/delegated.rs), the process instance id comes
    // from its readiness report and is only held constant within one session, and the
    // Gateway persists what a reconnecting supervisor claims as its main process instance
    // (crates/openshell-server/src/compute/mod.rs). ConnectSupervisor does authenticate a
    // sandbox principal scoped to this Sandbox id, so continuity rests on that principal
    // plus the supervisor's claims until OpenShell provides an attested reconnect identity
    // (a planned OpenShell change). No material is issued or replayed on adoption.
    if (
      (
        [
          "workspace",
          "sandbox",
          "sandboxId",
          "executionId",
          "provider",
          "providerId",
          "profileVersion",
          "attachmentEpoch",
        ] as const
      ).some((key) => observed[key] !== previous[key])
    ) {
      throw new OpenShellGitRouteError(
        "supervisor_replaced",
        "OpenShell Git supervisor was replaced.",
      );
    }
    if (adopt && entry.opened && observed.supervisorSessionId !== previous.supervisorSessionId) {
      // Reported once the route is open again; a route that never opened has nothing to restore.
      entry.reconnected ??= { since: entry.closedAt ?? performance.now() };
    }
  }
  if (adopt) {
    entry.supervisor = observed;
    entry.unverified = undefined;
    if (
      entry.continuity &&
      entry.retainedLaunchHash === undefined &&
      observed.credentialState === "active"
    ) {
      const previewReceipt = await entry.preview?.completedModelReceipt(
        entry.client,
        observed,
        entry.continuity.model,
        signal,
      );
      if (entry.preview && !previewReceipt) {
        return;
      }
      const hash = await witnessOpenShellGitLaunch(
        entry.client,
        entry.continuity,
        sandbox,
        observed,
        signal,
        previewReceipt,
      );
      if (!hash) {
        return;
      }
      entry.retainedLaunchHash = hash;
    }
  }
  return observed;
}
