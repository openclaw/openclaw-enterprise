import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { constants, lstatSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import {
  assertPinnedResolution,
  assertUpstreamCaScope,
  CONTROLLED_INFERENCE_MARKER,
  loadUpstreamCa,
  parseRoute,
  EXECUTION_BEARER,
  GITHUB_HOSTS,
  GITHUB_TOKEN_VALUE,
  routeView,
  sameRouteView,
} from "./egress.ts";
import type { EgressRoute, RouteView, UpstreamCa } from "./egress.ts";
import {
  ensureEmpty,
  fields,
  hostConfig,
  object,
  privateDirectory,
  readConfig,
  READY_FILE,
  start,
  string,
} from "./launch.ts";
import type { Execution, HostConfig, StartInput } from "./launch.ts";
import { listen, PORT, processIdentity } from "./transport.ts";

import {
  approve,
  currentController,
  durableRecord,
  isApproved,
  OWNER,
  sameOwner,
} from "./admission.ts";
import type { Owner, OwnerPin, Pending } from "./admission.ts";
import {
  assertHarnessImageCommand,
  assertHarnessImageLaunch,
  assertHarnessImageView,
  HARNESS_SPLIT_COMBINED_SHA256,
  HARNESS_SPLIT_COMMAND_SHA256,
  installHarnessImage,
  readHarnessImageSplit,
  readHarnessProc,
} from "./installed-harness-image.ts";
import type { HarnessImageInstallation } from "./installed-harness-image.ts";
import {
  assertNodeInputs,
  assertPinnedDirectory,
  assertStockCombinedCommand,
  FILE_NODE_STATE,
  mountIdentity,
  nodeRuntimeBytes,
  nodeInstallation,
  splitStockCommand,
  startWorkspaceNode,
  type MountIdentity,
  type NodeInstallation,
  type NodeLaunch,
} from "./installed-workspace-node.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const CONTROL = "/v1/execution";
const ADMISSION = "/v1/admission";
const RELEASE = "/v1/release";
const MAX_REQUEST = 512_000;
const WORKER_CONTROL = "worker-control";
const WORKSPACE = "/home/node/workspace";
const MOUNTS = {
  [WORKSPACE]: "workspace",
  "/home/node/.codex/generated_images": "generated-images",
  "/home/node/.codex/sessions": "codex-sessions",
  [FILE_NODE_STATE]: "node",
} as const;

interface InstalledConfig extends HostConfig {
  owner: OwnerPin;
  image: string;
  harnessImage?: HarnessImageInstallation;
  harnessImageSplit?: MountIdentity;
  controlSocketMode?: "worker-directory";
  profileSha256?: string;
  approvalDir?: string;
  endpoint: { url: string; workspaceRoot: string };
  workspaceClaim: string;
  mountIdentities: ReadonlyMap<string, MountIdentity>;
  workspaceSetupId?: string;
  writableState: string[];
  workspaceNode?: EgressRoute;
  separateWorkspaceNode?: NodeInstallation;
  controlledInference?: EgressRoute;
  /**
   * STAGE_A_PROTOTYPE: protected repository access on this host. Box injects the OCE-minted
   * GitHub installation token for `github.com` and `api.github.com` itself. `caSha256` opts the
   * GitHub routes in to `upstreamCa`, which Box applies to every upstream.
   */
  protectedRepository?: ProtectedRepository;
  upstreamCa?: UpstreamCa;
}

export interface RecordView {
  owner: Owner;
  requirementsDigest: string;
  executionId: string;
  state: "starting" | "running" | "failed";
  endpoint: InstalledConfig["endpoint"];
  workspaceNodeMode?: NodeInstallation["mode"];
  workspaceVolume?: NodeInstallation["workspaceVolume"];
  generationSha256?: string;
  /**
   * Host-observed recipient of this execution's repository material: the digest of the
   * per-execution bearer the Driver minted (never the bearer), `bootId:pid:startTicks` of this
   * host process, which receives the material, and, once `box run` holds it, the exact material
   * version and that live `box run` process. The Driver binds these into the recipient it reports.
   */
  repositoryRecipient?: RepositoryRecipient;
  /**
   * Protected startup: the reservation generation (fixed once `box run` exists, before any
   * release) and, after the host verified Compute's release, the release's SHA-256.
   */
  protectedStartup?: {
    plan: Record<string, unknown>;
    reservedAt: string;
    generationSha256?: string;
    startupId?: string;
    startupSha256?: string;
  };
  controlledInference?: RouteView;
}

interface LaunchPlan extends StartInput {
  readonly separateNode?: NodeLaunch;
  /** Present only for a protected revision on a host configured with a repository sender. */
  readonly protectedStartup?: ProtectedStartup;
}

export const ENROLLMENT_REVISION_ENV = "OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID";
export const RELEASE_PUBLIC_KEY_ENV = "OPENCLAW_EGRESS_COMPUTE_RELEASE_PUBLIC_KEY";
export const RELEASE_PROFILE = "oce-compute-execution-release-v1";
export const PROTECTED_WIRING_VERSION = 2;
export const MATERIAL = "/v1/repository-material";

export interface ProtectedRepository {
  readonly provider: "github";
  readonly caSha256?: string;
}

export interface RepositoryRecipient {
  bearerSha256: string;
  processInstanceId: string;
  installed?: {
    preparationAttemptId: string;
    materialVersion: string;
    boxProcessInstanceId: string;
  };
}

/** STAGE_A_PROTOTYPE: the material the Worker delivers once per execution. */
export interface DeliveredMaterial {
  readonly preparationAttemptId: string;
  readonly materialVersion: string;
  readonly expiresAt: string;
  readonly installationId: string;
  readonly repositories: readonly { readonly repositoryId: string; readonly repository: string }[];
  readonly value: string;
}

export interface ProtectedStartup {
  readonly releaseKey: KeyObject;
  readonly plan: Record<string, unknown>;
}

/**
 * The exact nonsecret wiring the paired Driver and this host agree on for protected access.
 * STAGE_A_PROTOTYPE: Box injects the installation token for the two public GitHub hosts itself.
 */
export function wiringConfiguration(provider: "github") {
  return {
    version: PROTECTED_WIRING_VERSION,
    protectedRepository: {
      provider,
      hosts: [...GITHUB_HOSTS] as readonly string[],
      delivery: "box-env-v1" as const,
    },
  };
}

/**
 * The exact protected inputs the paired Driver may hand to this host: one online-request
 * `github-repository` plan with no other routes, owned by this host's Driver and revision, whose
 * nonsecret configuration is exactly this host's protected repository wiring.
 */
export function protectedWiring(
  configured: ProtectedRepository | undefined,
  value: unknown,
  owner: Owner,
): Record<string, unknown> {
  const wiring = object(value);
  fields(wiring, ["plan", "configuration"]);
  const plan = object(wiring.plan);
  const execution = object(plan.execution);
  const git = object(plan.repositoryGit);
  const bindings = git.bindings;
  if (
    configured === undefined ||
    canonical(wiring.configuration) !== canonical(wiringConfiguration(configured.provider)) ||
    plan.repositoryGitAuthorization !== "online-request" ||
    !Array.isArray(plan.routes) ||
    plan.routes.length !== 0 ||
    plan.harnessCredentialSource !== undefined ||
    plan.policyReductionVersion !== undefined ||
    plan.sandboxDriverId !== owner.driverId ||
    plan.egressDriverId !== owner.driverId ||
    execution.namespaceId !== owner.namespaceId ||
    execution.agentId !== owner.agentId ||
    execution.revisionId !== owner.revisionId ||
    typeof execution.executionId !== "string" ||
    !Array.isArray(bindings) ||
    bindings.length !== 1 ||
    object(bindings[0]).profile !== "github-repository"
  ) {
    throw new Error("unadmitted_protected_wiring");
  }
  return plan;
}

const ID = /^[\x21-\x7e]{1,256}$/;

/** STAGE_A_PROTOTYPE: refuse anything but one complete, unexpired installation token. */
export function deliveredMaterial(value: unknown): DeliveredMaterial {
  const material = object(value);
  fields(material, [
    "preparationAttemptId",
    "materialVersion",
    "expiresAt",
    "installationId",
    "repositories",
    "value",
  ]);
  const repositories = material.repositories;
  if (
    typeof material.preparationAttemptId !== "string" ||
    !ID.test(material.preparationAttemptId) ||
    typeof material.materialVersion !== "string" ||
    !ID.test(material.materialVersion) ||
    typeof material.expiresAt !== "string" ||
    !(Date.parse(material.expiresAt) > Date.now()) ||
    typeof material.installationId !== "string" ||
    !/^[1-9][0-9]{0,15}$/.test(material.installationId) ||
    typeof material.value !== "string" ||
    !GITHUB_TOKEN_VALUE.test(material.value) ||
    !Array.isArray(repositories) ||
    repositories.length < 1 ||
    repositories.length > 100
  )
    throw new Error("invalid_github_material");
  return {
    preparationAttemptId: material.preparationAttemptId,
    materialVersion: material.materialVersion,
    expiresAt: material.expiresAt,
    installationId: material.installationId,
    repositories: repositories.map((entry) => {
      const repository = object(entry);
      fields(repository, ["repositoryId", "repository"]);
      if (
        typeof repository.repositoryId !== "string" ||
        !/^[1-9][0-9]{0,15}$/.test(repository.repositoryId) ||
        typeof repository.repository !== "string" ||
        !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository.repository)
      )
        throw new Error("invalid_github_material");
      return { repositoryId: repository.repositoryId, repository: repository.repository };
    }),
    value: material.value,
  };
}

function releaseKey(value: string): KeyObject {
  try {
    const key = createPublicKey({
      key: Buffer.from(value, "base64url"),
      format: "der",
      type: "spki",
    });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("release_key");
    return key;
  } catch {
    throw new Error("invalid_release_key");
  }
}

/**
 * Verify Compute's signed startup release for this exact held execution. Only the host,
 * which owns the `box run` process and the bearer, decides; the Driver merely relays it.
 */
export function verifyRelease(
  startup: ProtectedStartup,
  value: unknown,
  expected: {
    readonly executionId: string;
    readonly processInstanceId: string;
    readonly bearerSha256: string;
  },
  now = Date.now(),
): { readonly startupId: string; readonly startupSha256: string } {
  const release = object(value);
  fields(release, ["challenge", "installation", "expiresAt", "signature"]);
  const challenge = object(release.challenge);
  const installation = object(release.installation);
  const recipient = object(installation.repositoryGitRecipient);
  const plan = startup.plan;
  const signature = release.signature;
  const expiresAt = release.expiresAt;
  if (
    typeof signature !== "string" ||
    !/^[A-Za-z0-9_-]{86}$/.test(signature) ||
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt) ||
    !(now < expiresAt) ||
    !verify(
      null,
      Buffer.from(JSON.stringify([release.challenge, release.installation, expiresAt])),
      startup.releaseKey,
      Buffer.from(signature, "base64url"),
    )
  ) {
    throw new Error("release_signature_refused");
  }
  const startupId = challenge.startupId;
  if (
    challenge.profile !== RELEASE_PROFILE ||
    typeof startupId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(startupId) ||
    challenge.repositoryGitAuthorization !== "online-request" ||
    canonical(challenge.plan) !== canonical({ id: plan.id, generation: plan.generation }) ||
    canonical(challenge.execution) !== canonical(plan.execution) ||
    installation.sandboxId !== expected.executionId ||
    installation.instanceId !== expected.executionId ||
    installation.peerKeyId !== undefined ||
    recipient.processInstanceId !== expected.processInstanceId ||
    recipient.networkInstanceId !== `box-phantom-sha256:${expected.bearerSha256}` ||
    recipient.attachmentEpoch !== expected.executionId ||
    recipient.authorization !== "online-request" ||
    recipient.deliveryProfile !== "github_repository"
  ) {
    throw new Error("release_outside_held_execution");
  }
  return { startupId, startupSha256: digest(release) };
}

/**
 * The Driver states the exact route it was configured with. The host's own route stays the only
 * one Box receives; a missing, extra or different statement refuses before anything starts.
 */
export function confirmControlledInference(
  route: EgressRoute | undefined,
  needed: boolean,
  stated: unknown,
): void {
  if (needed !== (stated !== undefined)) throw new Error("controlled_inference_unconfirmed");
  if (needed && (route === undefined || !sameRouteView(stated, route)))
    throw new Error("controlled_inference_route_mismatch");
}

function inferenceRoute(plan: LaunchPlan): EgressRoute | undefined {
  return plan.egress?.find((route) => route.kind === "controlled-inference");
}

function approvedWorkspaceNode(plan: LaunchPlan): Pending["workspaceNode"] {
  if (plan.separateNode === undefined) return undefined;
  const { installation, workspace, volumeMounts, route, displayName } = plan.separateNode;
  return {
    mode: installation.mode,
    workspaceVolume: installation.workspaceVolume,
    planSha256: digest({
      command: plan.command,
      installation,
      workspace,
      volumeMounts,
      route,
      displayName,
    }),
  };
}

function startInstalledExecution(config: InstalledConfig, plan: LaunchPlan): Execution {
  const image = config.harnessImage;
  const beforeBoxExec =
    image === undefined
      ? undefined
      : () => {
          if (config.harnessImageSplit !== undefined) {
            const split = readHarnessImageSplit(
              config.agentBuildDir,
              image,
              config.harnessImageSplit,
            );
            pinnedHarnessImageArgv(split.data);
          }
          assertHarnessImageLaunch(image);
          return image.bootId;
        };
  const box = start(config, plan, undefined, beforeBoxExec);
  const input = plan.separateNode;
  if (input === undefined) return box;

  const abort = new AbortController();
  const startNode = () =>
    startWorkspaceNode(
      input,
      join(config.runtimeDir, plan.github === undefined ? "file-node" : "file-node-installed"),
      abort.signal,
    );
  const node = image === undefined ? startNode() : box.spawned.then(startNode);
  const nodeDone = node.then(
    (process) => process.done,
    () => 1,
  );
  const watcher = setInterval(() => {
    try {
      assertNodeInputs(input);
    } catch {
      abort.abort();
      void box.stop().catch(() => undefined);
    }
  }, 1_000);
  watcher.unref();
  const boxDone = box.done.finally(() => {
    clearInterval(watcher);
    abort.abort();
  });
  void nodeDone.then(() => box.stop()).catch(() => undefined);
  return {
    ready: Promise.all([box.ready, node]).then(([ready]) => ready),
    spawned: box.spawned,
    done: Promise.all([boxDone, nodeDone]).then(([code]) => code),
    boxProcess: () => box.boxProcess(),
    generation: () => box.generation(),
    release: () => box.release(),
    async stop() {
      abort.abort();
      const [code] = await Promise.all([box.stop(), nodeDone]);
      return code;
    },
  };
}

interface LiveRecord {
  view: RecordView;
  execution?: Execution;
  retiring: boolean;
  protectedStartup?: ProtectedStartup;
  /** The admitted launch, kept so the protected install can restart `box run` with material. */
  plan?: LaunchPlan;
  workspaceNode?: Pending["workspaceNode"];
  /**
   * STAGE_A_PROTOTYPE: the one material version this execution accepted. Set before the restart
   * begins, so a lost reply is answered from it and never installs a second time.
   */
  installing?: { readonly preparationAttemptId: string; readonly materialVersion: string };
}

/** Canonical JSON for the operator profile and the exact Worker request. */
export function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const data = object(value);
  return `{${Object.keys(data)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(data[key])}`)
    .join(",")}}`;
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function profileDigest(value: unknown): string {
  const requirements = object(value);
  if (!Array.isArray(requirements.environment)) throw new Error("environment_missing");
  return digest({
    ...requirements,
    environment: requirements.environment.map((entry: unknown) => {
      const env = object(entry);
      return env.name === "APP_TOKEN_SHA" ? { ...env, value: "revision-native-verifier" } : env;
    }),
  });
}

export function parseOwner(value: unknown): Owner;
export function parseOwner(value: unknown, pin: true): OwnerPin;
export function parseOwner(value: unknown, pin = false): OwnerPin {
  const data = object(value);
  fields(data, OWNER);
  const result = {
    driverId: string(data.driverId, 128),
    implementation: string(data.implementation, 128),
    namespaceId: string(data.namespaceId, 128),
    namespaceName: string(data.namespaceName, 128),
    agentId: string(data.agentId, 128),
    ...(pin && data.revisionId === undefined ? {} : { revisionId: string(data.revisionId, 128) }),
  };
  const { implementation, ...identifiers } = result;
  if (
    Object.values(identifiers).some((value) => !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) ||
    !/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*@(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(
      implementation,
    )
  ) {
    throw new Error("invalid_owner");
  }
  return result;
}

export function reserveExecution(
  path: string,
  view: Pick<RecordView, "owner" | "requirementsDigest" | "executionId">,
): void {
  durableRecord(path, "intent.json", {
    version: 1,
    owner: view.owner,
    requirementsDigest: view.requirementsDigest,
    executionId: view.executionId,
  });
}

const WRITABLE_HARNESS_STATE = new Set([
  "/home/node/.codex",
  "/home/node/.openclaw",
  "/home/node/.local",
  "/home/node/openclaw-runtime-assets",
]);
const PRIVATE_HOST_TREES = [
  "/home/node",
  "/root",
  "/etc/shadow",
  "/etc/gshadow",
  "/etc/ssh",
  "/var/lib/kubelet",
  "/run/secrets",
  "/var/run/secrets",
  "/proc",
  "/sys",
  "/dev",
];
function contains(parent: string, child: string): boolean {
  return (
    child === parent || (parent === "/" ? child.startsWith("/") : child.startsWith(parent + sep))
  );
}

// Workspace and admitted node state come only from exact claim mount rows. The
// stock Box executable also applies its own protected-path floor.
export function validateInstalledGrants(
  writable: unknown,
  read: readonly string[],
  exec: readonly string[],
): string[] {
  if (
    !Array.isArray(writable) ||
    writable.length > WRITABLE_HARNESS_STATE.size ||
    new Set(writable).size !== writable.length ||
    writable.some((path) => typeof path !== "string" || !WRITABLE_HARNESS_STATE.has(path))
  ) {
    throw new Error("unsupported_writable_state");
  }
  if (
    [...read, ...exec].some((path) =>
      PRIVATE_HOST_TREES.some((tree) => contains(path, tree) || contains(tree, path)),
    )
  ) {
    throw new Error("protected_host_grant");
  }
  return writable.map((path: unknown) => string(path));
}

function installedConfig(value: unknown): InstalledConfig {
  const data = object(value);
  const config = hostConfig(value, [
    "owner",
    "image",
    "harnessImageReceipt",
    "controlSocketMode",
    "profileSha256",
    "approvalDir",
    "endpoint",
    "workspaceClaim",
    "mountIdentities",
    "workspaceSetupId",
    "writableState",
    "workspaceNode",
    "separateWorkspaceNode",
    "controlledInference",
    "protectedRepository",
    "upstreamCa",
  ]);
  if (config.workspace !== WORKSPACE) throw new Error("unsupported_workspace_path");
  const endpoint = object(data.endpoint);
  fields(endpoint, ["url", "workspaceRoot"]);
  const url = new URL(string(endpoint.url));
  if (
    url.protocol !== "wss:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    endpoint.workspaceRoot !== config.workspace
  )
    throw new Error("invalid_fixed_endpoint");
  const image = string(data.image);
  if (!/@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("unverified_agent_image");
  const harnessImage =
    data.harnessImageReceipt === undefined
      ? undefined
      : installHarnessImage(data.harnessImageReceipt, image, config);
  const controlSocketMode = data.controlSocketMode;
  if (controlSocketMode !== undefined && controlSocketMode !== "worker-directory") {
    throw new Error("invalid_control_socket_mode");
  }
  const profileSha256 = data.profileSha256 === undefined ? undefined : string(data.profileSha256);
  const approvalDir =
    data.approvalDir === undefined ? undefined : privateDirectory(data.approvalDir);
  const ownerPin = parseOwner(data.owner, true);
  if (
    (profileSha256 === undefined) === (approvalDir === undefined) ||
    (profileSha256 !== undefined &&
      (!SHA256.test(profileSha256) || ownerPin.revisionId === undefined))
  ) {
    throw new Error("invalid_admission_mode");
  }
  const identity = object(data.mountIdentities);
  fields(identity, Object.keys(MOUNTS));
  const mountIdentities = new Map(
    Object.entries(identity).map(([path, record]) => [path, mountIdentity(record)] as const),
  );
  const writableState = validateInstalledGrants(data.writableState, config.read, config.exec).map(
    privateDirectory,
  );
  const workspaceNode =
    data.workspaceNode === undefined ? undefined : parseRoute(data.workspaceNode, "workspace-node");
  const separateWorkspaceNode =
    data.separateWorkspaceNode === undefined
      ? undefined
      : nodeInstallation(data.separateWorkspaceNode);
  let harnessImageSplit: MountIdentity | undefined;
  if (harnessImage !== undefined && separateWorkspaceNode !== undefined) {
    const split = readHarnessImageSplit(config.agentBuildDir, harnessImage);
    pinnedHarnessImageArgv(split.data);
    harnessImageSplit = split.identity;
  }
  if (separateWorkspaceNode !== undefined) {
    // The file node's state and root image may never be present in a Box grant.
    const isolated = [FILE_NODE_STATE, separateWorkspaceNode.rootfs];
    const otherPaths = [
      ...Object.keys(MOUNTS).filter((path) => path !== FILE_NODE_STATE),
      ...config.read,
      ...config.exec,
      ...writableState,
      config.agentBuildDir,
      config.nodeBin,
      config.codexBin,
      config.boxBin,
      config.runtimeDir,
      ...(approvalDir === undefined ? [] : [approvalDir]),
    ];
    if (
      approvalDir === undefined ||
      workspaceNode === undefined ||
      data.controlledInference === undefined ||
      !mountIdentities.has(FILE_NODE_STATE) ||
      config.read.length !== 2 ||
      !config.read.includes("/app") ||
      !config.read.includes("/opt/oce/runtime") ||
      config.exec.length !== 1 ||
      config.exec[0] !== "/usr/bin/tini" ||
      contains(FILE_NODE_STATE, separateWorkspaceNode.rootfs) ||
      contains(separateWorkspaceNode.rootfs, FILE_NODE_STATE) ||
      isolated.some((isolatedPath) =>
        otherPaths.some((path) => contains(path, isolatedPath) || contains(isolatedPath, path)),
      )
    ) {
      throw new Error("file_node_authority_overlap_or_missing_owner");
    }
  }
  if (approvalDir !== undefined) {
    for (const path of [
      config.runtimeDir,
      config.workspace,
      config.agentBuildDir,
      ...config.read,
      ...config.exec,
      ...writableState,
    ]) {
      if (
        approvalDir === path ||
        approvalDir.startsWith(path + sep) ||
        path.startsWith(approvalDir + sep)
      ) {
        throw new Error("approval_directory_is_not_private_to_operator");
      }
    }
  }
  const controlledInference =
    data.controlledInference === undefined
      ? undefined
      : parseRoute(data.controlledInference, "controlled-inference");
  const upstreamCa = data.upstreamCa === undefined ? undefined : loadUpstreamCa(data.upstreamCa);
  assertUpstreamCaScope(
    upstreamCa,
    boxDialedRoutes({ workspaceNode, separateWorkspaceNode, controlledInference }),
  );
  const protectedRepository = parseProtectedRepository(data.protectedRepository);
  // Box applies the bundle to its GitHub upstreams too, so those routes must opt in as well.
  if (
    protectedRepository !== undefined &&
    protectedRepository.caSha256 !== upstreamCa?.sha256
  )
    throw new Error(
      upstreamCa === undefined ? "upstream_ca_not_configured" : "upstream_ca_route_not_declared",
    );
  return {
    ...config,
    owner: ownerPin,
    image,
    ...(harnessImage === undefined ? {} : { harnessImage }),
    ...(harnessImageSplit === undefined ? {} : { harnessImageSplit }),
    ...(controlSocketMode === undefined ? {} : { controlSocketMode }),
    ...(profileSha256 === undefined ? {} : { profileSha256 }),
    ...(approvalDir === undefined ? {} : { approvalDir }),
    endpoint: { url: url.toString(), workspaceRoot: config.workspace },
    workspaceClaim: string(data.workspaceClaim),
    mountIdentities,
    writableState,
    ...(data.workspaceSetupId === undefined
      ? {}
      : { workspaceSetupId: string(data.workspaceSetupId) }),
    ...(workspaceNode === undefined ? {} : { workspaceNode }),
    ...(separateWorkspaceNode === undefined ? {} : { separateWorkspaceNode }),
    ...(controlledInference === undefined ? {} : { controlledInference }),
    ...(upstreamCa === undefined ? {} : { upstreamCa }),
    ...(protectedRepository === undefined ? {} : { protectedRepository }),
  };
}

function parseProtectedRepository(value: unknown): ProtectedRepository | undefined {
  if (value === undefined) return undefined;
  const configured = object(value);
  fields(configured, ["provider", "caSha256"]);
  if (
    configured.provider !== "github" ||
    (configured.caSha256 !== undefined &&
      (typeof configured.caSha256 !== "string" || !SHA256.test(configured.caSha256)))
  )
    throw new Error("invalid_protected_repository");
  return {
    provider: "github",
    ...(configured.caSha256 === undefined ? {} : { caSha256: configured.caSha256 as string }),
  };
}

/**
 * Every configured route that Box itself may dial: the workspace node only when it runs inline
 * (a separate file node dials from outside Box), and the controlled model. A new route kind that
 * Box dials belongs here, and opts in to an upstream CA bundle by declaring its digest.
 */
export function boxDialedRoutes(config: {
  readonly workspaceNode?: EgressRoute | undefined;
  readonly separateWorkspaceNode?: unknown;
  readonly controlledInference?: EgressRoute | undefined;
}): EgressRoute[] {
  return [
    ...(config.workspaceNode !== undefined && config.separateWorkspaceNode === undefined
      ? [config.workspaceNode]
      : []),
    ...(config.controlledInference === undefined ? [] : [config.controlledInference]),
  ];
}

// Keep these exact literals pinned against the real Compute producer in conformance.
// Box executes the received argv verbatim; the held admission separately pins its full digest.
const STOCK_WRAPPER = ["/usr/bin/tini", "-s", "-e", "143", "--", "node", "-e"];
const STOCK_LOADER =
  'require("node:vm").runInThisContext(require("node:zlib").inflateRawSync(' +
  'Buffer.from(process.argv.splice(1).join(""), "base64")).toString("utf8"), { filename: "[eval]" });';
const STOCK_PIECE_BYTES = 32 * 1024;
const MAX_STOCK_PIECES = 8;

function parseStockHarnessCommand(value: unknown): {
  readonly command: readonly string[];
  readonly program: Buffer;
} {
  if (
    !Array.isArray(value) ||
    value.length < STOCK_WRAPPER.length + 2 ||
    value.length > STOCK_WRAPPER.length + 1 + MAX_STOCK_PIECES ||
    !STOCK_WRAPPER.every((arg, index) => value[index] === arg) ||
    value[STOCK_WRAPPER.length] !== STOCK_LOADER
  ) {
    throw new Error("unsupported_command");
  }
  const pieces = value.slice(STOCK_WRAPPER.length + 1).map((piece, index, all) => {
    if (
      typeof piece !== "string" ||
      piece.length === 0 ||
      piece.length > STOCK_PIECE_BYTES ||
      (index < all.length - 1 && piece.length !== STOCK_PIECE_BYTES) ||
      Buffer.from(piece, "base64").toString("base64") !== piece ||
      (index < all.length - 1 && piece.endsWith("="))
    )
      throw new Error("unsupported_command");
    return piece;
  });
  try {
    const packed = Buffer.from(pieces.join(""), "base64");
    const result: unknown = inflateRawSync(packed, { maxOutputLength: 512_000, info: true });
    const decoded = object(result);
    if (
      object(decoded.engine).bytesWritten !== packed.length ||
      !Buffer.isBuffer(decoded.buffer) ||
      decoded.buffer.length === 0
    ) {
      throw new Error("unsupported_command");
    }
    new TextDecoder("utf-8", { fatal: true }).decode(decoded.buffer);
    return { command: [...STOCK_WRAPPER, STOCK_LOADER, ...pieces], program: decoded.buffer };
  } catch {
    throw new Error("unsupported_command");
  }
}

export function stockHarnessCommand(value: unknown): readonly string[] {
  return parseStockHarnessCommand(value).command;
}

function pinnedHarnessImageArgv(value: unknown): readonly string[] {
  const command = stockHarnessCommand(value);
  if (digest(command) !== HARNESS_SPLIT_COMMAND_SHA256) {
    throw new Error("harness_image_split_argv_changed");
  }
  return command;
}

export function splitSelectedHarnessImageCommand(
  combined: Buffer,
  standalone: unknown,
): readonly string[] {
  assertStockCombinedCommand(combined);
  if (createHash("sha256").update(combined).digest("hex") !== HARNESS_SPLIT_COMBINED_SHA256) {
    throw new Error("harness_image_split_combined_changed");
  }
  return pinnedHarnessImageArgv(standalone);
}

function admitted(
  config: InstalledConfig,
  requested: Owner,
  request: Record<string, unknown>,
  phase: "observe" | "start",
): LaunchPlan {
  const requirements = object(request.requirements);
  fields(requirements, [
    "loginMode",
    "image",
    "command",
    "workloadIdentity",
    "workspaceMounts",
    "workspaceSetup",
    "environment",
    "files",
    "credentialAttachments",
    "proxyWiring",
    "labels",
  ]);
  if (
    requirements.image !== config.image ||
    (config.profileSha256 !== undefined && profileDigest(requirements) !== config.profileSha256)
  )
    throw new Error("unadmitted_profile");
  const labels = object(requirements.labels);
  if (
    labels["openclaw.dev/workload-role"] !== "agent" ||
    labels["openclaw.dev/namespace"] !== requested.namespaceId ||
    labels["openclaw.dev/agent"] !== requested.agentId ||
    labels["openclaw.dev/revision"] !== requested.revisionId
  )
    throw new Error("unadmitted_labels");
  if (
    requirements.workloadIdentity !== undefined ||
    !Array.isArray(requirements.credentialAttachments) ||
    requirements.credentialAttachments.length !== 0 ||
    (requirements.proxyWiring === undefined) !== (config.protectedRepository === undefined)
  ) {
    throw new Error("unavailable_identity_or_credential_material");
  }
  // A host configured for protected repository access runs only the paired protected execution.
  const protectedPlan =
    requirements.proxyWiring === undefined
      ? undefined
      : protectedWiring(config.protectedRepository, requirements.proxyWiring, requested);
  let releasePublicKey: string | undefined;
  if (requirements.workspaceSetup !== undefined) {
    const setup = object(requirements.workspaceSetup);
    if (config.workspaceSetupId === undefined || setup.id !== config.workspaceSetupId)
      throw new Error("workspace_setup_not_staged");
    const marker = join(config.workspace, ".oce-workspace-setup.json");
    const stat = lstatSync(marker);
    if (!stat.isFile() || stat.uid !== process.getuid!() || stat.size > 4096)
      throw new Error("workspace_setup_not_staged");
    const expected = {
      id: setup.id,
      namespaceId: requested.namespaceId,
      agentId: requested.agentId,
      ...(setup.defaultsId === undefined ? {} : { defaultsId: setup.defaultsId }),
    };
    if (JSON.stringify(JSON.parse(readFileSync(marker, "utf8"))) !== JSON.stringify(expected))
      throw new Error("workspace_setup_not_staged");
  } else if (config.workspaceSetupId !== undefined) throw new Error("unexpected_workspace_setup");
  const stock = parseStockHarnessCommand(requirements.command);
  if (
    !Array.isArray(requirements.workspaceMounts) ||
    requirements.workspaceMounts.length < 3 ||
    requirements.workspaceMounts.length > 4
  ) {
    throw new Error("unsupported_workspace_mounts");
  }
  const mounts = new Map<string, string>();
  for (const entry of requirements.workspaceMounts) {
    const mount = object(entry);
    fields(mount, ["claimName", "mountPath", "subPath", "readOnly"]);
    const path = string(mount.mountPath);
    const subPath = string(mount.subPath);
    if (
      !Object.hasOwn(MOUNTS, path) ||
      mounts.has(path) ||
      mount.claimName !== config.workspaceClaim ||
      mount.readOnly !== false ||
      (path === FILE_NODE_STATE
        ? !/^workspace-node-[a-f0-9]{12}-[a-f0-9]{12}$/.test(subPath)
        : MOUNTS[path as keyof typeof MOUNTS] !== subPath)
    )
      throw new Error("unsupported_workspace_mounts");
    const pin = config.mountIdentities.get(path);
    if (pin === undefined) throw new Error("workspace_mount_replaced");
    assertPinnedDirectory(path, pin);
    mounts.set(path, subPath);
  }
  if (
    !Object.keys(MOUNTS)
      .slice(0, 3)
      .every((path) => mounts.has(path)) ||
    mounts.size !== config.mountIdentities.size
  ) {
    throw new Error("workspace_mount_missing");
  }
  if (!Array.isArray(requirements.environment) || requirements.environment.length > 100)
    throw new Error("invalid_environment");
  const environment: Record<string, string> = {};
  const observed = new Set<string>();
  let needsSetupCode = false;
  let needsControlledInference = false;
  for (const entry of requirements.environment) {
    const env = object(entry);
    fields(env, ["name", "value", "valueFrom"]);
    const name = string(env.name, 128);
    if (observed.has(name)) throw new Error("duplicate_environment");
    observed.add(name);
    if (env.valueFrom !== undefined) {
      const valueFrom = object(env.valueFrom);
      fields(valueFrom, ["secretKeyRef"]);
      const ref = object(valueFrom.secretKeyRef);
      fields(ref, ["name", "key"]);
      if (env.value !== undefined) throw new Error("unsupported_secret_reference");
      if (
        name === "OPENCLAW_NODE_SETUP_CODE" &&
        ref.key === "setupCode" &&
        ref.name === mounts.get(FILE_NODE_STATE)
      ) {
        needsSetupCode = true;
      } else if (
        name === "OPENAI_API_KEY" &&
        typeof ref.name === "string" &&
        typeof ref.key === "string" &&
        config.controlledInference !== undefined
      ) {
        needsControlledInference = true;
      } else throw new Error("unsupported_secret_reference");
    } else {
      if (
        name === "OPENCLAW_NODE_SETUP_CODE" ||
        name === "OPENAI_API_KEY" ||
        typeof env.value !== "string"
      )
        throw new Error("invalid_literal_environment");
      if (name === ENROLLMENT_REVISION_ENV || name === RELEASE_PUBLIC_KEY_ENV) {
        // Compute's enrollment inputs are consumed by the host and never enter Box.
        if (
          protectedPlan === undefined ||
          (name === ENROLLMENT_REVISION_ENV && env.value !== requested.revisionId)
        )
          throw new Error("unadmitted_enrollment_environment");
        if (name === RELEASE_PUBLIC_KEY_ENV) releasePublicKey = env.value;
        continue;
      }
      environment[name] = env.value;
    }
  }
  if (
    protectedPlan !== undefined &&
    (releasePublicKey === undefined || !observed.has(ENROLLMENT_REVISION_ENV))
  )
    throw new Error("unadmitted_enrollment_environment");
  if (phase === "start")
    confirmControlledInference(
      config.controlledInference,
      needsControlledInference,
      request.controlledInference,
    );
  const egress: EgressRoute[] = [];
  const setupCode = request.workspaceNodeSetupCode;
  let expiresAt: number | undefined;
  if (
    (phase === "start" && needsSetupCode !== (setupCode !== undefined)) ||
    (needsSetupCode && config.workspaceNode === undefined)
  ) {
    throw new Error("unexpected_or_missing_setup_projection");
  }
  if (setupCode !== undefined) {
    const code = string(setupCode, 65_536);
    if (!/^(?:oc-pair:\/\/)?[A-Za-z0-9_-]+$/i.test(code) || config.workspaceNode === undefined)
      throw new Error("invalid_setup_projection");
    const decoded = Buffer.from(code.replace(/^oc-pair:\/\//i, ""), "base64url");
    try {
      const envelope = object(JSON.parse(decoded.toString("utf8")) as unknown);
      if (
        typeof envelope.url !== "string" ||
        new URL(envelope.url).toString() !== config.workspaceNode.url ||
        typeof envelope.expiresAtMs !== "number" ||
        !Number.isSafeInteger(envelope.expiresAtMs) ||
        envelope.expiresAtMs <= Date.now()
      ) {
        throw new Error("setup_projection_outside_owner_route");
      }
      expiresAt = envelope.expiresAtMs;
    } finally {
      decoded.fill(0);
    }
    if (config.separateWorkspaceNode === undefined) egress.push(config.workspaceNode);
  }
  if (
    !SHA256.test(environment.APP_TOKEN_SHA ?? "") ||
    environment.APP_SERVER_PORT !== String(PORT) ||
    environment.HOME !== "/home/node" ||
    environment.OPENCLAW_WORKSPACE_DIR !== config.workspace
  )
    throw new Error("unsupported_native_environment");
  if (!Array.isArray(requirements.files) || requirements.files.length > 8)
    throw new Error("unsupported_files");
  const files = requirements.files.map((entry) => {
    const file = object(entry);
    fields(file, ["name", "content", "environmentVariable"]);
    return {
      name: string(file.name, 80),
      content: string(file.content, 128_000),
      environmentVariable: string(file.environmentVariable, 128),
    };
  });
  if (needsControlledInference) {
    const manifest = files.find(({ name }) => name === "runtime.json");
    const runtime = object(JSON.parse(manifest?.content ?? "null") as unknown);
    const modelEndpoint = object(runtime.modelEndpoint);
    if (
      config.controlledInference === undefined ||
      modelEndpoint.modelProvider !== "openai-compatible" ||
      typeof modelEndpoint.baseUrl !== "string" ||
      new URL(modelEndpoint.baseUrl).toString() !== config.controlledInference.url ||
      requirements.loginMode !== "api_key" ||
      environment.CODEX_LOGIN_MODE !== "api_key"
    )
      throw new Error("inference_outside_owner_route");
    environment.OPENAI_API_KEY = CONTROLLED_INFERENCE_MARKER;
    egress.push(config.controlledInference);
  }
  let separateNode: NodeLaunch | undefined;
  if ((request.workspaceVolume === undefined) !== (config.separateWorkspaceNode === undefined)) {
    throw new Error("file_node_workspace_volume_missing_or_unselected");
  }
  if (config.separateWorkspaceNode !== undefined) {
    const workspaceIdentity = config.mountIdentities.get(config.workspace);
    const stateIdentity = config.mountIdentities.get(FILE_NODE_STATE);
    const displayName = `agent-${createHash("sha256").update(requested.agentId).digest("hex").slice(0, 12)}-workspace`;
    if (
      !needsSetupCode ||
      !needsControlledInference ||
      config.workspaceNode === undefined ||
      workspaceIdentity === undefined ||
      stateIdentity === undefined ||
      environment.OPENCLAW_NODE_STATE_DIR !== FILE_NODE_STATE ||
      environment.OPENCLAW_NODE_DISPLAY_NAME !== displayName ||
      canonical(request.workspaceVolume) !==
        canonical(config.separateWorkspaceNode.workspaceVolume) ||
      requirements.workspaceSetup !== undefined
    ) {
      throw new Error("file_node_requires_stock_ordinary_inputs");
    }
    separateNode = {
      installation: config.separateWorkspaceNode,
      workspace: config.workspace,
      workspaceIdentity,
      stateIdentity,
      volumeMounts: [...mounts].map(([path, subPath]) => ({
        path,
        subPath,
        identity: config.mountIdentities.get(path)!,
      })),
      runtime: join(config.agentBuildDir, "workspace-node-runtime.mjs"),
      ...(config.harnessImage === undefined
        ? {}
        : { mountinfo: () => readHarnessProc(config.harnessImage!).mountinfo }),
      route: config.workspaceNode,
      ...(environment.OPENCLAW_NODE_CA_PEM === undefined
        ? {}
        : { ca: environment.OPENCLAW_NODE_CA_PEM }),
      displayName,
      ...(typeof setupCode === "string" && expiresAt !== undefined ? { setupCode, expiresAt } : {}),
    };
    assertNodeInputs(separateNode);
    nodeRuntimeBytes(separateNode);
    for (const key of [
      "OPENCLAW_NODE_CA_PEM",
      "OPENCLAW_NODE_DISPLAY_NAME",
      "OPENCLAW_NODE_STATE_DIR",
      "OPENCLAW_WORKSPACE_BOOTSTRAP",
    ])
      delete environment[key];
    mounts.delete(FILE_NODE_STATE);
  }
  let command = stock.command;
  if (separateNode !== undefined) {
    if (config.harnessImage === undefined) {
      command = splitStockCommand(stock.program);
    } else {
      if (config.harnessImageSplit === undefined) {
        throw new Error("harness_image_split_not_approved");
      }
      const split = readHarnessImageSplit(
        config.agentBuildDir,
        config.harnessImage,
        config.harnessImageSplit,
      );
      command = splitSelectedHarnessImageCommand(stock.program, split.data);
    }
  }
  if (config.harnessImage !== undefined) {
    if (needsSetupCode && separateNode === undefined) {
      throw new Error("harness_image_requires_separate_workspace_node");
    }
    assertHarnessImageCommand(config.harnessImage, command, environment.PATH);
    assertHarnessImageView(config.harnessImage);
  }
  return {
    command,
    environment,
    files,
    readOnly: [],
    writable: [...mounts.keys(), ...config.writableState],
    egress,
    ...(config.upstreamCa === undefined ? {} : { upstreamCa: config.upstreamCa }),
    ...(separateNode === undefined && typeof setupCode === "string" && expiresAt !== undefined
      ? { workspaceNodeSetupCode: setupCode, workspaceNodeSetupExpiresAt: expiresAt }
      : {}),
    ...(separateNode === undefined ? {} : { separateNode }),
    ...(protectedPlan === undefined || releasePublicKey === undefined
      ? {}
      : {
          releaseGate: true as const,
          protectedStartup: { releaseKey: releaseKey(releasePublicKey), plan: protectedPlan },
        }),
  };
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"] !== "application/json") throw new Error("content_type");
  const pieces: Buffer[] = [];
  let length = 0;
  try {
    for await (const piece of request) {
      if (!Buffer.isBuffer(piece)) throw new Error("invalid_body");
      length += piece.length;
      if (length > MAX_REQUEST) throw new Error("body_too_large");
      pieces.push(piece);
    }
    const bytes = Buffer.concat(pieces);
    try {
      return object(JSON.parse(bytes.toString("utf8")) as unknown);
    } finally {
      bytes.fill(0);
    }
  } finally {
    for (const piece of pieces) piece.fill(0);
  }
}

function reply(
  response: ServerResponse,
  code: number,
  body?:
    | RecordView
    | { error: string }
    | {
        state: "held" | "approved";
        owner: Owner;
        requirementsDigest: string;
        controlledInference?: RouteView;
      },
): void {
  response.writeHead(code, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    Connection: "close",
  });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

function controlSocketPath(config: InstalledConfig): string {
  if (config.controlSocketMode === undefined) {
    ensureEmpty(config.runtimeDir);
    return join(config.runtimeDir, "control.sock");
  }

  const directory = privateDirectory(join(config.runtimeDir, WORKER_CONTROL));
  const otherPaths = [
    config.workspace,
    ...Object.keys(MOUNTS),
    ...config.read,
    ...config.exec,
    ...config.writableState,
    config.agentBuildDir,
    config.approvalDir,
    config.separateWorkspaceNode?.rootfs,
  ];
  if (
    otherPaths.some(
      (path) => path !== undefined && (contains(path, directory) || contains(directory, path)),
    )
  ) {
    throw new Error("worker_control_directory_overlap");
  }

  // A bind mount can alias another directory even when its real path is canonical.
  const mountPath = directory.replace(
    /[ \\]/g,
    (character) => `\\${character.charCodeAt(0).toString(8).padStart(3, "0")}`,
  );
  if (
    (config.harnessImage === undefined
      ? readFileSync("/proc/self/mountinfo", "utf8")
      : readHarnessProc(config.harnessImage).mountinfo
    )
      .split("\n")
      .some((line) => line.split(" ", 5)[4] === mountPath)
  ) {
    throw new Error("worker_control_directory_mounted");
  }
  if (readdirSync(config.runtimeDir).some((name) => name !== WORKER_CONTROL)) {
    throw new Error("runtime_already_used");
  }
  ensureEmpty(directory);
  return join(directory, "control.sock");
}

/** The identity of this host process, which receives the material for its execution. */
function hostProcessInstance(): string {
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  return `${bootId}:${process.pid}:${processIdentity(process.pid).startTicks}`;
}

/**
 * The protected reservation generation, fixed before any material exists: this host process,
 * the execution and the execution bearer digest. Ingress presents it as the owner generation.
 */
export function reservationGeneration(
  executionId: string,
  bearerSha256: string,
  hostProcessInstanceId: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 2,
        profile: "strands-box-protected-reservation-v2",
        host: hostProcessInstanceId,
        executionId,
        bearerSha256,
      }),
    )
    .digest("hex");
}

export function observedView(record: {
  readonly view: RecordView;
  readonly execution?: Pick<Execution, "boxProcess" | "generation">;
}): RecordView {
  const recipient = record.view.repositoryRecipient;
  if (recipient === undefined) return record.view;
  // The installed version is reported only while the `box run` that holds it is the same live
  // process; a replaced or exited Box reports none.
  const box = record.view.state === "failed" ? undefined : record.execution?.boxProcess();
  const installed = recipient.installed;
  const live =
    installed !== undefined &&
    box !== undefined &&
    installed.boxProcessInstanceId === `${box.bootId}:${box.pid}:${box.startTicks}`;
  return {
    ...record.view,
    repositoryRecipient: {
      bearerSha256: recipient.bearerSha256,
      processInstanceId: recipient.processInstanceId,
      ...(live ? { installed: { ...installed } } : {}),
    },
  };
}

export async function serveInstalledControl(config: InstalledConfig): Promise<void> {
  const socketPath = controlSocketPath(config);
  if (config.approvalDir !== undefined) ensureEmpty(config.approvalDir);
  const image = config.harnessImage;
  const controller = currentController(
    undefined,
    image === undefined ? undefined : readHarnessProc(image).bootId,
  );
  let pending: { view: Pending; requirements: string } | undefined;
  process.umask(0o077);
  let current: LiveRecord | undefined;
  let attempted = false;
  let shuttingDown = false;
  const server = createServer(
    { requestTimeout: 5_000, headersTimeout: 5_000, maxHeaderSize: 4_096 },
    (request, response) => {
      void handle(request, response).catch(() => {
        if (!response.headersSent && !response.destroyed)
          reply(response, 422, { error: "host_request_refused" });
      });
    },
  );
  server.maxConnections = 16;
  server.setTimeout(5_000, (socket) => socket.destroy());
  await listen(server, socketPath);
  process.stdout.write("strands-box-control: ready\n");
  await new Promise<void>((resolve) => {
    const stop = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      server.close();
      server.closeAllConnections();
      void Promise.resolve(current?.execution?.stop()).then(
        () => resolve(),
        () => {
          process.exitCode = 1;
          resolve();
        },
      );
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    server.on("error", stop);
  });

  /** Follow one started execution: its ready receipt and its exit. */
  function track(
    running: LiveRecord,
    execution: Execution,
    workspaceNode: Pending["workspaceNode"],
  ): void {
    const view = running.view;
    // A restarted protected run replaces `execution`; the replaced run's outcome is not the view's.
    const live = () => running.execution === execution;
    void execution.ready.then(
      (receipt) => {
        if (!live()) return;
        try {
          if (workspaceNode !== undefined) {
            const bytes = readFileSync(join(config.runtimeDir, READY_FILE), {
              flag: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            });
            if (!bytes.equals(Buffer.from(`${JSON.stringify(receipt)}\n`))) {
              throw new Error("original_ready_receipt_changed");
            }
            // A protected run keeps the reservation generation the Gateway pinned before release;
            // ready.json repeats it and host ingress presents it.
            view.generationSha256 =
              running.protectedStartup === undefined
                ? createHash("sha256").update(bytes).digest("hex")
                : (receipt.generationSha256 ?? "");
            if (!SHA256.test(view.generationSha256))
              throw new Error("protected_generation_missing");
          }
          view.state = "running";
        } catch {
          view.state = "failed";
          void execution.stop().catch(() => undefined);
        }
      },
      () => {
        if (live()) view.state = "failed";
      },
    );
    void execution.done.then(
      () => {
        if (live()) view.state = "failed";
      },
      () => {
        if (live()) view.state = "failed";
      },
    );
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const observing = request.url === ADMISSION && request.method === "POST";
    const releasing = request.url === RELEASE && request.method === "POST";
    const delivering = request.url === MATERIAL && request.method === "POST";
    if (request.url !== CONTROL && !observing && !releasing && !delivering) {
      reply(response, 404, { error: "unknown_path" });
      return;
    }
    if (shuttingDown) {
      reply(response, 503, { error: "host_stopping" });
      return;
    }
    if (request.method === "GET") {
      if (current === undefined) reply(response, 404, { error: "execution_absent" });
      else reply(response, 200, observedView(current));
      return;
    }
    if (
      !observing &&
      !releasing &&
      !delivering &&
      request.method !== "PUT" &&
      request.method !== "DELETE"
    ) {
      reply(response, 405, { error: "method_refused" });
      return;
    }
    const data = await readBody(request);
    if (shuttingDown) {
      reply(response, 503, { error: "host_stopping" });
      return;
    }
    const supplied = parseOwner(data.owner);
    const requirementsDigest = string(data.requirementsDigest, 64);
    if (!sameOwner(config.owner, supplied) || !SHA256.test(requirementsDigest)) {
      reply(response, 409, { error: "owner_mismatch" });
      return;
    }
    if (releasing) {
      fields(data, ["owner", "requirementsDigest", "executionId", "release"]);
      const held = current;
      const startup = held?.protectedStartup;
      const view = held === undefined ? undefined : observedView(held);
      const recipient = view?.repositoryRecipient;
      if (
        held === undefined ||
        view === undefined ||
        held.retiring ||
        held.execution === undefined ||
        startup === undefined ||
        !sameOwner(held.view.owner, supplied) ||
        held.view.executionId !== data.executionId ||
        held.view.requirementsDigest !== requirementsDigest ||
        view.state !== "starting" ||
        recipient === undefined ||
        view.protectedStartup?.generationSha256 === undefined
      ) {
        reply(response, 409, { error: "release_outside_held_execution" });
        return;
      }
      const verified = verifyRelease(startup, data.release, {
        executionId: held.view.executionId,
        processInstanceId: recipient.processInstanceId,
        bearerSha256: recipient.bearerSha256,
      });
      const prior = held.view.protectedStartup;
      if (prior?.startupSha256 !== undefined) {
        // One release per execution; only the identical verified release is acknowledged again.
        if (prior.startupSha256 !== verified.startupSha256) {
          reply(response, 409, { error: "execution_already_released" });
          return;
        }
      } else {
        await held.execution.release();
        if (prior === undefined) throw new Error("release_outside_held_execution");
        held.view.protectedStartup = { ...prior, ...verified };
      }
      reply(response, 200, observedView(held));
      return;
    }
    if (delivering) {
      // STAGE_A_PROTOTYPE: the Worker delivers the installation token OCE's Token Service minted
      // for this execution's committed recipient (this host control process). OCE prepares it
      // only after the revision activates, and stock Box reads an env:// secret once at start,
      // so the host restarts the released `box run` once with Box's two GitHub routes. One
      // version per execution: Box cannot take a renewed token, so another version is refused.
      fields(data, ["owner", "requirementsDigest", "executionId", "material"]);
      const held = current;
      const recipient = held?.view.repositoryRecipient;
      const material = deliveredMaterial(data.material);
      const version = {
        preparationAttemptId: material.preparationAttemptId,
        materialVersion: material.materialVersion,
      };
      if (
        held === undefined ||
        recipient === undefined ||
        held.retiring ||
        held.execution === undefined ||
        held.plan === undefined ||
        !sameOwner(held.view.owner, supplied) ||
        held.view.executionId !== data.executionId ||
        held.view.requirementsDigest !== requirementsDigest ||
        held.view.protectedStartup?.startupSha256 === undefined ||
        held.view.state === "failed"
      ) {
        reply(response, 409, { error: "material_outside_released_execution" });
        return;
      }
      if (held.installing !== undefined) {
        const installed = observedView(held).repositoryRecipient?.installed;
        const same =
          held.installing.preparationAttemptId === version.preparationAttemptId &&
          held.installing.materialVersion === version.materialVersion;
        if (same && installed !== undefined) reply(response, 200, observedView(held));
        else
          reply(response, 409, {
            error: same ? "material_install_unsettled" : "material_refresh_unsupported",
          });
        return;
      }
      held.installing = version;
      const previous = held.execution;
      held.view.state = "starting";
      await previous.stop().catch(() => undefined);
      if (shuttingDown || held.retiring || current !== held) {
        reply(response, 503, { error: "host_stopping" });
        return;
      }
      let execution: Execution;
      try {
        execution = startInstalledExecution(config, {
          ...held.plan,
          github: {
            token: material.value,
            ...(config.protectedRepository?.caSha256 === undefined
              ? {}
              : { caSha256: config.protectedRepository.caSha256 }),
          },
        });
        held.execution = execution;
      } catch {
        held.view.state = "failed";
        reply(response, 503, { error: "start_outcome_unknown" });
        return;
      }
      track(held, execution, held.workspaceNode);
      await execution.spawned.catch(() => undefined);
      const box = execution.boxProcess();
      if (box === undefined || (held.view.state as RecordView["state"]) === "failed") {
        held.view.state = "failed";
        reply(response, 503, { error: "start_outcome_unknown" });
        return;
      }
      recipient.installed = {
        ...version,
        boxProcessInstanceId: `${box.bootId}:${box.pid}:${box.startTicks}`,
      };
      reply(response, 200, observedView(held));
      return;
    }
    if (observing) {
      fields(data, ["owner", "requirementsDigest", "requirements", "workspaceVolume"]);
      if (digest(data.requirements) !== requirementsDigest)
        throw new Error("requirements_digest_mismatch");
      const exact = canonical({
        requirements: data.requirements,
        ...(data.workspaceVolume === undefined ? {} : { workspaceVolume: data.workspaceVolume }),
      });
      const conflicting = () =>
        pending !== undefined &&
        (!sameOwner(pending.view.owner, supplied) ||
          pending.view.requirementsDigest !== requirementsDigest ||
          pending.requirements !== exact);
      if (conflicting()) {
        reply(response, 409, { error: "pending_admission_conflict" });
        return;
      }
      if (pending === undefined) {
        const plan = admitted(config, supplied, data, "observe");
        const inference = inferenceRoute(plan);
        if (inference !== undefined) {
          await assertPinnedResolution(inference);
          if (shuttingDown) {
            reply(response, 503, { error: "host_stopping" });
            return;
          }
          // Another request may have recorded the pending admission during the lookup: an
          // identical request shares it, any other conflicts.
          if (conflicting()) {
            reply(response, 409, { error: "pending_admission_conflict" });
            return;
          }
        }
        if (pending === undefined) {
          const workspaceNode = approvedWorkspaceNode(plan);
          const view: Pending = {
            version: 1,
            owner: supplied,
            requirementsDigest,
            profileSha256: profileDigest(data.requirements),
            image: config.image,
            commandSha256: digest(plan.command),
            ...(workspaceNode === undefined ? {} : { workspaceNode }),
            ...(inference === undefined ? {} : { controlledInference: routeView(inference) }),
            ...(config.protectedRepository === undefined
              ? {}
              : {
                  protectedRepository: wiringConfiguration(config.protectedRepository.provider)
                    .protectedRepository,
                }),
            counts: {
              environment: Object.keys(plan.environment).length,
              files: plan.files?.length ?? 0,
              mounts: config.mountIdentities.size,
            },
            controller,
          };
          durableRecord(config.runtimeDir, "pending.json", view);
          pending = { view, requirements: exact };
        }
      }
      const allowed =
        config.approvalDir === undefined || isApproved(config.approvalDir, pending.view);
      reply(response, 200, {
        state: allowed ? "approved" : "held",
        owner: pending.view.owner,
        requirementsDigest,
        ...(pending.view.workspaceNode === undefined
          ? {}
          : {
              workspaceNodeMode: pending.view.workspaceNode.mode,
              workspaceVolume: pending.view.workspaceNode.workspaceVolume,
            }),
        ...(pending.view.controlledInference === undefined
          ? {}
          : { controlledInference: pending.view.controlledInference }),
      });
      return;
    }
    if (request.method === "PUT") {
      fields(data, [
        "owner",
        "requirementsDigest",
        "requirements",
        "workspaceVolume",
        "workspaceNodeSetupCode",
        "controlledInference",
        "executionBearer",
      ]);
      if (digest(data.requirements) !== requirementsDigest)
        throw new Error("requirements_digest_mismatch");
      if (current !== undefined) {
        if (
          current.retiring ||
          !sameOwner(current.view.owner, supplied) ||
          current.view.requirementsDigest !== requirementsDigest ||
          digest(current.view.workspaceVolume ?? null) !== digest(data.workspaceVolume ?? null)
        )
          reply(response, 409, { error: "execution_conflict" });
        else reply(response, 200, observedView(current));
        return;
      }
      if (attempted) {
        reply(response, 409, { error: "execution_already_attempted" });
        return;
      }
      if (
        pending === undefined ||
        !sameOwner(pending.view.owner, supplied) ||
        pending.view.requirementsDigest !== requirementsDigest ||
        pending.requirements !==
          canonical({
            requirements: data.requirements,
            ...(data.workspaceVolume === undefined
              ? {}
              : { workspaceVolume: data.workspaceVolume }),
          }) ||
        (config.approvalDir !== undefined &&
          !isApproved(
            config.approvalDir,
            pending.view,
            image === undefined ? undefined : readHarnessProc(image).bootId,
          ))
      ) {
        reply(response, 409, { error: "owner_admission_not_approved" });
        return;
      }
      // Resolve again just before the one start attempt; Box pins the address it dials.
      // Nothing below this lookup awaits, so the checks after it hold until Box starts.
      if (pending.view.controlledInference !== undefined) {
        if (config.controlledInference === undefined)
          throw new Error("controlled_inference_admitted_route_changed");
        await assertPinnedResolution(config.controlledInference);
        if (shuttingDown || attempted || current !== undefined) {
          reply(response, 409, { error: "execution_already_attempted" });
          return;
        }
        // The operator may withdraw approval.json while the lookup runs.
        if (config.approvalDir !== undefined && !isApproved(config.approvalDir, pending.view)) {
          reply(response, 409, { error: "owner_admission_not_approved" });
          return;
        }
      }
      const bearer = data.executionBearer;
      const input = admitted(config, supplied, data, "start");
      // A protected host needs exactly one fresh execution bearer; an ordinary one takes none.
      if (
        (input.protectedStartup === undefined) !== (bearer === undefined) ||
        (bearer !== undefined && (typeof bearer !== "string" || !EXECUTION_BEARER.test(bearer)))
      ) {
        throw new Error("execution_bearer_unexpected_or_missing");
      }
      const workspaceNode = approvedWorkspaceNode(input);
      if (workspaceNode?.planSha256 !== pending.view.workspaceNode?.planSha256) {
        throw new Error("file_node_admitted_plan_changed");
      }
      const inference = inferenceRoute(input);
      const inferenceView = inference === undefined ? undefined : routeView(inference);
      if (JSON.stringify(inferenceView) !== JSON.stringify(pending.view.controlledInference)) {
        throw new Error("controlled_inference_admitted_route_changed");
      }
      const executionId = randomUUID();
      const bearerSha256 =
        typeof bearer === "string" ? createHash("sha256").update(bearer).digest("hex") : undefined;
      const hostInstance = bearerSha256 === undefined ? undefined : hostProcessInstance();
      const view: RecordView = {
        owner: supplied,
        requirementsDigest,
        executionId,
        state: "starting",
        endpoint: config.endpoint,
        ...(bearerSha256 === undefined || hostInstance === undefined
          ? {}
          : { repositoryRecipient: { bearerSha256, processInstanceId: hostInstance } }),
        ...(workspaceNode === undefined
          ? {}
          : {
              workspaceNodeMode: workspaceNode.mode,
              workspaceVolume: workspaceNode.workspaceVolume,
            }),
        ...(inferenceView === undefined ? {} : { controlledInference: inferenceView }),
      };
      attempted = true;
      reserveExecution(config.runtimeDir, view);
      const generation =
        bearerSha256 === undefined || hostInstance === undefined
          ? undefined
          : reservationGeneration(executionId, bearerSha256, hostInstance);
      if (input.protectedStartup !== undefined && generation !== undefined)
        view.protectedStartup = {
          plan: input.protectedStartup.plan,
          reservedAt: new Date().toISOString(),
          generationSha256: generation,
        };
      const plan: LaunchPlan =
        generation === undefined ? input : { ...input, reservationGeneration: generation };
      const running: LiveRecord = {
        view,
        retiring: false,
        plan,
        workspaceNode,
        ...(input.protectedStartup === undefined
          ? {}
          : { protectedStartup: input.protectedStartup }),
      };
      current = running;
      let execution: Execution;
      try {
        execution = startInstalledExecution(config, plan);
        running.execution = execution;
      } catch {
        view.state = "failed";
        reply(response, 503, { error: "start_outcome_unknown" });
        return;
      }
      track(running, execution, workspaceNode);
      reply(response, 202, view);
      return;
    }
    fields(data, ["owner", "requirementsDigest", "executionId"]);
    if (current === undefined) {
      reply(response, 404, { error: "execution_absent" });
      return;
    }
    const retiring = current;
    if (
      !sameOwner(retiring.view.owner, supplied) ||
      retiring.view.executionId !== data.executionId ||
      retiring.view.requirementsDigest !== requirementsDigest
    ) {
      reply(response, 409, { error: "execution_mismatch" });
      return;
    }
    if (retiring.execution === undefined) {
      reply(response, 503, { error: "start_outcome_unknown" });
      return;
    }
    retiring.retiring = true;
    await retiring.execution.stop();
    if (current === retiring) current = undefined;
    reply(response, 204);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const path = process.argv[2];
    if (path === "--profile-sha256" && process.argv[3] !== undefined && process.argv.length === 4) {
      process.stdout.write(`${profileDigest(readConfig(process.argv[3]))}\n`);
    } else if (
      path === "approve" &&
      process.argv[3] !== undefined &&
      process.argv[4] !== undefined &&
      process.argv[5] !== undefined &&
      process.argv.length === 6
    ) {
      const config = installedConfig(readConfig(process.argv[3]));
      if (config.approvalDir === undefined) throw new Error("held_mode_required");
      approve(
        config.runtimeDir,
        config.approvalDir,
        config.owner,
        process.argv[4],
        process.argv[5],
        config.harnessImage === undefined ? undefined : readHarnessProc(config.harnessImage).bootId,
      );
      process.stdout.write("strands-box-control: exact held admission approved\n");
    } else {
      if (path === undefined || process.argv.length !== 3 || process.arch !== "arm64")
        throw new Error("linux_arm64_required");
      await serveInstalledControl(installedConfig(readConfig(path)));
    }
  } catch {
    process.stderr.write("strands-box-control: configuration, listener or retirement refused\n");
    process.exitCode = 1;
  }
}
