import { cp, mkdir, copyFile, rm } from "node:fs/promises";

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
