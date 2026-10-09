import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import { readFile, realpath, stat } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  ComputeDriver,
  ConfigurationDriver,
  DriverImplementation,
  IAMDriver,
  SandboxDriver,
} from "@openclaw-enterprise/contracts";
import type { NativeIAMStateStore } from "@openclaw-enterprise/iam";
import { currentComputeAbortSignal } from "../drivers/compute/operation-context.ts";
import type { SelectedDriverConfiguration } from "./installation-config.ts";

type ConfigurationRecord = Readonly<Record<string, unknown>>;

interface ExternalDriverModule extends DriverImplementation {
  createDriver(options: {
    readonly id: string;
    readonly implementation: string;
    readonly configuration: ConfigurationRecord;
    readonly platformState?: NativeIAMStateStore;
    readonly getOperationAbortSignal?: () => AbortSignal | undefined;
  }): unknown;
}

interface LoadedDriverPackage {
  readonly module: ExternalDriverModule;
  readonly implementation: string;
}

const PACKAGE_NAME = /^(?:@[a-zA-Z0-9][a-zA-Z0-9._~-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._~-]*$/;

const INVALID_EXPORT_TARGET = Symbol("invalid package export target");

type ExportTarget = URL | null | undefined | typeof INVALID_EXPORT_TARGET;

// Node's default conditions for `import()` (no --conditions, --no-addons or
// --no-experimental-require-module flags; the controller sets none).
const IMPORT_CONDITIONS: ReadonlySet<string> = new Set([
  "node",
  "import",
  "module-sync",
  "node-addons",
  "default",
]);

// Node refuses ".", ".." and "node_modules" segments, including percent-encoded letters.
const INVALID_TARGET_SEGMENT =
  /(?:^|\\|\/)(?:(?:\.|%2e)(?:\.|%2e)?|(?:n|%6e|%4e)(?:o|%6f|%4f)(?:d|%64|%44)(?:e|%65|%45)(?:_|%5f)(?:m|%6d|%4d)(?:o|%6f|%4f)(?:d|%64|%44)(?:u|%75|%55)(?:l|%6c|%4c)(?:e|%65|%45)(?:s|%73|%53))(?:\\|\/|$)/i;

function isArrayIndex(key: string): boolean {
  const index = Number(key);
  return String(index) === key && index >= 0 && index < 0xffff_ffff;
}

/**
 * Node's PACKAGE_TARGET_RESOLVE for the package root under import conditions: a
 * "." key is a condition name here, so only the top level selects a subpath.
 */
function exportTarget(target: unknown, manifestUrl: URL, path: string): ExportTarget {
  if (typeof target === "string") {
    if (!target.startsWith("./") || INVALID_TARGET_SEGMENT.test(target.slice(2))) {
      return INVALID_EXPORT_TARGET;
    }
    // URL parsing drops tabs and newlines, so containment is checked after it.
    const resolved = new URL(target, manifestUrl);
    return resolved.pathname.startsWith(new URL(".", manifestUrl).pathname)
      ? resolved
      : INVALID_EXPORT_TARGET;
  }
  if (Array.isArray(target)) {
    // Invalid targets and unmatched conditions fall through to the next entry; the
    // result is the last null or invalid entry when none selects a file.
    let last: ExportTarget = target.length === 0 ? null : undefined;
    for (const item of target) {
      const resolved = exportTarget(item, manifestUrl, path);
      if (resolved instanceof URL) {
        return resolved;
      }
      if (resolved !== undefined) {
        last = resolved;
      }
    }
    return last;
  }
  if (target === null) {
    return null;
  }
  if (typeof target !== "object") {
    return INVALID_EXPORT_TARGET;
  }
  const conditions = target as Record<string, unknown>;
  const keys = Object.getOwnPropertyNames(conditions);
  if (keys.some(isArrayIndex)) {
    throw new Error(`${path}.package exports must not contain numeric condition keys.`);
  }
  for (const key of keys) {
    if (IMPORT_CONDITIONS.has(key)) {
      const resolved = exportTarget(conditions[key], manifestUrl, path);
      if (resolved !== undefined) {
        return resolved;
      }
    }
  }
  return undefined;
}

/** Node's PACKAGE_EXPORTS_RESOLVE for the "." subpath. */
function rootExportTarget(exports: unknown, manifestUrl: URL, path: string): ExportTarget {
  if (exports !== null && typeof exports === "object" && !Array.isArray(exports)) {
    const keys = Object.getOwnPropertyNames(exports);
    const subpaths = keys.filter((key) => key.startsWith("."));
    if (subpaths.length > 0 && subpaths.length < keys.length) {
      throw new Error(`${path}.package exports must not mix subpath and condition keys.`);
    }
    if (subpaths.length > 0) {
      return Object.hasOwn(exports, ".")
        ? exportTarget((exports as Record<string, unknown>)["."], manifestUrl, path)
        : undefined;
    }
  }
  return exportTarget(exports, manifestUrl, path);
}

export async function loadDriverPackage(
  selection: ConfigurationRecord,
  capability: "configuration" | "iam" | "compute" | "sandbox",
  packageRoot: string,
  allowFixtureTarball: boolean,
): Promise<LoadedDriverPackage | undefined> {
  if (!Object.hasOwn(selection, "package")) {
    return undefined;
  }

  const path = `drivers.${capability}`;
  const packageName = selection.package;
  if (!isNonEmptyString(packageName)) {
    throw new Error(`${path}.package must be a nonempty string.`);
  }
  if (!PACKAGE_NAME.test(packageName)) {
    throw new Error(`${path}.package must be one exact npm package name.`);
  }
  const ownerPath = resolve(packageRoot, "package.json");
  let owner: ConfigurationRecord | undefined;
  try {
    owner = asRecord(JSON.parse(await readFile(ownerPath, "utf8")));
    if (owner === undefined) {
      throw new Error("controller package.json must be one object.");
    }
  } catch {
    throw new Error(`${path}.package cannot read the controller package manifest.`);
  }
  const dependencies = owner.dependencies === undefined ? {} : asRecord(owner.dependencies);
  if (dependencies === undefined) {
    throw new Error("controller package.json dependencies must be one object.");
  }
  if (
    !Object.hasOwn(dependencies, packageName) ||
    typeof dependencies[packageName] !== "string" ||
    dependencies[packageName].trim().length === 0
  ) {
    throw new Error(`${path}.package must be a direct controller production dependency.`);
  }
  const dependencyVersion = dependencies[packageName];

  let installedManifestPath: string;
  try {
    const ownerUrl = pathToFileURL(ownerPath);
    const installed = findPackageJSON(packageName, ownerUrl);
    if (installed === undefined) {
      throw new Error("package metadata unavailable");
    }
    installedManifestPath = await realpath(installed);
  } catch {
    throw new Error(`${path}.package selects an unavailable installed Driver package.`);
  }

  let installedManifest: ConfigurationRecord | undefined;
  try {
    installedManifest = asRecord(JSON.parse(await readFile(installedManifestPath, "utf8")));
    if (installedManifest === undefined) {
      throw new Error(`${path}.package manifest must be one object.`);
    }
  } catch {
    throw new Error(`${path}.package has invalid installed package metadata.`);
  }
  if (installedManifest.name !== packageName) {
    throw new Error(`${path}.package does not match the installed npm package name.`);
  }
  const installedVersion = installedManifest.version;
  if (!isNonEmptyString(installedVersion)) {
    throw new Error(`${path}.package installed version must be a nonempty string.`);
  }
  if (
    dependencyVersion !== installedVersion &&
    !(allowFixtureTarball && /^file:.+\.tgz$/.test(dependencyVersion))
  ) {
    throw new Error(`${path}.package must be pinned to its exact installed production version.`);
  }
  const exported = rootExportTarget(
    installedManifest.exports,
    pathToFileURL(installedManifestPath),
    path,
  );
  if (!(exported instanceof URL)) {
    throw new Error(`${path}.package must declare an exported compiled ESM entry.`);
  }
  // Node then loads exactly the selected file: no extension, directory or main lookup.
  if (/%2f|%5c/i.test(exported.pathname)) {
    throw new Error(`${path}.package export target must not encode a path separator.`);
  }
  let targetPath: string;
  try {
    targetPath = fileURLToPath(exported);
  } catch {
    throw new Error(`${path}.package export target has malformed percent encoding.`);
  }
  const target = await stat(targetPath).catch(() => undefined);
  if (target?.isDirectory() === true) {
    throw new Error(`${path}.package export target must be a file, not a directory.`);
  }
  let entryPath: string;
  try {
    if (target?.isFile() !== true) {
      throw new Error("The selected export target is not a file.");
    }
    entryPath = await realpath(targetPath);
  } catch {
    throw new Error(`${path}.package selects an unavailable compiled ESM entry.`);
  }
  const extension = extname(entryPath);
  if (extension !== ".mjs" && !(extension === ".js" && installedManifest.type === "module")) {
    throw new Error(`${path}.package must export precompiled JavaScript ESM.`);
  }
  const contained = relative(dirname(installedManifestPath), entryPath);
  if (contained === "" || contained.startsWith("..") || isAbsolute(contained)) {
    throw new Error(`${path}.package entry escapes its installed package root.`);
  }

  let imported: unknown;
  try {
    imported = await import(pathToFileURL(entryPath).href);
  } catch {
    throw new Error(`${path}.package failed to load its compiled Driver module.`);
  }
  const module = asRecord(imported);
  if (module === undefined) {
    throw new Error(`${path}.package exports must be one object.`);
  }
  if (
    typeof module.validateConfiguration !== "function" ||
    typeof module.createDriver !== "function"
  ) {
    throw new Error(`${path}.package must export Driver validation and a factory.`);
  }
  if (asRecord(module.configurationSchema) === undefined) {
    throw new Error(`${path}.configurationSchema must be one object.`);
  }
  return Object.freeze({
    module: module as unknown as ExternalDriverModule,
    implementation: `${packageName}@${installedVersion}`,
  });
}

export function createExternalDriver(
  implementation: ExternalDriverModule,
  selection: SelectedDriverConfiguration,
  capability: "configuration" | "iam" | "compute" | "sandbox",
  platformState?: NativeIAMStateStore,
): ConfigurationDriver | IAMDriver | ComputeDriver | SandboxDriver {
  if (capability === "iam" && typeof platformState?.loadNativeIAMState !== "function") {
    throw new Error("drivers.iam factory requires platform state.");
  }
  const created = asRecord(
    implementation.createDriver({
      id: selection.id,
      implementation: selection.implementation,
      configuration: selection.configuration,
      ...(platformState === undefined ? {} : { platformState }),
      ...(capability === "compute" ? { getOperationAbortSignal: currentComputeAbortSignal } : {}),
    }),
  );
  if (created === undefined) {
    throw new Error(`drivers.${capability} factory result must be one object.`);
  }
  if (
    created.capability !== capability ||
    created.id !== selection.id ||
    created.implementation !== selection.implementation
  ) {
    throw new Error(`drivers.${capability} factory returned an unselected Driver identity.`);
  }
  const methods =
    capability === "configuration"
      ? ["create", "read", "update", "delete", "validate"]
      : capability === "iam"
        ? ["lookupIdentity", "authorize"]
        : capability === "compute"
          ? [
              "ensureNamespace",
              "deleteNamespace",
              "prepareRevision",
              "stopRevision",
              "retireRevision",
            ]
          : ["cleanup"];
  if (methods.some((method) => typeof created[method] !== "function")) {
    throw new Error(`drivers.${capability} factory returned an invalid Driver contract.`);
  }
  if (
    capability === "sandbox" &&
    ((created.ensureNamespace !== undefined && typeof created.ensureNamespace !== "function") ||
      (created.provisionHarness !== undefined && typeof created.provisionHarness !== "function"))
  ) {
    throw new Error("drivers.sandbox factory returned invalid optional lifecycle hooks.");
  }
  if (
    capability === "compute" &&
    created.setLifecycleDrivers !== undefined &&
    typeof created.setLifecycleDrivers !== "function"
  ) {
    throw new Error("drivers.compute factory returned invalid lifecycle Driver wiring.");
  }
  return created as unknown as ConfigurationDriver | IAMDriver | ComputeDriver | SandboxDriver;
}
