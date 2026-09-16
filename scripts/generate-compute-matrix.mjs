import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const matrixStart = "<!-- compute-matrix:start -->";
export const matrixEnd = "<!-- compute-matrix:end -->";

const labels = {
  supported: "✓ Supported",
  partial: "✓ Partial",
  unsupported: "— Unsupported",
  unknown: "? Unknown",
};
const escapeCell = (value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");

export function renderMatrixMarkdown(data) {
  const url = (evidence) =>
    `https://github.com/openclaw/openclaw-enterprise/blob/${data.baseline}/${evidence.path}#L${evidence.start}-L${evidence.end}`;
  const lines = [
    matrixStart,
    "",
    "<!-- Generated from docs/assets/compute-driver-matrix.json; run node scripts/generate-compute-matrix.mjs. -->",
    "",
    `Reviewed ${data.reviewedAt} at [${data.baseline}](https://github.com/openclaw/openclaw-enterprise/tree/${data.baseline}).`,
    "",
    "<!-- prettier-ignore -->",
    `| Capability | Requirement | ${data.drivers.map((driver) => escapeCell(driver.name)).join(" | ")} |`,
    `| --- | --- | ${data.drivers.map(() => "---").join(" | ")} |`,
  ];
  for (const row of data.rows) {
    const cells = data.drivers.map((driver) => {
      const cell = row.cells[driver.id];
      const label = labels[cell.status];
      if (!label) throw new Error(`Unknown support status: ${row.id}/${driver.id}`);
      const evidence = cell.evidence[0];
      return evidence ? `[${label}](${url(evidence)})` : label;
    });
    lines.push(
      `| ${escapeCell(row.name)} | ${escapeCell(row.requirement)} | ${cells.join(" | ")} |`,
    );
  }
  lines.push("", matrixEnd);
  return lines.join("\n");
}

export function replaceMatrixMarkdown(markdown, data) {
  const start = markdown.indexOf(matrixStart);
  const end = markdown.indexOf(matrixEnd);
  if (start < 0 || end < start || markdown.indexOf(matrixStart, start + 1) >= 0)
    throw new Error("Expected one complete compute matrix block");
  return (
    markdown.slice(0, start) + renderMatrixMarkdown(data) + markdown.slice(end + matrixEnd.length)
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some((arg) => arg !== "--check"))
    throw new Error("Usage: generate-compute-matrix.mjs [--check]");
  const data = JSON.parse(fs.readFileSync("docs/assets/compute-driver-matrix.json", "utf8"));
  const target = "docs/reference/drivers/compute-matrix.md";
  const current = fs.readFileSync(target, "utf8");
  const expected = replaceMatrixMarkdown(current, data);
  if (process.argv.includes("--check")) {
    if (current !== expected)
      throw new Error(
        "Compute matrix fallback is stale; run node scripts/generate-compute-matrix.mjs",
      );
    console.log(`Compute matrix fallback is current (${data.rows.length} rows).`);
  } else {
    fs.writeFileSync(target, expected);
    console.log(`Updated ${target} (${data.rows.length} rows).`);
  }
}
