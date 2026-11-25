import { appendFileSync } from "node:fs";

import { asRecord } from "../../packages/utils/src/index.ts";
import { isOpenShellLane } from "./openshell-full-integration.ts";
import { loadTestSuites } from "./test-suites.ts";

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string");
}

const view = process.env.OCC_CI_SUITE_VIEW;
const name = process.env.CI_SELECTED_LANE;
const manifest = asRecord(loadTestSuites("scripts/ci/test-suites.json", view));
const lanes = asRecord(manifest?.lanes);
if (
  name === undefined ||
  !lanes ||
  !Object.hasOwn(lanes, name) ||
  (view === "full-integration" && !isOpenShellLane(name))
) {
  throw new Error("The selected lane does not belong to the action suite view.");
}
const lane = asRecord(lanes[name]);
if (!lane) {
  throw new Error("The selected lane must be an object.");
}
const prepare = asRecord(lane.prepare);
const sourceBuildFiles = prepare?.sourceBuildFiles;
if (sourceBuildFiles !== undefined && !isStringList(sourceBuildFiles)) {
  throw new Error("Installer source-build files must be an array of strings.");
}
const file = process.env.CI_SELECTED_TEST_FILE;
const files: unknown = lane.files;
if (!Array.isArray(files)) {
  throw new Error("The selected lane must list its test files.");
}
const sourceBuild =
  sourceBuildFiles?.some((path) =>
    file ? path === file : files.some((entry: unknown) => asRecord(entry)?.path === path),
  ) ?? false;

let firstAgent = false;
if (isOpenShellLane(name)) {
  const selfProvisionedFiles = prepare?.selfProvisionedFiles;
  if (!isStringList(selfProvisionedFiles)) {
    throw new Error("OpenShell self-provisioned files must be an array of strings.");
  }
  firstAgent = file !== undefined && selfProvisionedFiles.includes(file) && !sourceBuild;
}

const output = process.env.GITHUB_OUTPUT;
if (output === undefined) {
  throw new Error("GITHUB_OUTPUT is required.");
}
appendFileSync(output, `source-build=${sourceBuild}\nfirst-agent=${firstAgent}\n`);
