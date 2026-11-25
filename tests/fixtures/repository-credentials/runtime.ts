import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

export const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const appRoot =
  process.env.REPOSITORY_CREDENTIALS_APP_ROOT ?? join(repositoryRoot, "apps/controller/src");
export const appExtension = appRoot.endsWith("/dist") ? "js" : "ts";
export async function appModule(path: string): Promise<unknown> {
  return import(pathToFileURL(resolve(appRoot, `${path}.${appExtension}`)).href);
}

export function credentialDriverModule(path: string) {
  return appModule(
    path.startsWith("client/")
      ? `drivers/repo/github/access/${path}`
      : `drivers/repo/access/${path}`,
  );
}
export function githubProviderModule(path: string) {
  return appModule(`drivers/repo/github/access/${path}`);
}
export function credentialCompositionModule(path: string) {
  return appModule(`composition/repository-credentials/${path}`);
}
export function credentialClientPath(name: string) {
  return resolve(appRoot, `drivers/repo/github/access/client/${name}.${appExtension}`);
}
