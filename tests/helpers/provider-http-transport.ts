import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { TestContext } from "node:test";
import { listen } from "./listen.ts";

export type ProviderHandler = (request: IncomingMessage, response: ServerResponse) => unknown;

export function parseAuthorizationUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error("Authentication response URL was invalid");
  }
}

export async function readProviderRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: AsyncIterable<unknown, unknown, undefined> = request;
  let body = "";
  for await (const chunk of chunks) {
    if (typeof chunk !== "string" && !Buffer.isBuffer(chunk)) {
      throw new Error("Provider request body contained an unsupported chunk");
    }
    body += chunk;
  }
  return body;
}

// Sends only the provider's fixed URLs to `target`. Real fetch, cancellation, stream
// reads, response parsing and redirect handling stay production behavior. Any other
// destination fails the test, even when the product turns the refused fetch into a
// provider-unavailable denial.
export function redirectProviderFetch(
  t: TestContext,
  allowedUrls: ReadonlySet<string>,
  target: string,
) {
  const originalFetch = globalThis.fetch;
  let unexpected = 0;
  t.mock.method(globalThis, "fetch", (...[input, init]: Parameters<typeof fetch>) => {
    const url = parseAuthorizationUrl(input instanceof Request ? input.url : String(input));
    if (!allowedUrls.has(url.href)) {
      unexpected += 1;
      throw new Error("Unexpected provider request");
    }
    return originalFetch(new URL(url.pathname, target), init);
  });
  t.after(() => assert.equal(unexpected, 0, "unexpected provider requests"));
}

// A loopback HTTP server standing in for the provider. It records each request path
// and delegates to `handle`, which tests swap per case.
export async function startProviderServer(t: TestContext, handle: ProviderHandler) {
  const requests: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    handle(request, response);
  });
  // Pooled connections outlive each subtest. A subtest that never yields to the event loop
  // (the 4096-callback admission sweep) stalls every timer. If it runs past the server's
  // idle timeout (about 6 s), the next fetch is written to a pooled socket before the
  // overdue server timer destroys it, and fails as a provider outage. Only the client
  // closes idle connections here.
  server.keepAliveTimeout = 0;
  return { requests, port: await listen(t, server) };
}
