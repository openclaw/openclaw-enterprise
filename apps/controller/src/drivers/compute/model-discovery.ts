import { ModelDiscoveryError } from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 10_000;
const MAX_PAGES = 10;

async function readModelPage(response: Response): Promise<Record<string, unknown>> {
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
    if (page === undefined || !Array.isArray(page.data)) {
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

/** Native API-key discovery; caller credentials never become stored platform state. */
export async function discoverHarnessModels(input: {
  readonly provider: string;
  readonly apiKey: string;
}): Promise<readonly { readonly id: string; readonly name: string }[]> {
  if (input.provider !== "openai" && input.provider !== "anthropic") {
    throw new ModelDiscoveryError("unavailable");
  }
  try {
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
    const signal = AbortSignal.timeout(10_000);
    const models = new Map<string, { readonly id: string; readonly name: string }>();
    const cursors = new Set<string>();
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
      const page = await readModelPage(
        await fetch(url.href, { headers, signal, redirect: "error" }),
      );
      for (const item of page.data as unknown[]) {
        const model = asRecord(item);
        if (!isNonEmptyString(model?.id) || /[\s\p{Cc}]/u.test(model.id)) {
          throw new ModelDiscoveryError("invalid_response");
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
        return [...models.values()].sort((left, right) =>
          left.id < right.id ? -1 : Number(left.id > right.id),
        );
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
