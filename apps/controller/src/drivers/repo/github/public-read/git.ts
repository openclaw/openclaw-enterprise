import type { IncomingMessage, ServerResponse } from "node:http";
import { request, type Agent } from "node:https";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { canonicalPublicGithubRepository } from "./access.ts";

const requestLimit = 4 * 1024 * 1024;
const responseLimit = 1024 * 1024 * 1024;
const deadline = 10 * 60 * 1000;

export interface PublicGithubGitRoute {
  repository: string;
  target: string;
  discovery: boolean;
}

export function publicGithubGitRoute(target: string): PublicGithubGitRoute | undefined {
  // Parse the original target without URL dot-segment or percent normalization.
  const match = target.match(
    /^\/git\/([^/?]+)\/([^/?]+)\.git\/(info\/refs\?service=git-upload-pack|git-upload-pack)$/,
  );
  if (!match) {
    return;
  }
  const repository = canonicalPublicGithubRepository(`${match[1]}/${match[2]}`);
  if (!repository) {
    return;
  }
  return {
    repository,
    target: `/${repository}.git/${match[3]}`,
    discovery: match[3]!.startsWith("info/"),
  };
}

export function publicGithubGitRequestError(
  req: IncomingMessage,
  route: PublicGithubGitRoute,
): number | undefined {
  if (req.method !== (route.discovery ? "GET" : "POST")) {
    return 405;
  }
  if (
    req.headers["git-protocol"] !== undefined &&
    !/^version=[12]$/.test(String(req.headers["git-protocol"]))
  ) {
    return 400;
  }
  if (route.discovery) {
    return req.headers["transfer-encoding"] !== undefined ||
      Number(req.headers["content-length"] ?? 0) !== 0
      ? 400
      : undefined;
  }
  const length = req.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > requestLimit)) {
    return 413;
  }
  if (
    req.headers["content-type"] !== "application/x-git-upload-pack-request" ||
    (req.headers["content-encoding"] !== undefined &&
      !["identity", "gzip"].includes(String(req.headers["content-encoding"]))) ||
    (req.headers["transfer-encoding"] !== undefined &&
      req.headers["transfer-encoding"] !== "chunked")
  ) {
    return 400;
  }
  return;
}

function bounded(limit: number) {
  let length = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      length += chunk.length;
      callback(
        length > limit ? new Error("Public GitHub transfer exceeded its byte limit.") : null,
        chunk,
      );
    },
  });
}

export function publicGithubGitFailure(
  res: ServerResponse,
  status: number,
  text: string,
  headers: Record<string, string> = {},
) {
  if (!res.headersSent && !res.destroyed) {
    res
      .writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...headers,
      })
      .end(JSON.stringify({ message: text }));
  } else if (!res.writableFinished) {
    res.destroy();
  }
}

export async function streamPublicGithubGit(
  req: IncomingMessage,
  res: ServerResponse,
  route: PublicGithubGitRoute,
  agent: Agent,
  rateLimited: (headers: IncomingMessage["headers"]) => Record<string, string>,
): Promise<void> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), deadline).unref();
  const cancel = () => {
    if (!res.writableFinished) {
      abort.abort();
    }
  };
  res.once("close", cancel);
  req.once("aborted", cancel);
  // Construct only fixed protocol headers. In particular, neither the capability
  // nor cookies, proxy credentials, arbitrary headers or provider tokens survive.
  const headers: Record<string, string> = {
    accept: route.discovery
      ? "application/x-git-upload-pack-advertisement"
      : "application/x-git-upload-pack-result",
    "accept-encoding": "identity",
    "user-agent": "openclaw-enterprise-public-github-read",
  };
  const protocol = req.headers["git-protocol"];
  if (typeof protocol === "string" && /^version=[12]$/.test(protocol)) {
    headers["git-protocol"] = protocol;
  }
  if (!route.discovery) {
    headers["content-type"] = "application/x-git-upload-pack-request";
    if (req.headers["content-length"] !== undefined) {
      headers["content-length"] = req.headers["content-length"];
    }
    if (req.headers["content-encoding"] === "gzip") {
      headers["content-encoding"] = "gzip";
    }
  }
  const upstream = request("https://github.com" + route.target, {
    method: req.method,
    headers,
    agent,
    signal: abort.signal,
  });
  const stopped = new Promise<void>((resolve) => upstream.once("close", resolve));
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    upstream.once("response", resolve);
    upstream.once("error", reject);
  });
  const upload = route.discovery
    ? (upstream.end(), Promise.resolve())
    : pipeline(req, bounded(requestLimit), upstream);
  // Attach immediately: an upload can fail before the provider sends headers.
  const uploading = upload.catch((error: unknown) => {
    abort.abort();
    throw error;
  });
  void uploading.catch(() => {});
  try {
    const provider = await response;
    const status = provider.statusCode ?? 502;
    const throttled =
      status === 429 ||
      (status === 403 &&
        (provider.headers["x-ratelimit-remaining"] === "0" ||
          provider.headers["retry-after"] !== undefined));
    const retry =
      throttled || provider.headers["x-ratelimit-remaining"] === "0"
        ? rateLimited(provider.headers)
        : {};
    if (status !== 200) {
      publicGithubGitFailure(
        res,
        throttled ? 429 : status === 404 ? 404 : 502,
        "GitHub did not return the public repository. Redirects are not followed.",
        throttled ? retry : {},
      );
      provider.destroy();
      return;
    }
    const expected = route.discovery
      ? "application/x-git-upload-pack-advertisement"
      : "application/x-git-upload-pack-result";
    const length = provider.headers["content-length"];
    if (
      provider.headers["content-type"] !== expected ||
      (provider.headers["content-encoding"] !== undefined &&
        provider.headers["content-encoding"] !== "identity") ||
      (length !== undefined && (!/^\d+$/.test(length) || Number(length) > responseLimit))
    ) {
      publicGithubGitFailure(
        res,
        502,
        "GitHub returned an unsupported or oversized Git representation.",
      );
      provider.destroy();
      return;
    }
    res.writeHead(200, {
      "content-type": expected,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    await Promise.all([uploading, pipeline(provider, bounded(responseLimit), res)]);
  } catch {
    publicGithubGitFailure(
      res,
      abort.signal.aborted ? 504 : 502,
      "The public GitHub transfer did not complete.",
    );
  } finally {
    clearTimeout(timer);
    res.removeListener("close", cancel);
    req.removeListener("aborted", cancel);
    upstream.destroy();
    // Keep the shared provider slot until cancellation has stopped the socket.
    await stopped;
    await uploading.catch(() => {});
  }
}
