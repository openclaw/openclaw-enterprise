import { isDeepStrictEqual } from "node:util";
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
        /^(?:content-encoding|transfer-encoding|upgrade|proxy-authorization|x-oce-binding|x-http-method(?:-override)?|x-method-override|x-original-url|x-rewrite-url|x-openai-fedramp|openai-organization|openai-project)$/.test(
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
      if (grant.kind !== "workspace_inference") {
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
          if (url.pathname === modelsPath && url.search === "?client_version=0.163.0") {
            return { ...operation, action: "models" };
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
      if (operation.kind !== "workspace_bootstrap" || operation.action !== "identity") {
        // TODO: Qualify native accounts and model-catalog response schemas before enabling
        // their response release. Request qualification alone cannot establish workspace custody.
        return undefined;
      }
      const clean = protectedIdentity(response, value, operation.workspaceId);
      return clean;
    },
  });
}

function protectedIdentity(
  response: EgressResponse,
  token: string,
  workspace: string,
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
    if (body?.chatgpt_account_id !== workspace || body.chatgpt_account_is_fedramp !== false) {
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
    const pending: unknown[] = [body];
    let nodes = 0;
    while (pending.length) {
      const value = pending.pop();
      if (
        ++nodes > 4096 ||
        (typeof value === "string" && (leaked(value) || /^https?:\/\//i.test(value)))
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
      body: Buffer.from(
        JSON.stringify({
          chatgpt_account_id: workspace,
          chatgpt_account_is_fedramp: false,
        }),
      ),
      trailers: [],
    };
  } catch {
    return undefined;
  }
}
