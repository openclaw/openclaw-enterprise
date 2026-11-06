import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { chromium } from "playwright";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { launchTrustingBrowser } from "../helpers/trusted-chromium.ts";

const run = promisify(execFile);
const repository = new URL("../../", import.meta.url);

async function serveNativePage(t: TestContext, tls: { cert: Buffer; key: Buffer }) {
  const requests: { host: string | undefined; cookie: string }[] = [];
  const server = createServer(tls, (request, response) => {
    if (request.method !== "GET" || request.url !== "/") {
      response.writeHead(404).end();
      return;
    }
    requests.push({ host: request.headers.host, cookie: request.headers.cookie ?? "" });
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Native admin UI</title>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
      server.closeAllConnections();
    });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return { requests, port: address.port };
}

export function nativeBrowserSupported(t: TestContext) {
  if (process.platform === "linux") {
    return true;
  }
  t.skip(
    "Native Agent HTTPS requires Linux Chromium's NSS trust store. See docs/testing/local.md.",
  );
  return false;
}

export async function createNativeConsoleFixture<Options extends object>(
  t: TestContext,
  options: Options,
  { serveAgentPage = false }: { serveAgentPage?: boolean } = {},
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
    const nativePage = serveAgentPage ? await serveNativePage(t, ingressTLS) : undefined;
    const nativeAddress = nativePage === undefined ? undefined : `127.0.0.1:${nativePage.port}`;
    // Preserve the browser-visible Agent origin and default port. Chromium resolves its
    // Agent connection to the test-owned ephemeral loopback port.
    const hostsForBrowser = [
      ...(nativeAddress === undefined
        ? []
        : [
            { host: `*.${nativeDomain}`, address: nativeAddress },
            { host: `wrong.${cookieDomain}`, address: nativeAddress },
          ]),
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
      nativePage,
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
