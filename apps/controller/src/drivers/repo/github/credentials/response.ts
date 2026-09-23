import type {
  HeaderFields,
  RequestHead,
  ResponsePolicy,
} from "../../credentials/backend-contracts.ts";
import { classifyResource, createResourceRewriter } from "./response-resources.ts";
import { createUrlRewriter, rewritePaginationLinks } from "./response-urls.ts";

interface ResponsePolicyOptions {
  readonly repository: string;
  readonly repositoryId: string;
  readonly apiOrigin: string;
  readonly gatewayOrigin: string;
}

function responseBody(git: boolean, rawResponse: boolean): ResponsePolicy["body"] {
  if (git) {
    return "stream";
  }
  return rawResponse ? "bounded-raw" : "bounded-json";
}

function rewriteHeaders(
  git: boolean,
  status: number,
  headers: HeaderFields,
  rewriteUrl: (value: string) => string,
): HeaderFields {
  if (status >= 300 && status < 400) {
    throw new Error("upstream-redirect");
  }
  const output: Record<string, string> = {};
  for (const name of [
    "content-type",
    "cache-control",
    "expires",
    "pragma",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-ratelimit-used",
    "x-ratelimit-resource",
  ]) {
    const value = headers[name];
    if (value !== undefined && value.length <= 2048 && !/[\r\n]/.test(value)) {
      output[name] = value;
    }
  }
  const retry = headers["retry-after"];
  if (retry !== undefined && /^[0-9]{1,10}$/.test(retry)) {
    output["retry-after"] = retry;
  }
  const link = headers.link;
  if (link === undefined) {
    return Object.freeze(output);
  }
  if (git || link.length > 8192) {
    throw new Error("unsafe-upstream-url");
  }
  output.link = rewritePaginationLinks(link, rewriteUrl);
  return Object.freeze(output);
}

export function createResponsePolicy(
  options: ResponsePolicyOptions,
  allowsRoute: (head: RequestHead) => boolean,
): (git: boolean, target: string, rawResponse?: boolean) => ResponsePolicy {
  const rewriteUrl = createUrlRewriter({ ...options, allowsRoute });
  return (git, target, rawResponse = false) =>
    Object.freeze({
      body: responseBody(git, rawResponse),
      rewriteJson:
        git || rawResponse
          ? undefined
          : createResourceRewriter(classifyResource(options.repository, target), { rewriteUrl }),
      headers: (status: number, headers: HeaderFields) =>
        rewriteHeaders(git, status, headers, rewriteUrl),
    });
}
