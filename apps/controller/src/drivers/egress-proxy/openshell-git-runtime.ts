import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { githubInstallationProfile } from "@openclaw-enterprise/contracts";
import type {
  AgentRevision,
  ProtectedGitHubInstallationMaterial,
  ProtectedGitHubRepositoryMaterial,
  ProtectedRepositoryGitAuthority,
  ProtectedRepositoryGitMaterial,
  ProxyRevisionContext,
  RepositoryGitInstallationFence,
  SandboxRepositoryAccess,
} from "@openclaw-enterprise/contracts";
import type { PostgresPool } from "@openclaw-enterprise/occ";
import type { EgressAuthorityConfiguration } from "../../composition/egress-authority.ts";
import type { RepositoryTransportEmit } from "../../composition/repository-credentials/contracts.ts";
import { REPOSITORY_CLIENT_BIN } from "../compute/kubernetes/repository-native-configuration.ts";
import type {
  RepositoryGitDeliveryResolver,
  RepositoryGitDeliveryBinding,
} from "../repo/credentials/delivery.ts";
import {
  witnessOpenShellGitLaunch,
  subtractExpiredOpenShellGit,
  type OpenShellGitContinuity,
  type OpenShellGitExpiryResult,
} from "./openshell-expired-git.ts";
import type {
  OpenShellGatewayClient,
  OpenShellSandboxResponse,
} from "../sandbox/openshell-gateway-client.ts";
import {
  type OpenShellGitMaterialReference,
  type OpenShellGitRouteSnapshot,
  type OpenShellGitRouteStore,
  type OpenShellGitRouteWithdrawal,
  PostgresOpenShellGitRouteStore,
} from "./openshell-git-route-store.ts";
import {
  deleteOpenShellPreparedGitProvider,
  OpenShellPreparedGitProvider,
  OpenShellPreparedGitProviderError,
  type OpenShellPreparedGitBinding,
  type OpenShellPreparedGitDelivery,
  type OpenShellPreparedGitGeneration,
  type OpenShellPreparedGitInstalled,
} from "./openshell-prepared-git-provider.ts";
import {
  createOpenShellOnlineGitAuthority,
  type OpenShellOnlineGitBinding,
  type OpenShellOnlineGitIdentity,
  type OpenShellOnlineGitAuthorityOptions,
  type OpenShellOnlineGitReasonCode,
} from "./openshell-online-git-authority.ts";
import {
  ObservedHookPreview,
  observedRequestHook,
  previewPolicyAndRecipient,
} from "./openshell-request-hook-preview.ts";
import { bindOpenShellEgressAuthority } from "./openshell-authority.ts";
import {
  OpenShellGitObservationError,
  OpenShellGitRouteError,
  checkOpenShellGitProviders,
  classifyOpenShellGitObservationFailure,
  observeOpenShellGitInstallation,
  openShellGitExecutionIdentity,
  overlapsOpenShellGitHost,
  readOpenShellGitEvidence as read,
  type OpenShellGitObservationEntry,
  type OpenShellGitObservationFailure,
  type OpenShellGitRouteBlockReason,
} from "./openshell-git-installation.ts";

export type {
  OpenShellGitObservationFailure,
  OpenShellGitRouteBlockReason,
} from "./openshell-git-installation.ts";

const missingAdmittedGitScope =
  "OpenShell prepared Git requires one explicitly admitted GitHub binding and its dedicated Codex execution.";

export interface OpenShellGitRuntimeConfiguration {
  readonly registrationName: string;
  /** Dedicated supported stock gateway, only operator-controlled writers, no other workspace member. */
  readonly observedHookPreviewWorkspace?: string;
  readonly authority: EgressAuthorityConfiguration;
}
type ReadMaterial = ProtectedRepositoryGitAuthority["online"]["readMaterial"];
type MaterialReader = {
  readOpenShellMaterial(
    ...args: [
      revisionId: RepositoryGitInstallationFence["revisionId"],
      signal: AbortSignal,
      route?: RepositoryGitInstallationFence | undefined,
      installationScope?: typeof githubInstallationProfile | "github-repository",
    ]
  ): Promise<
    | Awaited<ReturnType<ReadMaterial>>
    | ProtectedGitHubInstallationMaterial
    | ProtectedGitHubRepositoryMaterial
  >;
};
type OnlineGitOwner = MaterialReader & {
  authorizeOnlineRequest: OpenShellOnlineGitAuthorityOptions["authorizeOnlineRequest"];
};

/** The bundled sender cannot honor an exact-send permit. Both calls use only the online port. */
export function protectedOpenShellGitOwner(
  authority: ProtectedRepositoryGitAuthority,
  preview = false,
): OnlineGitOwner {
  const installationAuthority = preview
    ? authority.observedHook
    : authority.online.githubInstallation;
  return {
    readOpenShellMaterial: async (revisionId, signal, route, scope) => {
      const owner =
        scope === "github-repository"
          ? authority.online.githubRepository
          : scope === githubInstallationProfile
            ? installationAuthority
            : authority.online;
      return route?.revisionId === revisionId ? owner?.readMaterial(route, signal) : undefined;
    },
    authorizeOnlineRequest: async (request, installed, signal) => {
      const { route } = installed;
      if (!route) {
        return { kind: "denied", reason: "unavailable" };
      }
      if ("scope" in request && request.scope === "github-repository") {
        return (
          authority.online.githubRepository?.authorize(
            request,
            { ...installed, route },
            signal,
          ) ?? { kind: "denied", reason: "unavailable" }
        );
      }
      if ("scope" in request) {
        const owner = installationAuthority;
        if (owner) {
          const result = await owner.authorize(request, { ...installed, route }, signal);
          if (
            result.kind === "denied" ||
            (result.scope === request.scope &&
              result.operation === request.operation &&
              result.revisionId === route.revisionId &&
              result.fence === route.fence)
          ) {
            return result;
          }
        }
        return { kind: "denied", reason: "unavailable" };
      }
      return authority.online.authorize(request, { ...installed, route }, signal);
    },
  };
}

type MaterialIdentity =
  | Omit<ProtectedRepositoryGitMaterial, "value">
  | Omit<ProtectedGitHubInstallationMaterial, "value">
  | Omit<ProtectedGitHubRepositoryMaterial, "value">;

/** The route's state for one revision, as Compute readiness and operators see it. */
export type OpenShellGitRouteState =
  | { readonly state: "none" }
  | { readonly state: "bootstrapping" }
  | {
      readonly state: "pending";
      readonly reason: "unverified" | "awaiting_material" | "material_unavailable" | "unobserved";
      readonly failure?: OpenShellGitObservationFailure;
    }
  | { readonly state: "installed" }
  | { readonly state: "blocked"; readonly reason: OpenShellGitRouteBlockReason };

/**
 * What a route state means for Compute readiness. Prepared material is discovered and read
 * only for the Agent's active revision (the `sessions` snapshot in prepared-repository-git.ts),
 * so a deploying revision whose Sandbox route has verified waits as `awaiting_material` (no
 * material was ever installed) until it activates: it is ready to activate, and its material
 * installs within seconds after. Holding it would never end (finding 2139). A revision that
 * lost the material it had (`material_unavailable`) and every other pending state waits; a
 * blocked route fails.
 */
export function openShellGitRouteReadiness(
  route: OpenShellGitRouteState,
): "ready" | "pending" | "blocked" {
  if (route.state === "blocked") {
    return "blocked";
  }
  if (
    route.state === "installed" ||
    (route.state === "pending" && route.reason === "awaiting_material")
  ) {
    return "ready";
  }
  return "pending";
}

interface Entry extends OpenShellGitObservationEntry {
  readonly preview: ObservedHookPreview;
  continuityDiagnosticReported?: true;
  readonly bindingId: string;
  readonly authorization: RepositoryGitDeliveryBinding;
  /** The loss of material the route had was reported (on the first request it refused). */
  materialLost?: true | undefined;
  material?: MaterialIdentity;
  /**
   * The material this route last verified installed, and the wall-clock time of that
   * verification. OpenShell resets every connection of the Sandbox when it installs a
   * credential (finding 2141); activation waits for the node to be back after this time.
   */
  materialInstalled?:
    | {
        readonly materialVersion: string;
        readonly preparationAttemptId: string;
        readonly at: number;
      }
    | undefined;
  blocked?: OpenShellGitRouteBlockReason;
  /** Only this terminal record can be retried, never the uncertain preview operation. */
  previewClosure?:
    | {
        readonly fence: number;
        readonly reason: OpenShellGitRouteBlockReason;
        confirming?: Promise<void> | undefined;
        reportedPending?: true;
      }
    | undefined;
  nextRefreshAt?: number;
  /** Why the route is closed while nothing blocks it. */
  pending?: "unverified" | "material_unavailable" | undefined;
  /** The last failed read, kept until a read succeeds; `failures` sizes the backoff. */
  unobserved?:
    | {
        readonly failure: OpenShellGitObservationFailure;
        readonly since: number;
        readonly failures: number;
      }
    | undefined;
  nextObserveAt?: number | undefined;
  /** A provider write this worker reserved at this fence and never sent, whose cancellation
   * the store did not confirm: the next pass clears it before anything else. */
  unsentWrite?: number | undefined;
  /** The persisted route's adoption fence this worker holds. */
  fence: number;
  /** The snapshot last persisted for this fence, so the row is written only on change. */
  persisted?: OpenShellGitRouteSnapshot | undefined;
  /** Why the owner last had no material: the session is gone, or none is usable (finding 2149). */
  absent?: "withdrawn" | "unprepared" | undefined;
  /** A closed route's next Sandbox read, the reads that found it, whether the last found none,
   * and whether a read was refused by the worker's identity (reported once): release() drops
   * the entry once the Sandbox is gone (finding 2218). */
  release?:
    | { at: number; present: number; absent?: true | undefined; refused?: true | undefined }
    | undefined;
}
interface EntryState {
  entry?: Entry;
  failed?: true;
  /** The persisted route was a tombstone, or its adoption was refused with this reason. */
  blocked?: OpenShellGitRouteBlockReason;
}
/** The runtime image's PATH, then the draft helper's directory. The image's own `gh` stays
 * first: the broker `gh` shim beside the helper has no repository manifest in this sandbox. */
const OPENSHELL_GIT_DRAFT_PATH = `/app/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${REPOSITORY_CLIENT_BIN}`;
const binaries = [
  "/usr/bin/git",
  "/usr/lib/git-core/git-remote-https",
  "/usr/lib/git-core/git-remote-http",
  "/usr/libexec/git-core/git-remote-https",
  "/usr/libexec/git-core/git-remote-http",
  "/usr/bin/curl",
  "/usr/local/bin/node",
  "/usr/bin/node",
];
const OBSERVE_TIMEOUT_MS = 5000;
const REFRESH_INTERVAL_MS = 10_000;
// A failed read is observed again after 1 s, doubling to this cap. A replaced OpenShell
// Gateway Pod answers again within about 30 s; the route is back on the next read after that.
const OBSERVE_BACKOFF_CAP_MS = 10_000;
// A closed route's Sandbox is read after one refresh interval, doubling to this cap while it
// stays (a Sandbox retained after Git expiry can run for a long time).
const RELEASE_INTERVAL_CAP_MS = 60_000;
/** The revision's route is a tombstone: Compute fails the revision with that cause instead of
 * retrying a preparation that can never succeed (a new revision is required). */
/** The store closed the route at this worker's fence: another worker withdrew the revision or
 * expired its access, and the row already says why (finding 2218). */
class OpenShellGitRouteClosedError extends OpenShellGitRouteError {}

export class OpenShellGitRouteBlockedError extends Error {
  readonly reason: OpenShellGitRouteBlockReason;

  constructor(reason: OpenShellGitRouteBlockReason) {
    super(`OpenShell Git revision binding is unavailable: ${reason}.`);
    this.name = "OpenShellGitRouteBlockedError";
    this.reason = reason;
  }
}

/**
 * What the Agent is told for a lookup denial of one of this worker's routes (finding 2149). A
 * request from another Sandbox than an open route's stays generic: it is not that Agent. A
 * closed route answers every request for its binding the same way; the codes are not secret.
 */
function lookupReasonCode(reason: string, entry: Entry): OpenShellOnlineGitReasonCode | undefined {
  switch (reason) {
    case "execution_mismatch":
      return undefined;
    case "route_blocked":
      return entry.blocked === "withdrawn" || entry.blocked === "repository_expired"
        ? "access_withdrawn"
        : "route_blocked";
    case "material_unavailable":
      // The route had material and lost it: the session ended, or the owner retired the
      // material and cannot prepare more (for example a rejected App key).
      return entry.absent === "withdrawn" ? "access_withdrawn" : "credential_unavailable";
    default:
      // Pending, unobserved, rotated, expired, changed installation or an aborted lookup.
      return "route_not_ready";
  }
}

/** The provider generation a binding names: what the route store keeps of it. */
function generationOf(binding: OpenShellPreparedGitBinding): OpenShellPreparedGitGeneration {
  return {
    providerId: binding.providerId,
    profileVersion: binding.profileVersion,
    resourceVersion: binding.resourceVersion,
    expiresAt: binding.expiresAt,
    credentialState: binding.credentialState,
  };
}

/** Construct the same stock provider scope on initial preparation, observation and adoption. */
function gitProvider(
  client: OpenShellGatewayClient,
  workspace: string,
  workspaceId: string,
  sandbox: string,
  executionId: string,
  delivery: OpenShellPreparedGitDelivery,
  observedHookPreview?: true,
) {
  return new OpenShellPreparedGitProvider(client, {
    workspace,
    workspaceId,
    sandbox,
    executionId,
    ...delivery,
    ...(observedHookPreview && { observedHookPreview }),
    binaries: delivery.installationId
      ? [...binaries, "/usr/bin/gh", "/usr/local/bin/gh"]
      : binaries,
    gitOrigin: "https://github.com",
    apiOrigin: "https://api.github.com",
  });
}

function revisionIdentity(revision: Readonly<AgentRevision>): Readonly<Record<string, string>> {
  const binding = revision.repositoryCredentials?.bindings[0];
  return {
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    revisionId: revision.id,
    ...(binding === undefined ? {} : { repositoryRef: binding.repositoryRef }),
  };
}

/** A network policy or Agent network grant that would open a route beside the middleware. */
export interface OpenShellGitPolicyOverlap {
  readonly name: string;
  readonly host: string;
  /** The host is an IP address (or range), refused because it may reach GitHub (finding 2145). */
  readonly ipAddress: boolean;
}

/**
 * Whether a policy host names an IP address (private and loopback ones included) rather than a DNS
 * name: IPv6, bracketed or not, an address range, or IPv4, which, as for a URL parser, is any host
 * whose last label is numeric (so 0x8c.0x52.0x70.0x3 and 2354212867 count), or a wildcard over one.
 */
function isIpAddressHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  const address = (/^\[([^\]]*)\]/.exec(normalized)?.[1] ?? normalized).split("/")[0]!;
  if (isIP(address) !== 0) {
    return true;
  }
  const parts = address.split(":");
  const name = parts.length === 2 ? parts[0]! : address;
  return /^(?:0x[0-9a-f]*|[0-9]+)$/.test(name.slice(name.lastIndexOf(".") + 1));
}

/**
 * Worker-local authority over each revision's Git route. The route store (migration 0060)
 * keeps the identity and custody facts of every route this worker prepared. Live preparation
 * requires the store and closes persisted routes on adoption: a restarted or replacement
 * worker cannot inherit the held observation. A missing row with an existing Sandbox also
 * requires a new revision; labels alone cannot resume a provider write whose result was lost.
 */
export class OpenShellGitRuntime {
  private readonly entries = new Map<string, Promise<Entry>>();
  private readonly states = new Map<string, EntryState>();
  /** One reconcile pass's read budget; a provider write has its own deadline. */
  private observeTimeoutMs = OBSERVE_TIMEOUT_MS;
  private owner: OnlineGitOwner | undefined;
  private emit: RepositoryTransportEmit | undefined;
  private routes: OpenShellGitRouteStore | undefined;
  /** This worker process, as the persisted routes name their holder. */
  private readonly instance = randomUUID();
  private stopped = new AbortController();
  private running: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private server?: ReturnType<typeof createOpenShellOnlineGitAuthority>;
  readonly configuration: OpenShellGitRuntimeConfiguration;
  private readonly resolveDelivery: RepositoryGitDeliveryResolver;
  constructor(
    configuration: OpenShellGitRuntimeConfiguration,
    resolveDelivery: RepositoryGitDeliveryResolver,
  ) {
    this.configuration = configuration;
    this.resolveDelivery = resolveDelivery;
  }

  private scope(revision: Readonly<AgentRevision>) {
    const state = revision.repositoryCredentials;
    const binding = state?.bindings[0];
    if (
      !state ||
      (state.bindings.length !== 1 &&
        !state.bindings.every((b) => b.profile === "github-repository")) ||
      !binding ||
      revision.harness.id !== "codex" ||
      revision.harness.mode !== "dedicated" ||
      (revision.executionAdmission?.version === 6
        ? !this.configuration.observedHookPreviewWorkspace ||
          binding.profile !== githubInstallationProfile ||
          revision.egressPlan?.repositoryGitAuthorization !== observedRequestHook
        : revision.executionAdmission?.version !== 5 ||
          revision.egressPlan?.repositoryGitAuthorization !== "online-request" ||
          (binding.profile === githubInstallationProfile &&
            !!this.configuration.observedHookPreviewWorkspace)) ||
      !revision.egressPlan?.driver ||
      !isDeepStrictEqual(revision.egressPlan.repositoryGit, state) ||
      (binding.profile !== "git-write" &&
        binding.profile !== githubInstallationProfile &&
        binding.profile !== "github-repository")
    ) {
      throw new Error(missingAdmittedGitScope);
    }
    const scope = this.resolveDelivery(revision);
    if (!isDeepStrictEqual(scope.binding, binding)) {
      throw new Error("OpenShell Git delivery does not match the admitted binding.");
    }
    return scope;
  }

  /** A read of the same running installation. Only normal reconciliation may adopt one. */
  async verifyExecution(
    revision: Readonly<AgentRevision>,
    signal: AbortSignal,
    cold?: () => Promise<StandingGitExecution | undefined>,
  ) {
    if (this.states.get(revision.id)?.blocked !== undefined) {
      return;
    }
    const entry = await this.entries.get(revision.id);
    if (!entry && revision.executionAdmission?.version === 6) {
      return;
    }
    if (!entry && cold && revision.repositoryCredentials?.standingApprovalId) {
      // The worker verifies execution before it prepares a successor session or route. A new
      // process has neither a local entry nor authority to bootstrap here. Read
      // the known installation, including its original launch and both Pods, without taking
      // the route fence, asking for material, or changing any state in this worker.
      const saved = await this.routes?.standing(revision);
      const git = saved?.route.observed;
      const generation = saved?.route.generation;
      if (!saved || !git || !generation) {
        return;
      }
      const scope = this.scope(revision);
      const context = await cold();
      if (!context || git.workspace !== context.workspace || git.sandbox !== context.sandbox) {
        return;
      }
      const { client, workspace, sandbox, continuity } = context;
      const provider = gitProvider(
        client,
        workspace,
        await this.gateway(client, workspace, signal),
        sandbox,
        revision.id,
        scope.delivery,
      );
      const binding = provider.restore(generation, true);
      if (!(await provider.observePredecessor(binding, git, signal))) {
        return;
      }
      const box = await client.getSandbox({ workspace, name: sandbox }, signal);
      const hash = box && (await witnessOpenShellGitLaunch(client, continuity, box, git, signal));
      const identity = openShellGitExecutionIdentity(git);
      if (
        hash !== saved.retainedLaunchHash ||
        identity.fingerprint !== saved.executionFingerprint
      ) {
        return;
      }
      const current = await this.routes?.standing(revision);
      return !signal.aborted && !this.stopped.signal.aborted && isDeepStrictEqual(saved, current)
        ? identity
        : undefined;
    }
    if (
      !entry?.opened ||
      entry.blocked ||
      entry.unverified ||
      !isDeepStrictEqual(entry.revision, revision)
    ) {
      return;
    }
    if (!isDeepStrictEqual(this.scope(revision), entry.authorization)) {
      return;
    }
    await this.fenced(entry, signal);
    const observed = await this.observation(entry, signal, { predecessor: true });
    if (
      !observed ||
      !entry.sandboxId ||
      !entry.opened ||
      entry.blocked ||
      entry.unverified ||
      signal.aborted ||
      this.stopped.signal.aborted
    ) {
      return;
    }
    return openShellGitExecutionIdentity(observed);
  }

  /** The prepared owner already caps material at both session and provider expiry. */
  private materialIsLive(revision: Readonly<AgentRevision>, expiresAt: string) {
    const snapshot = revision.repositoryCredentials!;
    const now = Date.now();
    return (
      Date.parse(expiresAt) > now &&
      (snapshot.standingApprovalId !== undefined || snapshot.deadlineWallMs > now)
    );
  }

  async prepare(
    revision: Readonly<AgentRevision>,
    client: OpenShellGatewayClient,
    workspace: string,
    sandbox: string,
    signal: AbortSignal,
    otherProviders: readonly string[] = [],
    otherHosts: readonly string[] = [],
  ) {
    if (
      !revision.repositoryCredentials ||
      (revision.repositoryCredentials.deadlineWallMs <= Date.now() &&
        !revision.repositoryCredentials.standingApprovalId)
    ) {
      throw new Error("OpenShell prepared Git requires a live admitted GitHub binding.");
    }
    const scope = this.scope(revision);
    const executionId = revision.egressPlan?.execution?.executionId;
    if (!executionId) {
      throw new Error(missingAdmittedGitScope);
    }
    const legacyPreview = revision.executionAdmission?.version === 6;
    const mandatory =
      revision.egressPlan?.repositoryGitAuthorization === "online-request" &&
      scope.binding.profile !== githubInstallationProfile;
    // The bundled Proxy admits installation-wide Git only as explicit v6 preview.
    // Keep historical scope validation available to readonly and retirement paths.
    if (!legacyPreview && !mandatory) {
      throw new Error(missingAdmittedGitScope);
    }
    const routes = this.routes;
    if (
      (legacyPreview && workspace !== this.configuration.observedHookPreviewWorkspace) ||
      !routes
    ) {
      throw new Error(
        "The observed-hook preview requires its dedicated workspace and durable route owner.",
      );
    }
    if (otherHosts.some((host) => isIpAddressHost(host) || overlapsOpenShellGitHost(host))) {
      throw new Error("OpenShell Git cannot share overlapping network policy.");
    }
    if (!this.owner || this.stopped.signal.aborted) {
      throw new Error("OpenShell Git worker is unavailable.");
    }
    const state = this.states.get(revision.id);
    if (state?.blocked !== undefined) {
      throw new OpenShellGitRouteBlockedError(state.blocked);
    }
    let pending = this.entries.get(revision.id);
    if (!pending) {
      pending = (async (): Promise<Entry> => {
        // Close a route this worker did not prepare; a failed store read can be retried.
        const credentials = revision.repositoryCredentials!;
        const persisted = await read(
          () => routes.adopt(revision.id, this.instance, "close-preview"),
          signal,
        );
        if (persisted !== undefined) {
          // A restart cannot inherit this observation. Taking the fence also closed the route,
          // even if the old worker stopped before its terminal reason could be recorded.
          throw new OpenShellGitRouteBlockedError(persisted.blocked ?? "worker_replaced");
        }
        if (credentials.deadlineWallMs <= Date.now()) {
          throw new OpenShellGitRouteBlockedError("repository_expired");
        }
        // A read that fails here is read again on the next pass, nothing written (finding
        // 2210); a refused identity or an overlapping provider is final.
        await read(
          () => checkOpenShellGitProviders(client, workspace, otherProviders, signal),
          signal,
        );
        const current = await read(
          () => client.getSandbox({ workspace, name: sandbox }, signal),
          signal,
        );
        if (current) {
          // The rejected bootstrap is retained below, so this logs once per revision while
          // every later pass (maintenance included) rethrows the same failure. The Sandbox
          // predates the route store (or its route was removed): nothing says which
          // generation this worker's predecessor wrote, so nothing is adopted.
          this.emit?.({
            event: "worker.error",
            code: "OPENSHELL_GIT_RECONCILIATION_REQUIRED",
            reason: "worker_restarted",
            ...revisionIdentity(revision),
          });
          throw new Error("OpenShell Git requires a new revision after worker restart.");
        }
        const provider = gitProvider(
          client,
          workspace,
          await read(() => this.gateway(client, workspace, signal), signal),
          sandbox,
          revision.id,
          scope.delivery,
          true,
        );
        const bindingId = executionId;
        const route = {
          revisionId: revision.id,
          namespaceId: revision.namespaceId,
          agentId: revision.agentId,
          workspace,
          sandbox,
          bindingId,
        };
        // The route is on record, with its bootstrap write pending, before the write: a
        // worker that finds the write still pending knows its outcome was lost. A store
        // that does not answer here is read again on the next pass, nothing written.
        const fence = 1;
        await read(() => routes.open(route, this.instance), signal);
        if (credentials.deadlineWallMs <= Date.now()) {
          // The initial deadline passed while recording intent; this worker has not sent a write.
          await this.routes?.block(revision.id, fence, "repository_expired").catch(() => {});
          throw new OpenShellGitRouteBlockedError("repository_expired");
        }
        let binding: OpenShellPreparedGitBinding;
        try {
          binding = await provider.bootstrap(signal);
        } catch (error) {
          if (error instanceof OpenShellPreparedGitProviderError && error.outcome === "refused") {
            // Nothing was written: the row says so, instead of outliving this attempt as a
            // pending write (which a later worker would have to read as write_unknown).
            await this.routes?.block(revision.id, fence, "bootstrap_failed").catch(() => {});
          }
          throw error;
        }
        const entry: Entry = {
          revision,
          client,
          provider,
          binding,
          authorization: structuredClone(scope),
          otherProviders: [...otherProviders],
          bindingId,
          preview: new ObservedHookPreview(workspace, bindingId, mandatory),
          fence,
        };
        // The written generation is recorded now; a store that does not answer leaves the
        // bootstrap marked pending until the next verified pass records it (a worker that
        // restarts before then tombstones the route as write_unknown).
        await this.persist(entry, signal).catch(() => {});
        return entry;
      })();
      // Retain a rejected bootstrap as a stopped attempt, never silently replay its writes.
      this.entries.set(revision.id, pending);
      const state: EntryState = {};
      this.states.set(revision.id, state);
      void pending.then(
        (entry) => {
          state.entry = entry;
        },
        (error) => {
          if (error instanceof OpenShellGitRouteBlockedError) {
            state.blocked = error.reason;
          } else if (error instanceof OpenShellGitObservationError) {
            // Nothing was written (a store or gateway that did not answer): the next pass
            // reads the store and the gateway again.
            this.entries.delete(revision.id);
            this.states.delete(revision.id);
          } else {
            state.failed = true;
          }
        },
      );
    }
    const entry = await pending;
    if (entry.blocked) {
      throw new OpenShellGitRouteBlockedError(entry.blocked);
    }
    if (
      entry.client !== client ||
      entry.binding.workspace !== workspace ||
      entry.binding.sandbox !== sandbox ||
      !isDeepStrictEqual(entry.otherProviders, otherProviders) ||
      !isDeepStrictEqual(entry.revision, revision) ||
      !isDeepStrictEqual(entry.authorization, scope)
    ) {
      throw new Error("OpenShell Git revision binding is unavailable.");
    }
    // `oce-github pr-create --draft` runs from the image's repository client; Landlock and
    // PATH must admit it only where the grant allows a draft.
    const draft = scope.repository?.draftPullRequest;
    const resuming = revision.repositoryCredentials.deadlineWallMs <= Date.now();
    if (
      resuming &&
      (!entry.opened || !entry.sandboxId || !revision.repositoryCredentials.standingApprovalId)
    ) {
      throw new OpenShellGitRouteBlockedError("repository_expired");
    }
    return {
      ...(resuming && { existingSandboxId: entry.sandboxId }),
      provider: entry.binding.provider,
      readOnlyPaths: draft ? [dirname(REPOSITORY_CLIENT_BIN)] : [],
      environment: [
        ...(draft ? [{ name: "PATH", value: OPENSHELL_GIT_DRAFT_PATH }] : []),
        ...(scope.repository
          ? [
              { name: "OCE_OPENSHELL_GIT_REPOSITORY", value: scope.delivery.repository },
              { name: "OCE_OPENSHELL_GIT_PUSH_REF", value: scope.repository.pushRef },
              { name: "OCE_OPENSHELL_GIT_API_ORIGIN", value: "https://api.github.com" },
              ...(scope.repository.pullRequestBase
                ? [{ name: "OCE_OPENSHELL_GIT_BASE", value: scope.repository.pullRequestBase }]
                : []),
            ]
          : []),
        { name: "GIT_TERMINAL_PROMPT", value: "0" },
        { name: "GIT_CONFIG_COUNT", value: "5" },
        { name: "GIT_CONFIG_KEY_0", value: "credential.helper" },
        { name: "GIT_CONFIG_VALUE_0", value: "" },
        {
          name: "GIT_CONFIG_KEY_1",
          value: `credential.https://github.com${entry.authorization.delivery.repository ? "/" + entry.authorization.delivery.repository + ".git" : ""}.helper`,
        },
        {
          name: "GIT_CONFIG_VALUE_1",
          value: "!f() { printf '%s\\n' 'username=x-access-token' \"password=$GITHUB_TOKEN\"; }; f",
        },
        { name: "GIT_CONFIG_KEY_2", value: "http.followRedirects" },
        { name: "GIT_CONFIG_VALUE_2", value: "false" },
        { name: "GIT_CONFIG_KEY_3", value: "http.sslVerify" },
        { name: "GIT_CONFIG_VALUE_3", value: "true" },
        { name: "GIT_CONFIG_KEY_4", value: "credential.useHttpPath" },
        { name: "GIT_CONFIG_VALUE_4", value: "true" },
      ],
      middlewares: openShellGitMiddleware(this.configuration.registrationName, entry.bindingId),
    };
  }

  /** The gateway this route runs through: the middleware is registered and the workspace
   * has an identity. Answers the workspace id. */
  private async gateway(
    client: OpenShellGatewayClient,
    workspace: string,
    signal: AbortSignal,
  ): Promise<string> {
    const info = await client.getGatewayInfo?.(signal);
    if (
      !Array.isArray(info?.extensions) ||
      !info.extensions.some((value) => {
        const extension = value as Record<string, unknown>;
        return (
          extension.configured_name === this.configuration.registrationName &&
          [4, "EXTENSION_KIND_SUPERVISOR_MIDDLEWARE"].includes(extension.kind as string | number) &&
          extension.protocol_major === 1
        );
      })
    ) {
      throw new Error("OpenShell Git middleware is not registered with the selected gateway.");
    }
    const ws = await client.getWorkspace(workspace, signal);
    if (!ws?.id) {
      throw new Error("OpenShell Git workspace identity is unavailable.");
    }
    return ws.id;
  }

  /** The route as this worker now holds it, written when it differs from the last write.
   * A stale fence means another worker adopted the route: this one closes it. */
  private async persist(entry: Entry, signal: AbortSignal): Promise<void> {
    const routes = this.routes;
    const fence = entry.fence;
    if (routes === undefined) {
      return;
    }
    const snapshot: OpenShellGitRouteSnapshot = {
      generation: generationOf(entry.binding),
      material: entry.material && {
        materialVersion: entry.material.materialVersion,
        preparationAttemptId: entry.material.preparationAttemptId,
      },
      observed: entry.supervisor,
      ...(entry.retainedLaunchHash && { retainedLaunchHash: entry.retainedLaunchHash }),
    };
    if (isDeepStrictEqual(snapshot, entry.persisted)) {
      return;
    }
    if (!(await read(() => routes.record(entry.revision.id, fence, snapshot), signal))) {
      throw await this.refusal(entry, fence, signal);
    }
    entry.persisted = snapshot;
  }

  /**
   * Why the store refused this holder, as the error that closes the route. A route closed at
   * this fence names its own reason: another worker withdrew the revision or expired its
   * access, and the Agent is told so (finding 2218). Otherwise another worker took it over.
   */
  private async refusal(
    entry: Entry,
    fence: number,
    signal: AbortSignal,
    held?: boolean | OpenShellGitRouteBlockReason,
  ): Promise<OpenShellGitRouteError> {
    held ??= await read(() => this.routes!.owns(entry.revision.id, fence), signal);
    return typeof held === "string"
      ? new OpenShellGitRouteClosedError(held, "OpenShell Git route was closed by another worker.")
      : new OpenShellGitRouteError(
          "worker_replaced",
          "OpenShell Git route was adopted by another worker.",
        );
  }

  /** Whether this worker still holds the route; a provider write is marked before it runs. */
  private async fenced(
    entry: Entry,
    signal: AbortSignal,
    write?: "rotate",
    material?: OpenShellGitMaterialReference,
  ): Promise<void> {
    const routes = this.routes;
    const fence = entry.fence;
    if (routes === undefined) {
      return;
    }
    if (write === undefined) {
      const held = await read(() => routes.owns(entry.revision.id, fence), signal);
      if (held !== true) {
        throw await this.refusal(entry, fence, signal, held);
      }
      return;
    }
    const reserved = await read(
      () => routes.writing(entry.revision.id, fence, write, material),
      signal,
    );
    if (reserved === undefined) {
      throw await this.refusal(entry, fence, signal);
    }
    entry.fence = reserved;
  }

  /**
   * Clears this worker's own write reservation, proven unsent. A store that does not answer
   * leaves it reserved: the entry remembers it, and the next pass clears it before anything
   * else, so a store outage never turns an unsent write into an unknown one.
   */
  private async cancelWriting(entry: Entry, signal: AbortSignal): Promise<void> {
    const routes = this.routes;
    const fence = entry.fence;
    if (routes === undefined) {
      return;
    }
    const retry = entry.unsentWrite === fence;
    entry.unsentWrite = fence;
    if (!(await read(() => routes.cancelWriting(entry.revision.id, fence), signal))) {
      if (!retry) {
        throw new OpenShellGitRouteError(
          "write_unknown",
          "Cannot confirm cancellation of the unsent write.",
        );
      }
      // The earlier attempt committed and only its answer was lost: a fence this worker still
      // holds has no write pending. Another worker's fence stops this one.
      await this.fenced(entry, signal);
    }
    entry.unsentWrite = undefined;
  }

  async bind(
    revisionId: string,
    verify: (sandbox: OpenShellSandboxResponse) => void,
    continuity?: OpenShellGitContinuity,
  ): Promise<void> {
    const entry = await this.entries.get(revisionId);
    if (!entry || entry.blocked) {
      throw new Error("OpenShell Git has no admitted bootstrap.");
    }
    entry.verify = verify;
    if (continuity) {
      entry.continuity = continuity;
    }
  }

  /** Perform the one challenge while the launcher is held. Lost results are not replayed. */
  async observeHeldPreview(
    revisionId: string,
    startupId: string,
    signal: AbortSignal,
    probe: (path: string) => Promise<unknown>,
  ): Promise<"held" | "installed" | undefined> {
    const entry = this.states.get(revisionId)?.entry;
    const preview = entry?.preview;
    if (!preview || !entry || entry.blocked || !preview.recipient || !entry.supervisor) {
      return;
    }
    if (preview.hook && preview.hook.startupId !== startupId) {
      try {
        this.reportContinuity(entry, [
          {
            check: "held-startup-recorded",
            keyHash: createHash("sha256").update(preview.hook.startupId).digest("hex"),
          },
          {
            check: "held-startup-observed",
            keyHash: createHash("sha256").update(startupId).digest("hex"),
          },
        ]);
      } catch {
        // Hash/report failures do not change the original startup-identity refusal.
      }
      this.block(entry, "execution_replaced");
      return;
    }
    if (!preview.hook) {
      if (entry.material || entry.binding.credentialState !== "bootstrap" || entry.fence !== 1) {
        return;
      }
      await this.fenced(entry, signal);
      const before = await this.observation(entry, signal);
      if (!before || !isDeepStrictEqual(before, entry.supervisor)) {
        return;
      }
      try {
        const path = preview.arm(startupId, entry.authorization.delivery.repository);
        preview.confirm(await probe(path));
        await this.fenced(entry, signal);
      } catch (error) {
        this.block(entry, "bootstrap_failed");
        throw error;
      }
    }
    const observed = await this.observation(entry, signal);
    if (
      !observed ||
      !preview.hook ||
      (!preview.mandatory && !observed.observedHook) ||
      entry.blocked
    ) {
      return;
    }
    if (observed.credentialState === "active") {
      return entry.installed && isDeepStrictEqual(entry.installed, observed)
        ? "installed"
        : undefined;
    }
    entry.supervisor = observed;
    await this.persist(entry, signal);
    return "held";
  }

  /** Deliver one release, and open ordinary authorization only on the same launcher's ACK.
   * A lost response may mean the workload started. Block and retire this family, never resend. */
  async releasePreview(
    revisionId: string,
    startupId: string,
    deliver: () => Promise<boolean>,
  ): Promise<void> {
    const entry = this.states.get(revisionId)?.entry;
    const preview = entry?.preview;
    if (
      !preview?.hook ||
      !entry ||
      entry.blocked ||
      !entry.installed ||
      preview.release ||
      preview.hook.startupId !== startupId ||
      (!preview.mandatory && !isDeepStrictEqual(entry.installed.observedHook, preview.hook))
    ) {
      throw new Error("Cannot release this preview startup.");
    }
    preview.release = "sending";
    try {
      if (!(await deliver()) || entry.blocked) {
        throw new Error("The preview release was not acknowledged.");
      }
      preview.release = "acknowledged";
    } catch (error) {
      this.block(entry, "preview_release_unconfirmed");
      throw error;
    }
  }

  previewReleased(revisionId: string): boolean {
    const entry = this.states.get(revisionId)?.entry;
    return !entry?.blocked && entry?.preview.release === "acknowledged";
  }

  /** Read, never adopt, the exact current observation. Material selection and later use are
   * independently fenced in PostgreSQL. A change after a write may leave a usable token. */
  async mandatoryEnforcement(context: ProxyRevisionContext, sandboxId: string) {
    const entry = this.states.get(context.revision.id)?.entry;
    if (
      !entry?.preview.mandatory ||
      !entry.preview.hook ||
      entry.blocked ||
      entry.sandboxId !== sandboxId ||
      context.plan.repositoryGitAuthorization !== "online-request"
    ) {
      return;
    }
    await this.fenced(entry, context.signal);
    const current = await this.observation(entry, context.signal);
    if (!current || !entry.continuity) {
      return;
    }
    const box = await entry.client.getSandbox(
      { workspace: entry.binding.workspace, name: entry.binding.sandbox },
      context.signal,
    );
    if (!box) {
      return;
    }
    const recipient = await previewPolicyAndRecipient({
      mandatory: true,
      client: entry.client,
      sandbox: box,
      observed: current,
      registration: this.configuration.registrationName,
      audience: this.configuration.authority.audience,
      gitRule: entry.provider.previewNetworkRule(),
      modelProvider: entry.continuity.model,
      workload: entry.continuity.workload,
      signal: context.signal,
    });
    if (!recipient || entry.preview.recipient !== recipient) {
      return;
    }
    const { providerId, attachmentEpoch, processInstanceId, networkInstanceId } = current;
    return {
      instanceId: networkInstanceId,
      policyHash: current.policyHash,
      authorityScope: "execution" as const,
      configurationId: recipient,
      repositoryGitRecipient: {
        providerId,
        attachmentEpoch,
        processInstanceId,
        networkInstanceId,
        authorization: "online-request" as const,
        ...(entry.authorization.binding.profile === "github-repository" && {
          deliveryProfile: "github_repository" as const,
        }),
      },
    };
  }

  async previewEnforcement(context: ProxyRevisionContext, sandboxId: string) {
    const entry = this.states.get(context.revision.id)?.entry;
    const preview = entry?.preview;
    if (!preview?.hook || !entry || entry.blocked || entry.sandboxId !== sandboxId) {
      return;
    }
    await this.fenced(entry, context.signal);
    const current = await this.observation(entry, context.signal);
    if (current && isDeepStrictEqual(current, entry.supervisor)) {
      return preview.enforcement(context, current);
    }
  }

  async retireExpiredRepositoryAccess(
    revision: Readonly<AgentRevision>,
    client: OpenShellGatewayClient,
    workspace: string,
    sandbox: string,
    owner: OpenShellGitContinuity,
    signal: AbortSignal,
  ): Promise<OpenShellGitExpiryResult> {
    const credentials = revision.repositoryCredentials;
    if (!this.routes || !this.owner || !credentials) {
      return "retire-runtime";
    }
    if (!credentials.standingApprovalId) {
      if (credentials.deadlineWallMs > Date.now()) {
        return "retire-runtime";
      }
      try {
        // A finite grant substitution remains a refusal even if first seen after the deadline.
        this.scope(revision);
      } catch {
        return "retire-runtime";
      }
    }
    // Standing withdrawal may precede the first deadline, or be caused by removal of the
    // policy itself. The store requires the exact durable withdrawal and original installation;
    // asking for current Git permission here would prevent subtracting that permission.
    const saved = await this.routes.expire(revision, workspace, sandbox);
    if (!saved) {
      return "retire-runtime";
    }
    const entry = this.states.get(revision.id)?.entry;
    if (entry) {
      entry.blocked = "repository_expired";
      entry.installed = undefined;
    }
    return subtractExpiredOpenShellGit(
      this.routes,
      saved,
      client,
      owner,
      signal,
      async (providers) => {
        try {
          await checkOpenShellGitProviders(client, workspace, providers, signal);
          return true;
        } catch (error) {
          if (error instanceof OpenShellGitRouteError) {
            return false;
          }
          throw error; // a failed read is not a finding about the retained authority
        }
      },
      (outcome, check, failure) =>
        this.emit?.({
          event: "worker.openshell-git-expiry",
          ...revisionIdentity(revision),
          outcome,
          check,
          ...(failure === undefined ? {} : { failure }),
        }),
    );
  }

  /**
   * Deletes the revision's Git provider and its profile (finding 2206). The Sandbox Driver calls
   * this only after withdraw() and after OpenShell confirms the revision's Sandbox gone, so no
   * route can use the provider again: in this process the entry is blocked, and adoption by any
   * other worker finds neither the Sandbox nor the provider (the store's tombstone, written best
   * effort, refuses it earlier). The name derives from the revision's own scope, as at
   * preparation, so a restarted worker finds
   * it too. `attached`, the Sandbox's provider list read before its deletion, names it when the
   * scope no longer resolves (its grant or standing approval was withdrawn, often the reason the
   * revision stopped) or derives another name (an upgrade changed the scope's inputs). A
   * provider neither names (an earlier pass deleted the Sandbox, or the Sandbox detached it at
   * expiry) is left to Namespace cleanup.
   */
  async removeProvider(
    revision: Readonly<AgentRevision>,
    client: OpenShellGatewayClient,
    workspace: string,
    sandbox: string,
    attached: readonly string[],
    signal: AbortSignal,
  ): Promise<void> {
    let delivery: OpenShellPreparedGitDelivery | undefined;
    try {
      delivery = this.scope(revision).delivery;
    } catch {
      delivery = undefined;
    }
    if (delivery !== undefined) {
      const current = await client.getWorkspace(workspace, signal);
      if (current?.id) {
        await gitProvider(client, workspace, current.id, sandbox, revision.id, delivery).remove(
          signal,
        );
      }
    }
    // The derived provider is gone by now, so this finds only another prepared Git provider the
    // Sandbox attached; deleteOpenShellPreparedGitProvider skips every provider that is not one.
    for (const name of attached) {
      const provider = await client.getProvider(workspace, name, signal);
      if (provider !== undefined) {
        await deleteOpenShellPreparedGitProvider(client, workspace, provider, signal);
      }
    }
  }

  withdraw(revisionId: string): void {
    // Keep the tombstone to prevent adoption/recreation under the same execution identity,
    // in this process and, through the store, in any later one. The entry itself is dropped
    // once its Sandbox is gone; its reason stays.
    void this.entries.get(revisionId)?.then(
      (entry) => {
        entry.blocked ??= "withdrawn";
        entry.installed = undefined;
      },
      () => {},
    );
    this.recordWithdrawal({ revisionId });
  }

  withdrawNamespace(namespaceId: string): void {
    for (const pending of this.entries.values()) {
      void pending.then(
        (entry) => {
          if (entry.revision.namespaceId === namespaceId) {
            entry.blocked ??= "withdrawn";
            entry.installed = undefined;
          }
        },
        () => {},
      );
    }
    this.recordWithdrawal({ namespaceId });
  }

  /** The store's tombstone keeps any other worker from adopting the routes; this process's
   * own tombstone already refuses them, so a store that does not answer is reported only. */
  private recordWithdrawal(selector: OpenShellGitRouteWithdrawal): void {
    void this.routes?.withdraw(selector).catch((error: unknown) => {
      this.emit?.({
        event: "worker.error",
        code: "OPENSHELL_GIT_WITHDRAWAL_UNRECORDED",
        ...selector,
        cause: error instanceof Error ? error.name : "unknown",
      });
    });
  }

  /**
   * The route's state for a revision this worker prepared. Compute readiness holds a
   * revision until the route is verified (installed, or awaiting its first material, which
   * is issued only once the revision is active) and fails it while the route is blocked, so
   * a deployment never reports success over a route that cannot open (findings 2136, 2139).
   */
  route(revisionId: string): OpenShellGitRouteState {
    const state = this.states.get(revisionId);
    if (state === undefined) {
      return { state: "none" };
    }
    if (state.blocked !== undefined) {
      return { state: "blocked", reason: state.blocked };
    }
    if (state.failed) {
      return { state: "blocked", reason: "bootstrap_failed" };
    }
    const entry = state.entry;
    if (entry === undefined) {
      return { state: "bootstrapping" };
    }
    if (entry.blocked) {
      return { state: "blocked", reason: entry.blocked };
    }
    if (entry.installed) {
      return { state: "installed" };
    }
    if (entry.unobserved) {
      return { state: "pending", reason: "unobserved", failure: entry.unobserved.failure };
    }
    if (entry.pending === "material_unavailable" && entry.material === undefined) {
      return { state: "pending", reason: "awaiting_material" };
    }
    return { state: "pending", reason: entry.pending ?? "unverified" };
  }

  /**
   * When the route last verified its current material installed (wall-clock ms), or
   * undefined while it is not installed or verified other material. Installing a credential
   * makes OpenShell 0.1.4 reload the Sandbox's policy runtime, which closes every connection
   * out of the Sandbox, the workspace node's included (finding 2141); Compute activation
   * waits for the node to be connected again after this time.
   */
  materialInstalledAt(revisionId: string): number | undefined {
    const entry = this.states.get(revisionId)?.entry;
    const installed = entry?.materialInstalled;
    if (
      entry?.installed === undefined ||
      entry.blocked !== undefined ||
      installed === undefined ||
      entry.material?.materialVersion !== installed.materialVersion ||
      entry.material.preparationAttemptId !== installed.preparationAttemptId
    ) {
      return undefined;
    }
    return installed.at;
  }

  /**
   * The first policy that also reaches GitHub (github.com or a name under it), which only the
   * middleware route may. An
   * IP-address host counts too: the Controller cannot tell whether it leads to GitHub, so it is
   * refused outright rather than tracked against GitHub's published ranges (finding 2145).
   */
  overlappingPolicy(
    policies: readonly {
      readonly name: string;
      readonly endpoints: readonly { readonly host: string }[];
    }[],
  ): OpenShellGitPolicyOverlap | undefined {
    for (const policy of policies) {
      for (const { host } of policy.endpoints) {
        if (isIpAddressHost(host)) {
          return { name: policy.name, host, ipAddress: true };
        }
        if (overlapsOpenShellGitHost(host)) {
          return { name: policy.name, host, ipAddress: false };
        }
      }
    }
    return undefined;
  }

  private observation(
    entry: Entry,
    signal: AbortSignal,
    options: { readonly adopt?: boolean; readonly predecessor?: boolean } = {},
  ): Promise<OpenShellPreparedGitInstalled | undefined> {
    return observeOpenShellGitInstallation(entry, signal, {
      ...options,
      configuration: this.configuration,
      verifyFence: () => this.fenced(entry, signal),
      reportEnvironmentLag: () =>
        this.emit?.({
          event: "worker.openshell-git-route-warning",
          status: "pending",
          reason: "environment_not_installed",
          ...this.identity(entry),
        }),
      reportSupervisorChange: (check) =>
        this.reportContinuity(entry, [{ check, result: "changed" }]),
      reportExecutionChange: ({ restartCount, neverRestartPolicy, sandboxIdChanged }) =>
        this.reportContinuity(entry, [
          { check: "sandbox-restart-count", result: restartCount ?? "invalid" },
          { check: "sandbox-restart-policy-never", result: neverRestartPolicy },
          { check: "sandbox-id-changed", result: sandboxIdChanged },
        ]),
    });
  }

  private reportContinuity(
    entry: Entry,
    checks: readonly Readonly<Record<string, string | number | boolean>>[],
  ): void {
    if (entry.continuityDiagnosticReported) {
      return;
    }
    entry.continuityDiagnosticReported = true;
    try {
      for (const check of checks) {
        this.emit?.({
          event: "worker.openshell-git-continuity-refused",
          ...check,
          ...this.identity(entry),
        });
      }
    } catch {
      // Preserve the first failed comparison; a failing sink never changes the guard.
    }
  }

  private identity(entry: Entry): Readonly<Record<string, string>> {
    return revisionIdentity(entry.revision);
  }

  private pending(entry: Entry, reason: "unverified" | "material_unavailable"): void {
    entry.installed = undefined;
    entry.pending = reason;
    entry.unobserved = undefined;
    entry.nextObserveAt = undefined;
  }

  private installedNow(entry: Entry, installed: OpenShellPreparedGitInstalled): void {
    entry.installed = installed;
    entry.nextRefreshAt = performance.now() + REFRESH_INTERVAL_MS;
    entry.pending = undefined;
    entry.unobserved = undefined;
    entry.nextObserveAt = undefined;
    entry.materialLost = undefined;
    entry.opened = true;
    const reconnected = entry.reconnected;
    const restoredAt = entry.closedAt ?? reconnected?.since;
    if (restoredAt !== undefined) {
      const reason = reconnected === undefined ? undefined : "supervisor_reconnected";
      this.emit?.({
        event: "worker.openshell-git-route",
        status: "restored",
        ...(reason === undefined ? {} : { reason }),
        durationMs: Math.round(performance.now() - restoredAt),
        ...this.identity(entry),
      });
      entry.closedAt = undefined;
      entry.reconnected = undefined;
    }
  }

  /** Closes the route for good and reports why; the entry is a tombstone from here on, in
   * this process and, unless another worker holds the route now, in the store. */
  private block(entry: Entry, reason: OpenShellGitRouteBlockReason, reported = false): void {
    if (entry.blocked) {
      return;
    }
    entry.blocked = reason;
    entry.installed = undefined;
    entry.unobserved = undefined;
    entry.closedAt = undefined;
    entry.reconnected = undefined;
    if (reason === "worker_replaced") {
      // This worker no longer holds the route: drop this copy without writing its row.
      if (this.entries.get(entry.revision.id) !== undefined) {
        this.entries.delete(entry.revision.id);
        this.states.delete(entry.revision.id);
      }
      this.emit?.({
        event: "worker.openshell-git-route-warning",
        status: "closed",
        reason,
        ...this.identity(entry),
      });
      return;
    }
    if (reported) {
      // Another worker closed the route in the store (withdrawal or expiry), and the row already
      // says why. The entry stays, so the Agent is told access_withdrawn, until its Sandbox is
      // gone (finding 2218).
      this.emit?.({
        event: "worker.openshell-git-route-warning",
        status: "closed",
        reason,
        ...this.identity(entry),
      });
      return;
    }
    entry.previewClosure = { reason, fence: entry.fence };
    void this.confirmPreviewClosure(entry);
    this.emit?.({
      event: "worker.error",
      code: "OPENSHELL_GIT_RECONCILIATION_REQUIRED",
      reason,
      ...this.identity(entry),
    });
  }

  /**
   * Keep authorization closed until the credential owner's retirement signal is durable or superseded.
   */
  private confirmPreviewClosure(entry: Entry): Promise<void> | undefined {
    const closure = entry.previewClosure;
    if (!closure) {
      return;
    }
    const { fence, reason } = closure;
    const report = (status: "pending" | "confirmed" | "superseded") =>
      this.emit?.({
        event: "worker.openshell-preview-closure",
        status,
        reason,
        fence,
        ...this.identity(entry),
      });
    return (closure.confirming ??= this.routes!.confirmPreviewBlocked(
      entry.revision.id,
      this.instance,
      fence,
      reason,
    )
      .then(
        (status) => {
          entry.previewClosure = undefined;
          report(status);
        },
        () => {
          if (!closure.reportedPending) {
            closure.reportedPending = true;
            report("pending");
          }
        },
      )
      .finally(() => {
        closure.confirming = undefined;
      }));
  }

  /**
   * Classifies a failed reconcile or lookup. The runtime's own verifications and an unknown
   * provider write block the route: no retry, replacement, or token replay. A failed read
   * only closes it until the next successful observation, with a bounded backoff.
   */
  private failed(entry: Entry, error: unknown, signal: AbortSignal): void {
    if (entry.blocked) {
      entry.installed = undefined;
      return;
    }
    let failure: OpenShellGitObservationFailure | undefined;
    if (error instanceof OpenShellGitRouteError) {
      this.block(entry, error.reason, error instanceof OpenShellGitRouteClosedError);
      return;
    }
    if (error instanceof OpenShellPreparedGitProviderError) {
      if (error.outcome === "unknown") {
        this.block(entry, "write_unknown");
        return;
      }
      // A refused write wrote nothing. Refused because the gateway did not answer, it is
      // observed again; refused for any other reason, the provider no longer verifies.
      failure = error.readFailure;
      if (failure === undefined) {
        this.block(entry, "write_refused");
        return;
      }
    } else {
      failure = classifyOpenShellGitObservationFailure(error, signal);
      if (failure === undefined) {
        this.block(entry, "unknown");
        return;
      }
    }
    if (entry.installed) {
      entry.closedAt ??= performance.now();
    }
    entry.installed = undefined;
    const failures = (entry.unobserved?.failures ?? 0) + 1;
    entry.unobserved = {
      failure,
      since: entry.unobserved?.since ?? performance.now(),
      failures,
    };
    entry.nextObserveAt =
      performance.now() + Math.min(1000 * 2 ** (failures - 1), OBSERVE_BACKOFF_CAP_MS);
    if (failures === 1) {
      this.emit?.({
        event: "worker.openshell-git-route-warning",
        status: "unobserved",
        reason: failure,
        ...this.identity(entry),
      });
    }
  }

  private async reconcile(entry: Entry): Promise<void> {
    if (entry.blocked) {
      await this.confirmPreviewClosure(entry);
      await this.release(entry);
      return;
    }
    if (!entry.verify || !this.owner) {
      return;
    }
    const now = performance.now();
    if (entry.preview.verifyInstallBy !== undefined && now >= entry.preview.verifyInstallBy) {
      // The write may already be usable. A terminal tombstone makes this exact preview
      // family eligible for its owner's normal retirement, not a new installation attempt.
      this.block(entry, "preview_install_unverified");
      return;
    }
    if (entry.installed ? now < (entry.nextRefreshAt ?? 0) : now < (entry.nextObserveAt ?? 0)) {
      return;
    }
    const signal = AbortSignal.any([
      this.stopped.signal,
      AbortSignal.timeout(this.observeTimeoutMs),
    ]);
    try {
      // Another worker may have adopted the route meanwhile (finding 2128).
      await this.fenced(entry, signal);
      if (entry.unsentWrite !== undefined) {
        await this.cancelWriting(entry, signal);
      }
      // Observe the bootstrap supervisor before delivering the first usable credential.
      const observed = await this.observation(entry, signal, { adopt: true, predecessor: true });
      if (!observed) {
        this.pending(entry, "unverified");
        return;
      }
      // Commit the observed generation before the credential owner selects exactly that row.
      await this.persist(entry, signal);
      if (!entry.preview.hook) {
        return;
      }
      const owner = this.owner;
      const install = entry.revision.egressPlan?.repositoryGit
        ? { revisionId: entry.revision.id, fence: entry.fence, observed: entry.supervisor }
        : undefined;
      const scopeName =
        "scope" in entry.authorization.delivery
          ? entry.authorization.delivery.scope
          : entry.authorization.delivery.installationId
            ? githubInstallationProfile
            : undefined;
      const readMaterial = (route = install) =>
        owner.readOpenShellMaterial(entry.revision.id, signal, route, scopeName);
      const material = await read(readMaterial, signal);
      if (!material || "absent" in material) {
        entry.absent = material?.absent;
        if (entry.material) {
          // The route lost the material it had: the owner retired it (the App key was
          // rotated or rejected and preparation is quarantined, access was withdrawn, or a
          // newer version is active and this one is about to be withdrawn). The restoration
          // reports the outage's length; the first request refused meanwhile reports the
          // loss (finding 2135).
          entry.closedAt ??= performance.now();
        }
        this.pending(entry, "material_unavailable");
        await this.persist(entry, signal);
        return;
      }
      entry.absent = undefined;
      let scope: ReturnType<OpenShellGitRuntime["scope"]>;
      try {
        scope = this.scope(entry.revision);
      } catch (error) {
        throw new OpenShellGitRouteError(
          "grant_changed",
          "OpenShell Git delivery is no longer authorized by Repo.",
          error,
        );
      }
      const { binding, repository } = scope;
      if (
        !isDeepStrictEqual(scope, entry.authorization) ||
        ("scope" in material
          ? material.scope !== scopeName ||
            material.installationId !== entry.authorization.delivery.installationId ||
            (material.scope === "github-repository" &&
              (!("repositories" in entry.authorization.delivery) ||
                !isDeepStrictEqual(
                  material.repositories,
                  entry.authorization.delivery.repositories,
                )))
          : !repository ||
            material.repository !== entry.authorization.delivery.repository ||
            material.repositoryId !== binding.grant.repositoryId ||
            material.pushRef !== repository.pushRef ||
            material.pullRequestBase !== repository.pullRequestBase) ||
        material.providerInstanceId !== binding.grant.providerInstanceId ||
        material.grantId !== binding.grant.grantId ||
        material.apiOrigin !== "https://api.github.com"
      ) {
        throw new OpenShellGitRouteError(
          "material_mismatch",
          "OpenShell Git material does not match admission.",
        );
      }
      // The admission deadline may pass while we read the supervisor and its material. The
      // normalized delivery binding still has to match; time alone is not a changed grant.
      if (!this.materialIsLive(entry.revision, material.expiresAt)) {
        this.pending(entry, "material_unavailable");
        return;
      }
      const { value: _value, ...identity } = material;
      if (!entry.material || !isDeepStrictEqual(entry.material, identity)) {
        if (entry.blocked || this.stopped.signal.aborted || signal.aborted) {
          return;
        }
        this.pending(entry, "unverified");
        // Marked before the write: a worker that stops in between leaves the outcome
        // unknown, and a stale fence writes nothing.
        await this.fenced(entry, signal, "rotate", material);
        // Retain the selected recipient, but authorize at this reservation's new fence.
        const reservedInstall = install && { ...install, fence: entry.fence };
        try {
          const rotated = await entry.provider.rotate(
            entry.binding,
            async () => {
              // Provider, profile and workspace have now been read. Recheck the fence, then
              // ask the prepared owner for *current* approval, execution, session and material.
              // A different selection needs a new observation, never a use receipt or a replay.
              await this.fenced(entry, signal);
              if (!isDeepStrictEqual(await this.observation(entry, signal), observed)) {
                throw new OpenShellGitRouteError(
                  "material_mismatch",
                  "Preview credential recipient changed before installation.",
                );
              }
              const current = await read(() => readMaterial(reservedInstall), signal);
              if (
                current &&
                !("absent" in current) &&
                isDeepStrictEqual(material, current) &&
                this.materialIsLive(entry.revision, current.expiresAt) &&
                !entry.blocked &&
                !this.stopped.signal.aborted &&
                !signal.aborted
              ) {
                return { value: current.value, expiresAt: current.expiresAt };
              }
              entry.absent = current && "absent" in current ? current.absent : undefined;
            },
            signal,
          );
          if (!rotated) {
            if (signal.aborted) {
              // This pass ran out of time before the write (finding 2211): nothing was sent.
              // The catch below clears the reservation; the route is observed again.
              throw new OpenShellGitObservationError("timeout", signal.reason);
            }
            // The writer never sent the selected material. Clear only our own write intent.
            this.pending(entry, "material_unavailable");
            await this.cancelWriting(entry, signal);
            return;
          }
          entry.binding = rotated;
          entry.preview.verifyInstallBy = performance.now() + 30_000;
        } catch (error) {
          if (
            error instanceof OpenShellGitObservationError ||
            (error instanceof OpenShellPreparedGitProviderError && error.outcome === "refused")
          ) {
            // Nothing was written: the marked write is cleared with the unchanged route.
            await this.cancelWriting(entry, signal);
          }
          throw error;
        }
        entry.material = identity;
        await this.persist(entry, signal);
      }
      const installed = await this.observation(entry, signal, { adopt: true });
      if (
        installed?.credentialState === "active" &&
        !entry.blocked &&
        !this.stopped.signal.aborted &&
        !signal.aborted
      ) {
        this.installedNow(entry, installed);
        entry.preview.verifyInstallBy = undefined;
        const { materialVersion, preparationAttemptId } = entry.material;
        if (
          entry.materialInstalled?.materialVersion !== materialVersion ||
          entry.materialInstalled.preparationAttemptId !== preparationAttemptId
        ) {
          // The supervisor activated this material: its connection reset has happened by now.
          entry.materialInstalled = { materialVersion, preparationAttemptId, at: Date.now() };
        }
      } else {
        this.pending(entry, "unverified");
      }
      await this.persist(entry, signal);
    } catch (error) {
      this.failed(entry, error, signal);
    }
  }

  /**
   * Drops a closed route whose Sandbox is gone (finding 2218): nothing can ask for it any more,
   * so the tick and lookups stop walking it. Its reason stays in this process, which never
   * prepares, adopts or verifies the revision again, and the store's tombstone refuses it to any
   * other worker. A Sandbox still there, or a failed read, is read again later, backing off. A
   * Sandbox the route never observed may still be in creation: it must read absent twice.
   */
  private async release(entry: Entry): Promise<void> {
    const id = entry.revision.id;
    const last = entry.release;
    if (
      entry.previewClosure !== undefined ||
      this.states.get(id)?.entry !== entry ||
      performance.now() < (last?.at ?? 0)
    ) {
      return;
    }
    const signal = AbortSignal.any([
      this.stopped.signal,
      AbortSignal.timeout(this.observeTimeoutMs),
    ]);
    // A read that fails for any reason keeps the entry. One the gateway refuses by this worker's
    // identity keeps it until that changes, so it is reported, once per entry.
    let refused = false;
    const present = await read(async () => {
      const { workspace, sandbox } = entry.binding;
      return entry.client.getSandbox({ workspace, name: sandbox }, signal);
    }, signal).then(
      (box) => box !== undefined,
      (error: unknown) => {
        refused =
          error instanceof OpenShellGitRouteError && error.reason === "gateway_unauthorized";
        return true;
      },
    );
    if (entry.blocked === undefined || this.states.get(id)?.entry !== entry) {
      return;
    }
    if (!present && (entry.sandboxId !== undefined || last?.absent)) {
      this.entries.delete(id);
      this.states.set(id, { blocked: entry.blocked });
      return;
    }
    if (refused && !last?.refused) {
      this.emit?.({
        event: "worker.openshell-git-route-warning",
        status: "retained",
        reason: "gateway_unauthorized",
        ...this.identity(entry),
      });
    }
    const reads = (last?.present ?? 0) + (present ? 1 : 0);
    entry.release = {
      at: performance.now() + Math.min(REFRESH_INTERVAL_MS * 2 ** reads, RELEASE_INTERVAL_CAP_MS),
      present: reads,
      ...(!present && { absent: true }),
      ...((refused || last?.refused) && { refused: true }),
    };
  }

  /**
   * The live binding for a request, or undefined with one `worker.openshell-git-denied` line.
   * `refused` is told the reason code the Agent is shown when the denial is attributed to one
   * of this worker's routes (finding 2149); an unattributed request stays generic.
   */
  async lookup(
    identity: OpenShellOnlineGitIdentity,
    signal: AbortSignal,
    refused?: (reasonCode: OpenShellOnlineGitReasonCode) => void,
  ): Promise<OpenShellOnlineGitBinding | undefined> {
    if (!this.owner || this.stopped.signal.aborted || signal.aborted) {
      return;
    }
    let reason = "no_binding";
    let denied: Entry | undefined;
    for (const pending of this.entries.values()) {
      const entry = await pending.catch(() => undefined);
      if (
        !entry ||
        entry.bindingId !== identity.bindingId ||
        entry.binding.workspace !== identity.workspace
      ) {
        continue;
      }
      // The binding is this entry's; from here the denial names the route's state.
      denied = entry;
      if (entry.blocked) {
        reason = "route_blocked";
        break;
      }
      if (entry.sandboxId !== identity.sandboxId) {
        reason = "execution_mismatch";
        break;
      }
      if (entry.preview.release !== "acknowledged") {
        reason = "route_pending";
        break;
      }
      if (!entry.installed || !entry.material) {
        // A route that had material and lost it names that, so an operator can tell a
        // retired credential (recovery required) from a version still verifying.
        reason = entry.unobserved
          ? "route_unobserved"
          : entry.pending === "material_unavailable" && entry.material
            ? "material_unavailable"
            : "route_pending";
        if (reason === "material_unavailable" && !entry.materialLost) {
          // Said once per loss, and only for a Sandbox still asking: a version superseded
          // by a newer one loses its material a moment before it is withdrawn, and nothing
          // asks for it. A live version with a retired credential (recovery required) does.
          entry.materialLost = true;
          this.emit?.({
            event: "worker.openshell-git-route-warning",
            status: "pending",
            reason: "material_unavailable",
            reasonCode: lookupReasonCode(reason, entry),
            ...this.identity(entry),
          });
        }
        break;
      }
      const material = entry.material;
      try {
        // A worker another worker replaced admits nothing more (finding 2128). A store
        // that does not answer denies this request and leaves the route as the worker's
        // reconcile last left it: it is not a gateway observation.
        try {
          await this.fenced(entry, signal);
        } catch (error) {
          if (error instanceof OpenShellGitObservationError) {
            reason = "store_unavailable";
            break;
          }
          throw error;
        }
        const observed = await this.observation(entry, signal);
        if (entry.blocked || this.stopped.signal.aborted || signal.aborted) {
          reason = entry.blocked ? "route_blocked" : "lookup_aborted";
          break;
        }
        if (entry.material !== material) {
          reason = "material_rotated";
          break;
        }
        if (!observed || !isDeepStrictEqual(observed, entry.installed)) {
          // The installation no longer reads as the one admitted: close the route until the
          // worker's own reconcile verifies it again.
          this.pending(entry, "unverified");
          reason = "installation_changed";
          break;
        }
        if (!this.materialIsLive(entry.revision, material.expiresAt)) {
          reason = "material_expired";
          break;
        }
        return {
          sandboxId: identity.sandboxId,
          bindingId: identity.bindingId,
          workspace: identity.workspace,
          executionId: entry.revision.id,
          sessionId: material.sessionId,
          providerInstanceId: material.providerInstanceId,
          grantId: material.grantId,
          ...("scope" in material
            ? {
                installationId: material.installationId,
                ...(material.scope === "github-repository"
                  ? { scope: material.scope, repositories: material.repositories }
                  : { scope: material.scope }),
              }
            : {
                repositoryId: material.repositoryId,
                repository: material.repository,
                pushRef: material.pushRef,
                ...(material.pullRequestBase && { pullRequestBase: material.pullRequestBase }),
              }),
          apiOrigin: material.apiOrigin,
          installed: {
            ...(entry.revision.egressPlan?.repositoryGit && {
              route: {
                revisionId: entry.revision.id,
                fence: entry.fence,
                observed: entry.supervisor,
              },
            }),
            preparationAttemptId: material.preparationAttemptId,
            materialVersion: material.materialVersion,
          },
        };
      } catch (error) {
        if (signal.aborted && !(error instanceof OpenShellGitRouteError)) {
          // The request's own budget ran out: this request is denied, and the route stays as
          // the worker's reconcile last left it.
          reason = "lookup_aborted";
          break;
        }
        this.failed(entry, error, signal);
        reason = entry.blocked ? "route_blocked" : "route_unobserved";
        break;
      }
    }
    // One line per denial the worker decides (finding 2133); the supervisor's own log only
    // says the middleware denied. It names the reason code the Agent sees (finding 2149).
    const reasonCode = denied && lookupReasonCode(reason, denied);
    if (reasonCode !== undefined) {
      refused?.(reasonCode);
    }
    this.emit?.({
      event: "worker.openshell-git-denied",
      reason,
      ...(reasonCode === undefined ? {} : { reasonCode }),
      sandboxId: identity.sandboxId,
      requestId: identity.requestId,
      ...(denied === undefined ? {} : this.identity(denied)),
    });
    return undefined;
  }

  /** Composition supplies this Driver's store. Neither the pool nor this store is a sender port. */
  connectRouteStore(pool: PostgresPool, emit?: RepositoryTransportEmit): OpenShellGitRouteStore {
    this.routes = new PostgresOpenShellGitRouteStore(pool);
    this.emit = emit;
    return this.routes;
  }

  /** The protected sender gets committed material and one request decision, never the issuer. */
  async bindRepositoryGit(authority: ProtectedRepositoryGitAuthority) {
    if (!this.routes) {
      throw new Error("OpenShell protected repository Git requires its selected route store.");
    }
    await this.start(
      protectedOpenShellGitOwner(authority, !!this.configuration.observedHookPreviewWorkspace),
      this.emit,
      this.routes,
    );
    return { close: () => this.close() };
  }

  /**
   * `routes` persists each route this worker prepares so a restarted or replacement worker
   * re-adopts it (finding 2128); without it a restart requires a new revision.
   */
  async start(
    owner: OnlineGitOwner,
    emit?: RepositoryTransportEmit,
    routes?: OpenShellGitRouteStore,
  ): Promise<void> {
    if (this.owner || this.stopped.signal.aborted) {
      throw new Error("OpenShell Git worker already started or stopped.");
    }
    const config = this.configuration.authority;
    const [certificate, privateKey, publicKey] = await Promise.all([
      readFile(config.certificatePath),
      readFile(config.privateKeyPath),
      readFile(config.issuerPublicKeyPath),
    ]);
    this.owner = owner;
    this.emit = emit;
    this.routes = routes;
    this.server = createOpenShellOnlineGitAuthority({
      registrationName: this.configuration.registrationName,
      budgetMs: 3000,
      identity: {
        issuer: config.issuer,
        audience: config.audience,
        keyId: config.keyId,
        publicKey,
      },
      ...{
        previewDenial: (
          q: import("./openshell-online-authority.ts").OpenShellOnlineHttpRequest,
        ) => {
          for (const { entry } of this.states.values()) {
            if (
              entry &&
              entry.sandboxId === q.sandboxId &&
              !entry.blocked &&
              !entry.material &&
              entry.binding.credentialState === "bootstrap"
            ) {
              return entry.preview.deny(q, entry.sandboxId);
            }
          }
        },
      },
      lookupBinding: async (identity, signal) => {
        let refused: OpenShellOnlineGitReasonCode | undefined;
        const binding = await this.lookup(identity, signal, (code) => {
          refused = code;
        });
        return binding ?? (refused === undefined ? undefined : { refused });
      },
      authorizeOnlineRequest: owner.authorizeOnlineRequest,
      onDeny: (denial) => {
        this.emit?.({ event: "worker.openshell-git-denied", ...denial });
      },
    });
    try {
      await bindOpenShellEgressAuthority(
        this.server,
        `${config.host.includes(":") ? `[${config.host}]` : config.host}:${config.port}`,
        certificate,
        privateKey,
      );
    } catch (error) {
      this.server.forceShutdown();
      this.owner = undefined;
      throw error;
    } finally {
      privateKey.fill(0);
    }
    const tick = () => {
      this.running = (async () => {
        for (const pending of this.entries.values()) {
          const entry = await pending.catch(() => undefined);
          if (entry) {
            await this.reconcile(entry);
          }
        }
      })().finally(() => {
        if (!this.stopped.signal.aborted) {
          this.timer = setTimeout(tick, 1000);
        }
      });
    };
    tick();
  }

  async close(): Promise<void> {
    this.stopped.abort();
    clearTimeout(this.timer);
    this.server?.forceShutdown();
    await this.running;
    this.owner = undefined;
    this.entries.clear();
    this.states.clear();
  }
}

interface StandingGitExecution {
  readonly client: OpenShellGatewayClient;
  readonly workspace: string;
  readonly sandbox: string;
  readonly continuity: OpenShellGitContinuity;
}

/** The repository lifecycle offered by this Sandbox, including cold execution observation. */
export function openShellRepositoryAccess(
  git: OpenShellGitRuntime,
  standing: (
    context: Parameters<SandboxRepositoryAccess["verifyExecution"]>[0],
  ) => StandingGitExecution | undefined,
): SandboxRepositoryAccess {
  return {
    verifyExecution: (context) =>
      git.verifyExecution(context.revision, context.signal, async () => standing(context)),
    retireExpired: async (context) => {
      const owner = await standing(context);
      return owner
        ? git.retireExpiredRepositoryAccess(
            context.revision,
            owner.client,
            owner.workspace,
            owner.sandbox,
            owner.continuity,
            context.signal,
          )
        : "retire-runtime";
    },
    routeReadiness: (id) => openShellGitRouteReadiness(git.route(id)),
    isRouteBlockedError: (error) => error instanceof OpenShellGitRouteBlockedError,
    materialSettledAt: (id) => {
      // The supervisor reload closes the node connection. Allow the Gateway to see the disconnect.
      const installed = git.materialInstalledAt(id);
      return installed === undefined ? undefined : installed + 2_000;
    },
  };
}

/** One policy definition, compared again by the Credential Proxy at Compute release. */
export function openShellGitMiddleware(registrationName: string, bindingId: string) {
  return {
    "oce-prepared-git": {
      name: "oce-prepared-git",
      middleware: registrationName,
      config: { fields: { binding_id: { stringValue: bindingId } } },
      on_error: "fail_closed",
      order: 2147483647,
      endpoints: { include: ["github.com", "api.github.com"] },
    },
  };
}
