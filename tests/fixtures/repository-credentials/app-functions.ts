import { appModule } from "./runtime.mjs";

type AppModules = {
  "drivers/repo/access/service": Pick<
    typeof import("../../../apps/controller/src/drivers/repo/access/service.ts"),
    "createCredentialService"
  >;
  "drivers/repo/access/session-construction": Pick<
    typeof import("../../../apps/controller/src/drivers/repo/access/session-construction.ts"),
    "preparedSessionConstructor"
  >;
  "drivers/repo/access/development-session": Pick<
    typeof import("../../../apps/controller/src/drivers/repo/access/development-session.ts"),
    "developmentSessionConstructor"
  >;
  "drivers/repo/github/access/factory": Pick<
    typeof import("../../../apps/controller/src/drivers/repo/github/access/factory.ts"),
    "createGitHubDriverFactory"
  >;
  "drivers/repo/github/access/static-token": Pick<
    typeof import("../../../apps/controller/src/drivers/repo/github/access/static-token.ts"),
    "createGitHubStaticTokenOwner"
  >;
  "drivers/repo/access/configuration": Pick<
    typeof import("../../../apps/controller/src/drivers/repo/access/configuration.ts"),
    "validateServiceConfig"
  >;
  "drivers/repo/access/sessions": Pick<
    typeof import("../../../apps/controller/src/drivers/repo/access/sessions.ts"),
    "admitSession"
  >;
  "drivers/repo/access/custody": Pick<
    typeof import("../../../apps/controller/src/drivers/repo/access/custody.ts"),
    "createCustody"
  >;
  "drivers/repo/github/access/config": Pick<
    typeof import("../../../apps/controller/src/drivers/repo/github/access/config.ts"),
    "validateGitHubConfiguration"
  >;
};

const loadAppModule: (path: keyof AppModules) => Promise<unknown> = appModule;

export async function appFunction<
  Path extends keyof AppModules,
  Name extends keyof AppModules[Path],
>(path: Path, name: Name): Promise<AppModules[Path][Name]> {
  const module = await loadAppModule(path);
  const entry: unknown =
    module !== null && typeof module === "object" ? Reflect.get(module, name) : undefined;
  if (typeof entry !== "function") {
    throw new TypeError(`Credential fixture export is unavailable: ${path}.${String(name)}`);
  }
  // runtime.mjs selects either this source module or its emitted JavaScript.
  return entry as AppModules[Path][Name];
}
