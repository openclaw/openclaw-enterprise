import { join } from "node:path";
import type { ClientFiles } from "./config.ts";

export const repositoryClientPath =
  "/opt/oce/repository-credentials/bin:/usr/local/bin:/usr/bin:/bin";

const inheritedRuntimeEnvironment = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "GIT_SSL_CAINFO",
  "NODE_EXTRA_CA_CERTS",
] as const;

export function createClientEnvironment(
  configuration: ClientFiles,
  sessionDirectory: string,
  home: string,
): NodeJS.ProcessEnv {
  // gh uses only the selected private hosts file. Native child Git still reads
  // the image's system include and the user's normal HOME/configuration.
  const env: NodeJS.ProcessEnv = {
    PATH: repositoryClientPath,
    HOME: home,
    ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "dumb",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GH_CONFIG_DIR: join(sessionDirectory, "gh"),
    GH_HOST: "github.com",
    GH_REPO: `github.com/${configuration.client.repository}`,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    GH_BROWSER: "/bin/false",
    BROWSER: "/bin/false",
    GH_PAGER: "cat",
    PAGER: "cat",
  };
  for (const name of inheritedRuntimeEnvironment) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }
  if (configuration.hasPublicCa) {
    const ca = join(sessionDirectory, "ca.pem");
    env.SSL_CERT_FILE ??= ca;
    env.GIT_SSL_CAINFO ??= ca;
    env.NODE_EXTRA_CA_CERTS ??= ca;
  }
  return env;
}
