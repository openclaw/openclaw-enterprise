import type { createFastifyApp } from "../../apps/controller/src/index.ts";
import { authenticatedHeaders } from "./auth-session.mjs";

type FastifyApp = ReturnType<typeof createFastifyApp>;
type App = Pick<FastifyApp, "inject">;
type InjectOptions = Exclude<
  App["inject"] extends {
    (options: infer Options): Promise<unknown>;
    (): unknown;
  }
    ? Options
    : never,
  string
>;
type InjectionMethod = NonNullable<InjectOptions["method"]>;
type JsonOptions = {
  body?: unknown;
  session?: Parameters<typeof authenticatedHeaders>[0];
  key?: string;
  headers?: Record<string, string>;
  host?: string;
  remoteAddress?: string;
};

/**
 * Send one API request with the default loopback host and optional session or service key.
 * JSON-encode every supplied body, including strings. Custom headers override authentication
 * headers, but a supplied body always sets the JSON content type. Return Fastify's raw response.
 */
export function injectJson(
  app: App,
  method: InjectionMethod,
  url: string,
  { body, session, key, headers = {}, host = "127.0.0.1", remoteAddress }: JsonOptions = {},
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

/** Build fetch or Request options; callers can spread the result and add options such as signal. */
export function jsonRequestInit(
  method: NonNullable<RequestInit["method"]>,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  } satisfies RequestInit;
}

/** Use Fastify's implicit localhost host for suites that depend on that default. */
export function injectLocalhost(
  app: App,
  method: InjectionMethod,
  url: string,
  options: JsonOptions = {},
) {
  return injectJson(app, method, url, { host: "localhost:80", ...options });
}
