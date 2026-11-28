const policyLane = "openshell-policy";
const installerLane = "openshell-installers";
const installerFiles = new Set([
  "tests/integration/openshell-upstream-real.test.ts",
  "tests/integration/local-first-agent-openshell-real.test.mjs",
  "tests/integration/dev-up-openshell-k3d-real.test.mjs",
  "tests/integration/local-first-agent-openshell-k3d-real.test.mjs",
]);

// Approved release ancestors can carry this 14-path layout from #5333 until #7224.
// The earlier 13-path set had two shard assignments, so leave its projection unchanged.
const legacyInstallerFiles = new Set([
  ...installerFiles,
  "tests/integration/openshell-git-finite-removal-real.test.ts",
]);
const legacyPaths = new Set([
  ...legacyInstallerFiles,
  "tests/integration/openshell-refresh-real.test.ts",
  "tests/integration/openshell-withdrawal-real.test.ts",
  "tests/integration/openshell-credentials-real.test.ts",
  "tests/integration/openshell-gateway-tool-policy-real.test.ts",
  "tests/integration/sandbox-driver-openshell-k3d-real.test.mjs",
  "tests/integration/sandbox-driver-openshell-scratch-k3d-real.test.ts",
  "tests/integration/openshell-plugin-install-real.test.ts",
  "tests/integration/namespace-driver-openshell-k3d-real.test.ts",
  "tests/integration/openshell-git-retention-real.test.ts",
]);

export function isOpenShellInstallerFile(file: string | undefined) {
  return file !== undefined && installerFiles.has(file);
}

export function isOpenShellLane(lane: string) {
  return lane === "openshell" || lane === policyLane || lane === installerLane;
}

function hasFiles(lane: unknown): lane is { files: { path: string }[] } {
  return (
    typeof lane === "object" &&
    lane !== null &&
    "files" in lane &&
    Array.isArray(lane.files) &&
    lane.files.every(
      (file: unknown) =>
        typeof file === "object" &&
        file !== null &&
        "path" in file &&
        typeof file.path === "string",
    )
  );
}

export function projectFullIntegrationOpenShell(manifest: {
  lanes: Record<string, unknown>;
  groups?: unknown;
}) {
  const { openshell: original, ...otherLanes } = manifest.lanes;
  const groups = manifest.groups;
  if (
    !hasFiles(original) ||
    typeof groups !== "object" ||
    groups === null ||
    !("full" in groups) ||
    !Array.isArray(groups.full) ||
    groups.full.filter((lane: unknown) => lane === "openshell").length !== 1 ||
    policyLane in otherLanes ||
    installerLane in otherLanes ||
    "openshell" in groups
  ) {
    throw new Error("Full Integration requires the canonical OpenShell lane exactly once.");
  }
  const paths = new Set(original.files.map(({ path }) => path));
  const installerPaths =
    paths.size === legacyPaths.size && [...paths].every((path) => legacyPaths.has(path))
      ? legacyInstallerFiles
      : installerFiles;
  const installers = original.files.filter(({ path }) => installerPaths.has(path));
  const shared = original.files.filter(({ path }) => !installerPaths.has(path));
  if (
    paths.size !== original.files.length ||
    installers.length !== installerPaths.size ||
    shared.length === 0
  ) {
    throw new Error("Full Integration requires two disjoint, nonempty OpenShell lanes.");
  }
  return {
    ...manifest,
    lanes: {
      ...otherLanes,
      [policyLane]: { ...original, files: shared },
      [installerLane]: { ...original, files: installers },
    },
    groups: {
      ...groups,
      full: groups.full.flatMap((lane: unknown) =>
        lane === "openshell" ? [policyLane, installerLane] : [lane],
      ),
      openshell: [policyLane, installerLane],
    },
  };
}
