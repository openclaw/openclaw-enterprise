import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { nativeProbe } from "./client.ts";

export interface FixtureSetup {
  configuration: string;
  environment: Record<string, string>;
  mode: "protected" | "stock";
}

const setup: FixtureSetup = JSON.parse(await readFile("/fixture/setup.json", "utf8"));
process.env = {
  PATH: process.env.PATH,
  HOME: "/tmp/home",
  CODEX_HOME: "/tmp/home/.codex",
  ...setup.environment,
};
await mkdir(process.env.CODEX_HOME!, { recursive: true });
await mkdir("/tmp/workspace", { recursive: true });
await writeFile(process.env.CODEX_HOME + "/config.toml", setup.configuration);
if (setup.mode === "protected") {
  // This artifact comes directly from OCE's production launcher producer.
  createRequire(import.meta.url)("/fixture/generated-launcher.cjs");
} else {
  await nativeProbe("stock");
}
