import { mkdir, readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { temporaryDirectory } from "./temporary-directory.mjs";

/** Exercise the external package loader against an installed, independently authored Driver. */
export async function protectedDriverPackage(
  t: TestContext,
  id: string,
  filename: "index" | "repository-git" | "remote-repository-git" = "index",
) {
  const directory = await temporaryDirectory(t, "oce-protected-driver-");
  const entry = join(directory, "node_modules", id);
  await mkdir(entry, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ dependencies: { [id]: "1.0.0" } }),
  );
  await writeFile(
    join(entry, "package.json"),
    JSON.stringify({ name: id, version: "1.0.0", exports: "./" + filename + ".mjs" }),
  );
  const modules = [filename];
  if (filename !== "index") {
    modules.unshift("index");
  }
  if (filename === "remote-repository-git") {
    modules.unshift("repository-git");
  }
  for (const name of modules) {
    const source = await readFile(
      new URL(
        "../fixtures/driver-packages/protected-execution-driver/" + name + ".ts",
        import.meta.url,
      ),
      "utf8",
    );
    const js = stripTypeScriptTypes(source)
      .replaceAll('"./index.ts"', '"./index.mjs"')
      .replaceAll('"./repository-git.ts"', '"./repository-git.mjs"');
    await writeFile(join(entry, name + ".mjs"), js);
  }
  return { directory, entry };
}
