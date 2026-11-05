import fs from "node:fs";
import path from "node:path";
import {
  computeMatrixOptions,
  matrixCell,
  validateMatrix,
  pluginMatrixOptions,
  renderDriverMatrixMarkdown,
} from "../generate-compute-matrix.ts";

import type {
  DriverMatrix,
  MatrixCell,
  MatrixOptions,
  MatrixReference,
  MatrixStatus,
} from "../generate-compute-matrix.ts";

interface MatrixDefinition extends MatrixOptions {
  requirementLabel: string;
  title: string;
  ariaLabel: string;
  searchLabel: string;
  categoryLabel: string;
  statusLabel: string | null;
  testLabel: string;
  liveProof: string;
  requirementSourceLabel: string;
  notice: string;
}
const statusLabels: Record<MatrixStatus, string> = {
  supported: "Supported",
  partial: "Partial",
  unsupported: "Unsupported",
  "not-applicable": "Not applicable",
  unknown: "Unknown",
};
const statusMarks: Record<MatrixStatus, string> = {
  supported: "✓",
  partial: "✓",
  unsupported: "No",
  "not-applicable": "N/A",
  unknown: "?",
};

const computeDefinition: MatrixDefinition = {
  ...computeMatrixOptions,
  title: "ComputeDriver feature matrix",
  ariaLabel: "ComputeDriver feature matrix",
  searchLabel: "Search ComputeDriver feature matrix",
  categoryLabel: "Filter ComputeDriver feature matrix by category",
  statusLabel: null,
  testLabel: "Tests (not run)",
  liveProof: "unknown/not run",
  requirementLabel: "Requirement",
  requirementSourceLabel: "Requirement source",
  notice:
    "Unknown means the available evidence does not establish support for that driver cell. Test links identify repository coverage only; they are not live-runtime proof.",
};
const pluginDefinition: MatrixDefinition = {
  ...pluginMatrixOptions,
  title: "PluginDriver feature matrix",
  ariaLabel: "PluginDriver feature matrix",
  searchLabel: "Search PluginDriver feature matrix",
  categoryLabel: "Filter PluginDriver feature matrix by category",
  statusLabel: "Filter PluginDriver feature matrix by status",
  testLabel: "Test coverage",
  liveProof: "unknown/not run",
  requirementLabel: "Scope",
  requirementSourceLabel: "Reference",
  notice:
    "The status filter matches either Driver cell. Test links identify repository coverage; source support is not live-runtime proof.",
};
const matrixDefinitions = [computeDefinition, pluginDefinition];

function escapeHtml(value: string) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value: string) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

function sourceLabel(ref: MatrixReference) {
  const suffix =
    Number.isInteger(ref.start) && Number.isInteger(ref.end)
      ? `:${ref.start}-${ref.end}`
      : Number.isInteger(ref.start)
        ? `:${ref.start}`
        : "";
  return `${ref.path}${suffix}`;
}

function sourceUrl(data: DriverMatrix, ref: MatrixReference) {
  const file = String(ref.path ?? "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const line =
    Number.isInteger(ref.start) && Number.isInteger(ref.end)
      ? `#L${ref.start}-L${ref.end}`
      : Number.isInteger(ref.start)
        ? `#L${ref.start}`
        : "";
  return `https://github.com/openclaw/openclaw-enterprise/blob/${encodeURIComponent(
    data.baseline,
  )}/${file}${line}`;
}

function renderReferenceList(
  data: DriverMatrix,
  label: string,
  refs: MatrixReference[] | null | undefined,
) {
  if (!Array.isArray(refs) || refs.length === 0) {
    return "";
  }
  return (
    '<details class="compute-matrix-evidence"><summary>' +
    escapeHtml(label) +
    "</summary><p>" +
    refs
      .map(
        (ref) =>
          '<a href="' +
          escapeAttr(sourceUrl(data, ref)) +
          '">' +
          escapeHtml(sourceLabel(ref)) +
          "</a>",
      )
      .join(", ") +
    "</p></details>"
  );
}

function renderCell(data: DriverMatrix, cell: MatrixCell, definition: MatrixDefinition) {
  const status = cell.status;
  return (
    '<details class="compute-matrix-cell compute-matrix-status-' +
    escapeAttr(status) +
    '"><summary><span class="compute-matrix-mark" aria-hidden="true">' +
    escapeHtml(statusMarks[status]) +
    '</span><span class="compute-matrix-status-label">' +
    escapeHtml(statusLabels[status]) +
    "</span></summary><p>" +
    escapeHtml(cell.detail) +
    "</p>" +
    renderReferenceList(data, "Source", cell.evidence) +
    renderReferenceList(data, definition.testLabel, cell.tests) +
    '<p class="compute-matrix-live-proof"><span>Live proof:</span> ' +
    escapeHtml(definition.liveProof) +
    "</p>" +
    "</details>"
  );
}

export function renderComputeMatrix(
  data: unknown,
  definition: MatrixDefinition = computeDefinition,
) {
  validateMatrix(data, "compute matrix");
  const categories = [...new Set(data.rows.map((row) => row.category))].sort((a, b) =>
    a.localeCompare(b),
  );
  const statusOptions = Object.entries(statusLabels)
    .filter(([status]) =>
      data.rows.some((row) =>
        data.drivers.some((driver) => matrixCell(row, driver.id).status === status),
      ),
    )
    .map(
      ([status, label]) =>
        '<option value="' + escapeAttr(status) + '">' + escapeHtml(label) + "</option>",
    )
    .join("");
  const driverHeaders = data.drivers
    .map((driver) => '<th scope="col">' + escapeHtml(driver.name) + "</th>")
    .join("");
  const categoryOptions = categories
    .map(
      (category) =>
        '<option value="' + escapeAttr(category) + '">' + escapeHtml(category) + "</option>",
    )
    .join("");
  const rows = data.rows
    .map((row) => {
      const text = [row.category, row.name, row.requirement]
        .concat(row.requirementDetail ?? [])
        .concat(
          data.drivers.flatMap((driver) => [
            matrixCell(row, driver.id).status,
            matrixCell(row, driver.id).detail,
          ]),
        )
        .join(" ")
        .toLocaleLowerCase("en-US");
      const rowStatuses = data.drivers.map((driver) => matrixCell(row, driver.id).status).join(" ");
      const cells = data.drivers
        .map(
          (driver) => "<td>" + renderCell(data, matrixCell(row, driver.id), definition) + "</td>",
        )
        .join("");
      return (
        '<tr data-compute-matrix-row data-category="' +
        escapeAttr(row.category) +
        '" data-statuses="' +
        escapeAttr(rowStatuses) +
        '" data-search="' +
        escapeAttr(text) +
        '"><th scope="row"><span class="compute-matrix-category">' +
        escapeHtml(row.category) +
        "</span>" +
        escapeHtml(row.name) +
        '</th><td class="compute-matrix-requirement">' +
        escapeHtml(row.requirement) +
        (row.requirementDetail
          ? '<p class="compute-matrix-requirement-detail">' +
            escapeHtml(row.requirementDetail) +
            "</p>"
          : "") +
        renderReferenceList(data, definition.requirementSourceLabel, row.requirementEvidence) +
        "</td>" +
        cells +
        "</tr>"
      );
    })
    .join("");
  return (
    '<section class="compute-matrix" data-compute-matrix><div class="compute-matrix-head"><div><p class="compute-matrix-eyebrow">' +
    escapeHtml(definition.title) +
    '</p><p class="compute-matrix-meta">Reviewed ' +
    escapeHtml(data.reviewedAt) +
    ' at baseline <a href="https://github.com/openclaw/openclaw-enterprise/commit/' +
    escapeAttr(data.baseline) +
    '"><code>' +
    escapeHtml(data.baseline) +
    '</code></a>.</p><p class="compute-matrix-notice">' +
    escapeHtml(definition.notice) +
    '</p></div><div class="compute-matrix-controls" role="search"><label>Search <input type="search" data-compute-matrix-search aria-label="' +
    escapeAttr(definition.searchLabel) +
    '"></label><label>Category <select data-compute-matrix-category aria-label="' +
    escapeAttr(definition.categoryLabel) +
    '"><option value="">All categories</option>' +
    categoryOptions +
    "</select></label>" +
    (definition.statusLabel
      ? '<label>Status <select data-compute-matrix-status aria-label="' +
        escapeAttr(definition.statusLabel) +
        '"><option value="">All statuses</option>' +
        statusOptions +
        "</select></label>"
      : "") +
    '</div></div><p class="compute-matrix-count" data-compute-matrix-count aria-live="polite">' +
    data.rows.length +
    " rows</p>" +
    '<div class="compute-matrix-table" role="region" aria-label="' +
    escapeAttr(definition.ariaLabel) +
    '" tabindex="0"><table><thead><tr><th scope="col">Capability</th><th scope="col">' +
    escapeHtml(definition.requirementLabel) +
    "</th>" +
    driverHeaders +
    "</tr></thead><tbody>" +
    rows +
    "</tbody></table></div></section>"
  );
}

export function renderComputeMatrixBlocks(
  markdown: string,
  { sourceFile, root }: { sourceFile: string; root: string },
) {
  let rendered = markdown;
  for (const definition of matrixDefinitions) {
    const blockPattern = new RegExp(
      definition.matrixStart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        "([\\s\\S]*?)" +
        definition.matrixEnd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "g",
    );
    rendered = rendered.replace(blockPattern, (match) => {
      const matrixSource = definition.dataPath.replace(/^docs\//, "");
      const matrixFile = path.resolve(root, matrixSource);
      let data: unknown;
      try {
        data = JSON.parse(fs.readFileSync(matrixFile, "utf8"));
      } catch (error) {
        throw new Error(
          `${sourceFile}: ${definition.name}-matrix could not read ${matrixSource}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      validateMatrix(data, matrixSource);
      const expected = renderDriverMatrixMarkdown(data, definition);
      if (match !== expected) {
        throw new Error(
          `${sourceFile}: ${definition.name}-matrix fallback is stale; run node ${definition.generator}`,
        );
      }
      return "\n" + renderComputeMatrix(data, definition) + "\n";
    });
  }
  return rendered;
}
