import { PluginDiscoveryError } from "@openclaw-enterprise/occ";
import { asRecord } from "@openclaw-enterprise/utils";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function invalid(): never {
  throw new PluginDiscoveryError("invalid_response");
}

export async function readCatalogResponse(response: Response): Promise<Record<string, unknown>> {
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
      const parsed = asRecord(JSON.parse(Buffer.concat(chunks, size).toString("utf8")));
      return parsed ?? invalid();
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
