#!/usr/bin/env node
// Moves the tenants of a released single-cluster Installation with split-layout Gateway
// namespaces across an upgrade: `export` them through OCC, `discard` them on the old release,
// upgrade, then `import` them.
// See docs/guides/deploy/split-layout-upgrade.md.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, realpathSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Resource = Record<string, unknown>;
type Tenant = {
  id: string;
  name: string;
  secrets: { id: string; name: string }[];
  credentialSources: Resource[];
  configurations: Resource[];
  presets: Resource[];
  roles: Resource[];
  accessBindings: Resource[];
  serviceAccounts: { id: string; name: string }[];
  agents: (Resource & { workspaceFiles: Record<string, string>; unreadWorkspaceFiles: string[] })[];
};
type Bundle = { format: string; namespaces: unknown[] };
type ExportBundle = { format: string; exportedAt: string; namespaces: Tenant[] };
type LogOptions = { log?: (line: string) => void };
type WaitOptions = {
  timeoutMs: number;
  intervalMs: number;
  sleep: (ms: number) => Promise<unknown>;
};
type DiscardOptions = LogOptions & Partial<WaitOptions> & { allowUnreadWorkspaceFiles?: boolean };
type ImportOptions = LogOptions &
  Partial<WaitOptions> & {
    state?: unknown;
    save?: (state: unknown) => void;
    deploy?: boolean;
    names?: Record<string, string>;
    skip?: unknown[];
    readyTimeoutMs?: number;
  };
type CliOptions = {
  command: string | undefined;
  names: Record<string, string>;
  skip: string[];
  out?: string;
  bundle?: string;
  "secret-values"?: string;
  map?: string;
  yes?: boolean;
  "no-deploy"?: boolean;
  "allow-unread-workspace-files"?: boolean;
};
type ApiResult = {
  status: number;
  data: unknown;
  error: unknown;
  envelope: unknown;
};
type Api = ReturnType<typeof createOccApi>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const retainInputs = "Keep the original bundle and map, if present.";
const resumeOperation = "reconcile any earlier writes before resuming the original operation.";
const recoverOcc = `${retainInputs} Correct the OCC endpoint and ${resumeOperation}`;
const recoverInput = `${retainInputs} Correct the indicated input and ${resumeOperation}`;
const refusalStatuses: Record<string, number> = {
  INVALID_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  RESOURCE_CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
};

function boundedString(value: unknown, minimum: number, maximum: number): value is string {
  return (
    typeof value === "string" &&
    Array.from(value).length >= minimum &&
    Array.from(value).length <= maximum
  );
}

function hasOnlyKeys(value: unknown, keys: readonly string[]): value is Resource {
  return (
    isRecord(value) &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function validResponseMeta(envelope: Resource): boolean {
  const meta = envelope.meta;
  return (
    hasOnlyKeys(meta, ["requestId"]) &&
    typeof meta.requestId === "string" &&
    new RegExp(`^req_${uuidV4}$`, "u").test(meta.requestId)
  );
}

function validSuccessEnvelope(result: ApiResult): boolean {
  return (
    hasOnlyKeys(result.envelope, ["data", "meta"]) &&
    result.data !== undefined &&
    validResponseMeta(result.envelope)
  );
}

function validErrorEnvelope(
  result: ApiResult,
): result is ApiResult & { error: { code: string; message: string } } {
  const { error, envelope } = result;
  if (
    !hasOnlyKeys(envelope, ["error", "meta"]) ||
    !validResponseMeta(envelope) ||
    !hasOnlyKeys(error, ["code", "message", "details", "remainingResources"]) ||
    typeof error.code !== "string" ||
    !boundedString(error.message, 1, 256)
  ) {
    return false;
  }
  if (
    error.details !== undefined &&
    (!Array.isArray(error.details) ||
      error.details.length > 32 ||
      !error.details.every(
        (detail: unknown) =>
          hasOnlyKeys(detail, ["code", "path", "message"]) &&
          boundedString(detail.path, 0, 512) &&
          /^(?:\/(?:[^~/]|~0|~1)*)*$/u.test(detail.path) &&
          typeof detail.code === "string" &&
          [
            "REQUIRED",
            "UNKNOWN_FIELD",
            "INVALID_TYPE",
            "INVALID_FORMAT",
            "INVALID_VALUE",
            "TOO_LONG",
            "TOO_DEEP",
            "INVALID_RANGE",
            "OUTSIDE_CEILING",
          ].includes(detail.code) &&
          (detail.message === undefined || boundedString(detail.message, 0, 512)),
      ))
  ) {
    return false;
  }
  return (
    error.remainingResources === undefined ||
    (error.code === "NAMESPACE_NOT_EMPTY" &&
      Array.isArray(error.remainingResources) &&
      error.remainingResources.length <= 7 &&
      error.remainingResources.every(
        (item: unknown) =>
          hasOnlyKeys(item, ["kind", "count", "ids"]) &&
          boundedString(item.kind, 1, 64) &&
          Number.isInteger(item.count) &&
          Number(item.count) >= 0 &&
          Array.isArray(item.ids) &&
          item.ids.length <= 20 &&
          item.ids.every((id: unknown) => boundedString(id, 1, 200)),
      ))
  );
}

function definitiveRefusal(
  result: ApiResult,
  method: string,
  path: string,
): result is ApiResult & { error: { code: string; message: string } } {
  if (!validErrorEnvelope(result)) {
    return false;
  }
  const code = result.error.code;
  if (refusalStatuses[code] === result.status) {
    return true;
  }
  const deploy = method === "POST" && /^\/namespaces\/[^/]+\/agents\/[^/]+\/deploy$/u.test(path);
  if (
    [
      "CHANNEL_CREDENTIAL_ROLE_MISMATCH",
      "CHANNEL_CREDENTIAL_CREDENTIALS_REJECTED",
      "CHANNEL_CREDENTIAL_BINDING_REQUIRED",
    ].includes(code)
  ) {
    return (
      result.status === 400 &&
      (deploy || (method === "POST" && /^\/namespaces\/[^/]+\/configurations$/u.test(path)))
    );
  }
  if (result.status !== 409) {
    return false;
  }
  if (["REPOSITORY_GIT_PROFILE_UNSUPPORTED", "REPOSITORY_GIT_SENDER_UNQUALIFIED"].includes(code)) {
    return deploy;
  }
  if (code === "SANDBOX_POLICY_PROTECTED_EXECUTION") {
    return deploy || (method === "POST" && /^\/namespaces\/[^/]+\/agents$/u.test(path));
  }
  if (code === "NAMESPACE_NOT_EMPTY") {
    return method === "DELETE" && /^\/namespaces\/[^/]+$/u.test(path);
  }
  if (code === "NAMESPACE_NOT_READY") {
    return /^\/namespaces\/[^/]+\//u.test(path);
  }
  if (code === "AGENT_DELETING") {
    return /^\/namespaces\/[^/]+\/agents\//u.test(path);
  }
  if (code === "CREDENTIAL_GATEWAY_NOT_CONFIGURED") {
    return method === "POST" && path.endsWith("/credential-sources");
  }
  if (["CREDENTIAL_WITHDRAWAL_IN_PROGRESS", "CREDENTIAL_TOKEN_UNSETTLED"].includes(code)) {
    return method === "DELETE" && /^\/namespaces\/[^/]+\/credential-sources\/[^/]+$/u.test(path);
  }
  return (
    code === "SERVICE_ACCOUNT_DRIVER_NOT_CONFIGURED" &&
    (deploy || /^\/namespaces\/[^/]+\/service-accounts(?:\/[^/]+)?$/u.test(path))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function requireRecord(value: unknown, location: string, recovery = recoverInput): Resource {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new InvalidMigrationDataError(`${location}; expected an object. ${recovery}`);
  }
  return value;
}

function requireArray(value: unknown, location: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new InvalidMigrationDataError(`${location}; expected an array. ${recoverInput}`);
  }
  return value;
}

function* bundleRecords(namespace: Resource, field: string) {
  const location = `bundle namespaces[].${field}`;
  for (const [index, item] of requireArray(namespace[field], location).entries()) {
    yield requireRecord(item, `${location}[${index}]`);
  }
}

// These are the owning route parameter formats, including opaque IAM IDs.
const uuidV4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const resourcePrefixes: Record<string, string> = {
  namespaces: "ns_",
  agents: "agt_",
  configurations: "cfg_",
  presets: "pre_",
  secrets: "sec_",
  credentialSources: "cs_",
  serviceAccounts: "sa_",
  revisions: "rev_",
};

function validOpaqueId(value: unknown): value is string {
  return boundedString(value, 1, 200) && !value.includes("\0") && !/\p{Cs}/u.test(value);
}

function requireResourceId(
  value: unknown,
  kind: string,
  location: string,
  recovery = recoverInput,
): string {
  const prefix = resourcePrefixes[kind];
  const valid =
    typeof value === "string" &&
    (prefix === undefined
      ? validOpaqueId(value)
      : new RegExp(`^${prefix}${uuidV4}$`, "u").test(value));
  if (!valid) {
    throw new InvalidMigrationDataError(`${location}: invalid resource ID. ${recovery}`);
  }
  return value;
}

function readNamespaces(bundle: Bundle): Resource[] {
  const ids = new Set<string>();
  return bundle.namespaces.map((value, index) => {
    const location = `bundle namespaces[${index}]`;
    const namespace = requireRecord(value, location);
    const id = requireResourceId(namespace.id, "namespaces", `${location}.id`);
    if (ids.has(id)) {
      throw new InvalidMigrationDataError(
        `bundle contains a duplicate Namespace ID. ${recoverInput}`,
      );
    }
    ids.add(id);
    return namespace;
  });
}

function validateTenant(namespace: Resource) {
  const requireString = (value: unknown, location: string) => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new InvalidMigrationDataError(
        `${location}: expected a nonempty string. ${recoverInput}`,
      );
    }
  };
  requireResourceId(namespace.id, "namespaces", "bundle Namespace id");
  requireString(namespace.name, "bundle Namespace name");
  for (const field of [
    "agents",
    "configurations",
    "presets",
    "secrets",
    "credentialSources",
    "serviceAccounts",
    "roles",
    "accessBindings",
  ]) {
    for (const resource of bundleRecords(namespace, field)) {
      const location = `bundle namespaces[].${field}[]`;
      requireResourceId(resource.id, field, `${location}.id`);
      if ("configurationReadError" in resource) {
        throw new InvalidMigrationDataError(
          `${location}: saved configuration is unreadable. ${recoverInput}`,
        );
      }
      if (
        ["agents", "presets", "secrets", "credentialSources", "serviceAccounts"].includes(field)
      ) {
        requireString(resource.name, `${location}.name`);
      }
      if (field === "agents") {
        requireResourceId(
          resource.configurationId,
          "configurations",
          `${location}.configurationId`,
        );
        if (resource.servicePrincipalId !== undefined) {
          requireResourceId(
            resource.servicePrincipalId,
            "servicePrincipalId",
            `${location}.servicePrincipalId`,
          );
        }
      } else if (field === "configurations") {
        requireString(resource.kind, `${location}.kind`);
        requireRecord(resource.values, `${location}.values`);
      } else if (field === "presets") {
        requireRecord(resource.template, `${location}.template`);
      } else if (field === "credentialSources") {
        requireString(resource.type, `${location}.type`);
      } else if (field === "roles") {
        const permissions = requireArray(resource.permissions, `${location}.permissions`);
        if (permissions.length === 0 || permissions.length > 64) {
          throw new InvalidMigrationDataError(
            `${location}.permissions: expected 1 to 64 permissions. ${recoverInput}`,
          );
        }
        for (const [index, value] of permissions.entries()) {
          const permissionLocation = `${location}.permissions[${index}]`;
          const permission = requireRecord(value, permissionLocation);
          requireString(permission.action, `${permissionLocation}.action`);
          requireString(permission.resourceKind, `${permissionLocation}.resourceKind`);
        }
      } else if (field === "accessBindings") {
        requireString(resource.subjectKind, `${location}.subjectKind`);
        for (const key of ["subjectId", "roleId"]) {
          requireResourceId(resource[key], key, `${location}.${key}`);
        }
        if (
          resource.resourceId !== undefined ||
          BINDING_RESOURCE_KINDS.includes(resource.resourceKind)
        ) {
          requireResourceId(resource.resourceId, "resourceId", `${location}.resourceId`);
        }
      }
    }
  }
}

function identity(value: Resource, path: string): { id: string; name: string } {
  const { id, name } = value;
  if (typeof id !== "string" || typeof name !== "string") {
    throw new InvalidMigrationDataError(
      `GET ${path.slice(0, 240)}: invalid OCC resource; expected string id and name fields. ${recoverOcc}`,
    );
  }
  return { id, name };
}

function isBundle(value: unknown): value is Bundle {
  return isRecord(value) && value.format === BUNDLE_FORMAT && Array.isArray(value.namespaces);
}

export const BUNDLE_FORMAT = "oce-split-layout-tenants/v1";
export const WORKSPACE_FILE_NAMES = Object.freeze([
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
]);
// Access-binding resource kinds the current API accepts (Agent revisions are not carried over).
const BINDING_RESOURCE_KINDS: readonly unknown[] = Object.freeze([
  "namespace",
  "agent",
  "configuration",
  "credential_source",
  "preset",
  "secret",
  "service_account",
]);
const AGENT_FIELDS = Object.freeze([
  "name",
  "configurationId",
  "backendId",
  "executionMode",
  "harnessAuth",
  "plugins",
  "pluginApprovers",
  "credentialSources",
]);

/**
 * The release's managed ChatGPT method became `codex_pat` with a service-account source
 * (#1648). Other bindings pass through unchanged.
 */
export function currentHarnessAuth(harnessAuth: unknown, namespaceId: unknown) {
  if (!isRecord(harnessAuth) || harnessAuth.method !== "chatgpt_service_account") {
    return harnessAuth;
  }
  return {
    method: "codex_pat",
    source: { kind: "service_account", namespaceId, id: harnessAuth.serviceAccountId },
  };
}

const usage = `Usage:
  node scripts/split-layout-tenants.ts export --out FILE
  node scripts/split-layout-tenants.ts discard --bundle FILE --yes [--allow-unread-workspace-files]
  node scripts/split-layout-tenants.ts import --bundle FILE --secret-values FILE --map FILE
      [--rename OLD=NEW]... [--skip NAME]... [--no-deploy]
Environment: OCC_URL, OCC_SERVICE_KEY_FILE, optional OCC_CA_BUNDLE.`;

export class SplitLayoutError extends Error {}
class InvalidMigrationDataError extends SplitLayoutError {}
class OccRefusalError extends SplitLayoutError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** An OCC API client over a fetch function. `fetchImpl(url, init)` returns a Response. */
export function createOccApi({
  baseUrl,
  headers = {},
  fetchImpl = fetch,
}: {
  baseUrl: string | URL;
  headers?: Record<string, string>;
  fetchImpl?: Fetch;
}) {
  async function call(method: string, path: string, body?: unknown): Promise<ApiResult> {
    const init: RequestInit & { headers: Record<string, string> } = {
      method,
      redirect: "manual",
      headers: { ...headers },
    };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetchImpl(new URL(path, baseUrl).toString(), init);
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text === "" ? {} : JSON.parse(text);
    } catch {
      payload = {};
    }
    const envelope = isRecord(payload) ? payload : undefined;
    return {
      status: response.status,
      data: envelope?.data,
      error: envelope?.error,
      envelope: payload,
    };
  }
  async function expect(
    method: string,
    path: string,
    body?: unknown,
    accepted = [method === "POST" ? 201 : 200],
  ) {
    const result = await call(method, path, body);
    const refusal = definitiveRefusal(result, method, path);
    if (!accepted.includes(result.status) || (result.status >= 400 && !refusal)) {
      if (!refusal) {
        throw new InvalidMigrationDataError(
          `${method} ${path.slice(0, 240)}: ambiguous HTTP ${result.status} response. ${recoverOcc}`,
        );
      }
      const error = result.error;
      throw new OccRefusalError(
        error.code,
        `${method} ${path}: HTTP ${result.status} ${error.code} ${error.message}`,
      );
    }
    if (
      result.status >= 200 &&
      result.status < 300 &&
      result.status !== 204 &&
      result.data === undefined
    ) {
      throw new InvalidMigrationDataError(
        `${method} ${path.slice(0, 240)}: HTTP ${result.status} returned no data envelope. ${recoverOcc}`,
      );
    }
    if (
      result.status >= 200 &&
      result.status < 300 &&
      result.status !== 204 &&
      !validSuccessEnvelope(result)
    ) {
      throw new InvalidMigrationDataError(
        `${method} ${path.slice(0, 240)}: HTTP ${result.status} returned an invalid success envelope. ${recoverOcc}`,
      );
    }
    if (method === "DELETE" && result.status === 202) {
      responseId(
        requireRecord(result.data, `${method} ${path}: invalid OCC response data`, recoverOcc),
        `${method} ${path}`,
      );
    }
    return result;
  }
  return { call, expect };
}

const ns = (id: unknown) => `/namespaces/${encodeURIComponent(String(id))}`;
const list = async (api: Api, path: string): Promise<Resource[]> => {
  const { data } = await api.expect("GET", path);
  if (!Array.isArray(data)) {
    throw new SplitLayoutError(
      `GET ${path.slice(0, 240)}: invalid OCC collection response; expected an array in data. ${recoverOcc}`,
    );
  }
  const items: unknown[] = data;
  return items.map((item, index) => {
    if (!isRecord(item) || Array.isArray(item)) {
      throw new InvalidMigrationDataError(
        `GET ${path.slice(0, 240)}: invalid OCC collection response; expected an object in data[${index}]. ${recoverOcc}`,
      );
    }
    return item;
  });
};

async function readOccResource(api: Api, method: "GET" | "POST", path: string, body?: unknown) {
  const { data } = await api.expect(
    method,
    path,
    body,
    method === "POST" && path.endsWith("/deploy") ? [202] : undefined,
  );
  const resource = requireRecord(
    data,
    `${method} ${path.slice(0, 240)}: invalid OCC response data`,
    recoverOcc,
  );
  if ("configurationReadError" in resource) {
    throw new InvalidMigrationDataError(
      `${method} ${path.slice(0, 240)}: saved configuration is unreadable. ${recoverOcc}`,
    );
  }
  responseId(resource, `${method} ${path}`);
  if (
    method === "POST" &&
    isRecord(body) &&
    body.name !== undefined &&
    resource.name !== body.name
  ) {
    throw new InvalidMigrationDataError(
      `${method} ${path}: returned resource name does not match the request. ${recoverOcc}`,
    );
  }
  if (
    method === "POST" &&
    path.endsWith("/iam/access-bindings") &&
    isRecord(body) &&
    ["subjectKind", "subjectId", "roleId", "resourceKind", "resourceId"].some(
      (key) => resource[key] !== body[key],
    )
  ) {
    throw new InvalidMigrationDataError(
      `${method} ${path}: returned binding does not match the request. ${recoverOcc}`,
    );
  }
  return resource;
}

function responseId(resource: Resource, location: string, field = "id"): string {
  const value = resource[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidMigrationDataError(
      `${location.slice(0, 240)}: invalid OCC response data; expected a nonempty string in ${field}. ${recoverOcc}`,
    );
  }
  const path = location.slice(location.indexOf(" ") + 1);
  const parts = path.split("/").slice(1).map(decodeURIComponent);
  const kinds: Record<string, string> = {
    "credential-sources": "credentialSources",
    "service-accounts": "serviceAccounts",
    "access-bindings": "accessBindings",
  };
  const routeKind = parts[2] === "iam" ? parts[3] : parts[2];
  const deploy = parts[4] === "deploy";
  let kind = "namespaces";
  if (routeKind !== undefined) {
    kind = kinds[routeKind] ?? routeKind;
  }
  if (deploy) {
    kind = "revisions";
  }
  if (field !== "id") {
    kind = field;
  }
  requireResourceId(value, kind, `${location}: invalid OCC response ${field}`, recoverOcc);
  if (field === "id") {
    let exactId: string | undefined;
    if (location.startsWith("GET ") || location.startsWith("DELETE ")) {
      if (parts[2] === "iam") {
        exactId = parts[4];
      } else if (parts[2] === undefined) {
        exactId = parts[1];
      } else {
        exactId = parts[3];
      }
    }
    if (
      (exactId !== undefined && value !== exactId) ||
      (routeKind !== undefined && resource.namespaceId !== parts[1]) ||
      (deploy &&
        (resource.agentId !== parts[3] ||
          !Number.isInteger(resource.revision) ||
          Number(resource.revision) < 1))
    ) {
      throw new InvalidMigrationDataError(
        `${location}: returned resource identity does not match the request. ${recoverOcc}`,
      );
    }
  }
  return value;
}

/** Reads every Namespace's tenant resources into a bundle. Read-only. */
export async function exportTenants(
  api: Api,
  { log = () => {} }: LogOptions = {},
): Promise<ExportBundle> {
  const namespaces: Tenant[] = [];
  for (const namespace of await list(api, "/namespaces")) {
    const namespaceIdentity = identity(namespace, "/namespaces");
    const base = ns(namespaceIdentity.id);
    const agents = [];
    const configurationIds = new Set<unknown>();
    for (const listed of await list(api, `${base}/agents`)) {
      const agent = await readOccResource(api, "GET", `${base}/agents/${listed.id}`);
      configurationIds.add(agent.configurationId);
      const workspaceFiles: Record<string, string> = {};
      const unreadWorkspaceFiles = [];
      for (const name of WORKSPACE_FILE_NAMES) {
        const path = `${base}/agents/${agent.id}/workspace/files/${name}`;
        const file = await api.call("GET", path);
        const data = file.data;
        const isWellFormed = (
          String.prototype as unknown as { isWellFormed: (this: string) => boolean }
        ).isWellFormed;
        if (
          file.status === 200 &&
          validSuccessEnvelope(file) &&
          hasOnlyKeys(data, ["name", "content"]) &&
          data.name === name &&
          typeof data.content === "string" &&
          isWellFormed.call(data.content) &&
          !data.content.includes("\0") &&
          Buffer.byteLength(data.content, "utf8") <= 16 * 1024
        ) {
          workspaceFiles[name] = data.content;
        } else if (!(
          file.status === 404 &&
          definitiveRefusal(file, "GET", path) &&
          file.error.code === "NOT_FOUND"
        )) {
          // Only a verified missing-file response proves absence. Unknown responses
          // remain unread, so discard still requires an explicit recovery decision.
          unreadWorkspaceFiles.push(`${name} (HTTP ${file.status})`);
        }
      }
      if (unreadWorkspaceFiles.length > 0) {
        log(
          `could not read workspace files of Agent ${namespace.name}/${agent.name}: ` +
            `${unreadWorkspaceFiles.join(", ")}; deploy it and export again to keep them`,
        );
      }
      agents.push({ ...agent, workspaceFiles, unreadWorkspaceFiles });
    }
    const configurations = [];
    for (const id of configurationIds) {
      configurations.push(await readOccResource(api, "GET", `${base}/configurations/${id}`));
    }
    // The Preset list carries summaries; each template is on the exact Preset read.
    const presets = [];
    for (const { id } of await list(api, `${base}/presets`)) {
      const path = `${base}/presets/${encodeURIComponent(String(id))}`;
      presets.push(await readOccResource(api, "GET", path));
    }
    const tenant: Tenant = {
      ...namespaceIdentity,
      secrets: (await list(api, `${base}/secrets`)).map((secret) =>
        identity(secret, `${base}/secrets`),
      ),
      credentialSources: await list(api, `${base}/credential-sources`),
      configurations,
      presets,
      roles: await list(api, `${base}/iam/roles`),
      accessBindings: await list(api, `${base}/iam/access-bindings`),
      serviceAccounts: (await list(api, `${base}/service-accounts`)).map((account) =>
        identity(account, `${base}/service-accounts`),
      ),
      agents,
    };
    validateTenant(tenant);
    namespaces.push(tenant);
    log(
      `exported ${namespace.name} (${namespace.id}): ${agents.length} Agents, ` +
        `${configurations.length} Configurations, ${tenant.secrets.length} Secrets`,
    );
  }
  const bundle = { format: BUNDLE_FORMAT, exportedAt: new Date().toISOString(), namespaces };
  readNamespaces(bundle);
  return bundle;
}

function mappedResourceKinds(namespaces: Resource[]) {
  const mappedKinds = new Map<unknown, { kind: string; namespaceId: unknown }>();
  const registerIdentity = (id: unknown, kind: string, namespaceId: unknown) => {
    const previous = mappedKinds.get(id);
    if (previous && (previous.kind !== kind || previous.namespaceId !== namespaceId)) {
      throw new InvalidMigrationDataError(
        `Bundle source IDs overlap across resource kinds or Namespaces; the ID map cannot represent both identities. ${recoverInput}`,
      );
    }
    mappedKinds.set(id, { kind, namespaceId });
  };
  for (const namespace of namespaces) {
    registerIdentity(namespace.id, "namespaces", namespace.id);
  }
  for (const namespace of namespaces) {
    for (const field of [
      "agents",
      "configurations",
      "presets",
      "secrets",
      "credentialSources",
      "serviceAccounts",
      "roles",
      "accessBindings",
    ]) {
      for (const resource of bundleRecords(namespace, field)) {
        registerIdentity(resource.id, field, namespace.id);
        if (field === "agents" && resource.servicePrincipalId !== undefined) {
          registerIdentity(resource.servicePrincipalId, "servicePrincipalId", namespace.id);
        }
      }
    }
  }
  return mappedKinds;
}

function readPrivateJson(path: string, label: string): unknown {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SplitLayoutError(`Invalid JSON in ${label}.`);
    }
    throw error;
  }
}

function readBundle(path: string): Bundle {
  const bundle = readPrivateJson(path, "bundle");
  if (!isBundle(bundle)) {
    throw new SplitLayoutError(`${path} is not a ${BUNDLE_FORMAT} bundle`);
  }
  return bundle;
}

async function waitUntil(
  check: () => Promise<boolean>,
  { timeoutMs, intervalMs, sleep }: WaitOptions,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(intervalMs);
  }
}

const defaultSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function deletionPath(base: string, route: string, id: unknown, location: string): string {
  let path: string | undefined;
  try {
    const encoded = encodeURIComponent(String(id));
    const candidate = `${base}/${route}/${encoded}`;
    const url = new URL(candidate, "http://127.0.0.1");
    if (
      url.pathname === candidate &&
      decodeURIComponent(url.pathname.split("/").at(-1) ?? "") === id
    ) {
      path = candidate;
    }
  } catch {
    // Malformed Unicode cannot be addressed; never include the private ID in diagnostics.
  }
  if (path === undefined) {
    throw new InvalidMigrationDataError(
      `${location}: resource ID cannot be addressed as one URL segment. ${recoverInput}`,
    );
  }
  return path;
}

/**
 * Deletes the bundle's tenants on the old release: Agents first, then the Namespace children,
 * then the Namespaces. Refuses when a Namespace holds an Agent or Secret the bundle lacks.
 */
export async function discardTenants(
  api: Api,
  bundle: Bundle,
  {
    log = () => {},
    allowUnreadWorkspaceFiles = false,
    timeoutMs = 600_000,
    intervalMs = 5_000,
    sleep = defaultSleep,
  }: DiscardOptions = {},
) {
  const namespaces = readNamespaces(bundle);
  const childRoutes = [
    ["iam/access-bindings", "accessBindings"],
    ["service-accounts", "serviceAccounts"],
    ["presets", "presets"],
    ["configurations", "configurations"],
    ["credential-sources", "credentialSources"],
    ["secrets", "secrets"],
    ["iam/roles", "roles"],
  ] as const;
  const deletionPlans = namespaces.map((namespace) => {
    validateTenant(namespace);
    const base = ns(namespace.id);
    const paths = (route: string, field: string) =>
      Array.from(bundleRecords(namespace, field), (resource) => ({
        resource,
        path: deletionPath(base, route, resource.id, `bundle namespaces[].${field}[].id`),
      }));
    return {
      namespace,
      base,
      agents: paths("agents", "agents"),
      children: childRoutes.flatMap(([route, field]) => paths(route, field)),
    };
  });
  mappedResourceKinds(namespaces);
  const unread = namespaces.flatMap((namespace) =>
    Array.from(bundleRecords(namespace, "agents"))
      .filter(
        (agent) =>
          requireArray(
            agent.unreadWorkspaceFiles ?? [],
            "bundle namespaces[].agents[].unreadWorkspaceFiles",
          ).length > 0,
      )
      .map((agent) => `${namespace.name}/${agent.name}`),
  );
  if (unread.length > 0 && !allowUnreadWorkspaceFiles) {
    throw new SplitLayoutError(
      `the bundle lacks workspace files of ${unread.join(", ")}; deploy those Agents and export ` +
        "again, or add --allow-unread-workspace-files to discard them",
    );
  }
  for (const namespace of namespaces) {
    const base = ns(namespace.id);
    const exported = new Set(
      [...bundleRecords(namespace, "agents"), ...bundleRecords(namespace, "secrets")].map(
        ({ id }) => id,
      ),
    );
    const live = [...(await list(api, `${base}/agents`)), ...(await list(api, `${base}/secrets`))];
    const missing = live.filter(({ id }) => !exported.has(id)).map(({ id }) => id);
    if (missing.length > 0) {
      throw new SplitLayoutError(
        `${namespace.name} has resources the bundle lacks (${missing.join(", ")}); export again`,
      );
    }
  }
  for (const { namespace, base, agents, children } of deletionPlans) {
    for (const { resource: agent, path } of agents) {
      await api.expect("DELETE", path, undefined, [202, 404]);
      log(`deleting Agent ${agent.name} (${agent.id})`);
    }
    const gone = await waitUntil(async () => (await list(api, `${base}/agents`)).length === 0, {
      timeoutMs,
      intervalMs,
      sleep,
    });
    if (!gone) {
      throw new SplitLayoutError(`${namespace.name}: Agents still present after ${timeoutMs} ms`);
    }
    for (const { path } of children) {
      await api.expect("DELETE", path, undefined, [204, 404]);
    }
    try {
      await api.expect("DELETE", base, undefined, [202, 404]);
    } catch (error) {
      if (!(error instanceof OccRefusalError) || error.code !== "NAMESPACE_NOT_EMPTY") {
        throw error;
      }
      throw new SplitLayoutError(
        `${namespace.name} (${namespace.id}) is not empty: ${error.message} ` +
          "A Configuration no Agent references is not exported and blocks the delete. Unless " +
          "the message names them, find them with `select id from occ.configurations where " +
          "namespace_id = '<id>'`, delete each with `occ configuration delete`, then run " +
          "discard again.",
      );
    }
    log(`deleting Namespace ${namespace.name} (${namespace.id})`);
  }
  const ids = new Set(namespaces.map(({ id }) => id));
  const cleared = await waitUntil(
    async () => (await list(api, "/namespaces")).every(({ id }) => !ids.has(id)),
    { timeoutMs, intervalMs, sleep },
  );
  if (!cleared) {
    throw new SplitLayoutError(`Namespaces still present after ${timeoutMs} ms`);
  }
}

/** Replaces every string equal to a mapped old ID, at any depth. */
export function remap(value: unknown, ids: ReadonlyMap<unknown, unknown>): unknown {
  if (typeof value === "string") {
    return ids.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => remap(item, ids));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item, ids)]));
  }
  return value;
}

function pick(source: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    fields
      .filter((field) => source[field] !== undefined && source[field] !== null)
      .map((field) => [field, source[field]]),
  );
}

function bindingKey(binding: Record<string, unknown>) {
  return [
    binding.subjectKind,
    binding.subjectId,
    binding.roleId,
    binding.resourceKind ?? "",
    binding.resourceId ?? "",
  ].join("\u0000");
}

function ownValue(mapping: unknown, key: unknown): unknown {
  if (!isRecord(mapping) || Array.isArray(mapping)) {
    return undefined;
  }
  const property = typeof key === "symbol" ? key : String(key);
  if (!Object.hasOwn(mapping, property)) {
    return undefined;
  }
  const value: unknown = Reflect.get(mapping, property);
  return value;
}

function secretValue(secretValues: unknown, namespaceName: unknown, secretName: unknown) {
  return ownValue(ownValue(secretValues, namespaceName), secretName);
}

/** Checks a bundle and its Secret values before anything is created. Returns the problems. */
export function checkImport(bundle: Bundle, secretValues: unknown) {
  const problems = [];
  for (const [index, namespace] of readNamespaces(bundle).entries()) {
    const location = `bundle namespaces[${index}]`;
    validateTenant(namespace);
    for (const secretValueEntry of requireArray(namespace.secrets, `${location}.secrets`)) {
      const secret = requireRecord(secretValueEntry, `${location}.secrets[]`);
      if (typeof secretValue(secretValues, namespace.name, secret.name) !== "string") {
        problems.push(`no value for Secret ${namespace.name}/${secret.name}`);
      }
    }
  }
  return problems;
}

/**
 * Re-creates the bundle's tenants on the new release. `state` maps old IDs to new ones and is
 * saved after every create through `save`, so a rerun with the same state resumes.
 */
export async function importTenants(
  api: Api,
  bundle: Bundle,
  secretValues: unknown,
  {
    state = { ids: {}, deployed: [] },
    save = () => {},
    deploy = true,
    log = () => {},
    names = {},
    skip = [],
    readyTimeoutMs = 20_000,
    intervalMs = 3_000,
    sleep = defaultSleep,
  }: ImportOptions = {},
) {
  // A deleted Namespace's name stays reserved, so the copies usually need new names.
  const allNamespaces = readNamespaces(bundle);
  const mappedKinds = mappedResourceKinds(allNamespaces);
  const namespaces = allNamespaces.filter(({ name }) => !skip.includes(name));
  const targetName = (namespace: Resource) => ownValue(names, namespace.name) ?? namespace.name;
  const problems = checkImport({ ...bundle, namespaces }, secretValues);
  if (problems.length > 0) {
    throw new SplitLayoutError(problems.join("\n"));
  }
  const importState = requireRecord(state, "ID map (--map)");
  const savedIds = requireRecord(importState.ids, "ID map (--map).ids");
  if (
    Object.entries(savedIds).some(([key, value]) => !validOpaqueId(key) || !validOpaqueId(value))
  ) {
    throw new InvalidMigrationDataError(
      `ID map (--map).ids: expected nonempty string values and keys of at most 200 code points. ${recoverInput}`,
    );
  }
  for (const [key, value] of Object.entries(savedIds)) {
    requireResourceId(value, mappedKinds.get(key)?.kind ?? "opaque", "ID map (--map).ids");
  }
  const ids = new Map<unknown, unknown>(Object.entries(savedIds));
  // Each source tenant must keep a separate destination, including on a resumed import.
  // Otherwise adopting an empty Namespace can silently merge tenants before any API conflict.
  const targets = new Map<unknown, unknown>();
  for (const namespace of namespaces) {
    const name = targetName(namespace);
    if (targets.has(name)) {
      throw new SplitLayoutError(
        `Namespaces ${targets.get(name)} and ${namespace.name} both target ${name}; ` +
          "use distinct --rename targets or --skip one Namespace",
      );
    }
    targets.set(name, namespace.name);
  }
  const record = (oldId: unknown, newId: string) => {
    ids.set(oldId, newId);
    importState.ids = Object.fromEntries(ids);
    save(state);
  };
  const pending = [];
  const failedDeploys: string[] = [];
  const skippedBindings: string[] = [];

  // Namespaces first: each needs its tenant RoleBindings before it becomes ready.
  const existing = await list(api, "/namespaces");
  const destinations = new Map<unknown, unknown>();
  const resolved: [Resource, unknown][] = [
    // A saved destination remains owned even when its source is skipped on this run.
    ...allNamespaces.map((namespace): [Resource, unknown] => [namespace, ids.get(namespace.id)]),
    ...namespaces
      .filter((namespace) => !ids.has(namespace.id))
      .map((namespace): [Resource, unknown] => [
        namespace,
        existing.find(({ name }) => name === targetName(namespace))?.id,
      ]),
  ];
  for (const [namespace, destination] of resolved) {
    if (destination === undefined) {
      continue;
    }
    if (destinations.has(destination)) {
      const name = existing.find(({ id }) => id === destination)?.name;
      throw new SplitLayoutError(
        `Namespaces ${destinations.get(destination)} and ${namespace.name} both resolve to ` +
          `Namespace ${destination}${name === undefined ? "" : ` (${name})`}; ` +
          "choose separate destinations and review the saved ID map",
      );
    }
    destinations.set(destination, namespace.name);
  }
  for (const namespace of namespaces) {
    if (ids.has(namespace.id)) {
      continue;
    }
    const name = targetName(namespace);
    const same = existing.find((live) => live.name === name);
    if (same !== undefined) {
      // Only an empty live Namespace is safe to fill: adopting a populated one would merge
      // the bundle into someone else's Secrets and Agents.
      const base = ns(same.id);
      const populated =
        (await list(api, `${base}/agents`)).length + (await list(api, `${base}/secrets`)).length;
      if (populated > 0) {
        throw new SplitLayoutError(
          `Namespace ${name} already exists and holds Agents or Secrets; ` +
            `add --rename '${namespace.name}=<new name>' or --skip '${namespace.name}'`,
        );
      }
    }
    let created = same;
    if (created === undefined) {
      try {
        created = await readOccResource(api, "POST", "/namespaces", { name });
      } catch (error) {
        if (!(error instanceof OccRefusalError) || error.code !== "RESOURCE_CONFLICT") {
          throw error;
        }
        throw new SplitLayoutError(
          `Namespace name ${name} is taken (${error.message}); ` +
            `add --rename '${namespace.name}=<new name>' or --skip '${namespace.name}'`,
        );
      }
    }
    const id = responseId(created, same ? "GET /namespaces" : "POST /namespaces");
    record(namespace.id, id);
    log(`${same ? "reusing" : "created"} Namespace ${name}: ${id}`);
  }
  // One short shared wait: a Namespace stays provisioning until its RoleBindings exist.
  const notReady = async () => {
    const waiting = [];
    for (const namespace of namespaces) {
      const id = ids.get(namespace.id);
      const data = await readOccResource(api, "GET", ns(id));
      const status = isRecord(data) ? data.status : undefined;
      if (status === "failed" || status === "deleting") {
        throw new SplitLayoutError(
          `Namespace ${id} is ${status}. ${retainInputs} Resolve its lifecycle state before resuming the import.`,
        );
      }
      if (status === "provisioning") {
        waiting.push(`${targetName(namespace)} (${id})`);
      } else if (status !== "ready") {
        throw new InvalidMigrationDataError(
          `GET ${ns(id)}: invalid Namespace status. ${recoverOcc}`,
        );
      }
    }
    return waiting;
  };
  await waitUntil(async () => (await notReady()).length === 0, {
    timeoutMs: readyTimeoutMs,
    intervalMs,
    sleep,
  });
  pending.push(...(await notReady()));
  if (pending.length > 0) {
    return { complete: false, pendingNamespaces: pending, failedDeploys, skippedBindings };
  }

  for (const namespace of namespaces) {
    const base = ns(ids.get(namespace.id));
    // A named item that already exists here was created by an interrupted earlier run
    // (or lives in a reused Namespace): adopt it rather than fail on its name.
    const create = async (
      oldId: unknown,
      kind: string,
      body: unknown,
      label: string,
      name?: unknown,
    ) => {
      if (ids.has(oldId)) {
        return ids.get(oldId);
      }
      const path = `${base}/${kind}`;
      const same =
        name === undefined ? undefined : (await list(api, path)).find((item) => item.name === name);
      if (same) {
        const id = responseId(same, `GET ${path}`);
        record(oldId, id);
        log(`reusing existing ${label}: ${id} (left unchanged)`);
        return id;
      }
      const data = await readOccResource(api, "POST", path, body);
      const id = responseId(data, `POST ${path}`);
      record(oldId, id);
      log(`created ${label}: ${id}`);
      return id;
    };
    for (const secret of bundleRecords(namespace, "secrets")) {
      await create(
        secret.id,
        "secrets",
        { name: secret.name, value: secretValue(secretValues, namespace.name, secret.name) },
        `Secret ${namespace.name}/${secret.name}`,
        secret.name,
      );
    }
    for (const source of bundleRecords(namespace, "credentialSources")) {
      await create(
        source.id,
        "credential-sources",
        remap(pick(source, ["name", "type", "config", "secrets"]), ids),
        `credential source ${namespace.name}/${source.name}`,
        source.name,
      );
    }
    // Configurations have no name to adopt by: a run interrupted between creating one and
    // saving its ID leaves an unused copy behind, which is harmless.
    for (const configuration of bundleRecords(namespace, "configurations")) {
      await create(
        configuration.id,
        "configurations",
        remap(pick(configuration, ["kind", "values", "secretBindings"]), ids),
        `Configuration ${namespace.name}/${configuration.id}`,
      );
    }
    // Preset Harness authentication can refer to these accounts; map them before templates.
    for (const account of bundleRecords(namespace, "serviceAccounts")) {
      await create(
        account.id,
        "service-accounts",
        { name: account.name },
        `service account ${namespace.name}/${account.name}`,
        account.name,
      );
    }
    for (const preset of bundleRecords(namespace, "presets")) {
      const template = structuredClone(preset.template);
      const templateAgent = isRecord(template) ? template.agent : undefined;
      if (isRecord(templateAgent) && templateAgent.harnessAuth !== undefined) {
        templateAgent.harnessAuth = currentHarnessAuth(templateAgent.harnessAuth, namespace.id);
      }
      await create(
        preset.id,
        "presets",
        remap({ name: preset.name, template }, ids),
        `Preset ${namespace.name}/${preset.name}`,
        preset.name,
      );
    }
    const liveRoles = await list(api, `${base}/iam/roles`);
    for (const role of bundleRecords(namespace, "roles")) {
      if (ids.has(role.id)) {
        continue;
      }
      const same =
        role.name === undefined ? undefined : liveRoles.find(({ name }) => name === role.name);
      if (same) {
        record(role.id, responseId(same, `GET ${base}/iam/roles`));
        continue;
      }
      await create(
        role.id,
        "iam/roles",
        pick(role, ["name", "permissions"]),
        `Role ${namespace.name}/${role.name ?? role.id}`,
      );
    }
    for (const agent of bundleRecords(namespace, "agents")) {
      if (ids.has(agent.id)) {
        if (agent.servicePrincipalId && !ids.has(agent.servicePrincipalId)) {
          const path = `${base}/agents/${ids.get(agent.id)}`;
          const data = await readOccResource(api, "GET", path);
          record(agent.servicePrincipalId, responseId(data, `GET ${path}`, "servicePrincipalId"));
        }
        continue;
      }
      const body = requireRecord(
        remap(
          {
            ...pick(agent, AGENT_FIELDS),
            harnessAuth: currentHarnessAuth(agent.harnessAuth, namespace.id),
          },
          ids,
        ),
        "remapped bundle namespaces[].agents[]",
      );
      if (body.harnessAuth === undefined || body.harnessAuth === null) {
        delete body.harnessAuth;
      }
      if (Array.isArray(agent.repositoryBindings) && agent.repositoryBindings.length > 0) {
        body.repositoryBindings = agent.repositoryBindings.map((binding: unknown) =>
          pick(requireRecord(binding, "bundle namespaces[].agents[].repositoryBindings[]"), [
            "repositoryRef",
            "profile",
          ]),
        );
      }
      const workspaceFiles = agent.workspaceFiles;
      if (
        workspaceFiles != null &&
        Object.keys(requireRecord(workspaceFiles, "bundle namespaces[].agents[].workspaceFiles"))
          .length > 0
      ) {
        body.initialWorkspaceFiles = workspaceFiles;
      }
      const same = (await list(api, `${base}/agents`)).find(({ name }) => name === agent.name);
      const method = same ? "GET" : "POST";
      const path = same ? `${base}/agents/${same.id}` : `${base}/agents`;
      const data = await readOccResource(api, method, path, same ? undefined : body);
      if (same && data.configurationId !== body.configurationId) {
        throw new SplitLayoutError(
          `Agent ${namespace.name}/${agent.name} already exists here with another Configuration; ` +
            "delete it or import into another Namespace",
        );
      }
      const location = `${method} ${path}`;
      const id = responseId(data, location);
      if (agent.servicePrincipalId) {
        record(agent.servicePrincipalId, responseId(data, location, "servicePrincipalId"));
      }
      record(agent.id, id);
      log(`${same ? "reusing existing" : "created"} Agent ${namespace.name}/${agent.name}: ${id}`);
    }
    const liveBindings = new Map(
      (await list(api, `${base}/iam/access-bindings`)).map((binding) => [
        bindingKey(binding),
        binding,
      ]),
    );
    for (const binding of bundleRecords(namespace, "accessBindings")) {
      if (ids.has(binding.id)) {
        continue;
      }
      if (binding.resourceKind === "agent_revision") {
        log(`skipped access binding ${binding.id}: Agent revisions are not carried over`);
        continue;
      }
      const skip =
        binding.subjectKind !== "identity"
          ? `subject kind ${binding.subjectKind} is not accepted here; re-create it by hand`
          : !BINDING_RESOURCE_KINDS.includes(binding.resourceKind)
            ? `resource kind ${binding.resourceKind ?? "(none)"} is not accepted here; re-create it by hand`
            : undefined;
      if (skip !== undefined) {
        skippedBindings.push(`${namespace.name}/${binding.id}: ${skip}`);
        continue;
      }
      const body = remap(
        pick(binding, ["subjectKind", "subjectId", "roleId", "resourceKind", "resourceId"]),
        ids,
      );
      const live = liveBindings.get(
        bindingKey(requireRecord(body, "remapped bundle namespaces[].accessBindings[]")),
      );
      if (live) {
        record(binding.id, responseId(live, `GET ${base}/iam/access-bindings`));
        continue;
      }
      try {
        await create(
          binding.id,
          "iam/access-bindings",
          body,
          `access binding ${namespace.name}/${binding.id}`,
        );
      } catch (error) {
        if (!(error instanceof SplitLayoutError) || error instanceof InvalidMigrationDataError) {
          throw error;
        }
        // For example a binding to an Agent's own Role that the new Agent did not get.
        skippedBindings.push(`${namespace.name}/${binding.id}: ${error.message}`);
      }
    }
    if (deploy) {
      for (const agent of bundleRecords(namespace, "agents")) {
        if (
          agent.desiredRuntimeState !== "running" ||
          requireArray(importState.deployed, "ID map (--map).deployed").includes(agent.id)
        ) {
          continue;
        }
        try {
          const path = `${base}/agents/${ids.get(agent.id)}/deploy`;
          responseId(await readOccResource(api, "POST", path), `POST ${path}`);
        } catch (error) {
          if (!(error instanceof SplitLayoutError) || error instanceof InvalidMigrationDataError) {
            throw error;
          }
          failedDeploys.push(`${namespace.name}/${agent.name}: ${error.message}`);
          continue;
        }
        requireArray(importState.deployed, "ID map (--map).deployed").push(agent.id);
        save(state);
        log(`deploying Agent ${namespace.name}/${agent.name}`);
      }
    }
  }
  return { complete: true, pendingNamespaces: [], failedDeploys, skippedBindings };
}

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  const options: CliOptions = {
    command,
    names: Object.create(null) as Record<string, string>,
    skip: [],
  };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]!;
    if (["--yes", "--no-deploy", "--allow-unread-workspace-files"].includes(flag)) {
      options[flag.slice(2) as "yes" | "no-deploy" | "allow-unread-workspace-files"] = true;
    } else if (flag === "--rename" && /^[^=]+=[^=]+$/u.test(rest[index + 1] ?? "")) {
      const [from, to] = rest[index + 1]!.split("=");
      options.names[from!] = to!;
      index += 1;
    } else if (flag === "--skip" && rest[index + 1] !== undefined) {
      options.skip.push(rest[index + 1]!);
      index += 1;
    } else if (
      ["--out", "--bundle", "--secret-values", "--map"].includes(flag) &&
      rest[index + 1] !== undefined
    ) {
      options[flag.slice(2) as "out" | "bundle" | "secret-values" | "map"] = rest[index + 1]!;
      index += 1;
    } else {
      throw new SplitLayoutError(`unknown argument ${flag}\n${usage}`);
    }
  }
  return options;
}

function writePrivateJson(path: string, value: unknown) {
  const partial = `${path}.partial`;
  writeFileSync(partial, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(partial, path);
}

function cliApi() {
  const { OCC_URL: url, OCC_SERVICE_KEY_FILE: keyFile } = process.env;
  if (!url || !keyFile) {
    throw new SplitLayoutError(`OCC_URL and OCC_SERVICE_KEY_FILE are required\n${usage}`);
  }
  const base = new URL(url);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) {
    throw new SplitLayoutError("OCC_URL must use https (http only on loopback)");
  }
  const keyFileData = readPrivateJson(keyFile, "service-key file");
  const key =
    isRecord(keyFileData) && isRecord(keyFileData.data) ? keyFileData.data.key : undefined;
  if (typeof key !== "string" || key.trim() === "" || /[\r\n]/u.test(key)) {
    throw new SplitLayoutError(`invalid service-key file ${keyFile}`);
  }
  return createOccApi({ baseUrl: base, headers: { "x-api-key": key } });
}

export async function main(argv: string[]) {
  const options = parseArgs(argv);
  const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
  if (options.command === "export" && options.out) {
    if (existsSync(options.out)) {
      throw new SplitLayoutError(`${options.out} exists; choose a new file`);
    }
    writePrivateJson(options.out, await exportTenants(cliApi(), { log }));
    log(`wrote ${options.out}`);
  } else if (options.command === "discard" && options.bundle) {
    if (!options.yes) {
      throw new SplitLayoutError(
        "discard deletes every Agent and Namespace in the bundle; add --yes",
      );
    }
    await discardTenants(cliApi(), readBundle(options.bundle), {
      log,
      allowUnreadWorkspaceFiles: options["allow-unread-workspace-files"] === true,
    });
    log("discarded; confirm no oce-gateways-* namespaces remain before upgrading");
  } else if (
    options.command === "import" &&
    options.bundle &&
    options["secret-values"] &&
    options.map
  ) {
    const mapPath = options.map;
    const bundle = readBundle(options.bundle);
    const secretValues = readPrivateJson(options["secret-values"], "Secret-values file");
    const state: unknown = existsSync(options.map)
      ? readPrivateJson(options.map, "ID map")
      : { ids: {}, deployed: [] };
    const result = await importTenants(cliApi(), bundle, secretValues, {
      state,
      save: (value) => writePrivateJson(mapPath, value),
      deploy: !options["no-deploy"],
      names: options.names,
      skip: options.skip,
      log,
    });
    if (!result.complete) {
      log(
        `waiting for tenant RoleBindings: ${result.pendingNamespaces.join(", ")}. ` +
          "Grant them (production-agents.md), then rerun the same command.",
      );
      return 3;
    }
    for (const skipped of result.skippedBindings) {
      log(`access binding not re-created: ${skipped}`);
    }
    for (const failure of result.failedDeploys) {
      log(`deploy failed: ${failure}`);
    }
    log(`imported; ID map in ${options.map}`);
    if (result.failedDeploys.length + result.skippedBindings.length > 0) {
      return 4;
    }
  } else {
    throw new SplitLayoutError(usage);
  }
  return 0;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const bundle = process.env.OCC_CA_BUNDLE;
  if (bundle && process.env.NODE_EXTRA_CA_CERTS !== bundle) {
    // fetch reads extra trust roots only at process start.
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      {
        stdio: "inherit",
        env: { ...process.env, NODE_EXTRA_CA_CERTS: bundle },
      },
    );
    process.exit(child.status ?? 1);
  }
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof SplitLayoutError ? error.message : error);
      process.exit(1);
    },
  );
}
