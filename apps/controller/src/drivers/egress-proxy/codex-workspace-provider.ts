import { isDeepStrictEqual } from "node:util";
import { parse as parseToml, TomlDate } from "smol-toml";
import type {
  CredentialProviderDefinition,
  CredentialSource,
  EgressRequest,
  EgressResponse,
} from "@openclaw-enterprise/contracts";
import { asRecord, immutableCopy } from "@openclaw-enterprise/utils";
import { parseUnambiguousJson } from "../repo/credentials/json-members.ts";
import { classifyOpenAiRequest, openAiStaticProvider } from "./openai-provider.ts";

/** Implemented by the selected installed Driver's authoritative source registry.
 * No workload, request header, source config or token decoding may supply this binding.
 * Returning undefined keeps an imported token without verified workspace metadata closed. */
export interface CodexWorkspaceAuthority {
  workspaceForSource(source: Readonly<CredentialSource>): string | undefined;
}

const identityPath = "/api/accounts/v1/user-auth-credential/whoami";
const accountPath = "/backend-api/wham/accounts/check";
const policyPath = "/backend-api/wham/config/bundle";
const modelsPath = "/backend-api/codex/models";
const responsesPath = "/backend-api/codex/responses";
const utf8 = new TextDecoder("utf-8", { fatal: true });
const jsonType = /^application\/json(?:;\s*charset=utf-8)?$/i;
const workspaceId = /^[a-zA-Z0-9_-]{1,128}$/;

function framed(request: EgressRequest, host: string, workspace: string): boolean {
  const names = new Set<string>();
  return (
    request.headers.length <= 64 &&
    request.headers.every(([name, value]) => {
      const key = name.toLowerCase();
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(key) || /[\r\n\0]/.test(value) || names.has(key)) {
        return false;
      }
      names.add(key);
      if (
        /^(?:content-encoding|transfer-encoding|upgrade|proxy-authorization|x-oce-binding|x-http-method(?:-override)?|x-method-override|x-original-url|x-rewrite-url|x-openai-fedramp|x-openai-account-routing-override|openai-organization|openai-project)$/.test(
          key,
        )
      ) {
        return false;
      }
      if (key === "host" && value !== host && value !== `${host}:443`) {
        return false;
      }
      if (key === "chatgpt-account-id" && value !== workspace) {
        return false;
      }
      return key !== "content-length" || value === String(request.body.byteLength);
    })
  );
}

/** The registered Driver must separately qualify its installed sender, TLS and response
 * custody. This factory does not enable the bundled stock sender or relax its host guard. */
export function createCodexWorkspacePatProvider(
  authority: CodexWorkspaceAuthority,
): CredentialProviderDefinition {
  return Object.freeze<CredentialProviderDefinition>({
    ref: { id: "codex-workspace-pat-https", generation: 1 },
    schemaVersion: 1,
    sourceOwnership: "proxy",
    sourceType: {
      type: "codex-pat",
      config: [],
      secrets: [{ name: "access_token", required: true }],
      rotation: "none",
      harnessAuth: { modelProvider: "openai", loginMode: "codex_pat" },
    },
    normalizeConfig(config) {
      if (Object.keys(config).length) {
        throw new Error("Workspace PAT sources accept no workload-selected configuration.");
      }
      return {};
    },
    normalizeGrant(models, config = {}, source) {
      this.normalizeConfig(config);
      const workspace = source && authority.workspaceForSource(source);
      if (
        !source?.egress ||
        source.type !== "codex-pat" ||
        !workspace ||
        !workspaceId.test(workspace)
      ) {
        throw new Error("Workspace PAT requires an authoritative exact-source workspace binding.");
      }
      const grant = openAiStaticProvider.normalizeGrant(models);
      if (grant.kind !== "inference") {
        throw new Error("Unsupported model grant.");
      }
      return immutableCopy({ ...grant, kind: "workspace_inference", workspaceId: workspace });
    },
    routes(source, binding) {
      const grant = this.normalizeGrant(
        binding.grant.kind === "workspace_inference" ? binding.grant.models : [],
        source.config,
        source,
      );
      if (
        !isDeepStrictEqual(grant, binding.grant) ||
        !isDeepStrictEqual(source.egress?.key, binding.source) ||
        source.namespaceId !== binding.execution.namespaceId ||
        source.egress?.key.installationId !== binding.execution.installationId
      ) {
        throw new Error("Workspace PAT grant does not match its source and execution.");
      }
      return [
        ["https://auth.openai.com", identityPath, "GET"],
        ["https://chatgpt.com", accountPath, "GET"],
        ["https://chatgpt.com", modelsPath, "GET"],
        ["https://chatgpt.com", responsesPath, "POST"],
        ["https://chatgpt.com", policyPath, "GET"],
      ].map(([origin, path, method], index) =>
        immutableCopy({
          route: { id: `${binding.binding.id}/${index}`, generation: binding.binding.generation },
          binding,
          origin: origin!,
          path: path!,
          method: method as "GET" | "POST",
          operationPolicy: { id: "codex-workspace-requests", generation: 1 },
          responsePolicy: { id: "codex-workspace-responses", generation: 1 },
          deadlineMs: 30_000,
        }),
      );
    },
    classify(route, request) {
      const grant = route.binding.grant;
      if (grant.kind !== "workspace_inference" || grant.models.length !== 1) {
        return undefined;
      }
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        return undefined;
      }
      if (
        url.href !== request.url ||
        url.username ||
        url.password ||
        url.hash ||
        url.origin !== route.origin ||
        url.pathname !== route.path ||
        request.method !== route.method ||
        !framed(request, url.hostname, grant.workspaceId) ||
        (url.origin === "https://chatgpt.com" &&
          !request.headers.some(
            ([name, value]) =>
              name.toLowerCase() === "chatgpt-account-id" && value === grant.workspaceId,
          ))
      ) {
        return undefined;
      }
      const operation = { kind: "workspace_bootstrap" as const, workspaceId: grant.workspaceId };
      if (request.method === "GET" && request.body.byteLength === 0) {
        if (
          url.origin === "https://auth.openai.com" &&
          url.pathname === identityPath &&
          request.url === `https://auth.openai.com${identityPath}`
        ) {
          return { ...operation, action: "identity" };
        }
        if (url.origin === "https://chatgpt.com") {
          if (url.pathname === accountPath && request.url === `https://chatgpt.com${accountPath}`) {
            return { ...operation, action: "accounts" };
          }
          if (url.pathname === policyPath && request.url === `https://chatgpt.com${policyPath}`) {
            return { ...operation, action: "policy" };
          }
          if (url.pathname === modelsPath && url.search === "?client_version=0.163.0") {
            return { ...operation, action: "models", model: grant.models[0]! };
          }
        }
        return undefined;
      }
      if (
        url.origin !== "https://chatgpt.com" ||
        url.pathname !== responsesPath ||
        request.url !== `https://chatgpt.com${responsesPath}`
      ) {
        return undefined;
      }
      const classified = classifyOpenAiRequest(
        {
          ...route,
          binding: {
            ...route.binding,
            grant: { kind: "inference", models: grant.models, providerTools: "none" },
          },
        },
        request,
        "codex-workspace",
      );
      return classified?.kind === "inference"
        ? { ...classified, workspaceId: grant.workspaceId }
        : undefined;
    },
    inject: openAiStaticProvider.inject,
    // No provider-specific positive credential rejection signal has been qualified yet.
    credentialRejected: () => false,
    protectResponse(response, value, request, operation) {
      if (value === undefined) {
        return undefined;
      }
      if (operation.kind === "inference") {
        return openAiStaticProvider.protectResponse(response, value, request, operation);
      }
      if (operation.kind !== "workspace_bootstrap") {
        return undefined;
      }
      if (
        (operation.action === "models" || operation.action === "policy") &&
        (request.url !==
          (operation.action === "policy"
            ? `https://chatgpt.com${policyPath}`
            : `https://chatgpt.com${modelsPath}?client_version=0.163.0`) ||
          request.method !== "GET" ||
          request.body.byteLength !== 0 ||
          !framed(request, "chatgpt.com", operation.workspaceId) ||
          !request.headers.some(
            ([name, field]) =>
              name.toLowerCase() === "chatgpt-account-id" && field === operation.workspaceId,
          ))
      ) {
        return undefined;
      }
      const clean = protectedBootstrap(
        response,
        value,
        operation.workspaceId,
        operation.action,
        operation.action === "models" ? operation.model : undefined,
      );
      return clean;
    },
  });
}

function protectedBootstrap(
  response: EgressResponse,
  token: string,
  workspace: string,
  action: "identity" | "accounts" | "models" | "policy",
  model?: string,
): EgressResponse | undefined {
  if (
    response.status !== 200 ||
    response.body.byteLength > 64 * 1024 ||
    response.trailers.length ||
    response.headers.filter(([name]) => name.toLowerCase() === "content-type").length !== 1 ||
    !jsonType.test(
      response.headers.find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "",
    ) ||
    response.headers.some(
      ([name, value]) =>
        /[\r\n\0]/.test(name + value) ||
        /^(?:location|content-encoding|trailer|upgrade)$/i.test(name),
    )
  ) {
    return undefined;
  }
  try {
    const text = utf8.decode(response.body);
    const body = asRecord(parseUnambiguousJson(text));
    if (
      response.headers.some(
        ([name, field]) => name.toLowerCase() === "chatgpt-account-id" && field !== workspace,
      )
    ) {
      return undefined;
    }
    const catalog = action === "models" ? protectedCatalog(body, model) : undefined;
    if (action === "models" && !catalog) {
      return undefined;
    }
    const accounts = action === "accounts" ? protectedAccounts(body, workspace) : undefined;
    if (action === "accounts" && !accounts) {
      return undefined;
    }
    if (
      action === "identity" &&
      (body?.chatgpt_account_id !== workspace ||
        body.chatgpt_account_is_fedramp !== false ||
        typeof body.chatgpt_user_id !== "string" ||
        !workspaceId.test(body.chatgpt_user_id) ||
        typeof body.chatgpt_plan_type !== "string" ||
        !["free", "plus", "pro", "team", "business", "enterprise", "edu"].includes(
          body.chatgpt_plan_type,
        ) ||
        Object.keys(body).some(
          (key) =>
            ![
              "chatgpt_account_id",
              "chatgpt_account_is_fedramp",
              "chatgpt_user_id",
              "chatgpt_plan_type",
              "email",
            ].includes(key),
        ) ||
        (body.email !== undefined &&
          body.email !== null &&
          (typeof body.email !== "string" ||
            body.email.length > 254 ||
            !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+$/.test(body.email))))
    ) {
      return undefined;
    }
    const encodings = [
      token,
      encodeURIComponent(token),
      Buffer.from(token).toString("base64"),
      Buffer.from(token).toString("base64url"),
    ];
    const leaked = (text: string) => encodings.some((value) => text.includes(value));
    if (leaked(text) || response.headers.some(([name, value]) => leaked(name) || leaked(value))) {
      return undefined;
    }
    if (action === "policy" && !validPolicyBundle(body, leaked)) {
      return undefined;
    }
    const pending: unknown[] = [body];
    let nodes = 0;
    while (pending.length) {
      const value = pending.pop();
      if (
        ++nodes > 4096 ||
        (typeof value === "string" &&
          (leaked(value) ||
            (action !== "policy" &&
              /^https?:\/\//i.test(value) &&
              !(action === "accounts" && value === "https://chatgpt.com"))))
      ) {
        return undefined;
      }
      if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          if (leaked(key)) {
            return undefined;
          }
          pending.push(child);
        }
      }
    }
    return {
      status: 200,
      headers: [["content-type", "application/json"]],
      body:
        action === "policy"
          ? Buffer.from(response.body)
          : Buffer.from(
              JSON.stringify(
                catalog ??
                  accounts ?? {
                    chatgpt_account_id: workspace,
                    chatgpt_account_is_fedramp: false,
                    chatgpt_user_id: body!.chatgpt_user_id,
                    chatgpt_plan_type: body!.chatgpt_plan_type,
                    ...(body!.email === undefined ? {} : { email: body!.email }),
                  },
              ),
            ),
      trailers: [],
    };
  } catch {
    return undefined;
  }
}

// The public client accepts this list form. Only the admitted account and fixed
// public backend may survive; account selection and routing are not display metadata.
function protectedAccounts(body: Record<string, unknown> | undefined, workspace: string) {
  if (
    !body ||
    Object.keys(body).some(
      (key) => !["accounts", "account_ordering", "default_account_id"].includes(key),
    ) ||
    body.default_account_id !== workspace ||
    !Array.isArray(body.account_ordering) ||
    body.account_ordering.length !== 1 ||
    body.account_ordering[0] !== workspace ||
    !Array.isArray(body.accounts) ||
    body.accounts.length !== 1
  ) {
    return undefined;
  }
  const account = asRecord(body.accounts[0]);
  if (
    !account ||
    Object.keys(account).some(
      (key) =>
        ![
          "id",
          "name",
          "plan_type",
          "structure",
          "workspace_backend_origin",
          "account_routing_override",
        ].includes(key),
    ) ||
    account.id !== workspace ||
    account.workspace_backend_origin !== "https://chatgpt.com" ||
    account.account_routing_override !== "NO_CONSTRAINT" ||
    account.structure !== "workspace" ||
    typeof account.name !== "string" ||
    account.name.length === 0 ||
    account.name.length > 128 ||
    [...account.name].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    typeof account.plan_type !== "string" ||
    !["team", "business", "enterprise", "edu"].includes(account.plan_type)
  ) {
    return undefined;
  }
  return {
    accounts: [
      {
        id: workspace,
        name: account.name,
        plan_type: account.plan_type,
        structure: "workspace",
        workspace_backend_origin: "https://chatgpt.com",
        account_routing_override: "NO_CONSTRAINT",
      },
    ],
    account_ordering: [workspace],
    default_account_id: workspace,
  };
}

// This is the smallest qualified native ModelInfo profile, not an arbitrary
// model configuration. Unknown capabilities, instructions and upgrades stay closed.
function protectedCatalog(body: Record<string, unknown> | undefined, model: string | undefined) {
  if (
    !model ||
    !body ||
    Object.keys(body).length !== 1 ||
    !Array.isArray(body.models) ||
    body.models.length === 0 ||
    body.models.length > 128
  ) {
    return undefined;
  }
  const display = (value: unknown, max: number) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !/\b(?:https?|file|data|javascript|wss?):/i.test(value) &&
    ![...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    );
  const positive = (value: unknown, max: number) =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;
  const efforts = ["none", "minimal", "low", "medium", "high", "xhigh"];
  const allowed = new Set([
    "slug",
    "base_instructions",
    "display_name",
    "description",
    "default_reasoning_level",
    "supported_reasoning_levels",
    "shell_type",
    "visibility",
    "supported_in_api",
    "priority",
    "support_verbosity",
    "default_verbosity",
    "apply_patch_tool_type",
    "truncation_policy",
    "experimental_supported_tools",
    "context_window",
  ]);
  const models: Record<string, unknown>[] = [];
  const slugs = new Set<string>();
  for (const value of body.models) {
    const entry = asRecord(value);
    const truncation = asRecord(entry?.truncation_policy);
    if (
      !entry ||
      Object.keys(entry).some((key) => !allowed.has(key)) ||
      typeof entry.slug !== "string" ||
      !/^[a-zA-Z0-9_.-]{1,128}$/.test(entry.slug) ||
      slugs.has(entry.slug) ||
      entry.base_instructions !== "" ||
      !display(entry.display_name, 256) ||
      (entry.description !== undefined &&
        entry.description !== null &&
        !display(entry.description, 1024)) ||
      !["unified_exec", "disabled"].includes(String(entry.shell_type)) ||
      typeof entry.shell_type !== "string" ||
      !["list", "hide", "none"].includes(String(entry.visibility)) ||
      typeof entry.visibility !== "string" ||
      typeof entry.supported_in_api !== "boolean" ||
      typeof entry.support_verbosity !== "boolean" ||
      typeof entry.priority !== "number" ||
      !Number.isSafeInteger(entry.priority) ||
      entry.priority < 0 ||
      entry.priority > 100000 ||
      !Array.isArray(entry.supported_reasoning_levels) ||
      entry.supported_reasoning_levels.length > 6 ||
      !entry.supported_reasoning_levels.every((value) => {
        const level = asRecord(value);
        return (
          level &&
          Object.keys(level).length === 2 &&
          typeof level.effort === "string" &&
          efforts.includes(level.effort) &&
          display(level.description, 512)
        );
      }) ||
      (entry.default_reasoning_level !== undefined &&
        entry.default_reasoning_level !== null &&
        (typeof entry.default_reasoning_level !== "string" ||
          !entry.supported_reasoning_levels.some(
            (level) => asRecord(level)?.effort === entry.default_reasoning_level,
          ))) ||
      (entry.default_verbosity !== undefined &&
        entry.default_verbosity !== null &&
        (typeof entry.default_verbosity !== "string" ||
          !["low", "medium", "high"].includes(entry.default_verbosity))) ||
      (entry.apply_patch_tool_type !== undefined &&
        entry.apply_patch_tool_type !== null &&
        entry.apply_patch_tool_type !== "freeform") ||
      !truncation ||
      Object.keys(truncation).length !== 2 ||
      !["tokens", "bytes"].includes(String(truncation.mode)) ||
      typeof truncation.mode !== "string" ||
      !positive(truncation.limit, 1048576) ||
      (entry.context_window !== undefined && !positive(entry.context_window, 2097152)) ||
      !Array.isArray(entry.experimental_supported_tools) ||
      entry.experimental_supported_tools.length !== 0
    ) {
      return undefined;
    }
    slugs.add(entry.slug);
    if (entry.slug === model) {
      models.push(entry);
    }
  }
  return models.length === 1 ? { models } : undefined;
}

// A policy bundle is not identity metadata: retain its ordered fragments intact.
// Scan TOML's decoded strings before delivery; native Codex still owns policy enforcement.
function validPolicyBundle(
  body: Record<string, unknown> | undefined,
  leaked: (value: string) => boolean,
): boolean {
  if (!body || Object.keys(body).length !== 2) {
    return false;
  }
  let remaining = 4096;
  const decodedIsSafe = (contents: string): boolean => {
    const pending: { value: unknown; depth: number }[] = [];
    const push = (value: unknown, depth: number): boolean => {
      if (--remaining < 0 || depth > 32) {
        return false;
      }
      pending.push({ value, depth });
      return true;
    };
    if (!push(parseToml(contents, { maxDepth: 32, integersAsBigInt: true }), 0)) {
      return false;
    }
    while (pending.length) {
      const entry = pending.pop();
      if (!entry) {
        return false;
      }
      const { value, depth } = entry;
      if (typeof value === "string") {
        if (leaked(value)) {
          return false;
        }
      } else if (value instanceof TomlDate) {
        // Dates are typed TOML scalars, not containers or strings to reserialize.
        continue;
      } else if (Array.isArray(value)) {
        for (const child of value) {
          if (!push(child, depth + 1)) {
            return false;
          }
        }
      } else if (value && typeof value === "object") {
        const table = asRecord(value);
        if (!table) {
          return false;
        }
        for (const key in table) {
          // Include special own keys such as __proto__, never inherited properties.
          if (Object.hasOwn(table, key) && (leaked(key) || !push(table[key], depth + 1))) {
            return false;
          }
        }
      } else if (!["number", "bigint", "boolean"].includes(typeof value)) {
        return false;
      }
    }
    return true;
  };
  return ["config_toml", "requirements_toml"].every((key) => {
    const layer = asRecord(body[key]);
    if (!layer || Object.keys(layer).length !== 1 || !Array.isArray(layer.enterprise_managed)) {
      return false;
    }
    const identities = new Set<string>();
    return layer.enterprise_managed.every((value) => {
      const fragment = asRecord(value);
      if (
        !fragment ||
        Object.keys(fragment).length !== 3 ||
        typeof fragment.id !== "string" ||
        fragment.id.length === 0 ||
        identities.has(fragment.id) ||
        typeof fragment.name !== "string" ||
        typeof fragment.contents !== "string"
      ) {
        return false;
      }
      identities.add(fragment.id);
      return decodedIsSafe(fragment.contents);
    });
  });
}
