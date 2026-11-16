/**
 * Paired protected registration: one Strands Box Sandbox and its Credential Proxy with shared
 * state. Selected only when the Installation configures `repositorySender`; the ordinary
 * `drivers.sandbox` loader refuses this registration, and the paired loader refuses the
 * ordinary Driver, so neither can be selected as the other.
 *
 * Custody: the GitHub App and the installation token stay in the Worker (prepared-git owner).
 * The fixed-repository sender runs in the Worker and reads material per request. Box holds only
 * a per-execution phantom bearer that authenticates the execution to this sender.
 */
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type Agent, createServer, type Server } from "node:https";
import { isIP } from "node:net";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  CredentialProxyDriver,
  DriverImplementation,
  DriverRegistration,
  EgressInstallation,
  EgressRef,
  ErrorDetail,
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
  SandboxHarnessContext,
  SandboxHarnessStatus,
  SandboxHarnessStatusContext,
  SandboxHarnessWithdrawalContext,
  SandboxProtectedWorkspaceStatusContext,
  SandboxRepositoryAccess,
  SandboxResourceRef,
} from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError } from "@openclaw-enterprise/occ";
import { BOX_PHANTOM_IDENTITY, createRepositorySender } from "../git/index.ts";
import type { CurrentGitRecipient, GitReceipt } from "../git/index.ts";
import { repositorySelection, type RepositorySelection } from "../git/protocol.ts";
import {
  canonicalJson,
  control,
  digest,
  record,
  releaseExecution,
  sameOwner,
  type Execution,
} from "./control.ts";
import type { Options, StrandsBoxDriver } from "./index.ts";

export interface RepositorySenderConfiguration {
  /** What Box connects to: `https://<name>:<port>/`, the name resolving to `address`. */
  readonly url: string;
  /** The one private IPv4 Box's egress policy pins for `url`. */
  readonly address: string;
  /** The Box host's source address as the Worker listener sees it; every other peer is dropped. */
  readonly peerAddress: string;
  readonly listenHost?: string;
  readonly listenPort: number;
  /** Worker-local PEM files. Box verifies this certificate, so it must chain to a root Box trusts. */
  readonly certificateFile: string;
  readonly keyFile: string;
  /** Worker-local owner-only directory; one journal subdirectory per execution. */
  readonly journalDir: string;
  readonly repository: RepositorySelection;
}

export const repositorySenderSchema: NonNullable<DriverImplementation["configurationSchema"]> = {
  type: "object",
  additionalProperties: false,
  required: [
    "url",
    "address",
    "peerAddress",
    "listenPort",
    "certificateFile",
    "keyFile",
    "journalDir",
    "repository",
  ],
  properties: {
    url: { type: "string", minLength: 1, maxLength: 256 },
    address: { type: "string", minLength: 7, maxLength: 15 },
    peerAddress: { type: "string", minLength: 7, maxLength: 15 },
    listenHost: { type: "string", minLength: 1, maxLength: 64 },
    listenPort: { type: "integer", minimum: 1024, maximum: 65535 },
    certificateFile: { type: "string", minLength: 1, maxLength: 1024 },
    keyFile: { type: "string", minLength: 1, maxLength: 1024 },
    journalDir: { type: "string", minLength: 1, maxLength: 1024 },
    repository: {
      type: "object",
      additionalProperties: false,
      required: ["repository", "repositoryId", "installationId", "head", "base"],
      properties: {
        repository: { type: "string", minLength: 1, maxLength: 256 },
        repositoryId: { type: "string", minLength: 1, maxLength: 256 },
        installationId: { type: "string", minLength: 1, maxLength: 256 },
        head: { type: "string", minLength: 1, maxLength: 256 },
        base: { type: "string", minLength: 1, maxLength: 256 },
      },
    },
  },
};

const WIRING_VERSION = 1;
const RELEASE_PUBLIC_KEY_ENV = "OPENCLAW_EGRESS_COMPUTE_RELEASE_PUBLIC_KEY";
const RELEASE_PROFILE = "oce-compute-execution-release-v1";
const PROCESS_INSTANCE = /^([a-f0-9-]{36}):([1-9][0-9]{0,9}):([1-9][0-9]{0,19})$/;

function privateIpv4(address: string): boolean {
  return isIP(address) === 4 && /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(address);
}

function senderUrl(value: string, address: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.pathname === "/" &&
      url.port !== "" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.toString() === value &&
      (isIP(url.hostname) === 0
        ? /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(url.hostname)
        : url.hostname === address)
    );
  } catch {
    return false;
  }
}

export function validateRepositorySender(
  sender: RepositorySenderConfiguration,
): readonly ErrorDetail[] {
  const errors: ErrorDetail[] = [];
  const invalid = (path: string, message: string) =>
    errors.push({ path: `/repositorySender${path}`, code: "INVALID_VALUE", message });
  if (!privateIpv4(sender.address))
    invalid("/address", "Use the one private IPv4 address the sender name resolves to for Box.");
  if (!senderUrl(sender.url, sender.address))
    invalid("/url", "Use the sender's canonical https://<name>:<port>/ origin.");
  if (!privateIpv4(sender.peerAddress))
    invalid("/peerAddress", "Use the Box host's private IPv4 source address.");
  for (const key of ["certificateFile", "keyFile", "journalDir"] as const) {
    if (!isAbsolute(sender[key])) invalid(`/${key}`, "Use an absolute Worker-local path.");
  }
  try {
    repositorySelection(sender.repository);
  } catch {
    invalid(
      "/repository",
      "Select one exact GitHub repository and distinct head and base branches.",
    );
  }
  return errors;
}

/** The nonsecret configuration the host compares with its own sender route. */
function wiringConfiguration(sender: RepositorySenderConfiguration) {
  return {
    version: WIRING_VERSION,
    repositorySender: { url: sender.url, address: sender.address },
  };
}

function senderRef(id: string): EgressRef {
  return { id: `${id}-repository-sender`, generation: 1 };
}

function samePlan(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
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

interface Recipient {
  readonly executionId: string;
  readonly revisionId: string;
  readonly installation: EgressInstallation;
  route?: RepositoryGitInstallationFence;
  confirmed?: RepositoryGitInstallationFence;
  version?: RepositoryGitMaterialVersion;
  settledAt?: number;
  sender?: ReturnType<typeof createRepositorySender>;
  binding?: { close(): void | Promise<void> };
}

/** State shared by the paired Sandbox and Credential Proxy of one registration. */
class Shared {
  readonly sender: EgressRef;
  readonly wiring: ReturnType<typeof wiringConfiguration>;
  readonly retained = new Map<string, HarnessWorkloadRequirements>();
  authority: ProtectedRepositoryGitAuthority | undefined;
  server: Server | undefined;
  active: Recipient | undefined;
  readonly id: string;
  readonly options: Options & { readonly repositorySender: RepositorySenderConfiguration };

  readonly upstreamAgent: Agent | undefined;

  constructor(
    id: string,
    options: Options & { readonly repositorySender: RepositorySenderConfiguration },
    upstreamAgent?: Agent,
  ) {
    this.id = id;
    this.options = options;
    this.upstreamAgent = upstreamAgent;
    this.sender = senderRef(id);
    this.wiring = wiringConfiguration(options.repositorySender);
  }

  read(signal: AbortSignal): Promise<Execution | undefined> {
    return control(this.options.controlSocket, { method: "GET" }, signal);
  }

  /**
   * The recipient exactly as the host observes it now: this host execution, its live `box run`
   * process and the digest of the bearer the host gave it. Never built from a request or from
   * Compute's record alone.
   */
  installationFrom(
    plan: ProxyPlan,
    execution: Execution | undefined,
  ): EgressInstallation | undefined {
    const sender = execution?.repositorySender;
    const startup = execution?.protectedStartup;
    if (
      execution === undefined ||
      execution.state === "failed" ||
      sender?.processInstanceId === undefined ||
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
      sender: this.sender,
      installedAt: startup.reservedAt,
      enforcement: {
        instanceId: execution.executionId,
        configurationId: digest(this.wiring),
        policyHash: digest({
          version: WIRING_VERSION,
          plan,
          route: this.wiring.repositorySender,
          generationSha256: startup.generationSha256,
        }),
        authorityScope: "execution",
        repositoryGitRecipient: {
          providerId: this.sender.id,
          attachmentEpoch: execution.executionId,
          processInstanceId: sender.processInstanceId,
          networkInstanceId: `${BOX_PHANTOM_IDENTITY}${sender.bearerSha256}`,
          authorization: "online-request",
          deliveryProfile: "github_repository",
        },
      },
    };
  }

  async current(signal: AbortSignal): Promise<CurrentGitRecipient | undefined> {
    const active = this.active;
    if (active?.confirmed === undefined || active.version === undefined) return undefined;
    const execution = await this.read(signal);
    const installation = this.installationFrom(active.installation.plan, execution);
    const sender = execution?.repositorySender;
    const process = PROCESS_INSTANCE.exec(sender?.processInstanceId ?? "");
    if (
      installation === undefined ||
      sender === undefined ||
      process === null ||
      execution?.executionId !== active.executionId ||
      !isDeepStrictEqual(installation, active.installation) ||
      this.active !== active
    ) {
      return undefined;
    }
    return {
      installation,
      route: active.confirmed,
      version: active.version,
      original: {
        running: true,
        executionId: installation.plan.execution.executionId,
        bootId: process[1]!,
        pid: Number(process[2]),
        startTicks: process[3]!,
      },
      executionBearerSha256: sender.bearerSha256,
    };
  }

  async retire(): Promise<void> {
    const active = this.active;
    this.active = undefined;
    await active?.binding?.close();
  }

  journal(executionId: string): string {
    const root = this.options.repositorySender.journalDir;
    const path = join(root, createHash("sha256").update(executionId).digest("hex").slice(0, 32));
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const stat = lstatSync(path);
    if (!stat.isDirectory() || realpathSync(path) !== path || (stat.mode & 0o777) !== 0o700) {
      throw new DependencyUnavailableError("The sender journal directory is not owner-only.");
    }
    return path;
  }

  /**
   * One Worker pass: re-observe the host's current execution, the committed recipient, and the
   * eligible material version. The sender in this Worker is the recipient; it holds no copy of
   * the material and reads that exact version on each request.
   */
  async reconcile(signal: AbortSignal): Promise<void> {
    const authority = this.authority;
    if (authority === undefined) return;
    const execution = await this.read(signal);
    const plan = execution?.protectedStartup?.plan as ProxyPlan | undefined;
    const installation = plan === undefined ? undefined : this.installationFrom(plan, execution);
    if (execution === undefined || installation === undefined) {
      await this.retire();
      return;
    }
    if (
      this.active !== undefined &&
      (this.active.executionId !== execution.executionId ||
        !isDeepStrictEqual(this.active.installation, installation))
    ) {
      await this.retire();
    }
    const active = (this.active ??= {
      executionId: execution.executionId,
      revisionId: installation.plan.execution.revisionId,
      installation,
    });
    const route = await authority.recipients.observe(installation);
    if (route === undefined || this.active !== active) return;
    active.route = route;
    const git = authority.online.githubRepository;
    const material = git === undefined ? undefined : await git.readMaterial(route, signal);
    if (material === undefined || "absent" in material || this.active !== active) return;
    const version = {
      preparationAttemptId: material.preparationAttemptId,
      materialVersion: material.materialVersion,
    };
    if (isDeepStrictEqual(active.version, version)) return;
    const pending = await authority.recipients.beginInstall(route, version);
    if (pending === undefined || this.active !== active) return;
    const confirmed = await authority.recipients.confirmInstall(pending);
    if (confirmed === undefined || this.active !== active) return;
    active.confirmed = confirmed;
    active.version = version;
    active.settledAt = Date.now();
    if (active.sender === undefined) {
      const sender = createRepositorySender({
        execution: installation.plan.execution,
        driver: installation.plan.driver!,
        sender: this.sender,
        repository: this.options.repositorySender.repository,
        journalDir: this.journal(installation.plan.execution.executionId),
        current: (lifetime) => this.current(lifetime),
        record: receipt,
        ...(this.upstreamAgent === undefined ? {} : { upstreamAgent: this.upstreamAgent }),
      });
      active.binding = await sender.bindRepositoryGit(authority);
      active.sender = sender;
    }
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    const sender = this.active?.sender;
    if (sender === undefined) {
      res.writeHead(403, { "cache-control": "no-store", "content-length": "0" }).end();
      return;
    }
    void sender.handle(req, res);
  }

  async bind(authority: ProtectedRepositoryGitAuthority): Promise<RepositoryGitBinding> {
    if (this.authority !== undefined || authority.online.githubRepository === undefined) {
      throw new DependencyUnavailableError(
        "The selected online GitHub repository authority is unavailable.",
      );
    }
    const sender = this.options.repositorySender;
    const server = createServer(
      {
        cert: readFileSync(sender.certificateFile),
        key: readFileSync(sender.keyFile),
        requestTimeout: 30_000,
        headersTimeout: 10_000,
        maxHeaderSize: 8_192,
      },
      (req, res) => this.handle(req, res),
    );
    server.maxConnections = 16;
    // Only the Box host reaches this listener; the NetworkPolicy is the outer fence.
    server.on("connection", (socket) => {
      const remote = socket.remoteAddress?.replace(/^::ffff:/, "");
      if (remote !== sender.peerAddress) socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(sender.listenPort, sender.listenHost ?? "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.authority = authority;
    this.server = server;
    return {
      reconcile: (signal) => this.reconcile(signal),
      close: () => this.close(),
    };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.authority = undefined;
    await this.retire();
    if (server !== undefined) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

function receipt(row: GitReceipt): void {
  // Receipts carry stages and identifiers only, never material or the bearer.
  process.stderr.write(`${JSON.stringify({ event: "strands-box.repository-sender", ...row })}\n`);
}

export function createProtectedRegistration(
  Base: typeof StrandsBoxDriver,
  id: string,
  implementation: string,
  input: Options,
  /** Test seam only: `createDriver` never passes it, so configuration cannot select it. */
  seams: { readonly upstreamAgent?: Agent } = {},
): DriverRegistration {
  const configured = input.repositorySender;
  if (configured === undefined) throw new Error("repositorySender is required.");
  const options = { ...structuredClone(input), repositorySender: structuredClone(configured) };
  const shared = new Shared(id, options, seams.upstreamAgent);

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
      // OCC withdraws the binding; the sender then refuses before any provider connection.
      // The Box execution and its chat keep running.
      retireExpired: async () => "withdrawn",
      routeReadiness: (revisionId) =>
        shared.active?.revisionId === revisionId && shared.active.route !== undefined
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
          "This paired Strands Box registration runs only a protected one-repository revision through its fixed sender.",
        );
      }
    }

    /** A fresh bearer per PUT; the host keeps it only in memory and in `box run`. */
    protected override executionInputs(): Readonly<Record<string, string>> {
      return { repositorySenderBearer: randomBytes(32).toString("base64url") };
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
        await shared.retire();
      }
    }
  }

  const sandbox = new ProtectedStrandsBoxDriver(id, implementation, options);
  const credentialProxy: CredentialProxyDriver = {
    id,
    implementation,
    capability: "credential_proxy",
    sourceControl: {
      sender: shared.sender,
      backend: shared.sender,
      resolver: shared.sender,
      providers: [],
      async assertAvailable(signal, profile) {
        if (profile !== "github_repository") {
          throw new DependencyUnavailableError(
            "This Strands Box registration delivers only one GitHub repository through its sender.",
          );
        }
        // In the Worker, prove the host and the bound listener answer. The API process loads
        // the package but never binds; its admission answer is the configured guarantee, and the
        // Worker repeats this check in configure before any wiring.
        if (shared.authority !== undefined) {
          await shared.read(signal);
          if (shared.server?.listening !== true) {
            throw new DependencyUnavailableError("The repository sender listener is not bound.");
          }
        }
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
      if (shared.active?.revisionId === context.revision.id) await shared.retire();
      return true;
    },
    bindRepositoryGit: (authority) => shared.bind(authority),
  };
  return {
    capabilities: { sandbox, credential_proxy: credentialProxy },
    close: () => shared.close(),
  };
}
