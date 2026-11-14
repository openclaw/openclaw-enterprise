import { request as httpRequest } from "node:http";

// Use the real HTTP transport while preserving the public Host header. Node fetch replaces
// Host with the loopback dial address, which does not represent an HTTPS ingress request.
export async function fetchLoopback(url: string, init: RequestInit): Promise<Response> {
  const body = init.body as string | ArrayBuffer | undefined;
  const headers = new Headers(init.headers);
  if (body !== undefined) {
    headers.set(
      "content-length",
      String(typeof body === "string" ? Buffer.byteLength(body) : body.byteLength),
    );
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: init.method,
        headers: Object.fromEntries(headers),
        signal: init.signal ?? undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const headers = new Headers();
          for (const [name, values] of Object.entries(response.headers)) {
            for (const value of Array.isArray(values) ? values : [values]) {
              if (value !== undefined) {
                headers.append(name, value);
              }
            }
          }
          const status = response.statusCode ?? 500;
          resolve(
            new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), {
              status,
              headers,
            }),
          );
        });
      },
    );
    request.on("error", reject);
    request.end(body instanceof ArrayBuffer ? Buffer.from(body) : body);
  });
}

type RawRequestOptions = {
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
};

// These requests dial the loopback Controller with the configured public Host.
// Browser cases separately exercise the real TLS ingress.
export function createConsoleFixtureTransport(origin: string, transportOrigin: string) {
  async function rawRequest(
    method: string,
    path: string,
    { headers = {}, body, timeout = 5000 }: RawRequestOptions = {},
  ) {
    const response = await fetchLoopback(`${transportOrigin}${path}`, {
      method,
      headers: {
        host: new URL(origin).host,
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await response.text();
    return { response, text };
  }

  async function fetchThroughLoopback(request: Request) {
    const url = new URL(request.url);
    return fetchLoopback(`${transportOrigin}${url.pathname}${url.search}`, {
      method: request.method,
      headers: {
        ...Object.fromEntries(request.headers),
        host: url.host,
      },
      ...(request.body === null ? {} : { body: await request.arrayBuffer() }),
      signal: request.signal,
    });
  }

  return { rawRequest, fetchThroughLoopback };
}
