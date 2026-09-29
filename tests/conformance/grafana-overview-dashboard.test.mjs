import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const demoPath = "deploy/helm/openclaw-observability-demo/files/overview-dashboard.json";
const developmentPath = "deploy/metrics/development/grafana/overview-dashboard.json";
const logsEntry = "\n- [Operational logs](./d/occ-logs) — filtered OCC and runtime events.";

async function dashboard(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function markdownLinks(content) {
  return [...content.matchAll(/\]\(([^)]*)\)/gu)].map((match) => match[1]);
}

test("overview dashboard links resolve under a Grafana sub-path", async () => {
  for (const path of [demoPath, developmentPath]) {
    const links = markdownLinks((await dashboard(path)).panels[0].options.content);
    assert.ok(links.length > 0, path);
    for (const link of links) {
      // Grafana pages carry <base href="{app sub-URL}/">, so ./d/... stays under
      // root_url with serve_from_sub_path; a root-absolute /d/... escapes it.
      // Its text-panel sanitizer drops a bare d/... href, so keep the ./ prefix.
      assert.match(link, /^\.\/d\/[a-z-]+$/u, `${path}: ${link}`);
    }
  }
});

test("development overview is the demo overview without the logs view", async () => {
  // Both copies provision the same uid into separate Grafana instances. The
  // development stack has no Loki, so its copy omits only the logs entry.
  const demo = await dashboard(demoPath);
  const development = await dashboard(developmentPath);
  assert.ok(demo.panels[0].options.content.includes(logsEntry));
  const expected = structuredClone(demo);
  expected.description = "Open the OCC metrics view.";
  expected.panels[0].gridPos.h = 5;
  expected.panels[0].options.content = demo.panels[0].options.content.replace(logsEntry, "");
  assert.deepEqual(development, expected);
});
