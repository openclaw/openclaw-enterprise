import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { asRecord } from "../../packages/utils/src/index.ts";
import { assertNodeBaseImage } from "./image-build-cache.ts";
import { assertImmutableImageReference, immutableDigest } from "./k3d-image-admission.ts";
import { isOpenShellLane } from "./openshell-full-integration.ts";
import { openShellHarnessError, openShellRequiredEnv } from "./openshell-model-inputs.ts";
import { loadTestSuites } from "./test-suites.ts";

export type Environment = NodeJS.ProcessEnv;
export type LaneSelection = string | { name: string };
export type FileSelection = string | { path: string };

export type PrepareLaneOptions = {
  lane: LaneSelection;
  statePath?: string | undefined;
  file?: FileSelection | undefined;
  cleanupOwner?: string | undefined;
};

export type PrepareFileOptions = {
  lane: LaneSelection;
  file: FileSelection;
  statePath?: string | undefined;
  template?: string | undefined;
  modelSelectors?: Environment | undefined;
};

export const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const suiteView = process.env.OCC_CI_SUITE_VIEW;
const manifest = asRecord(
  loadTestSuites(join(repositoryRoot, "scripts/ci/test-suites.json"), suiteView),
);
const laneDefinitions = asRecord(manifest?.lanes) ?? {};

export const nativeIAMBarrierFile = "tests/integration/postgres-native-iam-policy-barrier.test.ts";
export const productionUpgradeImages = {
  OCC_TEST_PRODUCTION_UPGRADE_CONTROLLER_IMAGE: "OCC_TEST_PRODUCTION_CONTROLLER_IMAGE",
  OCC_TEST_PRODUCTION_UPGRADE_RUNTIME_IMAGE: "OCC_TEST_KUBERNETES_RUNTIME_IMAGE",
};

function environment(value: unknown, field: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  const record = asRecord(value);
  if (!record) {
    throw new Error(`${field} must be an object of environment strings.`);
  }
  const entries = Object.entries(record).map(([name, text]) => {
    if (typeof text !== "string") {
      throw new Error(`${field}.${name} must be an environment string.`);
    }
    return [name, text] as const;
  });
  return Object.fromEntries(entries);
}

function strings(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((entry: unknown) => typeof entry === "string")) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return value;
}

function flag(value: unknown, field: string): boolean {
  if (value === undefined) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean.`);
  }
  return value;
}

function readLane(value: unknown, name: string) {
  const lane = asRecord(value);
  if (!lane) {
    throw new Error(`lanes.${name} must be an object.`);
  }
  const files: unknown = lane.files;
  if (!Array.isArray(files)) {
    throw new Error(`lanes.${name}.files must be an array.`);
  }
  const field = `lanes.${name}.prepare`;
  const prepare = lane.prepare === undefined ? undefined : asRecord(lane.prepare);
  if (lane.prepare !== undefined && !prepare) {
    throw new Error(`${field} must be an object.`);
  }
  return {
    env: environment(lane.env, `lanes.${name}.env`),
    files: files.map((entry: unknown) => {
      const file = asRecord(entry);
      if (typeof file?.path !== "string") {
        throw new Error(`lanes.${name}.files must contain objects with a path string.`);
      }
      return {
        path: file.path,
        env: environment(file.env, `${file.path}.env`),
        requiredEnv: strings(file.requiredEnv, `${file.path}.requiredEnv`),
      };
    }),
    prepare: {
      defaultEnv: environment(prepare?.defaultEnv, `${field}.defaultEnv`),
      requireEnv: strings(prepare?.requireEnv, `${field}.requireEnv`),
      immutableEnvImages: strings(prepare?.immutableEnvImages, `${field}.immutableEnvImages`),
      immutableOptionalEnvImages: strings(
        prepare?.immutableOptionalEnvImages,
        `${field}.immutableOptionalEnvImages`,
      ),
      selfProvisionedFiles: strings(prepare?.selfProvisionedFiles, `${field}.selfProvisionedFiles`),
      sourceBuildFiles: strings(prepare?.sourceBuildFiles, `${field}.sourceBuildFiles`),
      nodeBaseImage: flag(prepare?.nodeBaseImage, `${field}.nodeBaseImage`),
      postgres: flag(prepare?.postgres, `${field}.postgres`),
      k3d: flag(prepare?.k3d, `${field}.k3d`),
      keycloak: flag(prepare?.keycloak, `${field}.keycloak`),
      codexSeccomp: flag(prepare?.codexSeccomp, `${field}.codexSeccomp`),
      requiresPreparedStateForFile: flag(
        prepare?.requiresPreparedStateForFile,
        `${field}.requiresPreparedStateForFile`,
      ),
    },
  };
}

const lanes = new Map(
  Object.entries(laneDefinitions).map(([name, definition]) => [name, readLane(definition, name)]),
);
const emptyLane = readLane({ files: [] }, "");

export function laneDefinition(name: string) {
  return lanes.get(name) ?? emptyLane;
}

export function repositoryCredentialsFileNeedsBinary(file: string) {
  const registered = laneDefinition("repository-credentials-container").files.find(
    ({ path }) => path === file,
  );
  return registered?.requiredEnv.includes("REPOSITORY_CREDENTIALS_GH_BINARY") ?? true;
}

export function lanePrepare(name: string) {
  return laneDefinition(name).prepare;
}

export function laneDefaults(name: string, env: Environment) {
  const lane = laneDefinition(name);
  const defaults = { ...lane.env };
  // Fixed manifest env wins over inherited input. Default env allows an
  // explicit process override first, then the effective preparation input.
  const effective = { ...env, ...defaults };
  for (const [envName, defaultValue] of Object.entries(lane.prepare.defaultEnv)) {
    defaults[envName] = process.env[envName] || effective[envName] || defaultValue;
  }
  return defaults;
}

export function effectiveLaneEnv(name: string, env: Environment = {}): Environment {
  const effective = { ...process.env, ...env };
  return { ...effective, ...laneDefaults(name, effective) };
}

export function laneName(lane: LaneSelection) {
  if (typeof lane === "string") {
    return lane;
  }
  if (typeof lane?.name === "string") {
    return lane.name;
  }
  throw new Error("CI lane must be a string or an object with a name.");
}

function filePath(file: FileSelection) {
  if (typeof file === "string") {
    return file;
  }
  if (typeof file?.path === "string") {
    return file.path;
  }
  throw new Error("CI file must be a string or an object with a path.");
}

export function assertLane(lane: LaneSelection) {
  const name = laneName(lane);
  if (!lanes.has(name)) {
    throw new Error(`Unknown CI lane: ${name}`);
  }
  return name;
}

export function requireEnv(names: readonly string[], env: Environment = process.env) {
  const missing = names.filter((name) => {
    const value = env[name];
    return !value || value.trim?.() === "";
  });
  if (missing.length > 0) {
    throw new Error(`Missing required CI input(s): ${missing.join(", ")}`);
  }
}

function toRepositoryRelative(path: string) {
  const resolved = isAbsolute(path) ? resolve(path) : resolve(repositoryRoot, path);
  const relativePath = relative(repositoryRoot, resolved);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Path escapes repository root: ${path}`);
  }
  return relativePath.split(sep).join("/");
}

export function normalizeFile(file: FileSelection) {
  return toRepositoryRelative(filePath(file));
}

export function selectedLaneFile(name: string, file: FileSelection | undefined) {
  if (file === undefined) {
    return;
  }
  const path = normalizeFile(file);
  if (!laneDefinition(name).files.some((entry) => entry.path === path)) {
    throw new Error("Selected file must belong to the lane manifest.");
  }
  return path;
}

function immutableEnvImage(name: string, env: Environment) {
  const image = env[name];
  assertImmutableImageReference(image, name);
  return image;
}

export function validateLaneInputsBeforeSideEffects(
  name: string,
  {
    file,
    modelSelectors,
  }: { file?: string | undefined; modelSelectors?: Environment | undefined } = {},
) {
  const prepare = lanePrepare(name);
  const effectiveEnv = effectiveLaneEnv(name);
  const modelEnv = modelSelectors ?? {
    ...effectiveEnv,
    ...laneDefinition(name).files.find((entry) => entry.path === file)?.env,
  };
  const harnessError = openShellHarnessError(name, file, modelEnv);
  if (harnessError) {
    throw new Error(harnessError);
  }
  if (prepare.k3d && !isOpenShellLane(name) && effectiveEnv.OPENCLAW_CI_K3S_IMAGE) {
    assertImmutableImageReference(effectiveEnv.OPENCLAW_CI_K3S_IMAGE, "OPENCLAW_CI_K3S_IMAGE");
  }
  const openShellApiKeyWorkflowFile = [
    "tests/integration/openshell-upstream-real.test.ts",
    "tests/integration/openshell-refresh-real.test.ts",
    "tests/integration/openshell-withdrawal-real.test.ts",
    "tests/integration/openshell-gateway-tool-policy-real.test.ts",
  ].some((path) => path === file);
  // Custom keys must not reach sibling tests that register the public provider.
  if (isOpenShellLane(name)) {
    const endpoint = effectiveEnv.OCC_TEST_OPENSHELL_MODEL_BASE_URL?.trim();
    const parsedEndpoint = endpoint ? URL.parse(endpoint) : null;
    if (endpoint && !parsedEndpoint) {
      throw new Error("The OpenShell model endpoint must be a valid absolute URL.");
    }
    const customEndpoint =
      parsedEndpoint && parsedEndpoint.href.replace(/\/$/u, "") !== "https://api.openai.com/v1";
    if (customEndpoint && !openShellApiKeyWorkflowFile) {
      throw new Error("Custom OpenShell model endpoints require a focused gateway workflow file.");
    }
    if (effectiveEnv.OCC_TEST_LOCAL_FIRST_AGENT_NATIVE_PROVIDER_FILE) {
      if (
        ![
          "tests/integration/local-first-agent-openshell-real.test.mjs",
          "tests/integration/local-first-agent-openshell-k3d-real.test.mjs",
        ].some((path) => path === file)
      ) {
        throw new Error("Custom native providers require a focused first-Agent file.");
      }
      requireEnv(["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"], effectiveEnv);
    }
  }
  const requiredInputs =
    isOpenShellLane(name) && file === undefined
      ? [
          ...new Set(
            laneDefinition(name).files.flatMap((entry) =>
              openShellRequiredEnv(name, entry.path, prepare.requireEnv, {
                ...modelEnv,
                ...entry.env,
              }),
            ),
          ),
        ]
      : openShellRequiredEnv(name, file, prepare.requireEnv, modelEnv);
  requireEnv(requiredInputs, effectiveEnv);
  if (prepare.nodeBaseImage) {
    assertNodeBaseImage(effectiveEnv.NODE_BASE_IMAGE);
  }
  for (const name of prepare.immutableEnvImages) {
    immutableEnvImage(name, effectiveEnv);
  }
  for (const name of prepare.immutableOptionalEnvImages) {
    if (effectiveEnv[name]) {
      immutableEnvImage(name, effectiveEnv);
    }
  }
  const runtimeImageInputs = [
    "OCC_TEST_KUBERNETES_GATEWAY_IMAGE",
    "OCC_TEST_KUBERNETES_AGENT_IMAGE",
  ];
  if (
    runtimeImageInputs.every((input) => prepare.immutableOptionalEnvImages.includes(input)) &&
    runtimeImageInputs.filter((input) => effectiveEnv[input]).length === 1
  ) {
    throw new Error(
      "OCC_TEST_KUBERNETES_GATEWAY_IMAGE and OCC_TEST_KUBERNETES_AGENT_IMAGE must be supplied together; omit both to build the runtime images.",
    );
  }
  if (name === "production-tui") {
    const candidates = Object.keys(productionUpgradeImages);
    if (candidates.some((variable) => effectiveEnv[variable])) {
      const baselines = Object.values(productionUpgradeImages);
      const digests = new Map(
        [...baselines, ...candidates].map((variable) => [
          variable,
          immutableDigest(immutableEnvImage(variable, effectiveEnv)),
        ]),
      );
      for (const [candidate, baseline] of Object.entries(productionUpgradeImages)) {
        if (digests.get(baseline) === digests.get(candidate)) {
          throw new Error(`${candidate} must select a different digest from ${baseline}.`);
        }
      }
    } else {
      assertNodeBaseImage(effectiveEnv.NODE_BASE_IMAGE);
    }
  }
}
