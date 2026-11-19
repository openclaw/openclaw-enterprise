import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The pre-upgrade initialization Job runs this in the release's controller image
// before migration and before Helm replaces the API Pod, which uses the Recreate
// strategy. It loads the Installation Secret as API and worker startup do: Drivers,
// Preset files, the repository registry, the prepared GitHub issuer CA, and the
// token grant JWT trust bundle. It compares its listeners with the chart's
// (OCC_EGRESS_AUTHORITY_PORT, OCC_OPENSHELL_GIT_PORT, OCC_TOKEN_GRANT_PORT),
// selected private Gateway routing (OCC_CHART_GATEWAY_ROUTING),
// and its TLS and issuer file paths with the chart's mounts.
// It reads no private key or custody file. It also loads the Console theme
// bundle with the API's loader when the chart mounts one. It never opens the database or
// the Kubernetes API, so Kubernetes Compute preflight is not repeated. A refusal fails
// the hook and leaves the running Pods serving. Errors are one line on stderr and
// identify rejected fields without their values; Preset file errors also identify the file.
const prefix = "installation-check: API and worker startup would refuse the Installation";
const themePrefix = "installation-check: API startup would refuse";

type ErrorName = { name?: unknown } | null | undefined;

type FormatConfigurationFailure =
  typeof import("../../../apps/controller/src/startup-failure.ts").formatStartupConfigurationFailure;

let formatConfigurationFailure: FormatConfigurationFailure | undefined;
try {
  ({ formatStartupConfigurationFailure: formatConfigurationFailure } = (await import(
    pathToFileURL(resolve("apps/controller/src/startup-failure.ts")).href
  )) as typeof import("../../../apps/controller/src/startup-failure.ts"));
  const { loadConsoleTheme } = (await import(
    pathToFileURL(resolve("apps/controller/src/composition/console-theme.ts")).href
  )) as typeof import("../../../apps/controller/src/composition/console-theme.ts");
  // The API loads the theme first and stops with CONSOLE_THEME_INVALID; unset loads nothing.
  await loadConsoleTheme(process.env.OCC_CONSOLE_THEME_DIR);
  const { loadInstallationConfiguration, loadStartupConfigurationSnapshot } = (await import(
    pathToFileURL(resolve("apps/controller/src/composition/installation-config.ts")).href
  )) as typeof import("../../../apps/controller/src/composition/installation-config.ts");
  const startupConfiguration = await loadStartupConfigurationSnapshot({ mode: "production" });
  await loadInstallationConfiguration({
    mode: "production",
    startupConfiguration,
    validateTokenGrantBundle: true,
  });
} catch (error) {
  let message = (
    formatConfigurationFailure?.(error) ?? (error instanceof Error ? error.message : String(error))
  ).replace(/\s+/g, " ");
  if ((error as ErrorName)?.name === "ConsoleThemeError") {
    process.stderr.write(`${themePrefix} (CONSOLE_THEME_INVALID): ${message}\n`);
  } else if ((error as ErrorName)?.name === "ChartListenerMismatchError") {
    process.stderr.write(`${prefix} (${(error as { code?: unknown }).code}): ${message}\n`);
  } else if ((error as ErrorName)?.name === "PresetFileError") {
    if (!message.includes("presets.files")) {
      message = `presets.files: ${message}`;
    }
    process.stderr.write(`${prefix} (PRESET_FILE_INVALID): ${message}\n`);
  } else {
    process.stderr.write(`${prefix}: ${message}\n`);
  }
  process.exit(1);
}
process.stdout.write("installation-startup-ready\n");
// Drivers may hold handles open; the hook must finish rather than wait for them.
process.exit(0);
