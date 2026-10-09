#!/usr/bin/env node
// Moves the tenants of a released single-cluster Installation with split-layout Gateway
// namespaces across an upgrade: `export` them through OCC, `discard` them on the old release,
// upgrade, then `import` them. See docs/guides/deploy/breaking-changes.md.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, realpathSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const BUNDLE_FORMAT = "oce-split-layout-tenants/v1";
export const WORKSPACE_FILE_NAMES = Object.freeze([
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
]);
// Access-binding resource kinds the current API accepts (Agent revisions are not carried over).
const BINDING_RESOURCE_KINDS = Object.freeze([
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
export function currentHarnessAuth(harnessAuth, namespaceId) {
  if (harnessAuth?.method !== "chatgpt_service_account") {
    return harnessAuth;
  }
  return {
    method: "codex_pat",
    source: { kind: "service_account", namespaceId, id: harnessAuth.serviceAccountId },
  };
}

const usage = `Usage:
  node scripts/split-layout-tenants.mjs export --out FILE
  node scripts/split-layout-tenants.mjs discard --bundle FILE --yes [--allow-unread-workspace-files]
  node scripts/split-layout-tenants.mjs import --bundle FILE --secret-values FILE --map FILE
      [--rename OLD=NEW]... [--skip NAME]... [--no-deploy]
Environment: OCC_URL, OCC_SERVICE_KEY_FILE, optional OCC_CA_BUNDLE.`;

export class SplitLayoutError extends Error {}

/** An OCC API client over a fetch function. `fetchImpl(url, init)` returns a Response. */
export function createOccApi({ baseUrl, headers = {}, fetchImpl = fetch }) {
  async function call(method, path, body) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetchImpl(new URL(path, baseUrl).toString(), init);
    const text = await response.text();
    let payload;
    try {
      payload = text === "" ? {} : JSON.parse(text);
    } catch {
      payload = {};
    }
    return { status: response.status, data: payload.data, error: payload.error };
  }
  async function expect(method, path, body, accepted = [200, 201, 202]) {
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

const ns = (id) => `/namespaces/${encodeURIComponent(id)}`;
const list = async (api, path) => (await api.expect("GET", path)).data ?? [];

/** Reads every Namespace's tenant resources into a bundle. Read-only. */
export async function exportTenants(api, { log = () => {} } = {}) {
  const namespaces = [];
  for (const namespace of await list(api, "/namespaces")) {
    const base = ns(namespace.id);
    const agents = [];
    const configurationIds = new Set();
    for (const listed of await list(api, `${base}/agents`)) {
      const agent = (await api.expect("GET", `${base}/agents/${listed.id}`)).data;
      configurationIds.add(agent.configurationId);
      const workspaceFiles = {};
      const unreadWorkspaceFiles = [];
      for (const name of WORKSPACE_FILE_NAMES) {
        const file = await api.call("GET", `${base}/agents/${agent.id}/workspace/files/${name}`);
        if (file.status === 200 && typeof file.data?.content === "string") {
          workspaceFiles[name] = file.data.content;
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
      configurations.push(data);
    }
    namespaces.push({
      id: namespace.id,
      name: namespace.name,
      secrets: (await list(api, `${base}/secrets`)).map(({ id, name }) => ({ id, name })),
      credentialSources: await list(api, `${base}/credential-sources`),
      configurations,
      presets: await list(api, `${base}/presets`),
      roles: await list(api, `${base}/iam/roles`),
      accessBindings: await list(api, `${base}/iam/access-bindings`),
      serviceAccounts: (await list(api, `${base}/service-accounts`)).map(({ id, name }) => ({
        id,
        name,
      })),
      agents,
    });
    log(
      `exported ${namespace.name} (${namespace.id}): ${agents.length} Agents, ` +
        `${configurations.length} Configurations, ${namespaces.at(-1).secrets.length} Secrets`,
    );
  }
  return { format: BUNDLE_FORMAT, exportedAt: new Date().toISOString(), namespaces };
}

function readBundle(path) {
  const bundle = JSON.parse(readFileSync(path, "utf8"));
  if (bundle?.format !== BUNDLE_FORMAT || !Array.isArray(bundle.namespaces)) {
    throw new SplitLayoutError(`${path} is not a ${BUNDLE_FORMAT} bundle`);
  }
  return bundle;
}

async function waitUntil(check, { timeoutMs, intervalMs, sleep }) {
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

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deletes the bundle's tenants on the old release: Agents first, then the Namespace children,
 * then the Namespaces. Refuses when a Namespace holds an Agent or Secret the bundle lacks.
 */
export async function discardTenants(
  api,
  bundle,
  {
    log = () => {},
    allowUnreadWorkspaceFiles = false,
    timeoutMs = 600_000,
    intervalMs = 5_000,
    sleep = defaultSleep,
  } = {},
) {
  const unread = bundle.namespaces.flatMap((namespace) =>
    namespace.agents
      .filter((agent) => (agent.unreadWorkspaceFiles ?? []).length > 0)
      .map((agent) => `${namespace.name}/${agent.name}`),
  );
  if (unread.length > 0 && !allowUnreadWorkspaceFiles) {
    throw new SplitLayoutError(
      `the bundle lacks workspace files of ${unread.join(", ")}; deploy those Agents and export ` +
        "again, or add --allow-unread-workspace-files to discard them",
    );
  }
  for (const namespace of bundle.namespaces) {
    const base = ns(namespace.id);
    const exported = new Set([...namespace.agents, ...namespace.secrets].map(({ id }) => id));
    const live = [...(await list(api, `${base}/agents`)), ...(await list(api, `${base}/secrets`))];
    const missing = live.filter(({ id }) => !exported.has(id)).map(({ id }) => id);
    if (missing.length > 0) {
      throw new SplitLayoutError(
        `${namespace.name} has resources the bundle lacks (${missing.join(", ")}); export again`,
      );
    }
  }
  for (const namespace of bundle.namespaces) {
    const base = ns(namespace.id);
    for (const agent of namespace.agents) {
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
    const children = [
      ["iam/access-bindings", namespace.accessBindings],
      ["service-accounts", namespace.serviceAccounts],
      ["presets", namespace.presets],
      ["configurations", namespace.configurations],
      ["credential-sources", namespace.credentialSources],
      ["secrets", namespace.secrets],
      ["iam/roles", namespace.roles],
    ];
    for (const [kind, items] of children) {
      for (const item of items) {
        await api.expect("DELETE", `${base}/${kind}/${item.id}`, undefined, [200, 202, 204, 404]);
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
  const ids = new Set(bundle.namespaces.map(({ id }) => id));
  const cleared = await waitUntil(
    async () => (await list(api, "/namespaces")).every(({ id }) => !ids.has(id)),
    { timeoutMs, intervalMs, sleep },
  );
  if (!cleared) {
    throw new SplitLayoutError(`Namespaces still present after ${timeoutMs} ms`);
  }
}

/** Replaces every string equal to a mapped old ID, at any depth. */
export function remap(value, ids) {
  if (typeof value === "string") {
    return ids.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => remap(item, ids));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item, ids)]));
  }
  return value;
}

function pick(source, fields) {
  return Object.fromEntries(
    fields
      .filter((field) => source[field] !== undefined && source[field] !== null)
      .map((field) => [field, source[field]]),
  );
}

function bindingKey(binding) {
  return [
    binding.subjectKind,
    binding.subjectId,
    binding.roleId,
    binding.resourceKind ?? "",
    binding.resourceId ?? "",
  ].join("\u0000");
}

/** Checks a bundle and its Secret values before anything is created. Returns the problems. */
export function checkImport(bundle, secretValues) {
  const problems = [];
  for (const namespace of bundle.namespaces) {
    for (const secret of namespace.secrets) {
      if (typeof secretValues?.[namespace.name]?.[secret.name] !== "string") {
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
  api,
  bundle,
  secretValues,
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
  } = {},
) {
  // A deleted Namespace's name stays reserved, so the copies usually need new names.
  const namespaces = bundle.namespaces.filter(({ name }) => !skip.includes(name));
  const targetName = (namespace) => names[namespace.name] ?? namespace.name;
  const problems = checkImport({ ...bundle, namespaces }, secretValues);
  if (problems.length > 0) {
    throw new SplitLayoutError(problems.join("\n"));
  }
  const ids = new Map(Object.entries(state.ids));
  const record = (oldId, newId) => {
    ids.set(oldId, newId);
    state.ids = Object.fromEntries(ids);
    save(state);
  };
  const pending = [];
  const failedDeploys = [];
  const skippedBindings = [];

  // Namespaces first: each needs its tenant RoleBindings before it becomes ready.
  const existing = await list(api, "/namespaces");
  for (const namespace of namespaces) {
    if (ids.has(namespace.id)) {
      continue;
    }
    const name = targetName(namespace);
    const same = existing.find((live) => live.name === name);
    if (same !== undefined && !Object.values(state.ids).includes(same.id)) {
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
      created = result.data;
    }
    record(namespace.id, created.id);
    log(`${same ? "reusing" : "created"} Namespace ${name}: ${created.id}`);
  }
  // One short shared wait: a Namespace stays provisioning until its RoleBindings exist.
  const notReady = async () => {
    const waiting = [];
    for (const namespace of namespaces) {
      const id = ids.get(namespace.id);
      if ((await api.expect("GET", ns(id))).data?.status !== "ready") {
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
    const create = async (oldId, kind, body, label, name) => {
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
      const { data } = await api.expect("POST", `${base}/${kind}`, body);
      record(oldId, data.id);
      log(`created ${label}: ${data.id}`);
      return data.id;
    };
    for (const secret of namespace.secrets) {
      await create(
        secret.id,
        "secrets",
        { name: secret.name, value: secretValues[namespace.name][secret.name] },
        `Secret ${namespace.name}/${secret.name}`,
        secret.name,
      );
    }
    for (const source of namespace.credentialSources) {
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
    for (const configuration of namespace.configurations) {
      await create(
        configuration.id,
        "configurations",
        remap(pick(configuration, ["kind", "values", "secretBindings"]), ids),
        `Configuration ${namespace.name}/${configuration.id}`,
      );
    }
    for (const preset of namespace.presets) {
      const template = structuredClone(preset.template);
      if (template?.agent?.harnessAuth !== undefined) {
        template.agent.harnessAuth = currentHarnessAuth(template.agent.harnessAuth, namespace.id);
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
    for (const role of namespace.roles) {
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
    for (const account of namespace.serviceAccounts) {
      await create(
        account.id,
        "service-accounts",
        { name: account.name },
        `service account ${namespace.name}/${account.name}`,
        account.name,
      );
    }
    for (const agent of namespace.agents) {
      if (ids.has(agent.id)) {
        if (agent.servicePrincipalId && !ids.has(agent.servicePrincipalId)) {
          const { data } = await api.expect("GET", `${base}/agents/${ids.get(agent.id)}`);
          record(agent.servicePrincipalId, data.servicePrincipalId);
        }
        continue;
      }
      const body = remap(
        {
          ...pick(agent, AGENT_FIELDS),
          harnessAuth: currentHarnessAuth(agent.harnessAuth, namespace.id),
        },
        ids,
      );
      if (body.harnessAuth === undefined || body.harnessAuth === null) {
        delete body.harnessAuth;
      }
      if (Array.isArray(agent.repositoryBindings) && agent.repositoryBindings.length > 0) {
        body.repositoryBindings = agent.repositoryBindings.map((binding) =>
          pick(binding, ["repositoryRef", "profile"]),
        );
      }
      if (Object.keys(agent.workspaceFiles ?? {}).length > 0) {
        body.initialWorkspaceFiles = agent.workspaceFiles;
      }
      const same = (await list(api, `${base}/agents`)).find(({ name }) => name === agent.name);
      const data = same
        ? (await api.expect("GET", `${base}/agents/${same.id}`)).data
        : (await api.expect("POST", `${base}/agents`, body)).data;
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
    for (const binding of namespace.accessBindings) {
      if (ids.has(binding.id)) {
        continue;
      }
      const skip =
        binding.resourceKind === "agent_revision"
          ? "Agent revisions are not carried over"
          : binding.subjectKind !== "identity"
            ? `subject kind ${binding.subjectKind} is not accepted here; re-create it by hand`
            : !BINDING_RESOURCE_KINDS.includes(binding.resourceKind)
              ? `resource kind ${binding.resourceKind ?? "(none)"} is not accepted here; re-create it by hand`
              : undefined;
      if (skip !== undefined) {
        log(`skipped access binding ${binding.id}: ${skip}`);
        continue;
      }
      const body = remap(
        pick(binding, ["subjectKind", "subjectId", "roleId", "resourceKind", "resourceId"]),
        ids,
      );
      const live = liveBindings.get(bindingKey(body));
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
      for (const agent of namespace.agents) {
        if (agent.desiredRuntimeState !== "running" || state.deployed.includes(agent.id)) {
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
        state.deployed.push(agent.id);
        save(state);
        log(`deploying Agent ${namespace.name}/${agent.name}`);
      }
    }
  }
  return { complete: true, pendingNamespaces: [], failedDeploys, skippedBindings };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, names: {}, skip: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (["--yes", "--no-deploy", "--allow-unread-workspace-files"].includes(flag)) {
      options[flag.slice(2)] = true;
    } else if (flag === "--rename" && /^[^=]+=[^=]+$/u.test(rest[index + 1] ?? "")) {
      const [from, to] = rest[index + 1].split("=");
      options.names[from] = to;
      index += 1;
    } else if (flag === "--skip" && rest[index + 1] !== undefined) {
      options.skip.push(rest[index + 1]);
      index += 1;
    } else if (
      ["--out", "--bundle", "--secret-values", "--map"].includes(flag) &&
      rest[index + 1] !== undefined
    ) {
      options[flag.slice(2)] = rest[index + 1];
      index += 1;
    } else {
      throw new SplitLayoutError(`unknown argument ${flag}\n${usage}`);
    }
  }
  return options;
}

function writePrivateJson(path, value) {
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
  const key = JSON.parse(readFileSync(keyFile, "utf8"))?.data?.key;
  if (typeof key !== "string" || key.trim() === "" || /[\r\n]/u.test(key)) {
    throw new SplitLayoutError(`invalid service-key file ${keyFile}`);
  }
  return createOccApi({ baseUrl: base, headers: { "x-api-key": key } });
}

export async function main(argv) {
  const options = parseArgs(argv);
  const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
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
    const bundle = readBundle(options.bundle);
    const secretValues = JSON.parse(readFileSync(options["secret-values"], "utf8"));
    const state = existsSync(options.map)
      ? JSON.parse(readFileSync(options.map, "utf8"))
      : { ids: {}, deployed: [] };
    const result = await importTenants(cliApi(), bundle, secretValues, {
      state,
      save: (value) => writePrivateJson(options.map, value),
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
    (error) => {
      console.error(error instanceof SplitLayoutError ? error.message : error);
      process.exit(1);
    },
  );
}
