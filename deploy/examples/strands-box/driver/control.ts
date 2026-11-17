import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { request } from "node:http";
import { dirname } from "node:path";
import { DependencyUnavailableError, TransientDependencyError } from "@openclaw-enterprise/occ";
import type { HarnessWorkloadRequirements } from "@openclaw-enterprise/contracts";

export interface Owner {
  readonly driverId: string;
  readonly implementation: string;
  readonly namespaceId: string;
  readonly namespaceName: string;
  readonly agentId: string;
  readonly revisionId: string;
}

export interface Execution {
  readonly owner: Owner;
  readonly requirementsDigest: string;
  readonly executionId: string;
  readonly state: "starting" | "running" | "failed";
  readonly endpoint: { readonly url: string; readonly workspaceRoot: string };
  readonly workspaceNodeMode?: WorkspaceNodeMode;
  readonly workspaceVolume?: WorkspaceVolume;
  readonly generationSha256?: string;
  /**
   * Host-observed repository recipient: the execution bearer digest, the host control process
   * that serves Box's credential source, and the live `box run` that asks it.
   */
  readonly repositoryRecipient?: RepositoryRecipient;
  /** Protected startup as the host observes it; `plan` is the exact admitted proxy plan. */
  readonly protectedStartup?: {
    readonly plan: Readonly<Record<string, unknown>>;
    readonly reservedAt: string;
    readonly generationSha256?: string;
    readonly startupId?: string;
    readonly startupSha256?: string;
  };
  readonly controlledInference?: ControlledInferenceRoute;
}

export interface RepositoryRecipient {
  readonly bearerSha256: string;
  readonly processInstanceId: string;
  /** Present while the live `box run` started with the source routes asks this host. */
  readonly source?: { readonly boxProcessInstanceId: string };
}

/** One Box credential-source ask as the host relays it (host/credential-source.ts). */
export interface SourceAsk {
  readonly askId: string;
  readonly requestId: string;
  readonly bearerSha256: string;
  readonly deadlineUnixMs: number;
  readonly target: {
    readonly host: "github.com" | "api.github.com";
    readonly port: 443;
    readonly method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
    readonly path: string;
    readonly query: string;
  };
  readonly headers: readonly (readonly [string, string])[];
  /** Standard base64, as Box sent it. */
  readonly body: string;
}

/** The Driver's answer for one ask: this request's value with its send-by, or a refusal. */
export type SourceAnswer =
  { readonly credential: string; readonly send_by_unix_ms: number } | { readonly refusal: string };

/** The nonsecret controlled inference route: HTTPS origin, pinned private IPv4, route CA digest. */
export interface ControlledInferenceRoute {
  readonly url: string;
  readonly address: string;
  readonly caSha256?: string;
}

export function inferenceRouteEvidence(value: unknown): ControlledInferenceRoute | undefined {
  const route = record(value);
  if (
    route === undefined ||
    Object.keys(route).some((key) => key !== "url" && key !== "address" && key !== "caSha256") ||
    typeof route.url !== "string" ||
    route.url.length > 256 ||
    typeof route.address !== "string" ||
    !/^[0-9.]{7,15}$/.test(route.address) ||
    (route.caSha256 !== undefined &&
      (typeof route.caSha256 !== "string" || !/^[a-f0-9]{64}$/.test(route.caSha256)))
  )
    return undefined;
  return {
    url: route.url,
    address: route.address,
    ...(route.caSha256 === undefined ? {} : { caSha256: route.caSha256 }),
  };
}

export function sameInferenceRoute(
  a: ControlledInferenceRoute | undefined,
  b: ControlledInferenceRoute | undefined,
): boolean {
  return a?.url === b?.url && a?.address === b?.address && a?.caSha256 === b?.caSha256;
}

export type WorkspaceNodeMode = "file-only-v1";
export interface WorkspaceVolume {
  readonly claimUid: string;
  readonly volumeName: string;
}

const EXECUTION_PATH = "/v1/execution";
const ADMISSION_PATH = "/v1/admission";
const RELEASE_PATH = "/v1/release";
const ASKS_PATH = "/v1/credential-asks";
const ANSWERS_PATH = "/v1/credential-answers";
const SHA256 = /^[a-f0-9]{64}$/;
const LIMIT = 32_768;
const TIMEOUT = 5_000;
/** A collect reply holds asks with up to about 4 MiB of body, base64, plus their heads. */
const ASKS_LIMIT = 12 * 1024 * 1024;

export function record(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
}

/** JSON objects are sorted by UTF-16 code unit. Array order is part of the admitted command. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = record(value);
  if (!object) return JSON.stringify(value);
  return `{${Object.keys(object)
    .sort()
    .filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function sameOwner(a: Owner, b: Owner): boolean {
  return (
    a.driverId === b.driverId &&
    a.implementation === b.implementation &&
    a.namespaceId === b.namespaceId &&
    a.namespaceName === b.namespaceName &&
    a.agentId === b.agentId &&
    a.revisionId === b.revisionId
  );
}

export function sameExecution(a: Execution, b: Execution): boolean {
  return (
    sameOwner(a.owner, b.owner) &&
    a.executionId === b.executionId &&
    a.requirementsDigest === b.requirementsDigest &&
    a.workspaceNodeMode === b.workspaceNodeMode &&
    sameWorkspaceVolume(a.workspaceVolume, b.workspaceVolume) &&
    a.generationSha256 === b.generationSha256 &&
    sameInferenceRoute(a.controlledInference, b.controlledInference) &&
    a.endpoint.url === b.endpoint.url &&
    a.endpoint.workspaceRoot === b.endpoint.workspaceRoot
  );
}

export function workspaceVolume(value: unknown): WorkspaceVolume | undefined {
  const volume = record(value);
  if (
    volume === undefined ||
    Object.keys(volume).length !== 2 ||
    typeof volume.claimUid !== "string" ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(volume.claimUid) ||
    typeof volume.volumeName !== "string" ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(volume.volumeName)
  )
    return undefined;
  return { claimUid: volume.claimUid, volumeName: volume.volumeName };
}

export function sameWorkspaceVolume(a?: WorkspaceVolume, b?: WorkspaceVolume): boolean {
  return a?.claimUid === b?.claimUid && a?.volumeName === b?.volumeName;
}

function parseOwner(value: unknown): Owner | undefined {
  const owner = record(value);
  if (
    !owner ||
    typeof owner.driverId !== "string" ||
    typeof owner.implementation !== "string" ||
    typeof owner.namespaceId !== "string" ||
    typeof owner.namespaceName !== "string" ||
    typeof owner.agentId !== "string" ||
    typeof owner.revisionId !== "string"
  ) {
    return undefined;
  }
  return {
    driverId: owner.driverId,
    implementation: owner.implementation,
    namespaceId: owner.namespaceId,
    namespaceName: owner.namespaceName,
    agentId: owner.agentId,
    revisionId: owner.revisionId,
  };
}

const PROCESS_INSTANCE = /^[a-f0-9-]{36}:[1-9][0-9]{0,9}:[1-9][0-9]{0,19}$/;

function parseRecipient(value: unknown): Execution["repositoryRecipient"] {
  if (value === undefined) return undefined;
  const recipient = record(value);
  const source = record(recipient?.source);
  if (
    !recipient ||
    Object.keys(recipient).some(
      (key) => key !== "bearerSha256" && key !== "processInstanceId" && key !== "source",
    ) ||
    typeof recipient.bearerSha256 !== "string" ||
    !SHA256.test(recipient.bearerSha256) ||
    typeof recipient.processInstanceId !== "string" ||
    !PROCESS_INSTANCE.test(recipient.processInstanceId) ||
    (recipient.source !== undefined &&
      (!source ||
        Object.keys(source).length !== 1 ||
        typeof source.boxProcessInstanceId !== "string" ||
        !PROCESS_INSTANCE.test(source.boxProcessInstanceId)))
  ) {
    throw new Error("Invalid repository recipient evidence");
  }
  return {
    bearerSha256: recipient.bearerSha256,
    processInstanceId: recipient.processInstanceId,
    ...(source === undefined
      ? {}
      : { source: { boxProcessInstanceId: source.boxProcessInstanceId as string } }),
  };
}

function parseStartup(value: unknown): Execution["protectedStartup"] {
  if (value === undefined) return undefined;
  const startup = record(value);
  const plan = record(startup?.plan);
  const allowed = ["plan", "reservedAt", "generationSha256", "startupId", "startupSha256"];
  if (
    !startup ||
    !plan ||
    Object.keys(startup).some((key) => !allowed.includes(key)) ||
    typeof startup.reservedAt !== "string" ||
    new Date(startup.reservedAt).toISOString() !== startup.reservedAt ||
    (startup.generationSha256 !== undefined &&
      (typeof startup.generationSha256 !== "string" || !SHA256.test(startup.generationSha256))) ||
    (startup.startupSha256 !== undefined &&
      (typeof startup.startupSha256 !== "string" ||
        !SHA256.test(startup.startupSha256) ||
        typeof startup.startupId !== "string" ||
        startup.generationSha256 === undefined)) ||
    (startup.startupId !== undefined && startup.startupSha256 === undefined)
  ) {
    throw new Error("Invalid protected startup evidence");
  }
  return {
    plan,
    reservedAt: startup.reservedAt,
    ...(startup.generationSha256 === undefined
      ? {}
      : { generationSha256: startup.generationSha256 as string }),
    ...(startup.startupSha256 === undefined
      ? {}
      : {
          startupId: startup.startupId as string,
          startupSha256: startup.startupSha256 as string,
        }),
  };
}

function parseExecution(value: unknown): Execution {
  const document = record(value);
  const repositoryRecipient = parseRecipient(document?.repositoryRecipient);
  const protectedStartup = parseStartup(document?.protectedStartup);
  const owner = parseOwner(document?.owner);
  const endpoint = record(document?.endpoint);
  const volume = workspaceVolume(document?.workspaceVolume);
  const inference = inferenceRouteEvidence(document?.controlledInference);
  if (
    (document?.controlledInference !== undefined && inference === undefined) ||
    !owner ||
    !endpoint ||
    typeof endpoint.url !== "string" ||
    typeof endpoint.workspaceRoot !== "string" ||
    typeof document?.executionId !== "string" ||
    !/^[a-zA-Z0-9_.:-]{1,128}$/.test(document.executionId) ||
    typeof document.requirementsDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(document.requirementsDigest) ||
    (document.state !== "starting" &&
      document.state !== "running" &&
      document.state !== "failed") ||
    (document.workspaceNodeMode !== undefined && document.workspaceNodeMode !== "file-only-v1") ||
    (document.workspaceVolume !== undefined && volume === undefined) ||
    (document.workspaceNodeMode === undefined) !== (volume === undefined) ||
    (document.generationSha256 !== undefined &&
      (document.workspaceNodeMode === undefined ||
        typeof document.generationSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(document.generationSha256))) ||
    (document.workspaceNodeMode !== undefined &&
      document.state === "running" &&
      document.generationSha256 === undefined) ||
    (repositoryRecipient === undefined) !== (protectedStartup === undefined)
  ) {
    throw new DependencyUnavailableError("Strands Box returned invalid execution evidence.");
  }
  return {
    owner,
    requirementsDigest: document.requirementsDigest,
    executionId: document.executionId,
    state: document.state,
    endpoint: { url: endpoint.url, workspaceRoot: endpoint.workspaceRoot },
    ...(document.workspaceNodeMode === undefined
      ? {}
      : { workspaceNodeMode: document.workspaceNodeMode }),
    ...(volume === undefined ? {} : { workspaceVolume: volume }),
    ...(document.generationSha256 === undefined
      ? {}
      : { generationSha256: document.generationSha256 }),
    ...(repositoryRecipient === undefined ? {} : { repositoryRecipient }),
    ...(protectedStartup === undefined ? {} : { protectedStartup }),
    ...(inference === undefined ? {} : { controlledInference: inference }),
  };
}

interface AdmissionRequest {
  readonly owner: Owner;
  readonly requirementsDigest: string;
  readonly requirements: HarnessWorkloadRequirements;
  readonly workspaceVolume?: WorkspaceVolume;
}

type ControlRequest =
  | { readonly method: "GET"; readonly phase?: "initial-provision" }
  | {
      readonly method: "PUT";
      readonly body: AdmissionRequest & {
        readonly workspaceNodeSetupCode?: string;
        readonly executionBearer?: string;
        readonly controlledInference?: ControlledInferenceRoute;
      };
    }
  | {
      readonly method: "DELETE";
      readonly body: Pick<Execution, "owner" | "executionId" | "requirementsDigest">;
    };

export async function control(
  socketPath: string,
  operation: ControlRequest,
  signal: AbortSignal,
): Promise<Execution | undefined> {
  try {
    const reply = await send(
      socketPath,
      operation.method,
      EXECUTION_PATH,
      "body" in operation ? operation.body : undefined,
      signal,
      operation.method === "GET" && operation.phase === "initial-provision",
    );
    if (operation.method === "GET" && reply.status === 404) return undefined;
    if (operation.method === "DELETE" && reply.status === 204) return undefined;
    if (reply.status !== 200 && !(operation.method === "PUT" && reply.status === 202)) {
      throw new Error("Refused control request");
    }
    return parseExecution(JSON.parse(reply.body));
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof TransientDependencyError) throw error;
    // A failed response conveys no evidence that a mutation did or did not happen.
    throw new DependencyUnavailableError(
      "The Strands Box host did not confirm the execution operation.",
    );
  }
}

/** Relay Compute's signed release; the host verifies it before opening the startup gate. */
export async function releaseExecution(
  socketPath: string,
  body: Pick<Execution, "owner" | "executionId" | "requirementsDigest"> & {
    readonly release: Readonly<Record<string, unknown>>;
  },
  signal: AbortSignal,
): Promise<Execution> {
  try {
    const reply = await send(socketPath, "POST", RELEASE_PATH, body, signal);
    if (reply.status !== 200) throw new Error("Refused release");
    return parseExecution(JSON.parse(reply.body));
  } catch {
    signal.throwIfAborted();
    throw new DependencyUnavailableError("The Strands Box host did not confirm the release.");
  }
}

type ExecutionKey = Pick<Execution, "owner" | "executionId" | "requirementsDigest">;

const ASK_HOSTS = new Set(["github.com", "api.github.com"]);
const ASK_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

function parseAsk(value: unknown): SourceAsk {
  const ask = record(value);
  const target = record(ask?.target);
  if (
    !ask ||
    !target ||
    typeof ask.askId !== "string" ||
    !/^[0-9a-f-]{36}$/.test(ask.askId) ||
    typeof ask.requestId !== "string" ||
    !/^[0-9a-f]{32}$/.test(ask.requestId) ||
    typeof ask.bearerSha256 !== "string" ||
    !SHA256.test(ask.bearerSha256) ||
    typeof ask.deadlineUnixMs !== "number" ||
    !Number.isSafeInteger(ask.deadlineUnixMs) ||
    typeof target.host !== "string" ||
    !ASK_HOSTS.has(target.host) ||
    target.port !== 443 ||
    typeof target.method !== "string" ||
    !ASK_METHODS.has(target.method) ||
    typeof target.path !== "string" ||
    typeof target.query !== "string" ||
    !Array.isArray(ask.headers) ||
    !ask.headers.every(
      (entry: unknown) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string",
    ) ||
    typeof ask.body !== "string"
  ) {
    throw new Error("Invalid credential ask");
  }
  return {
    askId: ask.askId,
    requestId: ask.requestId,
    bearerSha256: ask.bearerSha256,
    deadlineUnixMs: ask.deadlineUnixMs,
    target: {
      host: target.host as SourceAsk["target"]["host"],
      port: 443,
      method: target.method as SourceAsk["target"]["method"],
      path: target.path,
      query: target.query,
    },
    headers: (ask.headers as [string, string][]).map(([name, value]) => [name, value] as const),
    body: ask.body,
  };
}

/**
 * Collect the credential asks Box sent this execution's source since the last call, waiting up
 * to `waitMs` for one. The host hands each ask out once.
 */
export async function collectAsks(
  socketPath: string,
  body: ExecutionKey & { readonly waitMs: number },
  signal: AbortSignal,
): Promise<SourceAsk[]> {
  try {
    const reply = await send(socketPath, "POST", ASKS_PATH, body, signal, false, {
      limit: ASKS_LIMIT,
      timeout: body.waitMs + TIMEOUT,
    });
    if (reply.status !== 200) throw new Error("Refused collect");
    const asks = record(JSON.parse(reply.body))?.asks;
    if (!Array.isArray(asks)) throw new Error("Invalid asks");
    return asks.map(parseAsk);
  } catch {
    signal.throwIfAborted();
    throw new DependencyUnavailableError("The Strands Box host did not return credential asks.");
  }
}

/** Answer one ask. False when the host no longer holds it (it expired, or the execution ended). */
export async function sendAnswer(
  socketPath: string,
  body: ExecutionKey & { readonly askId: string; readonly answer: SourceAnswer },
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const reply = await send(socketPath, "POST", ANSWERS_PATH, body, signal);
    return reply.status === 204;
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

export async function requestAdmission(
  socketPath: string,
  input: AdmissionRequest,
  signal: AbortSignal,
  workspaceNodeMode?: WorkspaceNodeMode,
  controlledInference?: ControlledInferenceRoute,
): Promise<"held" | "approved"> {
  let route: ControlledInferenceRoute | undefined;
  let state: "held" | "approved";
  try {
    const reply = await send(socketPath, "POST", ADMISSION_PATH, input, signal);
    if (reply.status !== 200) throw new Error("Refused admission request");
    const value = record(JSON.parse(reply.body));
    const owner = parseOwner(value?.owner);
    if (
      !owner ||
      !sameOwner(owner, input.owner) ||
      value?.requirementsDigest !== input.requirementsDigest ||
      value.workspaceNodeMode !== workspaceNodeMode ||
      (value.workspaceVolume !== undefined &&
        workspaceVolume(value.workspaceVolume) === undefined) ||
      !sameWorkspaceVolume(workspaceVolume(value.workspaceVolume), input.workspaceVolume) ||
      (value.controlledInference !== undefined &&
        inferenceRouteEvidence(value.controlledInference) === undefined) ||
      (value.state !== "held" && value.state !== "approved")
    ) {
      throw new Error("Mismatched admission receipt");
    }
    route = inferenceRouteEvidence(value.controlledInference);
    state = value.state;
  } catch {
    signal.throwIfAborted();
    throw new DependencyUnavailableError(
      "The Strands Box host did not confirm the exact pending workload.",
    );
  }
  // The host must hold, and the operator approve, the same route this Driver was given.
  if (!sameInferenceRoute(route, controlledInference)) {
    throw new DependencyUnavailableError(
      "The Strands Box host holds a different controlled inference route than this Driver's configuration.",
    );
  }
  return state;
}

async function send(
  socketPath: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body: unknown,
  signal: AbortSignal,
  initialProvision = false,
  { limit = LIMIT, timeout = TIMEOUT }: { limit?: number; timeout?: number } = {},
): Promise<{ status: number; body: string }> {
  signal.throwIfAborted();
  const socket = await lstat(socketPath).catch(async (error: unknown) => {
    if (initialProvision && record(error)?.code === "ENOENT") {
      const directory = await lstat(dirname(socketPath));
      if (
        directory.isDirectory() &&
        (directory.mode & 0o077) === 0 &&
        directory.uid === process.geteuid?.()
      ) {
        // First provision can reach the original control export before its Host starts.
        // This lstat precedes every request; no admission or launch has been sent.
        signal.throwIfAborted();
        throw new TransientDependencyError(
          "sandbox_gateway",
          "unavailable",
          "The Strands Box host has not opened the initial control socket.",
        );
      }
    }
    throw error;
  });
  const directory = await lstat(dirname(socketPath));
  if (
    !socket.isSocket() ||
    (socket.mode & 0o077) !== 0 ||
    !directory.isDirectory() ||
    (directory.mode & 0o077) !== 0 ||
    socket.uid !== directory.uid
  ) {
    throw new Error("Insecure Unix socket");
  }
  signal.throwIfAborted();
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const pending = request(
      {
        socketPath,
        method,
        path,
        agent: false,
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
        headers: {
          accept: "application/json",
          ...(payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.once("error", reject);
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > limit) {
            response.destroy(new Error("Oversize response"));
          } else {
            chunks.push(chunk);
          }
        });
        response.once("end", () => {
          if (!response.complete) {
            reject(new Error("Incomplete response"));
          } else {
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          }
        });
      },
    );
    pending.once("error", reject);
    pending.end(payload);
  });
  signal.throwIfAborted();
  return reply;
}
