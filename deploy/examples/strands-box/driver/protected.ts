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
 *
 * With `modelGateway` the registration also supplies a Credential Gateway view
 * (`model-gateway.ts`), and a protected revision may carry its Harness model source: Box injects
 * the model key on each request to the configured model route through the same host relay, and
 * this Driver answers each such ask from the package's own Secret, never with OCE's GitHub
 * decision.
 */
import { createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  CredentialProxyDriver,
  DriverImplementation,
  DriverRegistration,
  EgressInstallation,
  EgressRef,
  HarnessWorkloadRequirements,
  ProtectedCodexArtifactPolicyAdmission,
  ProtectedRepositoryGitAuthority,
  ProtectedWorkspaceEndpoint,
  ProtectedWorkspaceSandboxDriver,
  ProxyPlan,
  ProxyRevisionContext,
  ProxyWiring,
  RepositoryGitBinding,
  SandboxPolicySnapshot,
  RepositoryGitInstallationFence,
  RepositoryGitMaterialVersion,
  RepositoryGitRequests,
  SandboxHarnessContext,
  SandboxHarnessStatus,
  SandboxHarnessStatusContext,
  SandboxHarnessWithdrawalContext,
  CredentialWithdrawalContext,
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
  harnessEnrollment,
  record,
  releaseExecution,
  revokeHarnessModel,
  sameOwner,
  sendAnswer,
  type Execution,
  type ModelAsk,
  type Owner,
  type SourceAsk,
} from "./control.ts";
import type { Options, StrandsBoxDriver } from "./index.ts";
import {
  createModelGateway,
  MODEL_SOURCE_TYPE,
  modelAttachmentRef,
  modelBaseUrl,
  ModelKeyStore,
  valueDigest,
} from "./model-gateway.ts";
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
const WIRING_VERSION = 4;
/** The only model request Box may carry a released key on, below the route's base path. */
const MODEL_PATH = "/responses";
/**
 * A released model key is valid for sending this long after the answer. The host accepts at most
 * 5 s on its own clock (host/credential-source.ts), so 4 s leaves the Worker 1 s of clock skew
 * ahead of the Box node; the host's own 5 s ceiling, the one Box sees, is unchanged.
 */
const MODEL_SEND_BY_MS = 4_000;
const GITHUB_HOSTS = ["github.com", "api.github.com"] as const;
const BOX_SOURCE_IDENTITY = "box-source-sha256:";
const RELEASE_PUBLIC_KEY_ENV = "OPENCLAW_EGRESS_COMPUTE_RELEASE_PUBLIC_KEY";
const RELEASE_PROFILE = "oce-compute-execution-release-v1";
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/**
 * The binding the stock protected Harness program puts in its startup challenge (its runtime
 * manifest's `egressEnrollment`), projected from the admitted plan exactly as Compute renders it
 * (core `harnessEgressEnrollment`, which a packaged Driver cannot import; a conformance test pins
 * this copy to it). For this Driver's plans: online-request, one repository route, no other.
 */
export function enrollmentBinding(plan: ProxyPlan): Record<string, unknown> {
  const { installationId, namespaceId, agentId, servicePrincipalId, revisionId, executionId } =
    plan.execution;
  return {
    ...(plan.repositoryGitAuthorization && {
      repositoryGitAuthorization: plan.repositoryGitAuthorization,
    }),
    routeCount: plan.routes.length + (plan.repositoryGit ? 1 : 0),
    inference: plan.harnessCredentialSource
      ? "credential_source"
      : plan.routes.some((route) => route.binding.grant.kind === "inference"),
    plan: { id: plan.id, generation: plan.generation },
    execution: {
      installationId,
      namespaceId,
      agentId,
      servicePrincipalId,
      revisionId,
      executionId,
    },
  };
}

/**
 * The nonsecret wiring for one plan. A plan with a Harness model source adds the model route's
 * delivery: Box asks for each `POST <route>/responses` and places the answer as the bearer.
 */
function wiringConfiguration(configured: ProtectedRepositoryConfiguration, model: boolean) {
  return {
    version: WIRING_VERSION,
    protectedRepository: {
      provider: configured.provider,
      hosts: [...GITHUB_HOSTS],
      delivery: "box-source-v1",
    },
    ...(model
      ? {
          harnessModel: {
            delivery: "box-source-v1",
            method: "POST",
            path: MODEL_PATH,
            placeholder: "OPENAI_API_KEY",
          },
        }
      : {}),
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

/**
 * The Harness model source a plan may carry: owned by this registration's Gateway, the one model
 * type, the API-key login. Absent unless the registration supplies the Gateway view.
 */
function admittedModelSource(plan: ProxyPlan, id: string, gateway: boolean): boolean {
  const source = plan.harnessCredentialSource;
  return (
    source === undefined ||
    (gateway &&
      Object.keys(source).sort().join(",") ===
        "credentialGatewayId,loginMode,method,sourceId,sourceType" &&
      source.method === "credential_source" &&
      typeof source.sourceId === "string" &&
      source.sourceId.length > 0 &&
      source.credentialGatewayId === id &&
      source.sourceType === MODEL_SOURCE_TYPE &&
      source.loginMode === "api_key")
  );
}

/**
 * Exactly one online-request, one-repository Git plan with no other route, owned by this Driver,
 * and at most this registration's own Harness model source.
 */
function admittedPlan(
  plan: ProxyPlan | undefined,
  id: string,
  gateway = false,
): plan is ProxyPlan {
  const bindings = plan?.repositoryGit?.bindings;
  return (
    plan !== undefined &&
    plan.repositoryGitAuthorization === "online-request" &&
    plan.routes.length === 0 &&
    admittedModelSource(plan, id, gateway) &&
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
  /**
   * The fence of OCE's committed installation at this recipient's first model ask, before any
   * confirmation (finding 3312): a later model ask at another fence is refused.
   */
  modelFence?: RepositoryGitInstallationFence;
  /**
   * Set while OCE holds exactly this recipient's committed installation, the host shows the live
   * Box asking, and the route never had material (OCE prepares it only for the active revision;
   * finding 3313): ready to activate, as core's own `awaiting_material` routes (finding 2139).
   */
  awaitingMaterial?: true | undefined;
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
/** What the Driver keeps of one answered model ask: identifiers, outcome, the key's digest. */
export interface ModelAskRecord {
  readonly requestId: string;
  readonly outcome: "allow" | "refused";
  readonly refusal?: string;
  /** SHA-256 of the released key, so evidence can name which key went out; never the key. */
  readonly keySha256?: string;
}

/** The empty artifact snapshot `admitProtectedCodexArtifactPolicy` returns, for this Driver. */
function emptySandboxPolicy(
  policy: SandboxPolicySnapshot | undefined,
  id: string,
  implementation: string,
): boolean {
  return (
    policy !== undefined &&
    Object.keys(policy).sort().join(",") === "additions,defaults,driverId,implementation,version" &&
    policy.driverId === id &&
    policy.implementation === implementation &&
    Number.isSafeInteger(policy.version) &&
    policy.version >= 1 &&
    isDeepStrictEqual(policy.defaults, {}) &&
    Array.isArray(policy.additions) &&
    policy.additions.length === 0
  );
}

function sameDigest(left: string, right: string | undefined): boolean {
  return (
    right !== undefined &&
    /^[a-f0-9]{64}$/.test(left) &&
    /^[a-f0-9]{64}$/.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

class Shared {
  readonly recipient: EgressRef;
  readonly retained = new Map<string, HarnessWorkloadRequirements>();
  /** The package's Secret store of model keys, when the Gateway view is configured. */
  readonly store: ModelKeyStore | undefined;
  /** Answered model asks, newest last: identifiers, outcomes and key digests only. */
  readonly modelAsks: ModelAskRecord[] = [];
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
    this.store =
      options.modelGateway === undefined ? undefined : new ModelKeyStore(options.modelGateway);
  }

  get gateway(): boolean {
    return this.store !== undefined;
  }

  /** The wiring for one plan: the GitHub routes, and the model route when the plan has one. */
  wiringFor(plan: ProxyPlan) {
    return wiringConfiguration(
      this.options.protectedRepository,
      plan.harnessCredentialSource !== undefined,
    );
  }

  admits(plan: ProxyPlan | undefined): plan is ProxyPlan {
    return admittedPlan(plan, this.id, this.gateway);
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
      !this.admits(plan)
    ) {
      return undefined;
    }
    const wiring = this.wiringFor(plan);
    return {
      plan,
      sandboxId: execution.executionId,
      sender: this.recipient,
      installedAt: startup.reservedAt,
      enforcement: {
        instanceId: execution.executionId,
        configurationId: digest(wiring),
        policyHash: digest({
          version: WIRING_VERSION,
          plan,
          route: wiring.protectedRepository,
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
    if (this.active !== active) return;
    if (route === undefined) {
      active.awaitingMaterial = undefined;
      return;
    }
    const git = authority.online.githubRepository;
    const material = git === undefined ? undefined : await git.readMaterial(route, signal);
    if (this.active !== active) return;
    // OCE prepares material only for the active revision (before it, OCC finds no live session
    // and answers `withdrawn`): a verified route that never had any waits for the activation,
    // and Compute must be able to activate it, as core's own routes (finding 3313). Git asks
    // still need a confirmed version; only the readiness changes.
    active.awaitingMaterial =
      material !== undefined &&
      "absent" in material &&
      active.version === undefined &&
      execution.repositoryRecipient?.source !== undefined
        ? true
        : undefined;
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
      let asks: (SourceAsk | ModelAsk)[];
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
        const decided =
          "kind" in ask && ask.kind === "model"
            ? this.decideModel(active, ask, signal)
            : this.decide(active, requests, ask as SourceAsk, signal);
        void decided.finally(() => {
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

  /**
   * One Box model request (finding 3298). The Namespace, the source and so the Secret come only
   * from OCE's own state, never from what the host reports:
   *
   * - `active.confirmed`: OCE confirmed this exact recipient (`recipients.confirmInstall`, or
   *   the version its delivery row already holds) for the live session's material, as the GitHub
   *   path requires before any ask;
   * - `recipients.observe(active.installation)`, read again for this request: OCE still holds
   *   exactly this installation committed for the revision, at the confirmed fence. The
   *   installation's plan is the one OCE rendered and committed at release: its
   *   `execution` (Namespace, Agent, revision, execution) and its `harnessCredentialSource`
   *   (the source OCE admitted for the Agent and attached through this Gateway).
   *
   * A host that reports another Namespace, source or plan builds an installation OCE never
   * committed, so it is never confirmed and `observe` finds nothing: a refusal, and no Secret is
   * read. Then, as before: the per-execution bearer, `POST` to the admitted route's
   * `/responses`, the deadline, and the host's live view (this execution, this source, no
   * revoke). The value is read for this request, sent with a 4 s send-by, and not kept.
   */
  private async decideModel(active: Recipient, ask: ModelAsk, signal: AbortSignal): Promise<void> {
    let answer: Parameters<typeof sendAnswer>[1]["answer"] = { refusal: "route_not_ready" };
    try {
      answer = await this.modelAnswer(active, ask, signal);
    } catch {
      // A failed store or host read is a refusal, never an unhandled rejection in the Worker.
    }
    this.modelAsks.push({
      requestId: ask.requestId,
      ...("refusal" in answer
        ? { outcome: "refused" as const, refusal: answer.refusal }
        : { outcome: "allow" as const, keySha256: valueDigest(answer.credential) }),
    });
    if (this.modelAsks.length > ASK_RECORDS) this.modelAsks.shift();
    await this.answer(active, ask, answer, signal);
  }

  private async modelAnswer(
    active: Recipient,
    ask: ModelAsk,
    signal: AbortSignal,
  ): Promise<Parameters<typeof sendAnswer>[1]["answer"]> {
    const route = this.options.controlledInference?.modelBaseUrl;
    const authority = this.authority;
    // OCE's plan as committed (checked against OCE's state below), never the host's report.
    const plan = active.installation.plan;
    const source = plan.harnessCredentialSource;
    if (
      this.store === undefined ||
      route === undefined ||
      authority === undefined ||
      source === undefined ||
      source.credentialGatewayId !== this.id
    ) {
      return { refusal: "model_not_admitted" };
    }
    if (this.active !== active || !sameDigest(ask.bearerSha256, active.bearerSha256)) {
      return { refusal: "execution_mismatch" };
    }
    const url = new URL(route);
    if (
      ask.target.host !== url.hostname ||
      ask.target.port !== Number(url.port || 443) ||
      ask.target.method !== "POST" ||
      ask.target.path !== `${url.pathname.replace(/\/$/, "")}${MODEL_PATH}` ||
      ask.target.query !== ""
    ) {
      return { refusal: "request_not_allowed" };
    }
    if (!(ask.deadlineUnixMs > Date.now())) return { refusal: "route_not_ready" };
    // OCE committed exactly this installation at the release and still holds it now. The Harness
    // checks its model while it starts, before OCE activates the revision, so before the
    // repository recipient can be confirmed (finding 3312): until then the fence is the one OCE
    // showed at this recipient's first model ask; once confirmed, the confirmed fence.
    const current = await authority.recipients.observe(active.installation);
    if (current === undefined || this.active !== active) return { refusal: "route_not_ready" };
    const fence = active.confirmed ?? (active.modelFence ??= current);
    if (
      current.revisionId !== plan.execution.revisionId ||
      current.revisionId !== fence.revisionId ||
      current.fence !== fence.fence ||
      !isDeepStrictEqual(current.observed, active.installation)
    ) {
      return { refusal: "route_not_ready" };
    }
    // The live attachment as the host shows it now: this execution, this source, no revoke.
    const execution = await this.read(signal);
    const model = execution?.harnessModel;
    if (
      execution === undefined ||
      execution.executionId !== active.executionId ||
      execution.state === "failed" ||
      !sameOwner(execution.owner, active.owner) ||
      execution.owner.namespaceId !== plan.execution.namespaceId ||
      // The live `box run` that asks (as a confirmation requires): an exited Box gets nothing.
      execution.repositoryRecipient?.source === undefined ||
      model?.sourceId !== source.sourceId
    ) {
      return { refusal: "execution_mismatch" };
    }
    if (model.revoked !== undefined) return { refusal: "access_withdrawn" };
    // Read for this request only: a rotation reaches the next request, a removal refuses it. The
    // Namespace and source are OCE's (the committed plan), never the host's owner record.
    const stored = await this.store.read(plan.execution.namespaceId, source.sourceId, signal);
    if (stored === undefined) return { refusal: "access_withdrawn" };
    return { credential: stored.value, send_by_unix_ms: Date.now() + MODEL_SEND_BY_MS };
  }

  private async answer(
    active: Recipient,
    ask: SourceAsk | ModelAsk,
    answer: Parameters<typeof sendAnswer>[1]["answer"],
    signal: AbortSignal,
  ): Promise<void> {
    // The answer object holds a key at most until the host has it.
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
        shared.active?.revisionId === revisionId &&
        (shared.active.confirmed !== undefined || shared.active.awaitingMaterial === true)
          ? "ready"
          : "pending",
      materialSettledAt: (revisionId) =>
        shared.active?.revisionId === revisionId ? shared.active.settledAt : undefined,
      isRouteBlockedError: () => false,
    };

    /**
     * Protected dedicated-Codex execution needs an explicit artifact-policy acknowledgement
     * (OCC refuses the deploy without one). Box enforces the egress the host renders from the
     * revision itself; this Driver declares no credential-free artifact rules and carries no
     * Agent additions, so the acknowledged snapshot is empty. Side-effect free.
     */
    admitProtectedCodexArtifactPolicy(version: number): ProtectedCodexArtifactPolicyAdmission {
      if (!Number.isSafeInteger(version) || version < 1) {
        throw new Error("The protected artifact policy needs a positive policy version.");
      }
      return {
        purpose: "protected-codex-artifacts",
        declaredRuleNames: [],
        snapshot: {
          driverId: this.id,
          implementation: this.implementation,
          version,
          defaults: {},
          additions: [],
        },
      };
    }

    /**
     * Exactly the paired protected plan, at most its one Harness model attachment (from this
     * registration's Gateway, as Compute rendered it), and the empty artifact snapshot this Driver
     * acknowledged (finding 3290). Everything else is refused.
     */
    protected override admit(context: SandboxHarnessContext): void {
      const { revision, requirements } = context;
      const plan = revision.egressPlan;
      const wiring = requirements.proxyWiring;
      if (
        revision.executionAdmission.mode !== "protected" ||
        revision.executionAdmission.version !== 5 ||
        !shared.admits(plan) ||
        wiring === undefined ||
        !samePlan(wiring.plan, plan) ||
        !samePlan(wiring.configuration, shared.wiringFor(plan)) ||
        !this.exactModelAttachment(context, plan) ||
        revision.harness.id !== "codex" ||
        revision.harness.mode !== "dedicated"
      ) {
        this.refuse(
          "This paired Strands Box registration runs only a protected one-repository revision through Box's GitHub routes and its own model route.",
        );
      }
      if (!emptySandboxPolicy(revision.sandboxPolicy, this.id, this.implementation)) {
        this.refuse(
          "This paired Strands Box registration needs the empty protected artifact policy it acknowledged.",
        );
      }
    }

    /** No attachment without a model source; with one, exactly its own (mirrors OpenShell). */
    private exactModelAttachment(context: SandboxHarnessContext, plan: ProxyPlan): boolean {
      const source = plan.harnessCredentialSource;
      const attachments = context.requirements.credentialAttachments;
      if (source === undefined) return attachments.length === 0;
      const [attachment] = attachments;
      return (
        attachments.length === 1 &&
        attachment !== undefined &&
        Object.keys(attachment).sort().join(",") === "ref,sourceId" &&
        attachment.sourceId === source.sourceId &&
        attachment.ref === modelAttachmentRef(source.sourceId) &&
        context.requirements.loginMode === "api_key" &&
        isDeepStrictEqual(context.revision.harnessAuth, source)
      );
    }

    protected override harnessModelAttached(requirements: HarnessWorkloadRequirements): boolean {
      return requirements.proxyWiring?.plan.harnessCredentialSource !== undefined;
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

    /**
     * Two releases, both signed by Compute for the committed installation. First the host's own
     * startup gate (a startupId this Driver chooses): the host verifies it and only then lets
     * `box run` start the stock protected program. Then, on a later pass, that program's own
     * startup challenge, read and answered through the host's pre-ready enrollment bridge into
     * Box with the transport bearer, as the contract and the bundled OpenShell Driver do: profile,
     * UUIDv4 startupId and the admitted plan's binding are checked before Compute is asked; the
     * program verifies the release itself. A program that is not listening yet stays pending; a
     * restarted or expired one (409/410) is read afresh on the next pass.
     */
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
      if (execution.protectedStartup?.startupSha256 === undefined) {
        await this.releaseHostGate(context, owner, execution, release);
        return;
      }
      // Ready: Codex listens, so the program accepted its release.
      if (execution.state !== "starting") return;
      await this.releaseHarness(context, installation, owner, execution, release);
    }

    private async releaseHostGate(
      context: SandboxHarnessStatusContext,
      owner: Owner,
      execution: Execution,
      release: (startupId: string) => Promise<Readonly<Record<string, unknown>>>,
    ): Promise<void> {
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

    private async releaseHarness(
      context: SandboxHarnessStatusContext,
      installation: EgressInstallation,
      owner: Owner,
      execution: Execution,
      release: (startupId: string) => Promise<Readonly<Record<string, unknown>>>,
    ): Promise<void> {
      const key = {
        owner,
        executionId: execution.executionId,
        requirementsDigest: execution.requirementsDigest,
        transportToken: context.transportToken,
      };
      const read = await harnessEnrollment(this.options.controlSocket, key, context.signal);
      // Not listening yet, or no longer serving a challenge: the next pass observes it again.
      if (read === undefined || read.status !== 200) return;
      // The challenge comes from inside the sandbox: untrusted until it matches this execution.
      const challenge = record(read.document);
      const { profile, startupId, ...binding } = challenge ?? {};
      if (
        challenge === undefined ||
        profile !== RELEASE_PROFILE ||
        typeof startupId !== "string" ||
        !UUID_V4.test(startupId) ||
        !isDeepStrictEqual(binding, enrollmentBinding(installation.plan))
      ) {
        throw new DependencyUnavailableError(
          "The Harness enrollment challenge does not match the admitted execution.",
        );
      }
      const signed = await release(startupId);
      if (!isDeepStrictEqual(signed.challenge, challenge)) {
        throw new DependencyUnavailableError(
          "Compute's release is not for the Harness enrollment challenge.",
        );
      }
      const posted = await harnessEnrollment(
        this.options.controlSocket,
        { ...key, release: signed },
        context.signal,
      );
      // Gone, restarted or expired: the next pass reads the fresh challenge.
      if (posted === undefined || posted.status === 409 || posted.status === 410) return;
      if (
        posted.status !== 200 ||
        !isDeepStrictEqual(posted.document, { enrolled: true, startupId })
      ) {
        throw new DependencyUnavailableError("The Harness enrollment was not acknowledged.");
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
      if (!shared.admits(plan)) {
        throw new DependencyUnavailableError(
          "This Strands Box registration supports one online-request GitHub repository plan and its own model source.",
        );
      }
      return { plan, configuration: structuredClone(shared.wiringFor(plan)) };
    },
    async wiringStatus(context, prepared) {
      if (
        !samePlan(prepared.plan, context.plan) ||
        !samePlan(prepared.configuration, shared.wiringFor(context.plan))
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
  const store = shared.store;
  const route = options.controlledInference?.modelBaseUrl;
  // The Gateway view sees the live execution only through the host the Sandbox owns.
  const modelHost = {
    async attachment(revisionId: string, signal: AbortSignal) {
      const execution = await shared.read(signal);
      if (
        execution === undefined ||
        execution.state === "failed" ||
        execution.owner.revisionId !== revisionId ||
        execution.owner.driverId !== id ||
        execution.harnessModel === undefined
      ) {
        return undefined;
      }
      return {
        sourceId: execution.harnessModel.sourceId,
        revoked: execution.harnessModel.revoked !== undefined,
      };
    },
    /**
     * The receipt is keyed by the revision's owner (built from OCE's withdrawal context, as the
     * Sandbox's own `owner()`), not by a live execution: a failed execution, or a host that
     * restarted without one, still gets it (finding 3301). The host's PUT reloads it.
     */
    async revoke(
      { namespace, revision }: Pick<CredentialWithdrawalContext, "namespace" | "revision">,
      sourceId: string,
      signal: AbortSignal,
    ) {
      if (
        namespace.name !== options.namespace ||
        namespace.id !== revision.namespaceId ||
        revision.sandboxDriverId !== id
      ) {
        return undefined;
      }
      return revokeHarnessModel(
        options.controlSocket,
        {
          owner: {
            driverId: id,
            implementation,
            namespaceId: namespace.id,
            namespaceName: namespace.name,
            agentId: revision.agentId,
            revisionId: revision.id,
          },
          sourceId,
        },
        signal,
      );
    },
  };
  const gateway =
    store === undefined || modelBaseUrl(route) === undefined
      ? undefined
      : createModelGateway(id, implementation, modelBaseUrl(route)!, store, modelHost);
  return {
    capabilities: {
      sandbox,
      credential_proxy: credentialProxy,
      ...(gateway === undefined ? {} : { credential_gateway: gateway }),
    },
    close: () => shared.close(),
  };
}
