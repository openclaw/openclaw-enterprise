import { readFile, writeFile } from "node:fs/promises";

// The image publisher supplies the revision of its checked-out build context.
const revision = process.argv[2] ?? "";
if (revision !== "" && !/^[a-f0-9]{40}$/.test(revision)) {
  throw new Error("OCC_BUILD_REVISION must be a full lowercase Git commit hash or empty.");
}
const shell = new URL("../apps/controller/src/console/index.html", import.meta.url);
const html = await readFile(shell, "utf8");
if (!/<meta name="occ-build-revision" content="[^"]*" \/>/.test(html)) {
  throw new Error("Console HTML is missing the OCC build revision metadata tag.");
}
await writeFile(
  shell,
  html.replace(
    /<meta name="occ-build-revision" content="[^"]*" \/>/,
    `<meta name="occ-build-revision" content="${revision}" />`,
  ),
);
