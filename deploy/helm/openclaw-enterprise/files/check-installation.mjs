import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The pre-upgrade initialization Job runs this in the release's controller image
// before migration and before Helm replaces the API Pod, which uses the Recreate
// strategy. It loads the Installation Secret as API and worker startup do: Drivers,
// Preset files and the repository registry it names. It also loads the Console theme
// bundle with the API's loader when the chart mounts one. It never opens the database or
// the Kubernetes API, so Kubernetes Compute preflight is not repeated. A refusal fails
// the hook and leaves the running Pods serving. Errors are one line on stderr and
// identify rejected fields without their values; Preset file errors also identify the file.
const prefix = "installation-check: API and worker startup would refuse the Installation";
const themePrefix = "installation-check: API startup would refuse";

let formatConfigurationFailure;
try {
  ({ formatStartupConfigurationFailure: formatConfigurationFailure } = await import(
    pathToFileURL(resolve("apps/controller/src/startup-failure.ts")).href
  ));
  const { loadConsoleTheme } = await import(
    pathToFileURL(resolve("apps/controller/src/composition/console-theme.ts")).href
  );
  // The API loads the theme first and stops with CONSOLE_THEME_INVALID; unset loads nothing.
  await loadConsoleTheme(process.env.OCC_CONSOLE_THEME_DIR);
  const { loadInstallationConfiguration, loadStartupConfigurationSnapshot } = await import(
    pathToFileURL(resolve("apps/controller/src/composition/installation-config.ts")).href
  );
  const startupConfiguration = await loadStartupConfigurationSnapshot({ mode: "production" });
  await loadInstallationConfiguration({ mode: "production", startupConfiguration });
} catch (error) {
  let message = (
    formatConfigurationFailure?.(error) ?? (error instanceof Error ? error.message : String(error))
  ).replace(/\s+/g, " ");
  if (error?.name === "ConsoleThemeError") {
    process.stderr.write(`${themePrefix} (CONSOLE_THEME_INVALID): ${message}\n`);
  } else if (error?.name === "PresetFileError") {
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
