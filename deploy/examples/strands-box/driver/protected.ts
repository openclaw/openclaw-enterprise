/**
 * Paired protected registration: one Strands Box Sandbox and its Credential Proxy with shared
 * state. Selected only when the Installation configures `protectedRepository`; the ordinary
 * `drivers.sandbox` loader refuses this registration, and the paired loader refuses the
 * ordinary Driver, so neither can be selected as the other.
 *
 * Custody: the GitHub App key stays in the Worker (prepared-Git owner); OCE's Token Service mints
 * the installation token. Box injects GitHub auth itself for its github.com and api.github.com
 * routes, and for each request it asks its request-time credential source, which the Box host
 * serves and relays to this Worker over the owner-only control socket. This Driver answers each
 * ask with OCE's own decision (`requests.authorize`, from `bindRepositoryGit`): allow with that
 * request's credential, or a refusal. Box holds no token between requests; the workload holds
 * only Box's placeholders; stock `git` and `gh` work unchanged.
 */
import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  CredentialProxyDriver,
  DriverImplementation,
  DriverRegistration,
  EgressInstallation,
  EgressRef,
  HarnessWorkloadRequirements,
  ProtectedRepositoryGitAuthority,
  ProtectedWorkspaceEndpoint,
  ProtectedWorkspaceSandboxDriver,
  ProxyPlan,
  ProxyRevisionContext,
  ProxyWiring,
  RepositoryGitBinding,
  RepositoryGitInstallationFence,
  RepositoryGitMaterialVersion,
  RepositoryGitRequests,
  SandboxHarnessContext,
  SandboxHarnessStatus,
  SandboxHarnessStatusContext,
  SandboxHarnessWithdrawalContext,
  SandboxProtectedWorkspaceStatusContext,
  SandboxRepositoryAccess,
  SandboxResourceRef,
} from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError } from "@openclaw-enterprise/occ";
import {
  canonicalJson,
  collectAsks,
  control,
  digest,
  record,
  releaseExecution,
  sameOwner,
  sendAnswer,
  type Execution,
  type Owner,
  type SourceAsk,
} from "./control.ts";
import type { Options, StrandsBoxDriver } from "./index.ts";
import { answerAsk, type AskRecord } from "./request-source.ts";

export interface ProtectedRepositoryConfiguration {
  /** The provider whose installation token Box's routes carry. Only GitHub exists. */
  readonly provider: "github";
}

export const protectedRepositorySchema: NonNullable<DriverImplementation["configurationSchema"]> = {
  type: "object",
  additionalProperties: false,
  required: ["provider"],
  properties: { provider: { type: "string", enum: ["github"] } },
};

/** Equal to the host's `wiringConfiguration` (host/control.ts); the host compares it exactly. */
const WIRING_VERSION = 3;
const GITHUB_HOSTS = ["github.com", "api.github.com"] as const;
const BOX_SOURCE_IDENTITY = "box-source-sha256:";
const RELEASE_PUBLIC_KEY_ENV = "OPENCLAW_EGRESS_COMPUTE_RELEASE_PUBLIC_KEY";
const RELEASE_PROFILE = "oce-compute-execution-release-v1";

function wiringConfiguration(configured: ProtectedRepositoryConfiguration) {
  return {
    version: WIRING_VERSION,
    protectedRepository: {
      provider: configured.provider,
      hosts: [...GITHUB_HOSTS],
      delivery: "box-source-v1",
    },
  };
}

function recipientRef(id: string): EgressRef {
  return { id: `${id}-box-egress`, generation: 1 };
}

function samePlan(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameVersion(
  left: RepositoryGitMaterialVersion | undefined,
  right: RepositoryGitMaterialVersion | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.preparationAttemptId === right.preparationAttemptId &&
    left.materialVersion === right.materialVersion
  );
}

/** Exactly one online-request, one-repository Git plan with no other route, owned by this Driver. */
function admittedPlan(plan: ProxyPlan | undefined, id: string): plan is ProxyPlan {
  const bindings = plan?.repositoryGit?.bindings;
  return (
    plan !== undefined &&
    plan.repositoryGitAuthorization === "online-request" &&
    plan.routes.length === 0 &&
    plan.harnessCredentialSource === undefined &&
    plan.policyReductionVersion === undefined &&
    plan.sandboxDriverId === id &&
    plan.egressDriverId === id &&
    bindings?.length === 1 &&
    bindings[0]?.profile === "github-repository"
  );
}

/** How many asks this Driver decides at once; more are refused, never queued without bound. */
const MAX_IN_FLIGHT = 32;
/** The host holds a collect call open at most this long (host/credential-source.ts). */
const COLLECT_WAIT_MS = 4_000;
/** How many answered asks the Driver remembers (identifiers and outcomes only). */
const ASK_RECORDS = 256;

interface Recipient {
  readonly executionId: string;
  readonly revisionId: string;
  readonly owner: Owner;
  readonly requirementsDigest: string;
  readonly installation: EgressInstallation;
  /** The committed recipient's bearer digest, which Box's source asks must present. */
  readonly bearerSha256: string;
  route?: RepositoryGitInstallationFence;
  /** The intent OCC persisted; a lost confirmation is settled from it, never redone. */
  pending?: (RepositoryGitInstallationFence & RepositoryGitMaterialVersion) | undefined;
  /** The route OCE confirmed for `version`: every ask is decided against it. */
  confirmed?: RepositoryGitInstallationFence;
  version?: RepositoryGitMaterialVersion;
  /** When the first version became ready; renewals do not reset the workspace connection. */
  settledAt?: number;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

/** State shared by the paired Sandbox and Credential Proxy of one registration. */
class Shared {
  readonly recipient: EgressRef;
  readonly wiring: ReturnType<typeof wiringConfiguration>;
  readonly retained = new Map<string, HarnessWorkloadRequirements>();
  authority: ProtectedRepositoryGitAuthority | undefined;
  requests: RepositoryGitRequests | undefined;
  active: Recipient | undefined;
  /** Answered asks, newest last: Box's `request_id` beside OCE's `exchangeId`, never a value. */
  readonly asks: AskRecord[] = [];
  private serving: { readonly stop: AbortController; readonly done: Promise<void> } | undefined;
  private inFlight = 0;
  readonly id: string;
  readonly options: Options & {
    readonly protectedRepository: ProtectedRepositoryConfiguration;
  };

  constructor(
    id: string,
    options: Options & { readonly protectedRepository: ProtectedRepositoryConfiguration },
  ) {
    this.id = id;
    this.options = options;
    this.recipient = recipientRef(id);
    this.wiring = wiringConfiguration(options.protectedRepository);
  }

  read(signal: AbortSignal): Promise<Execution | undefined> {
    return control(this.options.controlSocket, { method: "GET" }, signal);
  }

  /**
   * The recipient exactly as the host observes it now: this host execution, the host control
   * process that receives the material for it, and the digest of the bearer the host gave it.
   * Never built from a request or from Compute's record alone. It does not change when the host
   * restarts `box run` to install material, so the committed installation stays exact.
   */
  installationFrom(
    plan: ProxyPlan,
    execution: Execution | undefined,
  ): EgressInstallation | undefined {
    const recipient = execution?.repositoryRecipient;
    const startup = execution?.protectedStartup;
    if (
      execution === undefined ||
      execution.state === "failed" ||
      recipient === undefined ||
      startup?.generationSha256 === undefined ||
      execution.owner.driverId !== this.id ||
      execution.owner.revisionId !== plan.execution.revisionId ||
      execution.owner.agentId !== plan.execution.agentId ||
      execution.owner.namespaceId !== plan.execution.namespaceId ||
      !samePlan(startup.plan, plan) ||
      !admittedPlan(plan, this.id)
    ) {
      return undefined;
    }
    return {
      plan,
      sandboxId: execution.executionId,
      sender: this.recipient,
      installedAt: startup.reservedAt,
      enforcement: {
        instanceId: execution.executionId,
        configurationId: digest(this.wiring),
        policyHash: digest({
          version: WIRING_VERSION,
          plan,
          route: this.wiring.protectedRepository,
          generationSha256: startup.generationSha256,
        }),
        authorityScope: "execution",
        repositoryGitRecipient: {
          providerId: this.recipient.id,
          attachmentEpoch: execution.executionId,
          processInstanceId: recipient.processInstanceId,
          networkInstanceId: `${BOX_SOURCE_IDENTITY}${recipient.bearerSha256}`,
          authorization: "online-request",
          deliveryProfile: "github_repository",
        },
      },
    };
  }

  retire(): void {
    this.active = undefined;
  }

  /**
   * One Worker pass: re-observe the host's current execution and the committed recipient, then
   * declare each eligible material version ready once. Box asks per request and holds no value,
   * so there is nothing to deliver: confirming a version means this recipient is ready to ask per
   * request (the contract's request-time meaning), and it requires the host to show the live
   * `box run` started with the source routes. A renewal is confirmed the same way while Box keeps
   * running. OCE prepares material only for the active revision, so this runs after the release
   * and the activation, never before.
   */
  async reconcile(signal: AbortSignal): Promise<void> {
    const authority = this.authority;
    if (authority === undefined) return;
    const execution = await this.read(signal);
    const plan = execution?.protectedStartup?.plan as ProxyPlan | undefined;
    const installation = plan === undefined ? undefined : this.installationFrom(plan, execution);
    const bearerSha256 = execution?.repositoryRecipient?.bearerSha256;
    if (execution === undefined || installation === undefined || bearerSha256 === undefined) {
      this.retire();
      return;
    }
    if (
      this.active !== undefined &&
      (this.active.executionId !== execution.executionId ||
        !isDeepStrictEqual(this.active.installation, installation))
    ) {
      this.retire();
    }
    const fresh: Recipient = {
      executionId: execution.executionId,
      revisionId: installation.plan.execution.revisionId,
      owner: execution.owner,
      requirementsDigest: execution.requirementsDigest,
      installation,
      bearerSha256,
    };
    const active = (this.active ??= fresh);
    if (active.pending !== undefined) {
      await this.settle(authority, active, execution, signal);
      return;
    }
    const route = await authority.recipients.observe(installation);
    if (route === undefined || this.active !== active) return;
    const git = authority.online.githubRepository;
    const material = git === undefined ? undefined : await git.readMaterial(route, signal);
    // Withdrawal: OCE refuses every ask from now on (`access_withdrawn`), before Box opens any
    // provider connection. Nothing is sent to the host; `box run` and the chat keep running.
    if (material === undefined || "absent" in material || this.active !== active) return;
    const version = {
      preparationAttemptId: material.preparationAttemptId,
      materialVersion: material.materialVersion,
    };
    if (sameVersion(active.version, version)) return;
    if (execution.repositoryRecipient?.source === undefined) return;
    const pending = await authority.recipients.beginInstall(route, version);
    if (this.active !== active) return;
    if (pending === undefined) {
      // OCC refuses an intent for the version its delivery row already holds, which is the state
      // a restarted Worker finds: that version is confirmed for this recipient, at `route`.
      this.settled(active, route, version);
      return;
    }
    active.pending = pending;
    await this.settle(authority, active, execution, signal);
  }

  /** Confirm the persisted intent while the host still shows the live `box run` asking it. */
  private async settle(
    authority: ProtectedRepositoryGitAuthority,
    active: Recipient,
    execution: Execution | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const pending = active.pending!;
    if (
      execution === undefined ||
      execution.executionId !== active.executionId ||
      execution.repositoryRecipient?.source === undefined ||
      this.active !== active
    ) {
      return;
    }
    const confirmed = await authority.recipients.confirmInstall(pending);
    signal.throwIfAborted();
    if (confirmed === undefined || this.active !== active) return;
    active.pending = undefined;
    this.settled(active, confirmed, pending);
  }

  private settled(
    active: Recipient,
    route: RepositoryGitInstallationFence,
    version: RepositoryGitMaterialVersion,
  ): void {
    active.route = route;
    active.confirmed = route;
    active.version = {
      preparationAttemptId: version.preparationAttemptId,
      materialVersion: version.materialVersion,
    };
    active.settledAt ??= Date.now();
  }

  /**
   * Serve Box's credential source from this Worker process for as long as the binding lives:
   * collect the live execution's asks from the host and answer each with OCE's decision.
   */
  private async serve(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const active = this.active;
      const requests = this.requests;
      if (active === undefined || requests === undefined) {
        await pause(250, signal);
        continue;
      }
      let asks: SourceAsk[];
      try {
        asks = await collectAsks(
          this.options.controlSocket,
          {
            owner: active.owner,
            executionId: active.executionId,
            requirementsDigest: active.requirementsDigest,
            waitMs: COLLECT_WAIT_MS,
          },
          signal,
        );
      } catch {
        await pause(500, signal);
        continue;
      }
      for (const ask of asks) {
        if (this.inFlight >= MAX_IN_FLIGHT) {
          void this.answer(active, ask, { refusal: "route_not_ready" }, signal);
          continue;
        }
        this.inFlight++;
        void this.decide(active, requests, ask, signal).finally(() => {
          this.inFlight--;
        });
      }
    }
  }

  private async decide(
    active: Recipient,
    requests: RepositoryGitRequests,
    ask: SourceAsk,
    signal: AbortSignal,
  ): Promise<void> {
    // Decided against the recipient that is live now: a retired or replaced one gets nothing.
    const live = this.active === active ? active : undefined;
    let answer: Parameters<typeof sendAnswer>[1]["answer"] = { refusal: "route_not_ready" };
    try {
      const decided = await answerAsk(ask, {
        route: live?.confirmed,
        bearerSha256: live?.bearerSha256,
        requests,
        signal,
      });
      answer = decided.answer;
      this.asks.push(decided.record);
      if (this.asks.length > ASK_RECORDS) this.asks.shift();
    } catch {
      // Never an unhandled rejection in the Worker: an unexpected failure is a refusal.
    }
    await this.answer(active, ask, answer, signal);
  }

  private async answer(
    active: Recipient,
    ask: SourceAsk,
    answer: Parameters<typeof sendAnswer>[1]["answer"],
    signal: AbortSignal,
  ): Promise<void> {
    await sendAnswer(
      this.options.controlSocket,
      {
        owner: active.owner,
        executionId: active.executionId,
        requirementsDigest: active.requirementsDigest,
        askId: ask.askId,
        answer,
      },
      signal,
    ).catch(() => false);
  }

  bind(
    authority: ProtectedRepositoryGitAuthority,
    requests: RepositoryGitRequests | undefined,
  ): RepositoryGitBinding {
    if (
      this.authority !== undefined ||
      authority.online.githubRepository === undefined ||
      requests === undefined
    ) {
      throw new DependencyUnavailableError(
        "The selected online GitHub repository authority or its request decision is unavailable.",
      );
    }
    this.authority = authority;
    this.requests = requests;
    const stop = new AbortController();
    this.serving = { stop, done: this.serve(stop.signal).catch(() => undefined) };
    return {
      reconcile: (signal) => this.reconcile(signal),
      close: () => this.close(),
    };
  }

  async close(): Promise<void> {
    const serving = this.serving;
    this.serving = undefined;
    this.authority = undefined;
    this.requests = undefined;
    this.retire();
    serving?.stop.abort();
    await serving?.done;
  }
}

export function createProtectedRegistration(
  Base: typeof StrandsBoxDriver,
  id: string,
  implementation: string,
  input: Options,
): DriverRegistration {
  const configured = input.protectedRepository;
  if (configured === undefined) throw new Error("protectedRepository is required.");
  const options = { ...structuredClone(input), protectedRepository: structuredClone(configured) };
  const shared = new Shared(id, options);

  class ProtectedStrandsBoxDriver extends Base implements ProtectedWorkspaceSandboxDriver {
    readonly repositoryAccess: SandboxRepositoryAccess = {
      async verifyExecution({ revision, signal }) {
        const execution = await shared.read(signal);
        const plan = execution?.protectedStartup?.plan as ProxyPlan | undefined;
        const installation =
          plan === undefined ? undefined : shared.installationFrom(plan, execution);
        if (installation === undefined || installation.plan.execution.revisionId !== revision.id) {
          return undefined;
        }
        return {
          executionId: installation.plan.execution.executionId,
          fingerprint: digest(installation.enforcement),
        };
      },
      // Box holds no token: from withdrawal on, OCE refuses each ask before any provider
      // connection, and OCC retires and revokes the token. The Box execution and its chat run on.
      retireExpired: async () => "withdrawn",
      routeReadiness: (revisionId) =>
        shared.active?.revisionId === revisionId && shared.active.confirmed !== undefined
          ? "ready"
          : "pending",
      materialSettledAt: (revisionId) =>
        shared.active?.revisionId === revisionId ? shared.active.settledAt : undefined,
      isRouteBlockedError: () => false,
    };

    protected override admit(context: SandboxHarnessContext): void {
      const { revision, requirements } = context;
      const plan = revision.egressPlan;
      const wiring = requirements.proxyWiring;
      if (
        revision.executionAdmission.mode !== "protected" ||
        revision.executionAdmission.version !== 5 ||
        !admittedPlan(plan, this.id) ||
        wiring === undefined ||
        !samePlan(wiring.plan, plan) ||
        !samePlan(wiring.configuration, shared.wiring) ||
        requirements.credentialAttachments.length !== 0 ||
        revision.harness.id !== "codex" ||
        revision.harness.mode !== "dedicated"
      ) {
        this.refuse(
          "This paired Strands Box registration runs only a protected one-repository revision through Box's GitHub routes.",
        );
      }
    }

    /**
     * A fresh bearer per PUT: the per-execution recipient identity. The host keeps its digest and
     * gives the bearer only to `box run`, which presents it to the credential source per request.
     * Never logged and never written to a file.
     */
    protected override executionInputs(): Readonly<Record<string, string>> {
      return { executionBearer: randomBytes(32).toString("base64url") };
    }

    override async provisionHarness(context: SandboxHarnessContext): Promise<SandboxResourceRef> {
      const ref = await super.provisionHarness(context);
      shared.retained.set(context.revision.id, context.requirements);
      return { ...ref, proxyWiring: context.requirements.proxyWiring! };
    }

    async protectedWorkspaceEndpoint(
      context: SandboxHarnessWithdrawalContext,
    ): Promise<ProtectedWorkspaceEndpoint | undefined> {
      const owner = this.owner(context);
      const execution = await this.readExecution(context.signal);
      const startup = execution?.protectedStartup;
      if (
        execution === undefined ||
        !sameOwner(execution.owner, owner) ||
        execution.state === "failed" ||
        startup?.generationSha256 === undefined ||
        execution.endpoint.url !== this.options.nativeEndpoint ||
        execution.endpoint.workspaceRoot !== this.options.workspaceRoot
      ) {
        return undefined;
      }
      return {
        url: this.options.nativeEndpoint,
        tls: { caBundle: this.options.nativeCaBundle },
        workspaceRoot: this.options.workspaceRoot,
        original: {
          purpose: "normal-protected-codex-workspace",
          generationSha256: startup.generationSha256,
          ...(startup.startupSha256 === undefined
            ? { state: "reserved" as const }
            : { state: "release-acknowledged" as const, startupSha256: startup.startupSha256 }),
        },
      };
    }

    async enrollHarness(
      context: SandboxHarnessStatusContext,
      installation: EgressInstallation,
      release: (startupId: string) => Promise<Readonly<Record<string, unknown>>>,
    ): Promise<void> {
      this.admit(context);
      const owner = this.owner(context);
      const execution = await this.readExecution(context.signal);
      const observed = shared.installationFrom(installation.plan, execution);
      if (
        execution === undefined ||
        observed === undefined ||
        !sameOwner(execution.owner, owner) ||
        !isDeepStrictEqual(observed, installation)
      ) {
        throw new DependencyUnavailableError(
          "The committed installation is not the host's current held Box execution.",
        );
      }
      if (execution.protectedStartup?.startupSha256 !== undefined) return;
      const startupId = randomUUID();
      const signed = await release(startupId);
      const challenge = record(signed.challenge);
      const key = context.requirements.environment.find(
        (entry) => entry.name === RELEASE_PUBLIC_KEY_ENV && "value" in entry,
      );
      if (
        challenge?.profile !== RELEASE_PROFILE ||
        challenge.startupId !== startupId ||
        key === undefined ||
        !("value" in key) ||
        typeof signed.signature !== "string" ||
        !verify(
          null,
          Buffer.from(JSON.stringify([signed.challenge, signed.installation, signed.expiresAt])),
          createPublicKey({
            key: Buffer.from(key.value, "base64url"),
            format: "der",
            type: "spki",
          }),
          Buffer.from(signed.signature, "base64url"),
        )
      ) {
        throw new DependencyUnavailableError("Compute's startup release does not verify.");
      }
      const released = await releaseExecution(
        this.options.controlSocket,
        {
          owner,
          executionId: execution.executionId,
          requirementsDigest: execution.requirementsDigest,
          release: signed,
        },
        context.signal,
      );
      if (
        released.executionId !== execution.executionId ||
        released.protectedStartup?.startupId !== startupId
      ) {
        throw new DependencyUnavailableError(
          "The Strands Box host did not acknowledge the release.",
        );
      }
    }

    override async harnessStatus(
      context: SandboxHarnessStatusContext | SandboxProtectedWorkspaceStatusContext,
    ): Promise<SandboxHarnessStatus> {
      if (!("protectedWorkspaceEndpoint" in context)) return super.harnessStatus(context);
      // A bound serving read: restore the requirements this Worker admitted for the revision.
      const requirements = shared.retained.get(context.revision.id);
      if (requirements === undefined) return { state: "starting" };
      const { protectedWorkspaceEndpoint: _bound, ...rest } = context;
      return super.harnessStatus({ ...rest, requirements });
    }

    override async cleanup(context: Parameters<StrandsBoxDriver["cleanup"]>[0]): Promise<void> {
      await super.cleanup(context);
      if (context.revision !== undefined) shared.retained.delete(context.revision.id);
      if (
        shared.active !== undefined &&
        (context.revision === undefined || shared.active.revisionId === context.revision.id)
      ) {
        shared.retire();
      }
    }
  }

  const sandbox = new ProtectedStrandsBoxDriver(id, implementation, options);
  const credentialProxy: CredentialProxyDriver = {
    id,
    implementation,
    capability: "credential_proxy",
    sourceControl: {
      sender: shared.recipient,
      backend: shared.recipient,
      resolver: shared.recipient,
      providers: [],
      async assertAvailable(signal, profile) {
        if (profile !== "github_repository") {
          throw new DependencyUnavailableError(
            "This Strands Box registration delivers only one GitHub repository through Box's routes.",
          );
        }
        // In the Worker, prove the host answers. The API process loads the package but never
        // binds; the Worker repeats this check in configure before any wiring.
        if (shared.authority !== undefined) await shared.read(signal);
        // Box asks for every request and this Driver answers each with `requests.authorize`.
        return { profile, authorization: "online-request" };
      },
    },
    async configureRevision({ plan }: ProxyRevisionContext): Promise<ProxyWiring> {
      if (!admittedPlan(plan, id)) {
        throw new DependencyUnavailableError(
          "This Strands Box registration supports one online-request GitHub repository plan.",
        );
      }
      return { plan, configuration: structuredClone(shared.wiring) };
    },
    async wiringStatus(context, prepared) {
      if (
        !samePlan(prepared.plan, context.plan) ||
        !samePlan(prepared.configuration, shared.wiring)
      ) {
        return undefined;
      }
      return shared.installationFrom(context.plan, await shared.read(context.signal));
    },
    async verifyInstallation(context, installation) {
      const observed = shared.installationFrom(
        installation.plan,
        await shared.read(context.signal),
      );
      return observed !== undefined && isDeepStrictEqual(observed, installation);
    },
    async removeRevision(context) {
      if (shared.active?.revisionId === context.revision.id) shared.retire();
      return true;
    },
    bindRepositoryGit: async (authority, requests) => shared.bind(authority, requests),
  };
  return {
    capabilities: { sandbox, credential_proxy: credentialProxy },
    close: () => shared.close(),
  };
}
