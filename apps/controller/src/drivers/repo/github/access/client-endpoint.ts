export function createGitHubClientEndpoint(gatewayOrigin: string, repository: string) {
  return {
    gatewayOrigin,
    gitRemote: `${gatewayOrigin}/${repository}.git`,
    gitUsername: "gateway-session",
    canonicalApiHost: "github.com",
    apiHost: new URL(gatewayOrigin).hostname,
  };
}
