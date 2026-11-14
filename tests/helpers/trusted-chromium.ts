import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BrowserType } from "playwright";

const run = promisify(execFile);
const browserHome = "browser-home";
type BrowserHost = { address: string; host: string };

// Chromium on Linux reads trust anchors from NSS under its process's HOME.
export async function launchTrustingBrowser(
  chromium: BrowserType,
  root: string,
  instructions: {
    caFiles: readonly string[];
    hosts: readonly BrowserHost[];
  },
) {
  const home = join(root, browserHome);
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

export async function preflightTrustingBrowser(
  chromium: BrowserType,
  root: string,
  hosts: readonly BrowserHost[],
) {
  try {
    const browser = await launchTrustingBrowser(chromium, root, { caFiles: [], hosts });
    try {
      const page = await browser.newPage();
      await page.goto("data:text/html,<title>Browser preflight</title>");
      if ((await page.title()) !== "Browser preflight") {
        throw new Error("Chromium did not render the local preflight page.");
      }
    } finally {
      await browser.close();
    }
  } finally {
    // The owner session initializes this same NSS home with the installed CA.
    await rm(join(root, browserHome), { recursive: true, force: true });
  }
}
