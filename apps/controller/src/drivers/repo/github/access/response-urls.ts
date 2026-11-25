import type { RequestHead } from "../../access/backend-contracts.ts";

interface UrlRewriteDependencies {
  readonly repository: string;
  readonly repositoryId: string;
  readonly apiOrigin: string;
  readonly gatewayOrigin: string;
  readonly allowsRoute: (head: RequestHead) => boolean;
}

function rewriteUrl(
  value: string,
  purpose: RegExp | undefined,
  dependencies: UrlRewriteDependencies,
): string {
  const url = new URL(value);
  if (
    (url.origin !== dependencies.apiOrigin && url.origin !== "https://api.github.com") ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("unsafe-upstream-url");
  }
  const prefix = `/repos/${dependencies.repository}`;
  const nativePrefix = `/repositories/${dependencies.repositoryId}`;
  if (url.pathname === nativePrefix || url.pathname.startsWith(`${nativePrefix}/`)) {
    url.pathname = `${prefix}${url.pathname.slice(nativePrefix.length)}`;
  }
  const namedPrefix = url.pathname.slice(0, prefix.length);
  if (
    url.pathname.startsWith("/repos/") &&
    namedPrefix.slice("/repos/".length).toLowerCase() === dependencies.repository.toLowerCase() &&
    (url.pathname.length === prefix.length || url.pathname[prefix.length] === "/")
  ) {
    url.pathname = `${prefix}${url.pathname.slice(prefix.length)}`;
  }
  if (
    purpose &&
    (!url.pathname.startsWith(prefix) || !purpose.test(url.pathname.slice(prefix.length)))
  ) {
    throw new Error("unsafe-upstream-url");
  }
  const target = `${url.pathname}${url.search}`;
  if (
    !dependencies.allowsRoute({
      method: "GET",
      rawTarget: target,
      headers: {},
      receivedMonoMs: 0,
      contentEncoding: "identity",
      framing: { kind: "none", bytes: undefined },
    })
  ) {
    throw new Error("unsafe-upstream-url");
  }
  return `${dependencies.gatewayOrigin}${target}`;
}

export function createUrlRewriter(
  dependencies: UrlRewriteDependencies,
): (value: string, purpose?: RegExp) => string {
  return (value, purpose) => rewriteUrl(value, purpose, dependencies);
}

export function rewritePaginationLinks(value: string, rewrite: (url: string) => string): string {
  return value
    .split(",")
    .map((part) => {
      const match = /^\s*<([^<>]+)>;\s*rel="(next|prev|first|last)"\s*$/.exec(part);
      if (!match) {
        throw new Error("unsafe-upstream-url");
      }
      return `<${rewrite(match[1]!)}>; rel="${match[2]}"`;
    })
    .join(", ");
}
