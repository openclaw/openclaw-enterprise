import type { SandboxHarnessContext } from "@openclaw-enterprise/contracts";

type UnavailableMaterial = "repository credentials" | "plugin-runtime configuration";

// These are the representations emitted by the ordinary runtime adapters.
// A path, inline document, or ready-marker name does not prove provider delivery.
const pluginMaterialEnvironment = new Set([
  "OPENCLAW_PLUGIN_RUNTIME_MANIFEST",
  "OPENCLAW_PLUGIN_CODEX_CONFIG_TOML",
  "OPENCLAW_PLUGIN_RUNTIME_JSON",
  "OPENCLAW_PLUGIN_READY_MARKER",
]);

/** Material the selected OpenShell adapter cannot currently deliver. */
export function unavailableOpenShellMaterial(
  context: Pick<SandboxHarnessContext, "revision" | "requirements">,
): readonly UnavailableMaterial[] {
  const unavailable: UnavailableMaterial[] = [];
  if (context.revision.repositoryCredentials !== undefined) {
    unavailable.push("repository credentials");
  }
  if (
    context.revision.harness.id === "codex" ||
    context.revision.plugins !== undefined ||
    context.requirements.environment.some((entry) => pluginMaterialEnvironment.has(entry.name))
  ) {
    // Even plugin-free Codex reads the revision's runtime.json and config.toml.
    unavailable.push("plugin-runtime configuration");
  }
  // TODO(material delivery): replace this refusal only when an accepted producer
  // binds the complete material set to the current revision and provider workload,
  // including revalidation after restart/replacement. PVC paths are not that proof.
  return unavailable;
}
