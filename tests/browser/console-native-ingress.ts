import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { chromium } from "playwright";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { launchTrustingBrowser } from "../helpers/trusted-chromium.ts";

const run = promisify(execFile);
const repository = new URL("../../", import.meta.url);

export async function createNativeConsoleFixture<Options extends object>(
  t: TestContext,
  options: Options,
) {
  assert.equal(
    process.platform,
    "linux",
    "Run the native Agent browser tests on Linux for isolated Chromium trust",
  );
  const directory = await mkdtemp(join(tmpdir(), "oce-native-browser-"));
  const remove = () => rm(directory, { recursive: true, force: true });
  try {
    const certificates = join(directory, "tls");
    const scope = `console-browser-${randomBytes(6).toString("hex")}`;
    const { stdout } = await run(
      "go",
      ["run", "./tests/helpers/dev-browser-tls", certificates, scope],
      {
        cwd: repository,
      },
    );
    const hosts: unknown = JSON.parse(stdout);
    assert.ok(typeof hosts === "object" && hosts !== null);
    assert.ok("consoleHost" in hosts && typeof hosts.consoleHost === "string");
    assert.ok("nativeDomain" in hosts && typeof hosts.nativeDomain === "string");
    assert.ok("cookieDomain" in hosts && typeof hosts.cookieDomain === "string");
    const { consoleHost, nativeDomain, cookieDomain } = hosts;
    const ingressTLS = {
      cert: await readFile(join(certificates, "browser-tls.crt")),
      key: await readFile(join(certificates, "browser-tls.key")),
    };
    const fixture = await createConsoleAppFixture(t, {
      ...options,
      originHost: consoleHost,
      publicOrigin: true,
      authCookieDomain: cookieDomain,
      development: { enabled: false },
      https: true,
      ingressTLS,
      authSecureCookies: true,
      nativeAdmin: { enabled: true, domain: nativeDomain, sharedCookieDomain: cookieDomain },
    });
    t.after(remove);
    const hostsForBrowser = [
      { host: `*.${cookieDomain}`, address: "127.0.0.1" },
      { host: "*", address: "~NOTFOUND" },
    ];
    const browserOptions = (caFiles: readonly string[]) => ({
      async launch() {
        const profile = await mkdtemp(join(directory, "profile-"));
        return launchTrustingBrowser(chromium, profile, { caFiles, hosts: hostsForBrowser });
      },
    });
    return {
      fixture,
      consoleHost,
      nativeDomain,
      cookieDomain,
      browserOptions: browserOptions([join(certificates, "browser-ca.crt")]),
      untrustedBrowserOptions: browserOptions([]),
    };
  } catch (error) {
    await remove();
    throw error;
  }
}
