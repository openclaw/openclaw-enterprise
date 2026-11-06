import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { CONTROLLED_INFERENCE_MARKER, parseRoute } from "./egress.ts";
import type { EgressRoute } from "./egress.ts";
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
import { listen, PORT } from "./transport.ts";

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
  assertNodeInputs,
  assertPinnedDirectory,
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
const MAX_REQUEST = 512_000;
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
}

interface RecordView {
  owner: Owner;
  requirementsDigest: string;
  executionId: string;
  state: "starting" | "running" | "failed";
  endpoint: InstalledConfig["endpoint"];
  workspaceNodeMode?: NodeInstallation["mode"];
  workspaceVolume?: NodeInstallation["workspaceVolume"];
  generationSha256?: string;
}

interface LaunchPlan extends StartInput {
  readonly separateNode?: NodeLaunch;
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
  const box = start(config, plan);
  const input = plan.separateNode;
  if (input === undefined) return box;

  const abort = new AbortController();
  const node = startWorkspaceNode(input, join(config.runtimeDir, "file-node"), abort.signal);
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
    done: Promise.all([boxDone, nodeDone]).then(([code]) => code),
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
  return {
    ...config,
    owner: ownerPin,
    image,
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
    ...(data.controlledInference === undefined
      ? {}
      : { controlledInference: parseRoute(data.controlledInference, "controlled-inference") }),
  };
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
    requirements.proxyWiring !== undefined ||
    !Array.isArray(requirements.credentialAttachments) ||
    requirements.credentialAttachments.length !== 0
  ) {
    throw new Error("unavailable_identity_or_credential_material");
  }
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
      environment[name] = env.value;
    }
  }
  if (
    phase === "start" &&
    (needsControlledInference !== (request.controlledInference === true) ||
      (request.controlledInference !== undefined && request.controlledInference !== true))
  )
    throw new Error("controlled_inference_unconfirmed");
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
  return {
    command: separateNode === undefined ? stock.command : splitStockCommand(stock.program),
    environment,
    files,
    readOnly: [],
    writable: [...mounts.keys(), ...config.writableState],
    egress,
    ...(separateNode === undefined && typeof setupCode === "string" && expiresAt !== undefined
      ? { workspaceNodeSetupCode: setupCode, workspaceNodeSetupExpiresAt: expiresAt }
      : {}),
    ...(separateNode === undefined ? {} : { separateNode }),
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
    | { state: "held" | "approved"; owner: Owner; requirementsDigest: string },
): void {
  response.writeHead(code, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    Connection: "close",
  });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

async function serve(config: InstalledConfig): Promise<void> {
  ensureEmpty(config.runtimeDir);
  if (config.approvalDir !== undefined) ensureEmpty(config.approvalDir);
  const controller = currentController();
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
  await listen(server, join(config.runtimeDir, "control.sock"));
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

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const observing = request.url === ADMISSION && request.method === "POST";
    if (request.url !== CONTROL && !observing) {
      reply(response, 404, { error: "unknown_path" });
      return;
    }
    if (shuttingDown) {
      reply(response, 503, { error: "host_stopping" });
      return;
    }
    if (request.method === "GET") {
      if (current === undefined) reply(response, 404, { error: "execution_absent" });
      else reply(response, 200, current.view);
      return;
    }
    if (!observing && request.method !== "PUT" && request.method !== "DELETE") {
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
    if (observing) {
      fields(data, ["owner", "requirementsDigest", "requirements", "workspaceVolume"]);
      if (digest(data.requirements) !== requirementsDigest)
        throw new Error("requirements_digest_mismatch");
      const exact = canonical({
        requirements: data.requirements,
        ...(data.workspaceVolume === undefined ? {} : { workspaceVolume: data.workspaceVolume }),
      });
      if (
        pending !== undefined &&
        (!sameOwner(pending.view.owner, supplied) ||
          pending.view.requirementsDigest !== requirementsDigest ||
          pending.requirements !== exact)
      ) {
        reply(response, 409, { error: "pending_admission_conflict" });
        return;
      }
      if (pending === undefined) {
        const plan = admitted(config, supplied, data, "observe");
        const workspaceNode = approvedWorkspaceNode(plan);
        const view: Pending = {
          version: 1,
          owner: supplied,
          requirementsDigest,
          profileSha256: profileDigest(data.requirements),
          image: config.image,
          commandSha256: digest(plan.command),
          ...(workspaceNode === undefined ? {} : { workspaceNode }),
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
        else reply(response, 200, current.view);
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
        (config.approvalDir !== undefined && !isApproved(config.approvalDir, pending.view))
      ) {
        reply(response, 409, { error: "owner_admission_not_approved" });
        return;
      }
      const input = admitted(config, supplied, data, "start");
      const workspaceNode = approvedWorkspaceNode(input);
      if (workspaceNode?.planSha256 !== pending.view.workspaceNode?.planSha256) {
        throw new Error("file_node_admitted_plan_changed");
      }
      const view: RecordView = {
        owner: supplied,
        requirementsDigest,
        executionId: randomUUID(),
        state: "starting",
        endpoint: config.endpoint,
        ...(workspaceNode === undefined
          ? {}
          : {
              workspaceNodeMode: workspaceNode.mode,
              workspaceVolume: workspaceNode.workspaceVolume,
            }),
      };
      attempted = true;
      reserveExecution(config.runtimeDir, view);
      const running: LiveRecord = { view, retiring: false };
      current = running;
      let execution: Execution;
      try {
        execution = startInstalledExecution(config, input);
        running.execution = execution;
      } catch {
        view.state = "failed";
        reply(response, 503, { error: "start_outcome_unknown" });
        return;
      }
      void execution.ready.then(
        (receipt) => {
          try {
            if (workspaceNode !== undefined) {
              const bytes = readFileSync(join(config.runtimeDir, READY_FILE), {
                flag: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
              });
              if (!bytes.equals(Buffer.from(`${JSON.stringify(receipt)}\n`))) {
                throw new Error("original_ready_receipt_changed");
              }
              view.generationSha256 = createHash("sha256").update(bytes).digest("hex");
            }
            view.state = "running";
          } catch {
            view.state = "failed";
            void execution.stop().catch(() => undefined);
          }
        },
        () => {
          view.state = "failed";
        },
      );
      void execution.done.then(
        () => {
          view.state = "failed";
        },
        () => {
          view.state = "failed";
        },
      );
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
      );
      process.stdout.write("strands-box-control: exact held admission approved\n");
    } else {
      if (path === undefined || process.argv.length !== 3 || process.arch !== "arm64")
        throw new Error("linux_arm64_required");
      await serve(installedConfig(readConfig(path)));
    }
  } catch {
    process.stderr.write("strands-box-control: configuration, listener or retirement refused\n");
    process.exitCode = 1;
  }
}
