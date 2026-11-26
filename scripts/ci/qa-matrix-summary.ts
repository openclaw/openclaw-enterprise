import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

interface SelectionCell {
  cell: string;
  scenarios: string[];
  unselected: string[];
}

interface StageOutcome {
  cell: string;
  scenario?: string | null;
  stage: string;
  outcome: string;
}

interface QaReport {
  scope: string;
  selection: SelectionCell[];
  outcomes: StageOutcome[];
}

let evidence: string | undefined;
try {
  evidence = await readFile(
    join(process.env.RUNNER_TEMP!, "qa-matrix-evidence/matrix.json"),
    "utf8",
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw error;
  }
}

const report = evidence === undefined ? undefined : parseReport(evidence);
if (evidence !== undefined && report === undefined) {
  console.error(
    "Malformed QA matrix evidence: expected a JSON report with scope, selection, and outcomes.",
  );
  process.exitCode = 1;
} else {
  await appendFile(process.env.GITHUB_STEP_SUMMARY!, formatSummary(report));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function isSelectionCell(value: unknown): value is SelectionCell {
  return (
    isRecord(value) &&
    typeof value.cell === "string" &&
    isStringList(value.scenarios) &&
    isStringList(value.unselected)
  );
}

function isStageOutcome(value: unknown): value is StageOutcome {
  return (
    isRecord(value) &&
    typeof value.cell === "string" &&
    (value.scenario === undefined ||
      value.scenario === null ||
      typeof value.scenario === "string") &&
    typeof value.stage === "string" &&
    typeof value.outcome === "string"
  );
}

function isReport(value: unknown): value is QaReport {
  return (
    isRecord(value) &&
    typeof value.scope === "string" &&
    Array.isArray(value.selection) &&
    value.selection.every(isSelectionCell) &&
    Array.isArray(value.outcomes) &&
    value.outcomes.every(isStageOutcome)
  );
}

function parseReport(evidence: string): QaReport | undefined {
  let report: unknown;
  try {
    report = JSON.parse(evidence);
  } catch {
    return undefined;
  }
  return isReport(report) ? report : undefined;
}

function formatSummary(report: QaReport | undefined): string {
  const lines = [
    "## QA matrix advisory",
    "",
    "This check is not required for merging. Selected coverage only; Git and Slack are not selected.",
    "",
  ];
  if (report === undefined) {
    lines.push(
      "No scenario results were produced. Inspect setup and credential steps; this is not a passing QA run.",
    );
  } else {
    lines.push(
      `Scope: ${report.scope}`,
      "",
      "| Cell | Selected scenarios | Unselected scenarios |",
      "| --- | --- | --- |",
    );
    for (const cell of report.selection) {
      lines.push(
        `| ${cell.cell} | ${cell.scenarios.join(", ") || "none"} | ${cell.unselected.join(", ") || "none"} |`,
      );
    }
    if (report.outcomes.length === 0) {
      lines.push(
        "",
        "No stage outcomes were recorded for the selected scenarios. Job status includes test and cleanup failures.",
      );
    } else {
      lines.push("", "| Cell | Scenario | Stage | Outcome |", "| --- | --- | --- | --- |");
      for (const row of report.outcomes) {
        lines.push(`| ${row.cell} | ${row.scenario ?? "setup"} | ${row.stage} | ${row.outcome} |`);
      }
      lines.push(
        "",
        "Stages absent from this table have no recorded completion. Job status includes test and cleanup failures.",
      );
    }
  }
  return lines.join("\n") + "\n";
}
