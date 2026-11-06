import { element } from "./dom.mjs";

interface CatalogRow {
  name: string;
  details: readonly (string | HTMLElement)[];
  actions: readonly HTMLButtonElement[];
}

export function oauthCatalog(
  title: string,
  create: HTMLButtonElement,
  nameColumn: string,
  detailColumns: readonly string[],
) {
  const list = element("div", { className: "oauth-catalog-list" });
  const notice = element("p", { className: "hint oauth-catalog-notice", role: "status" });
  const section = element(
    "section",
    { className: "resource-list oauth-catalog" },
    element("header", { className: "oauth-catalog-heading" }, element("h2", {}, title), create),
    list,
    notice,
  );

  function showRows(rows: readonly CatalogRow[]) {
    if (!rows.length) {
      list.replaceChildren();
      return;
    }
    const header = element("tr");
    for (const label of [nameColumn, ...detailColumns, "Actions"]) {
      header.append(element("th", { scope: "col" }, label));
    }
    const body = element("tbody");
    for (const row of rows) {
      body.append(
        element(
          "tr",
          {},
          element("th", { scope: "row" }, row.name),
          ...row.details.map((value, index) =>
            element("td", { "data-label": detailColumns[index] }, value),
          ),
          element("td", {}, element("div", { className: "resource-row-actions" }, ...row.actions)),
        ),
      );
    }
    list.replaceChildren(
      element(
        "table",
        { className: "oauth-catalog-table", "aria-label": title },
        element("thead", {}, header),
        body,
      ),
    );
  }

  return { section, list, notice, showRows };
}
