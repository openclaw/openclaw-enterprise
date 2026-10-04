import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import { readFile, realpath } from "node:fs/promises";
import { createRequire, findPackageJSON } from "node:module";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

function importEntrypoint(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const conditions = value as Record<string, unknown>;
  if (Object.hasOwn(conditions, ".")) {
    return importEntrypoint(conditions["."]);
  }
  for (const [condition, target] of Object.entries(conditions)) {
    if (condition !== "import" && condition !== "node" && condition !== "default") {
      continue;
    }
    const selected = importEntrypoint(target);
    if (selected !== undefined) {
      return selected;
    }
  }
  return undefined;
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
  const exportedEntrypoint = importEntrypoint(installedManifest.exports);
  if (exportedEntrypoint === undefined || !exportedEntrypoint.startsWith("./")) {
    throw new Error(`${path}.package must declare an exported compiled ESM entry.`);
  }
  let entryPath: string;
  try {
    entryPath = await realpath(
      createRequire(pathToFileURL(ownerPath)).resolve(
        resolve(dirname(installedManifestPath), exportedEntrypoint),
      ),
    );
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
