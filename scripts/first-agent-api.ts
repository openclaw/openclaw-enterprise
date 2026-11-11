export type FirstAgentApi = (
  method: string,
  path: string,
  body?: unknown,
  options?: { signal?: AbortSignal; maxBytes?: number },
) => Promise<unknown>;

function property(value: unknown, key: string): unknown {
  if (value === null || value === undefined) {
    throw new TypeError(`Cannot read properties of ${value} (reading '${key}')`);
  }
  return Reflect.get(Object(value), key);
}

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) {
    throw new TypeError("Response body is unavailable.");
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        throw new Error("Diagnostic response exceeded its byte limit.");
      }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    if (!response.bodyUsed) {
      await response.body?.cancel();
    }
  }
}

export function createFirstAgentApi({
  origin,
  key,
}: {
  origin: string | URL;
  key: { data: { key: string } };
}): FirstAgentApi {
  return async (method, path, body, { signal, maxBytes } = {}) => {
    let response: Response;
    try {
      response = await fetch(new URL(path, origin), {
        method,
        redirect: "error",
        signal: signal ?? AbortSignal.timeout(20_000),
        headers: {
          "x-api-key": key.data.key,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(
        `The local controller did not answer ${method} ${path}. Confirm Local Setup is running and retry the same Agent name.`,
      );
    }
    let envelope: unknown;
    try {
      envelope =
        maxBytes === undefined ? await response.json() : await boundedJson(response, maxBytes);
    } catch {
      throw new Error(
        `The local controller returned an invalid response (HTTP ${response.status}).`,
      );
    }
    if (!response.ok) {
      const error = property(envelope, "error");
      const errorCode = error == null ? undefined : property(error, "code");
      const meta = property(envelope, "meta");
      const id = meta == null ? undefined : property(meta, "requestId");
      const code = /^[A-Z0-9_]+$/.test(String(errorCode ?? "")) ? ` ${errorCode}` : "";
      const requestId = /^req_[a-f0-9-]+$/.test(String(id ?? "")) ? `; request ${id}` : "";
      throw new Error(
        `The local controller rejected ${method} ${path} (HTTP ${response.status}${code}${requestId}).`,
      );
    }
    return property(envelope, "data");
  };
}
