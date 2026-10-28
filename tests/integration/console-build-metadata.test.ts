import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { STATUS_CODES } from "node:http";
import { createServer } from "node:https";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { loadConsoleTheme } from "../../apps/controller/src/composition/console-theme.ts";
import { renderConsoleThemeShell } from "../../apps/controller/src/console-theme.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { caAndLeaf } from "../helpers/certificates.mjs";
import { captureChild } from "../helpers/child-processes.mjs";
import { listen } from "../helpers/listen.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const execute = promisify(execFile);
const sourcePath = "apps/controller/src/console";
const shellPath = "/console/";
const assetPath = "/console/console.css";
const verifier = fileURLToPath(new URL("../../scripts/verify-console-release.ts", import.meta.url));
const git = (cwd: string, ...args: string[]) =>
  execute("git", ["--no-lazy-fetch", "-C", cwd, ...args], { timeout: 5_000 });
const contentHeaders = (media: string, length: number) =>
  `Content-Type: ${media}\r\nContent-Length: ${length}`;

async function stageBuild(t: TestContext) {
  const directory = await temporaryDirectory(t, "occ-console-build-");
  const source = join(directory, "source");
  const shell = join(source, sourcePath, "index.html");
  const stamper = join(source, "scripts/build-console-metadata.mjs");
  await mkdir(join(source, sourcePath), { recursive: true });
  await mkdir(join(source, "scripts"));
  await cp(new URL("../../scripts/build-console-metadata.mjs", import.meta.url), stamper);
  await cp(new URL("../../apps/controller/src/console/index.html", import.meta.url), shell);
  return { directory, source, shell, stamper };
}

type ResponseOverride = {
  route?: string;
  body?: string;
  connection?: string;
  headers?: string;
  status?: number;
};
type Release = { directory: string; source: string; revision: string; html: string; css: string };

async function serveRelease(t: TestContext, release: Release) {
  const tls = await caAndLeaf(release.directory, {
    caKeyPem: undefined,
    leafKeyPem: undefined,
    caName: "Console fixture CA",
    commonName: "localhost",
    subjectAltName: "IP:127.0.0.1",
  });
  let override: ResponseOverride = {};
  const requests: string[] = [];
  const server = createServer(
    { key: await readFile(tls.keyPath), cert: await readFile(tls.certPath) },
    (request, response) => {
      assert.equal(request.method, "GET");
      for (const name of ["authorization", "cookie", "proxy-authorization"]) {
        assert.ok(request.headers[name] === undefined, `forbidden request header ${name}`);
      }
      requests.push(request.url!);
      const asset = request.url === assetPath;
      const selected = (override.route ?? shellPath) === request.url ? override : {};
      const body = selected.body ?? (asset ? release.css : release.html);
      const headers =
        selected.headers ??
        contentHeaders(asset ? "text/css" : "text/html", Buffer.byteLength(body));
      const status = selected.status ?? 200;
      response.socket!.end(
        `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\n${headers}\r\nConnection: ${selected.connection ?? "close"}\r\n\r\n${body}`,
      );
    },
  );
  const origin = `https://127.0.0.1:${await listen(t, server)}`;
  return async (
    expected: string,
    paths: string[],
    options: {
      response?: ResponseOverride;
      source?: string;
      path?: string;
      trust?: boolean;
      env?: NodeJS.ProcessEnv;
    } = {},
  ) => {
    override = options.response ?? {};
    requests.length = 0;
    const childOptions = {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: options.trust === false ? undefined : tls.caPath,
        ...options.env,
      },
      timeout: 25_000,
    };
    const result = await captureChild(
      process.execPath,
      [
        verifier,
        options.source ?? release.source,
        release.revision,
        origin + (options.path ?? shellPath),
      ],
      childOptions,
    );
    assert.equal(result.status, expected === "verified" ? 0 : 1);
    assert.equal(result.signal, null);
    assert.equal(result.stderr.length, 0, "verifier must keep stderr empty");
    assert.ok(
      requests.length === paths.length && requests.every((path, index) => path === paths[index]),
      "unexpected release request sequence",
    );
    assert.ok(
      !/secret|private|127\.0\.0\.1|https:|<!doctype/i.test(result.stdout),
      "verifier output contains private request or response data",
    );
    const record = JSON.parse(result.stdout);
    assert.equal(record.result, expected);
    return record;
  };
}

test("console image metadata preserves the supplied revision and rejects invalid build inputs", async (t) => {
  const { shell, stamper } = await stageBuild(t);
  const revision = "abcdef1234567890abcdef1234567890abcdef12";
  await execute(process.execPath, [stamper, revision]);
  assert.ok(
    (await readFile(shell, "utf8")).includes(`name="occ-build-revision" content="${revision}"`),
  );
  for (const invalid of ["abcdef12", "unknown", "<script>alert(1)</script>"]) {
    await assert.rejects(
      execute(process.execPath, [stamper, invalid]),
      /must be a full lowercase Git commit hash or empty/,
    );
  }
  await execute(process.execPath, [stamper], { env: { ...process.env, GITHUB_SHA: revision } });
  assert.ok((await readFile(shell, "utf8")).includes('name="occ-build-revision" content=""'));
});

test("console release verification checks served build artifacts", async (t) => {
  const build = await stageBuild(t);
  await cp(
    new URL("../../apps/controller/src/console/console.css", import.meta.url),
    join(build.source, sourcePath, "console.css"),
  );
  // Commit only the two release source objects. The delivered CSS comes independently from Fastify.
  await git(build.source, "init", "--quiet", "--template=");
  await git(build.source, "add", "--", sourcePath);
  await git(
    build.source,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "-m",
    "Console fixture",
  );
  const revision = (await git(build.source, "rev-parse", "HEAD")).stdout.trim();
  await execute(process.execPath, [build.stamper, revision]);
  const stamped = await readFile(build.shell, "utf8");
  const marker = `<meta name="occ-build-revision" content="${revision}" />`;

  const themeDirectory = join(build.directory, "theme");
  await mkdir(themeDirectory);
  await cp(
    new URL("../../apps/controller/src/console/favicon-32.png", import.meta.url),
    join(themeDirectory, "brand.png"),
  );
  await writeFile(
    join(themeDirectory, "theme.json"),
    JSON.stringify({
      schemaVersion: 1,
      displayName: 'Release <Operations> & "Support"',
      logo: "brand.png",
      favicon: "brand.png",
      appleTouchIcon: "brand.png",
      colors: { accent: "#2457C5" },
    }),
  );
  const theme = await loadConsoleTheme(themeDirectory);
  assert.ok(theme);
  const { createConsoleAppFixture } = await import("../helpers/console-app.mjs");
  const app = await createConsoleAppFixture(t, { consoleTheme: theme });
  const shellResponse = await app.rawRequest("GET", shellPath);
  const assetResponse = await app.rawRequest("GET", assetPath);
  assert.equal(shellResponse.response.status, 200);
  assert.equal(assetResponse.response.status, 200);
  const themed = renderConsoleThemeShell(stamped, theme);
  assert.ok(
    themed.replace(marker, '<meta name="occ-build-revision" content="" />') === shellResponse.text,
    "rendered themed shell differs from the Fastify response",
  );
  const verify = await serveRelease(t, {
    ...build,
    revision,
    html: themed,
    css: assetResponse.text,
  });
  const both = [shellPath, assetPath];

  for (const html of [stamped, themed]) {
    const record = await verify("verified", both, { response: { body: html } });
    assert.equal(record.revision, revision);
    assert.equal(record.assetSha256, createHash("sha256").update(assetResponse.text).digest("hex"));
  }
  const stylesheet = '<link rel="stylesheet" href="/console/console.css" />';
  assert.ok(themed.includes(stylesheet));
  for (const [name, body] of [
    ["stale revision", themed.replace(revision, "a".repeat(40))],
    ["inert marker", themed.replace(marker, `<template>${marker}</template>`)],
    [
      "disabled stylesheet",
      themed.replace(stylesheet, stylesheet.replace("<link", "<link disabled")),
    ],
  ] as const) {
    await t.test(name, () => verify("wrong-shell", [shellPath], { response: { body } }));
  }
  await t.test("mismatched CSS", () =>
    verify("wrong-asset", both, { response: { route: assetPath, body: "/* stale */" } }),
  );
  await t.test("HTTP framing, size, and media types cannot create a false green", async () => {
    await verify("incomplete-response", [shellPath], {
      response: {
        headers: contentHeaders("text/html", Buffer.byteLength(themed) + 1),
      },
    });
    await verify("incomplete-response", both, {
      response: {
        route: assetPath,
        headers: contentHeaders("text/css", Buffer.byteLength(assetResponse.text) + 1),
      },
    });
    await verify("unexpected-content", [shellPath], {
      response: {
        headers: `${contentHeaders("text/html", Buffer.byteLength(themed))}\r\nContent-Length: 0`,
      },
    });
    await verify("unexpected-content", [shellPath], {
      response: {
        headers: "Content-Type: text/html\r\nTransfer-Encoding: chunked",
        body: `${Buffer.byteLength(themed).toString(16)}\r\n${themed}\r\n0\r\n\r\n`,
      },
    });
    await verify("unexpected-content", [shellPath], {
      response: { headers: contentHeaders("application/json", 0), body: "" },
    });
    await verify("response-too-large", both, {
      response: {
        route: assetPath,
        headers: contentHeaders("text/css", 2 * 1024 * 1024 + 1),
        body: "",
      },
    });
  });
  await t.test("a protocol upgrade returns a sanitized refusal", () =>
    verify("unavailable", [shellPath], {
      response: { status: 101, connection: "Upgrade", headers: "Upgrade: websocket", body: "" },
    }),
  );
  await t.test("redirects, authentication, and untrusted origins stay private", async () => {
    const location = syntheticCredentialUrl({
      username: "fixture",
      password: "secret",
      host: "example.invalid",
      port: undefined,
      pathname: "/sign-in",
      search: "?token=secret",
    });
    await verify("redirect-refused", [shellPath], {
      response: {
        status: 302,
        body: "private secret",
        headers: `Location: ${location}\r\nSet-Cookie: private=secret`,
      },
    });
    await verify("authentication-required", [shellPath], {
      response: { status: 401, body: "private secret" },
    });
    await verify("unavailable", [], { trust: false });
    await verify("invalid-input", [], { path: "/?token=secret" });
  });
  await t.test("missing promised blobs cannot trigger a fetch or an HTTP request", async () => {
    await git(build.source, "config", "uploadpack.allowFilter", "true");
    const partial = join(build.directory, "partial");
    await git(
      build.directory,
      "-c",
      "protocol.file.allow=always",
      "clone",
      "--quiet",
      "--no-checkout",
      "--template=",
      "--filter=blob:none",
      pathToFileURL(build.source).href,
      partial,
    );
    assert.equal(
      (await git(partial, "config", "--get", "remote.origin.promisor")).stdout.trim(),
      "true",
    );
    await git(
      partial,
      "remote",
      "set-url",
      "origin",
      pathToFileURL(join(build.directory, "offline")).href,
    );
    const missing = async () =>
      (await git(partial, "rev-list", "--objects", "--all", "--missing=print")).stdout
        .split("\n")
        .filter((line) => line.startsWith("?"))
        .sort();
    const before = await missing();
    assert.equal(before.length, 2);
    const trace = join(build.directory, "trace.jsonl");
    await verify("invalid-source", [], { source: partial, env: { GIT_TRACE2_EVENT: trace } });
    const events = (await readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.event === "start"));
    assert.ok(events.every((event) => !Array.isArray(event.argv) || !event.argv.includes("fetch")));
    assert.deepEqual(await missing(), before);
  });
});
