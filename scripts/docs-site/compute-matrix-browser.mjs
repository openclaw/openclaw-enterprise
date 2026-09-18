function normalize(value) {
  return value.trim().toLocaleLowerCase("en-US");
}

function updateMatrix(matrix) {
  const search = normalize(matrix.querySelector("[data-compute-matrix-search]")?.value ?? "");
  const category = matrix.querySelector("[data-compute-matrix-category]")?.value ?? "";
  const status = matrix.querySelector("[data-compute-matrix-status]")?.value ?? "";
  const rows = [...matrix.querySelectorAll("[data-compute-matrix-row]")];
  let visible = 0;
  for (const row of rows) {
    const matchesSearch = !search || row.dataset.search.includes(search);
    const matchesCategory = !category || row.dataset.category === category;
    const matchesStatus = !status || row.dataset.statuses.split(" ").includes(status);
    const shown = matchesSearch && matchesCategory && matchesStatus;
    row.hidden = !shown;
    if (shown) {
      visible++;
    }
  }
  const count = matrix.querySelector("[data-compute-matrix-count]");
  if (count) {
    count.textContent = `${visible} ${visible === 1 ? "row" : "rows"}`;
  }
}

for (const matrix of document.querySelectorAll("[data-compute-matrix]")) {
  for (const control of matrix.querySelectorAll(
    "[data-compute-matrix-search], [data-compute-matrix-category], [data-compute-matrix-status]",
  )) {
    control.addEventListener("input", () => updateMatrix(matrix));
  }
  updateMatrix(matrix);
}
