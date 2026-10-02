import type {
  PluginCatalogEntry,
  PluginCatalogPage,
  PluginDiscoveryAuthentication,
  PluginToolCatalogEntry,
} from "@openclaw-enterprise/contracts";
import { PluginDiscoveryError } from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

const CATALOG_URL = "https://chatgpt.com/backend-api/ps/";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const PAGE_SIZE = 20;
const WORKSPACE_PLUGINS = {
  label: "Manage workspace plugins",
  url: "https://chatgpt.com/admin/plugins?catalog=GLOBAL",
};
const PLUGIN_SETUP = {
  label: "OCE plugin setup",
  url: "https://github.com/openclaw/openclaw-enterprise/blob/main/docs/reference/drivers/plugin-bundled.md#selection-and-catalogs",
};

function oauthIdentity(value: string): {
  accessToken: string;
  accountId: string;
  isFedramp: boolean;
} {
  try {
    const wrapper = asRecord(JSON.parse(value));
    const auth = asRecord(wrapper?.auth);
    const tokens = asRecord(auth?.tokens);
    if (
      wrapper?.version !== 1 ||
      wrapper.provider !== "codex" ||
      wrapper.state !== "ready" ||
      auth?.auth_mode !== "chatgpt" ||
      !isNonEmptyString(tokens?.access_token) ||
      tokens.access_token.length > 16384 ||
      /[\s\p{Cc}]/u.test(tokens.access_token) ||
      !isNonEmptyString(tokens.account_id) ||
      tokens.account_id.length > 256 ||
      /[\s\p{Cc}]/u.test(tokens.account_id) ||
      !isNonEmptyString(tokens.id_token)
    ) {
      throw new Error();
    }
    const segments = tokens.id_token.split(".");
    if (segments.length !== 3) {
      throw new Error();
    }
    // This is native login state supplied by the server, never browser-provided identity.
    const claims = asRecord(JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf8")));
    const identity = asRecord(claims?.["https://api.openai.com/auth"]);
    if (
      !claims ||
      (identity?.chatgpt_account_id !== undefined &&
        identity.chatgpt_account_id !== tokens.account_id) ||
      (identity?.chatgpt_account_is_fedramp !== undefined &&
        typeof identity.chatgpt_account_is_fedramp !== "boolean")
    ) {
      throw new Error();
    }
    return {
      accessToken: tokens.access_token,
      accountId: tokens.account_id,
      isFedramp: identity?.chatgpt_account_is_fedramp === true,
    };
  } catch {
    throw new PluginDiscoveryError("credentials_rejected");
  }
}

function invalid(): never {
  throw new PluginDiscoveryError("invalid_response");
}

function record(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? invalid();
}

function text(value: unknown, max = 8192): string {
  return isNonEmptyString(value) && value.length <= max ? value : invalid();
}

function array(value: unknown, max: number): unknown[] {
  return Array.isArray(value) && value.length <= max ? value : invalid();
}

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new PluginDiscoveryError(
      response.status === 401 || response.status === 403
        ? "credentials_rejected"
        : response.status === 429
          ? "rate_limited"
          : "unavailable",
    );
  }
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    invalid();
  }
  const reader = response.body?.getReader();
  if (!reader) {
    invalid();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        invalid();
      }
      chunks.push(chunk.value);
    }
    try {
      return record(JSON.parse(Buffer.concat(chunks, size).toString("utf8")));
    } catch {
      invalid();
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function withCredential<T>(
  input: PluginDiscoveryAuthentication,
  signal: AbortSignal | undefined,
  run: (request: (path: string, body?: unknown) => Promise<Record<string, unknown>>) => Promise<T>,
): Promise<T> {
  if (
    (input.accessToken === undefined) === (input.credential === undefined) ||
    (input.accessToken !== undefined &&
      (!input.accessToken.startsWith("at-") || /[\s\p{Cc}]/u.test(input.accessToken)))
  ) {
    throw new PluginDiscoveryError("credentials_rejected");
  }
  const deadline = AbortSignal.timeout(15_000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    let accessToken: string;
    let accountId: string;
    let isFedramp: boolean;
    if (input.credential !== undefined) {
      ({ accessToken, accountId, isFedramp } = oauthIdentity(input.credential.value));
    } else {
      accessToken = input.accessToken!;
      // Account authority comes from the PAT issuer, never a browser-provided account ID.
      const identity = await readResponse(
        await fetch("https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami", {
          headers: { Authorization: `Bearer ${accessToken}` },
          redirect: "error",
          signal: requestSignal,
        }),
      );
      accountId = text(identity.chatgpt_account_id, 256);
      if (
        /[\s\p{Cc}]/u.test(accountId) ||
        typeof identity.chatgpt_account_is_fedramp !== "boolean"
      ) {
        invalid();
      }
      isFedramp = identity.chatgpt_account_is_fedramp;
    }
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "ChatGPT-Account-ID": accountId,
      "OAI-Product-Sku": "codex",
      ...(isFedramp ? { "X-OpenAI-Fedramp": "true" } : {}),
    };
    const result = await run(async (path, body) =>
      readResponse(
        await fetch(`${CATALOG_URL}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            ...headers,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          signal: requestSignal,
        }),
      ),
    );
    // The opaque OAuth wrapper differs from the bearer value an upstream response could echo.
    if (JSON.stringify(result)?.includes(JSON.stringify(accessToken).slice(1, -1))) {
      invalid();
    }
    return result;
  } catch (error) {
    // Upstream errors can contain credentials, URLs, or private metadata. Expose only a reason.
    throw error instanceof PluginDiscoveryError ? error : new PluginDiscoveryError("unavailable");
  }
}

function publicHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 8192 || /[\s\p{Cc}]/u.test(value)) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function catalogEntry(value: unknown): PluginCatalogEntry {
  const plugin = record(value);
  const release = record(plugin.release);
  const slug = text(plugin.name, 200);
  if (plugin.scope !== "GLOBAL" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(slug)) {
    invalid();
  }
  const apps = array(release.app_ids, 100).map((id) => text(id, 256));
  // Native Codex loads skills from the installed bundle; validate catalog metadata here.
  array(release.skills, 1000);
  if (
    !["AVAILABLE", "INSTALLED_BY_DEFAULT", "NOT_AVAILABLE"].includes(
      String(plugin.installation_policy),
    )
  ) {
    invalid();
  }
  let unavailableReason: string | undefined;
  let unavailableHelp = PLUGIN_SETUP;
  if (plugin.status !== "ENABLED" || plugin.installation_policy === "NOT_AVAILABLE") {
    unavailableHelp = WORKSPACE_PLUGINS;
    switch (plugin.disabled_reason) {
      case "disabled_by_admin":
        unavailableReason =
          "Disabled by a ChatGPT workspace administrator. Ask an administrator to enable access for the user or service account behind this token.";
        break;
      case "plan_not_eligible":
        unavailableReason =
          "This workspace's plan is not eligible for this plugin. Ask a workspace administrator to review plan availability.";
        break;
      case "required_app_unavailable":
        unavailableReason =
          "A required app is unavailable. Ask a ChatGPT workspace administrator to review app access and setup for the user or service account behind this token.";
        break;
      default:
        unavailableReason =
          "Unavailable for this account. Ask a ChatGPT workspace administrator to review plugin access; the service did not provide a recognized reason.";
    }
  } else if (release.requires_local_executor !== false) {
    // The list can rule out local executors; details still check native component support.
    unavailableReason =
      "This plugin requires a local executor that OCE hosted discovery does not support. Changing ChatGPT access will not enable it here.";
  } else if (apps.length === 0) {
    unavailableReason = "This plugin has no concrete hosted app supported by OCE.";
  }
  const presentation = record(release.interface);
  const description = presentation.short_description ?? release.description;
  // Public presentation URLs may expire; keep them out of persisted plugin selections.
  const logoUrl =
    publicHttpsUrl(presentation.logo_url) ?? publicHttpsUrl(presentation.composer_icon_url);
  const websiteUrl = publicHttpsUrl(presentation.website_url);
  const privacyPolicyUrl = publicHttpsUrl(presentation.privacy_policy_url);
  const termsOfServiceUrl = publicHttpsUrl(presentation.terms_of_service_url);
  return {
    id: `codex-plugin:${slug}@openai-curated-remote`,
    remoteId: text(plugin.id, 256),
    name: isNonEmptyString(release.display_name) ? text(release.display_name, 512) : slug,
    ...(isNonEmptyString(description) ? { description: text(description) } : {}),
    ...(logoUrl ? { logoUrl } : {}),
    ...(websiteUrl ? { websiteUrl } : {}),
    ...(privacyPolicyUrl ? { privacyPolicyUrl } : {}),
    ...(termsOfServiceUrl ? { termsOfServiceUrl } : {}),
    available: unavailableReason === undefined,
    ...(unavailableReason ? { unavailableReason, unavailableHelp } : {}),
    tools: null,
  };
}

export async function discoverHostedPlugins(
  input: PluginDiscoveryAuthentication & { readonly cursor?: string; readonly q?: string },
  signal?: AbortSignal,
): Promise<PluginCatalogPage> {
  return withCredential(input, signal, async (request) => {
    const query = new URLSearchParams({ scope: "GLOBAL", limit: String(PAGE_SIZE) });
    const search = input.q?.trim();
    if (search) {
      query.set("q", search);
    }
    if (input.cursor !== undefined) {
      query.set("pageToken", text(input.cursor));
    }
    const response = await request(`plugins/${search ? "search" : "list"}?${query}`);
    const next = record(response.pagination).next_page_token;
    const nextCursor = next === null ? null : text(next);
    if (nextCursor !== null && nextCursor === input.cursor) {
      invalid();
    }
    return {
      plugins: array(response.plugins, PAGE_SIZE).map(catalogEntry),
      nextCursor,
      setup: {
        message:
          "App connection status is not verified. Catalog availability does not confirm linked credentials. In ChatGPT admin, select the same workspace as this credential and enable plugin and app access for its user or service account. For service-account plugin credentials, open Service accounts, choose the account, and configure its app connections. Workspace administrator access is required. OCE policies do not grant access or configure credentials. Reload plugins after changes.",
        links: [
          WORKSPACE_PLUGINS,
          { label: "Service account credentials", url: "https://admin.openai.com/" },
          PLUGIN_SETUP,
        ],
      },
    };
  });
}

export async function getHostedPlugin(
  input: PluginDiscoveryAuthentication & { readonly pluginId: string },
  signal?: AbortSignal,
): Promise<PluginCatalogEntry> {
  return withCredential(input, signal, async (request) => {
    const pluginId = text(input.pluginId, 256);
    // Request complete declarations for compatibility checks; artifact URLs never leave this Driver.
    const response = await request(
      `plugins/${encodeURIComponent(pluginId)}?includeDownloadUrls=true`,
    );
    let entry = catalogEntry(response);
    if (entry.remoteId !== pluginId) {
      invalid();
    }
    const release = record(response.release);
    // Codex uses authored app declarations when present, rather than remapped directory IDs.
    const rawDeclarations =
      release.app_manifest == null
        ? array(release.app_ids, 100).map((id) => [text(id, 256), text(id, 256)] as const)
        : Object.entries(record(record(release.app_manifest).apps ?? {})).map(
            ([name, app]) => [name, text(record(app).id, 256)] as const,
          );
    // Native Codex retains the first declaration per app before matching app/MCP alternatives.
    const seenApps = new Set<string>();
    const declarations = rawDeclarations.filter(([, id]) => {
      if (seenApps.has(id)) {
        return false;
      }
      seenApps.add(id);
      return true;
    });
    if (
      entry.available !== false &&
      (array(release.mcp_servers, 1000).some(
        (server) => !declarations.some(([name]) => name === text(record(server).key, 256)),
      ) ||
        (release.scheduled_tasks != null && array(release.scheduled_tasks, 1000).length > 0))
    ) {
      entry = {
        ...entry,
        available: false,
        unavailableReason:
          "This plugin includes components not supported by the selected Plugin Driver. Changing ChatGPT access will not enable it here.",
        unavailableHelp: PLUGIN_SETUP,
      };
    }
    const appIds = declarations.map(([, id]) => id);
    if (appIds.length > 100) {
      invalid();
    }
    if (appIds.length === 0) {
      return entry.available === false
        ? entry
        : {
            ...entry,
            available: false,
            unavailableReason: "This plugin has no concrete hosted app supported by OCE.",
            unavailableHelp: PLUGIN_SETUP,
          };
    }
    const responseApps = await request("apps/batch", { app_ids: appIds, include_tools: true });
    const apps = new Map<string, Record<string, unknown>>();
    for (const raw of array(responseApps.apps, 100)) {
      const app = record(raw);
      const id = text(app.id, 256);
      if (!appIds.includes(id) || apps.has(id)) {
        invalid();
      }
      apps.set(id, app);
    }
    if (apps.size !== new Set(appIds).size || [...apps.values()].some((app) => app.tools == null)) {
      return entry;
    }
    const tools = new Map<string, PluginToolCatalogEntry>();
    for (const [ownerId, app] of apps) {
      const appAvailable = app.status === "ENABLED" || app.status === "ONLY_ME";
      for (const raw of array(app.tools, 10_000)) {
        const tool = record(raw);
        const rawName = text(tool.name, 512);
        const id = `${encodeURIComponent(ownerId)}/${encodeURIComponent(rawName)}`;
        // Match Codex's public batch metadata defaults; no tool list still means unknown.
        const enabled = tool.is_enabled ?? true;
        const readOnly = tool.is_read_only === undefined ? false : tool.is_read_only;
        if (tools.has(id) || typeof enabled !== "boolean" || typeof readOnly !== "boolean") {
          invalid();
        }
        tools.set(id, {
          id,
          ownerId,
          name: isNonEmptyString(tool.title) ? text(tool.title, 512) : rawName,
          ...(isNonEmptyString(tool.description)
            ? { description: text(tool.description, 65_536) }
            : {}),
          available: appAvailable && enabled,
          ...(!appAvailable
            ? { unavailableReason: "The app providing this tool is unavailable for this account." }
            : !enabled
              ? { unavailableReason: "This tool is disabled by the administrator." }
              : {}),
          writes: !readOnly,
        });
      }
    }
    return { ...entry, tools: [...tools.values()].sort((a, b) => a.id.localeCompare(b.id)) };
  });
}
