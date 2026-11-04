import { authenticatedHeaders } from "./auth-session.mjs";

/**
 * One Fastify `app.inject` request to the API, as tests send it: `Host: 127.0.0.1` (override
 * with `host`), signed by `session` (a session's cookie and origin, or a bare cookie header;
 * see authenticatedHeaders) or a service API `key` (`x-api-key`). `body` is JSON-encoded (a
 * string too) and sets the content type. `headers` replace any header but that content type.
 * Returns the raw Fastify response.
 * @param {any} app
 * @param {string} method
 * @param {string} url
 * @param {{ body?: unknown, session?: string | { cookie: string, origin?: string },
 *   key?: string, headers?: Record<string, string>, host?: string, remoteAddress?: string }}
 *   [options]
 */
export function injectJson(
  app,
  method,
  url,
  { body, session, key, headers = {}, host = "127.0.0.1", remoteAddress } = {},
) {
  return app.inject({
    method,
    url,
    ...(remoteAddress === undefined ? {} : { remoteAddress }),
    headers: {
      host,
      ...(session === undefined ? {} : authenticatedHeaders(session)),
      ...(key === undefined ? {} : { "x-api-key": key }),
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

/**
 * The `fetch()` (or `new Request()`) init for one JSON request over HTTP: `method`, `headers`
 * and, when `body` is given, the JSON-encoded body with its content type after `headers`.
 * Spread it and add per-request options such as `signal`.
 * @param {string} method
 * @param {unknown} [body]
 * @param {Record<string, string>} [headers]
 */
export function jsonRequestInit(method, body, headers = {}) {
  return {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/**
 * injectJson with the Host header Fastify's `inject` sends when a request names none
 * (`localhost:80`) instead of 127.0.0.1, for suites written against that default.
 * @param {any} app
 * @param {string} method
 * @param {string} url
 * @param {Parameters<typeof injectJson>[3]} [options]
 */
export function injectLocalhost(app, method, url, options = {}) {
  return injectJson(app, method, url, { host: "localhost:80", ...options });
}
