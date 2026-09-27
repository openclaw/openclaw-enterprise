import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import { randomUUID } from "node:crypto";
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
  readonly requestId: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly annotations: Readonly<Record<string, string>>;
  readonly spec: RecordValue;
  readonly serviceExposures: readonly {
    readonly service: string;
    readonly targetPort: number;
  }[];
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
  readonly serviceUrls: Readonly<Record<string, string>>;
}

export interface OpenShellWorkspaceResponse {
  readonly name: string;
  readonly id?: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly phase?: string | number;
}

export interface OpenShellProviderProfileEndpoint {
  readonly host: string;
  readonly port: number;
  readonly protocol: string;
  readonly path: string;
}

/** The subset of an upstream ProviderProfile that OpenClaw Enterprise defines. */
export interface OpenShellProviderProfile {
  readonly id: string;
  readonly displayName: string;
  readonly category: "PROVIDER_PROFILE_CATEGORY_INFERENCE" | "PROVIDER_PROFILE_CATEGORY_OTHER";
  readonly credentials: readonly {
    readonly name: string;
    readonly envVars: readonly string[];
    readonly required: boolean;
    readonly authStyle: string;
    readonly headerName: string;
  }[];
  readonly endpoints: readonly OpenShellProviderProfileEndpoint[];
  readonly binaries: readonly string[];
  readonly inferenceCapable: boolean;
  readonly annotations: Readonly<Record<string, string>>;
}

export interface OpenShellStoredProviderProfile {
  readonly id: string;
  readonly resourceVersion: string;
  readonly annotations: Readonly<Record<string, string>>;
}

export interface OpenShellProviderCreateRequest {
  readonly workspace: string;
  readonly name: string;
  readonly type: string;
  readonly labels: Readonly<Record<string, string>>;
  /** Write-only material; never logged or returned by this client. */
  readonly credentials: Readonly<Record<string, string>>;
}

export interface OpenShellProviderResponse {
  readonly name: string;
  readonly type: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface OpenShellSandboxProviderStatus {
  readonly state: string;
  readonly reason?: string;
}

export interface OpenShellGatewayClient {
  health(signal: AbortSignal): Promise<void>;
  getWorkspace(name: string, signal: AbortSignal): Promise<OpenShellWorkspaceResponse | undefined>;
  createWorkspace(
    name: string,
    labels: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<OpenShellWorkspaceResponse>;
  deleteWorkspace(name: string, signal: AbortSignal): Promise<void>;
  createSandbox(
    request: OpenShellSandboxCreateRequest,
    signal: AbortSignal,
  ): Promise<OpenShellSandboxResponse>;
  deleteSandbox(request: OpenShellSandboxDeleteRequest, signal: AbortSignal): Promise<void>;
  getProviderProfile(
    workspace: string,
    id: string,
    signal: AbortSignal,
  ): Promise<OpenShellStoredProviderProfile | undefined>;
  importProviderProfile(
    workspace: string,
    profile: OpenShellProviderProfile,
    signal: AbortSignal,
  ): Promise<void>;
  updateProviderProfile(
    workspace: string,
    profile: OpenShellProviderProfile,
    expectedResourceVersion: string,
    signal: AbortSignal,
  ): Promise<void>;
  deleteProviderProfile(workspace: string, id: string, signal: AbortSignal): Promise<void>;
  createProvider(
    request: OpenShellProviderCreateRequest,
    signal: AbortSignal,
  ): Promise<OpenShellProviderResponse>;
  getProvider(
    workspace: string,
    name: string,
    signal: AbortSignal,
  ): Promise<OpenShellProviderResponse | undefined>;
  listProviders(
    workspace: string,
    signal: AbortSignal,
  ): Promise<readonly OpenShellProviderResponse[]>;
  deleteProvider(workspace: string, name: string, signal: AbortSignal): Promise<void>;
  getSandboxProviderStatus(
    workspace: string,
    sandbox: string,
    provider: string,
    signal: AbortSignal,
  ): Promise<OpenShellSandboxProviderStatus>;
  close(): void;
}

type OpenShellMethod =
  | "Health"
  | "GetWorkspace"
  | "CreateWorkspace"
  | "DeleteWorkspace"
  | "CreateSandbox"
  | "DeleteSandbox"
  | "GetSandboxProviderStatus"
  | "CreateProvider"
  | "GetProvider"
  | "ListProviders"
  | "DeleteProvider"
  | "GetProviderProfile"
  | "ImportProviderProfiles"
  | "UpdateProviderProfiles"
  | "DeleteProviderProfile";

type OpenShellUnaryMethod = (
  request: RecordValue,
  metadata: Metadata,
  options: { deadline: Date },
  callback: (error: Error | null, response?: RecordValue) => void,
) => ClientUnaryCall;

type OpenShellGrpcClient = Client & Record<OpenShellMethod, OpenShellUnaryMethod>;

class OpenShellGatewayFailure extends Error {}

export class OpenShellSandboxAlreadyExistsError extends Error {
  readonly sandboxName: string;

  constructor(sandboxName: string) {
    super(`OpenShell Sandbox ${sandboxName} already exists.`);
    this.sandboxName = sandboxName;
  }
}

export class OpenShellProviderAlreadyExistsError extends Error {
  readonly providerName: string;

  constructor(providerName: string) {
    super(`OpenShell provider ${providerName} already exists.`);
    this.providerName = providerName;
  }
}

export class OpenShellWorkspaceAlreadyExistsError extends Error {
  readonly workspaceName: string;

  constructor(workspaceName: string) {
    super(`OpenShell Workspace ${workspaceName} already exists.`);
    this.workspaceName = workspaceName;
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

function workspaceResponse(response: RecordValue, operation: string): OpenShellWorkspaceResponse {
  const workspace = asRecord(response.workspace);
  const metadata = asRecord(workspace?.metadata);
  const name = metadata?.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new OpenShellGatewayFailure(`OpenShell ${operation} returned no stable Workspace name.`);
  }
  const workspaceLabels = asRecord(metadata?.labels) ?? {};
  if (Object.values(workspaceLabels).some((value) => typeof value !== "string")) {
    throw new OpenShellGatewayFailure(`OpenShell ${operation} returned invalid Workspace labels.`);
  }
  return Object.freeze({
    name,
    ...(typeof metadata?.id === "string" && metadata.id.length > 0 ? { id: metadata.id } : {}),
    labels: Object.freeze({ ...(workspaceLabels as Record<string, string>) }),
    ...(asRecord(workspace?.status)?.phase === undefined
      ? {}
      : { phase: asRecord(workspace?.status)?.phase as string | number }),
  });
}

function stringMap(value: unknown, description: string): Readonly<Record<string, string>> {
  const record = asRecord(value) ?? {};
  if (Object.values(record).some((entry) => typeof entry !== "string")) {
    throw new OpenShellGatewayFailure(`OpenShell ${description} must be a string map.`);
  }
  return Object.freeze({ ...(record as Record<string, string>) });
}

function providerResponse(value: unknown, operation: string): OpenShellProviderResponse {
  const provider = asRecord(value);
  const metadata = asRecord(provider?.metadata);
  const name = metadata?.name;
  if (typeof name !== "string" || name.trim().length === 0 || typeof provider?.type !== "string") {
    throw new OpenShellGatewayFailure(`OpenShell ${operation} returned no stable provider.`);
  }
  // Credential values are never copied out of gateway responses.
  return Object.freeze({
    name,
    type: provider.type,
    labels: stringMap(metadata?.labels, "provider labels"),
  });
}

function profileMessage(profile: OpenShellProviderProfile): RecordValue {
  return {
    id: profile.id,
    display_name: profile.displayName,
    category: profile.category,
    credentials: profile.credentials.map((credential) => ({
      name: credential.name,
      env_vars: [...credential.envVars],
      required: credential.required,
      auth_style: credential.authStyle,
      header_name: credential.headerName,
    })),
    endpoints: profile.endpoints.map((endpoint) => ({
      host: endpoint.host,
      port: endpoint.port,
      protocol: endpoint.protocol,
      path: endpoint.path,
      enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
      access: "NETWORK_ACCESS_PRESET_READ_WRITE",
    })),
    binaries: profile.binaries.map((path) => ({ path })),
    inference_capable: profile.inferenceCapable,
    annotations: { ...profile.annotations },
  };
}

function profileDiagnosticsFailure(response: RecordValue, operation: string): void {
  const diagnostics = Array.isArray(response.diagnostics) ? response.diagnostics : [];
  const errors = diagnostics
    .map((entry) => asRecord(entry))
    .filter((entry) => entry?.severity === "error");
  if (errors.length > 0) {
    const detail = errors
      .map((entry) => `${String(entry?.field ?? "profile")}: ${String(entry?.message ?? "")}`)
      .join("; ");
    throw new OpenShellGatewayFailure(`OpenShell ${operation} rejected the profile: ${detail}`);
  }
}

function deletionConfirmed(response: RecordValue): boolean {
  return ["DELETION_OUTCOME_COMPLETED", "DELETION_OUTCOME_ALREADY_ABSENT", 1, 3].includes(
    response.outcome as string | number,
  );
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

function normalizeServiceUrl(value: unknown, endpoint: string): string {
  let serviceUrl: URL;
  try {
    serviceUrl = new URL(nonempty(value, "OpenShell service URL"));
  } catch {
    throw new OpenShellGatewayFailure("OpenShell service URL must be a valid URL.");
  }
  if (
    (serviceUrl.protocol !== "http:" && serviceUrl.protocol !== "https:") ||
    serviceUrl.username.length > 0 ||
    serviceUrl.password.length > 0 ||
    serviceUrl.pathname !== "/" ||
    serviceUrl.search.length > 0 ||
    serviceUrl.hash.length > 0
  ) {
    throw new OpenShellGatewayFailure(
      "OpenShell service URL must be an HTTP origin without credentials, query, or fragment.",
    );
  }
  const gateway = normalizeEndpoint(endpoint);
  const gatewayUrl = new URL(`${gateway.secure ? "https" : "http"}://${gateway.target}`);
  serviceUrl.port = gatewayUrl.port;
  return serviceUrl.toString();
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

  async getWorkspace(
    name: string,
    signal: AbortSignal,
  ): Promise<OpenShellWorkspaceResponse | undefined> {
    try {
      return workspaceResponse(
        await this.unary(
          "GetWorkspace",
          { name: nonempty(name, "OpenShell Workspace name") },
          signal,
        ),
        "GetWorkspace",
      );
    } catch (error) {
      const { grpc } = await this.ensureClient();
      if (statusCode(error) === grpc.status.NOT_FOUND) {
        return undefined;
      }
      throw error;
    }
  }

  async createWorkspace(
    name: string,
    labels: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<OpenShellWorkspaceResponse> {
    const workspaceName = nonempty(name, "OpenShell Workspace name");
    try {
      return workspaceResponse(
        await this.unary(
          "CreateWorkspace",
          { name: workspaceName, labels: { ...labels }, request_id: randomUUID() },
          signal,
        ),
        "CreateWorkspace",
      );
    } catch (error) {
      const { grpc } = await this.ensureClient();
      if (statusCode(error) === grpc.status.ALREADY_EXISTS) {
        throw new OpenShellWorkspaceAlreadyExistsError(workspaceName);
      }
      throw error;
    }
  }

  async deleteWorkspace(name: string, signal: AbortSignal): Promise<void> {
    let response: RecordValue;
    try {
      response = await this.unary(
        "DeleteWorkspace",
        {
          name: nonempty(name, "OpenShell Workspace name"),
          allow_missing: true,
          request_id: randomUUID(),
        },
        signal,
      );
    } catch (error) {
      const { grpc } = await this.ensureClient();
      if (statusCode(error) === grpc.status.NOT_FOUND) {
        return;
      }
      throw error;
    }
    if (
      !["DELETION_OUTCOME_COMPLETED", "DELETION_OUTCOME_ALREADY_ABSENT", 1, 3].includes(
        response.outcome as string | number,
      )
    ) {
      throw new OpenShellGatewayFailure(
        "OpenShell DeleteWorkspace did not confirm Workspace deletion.",
      );
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
          workspace_scope: { workspace: request.workspace },
          request_id: request.requestId,
          labels: { ...request.labels },
          annotations: { ...request.annotations },
          spec: request.spec,
          service_exposures: request.serviceExposures.map(({ service, targetPort }) => ({
            service,
            target_port: targetPort,
          })),
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
    const serviceUrls = asRecord(response.service_urls);
    if (serviceUrls === undefined) {
      throw new OpenShellGatewayFailure("OpenShell CreateSandbox returned no service URL map.");
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
      serviceUrls: Object.freeze(
        Object.fromEntries(
          Object.entries(serviceUrls).map(([service, value]) => [
            service,
            normalizeServiceUrl(value, this.options.endpoint),
          ]),
        ),
      ),
      ...(asRecord(sandbox?.status)?.phase === undefined
        ? {}
        : { phase: asRecord(sandbox?.status)?.phase as string | number }),
    });
  }

  async deleteSandbox(request: OpenShellSandboxDeleteRequest, signal: AbortSignal): Promise<void> {
    try {
      await this.unary(
        "DeleteSandbox",
        { name: request.name, workspace_scope: { workspace: request.workspace } },
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

  async getProviderProfile(
    workspace: string,
    id: string,
    signal: AbortSignal,
  ): Promise<OpenShellStoredProviderProfile | undefined> {
    let response: RecordValue;
    try {
      response = await this.unary(
        "GetProviderProfile",
        { id: nonempty(id, "OpenShell provider profile ID"), workspace_scope: { workspace } },
        signal,
      );
    } catch (error) {
      if (await this.isStatus(error, "NOT_FOUND")) {
        return undefined;
      }
      throw error;
    }
    const profile = asRecord(response.profile);
    if (typeof profile?.id !== "string" || profile.id !== id) {
      throw new OpenShellGatewayFailure("OpenShell GetProviderProfile returned another profile.");
    }
    return Object.freeze({
      id: profile.id,
      resourceVersion: String(profile.resource_version ?? "0"),
      annotations: stringMap(profile.annotations, "profile annotations"),
    });
  }

  async importProviderProfile(
    workspace: string,
    profile: OpenShellProviderProfile,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.unary(
      "ImportProviderProfiles",
      {
        profiles: [{ profile: profileMessage(profile), source: "openclaw-enterprise" }],
        workspace_scope: { workspace },
        request_id: randomUUID(),
      },
      signal,
    );
    profileDiagnosticsFailure(response, "ImportProviderProfiles");
    if (response.imported !== true) {
      throw new OpenShellGatewayFailure("OpenShell ImportProviderProfiles did not import.");
    }
  }

  async updateProviderProfile(
    workspace: string,
    profile: OpenShellProviderProfile,
    expectedResourceVersion: string,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.unary(
      "UpdateProviderProfiles",
      {
        id: profile.id,
        profile: { profile: profileMessage(profile), source: "openclaw-enterprise" },
        expected_resource_version: expectedResourceVersion,
        workspace_scope: { workspace },
        request_id: randomUUID(),
      },
      signal,
    );
    profileDiagnosticsFailure(response, "UpdateProviderProfiles");
    if (response.updated !== true) {
      throw new OpenShellGatewayFailure("OpenShell UpdateProviderProfiles did not update.");
    }
  }

  async deleteProviderProfile(workspace: string, id: string, signal: AbortSignal): Promise<void> {
    const response = await this.unary(
      "DeleteProviderProfile",
      {
        id: nonempty(id, "OpenShell provider profile ID"),
        workspace_scope: { workspace },
        allow_missing: true,
        request_id: randomUUID(),
      },
      signal,
    );
    if (!deletionConfirmed(response)) {
      throw new OpenShellGatewayFailure(
        "OpenShell DeleteProviderProfile did not confirm deletion.",
      );
    }
  }

  async createProvider(
    request: OpenShellProviderCreateRequest,
    signal: AbortSignal,
  ): Promise<OpenShellProviderResponse> {
    const name = nonempty(request.name, "OpenShell provider name");
    let response: RecordValue;
    try {
      response = await this.unary(
        "CreateProvider",
        {
          provider: {
            metadata: { name, labels: { ...request.labels } },
            type: nonempty(request.type, "OpenShell provider type"),
            // OCC imports its profiles into the same workspace as the provider.
            profile_workspace: request.workspace,
            credentials: { ...request.credentials },
          },
          workspace_scope: { workspace: request.workspace },
          request_id: randomUUID(),
        },
        signal,
      );
    } catch (error) {
      if (await this.isStatus(error, "ALREADY_EXISTS")) {
        throw new OpenShellProviderAlreadyExistsError(name);
      }
      throw error;
    }
    return providerResponse(response.provider, "CreateProvider");
  }

  async getProvider(
    workspace: string,
    name: string,
    signal: AbortSignal,
  ): Promise<OpenShellProviderResponse | undefined> {
    let response: RecordValue;
    try {
      response = await this.unary(
        "GetProvider",
        { name: nonempty(name, "OpenShell provider name"), workspace_scope: { workspace } },
        signal,
      );
    } catch (error) {
      if (await this.isStatus(error, "NOT_FOUND")) {
        return undefined;
      }
      throw error;
    }
    return providerResponse(response.provider, "GetProvider");
  }

  async listProviders(
    workspace: string,
    signal: AbortSignal,
  ): Promise<readonly OpenShellProviderResponse[]> {
    const providers: OpenShellProviderResponse[] = [];
    let pageToken = "";
    do {
      const response = await this.unary(
        "ListProviders",
        { page_size: 100, page_token: pageToken, workspace_scope: { workspace } },
        signal,
      );
      for (const provider of Array.isArray(response.providers) ? response.providers : []) {
        providers.push(providerResponse(provider, "ListProviders"));
      }
      pageToken = typeof response.next_page_token === "string" ? response.next_page_token : "";
    } while (pageToken.length > 0);
    return Object.freeze(providers);
  }

  async deleteProvider(workspace: string, name: string, signal: AbortSignal): Promise<void> {
    const response = await this.unary(
      "DeleteProvider",
      {
        name: nonempty(name, "OpenShell provider name"),
        workspace_scope: { workspace },
        allow_missing: true,
        request_id: randomUUID(),
      },
      signal,
    );
    if (!deletionConfirmed(response)) {
      throw new OpenShellGatewayFailure("OpenShell DeleteProvider did not confirm deletion.");
    }
  }

  async getSandboxProviderStatus(
    workspace: string,
    sandbox: string,
    provider: string,
    signal: AbortSignal,
  ): Promise<OpenShellSandboxProviderStatus> {
    const response = await this.unary(
      "GetSandboxProviderStatus",
      {
        sandbox: nonempty(sandbox, "OpenShell Sandbox name"),
        provider: nonempty(provider, "OpenShell provider name"),
        workspace_scope: { workspace },
      },
      signal,
    );
    const status = asRecord(response.status);
    if (typeof status?.state !== "string") {
      throw new OpenShellGatewayFailure("OpenShell GetSandboxProviderStatus returned no state.");
    }
    return Object.freeze({
      state: status.state,
      ...(typeof status.reason === "string" ? { reason: status.reason } : {}),
    });
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
    method: OpenShellMethod,
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

  private async isStatus(error: unknown, name: "NOT_FOUND" | "ALREADY_EXISTS"): Promise<boolean> {
    const { grpc } = await this.ensureClient();
    return statusCode(error) === grpc.status[name];
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
