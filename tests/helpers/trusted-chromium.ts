import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BrowserType } from "playwright";

const run = promisify(execFile);

// Chromium on Linux reads trust anchors from NSS under its process's HOME.
export async function launchTrustingBrowser(
  chromium: BrowserType,
  root: string,
  instructions: {
    caFiles: readonly string[];
    hosts: readonly { address: string; host: string }[];
  },
) {
  const home = join(root, "browser-home");
  const database = join(home, ".pki", "nssdb");
  await mkdir(database, { recursive: true, mode: 0o700 });
  const db = `sql:${database}`;
  await run("certutil", ["-N", "--empty-password", "-d", db]);
  for (const [index, file] of instructions.caFiles.entries()) {
    await run("certutil", [
      "-A",
      "-d",
      db,
      "-n",
      `oce-development-${index}`,
      "-t",
      "C,,",
      "-i",
      file,
    ]);
  }
  const rules = instructions.hosts.map(({ address, host }) => `MAP ${host} ${address}`);
  return chromium.launch({
    headless: true,
    chromiumSandbox: true,
    env: { HOME: home, PATH: process.env.PATH, TMPDIR: root },
    args: ["--no-proxy-server", `--host-resolver-rules=${rules.join(",")}`],
    ...(process.env.OCC_TEST_BROWSER_EXECUTABLE
      ? { executablePath: process.env.OCC_TEST_BROWSER_EXECUTABLE }
      : {}),
  });
}
