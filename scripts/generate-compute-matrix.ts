import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type MatrixStatus = "supported" | "partial" | "unsupported" | "not-applicable" | "unknown";
export interface MatrixReference {
  path: string;
  start?: number;
  end?: number;
}
export interface MatrixCell {
  status: MatrixStatus;
  detail: string;
  evidence?: MatrixReference[] | null;
  tests?: MatrixReference[] | null;
}
export interface MatrixRow {
  id: string;
  category: string;
  name: string;
  requirement: string;
  requirementDetail?: string;
  requirementEvidence?: MatrixReference[] | null;
  cells: Record<string, MatrixCell>;
}
export interface DriverMatrix {
  repository?: string;
  baseline: string;
  reviewedAt: string;
  drivers: { id: string; name: string }[];
  rows: MatrixRow[];
}
export interface MatrixOptions {
  name: string;
  matrixStart: string;
  matrixEnd: string;
  dataPath: string;
  generator: string;
  labels: Partial<Record<MatrixStatus, string>>;
  detailedCells: boolean;
  requirementLabel?: string;
}
export function matrixCell(row: MatrixRow, driverId: string): MatrixCell {
  const cell = row.cells[driverId];
  if (!cell) {
    throw new Error(`row ${row.id} missing ${driverId} cell`);
  }
  return cell;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
function isMatrixStatus(value: unknown): value is MatrixStatus {
  return (
    value === "supported" ||
    value === "partial" ||
    value === "unsupported" ||
    value === "not-applicable" ||
    value === "unknown"
  );
}
function validateReferences(refs: unknown, context: string): void {
  if (refs === undefined || refs === null) {
    return;
  }
  if (!isUnknownArray(refs)) {
    throw new Error(`${context}: references must be an array`);
  }
  for (const ref of refs) {
    validateReference(ref, context);
  }
}

function validateReference(ref: unknown, context: string): asserts ref is MatrixReference {
  if (!isRecord(ref)) {
    throw new Error(`${context}: reference must be an object`);
  }
  if (!ref.path || typeof ref.path !== "string") {
    throw new Error(`${context}: reference path must be a string`);
  }
  if (ref.start !== undefined && !Number.isInteger(ref.start)) {
    throw new Error(`${context}: reference start must be an integer`);
  }
  if (ref.end !== undefined && !Number.isInteger(ref.end)) {
    throw new Error(`${context}: reference end must be an integer`);
  }
}

export function validateMatrix(data: unknown, source: string): asserts data is DriverMatrix {
  if (!isRecord(data)) {
    throw new Error(`${source}: matrix JSON must be an object`);
  }
  if (data.repository !== undefined && typeof data.repository !== "string") {
    throw new Error(`${source}: repository must be a string`);
  }
  if (!data.baseline || typeof data.baseline !== "string") {
    throw new Error(`${source}: baseline must be a string`);
  }
  if (!data.reviewedAt || typeof data.reviewedAt !== "string") {
    throw new Error(`${source}: reviewedAt must be a string`);
  }
  if (!isUnknownArray(data.drivers) || data.drivers.length === 0) {
    throw new Error(`${source}: drivers must be a non-empty array`);
  }
  if (!isUnknownArray(data.rows)) {
    throw new Error(`${source}: rows must be an array`);
  }
  const ids = new Set<string>();
  for (const driver of data.drivers) {
    if (!isRecord(driver)) {
      throw new Error(`${source}: driver must be an object`);
    }
    if (!driver.id || typeof driver.id !== "string") {
      throw new Error(`${source}: driver id must be a string`);
    }
    if (ids.has(driver.id)) {
      throw new Error(`${source}: duplicate driver id ${driver.id}`);
    }
    ids.add(driver.id);
    if (!driver.name || typeof driver.name !== "string") {
      throw new Error(`${source}: driver ${driver.id} name must be a string`);
    }
  }
  for (const row of data.rows) {
    if (!isRecord(row)) {
      throw new Error(`${source}: row must be an object`);
    }
    for (const key of ["id", "category", "name", "requirement"]) {
      if (!row[key] || typeof row[key] !== "string") {
        throw new Error(`${source}: row ${key} must be a string`);
      }
    }
    if (row.requirementDetail !== undefined && typeof row.requirementDetail !== "string") {
      throw new Error(`${source}: row ${row.id} requirementDetail must be a string`);
    }
    if (!isRecord(row.cells)) {
      throw new Error(`${source}: row ${row.id} cells must be an object`);
    }
    validateReferences(row.requirementEvidence, `${source}: row ${row.id}`);
    for (const driverId of ids) {
      const cell = row.cells[driverId];
      if (!isRecord(cell)) {
        throw new Error(`${source}: row ${row.id} missing ${driverId} cell`);
      }
      if (!isMatrixStatus(cell.status)) {
        throw new Error(`${source}: row ${row.id} ${driverId} has invalid status`);
      }
      if (typeof cell.detail !== "string") {
        throw new Error(`${source}: row ${row.id} ${driverId} detail must be a string`);
      }
      validateReferences(cell.evidence, `${source}: row ${row.id}`);
      validateReferences(cell.tests, `${source}: row ${row.id}`);
    }
  }
}

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

const escapeCell = (value: string) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
const escapeMarkdownText = (value: string) =>
  escapeCell(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function sourceUrl(data: DriverMatrix, evidence: MatrixReference) {
  return `${data.repository ?? repository}/blob/${data.baseline}/${evidence.path}#L${
    evidence.start
  }-L${evidence.end}`;
}

function sourceLabel(evidence: MatrixReference) {
  return `${evidence.path}:${evidence.start}-${evidence.end}`;
}

function evidenceLinks(data: DriverMatrix, refs: MatrixReference[] | null | undefined) {
  if (!Array.isArray(refs) || refs.length === 0) {
    return "";
  }
  return refs.map((ref) => `[${escapeCell(sourceLabel(ref))}](${sourceUrl(data, ref)})`).join(", ");
}

function renderCompactCell(data: DriverMatrix, cell: MatrixCell, labels: MatrixOptions["labels"]) {
  const label = labels[cell.status];
  if (!label) {
    throw new Error(`Unknown support status: ${cell.status}`);
  }
  const evidence = cell.evidence?.[0];
  return evidence ? `[${label}](${sourceUrl(data, evidence)})` : label;
}

function renderDetailedCell(data: DriverMatrix, cell: MatrixCell, labels: MatrixOptions["labels"]) {
  const label = labels[cell.status];
  if (!label) {
    throw new Error(`Unknown support status: ${cell.status}`);
  }
  const parts = [`**${label}.** ${escapeMarkdownText(cell.detail)}`];
  const sources = evidenceLinks(data, cell.evidence);
  if (sources) {
    parts.push(`Source: ${sources}`);
  }
  const tests = evidenceLinks(data, cell.tests);
  if (tests) {
    parts.push(`Test coverage: ${tests}`);
  }
  return parts.join("<br>");
}

export function renderDriverMatrixMarkdown(data: DriverMatrix, options: MatrixOptions) {
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
      const cell = matrixCell(row, driver.id);
      try {
        return renderCell(data, cell, labels);
      } catch (error) {
        throw new Error(
          `${row.id}/${driver.id}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
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

export function replaceDriverMatrixMarkdown(
  markdown: string,
  data: DriverMatrix,
  options: MatrixOptions,
) {
  const start = markdown.indexOf(options.matrixStart);
  const end = markdown.indexOf(options.matrixEnd);
  if (start < 0 || end < start || markdown.indexOf(options.matrixStart, start + 1) >= 0) {
    throw new Error(`Expected one complete ${options.name} matrix block`);
  }
  return (
    markdown.slice(0, start) +
    renderDriverMatrixMarkdown(data, options) +
    markdown.slice(end + options.matrixEnd.length)
  );
}

export const computeMatrixOptions: MatrixOptions = {
  name: "compute",
  matrixStart,
  matrixEnd,
  dataPath: "docs/assets/compute-driver-matrix.json",
  generator: "scripts/generate-compute-matrix.mjs",
  labels: computeLabels,
  detailedCells: false,
  requirementLabel: "Requirement",
};

export const pluginMatrixOptions: MatrixOptions = {
  name: "plugin",
  matrixStart: "<!-- plugin-matrix:start -->",
  matrixEnd: "<!-- plugin-matrix:end -->",
  dataPath: "docs/assets/plugin-driver-matrix.json",
  generator: "scripts/generate-plugin-matrix.mjs",
  labels: pluginLabels,
  detailedCells: true,
  requirementLabel: "Scope",
};

export function renderMatrixMarkdown(data: DriverMatrix) {
  return renderDriverMatrixMarkdown(data, computeMatrixOptions);
}

export function renderPluginMatrixMarkdown(data: DriverMatrix) {
  return renderDriverMatrixMarkdown(data, pluginMatrixOptions);
}

export function replaceMatrixMarkdown(markdown: string, data: DriverMatrix) {
  return replaceDriverMatrixMarkdown(markdown, data, computeMatrixOptions);
}

export function runDriverMatrixGenerator(options: MatrixOptions, label: string, target: string) {
  if (process.argv.slice(2).some((arg) => arg !== "--check")) {
    throw new Error(`Usage: ${path.basename(options.generator)} [--check]`);
  }
  const data: unknown = JSON.parse(fs.readFileSync(options.dataPath, "utf8"));
  validateMatrix(data, options.dataPath);
  const current = fs.readFileSync(target, "utf8");
  const expected = replaceDriverMatrixMarkdown(current, data, options);
  if (process.argv.includes("--check")) {
    if (current !== expected) {
      throw new Error(`${label} matrix fallback is stale; run node ${options.generator}`);
    }
    console.log(`${label} matrix fallback is current (${data.rows.length} rows).`);
  } else {
    fs.writeFileSync(target, expected);
    console.log(`Updated ${target} (${data.rows.length} rows).`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDriverMatrixGenerator(
    computeMatrixOptions,
    "Compute",
    "docs/reference/drivers/compute-matrix.md",
  );
}
