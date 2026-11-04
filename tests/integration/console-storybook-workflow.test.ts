import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const controller = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const { loadYaml } = controller("@kubernetes/client-node");
const workflowFile = new URL("../../.github/workflows/console-storybook.yml", import.meta.url);

// GitHub's documented filter rules: "*" stops at "/", "**" does not, "**/" may match no
// directory, and a later "!" pattern removes files an earlier pattern selected.
function matches(file: string, pattern: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/|\*\*|\*/g, (star) =>
      star === "**/" ? "(?:.*/)?" : star === "*" ? "[^/]*" : ".*",
    );
  return new RegExp(`^${source}$`).test(file);
}

function selects(file: string, patterns: string[]): boolean {
  let selected = false;
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      selected &&= !matches(file, pattern.slice(1));
    } else {
      selected ||= matches(file, pattern);
    }
  }
  return selected;
}

const evidence = "scripts/console-storybook/evidence/console-navigation";
const scenarios = [
  // The preview asset builder renders the preview frame from the example theme.
  { name: "theme only", changed: ["deploy/examples/console-theme/theme.json"], builds: true },
  // The preview asset builder bundles the shipped Presets into the preview.
  { name: "consumed Preset only", changed: ["deploy/presets/swe-preset.json"], builds: true },
  {
    name: "typed asset preparer only",
    changed: ["scripts/console-storybook/prepare-assets.ts"],
    builds: true,
  },
  // Recordings are outside the published Storybook assets, so they need no build.
  {
    name: "recorded media only",
    changed: [
      `${evidence}/repository-outage.png`,
      `${evidence}/repository-outage.mp4`,
      "scripts/console-storybook/evidence/overview.png",
    ],
    builds: false,
  },
  // A frame under public/ is published, so media in the same change cannot hide it.
  {
    name: "media with a published frame",
    changed: [`${evidence}/repository-outage.webm`, "scripts/console-storybook/public/frame.html"],
    builds: true,
  },
  {
    name: "Storybook configuration",
    changed: ["scripts/console-storybook/.storybook/main.ts"],
    builds: true,
  },
  {
    name: "typed preview consumer",
    changed: ["scripts/console-storybook/flows.stories.ts"],
    builds: true,
  },
  {
    name: "unrelated OCC source",
    changed: ["packages/occ/src/deployment-diagnostics.ts"],
    builds: false,
  },
];

for (const event of ["pull_request", "push"] as const) {
  test(`${event} selects Console Storybook build paths`, async () => {
    const workflow = loadYaml(await readFile(workflowFile, "utf8"));
    // The workflow starts when at least one changed file survives the whole list.
    for (const { name, changed, builds } of scenarios) {
      const starts = changed.some((file) => selects(file, workflow.on[event].paths));
      assert.equal(starts, builds, name);
    }
  });
}

test("shared preview inputs select the Storybook build only on pushes to main", async (t) => {
  const workflow = loadYaml(await readFile(workflowFile, "utf8"));
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  for (const path of [
    "apps/controller/src/console-theme.ts",
    "apps/controller/src/composition/console-theme.ts",
    "packages/contracts/src/workspace-defaults.mjs",
    "packages/occ/src/environment-references.ts",
    "packages/occ/src/gateway-security-defaults.ts",
    "packages/occ/src/stored-configuration-rules.ts",
    "packages/occ/src/retired-openclaw-settings.ts",
    "packages/occ/src/deployment-failure-steps.ts",
  ]) {
    await t.test(path, () => {
      assert.equal(selects(path, workflow.on.pull_request.paths), false, "pull_request");
      assert.equal(selects(path, workflow.on.push.paths), true, "push to main");
    });
  }
});
