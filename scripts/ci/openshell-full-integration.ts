const policyLane = "openshell-policy";
const installerLane = "openshell-installers";
const installerFiles = new Set([
  "tests/integration/openshell-upstream-real.test.ts",
  "tests/integration/local-first-agent-openshell-real.test.mjs",
  "tests/integration/dev-up-openshell-k3d-real.test.mjs",
  "tests/integration/local-first-agent-openshell-k3d-real.test.mjs",
  "tests/integration/openshell-git-finite-removal-real.test.ts",
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
    groups.full.filter((lane) => lane === "openshell").length !== 1 ||
    policyLane in otherLanes ||
    installerLane in otherLanes ||
    "openshell" in groups
  ) {
    throw new Error("Full Integration requires the canonical OpenShell lane exactly once.");
  }
  const paths = new Set(original.files.map(({ path }) => path));
  const installers = original.files.filter(({ path }) => isOpenShellInstallerFile(path));
  const shared = original.files.filter(({ path }) => !isOpenShellInstallerFile(path));
  if (
    paths.size !== original.files.length ||
    installers.length !== installerFiles.size ||
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
