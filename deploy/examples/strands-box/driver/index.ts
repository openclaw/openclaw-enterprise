import { createHash, timingSafeEqual, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { isAbsolute, normalize } from "node:path";
import type {
  DriverImplementation,
  ErrorDetail,
  HarnessWorkloadRequirements,
  OpenClawConfigurationDocument,
  RevisionHarnessDescriptor,
  SandboxDriver,
  SandboxHarnessContext,
  SandboxHarnessEndpoint,
  SandboxHarnessStatus,
  SandboxHarnessStatusContext,
  SandboxNamespaceContext,
  SandboxResourceRef,
} from "@openclaw-enterprise/contracts";
import {
  ConfigurationHarnessError,
  DependencyUnavailableError,
  SandboxRevisionUnsupportedError,
  TransientDependencyError,
} from "@openclaw-enterprise/occ";
import { validateWorkspaceNodeSetupSecret } from "@openclaw-enterprise/utils";
import {
  control,
  digest,
  record,
  requestAdmission,
  sameExecution,
  sameOwner,
  type Execution,
  type Owner,
  type WorkspaceNodeMode,
  type WorkspaceVolume,
  sameWorkspaceVolume,
  workspaceVolume,
} from "./control.ts";
import { nativeStatus } from "./native.ts";
import { readObject, Relay, relayName, type RelayOptions } from "./relay.ts";

interface Options {
  readonly namespace: string;
  readonly controlSocket: string;
  readonly nativeEndpoint: string;
  readonly nativeCaBundle: string;
  readonly workspaceRoot: string;
  readonly relay: RelayOptions;
  readonly controlledInference?: { readonly modelBaseUrl: string };
  readonly workspaceNodeMode?: WorkspaceNodeMode;
}

const DNS_LABEL = "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$";
const SETUP_ENV = "OPENCLAW_NODE_SETUP_CODE";
const TRANSPORT_VERIFIER = "APP_TOKEN_SHA";
const MODEL_ENV = "OPENAI_API_KEY";
const MODEL_MARKER = "openclaw-strands-controlled-inference-v1";
type SecretKey = { readonly name: string; readonly key: string };

export const configurationSchema: NonNullable<DriverImplementation["configurationSchema"]> = {
  type: "object",
  additionalProperties: false,
  required: [
    "namespace",
    "controlSocket",
    "nativeEndpoint",
    "nativeCaBundle",
    "workspaceRoot",
    "relay",
  ],
  properties: {
    namespace: { type: "string", pattern: DNS_LABEL },
    controlSocket: { type: "string", minLength: 1, maxLength: 100 },
    nativeEndpoint: { type: "string", minLength: 1, maxLength: 256 },
    nativeCaBundle: { type: "string", minLength: 1, maxLength: 32768 },
    workspaceRoot: { type: "string", minLength: 1, maxLength: 1024 },
    workspaceNodeMode: { type: "string", enum: ["file-only-v1"] },
    controlledInference: {
      type: "object",
      additionalProperties: false,
      required: ["modelBaseUrl"],
      properties: { modelBaseUrl: { type: "string", minLength: 1, maxLength: 256 } },
    },
    relay: {
      type: "object",
      additionalProperties: false,
      required: ["image", "hostAddress", "installation", "workerPeer"],
      properties: {
        image: { type: "string", pattern: "^[^\\s@]+@sha256:[0-9a-f]{64}$" },
        hostAddress: { type: "string" },
        installation: { type: "string", pattern: DNS_LABEL },
        workerPeer: {
          type: "object",
          additionalProperties: false,
          required: ["namespace", "podLabels"],
          properties: {
            namespace: { type: "string", pattern: DNS_LABEL },
            podLabels: {
              type: "object",
              minProperties: 1,
              additionalProperties: { type: "string", minLength: 1 },
            },
          },
        },
      },
    },
  },
} as const;

function safePath(path: string): boolean {
  return (
    isAbsolute(path) &&
    normalize(path) === path &&
    path !== "/" &&
    !/[\u0000-\u0020\u007f]/u.test(path)
  );
}

function relayAddress(address: string): boolean {
  return isIP(address) === 4 && /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(address);
}

function privateModelBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.pathname === "/v1" &&
      (relayAddress(url.hostname) || url.hostname.endsWith(".svc.cluster.local")) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.toString() === value
    );
  } catch {
    return false;
  }
}

function rootEndpoint(input: string): URL {
  const url = new URL(input);
  if (
    url.protocol !== "wss:" ||
    url.port !== "8443" ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !url.hostname.endsWith(".svc.cluster.local") ||
    url.toString() !== input
  ) {
    throw new Error("Invalid Harness endpoint");
  }
  return url;
}

function publicCa(pem: string): boolean {
  const certificatePattern =
    /-----BEGIN CERTIFICATE-----[\sA-Za-z0-9+/=]+-----END CERTIFICATE-----/g;
  const certificates = pem.match(certificatePattern);
  return (
    certificates !== null &&
    pem.replace(certificatePattern, "").trim() === "" &&
    certificates.every((certificate) => {
      try {
        return new X509Certificate(certificate).ca;
      } catch {
        return false;
      }
    })
  );
}

export function validateConfiguration(
  config: Readonly<Record<string, unknown>>,
): readonly ErrorDetail[] {
  // The external loader has already validated the closed structural schema.
  const options = config as unknown as Options;
  const errors: ErrorDetail[] = [];
  const invalid = (path: string, message: string) =>
    errors.push({ path, code: "INVALID_VALUE", message });
  if (!safePath(options.controlSocket))
    invalid("/controlSocket", "Use a normalized absolute path to the private Unix control socket.");
  if (!safePath(options.workspaceRoot) || !options.workspaceRoot.startsWith("/home/node/")) {
    invalid("/workspaceRoot", "Use the exact admitted workspace below /home/node.");
  }
  try {
    if (
      rootEndpoint(options.nativeEndpoint).hostname !==
      `box-harness.${options.namespace}.svc.cluster.local`
    ) {
      throw new Error("The Harness Service must be in the selected namespace");
    }
  } catch {
    invalid("/nativeEndpoint", "Use the canonical private Service WSS origin on port 8443.");
  }
  if (!publicCa(options.nativeCaBundle))
    invalid("/nativeCaBundle", "Supply public PEM CA certificates only.");
  if (!relayAddress(options.relay.hostAddress))
    invalid("/relay/hostAddress", "Use one dedicated private IPv4 address.");
  if (
    options.controlledInference &&
    !privateModelBaseUrl(options.controlledInference.modelBaseUrl)
  ) {
    invalid(
      "/controlledInference/modelBaseUrl",
      "Use the single private HTTPS /v1 origin of the controlled model fixture.",
    );
  }
  if (options.workspaceNodeMode !== undefined && options.controlledInference === undefined) {
    invalid("/workspaceNodeMode", "The file-only workspace node requires controlled inference.");
  }
  return errors;
}

export function createDriver(input: {
  readonly id: string;
  readonly implementation: string;
  readonly configuration: Readonly<Record<string, unknown>>;
}): SandboxDriver {
  return new StrandsBoxDriver(
    input.id,
    input.implementation,
    input.configuration as unknown as Options,
  );
}

class StrandsBoxDriver implements SandboxDriver {
  readonly capability = "sandbox" as const;
  readonly harnessTransportCredential = "verifier" as const;
  readonly facets = Object.freeze(["networking", "filesystem", "process"] as const);
  readonly supportsHarnessExecutionMode = Object.freeze({
    openclaw: Object.freeze({
      embedded: Object.freeze({
        supported: false,
        reason: "Strands Box requires dedicated Codex.",
      }),
      dedicated: Object.freeze({
        supported: false,
        reason: "Strands Box requires dedicated Codex.",
      }),
    }),
  });
  readonly harnessHome = "/home/node";
  readonly id: string;
  readonly implementation: string;
  private readonly options: Options;
  private readonly relay: Relay;

  constructor(id: string, implementation: string, options: Options) {
    this.id = id;
    this.implementation = implementation;
    this.options = structuredClone(options);
    this.relay = new Relay(
      this.options.relay,
      this.options.nativeEndpoint,
      this.options.nativeCaBundle,
    );
  }

  configureAgent(
    configuration: Readonly<OpenClawConfigurationDocument>,
    harness: Readonly<RevisionHarnessDescriptor>,
  ): OpenClawConfigurationDocument {
    if (harness.id !== "codex" || harness.mode !== "dedicated") {
      throw new ConfigurationHarnessError("Strands Box requires dedicated Codex.");
    }
    const plugins = record(configuration.plugins);
    const entries = record(plugins?.entries);
    const codex = record(entries?.codex);
    const appServer = record(record(codex?.config)?.appServer);
    if (
      this.options.workspaceNodeMode !== undefined &&
      record(entries?.["file-transfer"])?.config !== undefined
    ) {
      throw new ConfigurationHarnessError(
        "The file-only workspace node uses the Gateway's exact workspace file policy.",
      );
    }
    const sandbox = appServer?.sandbox;
    const proxy = record(appServer?.networkProxy);
    if (sandbox !== "read-only" && sandbox !== "workspace-write") {
      throw new ConfigurationHarnessError(
        "Strands Box requires an explicit read-only or workspace-write Codex sandbox.",
      );
    }
    if (sandbox === "read-only" && proxy?.enabled === true && proxy.baseProfile === "workspace") {
      throw new ConfigurationHarnessError(
        "The selected Codex workspace profile conflicts with read-only sandbox mode.",
      );
    }
    return structuredClone(configuration);
  }

  harnessResource(
    context: Pick<SandboxHarnessContext, "namespace" | "revision">,
  ): SandboxResourceRef {
    const owner = this.owner(context);
    return {
      namespaceName: owner.namespaceName,
      resourceName: relayName(this.options.relay.installation),
      agentId: owner.agentId,
      revisionId: owner.revisionId,
    };
  }

  async provisionHarness(context: SandboxHarnessContext): Promise<SandboxResourceRef> {
    const owner = this.owner(context);
    this.requireOrdinary(context);
    const requirements = context.requirements;
    this.verifier(requirements);
    if (
      !/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(requirements.image) ||
      requirements.command.length === 0 ||
      !requirements.workspaceMounts.some(
        (mount) => mount.mountPath === this.options.workspaceRoot && !mount.readOnly,
      ) ||
      requirements.labels["openclaw.dev/agent"] !== owner.agentId ||
      requirements.labels["openclaw.dev/revision"] !== owner.revisionId ||
      requirements.labels["openclaw.dev/workload-role"] !== "agent" ||
      requirements.labels["openclaw.dev/network-profile"] !== "provider-fenced-v1"
    ) {
      this.refuse(
        "Strands Box requires a digest-pinned image, exact command, workspace and revision labels.",
      );
    }
    if (requirements.workloadIdentity || requirements.workspaceSetup) {
      this.refuse(
        "Strands Box requires the Compute transport verifier and pre-staged workspace without projected workload identity or setup files.",
      );
    }
    const { setup, model } = this.secretReferences(requirements);
    if (
      this.options.workspaceNodeMode !== undefined &&
      (setup === undefined || model === undefined)
    ) {
      this.refuse(
        "The file-only workspace node requires the stock pairing and controlled inference projections.",
      );
    }
    const volume = await this.readWorkspaceVolume(context);
    const requirementsDigest = digest(requirements);
    const admission = {
      owner,
      requirementsDigest,
      requirements,
      ...(volume === undefined ? {} : { workspaceVolume: volume }),
    };
    let execution = await this.readExecution(context.signal);
    if (execution === undefined) {
      if (
        (await requestAdmission(
          this.options.controlSocket,
          admission,
          context.signal,
          this.options.workspaceNodeMode,
        )) === "held"
      ) {
        throw new TransientDependencyError(
          "sandbox_gateway",
          "unavailable",
          "Strands Box is waiting for operator approval of this exact workload.",
        );
      }
      if (model) await this.confirmControlledModelMarker(context, model);
      await this.assertWorkspaceVolume(context, volume);
      const setupMaterial = setup === undefined ? undefined : await this.setupCode(context, setup);
      await this.assertWorkspaceVolume(context, volume);
      // Do not send a one-shot code after another execution appeared during the Secret read.
      execution = await this.readExecution(context.signal);
      if (execution === undefined) {
        if (setupMaterial && setupMaterial.expiresAtMs <= Date.now()) {
          throw new DependencyUnavailableError(
            "The exact workspace node setup Secret has expired.",
          );
        }
        execution = await control(
          this.options.controlSocket,
          {
            method: "PUT",
            body: {
              ...admission,
              ...(setupMaterial === undefined
                ? {}
                : { workspaceNodeSetupCode: setupMaterial.code }),
              ...(model === undefined ? {} : { controlledInference: true }),
            },
          },
          context.signal,
        );
      }
    }
    if (
      !execution ||
      !sameOwner(execution.owner, owner) ||
      !sameWorkspaceVolume(execution.workspaceVolume, volume) ||
      execution.requirementsDigest !== requirementsDigest
    ) {
      throw new DependencyUnavailableError(
        "The Strands Box execution is absent or belongs to different admitted inputs.",
      );
    }
    this.exactEndpoint(execution);
    const observed = await this.readExecution(context.signal);
    if (!observed || !sameExecution(execution, observed)) {
      throw new DependencyUnavailableError("The Strands Box execution changed during preparation.");
    }
    await this.relay.prepare(context, observed, requirements.labels);
    return this.harnessResource(context);
  }

  async harnessEndpoint(context: SandboxHarnessContext): Promise<SandboxHarnessEndpoint> {
    this.requireOrdinary(context);
    const execution = await this.current(context);
    return this.exactEndpoint(execution);
  }

  async harnessStatus(context: SandboxHarnessStatusContext): Promise<SandboxHarnessStatus> {
    this.requireOrdinary(context);
    const verifier = this.verifier(context.requirements);
    if (
      !/^[A-Za-z0-9._~+/-]+=*$/.test(context.transportToken) ||
      !timingSafeEqual(
        Buffer.from(verifier, "hex"),
        createHash("sha256").update(context.transportToken).digest(),
      )
    ) {
      throw new DependencyUnavailableError(
        "The Compute Harness transport credential does not match the admitted verifier.",
      );
    }
    const before = await this.current(context);
    if (before.state !== "running") return { state: "starting" };
    const endpoint = this.exactEndpoint(before);
    const status = await nativeStatus(
      endpoint.url,
      this.options.nativeCaBundle,
      context.transportToken,
      context.signal,
      before.generationSha256,
    );
    const after = await this.current(context);
    if (!sameExecution(before, after)) {
      throw new DependencyUnavailableError(
        "The Strands Box execution changed during the native status read.",
      );
    }
    if (status.state === "serving" && after.state !== "running") return { state: "starting" };
    return status;
  }

  async cleanup(
    context: SandboxNamespaceContext & { readonly revision?: SandboxHarnessContext["revision"] },
  ): Promise<void> {
    if (context.namespace.name !== this.options.namespace) return;
    const owner = context.revision
      ? this.owner({ namespace: context.namespace, revision: context.revision })
      : undefined;
    const execution = await this.readExecution(context.signal);
    if (
      execution &&
      (owner
        ? !sameOwner(execution.owner, owner)
        : execution.owner.namespaceId !== context.namespace.id ||
          execution.owner.namespaceName !== context.namespace.name ||
          execution.owner.driverId !== this.id ||
          execution.owner.implementation !== this.implementation)
    ) {
      throw new DependencyUnavailableError("Refusing to remove a foreign Strands Box execution.");
    }
    await this.relay.cleanup(context, owner ?? execution?.owner ?? {});
    if (!execution) return;
    const observed = await this.readExecution(context.signal);
    if (!observed) return;
    if (!sameExecution(execution, observed)) {
      throw new DependencyUnavailableError("The Strands Box execution changed before removal.");
    }
    const { executionId, requirementsDigest } = observed;
    await control(
      this.options.controlSocket,
      {
        method: "DELETE",
        body: { owner: observed.owner, executionId, requirementsDigest },
      },
      context.signal,
    );
    if (await this.readExecution(context.signal)) {
      throw new DependencyUnavailableError("The Strands Box host has not confirmed removal.");
    }
  }

  private owner({
    namespace,
    revision,
  }: Pick<SandboxHarnessContext, "namespace" | "revision">): Owner {
    if (
      namespace.name !== this.options.namespace ||
      namespace.id !== revision.namespaceId ||
      revision.sandboxDriverId !== this.id
    ) {
      throw new DependencyUnavailableError(
        "The selected Strands Box revision or namespace does not match.",
      );
    }
    return {
      driverId: this.id,
      implementation: this.implementation,
      namespaceId: namespace.id,
      namespaceName: namespace.name,
      agentId: revision.agentId,
      revisionId: revision.id,
    };
  }

  private requireOrdinary({ revision, requirements }: SandboxHarnessContext): void {
    if (
      revision.executionAdmission.mode !== "unprotected" ||
      revision.egressPlan ||
      revision.repositoryCredentials ||
      requirements.proxyWiring ||
      requirements.credentialAttachments.length !== 0
    ) {
      this.refuse(
        "This Strands Box example does not implement paired protected execution or repository credential delivery.",
      );
    }
    if (revision.harness.id !== "codex" || revision.harness.mode !== "dedicated") {
      this.refuse("Strands Box requires dedicated Codex.");
    }
  }

  private verifier(requirements: HarnessWorkloadRequirements): string {
    const matches = requirements.environment.filter(({ name }) => name === TRANSPORT_VERIFIER);
    const item = matches.length === 1 ? matches[0] : undefined;
    if (!item || !("value" in item) || !/^[0-9a-f]{64}$/.test(item.value)) {
      this.refuse("Strands Box requires the exact Compute-owned transport verifier.");
    }
    return item.value;
  }

  private secretReferences(requirements: HarnessWorkloadRequirements) {
    const names = new Set<string>();
    let setup: SecretKey | undefined;
    let model: SecretKey | undefined;
    for (const entry of requirements.environment) {
      if (names.has(entry.name) || entry.name === "APP_SERVER_TOKEN") {
        this.refuse("The Strands Box Harness environment contains an unsupported variable.");
      }
      names.add(entry.name);
      if ("value" in entry) {
        if (
          entry.name === SETUP_ENV ||
          entry.name === MODEL_ENV ||
          entry.name === "CODEX_ACCESS_TOKEN"
        ) {
          this.refuse(
            "The Strands Box Harness must not receive model credentials or a literal workspace setup code.",
          );
        }
      } else if (entry.name === SETUP_ENV && entry.valueFrom.secretKeyRef.key === "setupCode") {
        setup = entry.valueFrom.secretKeyRef;
      } else if (
        entry.name === MODEL_ENV &&
        entry.valueFrom.secretKeyRef.key === MODEL_ENV &&
        requirements.loginMode === "api_key" &&
        this.options.controlledInference !== undefined
      ) {
        model = entry.valueFrom.secretKeyRef;
      } else {
        this.refuse(
          "The Strands Box Harness supports only the exact workspace node setup Secret projection.",
        );
      }
    }
    if (model !== undefined) {
      const manifests = requirements.files.filter(
        ({ name, environmentVariable }) =>
          name === "runtime.json" && environmentVariable === "OPENCLAW_PLUGIN_RUNTIME_MANIFEST",
      );
      try {
        const file = manifests.length === 1 ? manifests[0] : undefined;
        const manifest = file === undefined ? undefined : record(JSON.parse(file.content));
        if (
          record(manifest?.modelEndpoint)?.baseUrl !==
          this.options.controlledInference?.modelBaseUrl
        ) {
          throw new Error("Different model endpoint");
        }
      } catch {
        this.refuse(
          "The admitted Harness model endpoint does not match the controlled inference fixture.",
        );
      }
    }
    return { setup, model };
  }

  private readSecret(context: SandboxHarnessContext, reference: SecretKey) {
    return readObject(context, {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: reference.name, namespace: context.namespace.name },
    });
  }

  private async confirmControlledModelMarker(
    context: SandboxHarnessContext,
    reference: SecretKey,
  ): Promise<void> {
    const secret = record(await this.readSecret(context, reference));
    const meta = record(secret?.metadata);
    const labels = record(meta?.labels);
    const encoded = record(secret?.data)?.[reference.key];
    if (
      meta?.name !== reference.name ||
      meta?.namespace !== context.namespace.name ||
      meta?.deletionTimestamp !== undefined ||
      labels?.["openclaw.dev/namespace"] !== context.namespace.id ||
      labels["openclaw.dev/agent"] !== context.revision.agentId ||
      labels["openclaw.dev/revision"] !== context.revision.id ||
      encoded !== Buffer.from(MODEL_MARKER, "utf8").toString("base64")
    ) {
      this.refuse(
        "The selected controlled inference fixture did not supply its exact non-authorizing marker.",
      );
    }
  }

  private async setupCode(context: SandboxHarnessContext, reference: SecretKey) {
    const secret = await this.readSecret(context, reference);
    try {
      const document = record(secret);
      const metadata = record(document?.metadata);
      if (metadata?.name !== reference.name || metadata?.deletionTimestamp !== undefined) {
        throw new Error("Wrong or deleting setup Secret");
      }
      const setup = validateWorkspaceNodeSetupSecret(secret, {
        namespace: context.namespace.name,
        namespaceId: context.namespace.id,
        agentId: context.revision.agentId,
        key: reference.key,
      });
      const encoded = record(document?.data)?.[reference.key];
      if (typeof encoded !== "string") throw new Error("No setup value");
      context.signal.throwIfAborted();
      return {
        code: Buffer.from(encoded, "base64").toString("utf8"),
        expiresAtMs: setup.expiresAtMs,
      };
    } catch {
      context.signal.throwIfAborted();
      throw new DependencyUnavailableError("The exact workspace node setup Secret is unavailable.");
    }
  }

  private async readExecution(signal: AbortSignal) {
    const execution = await control(this.options.controlSocket, { method: "GET" }, signal);
    if (execution !== undefined && execution.workspaceNodeMode !== this.options.workspaceNodeMode) {
      throw new DependencyUnavailableError("The Strands Box host workspace node mode changed.");
    }
    return execution;
  }

  private async current(context: SandboxHarnessContext): Promise<Execution> {
    const owner = this.owner(context);
    const result = await this.readExecution(context.signal);
    // Activation renders a smaller status projection. The host retains the original immutable
    // requirements digest and never accepts a different owner in the current execution slot.
    if (!result || !sameOwner(result.owner, owner)) {
      throw new DependencyUnavailableError(
        "The current Strands Box execution does not own this revision.",
      );
    }
    await this.assertWorkspaceVolume(context, result.workspaceVolume);
    await this.relay.assertCurrent(context, result);
    return result;
  }

  private async assertWorkspaceVolume(
    context: SandboxHarnessContext,
    expected?: WorkspaceVolume,
  ): Promise<void> {
    if (!sameWorkspaceVolume(await this.readWorkspaceVolume(context), expected)) {
      throw new DependencyUnavailableError(
        "The file-only node workspace claim is not the pinned bound volume.",
      );
    }
  }

  private async readWorkspaceVolume(
    context: SandboxHarnessContext,
  ): Promise<WorkspaceVolume | undefined> {
    if (this.options.workspaceNodeMode === undefined) return undefined;
    const name = context.requirements.workspaceMounts.find(
      ({ mountPath }) => mountPath === this.options.workspaceRoot,
    )?.claimName;
    if (
      name === undefined ||
      context.requirements.workspaceMounts.some(({ claimName }) => claimName !== name)
    ) {
      this.refuse("The file-only workspace node requires the same Harness workspace claim.");
    }
    const namespace = context.namespace.name;
    const claim = record(
      await readObject(context, {
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: { name, namespace },
      }),
    );
    const metadata = record(claim?.metadata);
    const labels = record(metadata?.labels);
    const volume = workspaceVolume({
      claimUid: metadata?.uid,
      volumeName: record(claim?.spec)?.volumeName,
    });
    if (
      claim?.kind !== "PersistentVolumeClaim" ||
      metadata?.name !== name ||
      metadata.namespace !== namespace ||
      metadata.deletionTimestamp !== undefined ||
      labels?.["openclaw.dev/namespace"] !== context.namespace.id ||
      labels["openclaw.dev/agent"] !== context.revision.agentId ||
      record(claim.status)?.phase !== "Bound" ||
      volume === undefined
    ) {
      throw new TransientDependencyError(
        "sandbox_gateway",
        "unavailable",
        "The exact file-only node workspace claim is not bound.",
      );
    }
    return volume;
  }

  private exactEndpoint(execution: Execution): SandboxHarnessEndpoint {
    if (
      execution.endpoint.url !== this.options.nativeEndpoint ||
      execution.endpoint.workspaceRoot !== this.options.workspaceRoot
    ) {
      throw new DependencyUnavailableError(
        "The Strands Box endpoint differs from the Installation's exact origin and workspace.",
      );
    }
    if (execution.workspaceNodeMode !== undefined && execution.generationSha256 === undefined) {
      throw new TransientDependencyError(
        "sandbox_gateway",
        "unavailable",
        "The original Strands Box workspace owner is still starting.",
      );
    }
    return {
      ...execution.endpoint,
      tls: { caBundle: this.options.nativeCaBundle },
      ...(execution.generationSha256 === undefined
        ? {}
        : { externalWorkspaceOwner: { generationSha256: execution.generationSha256 } }),
    };
  }

  private refuse(message: string): never {
    throw new SandboxRevisionUnsupportedError("SANDBOX_HARNESS_UNSUPPORTED", message);
  }
}
