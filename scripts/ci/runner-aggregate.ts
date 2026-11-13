import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { sanitizeError } from "./failure-redaction.ts";
import { exercisedLaneStatus } from "./full-integration-coverage.ts";
import {
  exists,
  isObject,
  issue,
  laneNamesForTarget,
  type loadRunnerManifest,
  selectedLaneNames,
  sourceEvidence,
} from "./runner-inputs.ts";
import { validateExpectedTests } from "./runner-reporter-output.ts";
import { projectSkipperRunnerReceipt, qualifySkipperRelease } from "./skipper-release.ts";

type RunnerManifest = ReturnType<typeof loadRunnerManifest>;
type RunnerLane = NonNullable<ReturnType<RunnerManifest["lanes"]["get"]>>;
type RunnerIssue = ReturnType<typeof issue>;
type LaneOutcome = {
  lane: string;
  status: unknown;
  exitCode: unknown;
  sourceSha: string | null;
};

export type AggregateSummary = {
  version: 1;
  command: "aggregate";
  sourceSha: string | null;
  group: string;
  fullCoverageExercised?: true;
  releaseQualification?: ReturnType<typeof qualifySkipperRelease>;
  status: "passed" | "failed";
  lanes: LaneOutcome[];
  issues: RunnerIssue[];
};

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function evidenceRecord(value: unknown): Record<string, unknown> {
  // Null receipt rows trigger the lane's invalid-output diagnostic.
  if (value == null) {
    throw new TypeError("Missing receipt record");
  }
  return isObject(value) ? value : {};
}

function validateLaneEvidence(
  summary: Record<string, unknown>,
  laneName: string,
  lane: RunnerLane,
  issues: RunnerIssue[],
): void {
  if (summary.version !== 1 || summary.command !== "run" || !Array.isArray(summary.files)) {
    issues.push(
      issue("invalid-lane-output", `result summary for ${laneName} is not runner output`, {
        lane: laneName,
      }),
    );
    return;
  }
  if (summary.scope === "focused") {
    issues.push(
      issue("focused-lane-evidence", `focused results do not complete lane ${laneName}`, {
        lane: laneName,
      }),
    );
  }
  if (summary.status === "passed" && summary.exitCode !== 0) {
    issues.push(
      issue("lane-exit-mismatch", `lane ${laneName} reported success with a nonzero exit`, {
        lane: laneName,
        exitCode: summary.exitCode,
      }),
    );
  }

  const files: readonly unknown[] = summary.files;
  const observedFiles = new Map<unknown, Record<string, unknown>[]>();
  for (const file of files) {
    const observed = evidenceRecord(file);
    const records = observedFiles.get(observed.path) ?? [];
    records.push(observed);
    observedFiles.set(observed.path, records);
  }
  for (const [file, records] of observedFiles) {
    if (records.length > 1) {
      const expectedFile = lane.files.find((entry) => entry.path === file);
      if (expectedFile) {
        issues.push(
          issue(
            "duplicate-lane-file",
            `lane ${laneName} has duplicate file evidence for ${expectedFile.path}`,
            { lane: laneName, file: expectedFile.path },
          ),
        );
      } else {
        issues.push(
          issue(
            "duplicate-lane-file",
            `lane ${laneName} has duplicate file evidence for an unregistered file`,
            {
              lane: laneName,
            },
          ),
        );
      }
    }
  }
  for (const expectedFile of lane.files) {
    const records = observedFiles.get(expectedFile.path);
    if (!records) {
      issues.push(
        issue("missing-lane-evidence", `lane ${laneName} is missing file evidence`, {
          lane: laneName,
          file: expectedFile.path,
        }),
      );
      continue;
    }
    for (const observed of records) {
      if (observed.status !== "passed") {
        issues.push(
          issue("lane-file-failed", `lane ${laneName} file did not pass`, {
            lane: laneName,
            file: expectedFile.path,
            status: observed.status,
          }),
        );
      }
      const total = isObject(observed.counts) ? observed.counts.total : undefined;
      const tests: unknown = observed.tests;
      if (
        typeof total !== "number" ||
        !Number.isInteger(total) ||
        total < 1 ||
        !Array.isArray(tests)
      ) {
        issues.push(
          issue("missing-lane-evidence", `lane ${laneName} file has no test evidence`, {
            lane: laneName,
            file: expectedFile.path,
          }),
        );
      } else {
        const cases: readonly unknown[] = tests;
        validateExpectedTests(expectedFile.path, expectedFile.expectedTests, cases, issues);
      }
      if (
        observed.cleanup != null &&
        (!isObject(observed.cleanup) || observed.cleanup.status !== "passed")
      ) {
        issues.push(
          issue("cleanup-failed", `lane ${laneName} file cleanup did not pass`, {
            lane: laneName,
            file: expectedFile.path,
          }),
        );
      }
    }
  }
}

// A verified test-only selection aggregates only its lanes, all from the group.
export async function aggregateGroup(
  root: string,
  manifest: RunnerManifest,
  groupName: string,
  resultsDir: string,
  needsPath: string | null,
  selection: string | undefined,
  releaseSelection: string | null,
): Promise<AggregateSummary> {
  let releaseQualification: AggregateSummary["releaseQualification"];
  const source = sourceEvidence(root);
  const issues = [...manifest.issues, ...source.issues];
  let laneNames = laneNamesForTarget(manifest, groupName);
  const lanes: LaneOutcome[] = [];
  const exercised = new Map<string, "passed" | "failed">();
  const recordFullCoverage =
    process.env.GITHUB_WORKFLOW === "Full Integration" &&
    process.env.OCC_CI_SUITE_VIEW === "full-integration" &&
    groupName === "full" &&
    selection === undefined &&
    Boolean(needsPath) &&
    process.env.GITHUB_REF === "refs/heads/main" &&
    process.env.GITHUB_RUN_ATTEMPT === "1" &&
    source.sha === process.env.GITHUB_SHA;
  const currentSha = source.sha;

  if (!laneNames) {
    issues.push(
      issue("missing-aggregate-target", `manifest does not define group or lane ${groupName}`, {
        target: groupName,
      }),
    );
  } else if (selection !== undefined) {
    laneNames = selectedLaneNames(laneNames, selection, issues);
  }

  if (releaseSelection && !laneNames?.includes("skipper-prepared-git-installed")) {
    issues.push(
      issue(
        "release-selection-lane-missing",
        "release selection requires installed Skipper evidence",
      ),
    );
  }
  let needs: unknown = null;
  if (needsPath) {
    try {
      needs = await readJson(needsPath);
      if (!isObject(needs)) {
        issues.push(issue("invalid-needs", "needs JSON must be an object"));
      } else {
        for (const [needName, need] of Object.entries(needs)) {
          const job = isObject(need) ? need : undefined;
          const result = job?.result;
          if (result !== "success") {
            issues.push(
              issue("need-not-success", `needs JSON reports ${needName} as ${result}`, {
                need: needName,
                result,
              }),
            );
          }
          const jobLanes = job?.lanes;
          if (
            jobLanes !== undefined &&
            (!Array.isArray(jobLanes) ||
              jobLanes.length === 0 ||
              new Set<unknown>(jobLanes).size !== jobLanes.length ||
              !jobLanes.every((lane: unknown) => typeof lane === "string" && lane.length > 0))
          ) {
            issues.push(
              issue("invalid-need-lanes", `needs JSON has invalid lanes for ${needName}`, {
                need: needName,
              }),
            );
          }
        }
      }
    } catch (error) {
      issues.push(
        issue("invalid-needs", "needs JSON could not be read", { error: sanitizeError(error) }),
      );
    }
  }

  for (const laneName of laneNames ?? []) {
    if (needs) {
      const jobs =
        isObject(needs) || Array.isArray(needs) || typeof needs === "string"
          ? Object.entries<unknown>(needs)
          : [];
      const owners = jobs.filter(([name, need]) => {
        if (name === laneName) {
          return true;
        }
        const jobLanes = isObject(need) ? need.lanes : undefined;
        return Array.isArray(jobLanes) && jobLanes.includes(laneName);
      });
      if (owners.length === 0) {
        issues.push(issue("missing-need", `needs JSON is missing ${laneName}`, { lane: laneName }));
      } else if (owners.length > 1) {
        issues.push(
          issue("ambiguous-need", `needs JSON has multiple jobs for ${laneName}`, {
            lane: laneName,
          }),
        );
      }
    }

    const resultPath = resolve(resultsDir, `${laneName}.json`);
    if (!(await exists(resultPath))) {
      issues.push(
        issue("missing-lane-output", `missing result summary for ${laneName}`, {
          lane: laneName,
          path: resultPath,
        }),
      );
      continue;
    }

    try {
      const summary = evidenceRecord(await readJson(resultPath));
      const lane = manifest.lanes.get(laneName);
      if (summary.lane !== laneName) {
        issues.push(
          issue("lane-output-mismatch", `result file for ${laneName} reports ${summary.lane}`, {
            lane: laneName,
            reportedLane: summary.lane,
          }),
        );
      }
      if (summary.sourceSha !== currentSha) {
        issues.push(
          issue("source-sha-mismatch", `lane ${laneName} did not run at the aggregate SHA`, {
            lane: laneName,
            expectedSourceSha: currentSha,
            observedSourceSha: summary.sourceSha,
          }),
        );
      }
      if (summary.lane !== laneName || summary.sourceSha !== currentSha) {
        continue;
      }
      lanes.push({
        lane: summary.lane,
        status: summary.status,
        exitCode: summary.exitCode,
        sourceSha: currentSha,
      });
      if (summary.status !== "passed") {
        issues.push(
          issue("lane-failed", `lane ${laneName} did not pass`, {
            lane: laneName,
            status: summary.status,
          }),
        );
      }
      if (recordFullCoverage && lane) {
        let outcome = exercisedLaneStatus(summary, lane.files);
        if (outcome && laneName === "skipper-prepared-git-installed") {
          try {
            const projected = projectSkipperRunnerReceipt(summary);
            outcome = exercisedLaneStatus({ ...projected, cleanup: summary.cleanup }, lane.files);
          } catch {
            // Its owning contract requires file cleanup even when other lanes do not.
            outcome = undefined;
          }
        }
        if (outcome) {
          exercised.set(laneName, outcome);
        }
      }
      if (lane && summary.status === "passed") {
        validateLaneEvidence(summary, laneName, lane, issues);
        if (releaseSelection && laneName === "skipper-prepared-git-installed") {
          try {
            const selectedRelease = await readJson(releaseSelection);
            if (currentSha === null) {
              throw new TypeError("Release qualification requires a source SHA");
            }
            releaseQualification = qualifySkipperRelease(selectedRelease, summary, currentSha);
          } catch {
            issues.push(
              issue(
                "skipper-release-mismatch",
                "installed Skipper evidence does not qualify the selected release",
                { lane: laneName },
              ),
            );
          }
        }
      }
    } catch (error) {
      issues.push(
        issue("invalid-lane-output", `result summary for ${laneName} is invalid JSON`, {
          lane: laneName,
          error: sanitizeError(error),
        }),
      );
    }
  }

  const fullCoverageExercised =
    recordFullCoverage &&
    laneNames !== null &&
    laneNames.length > 0 &&
    exercised.size === laneNames.length &&
    issues.every((entry) => {
      if (entry.code === "lane-failed") {
        return typeof entry.lane === "string" && exercised.get(entry.lane) === "failed";
      }
      if (entry.code !== "need-not-success" || entry.result !== "failure") {
        return false;
      }
      const need =
        isObject(needs) && typeof entry.need === "string" ? needs[entry.need] : undefined;
      const ownedLanes = (isObject(need) ? need.lanes : undefined) ?? [entry.need];
      return (
        Array.isArray(ownedLanes) &&
        ownedLanes.length > 0 &&
        ownedLanes.every((lane: unknown) => typeof lane === "string" && exercised.has(lane))
      );
    });

  return {
    version: 1,
    command: "aggregate",
    sourceSha: currentSha,
    group: groupName,
    ...(fullCoverageExercised ? { fullCoverageExercised: true } : {}),
    ...(releaseQualification && issues.length === 0 ? { releaseQualification } : {}),
    status: issues.length === 0 ? "passed" : "failed",
    lanes,
    issues,
  };
}
