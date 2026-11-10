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
  error: { code?: unknown; message?: unknown } | undefined;
};
type Api = ReturnType<typeof createOccApi>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

// These views leave values untyped until the operation that uses them, preserving its
// existing runtime checks and errors for unvalidated bundle and API data.
function resource(value: unknown): Resource {
  return value as Resource;
}

function array(value: unknown): unknown[] {
  return value as unknown[];
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
  if (resource(harnessAuth)?.method !== "chatgpt_service_account") {
    return harnessAuth;
  }
  return {
    method: "codex_pat",
    source: { kind: "service_account", namespaceId, id: resource(harnessAuth).serviceAccountId },
  };
}

const usage = `Usage:
  node scripts/split-layout-tenants.ts export --out FILE
  node scripts/split-layout-tenants.ts discard --bundle FILE --yes [--allow-unread-workspace-files]
  node scripts/split-layout-tenants.ts import --bundle FILE --secret-values FILE --map FILE
      [--rename OLD=NEW]... [--skip NAME]... [--no-deploy]
Environment: OCC_URL, OCC_SERVICE_KEY_FILE, optional OCC_CA_BUNDLE.`;

export class SplitLayoutError extends Error {}

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
    const envelope = resource(payload);
    const error = resource(envelope.error);
    return { status: response.status, data: envelope.data, error };
  }
  async function expect(method: string, path: string, body?: unknown, accepted = [200, 201, 202]) {
    const result = await call(method, path, body);
    if (!accepted.includes(result.status)) {
      const code = result.error?.code ?? "UNKNOWN";
      const message = result.error?.message ?? "";
      throw new SplitLayoutError(
        `${method} ${path}: HTTP ${result.status} ${code} ${message}`.trim(),
      );
    }
    if (
      result.status >= 200 &&
      result.status < 300 &&
      result.status !== 204 &&
      result.data === undefined
    ) {
      throw new SplitLayoutError(
        `${method} ${path}: HTTP ${result.status} returned no data envelope`,
      );
    }
    return result;
  }
  return { call, expect };
}

const ns = (id: unknown) => `/namespaces/${encodeURIComponent(id as string)}`;
const list = async (api: Api, path: string): Promise<Resource[]> => {
  const { data } = await api.expect("GET", path);
  if (!Array.isArray(data)) {
    throw new SplitLayoutError(
      `GET ${path.slice(0, 240)}: invalid OCC collection response; expected an array in data. Keep the original bundle and map, if present. Correct the OCC endpoint and reconcile any earlier writes before resuming the original operation.`,
    );
  }
  return data.map(resource);
};

/** Reads every Namespace's tenant resources into a bundle. Read-only. */
export async function exportTenants(
  api: Api,
  { log = () => {} }: LogOptions = {},
): Promise<ExportBundle> {
  const namespaces: Tenant[] = [];
  for (const namespace of await list(api, "/namespaces")) {
    const base = ns(namespace.id);
    const agents = [];
    const configurationIds = new Set<unknown>();
    for (const listed of await list(api, `${base}/agents`)) {
      const agent = resource((await api.expect("GET", `${base}/agents/${listed.id}`)).data);
      configurationIds.add(agent.configurationId);
      const workspaceFiles: Record<string, string> = {};
      const unreadWorkspaceFiles = [];
      for (const name of WORKSPACE_FILE_NAMES) {
        const file = await api.call("GET", `${base}/agents/${agent.id}/workspace/files/${name}`);
        const content = resource(file.data)?.content;
        if (file.status === 200 && typeof content === "string") {
          workspaceFiles[name] = content;
        } else if (file.status !== 404) {
          unreadWorkspaceFiles.push(
            `${name} (HTTP ${file.status} ${file.error?.code ?? ""})`.trim(),
          );
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
      const { data } = await api.expect("GET", `${base}/configurations/${id}`);
      configurations.push(resource(data));
    }
    // The Preset list carries summaries; each template is on the exact Preset read.
    const presets = [];
    for (const { id } of await list(api, `${base}/presets`)) {
      const { data } = await api.expect(
        "GET",
        `${base}/presets/${encodeURIComponent(id as string)}`,
      );
      presets.push(resource(data));
    }
    const tenant: Tenant = {
      id: namespace.id as string,
      name: namespace.name as string,
      secrets: (await list(api, `${base}/secrets`)).map(({ id, name }) => ({
        id: id as string,
        name: name as string,
      })),
      credentialSources: await list(api, `${base}/credential-sources`),
      configurations,
      presets,
      roles: await list(api, `${base}/iam/roles`),
      accessBindings: await list(api, `${base}/iam/access-bindings`),
      serviceAccounts: (await list(api, `${base}/service-accounts`)).map(({ id, name }) => ({
        id: id as string,
        name: name as string,
      })),
      agents,
    };
    namespaces.push(tenant);
    log(
      `exported ${namespace.name} (${namespace.id}): ${agents.length} Agents, ` +
        `${configurations.length} Configurations, ${tenant.secrets.length} Secrets`,
    );
  }
  return { format: BUNDLE_FORMAT, exportedAt: new Date().toISOString(), namespaces };
}

function readBundle(path: string): Bundle {
  const bundle: unknown = JSON.parse(readFileSync(path, "utf8"));
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
  const namespaces = bundle.namespaces.map(resource);
  const unread = namespaces.flatMap((namespace) =>
    array(namespace.agents)
      .filter((agent) => array(resource(agent).unreadWorkspaceFiles ?? []).length > 0)
      .map((agent) => `${namespace.name}/${resource(agent).name}`),
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
      [...array(namespace.agents), ...array(namespace.secrets)].map((item) => resource(item).id),
    );
    const live = [...(await list(api, `${base}/agents`)), ...(await list(api, `${base}/secrets`))];
    const missing = live.filter(({ id }) => !exported.has(id)).map(({ id }) => id);
    if (missing.length > 0) {
      throw new SplitLayoutError(
        `${namespace.name} has resources the bundle lacks (${missing.join(", ")}); export again`,
      );
    }
  }
  for (const namespace of namespaces) {
    const base = ns(namespace.id);
    for (const item of array(namespace.agents)) {
      const agent = resource(item);
      await api.expect("DELETE", `${base}/agents/${agent.id}`, undefined, [200, 202, 204, 404]);
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
    const children: [string, unknown][] = [
      ["iam/access-bindings", namespace.accessBindings],
      ["service-accounts", namespace.serviceAccounts],
      ["presets", namespace.presets],
      ["configurations", namespace.configurations],
      ["credential-sources", namespace.credentialSources],
      ["secrets", namespace.secrets],
      ["iam/roles", namespace.roles],
    ];
    for (const [kind, items] of children) {
      for (const item of array(items)) {
        await api.expect(
          "DELETE",
          `${base}/${kind}/${resource(item).id}`,
          undefined,
          [200, 202, 204, 404],
        );
      }
    }
    const deleted = await api.call("DELETE", base);
    if (deleted.status === 409) {
      throw new SplitLayoutError(
        `${namespace.name} (${namespace.id}) is not empty: ${deleted.error?.message ?? ""} ` +
          "A Configuration no Agent references is not exported and blocks the delete. Unless " +
          "the message names them, find them with `select id from occ.configurations where " +
          "namespace_id = '<id>'`, delete each with `occ configuration delete`, then run " +
          "discard again.",
      );
    }
    if (![200, 202, 204, 404].includes(deleted.status)) {
      throw new SplitLayoutError(
        `DELETE ${base}: HTTP ${deleted.status} ${deleted.error?.code ?? "UNKNOWN"}`,
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
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        remap(item, ids),
      ]),
    );
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
  return mapping !== null &&
    typeof mapping === "object" &&
    !Array.isArray(mapping) &&
    Object.hasOwn(mapping, key as PropertyKey)
    ? resource(mapping)[key as string]
    : undefined;
}

function secretValue(secretValues: unknown, namespaceName: unknown, secretName: unknown) {
  return ownValue(ownValue(secretValues, namespaceName), secretName);
}

/** Checks a bundle and its Secret values before anything is created. Returns the problems. */
export function checkImport(bundle: Bundle, secretValues: unknown) {
  const problems = [];
  for (const namespaceValue of bundle.namespaces) {
    const namespace = resource(namespaceValue);
    for (const secretValueEntry of array(namespace.secrets)) {
      const secret = resource(secretValueEntry);
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
  const allNamespaces = bundle.namespaces.map(resource);
  const namespaces = allNamespaces.filter(({ name }) => !skip.includes(name));
  const targetName = (namespace: Resource) => ownValue(names, namespace.name) ?? namespace.name;
  const problems = checkImport({ ...bundle, namespaces }, secretValues);
  if (problems.length > 0) {
    throw new SplitLayoutError(problems.join("\n"));
  }
  const ids = new Map<unknown, unknown>(Object.entries(resource(resource(state).ids)));
  // Each source tenant must keep a separate destination, including on a resumed import.
  // Otherwise adopting an empty Namespace can silently merge tenants before any API conflict.
  const targets = new Map();
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
  const record = (oldId: unknown, newId: unknown) => {
    ids.set(oldId, newId);
    resource(state).ids = Object.fromEntries(ids);
    save(state);
  };
  const pending = [];
  const failedDeploys: string[] = [];
  const skippedBindings: string[] = [];

  // Namespaces first: each needs its tenant RoleBindings before it becomes ready.
  const existing = await list(api, "/namespaces");
  const destinations = new Map();
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
    if (same !== undefined && !Object.values(resource(resource(state).ids)).includes(same.id)) {
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
      const result = await api.call("POST", "/namespaces", { name });
      if (result.status === 409) {
        throw new SplitLayoutError(
          `Namespace name ${name} is taken (${result.error?.message ?? ""}); ` +
            `add --rename '${namespace.name}=<new name>' or --skip '${namespace.name}'`,
        );
      }
      if (result.status !== 201) {
        throw new SplitLayoutError(
          `POST /namespaces: HTTP ${result.status} ${result.error?.code ?? "UNKNOWN"}`,
        );
      }
      created = resource(result.data);
    }
    record(namespace.id, created.id);
    log(`${same ? "reusing" : "created"} Namespace ${name}: ${created.id}`);
  }
  // One short shared wait: a Namespace stays provisioning until its RoleBindings exist.
  const notReady = async () => {
    const waiting = [];
    for (const namespace of namespaces) {
      const id = ids.get(namespace.id);
      if (resource((await api.expect("GET", ns(id))).data)?.status !== "ready") {
        waiting.push(`${targetName(namespace)} (${id})`);
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
      const same =
        name === undefined
          ? undefined
          : (await list(api, `${base}/${kind}`)).find((item) => item.name === name);
      if (same) {
        record(oldId, same.id);
        log(`reusing existing ${label}: ${same.id} (left unchanged)`);
        return same.id;
      }
      const data = resource((await api.expect("POST", `${base}/${kind}`, body)).data);
      record(oldId, data.id);
      log(`created ${label}: ${data.id}`);
      return data.id;
    };
    for (const item of array(namespace.secrets)) {
      const secret = resource(item);
      await create(
        secret.id,
        "secrets",
        { name: secret.name, value: secretValue(secretValues, namespace.name, secret.name) },
        `Secret ${namespace.name}/${secret.name}`,
        secret.name,
      );
    }
    for (const item of array(namespace.credentialSources)) {
      const source = resource(item);
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
    for (const item of array(namespace.configurations)) {
      const configuration = resource(item);
      await create(
        configuration.id,
        "configurations",
        remap(pick(configuration, ["kind", "values", "secretBindings"]), ids),
        `Configuration ${namespace.name}/${configuration.id}`,
      );
    }
    // Preset Harness authentication can refer to these accounts; map them before templates.
    for (const item of array(namespace.serviceAccounts)) {
      const account = resource(item);
      await create(
        account.id,
        "service-accounts",
        { name: account.name },
        `service account ${namespace.name}/${account.name}`,
        account.name,
      );
    }
    for (const item of array(namespace.presets)) {
      const preset = resource(item);
      const template = structuredClone(preset.template);
      const templateAgent = resource(resource(template)?.agent);
      if (templateAgent?.harnessAuth !== undefined) {
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
    for (const item of array(namespace.roles)) {
      const role = resource(item);
      if (ids.has(role.id)) {
        continue;
      }
      const same =
        role.name === undefined ? undefined : liveRoles.find(({ name }) => name === role.name);
      if (same) {
        record(role.id, same.id);
        continue;
      }
      await create(
        role.id,
        "iam/roles",
        pick(role, ["name", "permissions"]),
        `Role ${namespace.name}/${role.name ?? role.id}`,
      );
    }
    for (const item of array(namespace.agents)) {
      const agent = resource(item);
      if (ids.has(agent.id)) {
        if (agent.servicePrincipalId && !ids.has(agent.servicePrincipalId)) {
          const data = resource(
            (await api.expect("GET", `${base}/agents/${ids.get(agent.id)}`)).data,
          );
          record(agent.servicePrincipalId, data.servicePrincipalId);
        }
        continue;
      }
      const body = resource(
        remap(
          {
            ...pick(agent, AGENT_FIELDS),
            harnessAuth: currentHarnessAuth(agent.harnessAuth, namespace.id),
          },
          ids,
        ),
      );
      if (body.harnessAuth === undefined || body.harnessAuth === null) {
        delete body.harnessAuth;
      }
      if (Array.isArray(agent.repositoryBindings) && agent.repositoryBindings.length > 0) {
        body.repositoryBindings = agent.repositoryBindings.map((binding: unknown) =>
          pick(resource(binding), ["repositoryRef", "profile"]),
        );
      }
      if (Object.keys((agent.workspaceFiles ?? {}) as object).length > 0) {
        body.initialWorkspaceFiles = agent.workspaceFiles;
      }
      const same = (await list(api, `${base}/agents`)).find(({ name }) => name === agent.name);
      const data = resource(
        same
          ? (await api.expect("GET", `${base}/agents/${same.id}`)).data
          : (await api.expect("POST", `${base}/agents`, body)).data,
      );
      if (same && data.configurationId !== body.configurationId) {
        throw new SplitLayoutError(
          `Agent ${namespace.name}/${agent.name} already exists here with another Configuration; ` +
            "delete it or import into another Namespace",
        );
      }
      if (agent.servicePrincipalId && data.servicePrincipalId) {
        record(agent.servicePrincipalId, data.servicePrincipalId);
      }
      record(agent.id, data.id);
      log(
        `${same ? "reusing existing" : "created"} Agent ${namespace.name}/${agent.name}: ${data.id}`,
      );
    }
    const liveBindings = new Map(
      (await list(api, `${base}/iam/access-bindings`)).map((binding) => [
        bindingKey(binding),
        binding,
      ]),
    );
    for (const item of array(namespace.accessBindings)) {
      const binding = resource(item);
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
      const live = liveBindings.get(bindingKey(resource(body)));
      if (live) {
        record(binding.id, live.id);
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
        if (!(error instanceof SplitLayoutError)) {
          throw error;
        }
        // For example a binding to an Agent's own Role that the new Agent did not get.
        skippedBindings.push(`${namespace.name}/${binding.id}: ${error.message}`);
      }
    }
    if (deploy) {
      for (const item of array(namespace.agents)) {
        const agent = resource(item);
        if (
          agent.desiredRuntimeState !== "running" ||
          array(resource(state).deployed).includes(agent.id)
        ) {
          continue;
        }
        try {
          await api.expect("POST", `${base}/agents/${ids.get(agent.id)}/deploy`);
        } catch (error) {
          if (!(error instanceof SplitLayoutError)) {
            throw error;
          }
          failedDeploys.push(`${namespace.name}/${agent.name}: ${error.message}`);
          continue;
        }
        array(resource(state).deployed).push(agent.id);
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
  const keyFileData: unknown = JSON.parse(readFileSync(keyFile, "utf8"));
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
    const secretValues: unknown = JSON.parse(readFileSync(options["secret-values"], "utf8"));
    const state: unknown = existsSync(options.map)
      ? JSON.parse(readFileSync(options.map, "utf8"))
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
