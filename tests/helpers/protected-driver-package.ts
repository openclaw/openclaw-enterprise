import { mkdir, readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { temporaryDirectory } from "./temporary-directory.mjs";

/**
 * Install a fixture Driver package from `tests/fixtures/driver-packages/<fixture>/` in a private
 * controller package root, compiled to plain ESM, so the external package loader sees it as an
 * independently authored dependency. `files[0]` is the package entry.
 */
export async function installedDriverPackage(
  t: TestContext,
  id: string,
  fixture: string,
  files: readonly [string, ...string[]],
) {
  const directory = await temporaryDirectory(t, `oce-${fixture}-`);
  const entry = join(directory, "node_modules", id);
  await mkdir(entry, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ dependencies: { [id]: "1.0.0" } }),
  );
  await writeFile(
    join(entry, "package.json"),
    JSON.stringify({ name: id, version: "1.0.0", exports: "./" + files[0] + ".mjs" }),
  );
  for (const name of files) {
    const source = await readFile(
      new URL(`../fixtures/driver-packages/${fixture}/${name}.ts`, import.meta.url),
      "utf8",
    );
    const js = stripTypeScriptTypes(source).replace('"./index.ts"', '"./index.mjs"');
    await writeFile(join(entry, name + ".mjs"), js);
  }
  return { directory, entry };
}

/** Exercise the external package loader against an installed, independently authored Driver. */
export async function protectedDriverPackage(
  t: TestContext,
  id: string,
  filename: "index" | "repository-git" = "index",
) {
  return installedDriverPackage(
    t,
    id,
    "protected-execution-driver",
    filename === "repository-git" ? [filename, "index"] : [filename],
  );
}
