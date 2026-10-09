import { isAbsolute } from "node:path";
import type {
  Driver,
  BackendDefinition,
  DriverCapability,
  OpenShellBackendDefinition,
} from "@openclaw-enterprise/contracts";
import { BACKEND_ID_MAX_CHARACTERS, isBackendId } from "@openclaw-enterprise/contracts";
import { asRecord, deepFreeze, isNonEmptyString } from "@openclaw-enterprise/utils";
import { DriverSelectionError, ResourceConflictError, ScopeViolationError } from "./errors.ts";

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CHATGPT_CREDENTIAL_TTL_SECONDS = 30 * 24 * 60 * 60;

type BackendMap = ReadonlyMap<string, BackendDefinition>;

function path(value: string, key: string): string {
  return `backend[${value}].${key}`;
}

function backendId(value: unknown, label = "Backend ID"): string {
  // The API schema's rule (contracts BackendId), so a configured Backend ID and an Agent's
  // backendId accept exactly the same strings.
  if (!isBackendId(value)) {
    throw new ScopeViolationError(
      `${label} must be a string of 1 to ${BACKEND_ID_MAX_CHARACTERS} characters with no leading or trailing whitespace and no control characters or line or paragraph separators.`,
    );
  }
  return value;
}

function validateBackendDefinition(value: unknown, index: number): BackendDefinition {
  const candidate = asRecord(value);
  if (candidate === undefined) {
    throw new ScopeViolationError(`backend[${index}] must be one object.`);
  }
  for (const key of Object.keys(candidate)) {
    if (!["id", "type", "configuration", "drivers"].includes(key)) {
      throw new ScopeViolationError(`backend[${index}] contains unsupported option ${key}.`);
    }
  }
  const id = backendId(candidate.id, `backend[${index}].id`);
  if (
    candidate.type !== "chatgpt" &&
    candidate.type !== "github" &&
    candidate.type !== "openshell"
  ) {
    throw new ScopeViolationError(path(id, "type") + " must be chatgpt, github, or openshell.");
  }
  // Repository bindings still store a GitHub Backend ID under a 200 UTF-16 code unit bound
  // (occ.repository_bindings_are_valid, the repository registry and the binding state), so a
  // GitHub Backend ID must fit that too until those count code points.
  if (candidate.type === "github" && id.length > BACKEND_ID_MAX_CHARACTERS) {
    throw new ScopeViolationError(
      `backend[${index}].id must fit in ${BACKEND_ID_MAX_CHARACTERS} UTF-16 code units for a GitHub Backend, because repository bindings store it under that bound.`,
    );
  }

  const configuration = asRecord(candidate.configuration);
  if (configuration === undefined) {
    throw new ScopeViolationError(path(id, "configuration") + " must be one object.");
  }
  const drivers = asRecord(candidate.drivers);
  if (drivers === undefined) {
    throw new ScopeViolationError(path(id, "drivers") + " must be one object.");
  }
  if (candidate.type === "openshell") {
    return validateOpenShellBackend(id, configuration, drivers);
  }
  if (candidate.type === "github") {
    for (const key of Object.keys(configuration)) {
      if (key !== "registryPath") {
        throw new ScopeViolationError(path(id, `configuration.${key}`) + " is unsupported.");
      }
    }
    const registryPath = configuration.registryPath;
    if (!isNonEmptyString(registryPath) || !isAbsolute(registryPath)) {
      throw new ScopeViolationError(
        path(id, "configuration.registryPath") + " must be an absolute mounted file path.",
      );
    }
    for (const key of Object.keys(drivers)) {
      if (key !== "repo") {
        throw new ScopeViolationError(path(id, `drivers.${key}`) + " is unsupported.");
      }
    }
    const repo = drivers.repo;
    if (!isNonEmptyString(repo)) {
      throw new ScopeViolationError(path(id, "drivers.repo") + " is required.");
    }
    return deepFreeze({
      id,
      type: "github",
      configuration: { registryPath },
      drivers: { repo },
    });
  }
  for (const key of Object.keys(configuration)) {
    if (!["workspaceId", "apiKeyPath", "credentialTtlSeconds"].includes(key)) {
      throw new ScopeViolationError(path(id, `configuration.${key}`) + " is unsupported.");
    }
  }
  const workspaceId = configuration.workspaceId;
  if (typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId)) {
    throw new ScopeViolationError(path(id, "configuration.workspaceId") + " is invalid.");
  }
  const apiKeyPath = configuration.apiKeyPath;
  if (typeof apiKeyPath !== "string" || apiKeyPath.trim().length === 0 || !isAbsolute(apiKeyPath)) {
    throw new ScopeViolationError(
      path(id, "configuration.apiKeyPath") + " must be an absolute mounted file path.",
    );
  }
  const credentialTtlSeconds = configuration.credentialTtlSeconds;
  if (
    credentialTtlSeconds !== undefined &&
    (!Number.isSafeInteger(credentialTtlSeconds) ||
      (credentialTtlSeconds as number) < 1 ||
      (credentialTtlSeconds as number) > MAX_CHATGPT_CREDENTIAL_TTL_SECONDS)
  ) {
    throw new ScopeViolationError(
      path(id, "configuration.credentialTtlSeconds") + " must be between 1 and 2592000.",
    );
  }

  for (const key of Object.keys(drivers)) {
    if (key !== "service_account") {
      throw new ScopeViolationError(path(id, `drivers.${key}`) + " is unsupported.");
    }
  }
  const serviceAccount = drivers.service_account;
  if (!isNonEmptyString(serviceAccount)) {
    throw new ScopeViolationError(path(id, "drivers.service_account") + " is required.");
  }

  return deepFreeze({
    id,
    type: "chatgpt",
    configuration: {
      workspaceId,
      apiKeyPath,
      ...(credentialTtlSeconds === undefined
        ? {}
        : { credentialTtlSeconds: credentialTtlSeconds as number }),
    },
    drivers: { service_account: serviceAccount },
  });
}

/** Matches the gRPC client: a bare host:port, or an origin without credentials or path. */
function validGatewayEndpoint(value: unknown): boolean {
  if (!isNonEmptyString(value) || /\s/.test(value)) {
    return false;
  }
  if (!value.includes("://")) {
    return /^[^/:]+:[0-9]{1,5}$/.test(value);
  }
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

/** Upper bound for one OpenShell RPC deadline; it bounds late credential-provider creates. */
export const OPENSHELL_MAX_REQUEST_TIMEOUT_MS = 30_000;

function validateOpenShellBackend(
  id: string,
  configuration: Readonly<Record<string, unknown>>,
  drivers: Readonly<Record<string, unknown>>,
): OpenShellBackendDefinition {
  const allowed = [
    "endpoint",
    "scheme",
    "serviceName",
    "port",
    "auth",
    "requestTimeoutMs",
    "rootCertificatePath",
    "insecureTransport",
    "operatorTls",
  ];
  for (const key of Object.keys(configuration)) {
    if (!allowed.includes(key)) {
      throw new ScopeViolationError(path(id, `configuration.${key}`) + " is unsupported.");
    }
  }
  const { endpoint, scheme, serviceName, port, requestTimeoutMs, rootCertificatePath } =
    configuration;
  if (endpoint !== undefined && !validGatewayEndpoint(endpoint)) {
    throw new ScopeViolationError(
      path(id, "configuration.endpoint") + " must be host:port or an http or https origin.",
    );
  }
  if (endpoint === undefined && !isNonEmptyString(serviceName)) {
    throw new ScopeViolationError(path(id, "configuration") + " requires endpoint or serviceName.");
  }
  if (serviceName !== undefined && !isNonEmptyString(serviceName)) {
    throw new ScopeViolationError(path(id, "configuration.serviceName") + " is invalid.");
  }
  if (scheme !== undefined && scheme !== "http" && scheme !== "https") {
    throw new ScopeViolationError(path(id, "configuration.scheme") + " must be http or https.");
  }
  if (
    port !== undefined &&
    (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65535)
  ) {
    throw new ScopeViolationError(path(id, "configuration.port") + " is invalid.");
  }
  // Credential registration fences late gateway creates by this bound; see the OCC core.
  if (
    requestTimeoutMs !== undefined &&
    (!Number.isSafeInteger(requestTimeoutMs) ||
      (requestTimeoutMs as number) < 1000 ||
      (requestTimeoutMs as number) > OPENSHELL_MAX_REQUEST_TIMEOUT_MS)
  ) {
    throw new ScopeViolationError(
      path(id, "configuration.requestTimeoutMs") +
        ` must be between 1000 and ${OPENSHELL_MAX_REQUEST_TIMEOUT_MS} ms.`,
    );
  }
  if (
    rootCertificatePath !== undefined &&
    (!isNonEmptyString(rootCertificatePath) || !isAbsolute(rootCertificatePath))
  ) {
    throw new ScopeViolationError(
      path(id, "configuration.rootCertificatePath") + " must be an absolute file path.",
    );
  }
  const authRecord = configuration.auth === undefined ? undefined : asRecord(configuration.auth);
  if (configuration.auth !== undefined && authRecord === undefined) {
    throw new ScopeViolationError(path(id, "configuration.auth") + " must be one object.");
  }
  let auth: OpenShellBackendDefinition["configuration"]["auth"];
  if (authRecord !== undefined) {
    if (authRecord.mode === "unauthenticated" && Object.keys(authRecord).length === 1) {
      auth = { mode: "unauthenticated" };
    } else if (
      authRecord.mode === "bearerTokenFile" &&
      Object.keys(authRecord).length === 2 &&
      isNonEmptyString(authRecord.path) &&
      isAbsolute(authRecord.path)
    ) {
      auth = { mode: "bearerTokenFile", path: authRecord.path };
    } else {
      throw new ScopeViolationError(
        path(id, "configuration.auth") +
          " must be unauthenticated or bearerTokenFile with an absolute path.",
      );
    }
  }
  // Registration sends resolved credentials to the gateway. Plain or unauthenticated transport
  // requires an explicit statement that NetworkPolicy isolates the gateway inside the cluster.
  const insecureTransport = configuration.insecureTransport;
  if (insecureTransport !== undefined && insecureTransport !== "network-policy") {
    throw new ScopeViolationError(
      path(id, "configuration.insecureTransport") + " must be network-policy.",
    );
  }
  const tls =
    endpoint === undefined
      ? (scheme ?? (rootCertificatePath === undefined ? "http" : "https")) === "https"
      : (endpoint as string).startsWith("https://");
  let operatorTls: OpenShellBackendDefinition["configuration"]["operatorTls"];
  if (configuration.operatorTls !== undefined) {
    const record = asRecord(configuration.operatorTls);
    if (
      record === undefined ||
      Object.keys(record).length !== 2 ||
      !isNonEmptyString(record.certificatePath) ||
      !isAbsolute(record.certificatePath) ||
      !isNonEmptyString(record.privateKeyPath) ||
      !isAbsolute(record.privateKeyPath)
    ) {
      throw new ScopeViolationError(
        path(id, "configuration.operatorTls") +
          " requires absolute certificatePath and privateKeyPath file paths.",
      );
    }
    if (!tls) {
      throw new ScopeViolationError(
        path(id, "configuration.operatorTls") + " requires a direct HTTPS gateway endpoint.",
      );
    }
    operatorTls = {
      certificatePath: record.certificatePath,
      privateKeyPath: record.privateKeyPath,
    };
  }
  const protectedTransport = tls && auth?.mode === "bearerTokenFile";
  if (!protectedTransport && insecureTransport === undefined) {
    throw new ScopeViolationError(
      path(id, "configuration") +
        " requires TLS with bearerTokenFile authentication, or insecureTransport: network-policy.",
    );
  }
  if (protectedTransport && insecureTransport !== undefined) {
    throw new ScopeViolationError(
      path(id, "configuration.insecureTransport") + " is only for unprotected transport.",
    );
  }
  for (const key of Object.keys(drivers)) {
    if (key !== "sandbox" && key !== "credential_gateway" && key !== "credential_refresh") {
      throw new ScopeViolationError(path(id, `drivers.${key}`) + " is unsupported.");
    }
  }
  if (!isNonEmptyString(drivers.sandbox) || !isNonEmptyString(drivers.credential_gateway)) {
    throw new ScopeViolationError(
      path(id, "drivers") + " requires sandbox and credential_gateway members.",
    );
  }
  if (drivers.credential_refresh !== undefined && !isNonEmptyString(drivers.credential_refresh)) {
    throw new ScopeViolationError(path(id, "drivers.credential_refresh") + " must be a Driver ID.");
  }
  return deepFreeze({
    id,
    type: "openshell",
    configuration: {
      ...(endpoint === undefined ? {} : { endpoint: endpoint as string }),
      ...(scheme === undefined ? {} : { scheme: scheme as "http" | "https" }),
      ...(serviceName === undefined ? {} : { serviceName: serviceName as string }),
      ...(port === undefined ? {} : { port: port as number }),
      ...(auth === undefined ? {} : { auth }),
      ...(operatorTls === undefined ? {} : { operatorTls }),
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs: requestTimeoutMs as number }),
      ...(rootCertificatePath === undefined
        ? {}
        : { rootCertificatePath: rootCertificatePath as string }),
      ...(insecureTransport === undefined ? {} : { insecureTransport }),
    },
    drivers: {
      sandbox: drivers.sandbox,
      credential_gateway: drivers.credential_gateway,
      ...(drivers.credential_refresh === undefined
        ? {}
        : { credential_refresh: drivers.credential_refresh as string }),
    },
  });
}

function backendMembers(backend: BackendDefinition): readonly string[] {
  if (backend.type === "chatgpt") {
    return [`service_account:${backend.drivers.service_account}`];
  }
  if (backend.type === "github") {
    return [`repo:${backend.drivers.repo}`];
  }
  return [
    `sandbox:${backend.drivers.sandbox}`,
    `credential_gateway:${backend.drivers.credential_gateway}`,
    ...(backend.drivers.credential_refresh === undefined
      ? []
      : [`credential_refresh:${backend.drivers.credential_refresh}`]),
  ];
}

export function validateBackendDefinitions(value: unknown = []): readonly BackendDefinition[] {
  if (!Array.isArray(value)) {
    throw new ScopeViolationError("backend must be an array.");
  }
  const backends = value.map((entry, index) => validateBackendDefinition(entry, index));
  const ids = new Set<string>();
  const members = new Set<string>();
  for (const backend of backends) {
    if (ids.has(backend.id)) {
      throw new ScopeViolationError("Backend IDs must be unique.");
    }
    ids.add(backend.id);
    for (const member of backendMembers(backend)) {
      if (members.has(member)) {
        throw new ScopeViolationError("A Driver cannot belong to multiple Backends.");
      }
      members.add(member);
    }
  }
  if (backends.filter((backend) => backend.type === "chatgpt").length > 1) {
    throw new ScopeViolationError("Only one bundled ChatGPT Backend can be configured.");
  }
  if (backends.filter((backend) => backend.type === "github").length > 1) {
    throw new ScopeViolationError("Only one bundled GitHub Backend can be configured.");
  }
  if (backends.filter((backend) => backend.type === "openshell").length > 1) {
    throw new ScopeViolationError("Only one bundled OpenShell Backend can be configured.");
  }
  return Object.freeze(backends);
}

export function backendDefinitionMap(backends: readonly BackendDefinition[]): BackendMap {
  return new Map(validateBackendDefinitions(backends).map((backend) => [backend.id, backend]));
}

export function assertConfiguredBackend(
  backends: BackendMap,
  value: string | null,
  label = "Backend",
): BackendDefinition | undefined {
  if (value === null) {
    return undefined;
  }
  const id = backendId(value, label);
  const backend = backends.get(id);
  if (backend === undefined) {
    throw new ScopeViolationError(`${label} does not match a configured Backend.`);
  }
  return backend;
}

export function validateSelectedBackendDrivers(
  backends: readonly BackendDefinition[],
  selected: Readonly<Partial<Record<DriverCapability, Driver>>>,
): void {
  const requires = (capability: DriverCapability, id: string, label: string): void => {
    const driver = selected[capability];
    if (driver?.capability !== capability || driver.id !== id) {
      throw new DriverSelectionError(`The configured Backend requires its ${label}.`);
    }
  };
  for (const backend of backends) {
    if (backend.type === "github") {
      requires("repo", backend.drivers.repo, "repository credential Driver");
    } else if (backend.type === "chatgpt") {
      requires("service_account", backend.drivers.service_account, "ServiceAccount Driver");
    } else {
      requires("sandbox", backend.drivers.sandbox, "Sandbox Driver");
      requires(
        "credential_gateway",
        backend.drivers.credential_gateway,
        "Credential Gateway Driver",
      );
      if (backend.drivers.credential_refresh !== undefined) {
        requires(
          "credential_refresh",
          backend.drivers.credential_refresh,
          "Credential Refresh Driver",
        );
      }
    }
  }
  // Refresh state lives with the gateway's source record, so the two roles share one Backend.
  const refresh = selected.credential_refresh;
  if (
    refresh !== undefined &&
    !backends.some((backend) =>
      backendMembers(backend).includes(`credential_refresh:${refresh.id}`),
    )
  ) {
    throw new DriverSelectionError(
      "The selected Credential Refresh Driver must belong to the Credential Gateway's Backend.",
    );
  }
  const gateway = selected.credential_gateway;
  if (
    gateway !== undefined &&
    !backends.some((backend) =>
      backendMembers(backend).includes(`credential_gateway:${gateway.id}`),
    )
  ) {
    throw new DriverSelectionError(
      "The selected Credential Gateway Driver must belong to a configured Backend.",
    );
  }
}

export function validateServiceAccountBackendBinding(
  backends: BackendMap,
  backendIdValue: string | null,
  binding:
    | Readonly<{
        readonly backendId: string;
        readonly driverId: string;
        readonly workspaceId: string;
        readonly credentialIssued: boolean;
      }>
    | undefined,
): void {
  const backend = assertConfiguredBackend(backends, backendIdValue, "Agent Backend");
  if (backend === undefined || backend.type !== "chatgpt" || binding === undefined) {
    throw new ResourceConflictError(
      "The managed ServiceAccount credential has no Backend binding.",
    );
  }
  if (
    binding.backendId !== backend.id ||
    binding.driverId !== backend.drivers.service_account ||
    binding.workspaceId !== backend.configuration.workspaceId ||
    !binding.credentialIssued
  ) {
    throw new ResourceConflictError(
      "The managed ServiceAccount credential does not match its Backend.",
    );
  }
}
