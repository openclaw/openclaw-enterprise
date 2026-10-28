import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function stampConsoleBuildRevision(html, revision) {
  if (revision !== "" && !/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error("OCC_BUILD_REVISION must be a full lowercase Git commit hash or empty.");
  }
  const marker = /<meta name="occ-build-revision" content="[^"]*" \/>/;
  if (!marker.test(html)) {
    throw new Error("Console HTML is missing the OCC build revision metadata tag.");
  }
  return html.replace(marker, `<meta name="occ-build-revision" content="${revision}" />`);
}

// The image publisher supplies the revision of its checked-out build context.
if (import.meta.main ?? import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const shell = new URL("../apps/controller/src/console/index.html", import.meta.url);
  await writeFile(
    shell,
    stampConsoleBuildRevision(await readFile(shell, "utf8"), process.argv[2] ?? ""),
  );
}
