type RawRequestOptions = {
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
};

// These requests go directly to the loopback Controller. Node fetch can send the
// transport URL’s Host even when a logical Host is supplied; they do not test ingress routing.
export function createConsoleFixtureTransport(origin: string, transportOrigin: string) {
  async function rawRequest(
    method: string,
    path: string,
    { headers = {}, body, timeout = 5000 }: RawRequestOptions = {},
  ) {
    const response = await fetch(`${transportOrigin}${path}`, {
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
    return fetch(`${transportOrigin}${url.pathname}${url.search}`, {
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
