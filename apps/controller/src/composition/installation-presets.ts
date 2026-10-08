import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isName,
  NAME_RULE,
  validatePresetTemplate,
  type Preset,
} from "@openclaw-enterprise/contracts";
import type { BundledPresetVersion } from "@openclaw-enterprise/occ";
import { closed, type ConfigurationRecord, nonempty, object } from "./startup-file.ts";

/** A bundled default skipped because a `presets.files` entry uses its name. */
export interface ShadowedDefaultPreset {
  readonly presetName: string;
  /** Resolved path of the operator's file. */
  readonly presetFile: string;
}

function presetDefinition(value: unknown, path: string): Pick<Preset, "name" | "template"> {
  const preset = object(value, path);
  closed(preset, ["name", "template"], path);
  const name = nonempty(preset.name, `${path}.name`);
  if (!isName(name)) {
    throw new Error(`${path}.name must follow the Name rule: ${NAME_RULE}.`);
  }
  return Object.freeze({
    name,
    template: validatePresetTemplate(preset.template),
  });
}

/**
 * A `presets.files` list or entry that cannot become a default Preset: not a list of
 * paths, or a file that is missing, unreadable, malformed, invalid, or a duplicate name. API and worker startup report it as
 * `PRESET_FILE_INVALID` without the path or message, which stay in the thrown error.
 */
export class PresetFileError extends Error {
  override readonly name = "PresetFileError";
}

async function loadPresetDefinition(
  path: string | URL,
): Promise<Pick<Preset, "name" | "template">> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    throw new Error(`Preset file ${path} is unavailable.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`Preset file ${path} must contain valid JSON.`);
  }
  return presetDefinition(parsed, `Preset file ${path}`);
}

const bundledPresetDirectory = new URL("../../../../deploy/presets/", import.meta.url);

/**
 * Load every shipped version of the bundled defaults. `archive/versions.json` lists each
 * bundled file's versions oldest first; the last is the file itself and the others are
 * archived as `archive/<file stem>/<version>.json`. A conformance test keeps it complete.
 */
async function loadBundledPresetVersions(): Promise<readonly BundledPresetVersion[]> {
  const indexPath = new URL("archive/versions.json", bundledPresetDirectory);
  let index: unknown;
  try {
    index = JSON.parse(await readFile(indexPath, "utf8"));
  } catch (cause) {
    throw new Error(
      `Bundled Preset version index ${fileURLToPath(indexPath)} is unavailable or invalid.`,
      { cause },
    );
  }
  const versions: BundledPresetVersion[] = [];
  for (const [file, history] of Object.entries(object(index, "Bundled Preset versions"))) {
    if (
      !/^[a-z0-9-]+\.json$/.test(file) ||
      !Array.isArray(history) ||
      history.length === 0 ||
      history.some((version) => typeof version !== "string" || !/^[0-9a-f]{16}$/.test(version))
    ) {
      throw new Error(`Bundled Preset versions for ${file} are invalid.`);
    }
    const stem = file.slice(0, -".json".length);
    for (const [position, version] of (history as string[]).entries()) {
      const current = position === history.length - 1;
      const preset = await loadPresetDefinition(
        new URL(current ? file : `archive/${stem}/${version}.json`, bundledPresetDirectory),
      );
      versions.push(Object.freeze({ ...preset, file, version, current }));
    }
  }
  return Object.freeze(versions);
}

export async function loadInstallationPresets(
  configuration: ConfigurationRecord,
  configurationPath: string | undefined,
): Promise<{
  readonly includeDefaults: boolean;
  readonly bundledPresetVersions: readonly BundledPresetVersion[];
  readonly defaultPresets: Pick<Preset, "name" | "template">[];
  readonly shadowedDefaultPresets: ShadowedDefaultPreset[];
}> {
  const presets = object(
    configuration.presets === undefined ? {} : configuration.presets,
    "presets",
  );
  closed(presets, ["includeDefaults", "files"], "presets");
  if (presets.includeDefaults !== undefined && typeof presets.includeDefaults !== "boolean") {
    throw new Error("presets.includeDefaults must be a boolean.");
  }
  if (
    presets.files !== undefined &&
    (!Array.isArray(presets.files) || presets.files.some((entry) => typeof entry !== "string"))
  ) {
    throw new PresetFileError("presets.files must be an array of Preset JSON file paths.");
  }
  const includeDefaults = presets.includeDefaults === true;
  const bundledPresetVersions = await loadBundledPresetVersions();
  const filePresets: {
    readonly path: string;
    readonly preset: Pick<Preset, "name" | "template">;
  }[] = [];
  const filePresetPaths = new Map<string, string>();
  for (const entry of (presets.files ?? []) as readonly string[]) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      throw new PresetFileError("presets.files entries must be nonempty file paths.");
    }
    if (!isAbsolute(trimmed) && configurationPath === undefined) {
      throw new PresetFileError(
        "Relative presets.files entries require an Installation startup YAML path.",
      );
    }
    const path = isAbsolute(trimmed) ? trimmed : resolve(dirname(configurationPath!), trimmed);
    let preset: Pick<Preset, "name" | "template">;
    try {
      preset = await loadPresetDefinition(path);
    } catch (error) {
      throw new PresetFileError(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
    }
    const earlier = filePresetPaths.get(preset.name);
    if (earlier !== undefined) {
      throw new PresetFileError(
        `Default Preset ${preset.name} is configured more than once: ${earlier} and ${path}.`,
      );
    }
    filePresetPaths.set(preset.name, path);
    filePresets.push({ path, preset });
  }
  // An operator file named like a bundled default replaces that default: a later release can
  // bundle a name an operator already uses (default-codex), and startup must not stop for it.
  const defaultPresets: Pick<Preset, "name" | "template">[] = [];
  const shadowedDefaultPresets: ShadowedDefaultPreset[] = [];
  if (includeDefaults) {
    for (const version of bundledPresetVersions) {
      if (!version.current) {
        continue;
      }
      const shadow = filePresets.find(({ preset }) => preset.name === version.name);
      if (shadow !== undefined) {
        shadowedDefaultPresets.push(
          Object.freeze({ presetName: version.name, presetFile: shadow.path }),
        );
        continue;
      }
      defaultPresets.push(Object.freeze({ name: version.name, template: version.template }));
    }
  }
  defaultPresets.push(...filePresets.map(({ preset }) => preset));
  return { includeDefaults, bundledPresetVersions, defaultPresets, shadowedDefaultPresets };
}
