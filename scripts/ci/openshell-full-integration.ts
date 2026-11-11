const policyLane = "openshell-policy";
const installerLane = "openshell-installers";
const installerFiles = new Set([
  "tests/integration/openshell-upstream-real.test.ts",
  "tests/integration/local-first-agent-openshell-real.test.mjs",
  "tests/integration/dev-up-openshell-k3d-real.test.mjs",
  "tests/integration/local-first-agent-openshell-k3d-real.test.mjs",
]);

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
  groups: Record<string, string[]>;
}) {
  const { openshell: original, ...otherLanes } = manifest.lanes;
  const full = manifest.groups?.full;
  if (
    !hasFiles(original) ||
    !Array.isArray(full) ||
    full.filter((lane) => lane === "openshell").length !== 1 ||
    policyLane in otherLanes ||
    installerLane in otherLanes ||
    "openshell" in manifest.groups
  ) {
    throw new Error("Full Integration requires the canonical OpenShell lane exactly once.");
  }
  const paths = new Set(original.files.map(({ path }) => path));
  const installers = original.files.filter(({ path }) => installerFiles.has(path));
  const shared = original.files.filter(({ path }) => !installerFiles.has(path));
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
      ...manifest.groups,
      full: full.flatMap((lane) => (lane === "openshell" ? [policyLane, installerLane] : [lane])),
      openshell: [policyLane, installerLane],
    },
  };
}
