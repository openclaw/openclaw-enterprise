import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

let report;
try {
  report = JSON.parse(
    await readFile(join(process.env.RUNNER_TEMP, "qa-matrix-evidence/matrix.json"), "utf8"),
  );
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
}
const lines = [
  "## QA matrix advisory",
  "",
  "This check is not required for merging. Selected coverage only; Git and Slack are not selected.",
  "",
];
if (!report) {
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
  lines.push("", "| Cell | Scenario | Stage | Outcome |", "| --- | --- | --- | --- |");
  for (const row of report.outcomes) {
    lines.push(`| ${row.cell} | ${row.scenario ?? "setup"} | ${row.stage} | ${row.outcome} |`);
  }
  lines.push(
    "",
    "Stages absent from this table have no recorded completion. Job status includes test and cleanup failures.",
  );
}
await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
