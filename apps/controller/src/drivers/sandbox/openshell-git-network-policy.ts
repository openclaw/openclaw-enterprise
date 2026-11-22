import type { OpenShellProviderProfileEndpoint } from "./openshell-gateway-client.ts";

export type OpenShellGitNetworkTarget =
  | { readonly repository: string; readonly installationId?: never }
  | { readonly repository?: never; readonly installationId: string };

const binaries = Object.freeze([
  "/usr/bin/git",
  "/usr/lib/git-core/git-remote-https",
  "/usr/lib/git-core/git-remote-http",
  "/usr/libexec/git-core/git-remote-https",
  "/usr/libexec/git-core/git-remote-http",
  "/usr/bin/curl",
  "/usr/local/bin/node",
  "/usr/bin/node",
]);

export function openShellGitNetworkDefaults(target: OpenShellGitNetworkTarget) {
  return {
    binaries: target.installationId ? [...binaries, "/usr/bin/gh", "/usr/local/bin/gh"] : binaries,
    gitOrigin: "https://github.com",
    apiOrigin: "https://api.github.com",
  };
}

/**
 * The OpenShell Git rules bind only the github.com origins above. Why another prepared GitHub
 * origin (or none) is refused, and what to do; undefined only for api.github.com. Names host and
 * port only, never user info, a path or a query, in text the worker log keeps (no commas).
 */
export function openShellGitOriginRefusal(apiOrigin: string): string | undefined {
  if (apiOrigin === "https://api.github.com") {
    return undefined;
  }
  let selected = "not an https origin";
  if (typeof apiOrigin === "string" && URL.canParse(apiOrigin)) {
    const url = new URL(apiOrigin);
    selected = `${url.hostname}:${url.port || (url.protocol === "http:" ? "80" : "443")}`;
  }
  return `repository.openShell reaches only https://github.com and https://api.github.com but repository.preparedGitHub.apiOrigin is ${selected}. Remove apiOrigin to use github.com: repository.openShell supports no other GitHub origin.`;
}

/** OpenShell imports these endpoints into the Sandbox policy when attaching the Git Provider. */
export function openShellGitEndpoints(
  git: URL,
  api: URL,
  target: OpenShellGitNetworkTarget,
): readonly OpenShellProviderProfileEndpoint[] {
  return target.installationId
    ? [
        {
          host: git.hostname,
          port: 443,
          protocol: "rest",
          rules: [
            { allow: { method: "GET", path: "/**/info/refs" } },
            { allow: { method: "POST", path: "/**/git-upload-pack" } },
            { allow: { method: "POST", path: "/**/git-receive-pack" } },
          ],
        },
        {
          host: api.hostname,
          port: 443,
          protocol: "rest",
          access: "NETWORK_ACCESS_PRESET_FULL",
        },
        {
          host: api.hostname,
          port: 443,
          protocol: "graphql",
          path: "/graphql",
          access: "NETWORK_ACCESS_PRESET_FULL",
        },
      ]
    : [
        {
          host: git.hostname,
          port: Number(git.port || 443),
          protocol: "rest",
          path: "/" + target.repository + ".git/**",
        },
        {
          host: api.hostname,
          port: Number(api.port || 443),
          protocol: "rest",
          path: "/repos/" + target.repository + "/pulls",
        },
      ];
}
