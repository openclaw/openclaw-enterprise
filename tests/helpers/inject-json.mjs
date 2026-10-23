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
