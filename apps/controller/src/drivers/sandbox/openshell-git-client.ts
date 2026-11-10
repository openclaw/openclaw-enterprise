export function openShellGitGrantPrelude(repositoryUrl: string): string {
  const headerKey = `http.${repositoryUrl}.extraHeader`;
  // Send the handle on Git's first request without depending on an origin challenge.
  return String.raw`{
  const handle = process.env.GITHUB_TOKEN;
  if (!handle || !/^openshell:resolve:env:g[0-9a-f]{64}_GITHUB_TOKEN$/.test(handle)) {
    throw new Error("OpenShell Git credential placeholder is unavailable.");
  }
  process.env.GIT_CONFIG_KEY_4 = ${JSON.stringify(headerKey)};
  process.env.GIT_CONFIG_VALUE_4 = "Authorization: Basic " + Buffer.from("x-access-token:" + handle).toString("base64");
  process.env.GIT_CONFIG_COUNT = "5";
}
`;
}
