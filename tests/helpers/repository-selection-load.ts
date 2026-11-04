import assert from "node:assert/strict";
import { registerHooks } from "node:module";

export type RepositorySelectionMode = "none" | "protected" | "native";

const [mode, configurationPath, packageRoot] = process.argv.slice(2);
assert.ok(mode === "none" || mode === "protected" || mode === "native");
assert.ok(configurationPath);
assert.ok(packageRoot);

const loader = new URL(
  "../../apps/controller/src/composition/installation-config.ts",
  import.meta.url,
);
const nativeModules = new Set(
  [
    "../drivers/repo/github/driver.ts",
    "../backends/repository-credentials/control-client.ts",
    "./repository-credentials/public-ca.ts",
  ].map((path) => new URL(path, loader).href),
);
const resolvedNativeModules = new Set<string>();
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (nativeModules.has(resolved.url)) {
      resolvedNativeModules.add(resolved.url);
    }
    return resolved;
  },
});

const { loadInstallationConfiguration } =
  await import("../../apps/controller/src/composition/installation-config.ts");
const runtime = await loadInstallationConfiguration({
  mode: "production",
  environment: { OCC_CONFIG_PATH: configurationPath },
  packageRoot,
});
assert.ok(runtime);
try {
  assert.deepEqual(resolvedNativeModules, mode === "native" ? nativeModules : new Set());
  assert.equal(runtime.repositoryPolicy !== undefined, mode !== "none");
  assert.equal(runtime.nativeRepositorySender !== undefined, mode === "native");
  assert.equal(runtime.protectedDriver !== undefined, mode === "protected");
} finally {
  await runtime.protectedDriver?.close();
}
