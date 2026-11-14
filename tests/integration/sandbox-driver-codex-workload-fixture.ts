import type {
  SandboxEnvironmentVariable,
  SandboxWorkloadFile,
} from "../../packages/contracts/src/index.ts";

export const defaultCodexRuntimeManifest = JSON.stringify({ kind: "codex", selections: {} });
export const defaultCodexConfig = "[features]\nplugins = false\n";

export function codexAppServerEnvironment() {
  return [
    { name: "APP_SERVER_PORT", value: "8080" },
    { name: "APP_TOKEN_SHA", value: "a".repeat(64) },
  ] satisfies SandboxEnvironmentVariable[];
}

export function codexManagedRuntimeFiles(
  runtimeManifest = defaultCodexRuntimeManifest,
  codexConfig = defaultCodexConfig,
) {
  return [
    {
      name: "runtime.json",
      content: runtimeManifest,
      environmentVariable: "OPENCLAW_PLUGIN_RUNTIME_MANIFEST",
    },
    {
      name: "config.toml",
      content: codexConfig,
      environmentVariable: "OPENCLAW_PLUGIN_CODEX_CONFIG_TOML",
    },
  ] satisfies SandboxWorkloadFile[];
}
