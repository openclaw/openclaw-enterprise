import type { ConfigurationOptions, CoreV1Api, ResponseContext } from "@kubernetes/client-node";
import {
  DependencyUnavailableError,
  RuntimeDiagnosticsTransportError,
} from "@openclaw-enterprise/occ";
import { numericErrorStatus, readCappedBody } from "@openclaw-enterprise/utils";
import { nonRedirectingHttpLibrary } from "../../kubernetes/client.ts";

export const PLUGIN_RUNTIME_STATUS_PORT = 18_791;
export const PLUGIN_RUNTIME_STATUS_PATH = "/openclaw/plugin-runtime/status";
export const RUNTIME_STATUS_PATH = "/openclaw/runtime/status";
export const RUNTIME_DIAGNOSTICS_PATH = "/openclaw/runtime/diagnostics";
export const RUNTIME_IMAGE_PATH = "/openclaw/runtime/image";

export type PrivateStatusPath =
  | typeof PLUGIN_RUNTIME_STATUS_PATH
  | typeof RUNTIME_STATUS_PATH
  | typeof RUNTIME_DIAGNOSTICS_PATH
  | typeof RUNTIME_IMAGE_PATH;

type ProxyProtocolFailure = "oversized" | "redirect" | "interim";

type ProxyBody = { readonly body: unknown };
type ProxyReadOutcome = ProxyBody | DependencyUnavailableError | undefined;

const protocolFailureMessages = {
  oversized: "Runtime status returned oversized data.",
  redirect: "Runtime status answered with a redirect.",
  interim: "Runtime status answered with an unrequested 1xx status.",
} satisfies Record<ProxyProtocolFailure, string>;

type ReadRequest = <T>(operation: () => Promise<T>) => Promise<T>;

export async function readPrivateStatusProxy(
  core: Pick<CoreV1Api, "connectGetNamespacedPodProxyWithPath">,
  request: ReadRequest,
  target: {
    readonly namespace: string;
    readonly podName: string;
    readonly container: "agent" | "gateway";
    readonly path: PrivateStatusPath;
  },
): Promise<ProxyBody | undefined> {
  const options = await runtimeStatusOptions();
  async function readOnce(): Promise<ProxyReadOutcome> {
    try {
      const body: unknown = await core.connectGetNamespacedPodProxyWithPath(
        {
          name: `${target.podName}:${PLUGIN_RUNTIME_STATUS_PORT}`,
          namespace: target.namespace,
          path: target.path.slice(1),
        },
        options,
      );
      return { body };
    } catch (error) {
      if (error instanceof RuntimeStatusOversized) {
        return new DependencyUnavailableError(protocolFailureMessages.oversized);
      }
      if (error instanceof RuntimeStatusRedirected) {
        return new DependencyUnavailableError(protocolFailureMessages.redirect);
      }
      if (unsolicitedInterimResponse(error)) {
        return new DependencyUnavailableError(protocolFailureMessages.interim);
      }
      const status = numericErrorStatus(error);
      if (status === 404 || status === 503) {
        return undefined;
      }
      if (status !== undefined && status >= 300 && status <= 399) {
        return new DependencyUnavailableError(protocolFailureMessages.redirect);
      }
      throw error;
    }
  }

  const outcome = await request(readOnce).catch((error: unknown) => {
    if (target.container === "gateway" && target.path === RUNTIME_DIAGNOSTICS_PATH) {
      throw new RuntimeDiagnosticsTransportError();
    }
    throw error;
  });
  if (outcome instanceof DependencyUnavailableError) {
    throw outcome;
  }
  return outcome === undefined ? undefined : { body: decodeRuntimeStatus(outcome.body) };
}

const MAX_RUNTIME_STATUS_RESPONSE_BYTES = 65_536;

class RuntimeStatusOversized extends Error {}
class RuntimeStatusRedirected extends Error {}

/**
 * undici's refusal of an interim answer the request never asked for: a `100 Continue`
 * ("bad response") or a `101` without an upgrade request ("bad upgrade"). The peer chose that
 * answer, so retrying is unlikely to change it.
 * The texts are undici's (`lib/dispatcher/client-h1.js` `onHeadersComplete`, undici 8.11.2):
 * recheck them when undici changes, or these answers fall back to the generic retry.
 */
function unsolicitedInterimResponse(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (
      (current as { readonly code?: unknown }).code === "UND_ERR_SOCKET" &&
      (current.message === "bad response" || current.message === "bad upgrade")
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Reads a Pod proxy response up to the status limit instead of buffering all of it.
 * Error bodies are capped too: the client reads them unbounded for its exception.
 */
async function limitRuntimeStatusBody(response: ResponseContext): Promise<ResponseContext> {
  const stream = response.body.stream();
  if (response.httpStatusCode >= 300 && response.httpStatusCode <= 399) {
    // The status is already decisive; do not wait for an untrusted redirect body.
    try {
      if (stream !== null) {
        void stream.cancel().catch(() => {});
      }
    } catch {
      // A cancellation failure must not make this redirect retryable.
    }
    throw new RuntimeStatusRedirected();
  }
  if (stream !== null) {
    let bytes = await readCappedBody(stream, MAX_RUNTIME_STATUS_RESPONSE_BYTES);
    if (bytes === undefined) {
      // The status code still classifies an error whose body exceeds the limit.
      if (response.httpStatusCode < 200 || response.httpStatusCode > 299) {
        bytes = Buffer.alloc(0);
      } else {
        throw new RuntimeStatusOversized();
      }
    }
    response.body = {
      text: async () => new TextDecoder().decode(bytes),
      binary: async () => bytes,
      stream: () => null,
    };
  }
  return response;
}

let runtimeStatusRequestOptions: Promise<ConfigurationOptions> | undefined;

function runtimeStatusOptions(): Promise<ConfigurationOptions> {
  runtimeStatusRequestOptions ??= import("@kubernetes/client-node").then((sdk) => ({
    // The shared clients already refuse redirects; the Pod-written read does not rely on that.
    httpApi: nonRedirectingHttpLibrary(sdk),
    middleware: [
      {
        pre: (request) => new sdk.Observable(Promise.resolve(request)),
        post: (response) => new sdk.Observable(limitRuntimeStatusBody(response)),
      },
    ],
    middlewareMergeStrategy: "append",
  }));
  return runtimeStatusRequestOptions;
}

function decodeRuntimeStatus(value: unknown): unknown {
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_RUNTIME_STATUS_RESPONSE_BYTES) {
      throw new DependencyUnavailableError(protocolFailureMessages.oversized);
    }
    try {
      return JSON.parse(value);
    } catch {
      throw new DependencyUnavailableError("Runtime status returned invalid data.");
    }
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new DependencyUnavailableError("Runtime status returned invalid data.");
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") > MAX_RUNTIME_STATUS_RESPONSE_BYTES
  ) {
    throw new DependencyUnavailableError(protocolFailureMessages.oversized);
  }
  return value;
}
