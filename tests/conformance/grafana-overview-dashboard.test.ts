import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const demoPath = "deploy/helm/openclaw-observability-demo/files/overview-dashboard.json";
const developmentPath = "deploy/metrics/development/grafana/overview-dashboard.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPanel(value: unknown): value is { options?: { content?: string | null } | null } {
  if (!isRecord(value)) {
    return false;
  }
  const options = value.options;
  return (
    options == null ||
    (isRecord(options) && (options.content == null || typeof options.content === "string"))
  );
}

async function dashboard(path: string) {
  const overview: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.ok(isRecord(overview));
  const panels: unknown = overview.panels;
  assert.ok(Array.isArray(panels));
  const entries: unknown[] = panels;
  assert.ok(entries.every(isPanel));
  return { uid: overview.uid, panels: entries };
}

function markdownLinks(content: string) {
  return [...content.matchAll(/\]\(([^)]*)\)/gu)].map((match) => {
    const link = match[1];
    assert.ok(link !== undefined);
    return link;
  });
}

test("overview dashboard links resolve under a Grafana sub-path", async () => {
  for (const path of [demoPath, developmentPath]) {
    const overview = await dashboard(path);
    const links = overview.panels.flatMap((panel) => markdownLinks(panel.options?.content ?? ""));
    assert.ok(links.length > 0, path);
    for (const link of links) {
      // Grafana pages carry <base href="{app sub-URL}/">, so ./d/... stays under
      // root_url with serve_from_sub_path; a root-absolute /d/... escapes it.
      // Its text-panel sanitizer drops a bare d/... href, so keep the ./ prefix.
      assert.match(link, /^\.\/d\/[a-z-]+$/u, `${path}: ${link}`);
    }
  }
});

test("overview dashboards expose metrics and reserve logs for the demo", async () => {
  // Both environments use the same dashboard route; development has no Loki.
  for (const path of [demoPath, developmentPath]) {
    const overview = await dashboard(path);
    assert.equal(overview.uid, "occ-observability", path);
    const links = overview.panels.flatMap((panel) => markdownLinks(panel.options?.content ?? ""));
    assert.ok(links.includes("./d/occ-development"), path);
    assert.equal(links.includes("./d/occ-logs"), path === demoPath, path);
  }
});
