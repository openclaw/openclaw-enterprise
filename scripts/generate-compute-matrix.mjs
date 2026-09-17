import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const matrixStart = "<!-- compute-matrix:start -->";
export const matrixEnd = "<!-- compute-matrix:end -->";

const repository = "https://github.com/openclaw/openclaw-enterprise";

const computeLabels = {
  supported: "✓ Supported",
  partial: "✓ Partial",
  unsupported: "— Unsupported",
  unknown: "? Unknown",
};

const pluginLabels = {
  supported: "✓ Supported",
  partial: "✓ Partial",
  unsupported: "— Unsupported",
  "not-applicable": "N/A",
  unknown: "? Unknown",
};

const escapeCell = (value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
const escapeMarkdownText = (value) =>
  escapeCell(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function sourceUrl(data, evidence) {
  return `${data.repository ?? repository}/blob/${data.baseline}/${evidence.path}#L${
    evidence.start
  }-L${evidence.end}`;
}

function sourceLabel(evidence) {
  return `${evidence.path}:${evidence.start}-${evidence.end}`;
}

function evidenceLinks(data, refs) {
  if (!Array.isArray(refs) || refs.length === 0) return "";
  return refs.map((ref) => `[${escapeCell(sourceLabel(ref))}](${sourceUrl(data, ref)})`).join(", ");
}

function renderCompactCell(data, cell, labels) {
  const label = labels[cell.status];
  if (!label) throw new Error(`Unknown support status: ${cell.status}`);
  const evidence = cell.evidence?.[0];
  return evidence ? `[${label}](${sourceUrl(data, evidence)})` : label;
}

function renderDetailedCell(data, cell, labels) {
  const label = labels[cell.status];
  if (!label) throw new Error(`Unknown support status: ${cell.status}`);
  const parts = [`**${label}.** ${escapeMarkdownText(cell.detail)}`];
  const sources = evidenceLinks(data, cell.evidence);
  if (sources) parts.push(`Source: ${sources}`);
  const tests = evidenceLinks(data, cell.tests);
  if (tests) parts.push(`Test coverage: ${tests}`);
  return parts.join("<br>");
}

export function renderDriverMatrixMarkdown(data, options) {
  const labels = options.labels;
  const renderCell = options.detailedCells ? renderDetailedCell : renderCompactCell;
  const generator = options.generator;
  const lines = [
    options.matrixStart,
    "",
    `<!-- Generated from ${options.dataPath}; run node ${generator}. -->`,
    "",
    `Reviewed ${data.reviewedAt} at [${data.baseline}](${data.repository ?? repository}/tree/${
      data.baseline
    }).`,
    "",
    "<!-- prettier-ignore -->",
    `| Capability | ${options.requirementLabel ?? "Requirement"} | ${data.drivers
      .map((driver) => escapeCell(driver.name))
      .join(" | ")} |`,
    `| --- | --- | ${data.drivers.map(() => "---").join(" | ")} |`,
  ];
  for (const row of data.rows) {
    const cells = data.drivers.map((driver) => {
      const cell = row.cells[driver.id];
      try {
        return renderCell(data, cell, labels);
      } catch (error) {
        throw new Error(`${row.id}/${driver.id}: ${error.message}`);
      }
    });
    const requirement =
      options.detailedCells && row.requirementDetail
        ? `${row.requirement} ${row.requirementDetail}`
        : row.requirement;
    lines.push(`| ${escapeCell(row.name)} | ${escapeCell(requirement)} | ${cells.join(" | ")} |`);
  }
  lines.push("", options.matrixEnd);
  return lines.join("\n");
}

export function replaceDriverMatrixMarkdown(markdown, data, options) {
  const start = markdown.indexOf(options.matrixStart);
  const end = markdown.indexOf(options.matrixEnd);
  if (start < 0 || end < start || markdown.indexOf(options.matrixStart, start + 1) >= 0)
    throw new Error(`Expected one complete ${options.name} matrix block`);
  return (
    markdown.slice(0, start) +
    renderDriverMatrixMarkdown(data, options) +
    markdown.slice(end + options.matrixEnd.length)
  );
}

export const computeMatrixOptions = {
  name: "compute",
  matrixStart,
  matrixEnd,
  dataPath: "docs/assets/compute-driver-matrix.json",
  generator: "scripts/generate-compute-matrix.mjs",
  labels: computeLabels,
  detailedCells: false,
  requirementLabel: "Requirement",
};

export const pluginMatrixOptions = {
  name: "plugin",
  matrixStart: "<!-- plugin-matrix:start -->",
  matrixEnd: "<!-- plugin-matrix:end -->",
  dataPath: "docs/assets/plugin-driver-matrix.json",
  generator: "scripts/generate-plugin-matrix.mjs",
  labels: pluginLabels,
  detailedCells: true,
  requirementLabel: "Scope",
};

export function renderMatrixMarkdown(data) {
  return renderDriverMatrixMarkdown(data, computeMatrixOptions);
}

export function renderPluginMatrixMarkdown(data) {
  return renderDriverMatrixMarkdown(data, pluginMatrixOptions);
}

export function replaceMatrixMarkdown(markdown, data) {
  return replaceDriverMatrixMarkdown(markdown, data, computeMatrixOptions);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some((arg) => arg !== "--check"))
    throw new Error("Usage: generate-compute-matrix.mjs [--check]");
  const data = JSON.parse(fs.readFileSync(computeMatrixOptions.dataPath, "utf8"));
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
