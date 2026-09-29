import { APIError } from "better-auth";

// Bounded HTTP transport shared by the GitHub and Google sign-in providers.

export function rejected(): APIError {
  return APIError.fromStatus("UNAUTHORIZED", { message: "Authentication was not accepted." });
}

const providerResponseLimit = 64 * 1024;

// The provider gave no well-formed answer: transport failure, deadline, redirect,
// 429 or 5xx status, or an oversized or malformed body. Audited apart from rejection.
export class ProviderUnavailableError extends Error {}

export type ProviderDenial = "EXTERNAL_IDENTITY_REJECTED" | "PROVIDER_UNAVAILABLE";

// A code exchange yields the provider subject or the audited reason it did not.
export type ProviderExchange = { readonly subject: string } | { readonly denial: ProviderDenial };

export function providerExchangeFailure(error: unknown, signal: AbortSignal): ProviderExchange {
  return {
    denial:
      signal.aborted || error instanceof ProviderUnavailableError
        ? "PROVIDER_UNAVAILABLE"
        : "EXTERNAL_IDENTITY_REJECTED",
  };
}

// Every fixed provider endpoint the controller may call. Nothing else is fetchable.
export type ProviderEndpoint =
  | "https://github.com/login/oauth/access_token"
  | "https://api.github.com/user"
  | "https://oauth2.googleapis.com/token"
  | "https://www.googleapis.com/oauth2/v3/certs";

// A provider's fixed requests share a deadline, including streaming body reads.
// Only a well-formed 4xx answer is a rejection; every other failure is unavailability.
export async function providerJSON(
  endpoint: ProviderEndpoint,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  try {
    return await readProviderJSON(endpoint, init, signal);
  } catch (error) {
    throw error instanceof APIError ? error : new ProviderUnavailableError();
  }
}

async function readProviderJSON(
  endpoint: ProviderEndpoint,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch(endpoint, { ...init, signal, redirect: "error" });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw response.status === 429 || response.status >= 500 || response.ok
      ? new ProviderUnavailableError()
      : rejected();
  }
  const reader = response.body.getReader();
  try {
    if (Number(response.headers.get("content-length")) > providerResponseLimit) {
      await reader.cancel();
      throw new ProviderUnavailableError();
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > providerResponseLimit) {
        await reader.cancel();
        throw new ProviderUnavailableError();
      }
      chunks.push(value);
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new ProviderUnavailableError();
    }
    return data as Record<string, unknown>;
  } finally {
    reader.releaseLock();
  }
}
