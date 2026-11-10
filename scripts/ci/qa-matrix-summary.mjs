import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

let evidence;
try {
  evidence = await readFile(
    join(process.env.RUNNER_TEMP, "qa-matrix-evidence/matrix.json"),
    "utf8",
  );
} catch (error) {
  if (error.code !== "ENOENT") {
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
  await appendFile(process.env.GITHUB_STEP_SUMMARY, formatSummary(report));
}

function isStringList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseReport(evidence) {
  let report;
  try {
    report = JSON.parse(evidence);
  } catch {
    return undefined;
  }

  if (
    typeof report?.scope !== "string" ||
    !Array.isArray(report.selection) ||
    !report.selection.every(
      (cell) =>
        typeof cell?.cell === "string" &&
        isStringList(cell.scenarios) &&
        isStringList(cell.unselected),
    ) ||
    !Array.isArray(report.outcomes) ||
    !report.outcomes.every(
      (row) =>
        typeof row?.cell === "string" &&
        (row.scenario === undefined || row.scenario === null || typeof row.scenario === "string") &&
        typeof row.stage === "string" &&
        typeof row.outcome === "string",
    )
  ) {
    return undefined;
  }
  return report;
}

function formatSummary(report) {
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
