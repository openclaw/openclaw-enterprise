import fs from "node:fs";
import path from "node:path";
import { renderMatrixMarkdown } from "../generate-compute-matrix.mjs";

const blockPattern = /<!--\s*compute-matrix:start\s*-->([\s\S]*?)<!--\s*compute-matrix:end\s*-->/g;
const statuses = new Set(["supported", "partial", "unsupported", "unknown"]);
const statusLabels = {
  supported: "Supported",
  partial: "Partial",
  unsupported: "Unsupported",
  unknown: "Unknown",
};
const statusMarks = {
  supported: "✓",
  partial: "✓",
  unsupported: "No",
  unknown: "?",
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

function sourceLabel(ref) {
  const suffix =
    Number.isInteger(ref.start) && Number.isInteger(ref.end)
      ? `:${ref.start}-${ref.end}`
      : Number.isInteger(ref.start)
        ? `:${ref.start}`
        : "";
  return `${ref.path}${suffix}`;
}

function sourceUrl(data, ref) {
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

function renderReferenceList(data, label, refs) {
  if (!Array.isArray(refs) || refs.length === 0) return "";
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

function validateReference(ref, context) {
  if (!ref || typeof ref !== "object") throw new Error(`${context}: reference must be an object`);
  if (!ref.path || typeof ref.path !== "string")
    throw new Error(`${context}: reference path must be a string`);
  if (ref.start !== undefined && !Number.isInteger(ref.start))
    throw new Error(`${context}: reference start must be an integer`);
  if (ref.end !== undefined && !Number.isInteger(ref.end))
    throw new Error(`${context}: reference end must be an integer`);
}

function validateMatrix(data, source) {
  if (!data || typeof data !== "object")
    throw new Error(`${source}: matrix JSON must be an object`);
  if (!data.baseline || typeof data.baseline !== "string")
    throw new Error(`${source}: baseline must be a string`);
  if (!data.reviewedAt || typeof data.reviewedAt !== "string")
    throw new Error(`${source}: reviewedAt must be a string`);
  if (!Array.isArray(data.drivers) || data.drivers.length === 0)
    throw new Error(`${source}: drivers must be a non-empty array`);
  if (!Array.isArray(data.rows)) throw new Error(`${source}: rows must be an array`);
  const ids = new Set();
  for (const driver of data.drivers) {
    if (!driver || typeof driver !== "object")
      throw new Error(`${source}: driver must be an object`);
    if (!driver.id || typeof driver.id !== "string")
      throw new Error(`${source}: driver id must be a string`);
    if (ids.has(driver.id)) throw new Error(`${source}: duplicate driver id ${driver.id}`);
    ids.add(driver.id);
    if (!driver.name || typeof driver.name !== "string")
      throw new Error(`${source}: driver ${driver.id} name must be a string`);
  }
  for (const row of data.rows) {
    if (!row || typeof row !== "object") throw new Error(`${source}: row must be an object`);
    for (const key of ["id", "category", "name", "requirement"]) {
      if (!row[key] || typeof row[key] !== "string")
        throw new Error(`${source}: row ${key} must be a string`);
    }
    if (row.requirementDetail !== undefined && typeof row.requirementDetail !== "string")
      throw new Error(`${source}: row ${row.id} requirementDetail must be a string`);
    if (!row.cells || typeof row.cells !== "object")
      throw new Error(`${source}: row ${row.id} cells must be an object`);
    for (const ref of row.requirementEvidence ?? [])
      validateReference(ref, `${source}: row ${row.id}`);
    for (const driver of data.drivers) {
      const cell = row.cells[driver.id];
      if (!cell || typeof cell !== "object")
        throw new Error(`${source}: row ${row.id} missing ${driver.id} cell`);
      if (!statuses.has(cell.status))
        throw new Error(`${source}: row ${row.id} ${driver.id} has invalid status`);
      if (typeof cell.detail !== "string")
        throw new Error(`${source}: row ${row.id} ${driver.id} detail must be a string`);
      for (const ref of cell.evidence ?? []) validateReference(ref, `${source}: row ${row.id}`);
      for (const ref of cell.tests ?? []) validateReference(ref, `${source}: row ${row.id}`);
    }
  }
}

function renderCell(data, cell) {
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
    renderReferenceList(data, "Tests (not run)", cell.tests) +
    '<p class="compute-matrix-live-proof"><span>Live proof:</span> unknown/not run</p>' +
    "</details>"
  );
}

export function renderComputeMatrix(data) {
  validateMatrix(data, "compute matrix");
  const categories = [...new Set(data.rows.map((row) => row.category))].sort((a, b) =>
    a.localeCompare(b),
  );
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
            row.cells[driver.id].status,
            row.cells[driver.id].detail,
          ]),
        )
        .join(" ")
        .toLocaleLowerCase("en-US");
      const cells = data.drivers
        .map((driver) => "<td>" + renderCell(data, row.cells[driver.id]) + "</td>")
        .join("");
      return (
        '<tr data-compute-matrix-row data-category="' +
        escapeAttr(row.category) +
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
        renderReferenceList(data, "Requirement source", row.requirementEvidence) +
        "</td>" +
        cells +
        "</tr>"
      );
    })
    .join("");
  return (
    '<section class="compute-matrix" data-compute-matrix><div class="compute-matrix-head"><div><p class="compute-matrix-eyebrow">ComputeDriver feature matrix</p><p class="compute-matrix-meta">Reviewed ' +
    escapeHtml(data.reviewedAt) +
    ' at baseline <a href="https://github.com/openclaw/openclaw-enterprise/commit/' +
    escapeAttr(data.baseline) +
    '"><code>' +
    escapeHtml(data.baseline) +
    '</code></a>.</p><p class="compute-matrix-notice">Unknown means the available evidence does not establish support for that driver cell. Test links identify repository coverage only; they are not live-runtime proof.</p></div><div class="compute-matrix-controls" role="search"><label>Search <input type="search" data-compute-matrix-search aria-label="Search ComputeDriver feature matrix"></label><label>Category <select data-compute-matrix-category aria-label="Filter ComputeDriver feature matrix by category"><option value="">All categories</option>' +
    categoryOptions +
    '</select></label></div></div><p class="compute-matrix-count" data-compute-matrix-count aria-live="polite">' +
    data.rows.length +
    " rows</p>" +
    '<div class="compute-matrix-table" role="region" aria-label="ComputeDriver feature matrix" tabindex="0"><table><thead><tr><th scope="col">Capability</th><th scope="col">Requirement</th>' +
    driverHeaders +
    "</tr></thead><tbody>" +
    rows +
    "</tbody></table></div></section>"
  );
}

export function renderComputeMatrixBlocks(markdown, { sourceFile, root }) {
  return markdown.replace(blockPattern, (match) => {
    const matrixSource = "assets/compute-driver-matrix.json";
    const matrixFile = path.resolve(root, matrixSource);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(matrixFile, "utf8"));
    } catch (error) {
      throw new Error(
        `${sourceFile}: compute-matrix could not read ${matrixSource}: ${error.message}`,
      );
    }
    validateMatrix(data, matrixSource);
    const expected = renderMatrixMarkdown(data);
    if (match !== expected)
      throw new Error(
        `${sourceFile}: compute-matrix fallback is stale; run node scripts/generate-compute-matrix.mjs`,
      );
    return "\n" + renderComputeMatrix(data) + "\n";
  });
}
