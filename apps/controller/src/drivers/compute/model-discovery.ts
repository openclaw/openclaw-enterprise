import { ModelDiscoveryError } from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 10_000;
const MAX_PAGES = 10;

async function readDiscoveryResponse(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) {
      throw new ModelDiscoveryError("credentials_rejected");
    }
    throw new ModelDiscoveryError(response.status === 429 ? "rate_limited" : "unavailable");
  }
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new ModelDiscoveryError("invalid_response");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new ModelDiscoveryError("invalid_response");
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new ModelDiscoveryError("invalid_response");
      }
      chunks.push(chunk.value);
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
    } catch {
      throw new ModelDiscoveryError("invalid_response");
    }
    const page = asRecord(decoded);
    if (page === undefined) {
      throw new ModelDiscoveryError("invalid_response");
    }
    return page;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Native credential discovery; caller credentials never become stored platform state. */
export async function discoverHarnessModels(input: {
  readonly provider: string;
  readonly authMethod: "api_key" | "codex_pat";
  readonly apiKey: string;
}): Promise<readonly { readonly id: string; readonly name: string }[]> {
  if (input.provider !== "openai" && input.provider !== "anthropic") {
    throw new ModelDiscoveryError("unavailable");
  }
  if (
    input.authMethod === "codex_pat" &&
    (input.provider !== "openai" || !input.apiKey.startsWith("at-"))
  ) {
    // Native --with-access-token treats tokens without the at- prefix as identity JWTs.
    throw new ModelDiscoveryError("credentials_rejected");
  }
  try {
    const signal = AbortSignal.timeout(10_000);
    const pat = input.authMethod === "codex_pat";
    const anthropic = input.provider === "anthropic";
    const url = new URL(
      anthropic ? "https://api.anthropic.com/v1/models" : "https://api.openai.com/v1/models",
    );
    const headers: Record<string, string> = anthropic
      ? { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${input.apiKey}` };
    if (anthropic) {
      url.searchParams.set("limit", "1000");
    }
    if (pat) {
      // Codex 0.156 hydrates the account from whoami; callers never supply account authority.
      const identity = await readDiscoveryResponse(
        await fetch("https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami", {
          headers: { ...headers },
          signal,
          redirect: "error",
        }),
      );
      if (
        !isNonEmptyString(identity.chatgpt_account_id) ||
        /[\s\p{Cc}]/u.test(identity.chatgpt_account_id) ||
        typeof identity.chatgpt_account_is_fedramp !== "boolean"
      ) {
        throw new ModelDiscoveryError("invalid_response");
      }
      headers["ChatGPT-Account-ID"] = identity.chatgpt_account_id;
      if (identity.chatgpt_account_is_fedramp) {
        headers["X-OpenAI-Fedramp"] = "true";
      }
      url.href = "https://chatgpt.com/backend-api/codex/models?client_version=0.156.0";
    }
    const currentDate = new Date().toISOString().slice(0, 10);
    const models = new Map<string, { readonly id: string; readonly name: string }>();
    const cursors = new Set<string>();
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
      const page = await readDiscoveryResponse(
        await fetch(url.href, { headers, signal, redirect: "error" }),
      );
      const entries = pat ? page.models : page.data;
      if (!Array.isArray(entries) || entries.length > MAX_MODELS) {
        throw new ModelDiscoveryError("invalid_response");
      }
      if (pat) {
        entries.sort((left, right) => {
          const a = asRecord(left)?.priority;
          const b = asRecord(right)?.priority;
          if (typeof a !== "number" || typeof b !== "number") {
            throw new ModelDiscoveryError("invalid_response");
          }
          return a - b;
        });
      }
      for (const item of entries) {
        const entry = asRecord(item);
        if (pat && entry?.visibility !== "list") {
          continue;
        }
        const model = pat ? { ...entry, id: entry?.slug } : entry;
        if (!isNonEmptyString(model?.id) || /[\s\p{Cc}]/u.test(model.id)) {
          throw new ModelDiscoveryError("invalid_response");
        }
        if (!pat && !anthropic && typeof model.shutdown_date === "string") {
          const shutdownAt = Date.parse(model.shutdown_date);
          // Only an explicit, valid shutdown date proves expiry; missing/malformed metadata does not.
          if (
            Number.isFinite(shutdownAt) &&
            new Date(shutdownAt).toISOString().slice(0, 10) === model.shutdown_date &&
            model.shutdown_date <= currentDate
          ) {
            continue;
          }
        }
        if (!models.has(model.id)) {
          models.set(model.id, {
            id: model.id,
            name: isNonEmptyString(model.display_name) ? model.display_name : model.id,
          });
        }
        if (models.size > MAX_MODELS) {
          throw new ModelDiscoveryError("invalid_response");
        }
      }
      if (!anthropic || page.has_more === false) {
        const choices = [...models.values()];
        return pat
          ? choices
          : choices.sort((left, right) => (left.id < right.id ? -1 : Number(left.id > right.id)));
      }
      // Anthropic's cursor is the last model ID, never an upstream-provided URL.
      if (page.has_more !== true || !isNonEmptyString(page.last_id) || cursors.has(page.last_id)) {
        throw new ModelDiscoveryError("invalid_response");
      }
      cursors.add(page.last_id);
      url.searchParams.set("after_id", page.last_id);
    }
    throw new ModelDiscoveryError("invalid_response");
  } catch (error) {
    // Never return upstream bodies, request headers, or fetch errors containing credentials.
    throw new ModelDiscoveryError(
      error instanceof ModelDiscoveryError ? error.reason : "unavailable",
    );
  }
}
