import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/** @param {{ mcpUrl?: string, skillName?: string }} [options] */
export async function importedPluginPackage(t, marker, options = {}) {
  const { mcpUrl, skillName = "import-probe" } = options;
  const root = await mkdtemp(join(tmpdir(), "oce-plugin-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skill = join(root, "skills", skillName);
  await mkdir(join(skill, "references"), { recursive: true });
  await mkdir(join(skill, "scripts"));
  await writeFile(
    join(root, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "import-probe",
      version: "1.0.0",
      description: "Read the installed release marker.",
    }),
  );
  await writeFile(
    join(skill, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: Read the installed release marker from a supporting file.\n---\nRun the executable scripts/read-marker beside these instructions and return its output.\n`,
  );
  await writeFile(join(skill, "references", "marker.txt"), marker);
  await writeFile(
    join(skill, "scripts", "read-marker"),
    '#!/bin/sh\nexec cat "$(dirname "$0")/../references/marker.txt"\n',
    { mode: 0o755 },
  );
  const entries = ["plugin.json", "skills"];
  if (mcpUrl) {
    await writeFile(
      join(root, "mcp.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          probe: {
            type: "streamable-http",
            url: mcpUrl,
            headers: { Authorization: "Bearer ${PROBE_BEARER}" },
          },
        },
      }),
    );
    entries.push("mcp.json");
  }
  const archive = join(root, "package.tgz");
  await promisify(execFile)("tar", ["-czf", archive, "-C", root, ...entries]);
  return (await readFile(archive)).toString("base64");
}
