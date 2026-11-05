import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function buildPackOutput(packageDir: string, project: string): void {
  const output = join(packageDir, "dist");
  const existingOutput = lstatSync(output, { throwIfNoEntry: false });
  if (existingOutput && !existingOutput.isDirectory()) {
    throw new Error("Refusing to replace package output: dist is not a directory");
  }

  const compiler = fileURLToPath(
    new URL("../node_modules/@typescript/native/bin/tsc", import.meta.url),
  );
  const staging = mkdtempSync(join(packageDir, ".pack-"));
  try {
    execFileSync(
      process.execPath,
      [
        compiler,
        "--project",
        project,
        "--outDir",
        staging,
        "--tsBuildInfoFile",
        join(staging, "pack.tsbuildinfo"),
        "--pretty",
        "false",
      ],
      { cwd: packageDir, stdio: "inherit" },
    );
    rmSync(output, { recursive: true, force: true });
    renameSync(staging, output);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
