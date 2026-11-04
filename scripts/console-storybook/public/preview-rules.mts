interface FixtureRule {
  method?: string;
  path?: string;
  prefix?: string;
  pathIncludes?: string;
  suffix?: string;
  queryParam?: string;
  bodyHasIds?: boolean;
  skip?: number;
  once?: boolean;
  lostAnswer?: boolean;
  delayMs?: number;
  hold?: boolean;
  networkError?: boolean;
  bodyError?: boolean;
  status?: number;
  code?: string;
  message?: string;
  details?: unknown;
  retryAfter?: number | string;
  data?: unknown;
}

export function fixtureResponse(
  data: unknown,
  status = 200,
  errorCode?: string,
  meta: Record<string, unknown> = {},
  errorMessage?: string,
  details?: unknown,
  remainingResources?: unknown,
): Response {
  return new Response(
    JSON.stringify({
      ...(errorCode
        ? {
            error: {
              code: errorCode,
              message: errorMessage ?? "The selected preview simulates this failure.",
              ...(details ? { details } : {}),
              ...(remainingResources ? { remainingResources } : {}),
            },
          }
        : { data }),
      meta: { requestId: "req_00000000-0000-4000-8000-000000000001", ...meta },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

export function fixtureError(status: number, code?: string, message?: string): Response {
  return fixtureResponse(null, status, code, {}, message);
}

function bodyHasIds(body: unknown): boolean {
  if (body === null) {
    throw new TypeError("A preview rule cannot inspect ids in a null JSON body.");
  }
  return typeof body === "object" && "ids" in body && Array.isArray(body.ids);
}

async function readRequestText(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const abort = () => {
    // Cancel wakes the pending read. The source's cleanup must not delay the abort.
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    let text = "";
    while (true) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) {
        return text + decoder.decode();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export function createFixtureFetch(
  templates: readonly FixtureRule[],
  requests: { method: string; path: string }[],
  answer: (url: URL, method: string, body: unknown, headers: Headers) => Promise<Response>,
): typeof window.fetch {
  // Each mounted story consumes its own skip/once state without editing the authored rules.
  const rules: readonly (FixtureRule & { used?: boolean })[] = structuredClone(templates);
  return async (input, options) => {
    const request = new Request(input, options);
    const { method, signal, headers } = request;
    signal.throwIfAborted();
    const url = new URL(request.url);
    const path = url.pathname;
    // The common no-body request can reach the trace and reserve its rule without yielding.
    const text = request.body === null ? "" : await readRequestText(request.body, signal);
    signal.throwIfAborted();
    const body: unknown = text ? JSON.parse(text) : {};
    requests.push({ method, path });
    for (const rule of rules) {
      if (
        rule.used ||
        (rule.method ?? "GET") !== method ||
        (rule.path && rule.path !== path) ||
        (rule.prefix && !path.startsWith(rule.prefix)) ||
        (rule.pathIncludes && !path.includes(rule.pathIncludes)) ||
        (rule.suffix && !path.endsWith(rule.suffix)) ||
        (rule.queryParam && !url.searchParams.has(rule.queryParam)) ||
        (rule.bodyHasIds !== undefined && rule.bodyHasIds !== bodyHasIds(body))
      ) {
        continue;
      }
      if (rule.skip !== undefined && rule.skip > 0) {
        rule.skip -= 1;
        continue;
      }
      rule.used = rule.once === true;
      if (rule.lostAnswer) {
        // The simulated API applies the request once, then its answer is lost.
        await answer(url, method, body, headers);
        throw new TypeError("Failed to fetch");
      }
      if (rule.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            signal.removeEventListener("abort", abort);
            resolve();
          };
          const timer = setTimeout(finish, rule.delayMs);
          const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          if (signal.aborted) {
            abort();
          } else {
            signal.addEventListener("abort", abort, { once: true });
          }
        });
        signal.throwIfAborted();
      }
      if (rule.hold) {
        return new Promise<never>((_resolve, reject) => {
          const abort = () => reject(signal.reason);
          if (signal.aborted) {
            abort();
          } else {
            signal.addEventListener("abort", abort, { once: true });
          }
        });
      }
      if (rule.networkError) {
        // The browser's own failure for a request that never reaches the API (offline).
        throw new TypeError("Failed to fetch");
      }
      if (rule.bodyError) {
        // A simulated after-headers failure exercises the production body reader.
        // Real socket interruption is proved separately by the transport tests.
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"data":'));
              queueMicrotask(() => controller.error(new TypeError("Response body interrupted")));
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (rule.status) {
        const failure = fixtureResponse(
          null,
          rule.status,
          rule.code,
          {},
          rule.message,
          rule.details,
        );
        if (rule.retryAfter !== undefined) {
          failure.headers.set("retry-after", String(rule.retryAfter));
        }
        return failure;
      }
      if (rule.data !== undefined) {
        return fixtureResponse(rule.data);
      }
    }
    signal.throwIfAborted();
    return answer(url, method, body, headers);
  };
}
