import { createHash } from "node:crypto";
import { cp, mkdir, copyFile, rm, readFile, writeFile, readdir } from "node:fs/promises";

const assets = new URL("./dist/assets/console/", import.meta.url);
await rm(assets, { recursive: true, force: true });
await mkdir(assets, { recursive: true });
await cp(new URL("../../apps/controller/src/console/", import.meta.url), assets, {
  recursive: true,
});
// The controller serves these shared contract modules as console assets.
await copyFile(
  new URL("../../packages/contracts/src/workspace-defaults.mjs", import.meta.url),
  new URL("workspace-defaults.mjs", assets),
);
await copyFile(
  new URL("../../packages/contracts/src/preset-variables.mjs", import.meta.url),
  new URL("preset-variables.mjs", assets),
);

await copyFile(
  new URL("agents/plugin-fields.mjs", assets),
  new URL("agents/plugin-fields.production.mjs", assets),
);
await writeFile(
  new URL("agents/plugin-fields.mjs", assets),
  await readFile(new URL("./plugin-fields.storybook-wrapper.mjs", import.meta.url), "utf8"),
);

// Preview shipped Presets so screenshots follow their current contracts.
for (const [name, file] of [
  ["default-codex", "default-codex"],
  ["standard-codex", "standard-codex"],
  ["standard-openclaw", "standard-openclaw"],
  ["swe", "swe-preset"],
]) {
  await writeFile(
    new URL(`${name}-preset.mjs`, assets),
    `export default ${await readFile(new URL(`../../deploy/presets/${file}.json`, import.meta.url), "utf8")};\n`,
  );
}

// Version the entire static module graph so an existing rehearsal browser cannot
// mix cached Console/preset modules with a newly built Storybook manager.
const fixtureAssets = new URL("./dist/assets/storybook-fixtures/", import.meta.url);
await rm(fixtureAssets, { recursive: true, force: true });
await cp(new URL("./public/", import.meta.url), fixtureAssets, { recursive: true });
const files = (await readdir(new URL("./dist/assets/", import.meta.url), { recursive: true }))
  .filter((path) => /\.(mjs|html|css)$/.test(path))
  .sort();
const contents = await Promise.all(
  files.map((path) => readFile(new URL(`./dist/assets/${path}`, import.meta.url), "utf8")),
);
const hash = createHash("sha256");
files.forEach((path, index) => hash.update(path).update(contents[index]));
const version = hash.digest("hex").slice(0, 16);
for (const [index, path] of files.entries()) {
  let content = contents[index];
  if (path.endsWith(".mjs") && !path.endsWith("-preset.mjs")) {
    content = content.replace(
      /((?:from\s*|import\s*\(\s*|import\s*)["'])([./][^"']+\.mjs)(["'])/g,
      `$1$2?v=${version}$3`,
    );
  } else if (path.endsWith(".html")) {
    content = content.replace(/((?:src|href)="[^"?]+\.(?:mjs|css))"/g, `$1?v=${version}"`);
  }
  await writeFile(new URL(`./dist/assets/${path}`, import.meta.url), content);
}
await writeFile(new URL("./dist/asset-version.json", import.meta.url), JSON.stringify(version));
