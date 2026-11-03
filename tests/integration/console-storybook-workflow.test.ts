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
  // prepare-assets.mjs renders the preview frame from the example theme.
  { name: "theme only", changed: ["deploy/examples/console-theme/theme.json"], builds: true },
  // prepare-assets.mjs bundles the shipped Presets into the preview.
  { name: "consumed Preset only", changed: ["deploy/presets/swe-preset.json"], builds: true },
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
    changed: ["scripts/console-storybook/.storybook/main.mjs"],
    builds: true,
  },
];

for (const event of ["pull_request", "push"] as const) {
  test(`${event} builds Storybook only for changes that alter its output`, async () => {
    const workflow = loadYaml(await readFile(workflowFile, "utf8"));
    // The workflow starts when at least one changed file survives the whole list.
    for (const { name, changed, builds } of scenarios) {
      const starts = changed.some((file) => selects(file, workflow.on[event].paths));
      assert.equal(starts, builds, name);
    }
  });
}
