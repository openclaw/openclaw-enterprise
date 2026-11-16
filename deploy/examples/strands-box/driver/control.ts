import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { request } from "node:http";
import { dirname } from "node:path";
import { DependencyUnavailableError } from "@openclaw-enterprise/occ";
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
}

export type WorkspaceNodeMode = "file-only-v1";
export interface WorkspaceVolume {
  readonly claimUid: string;
  readonly volumeName: string;
}

const EXECUTION_PATH = "/v1/execution";
const ADMISSION_PATH = "/v1/admission";
const LIMIT = 32_768;
const TIMEOUT = 5_000;

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

function parseExecution(value: unknown): Execution {
  const document = record(value);
  const owner = parseOwner(document?.owner);
  const endpoint = record(document?.endpoint);
  const volume = workspaceVolume(document?.workspaceVolume);
  if (
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
      document.generationSha256 === undefined)
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
  };
}

interface AdmissionRequest {
  readonly owner: Owner;
  readonly requirementsDigest: string;
  readonly requirements: HarnessWorkloadRequirements;
  readonly workspaceVolume?: WorkspaceVolume;
}

type ControlRequest =
  | { readonly method: "GET" }
  | {
      readonly method: "PUT";
      readonly body: AdmissionRequest & {
        readonly workspaceNodeSetupCode?: string;
        readonly controlledInference?: true;
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
    );
    if (operation.method === "GET" && reply.status === 404) return undefined;
    if (operation.method === "DELETE" && reply.status === 204) return undefined;
    if (reply.status !== 200 && !(operation.method === "PUT" && reply.status === 202)) {
      throw new Error("Refused control request");
    }
    return parseExecution(JSON.parse(reply.body));
  } catch {
    signal.throwIfAborted();
    // A failed response conveys no evidence that a mutation did or did not happen.
    throw new DependencyUnavailableError(
      "The Strands Box host did not confirm the execution operation.",
    );
  }
}

export async function requestAdmission(
  socketPath: string,
  input: AdmissionRequest,
  signal: AbortSignal,
  workspaceNodeMode?: WorkspaceNodeMode,
): Promise<"held" | "approved"> {
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
      (value.state !== "held" && value.state !== "approved")
    ) {
      throw new Error("Mismatched admission receipt");
    }
    return value.state;
  } catch {
    signal.throwIfAborted();
    throw new DependencyUnavailableError(
      "The Strands Box host did not confirm the exact pending workload.",
    );
  }
}

async function send(
  socketPath: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<{ status: number; body: string }> {
  signal.throwIfAborted();
  const socket = await lstat(socketPath);
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
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]),
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
          if (bytes > LIMIT) {
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
