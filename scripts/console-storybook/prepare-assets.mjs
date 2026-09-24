import { cp, mkdir, copyFile, rm, readFile, writeFile } from "node:fs/promises";

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

// Preview shipped Presets so screenshots follow their current contracts.
for (const name of [
  "standard-codex",
  "standard-openclaw",
  "devday",
  "devday-qa",
  "devday-oncall",
]) {
  await writeFile(
    new URL(`${name}-preset.mjs`, assets),
    `export default ${await readFile(new URL(`../../deploy/presets/${name}.json`, import.meta.url), "utf8")};\n`,
  );
}
