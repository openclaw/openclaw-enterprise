import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client, ClientUnaryCall, Metadata, ServiceClientConstructor } from "@grpc/grpc-js";
import type { PackageDefinition } from "@grpc/proto-loader";

type RecordValue = Readonly<Record<string, unknown>>;

export interface OpenShellGatewayClientOptions {
  readonly endpoint: string;
  readonly auth?:
    | { readonly mode: "unauthenticated" }
    | { readonly mode: "bearerTokenFile"; readonly path: string };
  readonly requestTimeoutMs?: number;
  readonly rootCertificatePath?: string;
}

export interface OpenShellSandboxCreateRequest {
  readonly name: string;
  readonly workspace: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly annotations: Readonly<Record<string, string>>;
  readonly spec: RecordValue;
}

export interface OpenShellSandboxDeleteRequest {
  readonly name: string;
  readonly workspace: string;
}

export interface OpenShellSandboxResponse {
  readonly name: string;
  readonly id?: string;
  readonly workspace?: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly phase?: string | number;
}

export interface OpenShellGatewayClient {
  health(signal: AbortSignal): Promise<void>;
  createSandbox(
    request: OpenShellSandboxCreateRequest,
    signal: AbortSignal,
  ): Promise<OpenShellSandboxResponse>;
  deleteSandbox(request: OpenShellSandboxDeleteRequest, signal: AbortSignal): Promise<void>;
  close(): void;
}

interface OpenShellGrpcClient extends Client {
  Health(
    request: RecordValue,
    metadata: Metadata,
    options: { deadline: Date },
    callback: (error: Error | null, response?: RecordValue) => void,
  ): ClientUnaryCall;
  CreateSandbox(
    request: RecordValue,
    metadata: Metadata,
    options: { deadline: Date },
    callback: (error: Error | null, response?: RecordValue) => void,
  ): ClientUnaryCall;
  DeleteSandbox(
    request: RecordValue,
    metadata: Metadata,
    options: { deadline: Date },
    callback: (error: Error | null, response?: RecordValue) => void,
  ): ClientUnaryCall;
}

class OpenShellGatewayFailure extends Error {}

export class OpenShellSandboxAlreadyExistsError extends Error {
  readonly sandboxName: string;

  constructor(sandboxName: string) {
    super(`OpenShell Sandbox ${sandboxName} already exists.`);
    this.sandboxName = sandboxName;
  }
}

const CLIENT_MODULE = "@grpc/grpc-js";
const LOADER_MODULE = "@grpc/proto-loader";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function nonempty(value: unknown, description: string): string {
  if (!isNonEmptyString(value)) {
    throw new OpenShellGatewayFailure(`${description} must be a nonempty string.`);
  }
  return value;
}

function deadline(timeoutMs: number): Date {
  return new Date(Date.now() + timeoutMs);
}

function statusCode(error: unknown): number | undefined {
  const candidate = asRecord(error)?.code;
  return typeof candidate === "number" ? candidate : undefined;
}

function normalizeEndpoint(endpoint: string): {
  readonly target: string;
  readonly secure: boolean;
} {
  const value = nonempty(endpoint, "OpenShell gateway endpoint");
  if (!value.includes("://")) {
    return { target: value, secure: false };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OpenShellGatewayFailure("OpenShell gateway endpoint is not a valid URL.");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new OpenShellGatewayFailure(
      "OpenShell gateway endpoint must not include credentials, path, query, or fragment.",
    );
  }
  if (parsed.protocol === "http:") {
    return { target: parsed.host, secure: false };
  }
  if (parsed.protocol === "https:") {
    return { target: parsed.host, secure: true };
  }
  throw new OpenShellGatewayFailure("OpenShell gateway endpoint must use http or https.");
}

function toStructValue(value: unknown): Record<string, unknown> {
  if (value === null) {
    return { nullValue: 0 };
  }
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new OpenShellGatewayFailure("Struct numbers must be finite.");
    }
    return { numberValue: value };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (Array.isArray(value)) {
    return { listValue: { values: value.map((entry) => toStructValue(entry)) } };
  }
  const object = asRecord(value);
  if (object === undefined) {
    throw new OpenShellGatewayFailure("Struct values must be JSON-compatible.");
  }
  return {
    structValue: {
      fields: Object.fromEntries(
        Object.entries(object).map(([key, entry]) => [key, toStructValue(entry)]),
      ),
    },
  };
}

export function toProtobufStruct(value: RecordValue): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, toStructValue(entry)]),
  );
}

function metadataValue(token: string): string {
  const value = token.trim();
  if (value.length === 0 || /[\r\n]/.test(value)) {
    throw new OpenShellGatewayFailure("OpenShell bearer token file is empty or invalid.");
  }
  return `Bearer ${value}`;
}

async function metadata(
  grpc: typeof import("@grpc/grpc-js"),
  auth: OpenShellGatewayClientOptions["auth"],
): Promise<Metadata> {
  const value = new grpc.Metadata();
  if (auth === undefined || auth.mode === "unauthenticated") {
    return value;
  }
  if (!isAbsolute(auth.path)) {
    throw new OpenShellGatewayFailure("OpenShell bearer token file path must be absolute.");
  }
  value.set("authorization", metadataValue(await readFile(auth.path, "utf8")));
  return value;
}

async function loadGrpc(): Promise<{
  readonly grpc: typeof import("@grpc/grpc-js");
  readonly loader: typeof import("@grpc/proto-loader");
}> {
  try {
    const [grpc, loader] = await Promise.all([import(CLIENT_MODULE), import(LOADER_MODULE)]);
    return { grpc, loader };
  } catch (error) {
    throw new OpenShellGatewayFailure(
      `The OpenShell Sandbox Driver requires ${CLIENT_MODULE} and ${LOADER_MODULE}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export class GrpcOpenShellGatewayClient implements OpenShellGatewayClient {
  private readonly options: OpenShellGatewayClientOptions;
  private readonly requestTimeoutMs: number;
  private client:
    | Promise<{
        readonly grpc: typeof import("@grpc/grpc-js");
        readonly client: OpenShellGrpcClient;
      }>
    | undefined;

  constructor(options: OpenShellGatewayClientOptions) {
    this.options = options;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1000) {
      throw new OpenShellGatewayFailure("OpenShell request timeout must be at least 1000 ms.");
    }
    if (options.auth?.mode === "bearerTokenFile" && !isAbsolute(options.auth.path)) {
      throw new OpenShellGatewayFailure("OpenShell bearer token file path must be absolute.");
    }
    if (options.rootCertificatePath !== undefined && !isAbsolute(options.rootCertificatePath)) {
      throw new OpenShellGatewayFailure("OpenShell root certificate path must be absolute.");
    }
  }

  async health(signal: AbortSignal): Promise<void> {
    const response = await this.unary("Health", {}, signal);
    const status = response.status;
    if (status !== "SERVICE_STATUS_HEALTHY" && status !== 1) {
      throw new OpenShellGatewayFailure("OpenShell gateway is not healthy.");
    }
  }

  async createSandbox(
    request: OpenShellSandboxCreateRequest,
    signal: AbortSignal,
  ): Promise<OpenShellSandboxResponse> {
    let response: RecordValue;
    try {
      response = await this.unary(
        "CreateSandbox",
        {
          name: request.name,
          workspace: request.workspace,
          labels: { ...request.labels },
          annotations: { ...request.annotations },
          spec: request.spec,
        },
        signal,
      );
    } catch (error) {
      const { grpc } = await this.ensureClient();
      if (statusCode(error) === grpc.status.ALREADY_EXISTS) {
        throw new OpenShellSandboxAlreadyExistsError(request.name);
      }
      throw error;
    }
    const sandbox = asRecord(response.sandbox);
    const metadata = asRecord(sandbox?.metadata);
    const name = metadata?.name;
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new OpenShellGatewayFailure("OpenShell CreateSandbox returned no stable name.");
    }
    return Object.freeze({
      name,
      ...(typeof metadata?.id === "string" && metadata.id.length > 0 ? { id: metadata.id } : {}),
      ...(typeof metadata?.workspace === "string" && metadata.workspace.length > 0
        ? { workspace: metadata.workspace }
        : {}),
      labels: Object.freeze({
        ...(asRecord(metadata?.labels) as Record<string, string> | undefined),
      }),
      ...(asRecord(sandbox?.status)?.phase === undefined
        ? {}
        : { phase: asRecord(sandbox?.status)?.phase as string | number }),
    });
  }

  async deleteSandbox(request: OpenShellSandboxDeleteRequest, signal: AbortSignal): Promise<void> {
    try {
      await this.unary(
        "DeleteSandbox",
        { name: request.name, workspace: request.workspace },
        signal,
      );
    } catch (error) {
      const { grpc } = await this.ensureClient();
      if (statusCode(error) === grpc.status.NOT_FOUND) {
        return;
      }
      throw error;
    }
  }

  close(): void {
    const current = this.client;
    this.client = undefined;
    current
      ?.then(({ client }) => client.close())
      .catch(() => {
        // Nothing useful can be done after close; future calls create a fresh client.
      });
  }

  private async unary(
    method: "Health" | "CreateSandbox" | "DeleteSandbox",
    request: RecordValue,
    signal: AbortSignal,
  ): Promise<RecordValue> {
    signal.throwIfAborted();
    const { grpc, client } = await this.ensureClient();
    const headers = await metadata(grpc, this.options.auth);
    return new Promise<RecordValue>((resolve, reject) => {
      let call: ClientUnaryCall | undefined;
      const abort = () => {
        call?.cancel();
        reject(signal.reason ?? new Error("OpenShell gateway request aborted."));
      };
      signal.addEventListener("abort", abort, { once: true });
      call = client[method](
        request,
        headers,
        { deadline: deadline(this.requestTimeoutMs) },
        (error, response) => {
          signal.removeEventListener("abort", abort);
          if (signal.aborted) {
            reject(signal.reason ?? new Error("OpenShell gateway request aborted."));
            return;
          }
          if (error !== null) {
            reject(error);
            return;
          }
          resolve(asRecord(response) ?? {});
        },
      );
    });
  }

  private async ensureClient(): Promise<{
    readonly grpc: typeof import("@grpc/grpc-js");
    readonly client: OpenShellGrpcClient;
  }> {
    if (this.client !== undefined) {
      return this.client;
    }
    this.client = this.createClient();
    return this.client;
  }

  private async createClient(): Promise<{
    readonly grpc: typeof import("@grpc/grpc-js");
    readonly client: OpenShellGrpcClient;
  }> {
    const { grpc, loader } = await loadGrpc();
    const protoPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "proto",
      "openshell-gateway.proto",
    );
    const packageDefinition: PackageDefinition = await loader.load(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: false,
      oneofs: true,
    });
    const loaded = grpc.loadPackageDefinition(packageDefinition) as unknown as {
      readonly openshell?: { readonly v1?: { readonly OpenShell?: ServiceClientConstructor } };
    };
    const OpenShell = loaded.openshell?.v1?.OpenShell;
    if (OpenShell === undefined) {
      throw new OpenShellGatewayFailure("OpenShell gRPC service was not found in the proto.");
    }
    const endpoint = normalizeEndpoint(this.options.endpoint);
    const credentials = endpoint.secure
      ? grpc.credentials.createSsl(
          this.options.rootCertificatePath === undefined
            ? undefined
            : readFileSync(this.options.rootCertificatePath),
        )
      : grpc.credentials.createInsecure();
    return {
      grpc,
      client: new OpenShell(endpoint.target, credentials) as unknown as OpenShellGrpcClient,
    };
  }
}
