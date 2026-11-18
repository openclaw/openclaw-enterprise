import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  copyFile,
  rm,
  readFile,
  writeFile,
  readdir,
  stat,
  lstat,
} from "node:fs/promises";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

import { loadConsoleTheme } from "../../apps/controller/src/composition/console-theme.ts";
import { consoleAssetPaths, readConsoleAsset } from "../../apps/controller/src/console-assets.ts";
import { renderConsoleThemeShell } from "../../apps/controller/src/console-theme.ts";

async function includeFixture(path: string): Promise<boolean> {
  if (/\.(js|mjs|cjs)$/.test(path) && (await stat(path)).isFile()) {
    throw new Error(`Authored Storybook JavaScript is not allowed: ${path}. Use .mts instead.`);
  }
  return !path.endsWith(".mts");
}

async function validateFixtures(path: string): Promise<void> {
  if (!(await includeFixture(path)) || !(await lstat(path)).isDirectory()) {
    return;
  }
  for (const name of await readdir(path)) {
    await validateFixtures(join(path, name));
  }
}

const fixtureSource = new URL("./public/", import.meta.url);
// Reject authored JavaScript before replacing either existing preview tree.
await validateFixtures(fileURLToPath(fixtureSource));

const assets = new URL("./dist/assets/console/", import.meta.url);
await rm(assets, { recursive: true, force: true });
await mkdir(assets, { recursive: true });
await writeFile(new URL("index.html", assets), (await readConsoleAsset("/console/")).body);
for (const path of consoleAssetPaths()) {
  const file = new URL(path.slice("/console/".length), assets);
  await mkdir(new URL(".", file), { recursive: true });
  await writeFile(file, (await readConsoleAsset(path)).body);
}
// Keep the font license alongside the font when distributing this static preview.
const license = "fonts/instrument-sans-OFL.txt";
await copyFile(
  new URL(`../../apps/controller/src/console/${license}`, import.meta.url),
  new URL(license, assets),
);

await copyFile(
  new URL("agents/plugin-fields.mjs", assets),
  new URL("agents/plugin-fields.production.mjs", assets),
);
await writeFile(
  new URL("agents/plugin-fields.mjs", assets),
  stripTypeScriptTypes(
    await readFile(new URL("./plugin-fields.storybook-wrapper.mts", import.meta.url), "utf8"),
  ),
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
await cp(fixtureSource, fixtureAssets, {
  recursive: true,
  filter: includeFixture,
});
for (const path of await readdir(fixtureSource, { recursive: true })) {
  if (!path.endsWith(".mts")) {
    continue;
  }
  const source = await readFile(new URL(`./${path}`, fixtureSource), "utf8");
  const output = new URL(`./${path.replace(/\.mts$/, ".mjs")}`, fixtureAssets);
  // A generated module must never replace an authored fixture at the same URL.
  await writeFile(output, stripTypeScriptTypes(source), { flag: "wx" });
}
// Use the production loader and shell renderer; only resource/API state is simulated.
const theme = await loadConsoleTheme(
  process.env.OCC_CONSOLE_THEME_DIR ??
    fileURLToPath(new URL("../../deploy/examples/console-theme/", import.meta.url)),
);
if (theme === undefined) {
  throw new Error("Storybook requires a Console theme.");
}
const frame = await readFile(new URL("frame.html", fixtureAssets), "utf8");
await mkdir(new URL("theme/", assets), { recursive: true });
for (const path of theme.assets.keys()) {
  const file = new URL(path.slice("/console/".length), assets);
  await writeFile(file, (await readConsoleAsset(path, undefined, theme)).body);
}
await writeFile(new URL("frame-themed.html", fixtureAssets), renderConsoleThemeShell(frame, theme));
await writeFile(
  new URL("frame-long-name.html", fixtureAssets),
  renderConsoleThemeShell(frame, {
    ...theme,
    displayName: "Example Agents for the shared research and engineering workspace",
  }),
);
const assetRoot = new URL("./dist/assets/", import.meta.url);
const paths = (await readdir(assetRoot, { recursive: true }))
  .filter((path) => /\.(mjs|html|css)$/.test(path))
  .sort();
const files = await Promise.all(
  paths.map(async (path) => ({
    path,
    content: await readFile(new URL(`./${path}`, assetRoot), "utf8"),
  })),
);
const hash = createHash("sha256");
for (const { path, content } of files) {
  hash.update(path).update(content);
}
const version = hash.digest("hex").slice(0, 16);
for (const file of files) {
  const { path } = file;
  let { content } = file;
  if (path.endsWith(".mjs") && !path.endsWith("-preset.mjs")) {
    content = content.replace(
      /((?:from\s*|import\s*\(\s*|import\s*)["'])([./][^"']+)\.m[jt]s(["'])/g,
      `$1$2.mjs?v=${version}$3`,
    );
  } else if (path.endsWith(".html")) {
    content = content.replace(/((?:src|href)="[^"?]+\.(?:mjs|css))"/g, `$1?v=${version}"`);
  }
  await writeFile(new URL(`./${path}`, assetRoot), content);
}
await writeFile(new URL("./dist/asset-version.json", import.meta.url), JSON.stringify(version));
